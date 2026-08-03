import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, connectWs, createSession, deleteSession, gitCwd } from "./_e2e/e2e-setup.js";

/**
 * Route-level proof that the coordinator is the only remote-read authority.
 * The runner fixture has no network access: GitHub-shaped responses are local
 * and the only observed fetch is the injected command below.
 */
test.describe("remote-state coordinator routes", () => {
	test("coalesces session Git and PR reads and only broadcasts redacted snapshot envelopes", async ({ gateway }) => {
		test.setTimeout(30_000);
		const sessionId = await createSession({ cwd: gitCwd() });
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		let gitFetches = 0;
		let prReads = 0;
		let localOnly = false;
		const credentialUrl = "https://token:secret@example.github.test/acme/widget.git";
		let ws: Awaited<ReturnType<typeof connectWs>> | undefined;

		runner.execFile = async (file: string, args: readonly string[], options?: any) => {
			if (file === "git" && args.join(" ") === "remote get-url origin") {
				if (localOnly) throw new Error("no origin configured");
				return { stdout: `${credentialUrl}\n`, stderr: "" };
			}
			if (file === "git" && args.join(" ") === "fetch --quiet") {
				gitFetches += 1;
				return { stdout: "", stderr: "" };
			}
			if (file === "git" && args[0] === "pull") return { stdout: "Already up to date.", stderr: "" };
			if (file === "gh" && args[0] === "pr" && args[1] === "view") {
				prReads += 1;
				return {
					stdout: JSON.stringify({
						number: 42,
						url: "https://example.github.test/acme/widget/pull/42",
						title: "safe title",
						state: "OPEN",
						mergeable: "MERGEABLE",
						headRefName: "master",
						baseRefName: "master",
					}),
					stderr: "",
				};
			}
			if (file === "gh" && args[0] === "api") {
				return { stdout: JSON.stringify({ data: { repository: { viewerPermission: "WRITE", pullRequest: { viewerCanMergeAsAdmin: false } } } }), stderr: "" };
			}
			return originalExecFile.call(runner, file, args, options);
		};

		try {
			ws = await connectWs(sessionId);
			const cursor = ws.messageCount();
			const gitResponses = await Promise.all([
				apiFetch(`/api/sessions/${sessionId}/git-status?intent=explicit`),
				apiFetch(`/api/sessions/${sessionId}/git-status?intent=explicit`),
			]);
			const gitBodies = await Promise.all(gitResponses.map(async response => {
				expect(response.status).toBe(200);
				return response.json();
			}));
			expect(gitFetches).toBe(1);
			for (const body of gitBodies) {
				expect(body).toMatchObject({ source: "repository", stale: false, observedAt: expect.any(Number), refreshedAt: expect.any(Number), ageMs: expect.any(Number) });
				expect(JSON.stringify(body)).not.toContain("token:secret");
			}

			const gitFrame = await ws.waitForFrom(cursor, message => message.type === "remote_state_snapshot" && message.sessionId === sessionId && message.resource === "git");
			expect(gitFrame.snapshot).toMatchObject({ source: "repository", stale: false, observedAt: expect.any(Number), ageMs: expect.any(Number) });
			expect(JSON.stringify(gitFrame)).not.toContain("token:secret");
			expect(JSON.stringify(gitFrame)).not.toContain("example.github.test/acme/widget.git");

			const prResponses = await Promise.all([
				apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`),
				apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`),
			]);
			const prBodies = await Promise.all(prResponses.map(async response => {
				expect(response.status).toBe(200);
				return response.json();
			}));
			expect(prReads).toBe(1);
			for (const body of prBodies) {
				expect(body).toMatchObject({ source: "pr", stale: false, data: { number: 42 }, observedAt: expect.any(Number), refreshedAt: expect.any(Number) });
				expect(JSON.stringify(body)).not.toContain("token:secret");
			}

			// Sidebar demand retains the fresh PR record; an active read becomes due
			// after its shorter 20-second window without browser-count multiplication.
			await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=sidebar`);
			expect(prReads).toBe(1);
			gateway.clock.advance(20_000);
			await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=automatic`);
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(prReads).toBe(2);

			// A no-origin repository remains entirely local: status still works but no
			// `git fetch` is attempted by the coordinator.
			localOnly = true;
			const beforeLocalRead = gitFetches;
			const localResponse = await apiFetch(`/api/sessions/${sessionId}/git-status?intent=explicit`);
			expect(localResponse.status).toBe(200);
			expect(gitFetches).toBe(beforeLocalRead);
		} finally {
			runner.execFile = originalExecFile;
			ws?.close();
			await deleteSession(sessionId);
		}
	});

	test("shares refs across sibling worktrees without sharing dirty state, and invalidates immediately after a mutation", async ({ gateway }) => {
		test.setTimeout(30_000);
		const primary = gitCwd();
		const sibling = join(primary, `.remote-state-sibling-${Date.now()}`);
		const branch = `remote-state-sibling-${Date.now()}`;
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		await runner.execFile("git", ["worktree", "add", "-b", branch, sibling], { cwd: primary, encoding: "utf-8", timeout: 10_000 });
		writeFileSync(join(sibling, "SIBLING_ONLY_DIRTY.txt"), "untracked sibling state\n");

		const primarySession = await createSession({ cwd: primary });
		const siblingSession = await createSession({ cwd: sibling });
		let fetches = 0;
		let primaryWs: Awaited<ReturnType<typeof connectWs>> | undefined;
		let siblingWs: Awaited<ReturnType<typeof connectWs>> | undefined;

		runner.execFile = async (file: string, args: readonly string[], options?: any) => {
			if (file === "git" && args.join(" ") === "remote get-url origin") {
				return { stdout: "https://token:secret@example.github.test/acme/widget.git\n", stderr: "" };
			}
			if (file === "git" && args.join(" ") === "fetch --quiet") {
				fetches += 1;
				return { stdout: "", stderr: "" };
			}
			if (file === "git" && args[0] === "pull") return { stdout: "Already up to date.", stderr: "" };
			return originalExecFile.call(runner, file, args, options);
		};

		try {
			[primaryWs, siblingWs] = await Promise.all([connectWs(primarySession), connectWs(siblingSession)]);
			const primaryCursor = primaryWs.messageCount();
			const siblingCursor = siblingWs.messageCount();
			const [primaryResponse, siblingResponse] = await Promise.all([
				apiFetch(`/api/sessions/${primarySession}/git-status?intent=explicit`),
				apiFetch(`/api/sessions/${siblingSession}/git-status?intent=explicit`),
			]);
			expect(fetches).toBe(1);
			const [primaryBody, siblingBody] = await Promise.all([primaryResponse.json(), siblingResponse.json()]);
			expect(JSON.stringify(primaryBody)).not.toContain("SIBLING_ONLY_DIRTY.txt");
			expect(JSON.stringify(siblingBody)).toContain("SIBLING_ONLY_DIRTY.txt");

			const [primaryFrame, siblingFrame] = await Promise.all([
				primaryWs.waitForFrom(primaryCursor, message => message.type === "remote_state_snapshot" && message.resource === "git"),
				siblingWs.waitForFrom(siblingCursor, message => message.type === "remote_state_snapshot" && message.resource === "git"),
			]);
			for (const frame of [primaryFrame, siblingFrame]) {
				expect(JSON.stringify(frame)).not.toContain("SIBLING_ONLY_DIRTY.txt");
				expect(JSON.stringify(frame)).not.toContain("token:secret");
			}

			// A successful pull is a mutation boundary. The following automatic read
			// must not wait for the 30-second remote freshness window.
			const beforeMutation = fetches;
			const pull = await apiFetch(`/api/sessions/${primarySession}/git-pull`, { method: "POST" });
			expect(pull.status).toBe(200);
			await apiFetch(`/api/sessions/${primarySession}/git-status?intent=automatic`);
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(fetches).toBe(beforeMutation + 1);
		} finally {
			runner.execFile = originalExecFile;
			primaryWs?.close();
			siblingWs?.close();
			await Promise.all([deleteSession(primarySession), deleteSession(siblingSession)]);
			await runner.execFile("git", ["worktree", "remove", "--force", sibling], { cwd: primary, encoding: "utf-8", timeout: 10_000 });
			rmSync(sibling, { recursive: true, force: true });
		}
	});
});
