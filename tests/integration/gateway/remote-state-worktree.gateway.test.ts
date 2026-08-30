import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { awaitableRm } from "../../../tests/e2e/test-utils/cleanup.js";
import { test, expect } from "../../../tests2/integration/_e2e/in-process-harness.js";
import { apiFetch, connectWs, defaultProjectId, deleteSession, gitCwd } from "../../../tests2/integration/_e2e/e2e-setup.js";
import { loadServerTestRuntime } from "../../../tests2/harness/server-runtime.js";

let serverModule: any;
let forceRequestedAt = 1_000;

function deterministicGitStatus(opts?: { untracked?: boolean }) {
	return {
		branch: "main",
		primaryBranch: "main",
		primaryRef: "refs/heads/main",
		isOnPrimary: true,
		status: [],
		hasUpstream: true,
		ahead: 0,
		behind: 0,
		aheadOfPrimary: 0,
		behindPrimary: 0,
		mergedIntoPrimary: true,
		insertionsVsPrimary: 0,
		deletionsVsPrimary: 0,
		clean: true,
		summary: "clean",
		unpushed: false,
		partial: false,
		untrackedIncluded: opts?.untracked === true,
	};
}

function commandName(file: string): string {
	return basename(file).toLowerCase().replace(/\.(?:cmd|exe)$/, "");
}

async function createRemoteStateSession(gateway: any, cwd: string): Promise<string> {
	const projectId = await defaultProjectId();
	const response = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd, projectId, worktree: false }),
	});
	const body = await response.json().catch(() => ({})) as Record<string, unknown>;
	expect(response.status, `remote-state fixture session creation failed: ${JSON.stringify(body)}`).toBe(201);
	expect(body.id).toEqual(expect.any(String));
	const sessionId = String(body.id);
	expect(gateway.sessionManager.getSession(sessionId)).toMatchObject({
		id: sessionId,
		cwd,
		status: "idle",
	});
	expect(gateway.sessionManager.getSession(sessionId)?.worktreePath).toBeUndefined();
	return sessionId;
}

async function removeSiblingWorktree(runner: any, primary: string, sibling: string): Promise<void> {
	const cleanup = await awaitableRm(sibling, { maxAttempts: 5, backoffMs: 50 });
	expect(cleanup.removed, `sibling worktree cleanup failed after ${cleanup.attempts} attempts: ${String(cleanup.lastError ?? "unknown error")}`).toBe(true);
	await runner.execFile("git", ["worktree", "prune", "--expire", "now"], { cwd: primary, encoding: "utf-8", timeout: 10_000 });
	const listed = await runner.execFile("git", ["worktree", "list", "--porcelain"], { cwd: primary, encoding: "utf-8", timeout: 10_000 });
	const listedPaths = String(listed.stdout)
		.split(/\r?\n/)
		.filter((line: string) => line.startsWith("worktree "))
		.map((line: string) => line.slice("worktree ".length).replaceAll("\\", "/").toLowerCase());
	expect(listedPaths).not.toContain(sibling.replaceAll("\\", "/").toLowerCase());
}

test.describe("remote-state coordinator native worktree route", () => {
	test.beforeAll(async () => {
		serverModule = (await loadServerTestRuntime()).server;
		expect(typeof serverModule.__setGitStatusFake).toBe("function");
		expect(typeof serverModule.__clearGitStatusFake).toBe("function");
		expect(typeof serverModule.__setRemoteStateForceNowFake).toBe("function");
		expect(typeof serverModule.__clearRemoteStateForceNowFake).toBe("function");
	});

	test.beforeEach(() => {
		forceRequestedAt = 1_000;
		serverModule.__setRemoteStateForceNowFake(() => forceRequestedAt);
		serverModule.__setGitStatusFake(async (_cwd: string, _containerId?: string, opts?: { untracked?: boolean }) => deterministicGitStatus(opts));
	});

	test.afterEach(() => {
		serverModule.__clearGitStatusFake();
		serverModule.__clearRemoteStateForceNowFake();
	});

	test("shares refs across sibling worktrees without sharing dirty state and preserves the mutation budget", async ({ gateway }) => {
		test.setTimeout(30_000);
		const primary = gitCwd();
		const sibling = join(primary, `.remote-state-sibling-${Date.now()}`);
		// This is the sole route scenario that owns native status fidelity. Evict
		// deterministic projections before creating either worktree consumer.
		serverModule.__clearGitStatusFake();
		serverModule.invalidateGitStatusCache(primary);
		serverModule.invalidateGitStatusCache(sibling);
		const branch = `remote-state-sibling-${Date.now()}`;
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		await runner.execFile("git", ["worktree", "add", "-b", branch, sibling], { cwd: primary, encoding: "utf-8", timeout: 10_000 });
		writeFileSync(join(sibling, "SIBLING_ONLY_DIRTY.txt"), "untracked sibling state\n");

		const primarySession = await createRemoteStateSession(gateway, primary);
		const siblingSession = await createRemoteStateSession(gateway, sibling);
		let fetches = 0;
		let resolveFetchStarted!: () => void;
		let releaseFetch!: () => void;
		const fetchStarted = new Promise<void>(resolve => { resolveFetchStarted = resolve; });
		const fetchReleased = new Promise<void>(resolve => { releaseFetch = resolve; });
		const isolatedRemote = `https://token:secret@example.github.test/acme/widget-${Date.now()}.git`;
		let primaryWs: Awaited<ReturnType<typeof connectWs>> | undefined;
		let siblingWs: Awaited<ReturnType<typeof connectWs>> | undefined;

		runner.execFile = async (file: string, args: readonly string[], options?: any) => {
			if (commandName(file) === "git" && args.join(" ") === "remote get-url origin") {
				return { stdout: `${isolatedRemote}\n`, stderr: "" };
			}
			if (commandName(file) === "git" && args.join(" ") === "fetch --quiet") {
				fetches += 1;
				resolveFetchStarted();
				await fetchReleased;
				return { stdout: "", stderr: "" };
			}
			if (commandName(file) === "git" && args[0] === "pull") return { stdout: "Already up to date.", stderr: "" };
			return originalExecFile.call(runner, file, args, options);
		};

		try {
			[primaryWs, siblingWs] = await Promise.all([connectWs(primarySession), connectWs(siblingSession)]);
			const primaryCursor = primaryWs.messageCount();
			const siblingCursor = siblingWs.messageCount();
			const responses = Promise.all([
				apiFetch(`/api/sessions/${primarySession}/git-status?intent=explicit&untracked=1`),
				apiFetch(`/api/sessions/${siblingSession}/git-status?intent=explicit&untracked=1`),
			]);
			await fetchStarted;
			await new Promise<void>(resolve => setImmediate(resolve));
			releaseFetch();
			const [primaryResponse, siblingResponse] = await responses;
			expect(fetches).toBe(1);
			const [primaryBody, siblingBody] = await Promise.all([primaryResponse.json(), siblingResponse.json()]);
			expect(JSON.stringify(primaryBody)).not.toContain("SIBLING_ONLY_DIRTY.txt");
			expect(JSON.stringify(siblingBody)).toContain("SIBLING_ONLY_DIRTY.txt");

			// The one canonical completion recomputes and broadcasts entity-local
			// status for both sibling consumers without sharing untracked state.
			await new Promise<void>(resolve => setImmediate(resolve));
			const gitFrames = [
				...primaryWs.messages.slice(primaryCursor),
				...siblingWs.messages.slice(siblingCursor),
			].filter(message => message.type === "remote_state_snapshot" && message.resource === "git");
			expect(gitFrames).toHaveLength(2);
			expect(new Set(gitFrames.map(frame => frame.sessionId))).toEqual(new Set([primarySession, siblingSession]));
			for (const frame of gitFrames) {
				expect(frame.snapshot.data).toMatchObject({ branch: expect.any(String) });
				expect(JSON.stringify(frame)).not.toContain("SIBLING_ONLY_DIRTY.txt");
				expect(JSON.stringify(frame)).not.toContain("token:secret");
			}

			// A successful mutation marks retained refs stale without erasing the
			// canonical 30-second automatic-call budget. Explicit force bypasses it.
			const beforeMutation = fetches;
			const pull = await apiFetch(`/api/sessions/${primarySession}/git-pull`, { method: "POST" });
			expect(pull.status).toBe(200);
			const automatic = await apiFetch(`/api/sessions/${primarySession}/git-status?intent=automatic`);
			expect((await automatic.json()).stale).toBe(true);
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(fetches).toBe(beforeMutation);
			await apiFetch(`/api/sessions/${primarySession}/git-status?intent=explicit`);
			expect(fetches).toBe(beforeMutation + 1);
		} finally {
			releaseFetch();
			runner.execFile = originalExecFile;
			primaryWs?.close();
			siblingWs?.close();
			await Promise.all([deleteSession(primarySession), deleteSession(siblingSession)]);
			await removeSiblingWorktree(runner, primary, sibling);
		}
	});
});
