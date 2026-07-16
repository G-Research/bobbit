/**
 * Representative commit-file metadata and commit-scoped diff routes.
 *
 * The broad gateway router is covered elsewhere. These declarations use the
 * production commit/diff core behind a route-shaped fixture whose session,
 * goal, commit, and CommandRunner state is local to each test. No shared
 * gateway, SessionManager, command facade, or mutable dispatcher is involved.
 */
import { describe, expect, it } from "vitest";
import type { CommandRunner, ExecFileOptions } from "../../src/server/gateway-deps.js";
import { getCommitsWithFiles, getGitDiff } from "../../src/server/server.js";

type RouteKind = "sessions" | "goals";

type CommitState = {
	sha: string;
	marker: string;
};

type RouteEntity = {
	id: string;
	cwd: string;
	commit: CommitState;
	rangeArgs: string[];
};

function commitLog(entity: RouteEntity): string {
	return [
		`\x1e${entity.commit.sha}\x1f${entity.commit.sha.slice(0, 7)}\x1ftarget commit\x1fCommit Diff Test\x1f2026-01-01T00:00:00.000Z`,
		":100644 100644 0000000 0000000 M\ttracked.txt",
		":000000 100644 0000000 0000000 A\tadded.txt",
		":100644 000000 0000000 0000000 D\tdelete-me.txt",
		":100644 100644 0000000 0000000 R100\trename-old.txt\trename-new.txt",
		"1\t1\ttracked.txt",
	].join("\n");
}

function cannedGit(entity: RouteEntity, args: readonly string[]): string {
	const key = args.join(" ");
	if (key === "rev-parse --verify HEAD") return entity.commit.sha;
	if (args[0] === "cat-file" && args[1] === "-e") {
		if (args[2] === `${entity.commit.sha}^{commit}`) return "";
		throw new Error("unknown commit");
	}
	if (args[0] === "log") return commitLog(entity);
	if (args[0] === "show" && args.includes("--name-status")) {
		if (!args.includes(entity.commit.sha)) throw new Error("unknown commit");
		return "M\ttracked.txt\nA\tadded.txt\nD\tdelete-me.txt\nR100\trename-old.txt\trename-new.txt";
	}
	if (args[0] === "show" && args.includes(entity.commit.sha)) {
		const file = args.at(-1);
		if (file === "rename-new.txt") {
			return "diff --git a/rename-old.txt b/rename-new.txt\nsimilarity index 100%\nrename from rename-old.txt\nrename to rename-new.txt";
		}
		return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n+${entity.commit.marker}`;
	}
	if (args[0] === "diff" && args.includes("tracked.txt")) {
		return "diff --git a/tracked.txt b/tracked.txt\n--- a/tracked.txt\n+++ b/tracked.txt\n+worktree marker";
	}
	throw new Error(`unexpected canned git command: ${key}`);
}

function commandRunnerFor(entity: RouteEntity): CommandRunner {
	return {
		async execFile(file, args, options?: ExecFileOptions) {
			expect(file).toBe("git");
			expect(options?.cwd).toBe(entity.cwd);
			return { stdout: cannedGit(entity, args), stderr: "" };
		},
	};
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

class CommitFileRouteFixture {
	private readonly sessions = new Map<string, RouteEntity>();
	private readonly goals = new Map<string, RouteEntity>();
	private readonly runners = new Map<RouteEntity, CommandRunner>();

	add(kind: RouteKind, entity: RouteEntity): string {
		(kind === "sessions" ? this.sessions : this.goals).set(entity.id, entity);
		this.runners.set(entity, commandRunnerFor(entity));
		return `/api/${kind}/${entity.id}`;
	}

	async fetch(requestPath: string): Promise<Response> {
		const url = new URL(requestPath, "http://commit-file-route.local");
		const match = url.pathname.match(/^\/api\/(sessions|goals)\/([^/]+)\/(commits|git-diff)$/);
		if (!match) return json({ error: "Route not found" }, 404);
		const [, kind, id, action] = match as [string, RouteKind, string, "commits" | "git-diff"];
		const entity = (kind === "sessions" ? this.sessions : this.goals).get(id);
		if (!entity) return json({ error: kind === "sessions" ? "Session not found" : "Goal not found" }, 404);
		const runner = this.runners.get(entity)!;

		try {
			if (action === "commits") {
				const commits = await getCommitsWithFiles(entity.cwd, entity.rangeArgs, 10_000, undefined, runner);
				return json({ commits });
			}
			const file = url.searchParams.get("file") || undefined;
			const commit = url.searchParams.get("commit") || undefined;
			const diff = await getGitDiff(entity.cwd, file, undefined, commit, runner);
			return json({ diff });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message === "INVALID_PATH") return json({ error: "Invalid file path" }, 400);
			if (message === "INVALID_COMMIT") return json({ error: "Invalid commit" }, 400);
			if (message === "NO_DIFF") return json({ error: "No diff found" }, 404);
			return json({ error: action === "commits" ? "Failed to read git log" : message }, 500);
		}
	}
}

function byPath(files: any[], filePath: string): any {
	return files.find(file => file.path === filePath);
}

function assertTargetCommitFiles(commit: any): void {
	expect(commit.filesChanged).toBe(4);
	expect(commit.insertions).toBe(1);
	expect(commit.deletions).toBe(1);
	expect(Array.isArray(commit.files)).toBe(true);
	expect(byPath(commit.files, "tracked.txt")).toMatchObject({ status: "M", statusLabel: "modified" });
	expect(byPath(commit.files, "added.txt")).toMatchObject({ status: "A", statusLabel: "added" });
	expect(byPath(commit.files, "delete-me.txt")).toMatchObject({ status: "D", statusLabel: "deleted" });
	expect(byPath(commit.files, "rename-new.txt")).toMatchObject({
		status: "R",
		statusLabel: "renamed",
		oldPath: "rename-old.txt",
	});
}

async function expectTargetCommitSummary(api: CommitFileRouteFixture, endpoint: string, targetSha: string): Promise<void> {
	const commitsResp = await api.fetch(`${endpoint}/commits`);
	expect(commitsResp.status).toBe(200);
	const body = await commitsResp.json();
	const commit = body.commits.find((candidate: any) => candidate.sha === targetSha);
	expect(commit).toBeTruthy();
	assertTargetCommitFiles(commit);
}

async function expectCommitDiff(
	api: CommitFileRouteFixture,
	endpoint: string,
	targetSha: string,
	file: string,
	marker: string,
): Promise<void> {
	const response = await api.fetch(`${endpoint}/git-diff?commit=${targetSha}&file=${encodeURIComponent(file)}`);
	expect(response.status).toBe(200);
	const body = await response.json();
	expect(body.diff).toContain(`diff --git a/${file} b/${file}`);
	expect(body.diff).toContain(marker);
}

async function expectSessionCommitDiffValidation(
	api: CommitFileRouteFixture,
	endpoint: string,
	targetSha: string,
): Promise<void> {
	await expectTargetCommitSummary(api, endpoint, targetSha);
	await expectCommitDiff(api, endpoint, targetSha, "tracked.txt", "commit scoped marker");

	const renameResponse = await api.fetch(
		`${endpoint}/git-diff?commit=${targetSha}&file=${encodeURIComponent("rename-new.txt")}`,
	);
	expect(renameResponse.status).toBe(200);
	expect((await renameResponse.json()).diff).toContain("rename from rename-old.txt");

	const invalidPathResponse = await api.fetch(
		`${endpoint}/git-diff?commit=${targetSha}&file=${encodeURIComponent("../secret.txt")}`,
	);
	expect(invalidPathResponse.status).toBe(400);
	expect((await invalidPathResponse.json()).error).toBe("Invalid file path");

	const invalidCommitResponse = await api.fetch(
		`${endpoint}/git-diff?commit=${"f".repeat(40)}&file=${encodeURIComponent("tracked.txt")}`,
	);
	expect(invalidCommitResponse.status).toBe(400);
	expect((await invalidCommitResponse.json()).error).toBe("Invalid commit");
}

const test = Object.assign(it, { describe });

test.describe("commit file diff API", () => {
	test("session commits include changed files and commit-scoped git-diff", async () => {
		const api = new CommitFileRouteFixture();
		const entity: RouteEntity = {
			id: "session-commit-diff",
			cwd: "/isolated/session-repo",
			commit: {
				sha: "1111111111111111111111111111111111111111",
				marker: "commit scoped marker",
			},
			rangeArgs: ["-50", "HEAD"],
		};
		const endpoint = api.add("sessions", entity);

		await expectSessionCommitDiffValidation(api, endpoint, entity.commit.sha);

		const worktreeResponse = await api.fetch(
			`${endpoint}/git-diff?file=${encodeURIComponent("tracked.txt")}`,
		);
		expect(worktreeResponse.status).toBe(200);
		expect((await worktreeResponse.json()).diff).toContain("+worktree marker");
	});

	test("goal commits include changed files and commit-scoped git-diff", async () => {
		const api = new CommitFileRouteFixture();
		const entity: RouteEntity = {
			id: "goal-commit-diff",
			cwd: "/isolated/goal-repo",
			commit: {
				sha: "2222222222222222222222222222222222222222",
				marker: "goal commit scoped marker",
			},
			rangeArgs: ["-20", "origin/master..goal/commit-diff"],
		};
		const endpoint = api.add("goals", entity);

		await expectTargetCommitSummary(api, endpoint, entity.commit.sha);
		await expectCommitDiff(api, endpoint, entity.commit.sha, "tracked.txt", entity.commit.marker);
	});
});
