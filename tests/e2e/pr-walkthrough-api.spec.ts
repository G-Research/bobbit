import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test, expect } from "./in-process-harness.js";
import { apiFetch, createSession } from "./e2e-setup.js";

type GitFixture = {
	cwd: string;
	baseSha: string;
	headSha: string;
	cleanup: () => void;
};

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeGitFixture(): GitFixture {
	const cwd = mkdtempSync(join(tmpdir(), "bobbit-pr-walkthrough-"));
	git(cwd, ["init"]);
	git(cwd, ["config", "user.name", "Bobbit E2E"]);
	git(cwd, ["config", "user.email", "bobbit-e2e@example.test"]);
	writeFileSync(join(cwd, "README.md"), "# Demo\n\nFirst line\n", "utf-8");
	git(cwd, ["add", "."]);
	git(cwd, ["commit", "-m", "base"]);
	const baseSha = git(cwd, ["rev-parse", "HEAD"]);
	mkdirSync(join(cwd, "src"));
	writeFileSync(join(cwd, "README.md"), "# Demo\n\nFirst line\nSecond line\n", "utf-8");
	writeFileSync(join(cwd, "src", "feature.ts"), "export const answer = 42;\n", "utf-8");
	git(cwd, ["add", "."]);
	git(cwd, ["commit", "-m", "head"]);
	const headSha = git(cwd, ["rev-parse", "HEAD"]);
	return { cwd, baseSha, headSha, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

async function resolveLocal(fixture: GitFixture): Promise<any> {
	const resp = await apiFetch("/api/pr-walkthrough/resolve", {
		method: "POST",
		body: JSON.stringify({ cwd: fixture.cwd, baseSha: fixture.baseSha, headSha: fixture.headSha }),
	});
	expect(resp.status).toBe(200);
	return resp.json();
}

async function startMockGithubApi(status: number, body: unknown, headers: Record<string, string> = {}): Promise<{ baseUrl: string; requests: Array<{ url?: string; authorization?: string }>; close: () => Promise<void> }> {
	const requests: Array<{ url?: string; authorization?: string }> = [];
	const server = createServer((req, res) => {
		requests.push({ url: req.url, authorization: req.headers.authorization });
		res.writeHead(status, { "Content-Type": "application/json", ...headers });
		res.end(JSON.stringify(body));
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address !== "object") throw new Error("mock GitHub API did not bind a TCP port");
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		requests,
		close: () => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())),
	};
}

function firstLineAnchor(result: any): { cardId: string; diffBlockId: string; lineId: string } {
	for (const card of result.cards ?? []) {
		for (const block of card.diffBlocks ?? []) {
			for (const hunk of block.hunks ?? []) {
				const line = (hunk.lines ?? []).find((item: any) => item.newLine || item.oldLine);
				if (line) return { cardId: card.id, diffBlockId: block.id, lineId: line.id };
			}
		}
	}
	throw new Error("resolved walkthrough had no line anchors");
}

test.describe("PR walkthrough REST API", () => {
	test("POST launch creates a real child walkthrough session through production route wiring", async () => {
		const fixture = makeGitFixture();
		try {
			const parentSessionId = await createSession();
			const launchBody = { sessionId: parentSessionId, cwd: fixture.cwd, baseSha: fixture.baseSha, headSha: fixture.headSha };
			const launchResp = await apiFetch("/api/pr-walkthrough/launch", {
				method: "POST",
				body: JSON.stringify(launchBody),
			});
			expect(launchResp.status).toBe(201);
			const launch = await launchResp.json();
			expect(launch.status).toBe("waiting_for_yaml");
			expect(launch.job.parentSessionId).toBe(parentSessionId);
			expect(launch.job.childSessionId).toBe(launch.childSessionId);

			const sessionResp = await apiFetch(`/api/sessions/${encodeURIComponent(launch.childSessionId)}`);
			expect(sessionResp.status).toBe(200);
			const session = await sessionResp.json();
			expect(session.parentSessionId).toBe(parentSessionId);
			expect(session.childKind).toBe("pr-walkthrough");
			expect(session.readOnly).toBe(true);

			const duplicateResp = await apiFetch("/api/pr-walkthrough/launch", {
				method: "POST",
				body: JSON.stringify(launchBody),
			});
			expect(duplicateResp.status).toBe(200);
			expect((await duplicateResp.json()).childSessionId).toBe(launch.childSessionId);
		} finally {
			fixture.cleanup();
		}
	});

	test("POST resolve returns real local diff cards and GET returns persisted state", async () => {
		const fixture = makeGitFixture();
		try {
			const result = await resolveLocal(fixture);
			expect(result.changesetId).toBe(`${fixture.baseSha.slice(0, 7)}..${fixture.headSha.slice(0, 7)}`);
			expect(result.changeset.provider).toBe("local");
			expect(result.changeset.filesChanged).toBe(2);
			expect(result.cards.length).toBeGreaterThanOrEqual(2);
			expect(result.cards.flatMap((card: any) => card.diffBlocks).some((block: any) => block.filePath === "src/feature.ts")).toBe(true);

			const getResp = await apiFetch(`/api/pr-walkthrough/${encodeURIComponent(result.changesetId)}`);
			expect(getResp.status).toBe(200);
			const persisted = await getResp.json();
			expect(persisted.changesetId).toBe(result.changesetId);
			expect(persisted.schemaVersion).toBe(1);
			expect(persisted.cards.length).toBe(result.cards.length);
		} finally {
			fixture.cleanup();
		}
	});

	test("export preview maps line comments and submit rejects without explicit confirmation", async () => {
		const fixture = makeGitFixture();
		try {
			const result = await resolveLocal(fixture);
			const anchor = firstLineAnchor(result);
			const draft = {
				changeset: result.changeset,
				decisions: {},
				completedCardIds: [anchor.cardId],
				updatedAt: new Date().toISOString(),
				comments: [
					{ id: "line-1", ...anchor, body: "Please double-check this line.", source: "custom", createdAt: new Date().toISOString() },
					{ id: "card-1", cardId: anchor.cardId, body: "Card-level concern", source: "custom", createdAt: new Date().toISOString() },
				],
			};

			const previewResp = await apiFetch(`/api/pr-walkthrough/${encodeURIComponent(result.changesetId)}/export/preview`, {
				method: "POST",
				body: JSON.stringify(draft),
			});
			expect(previewResp.status).toBe(200);
			const preview = await previewResp.json();
			expect(preview.rows.some((row: any) => row.commentId === "line-1" && row.valid && row.path)).toBe(true);
			expect(preview.body).toContain("Card-level concern");

			const submitResp = await apiFetch(`/api/pr-walkthrough/${encodeURIComponent(result.changesetId)}/export/submit`, {
				method: "POST",
				body: JSON.stringify({ draft }),
			});
			expect(submitResp.status).toBe(400);
			const submitBody = await submitResp.json();
			expect(submitBody.code).toBe("CONFIRMATION_REQUIRED");
		} finally {
			fixture.cleanup();
		}
	});

	test("invalid refs and missing persisted walkthroughs return structured errors", async () => {
		const fixture = makeGitFixture();
		try {
			const invalidResp = await apiFetch("/api/pr-walkthrough/resolve", {
				method: "POST",
				body: JSON.stringify({ cwd: fixture.cwd, baseSha: "not-a-sha", headSha: fixture.headSha }),
			});
			expect(invalidResp.status).toBe(400);
			expect((await invalidResp.json()).error).toContain("Invalid baseSha");

			const missingResp = await apiFetch(`/api/pr-walkthrough/${encodeURIComponent("missing..walkthrough")}`);
			expect(missingResp.status).toBe(404);
			expect((await missingResp.json()).error).toContain("Walkthrough not found");
		} finally {
			fixture.cleanup();
		}
	});

	test("large local diffs return truncation warnings instead of maxBuffer failures", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "bobbit-pr-walkthrough-large-"));
		try {
			git(cwd, ["init"]);
			git(cwd, ["config", "user.name", "Bobbit E2E"]);
			git(cwd, ["config", "user.email", "bobbit-e2e@example.test"]);
			writeFileSync(join(cwd, "large.txt"), "base\n", "utf-8");
			git(cwd, ["add", "."]);
			git(cwd, ["commit", "-m", "base"]);
			const baseSha = git(cwd, ["rev-parse", "HEAD"]);
			writeFileSync(join(cwd, "large.txt"), Array.from({ length: 220_000 }, (_, index) => `line ${index} ${"x".repeat(16)}`).join("\n"), "utf-8");
			git(cwd, ["add", "."]);
			git(cwd, ["commit", "-m", "large"]);
			const headSha = git(cwd, ["rev-parse", "HEAD"]);

			const resp = await apiFetch("/api/pr-walkthrough/resolve", {
				method: "POST",
				body: JSON.stringify({ cwd, baseSha, headSha }),
			});
			expect(resp.status).toBe(200);
			const result = await resp.json();
			expect(result.warnings.some((warning: any) => warning.code === "diff-truncated")).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("empty local diffs resolve to an orientation-only walkthrough instead of a broken response", async () => {
		const fixture = makeGitFixture();
		try {
			const resp = await apiFetch("/api/pr-walkthrough/resolve", {
				method: "POST",
				body: JSON.stringify({ cwd: fixture.cwd, baseSha: fixture.headSha, headSha: fixture.headSha }),
			});
			expect(resp.status).toBe(200);
			const result = await resp.json();
			expect(result.changeset.filesChanged).toBe(0);
			expect(result.cards).toHaveLength(1);
			expect(result.cards[0].phaseId).toBe("orientation");
		} finally {
			fixture.cleanup();
		}
	});

	test("GitHub PR resolve rejects untrusted hosts with typed errors", async () => {
		const previousToken = process.env.GITHUB_TOKEN;
		process.env.GITHUB_TOKEN = "must-not-leak";
		try {
			const resp = await apiFetch("/api/pr-walkthrough/resolve", {
				method: "POST",
				body: JSON.stringify({ prUrl: "https://evil.example/acme/widgets/pull/42" }),
			});
			expect(resp.status).toBe(400);
			const body = await resp.json();
			expect(body.code).toBe("untrusted_github_host");
			expect(body.error).toContain("Untrusted GitHub PR host");
		} finally {
			if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = previousToken;
		}
	});

	test("GitHub adapter auth and permission errors preserve status, code, and warnings", async () => {
		const mock = await startMockGithubApi(403, { message: "Forbidden" }, { "x-ratelimit-remaining": "5" });
		const previousApiBase = process.env.BOBBIT_GITHUB_API_BASE_URL;
		const previousToken = process.env.GITHUB_TOKEN;
		process.env.BOBBIT_GITHUB_API_BASE_URL = mock.baseUrl;
		process.env.GITHUB_TOKEN = "mock-token";
		try {
			const resp = await apiFetch("/api/pr-walkthrough/resolve", {
				method: "POST",
				body: JSON.stringify({ prUrl: "https://github.com/acme/widgets/pull/42" }),
			});
			expect(resp.status).toBe(403);
			const body = await resp.json();
			expect(body.code).toBe("github_permission_denied");
			expect(body.warnings.some((warning: any) => warning.code === "github_permission_denied")).toBe(true);
			expect(mock.requests[0]?.authorization).toBe("Bearer mock-token");
		} finally {
			await mock.close();
			if (previousApiBase === undefined) delete process.env.BOBBIT_GITHUB_API_BASE_URL;
			else process.env.BOBBIT_GITHUB_API_BASE_URL = previousApiBase;
			if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = previousToken;
		}
	});

	test("GitHub PR resolve can be faked from local SHAs and remains preview-only without credentials", async () => {
		const fixture = makeGitFixture();
		try {
			const prUrl = "https://github.com/acme/widgets/pull/42";
			const resp = await apiFetch("/api/pr-walkthrough/resolve", {
				method: "POST",
				body: JSON.stringify({ cwd: fixture.cwd, prUrl, baseSha: fixture.baseSha, headSha: fixture.headSha }),
			});
			expect(resp.status).toBe(200);
			const result = await resp.json();
			expect(result.changesetId).toBe(`github:acme/widgets#42:${fixture.headSha.slice(0, 7)}`);
			expect(result.changeset.provider).toBe("github");
			expect(result.changeset.prUrl).toBe(prUrl);
			expect(result.changeset.externalUrl).toBe(prUrl);
			expect(result.export.previewOnly).toBe(true);

			const submitResp = await apiFetch(`/api/pr-walkthrough/${encodeURIComponent(result.changesetId)}/export/submit`, {
				method: "POST",
				body: JSON.stringify({ draft: { comments: [] }, confirm: true }),
			});
			expect(submitResp.status).toBe(400);
			expect((await submitResp.json()).code).toBe("EXPORT_UNAVAILABLE");
		} finally {
			fixture.cleanup();
		}
	});

	test("local SHA plus unsafe PR metadata does not persist clickable external URLs", async () => {
		const fixture = makeGitFixture();
		try {
			const resp = await apiFetch("/api/pr-walkthrough/resolve", {
				method: "POST",
				body: JSON.stringify({ cwd: fixture.cwd, prUrl: "javascript:alert(1)", prNumber: 42, baseSha: fixture.baseSha, headSha: fixture.headSha }),
			});
			expect(resp.status).toBe(200);
			const result = await resp.json();
			expect(result.changeset.provider).toBe("github");
			expect(result.changeset.prUrl).toBeUndefined();
			expect(result.changeset.externalUrl).toBeUndefined();
		} finally {
			fixture.cleanup();
		}
	});
});
