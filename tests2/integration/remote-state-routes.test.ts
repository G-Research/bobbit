import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { awaitableRm } from "../../tests/e2e/test-utils/cleanup.js";
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, connectWs, createGoal, defaultProjectId, deleteGoal, deleteSession, gitCwd } from "./_e2e/e2e-setup.js";

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
	// Route fixtures must stay on the exact supplied repository/worktree. The
	// ordinary helper permits asynchronous session worktree provisioning, which
	// can finish (or fail and remove the live session) halfway through a slow
	// Windows run and turn later route reads into unrelated 404s.
	expect(gateway.sessionManager.getSession(sessionId)).toMatchObject({
		id: sessionId,
		cwd,
		status: "idle",
	});
	expect(gateway.sessionManager.getSession(sessionId)?.worktreePath).toBeUndefined();
	return sessionId;
}

async function removeSiblingWorktree(runner: any, primary: string, sibling: string): Promise<void> {
	// Windows can briefly retain handles after the session and websocket close.
	// Remove the filesystem tree with the shared bounded retry policy, then prune
	// Git's administrative entry and prove that both halves of teardown settled.
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

/**
 * Route-level proof that the coordinator is the only remote-read authority.
 * The runner fixture has no network access: GitHub-shaped responses are local
 * and the only observed fetch is the injected command below.
 */
test.describe("remote-state coordinator routes", () => {
	test("coalesces session Git and PR reads and only broadcasts redacted snapshot envelopes", async ({ gateway }) => {
		test.setTimeout(30_000);
		const sessionId = await createRemoteStateSession(gateway, gitCwd());
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		let gitFetches = 0;
		let prReads = 0;
		let localOnly = false;
		let remoteHost = "example.github.test";
		let remoteOrigin: string | undefined;
		let goalId: string | undefined;
		let originalTrustedHosts: unknown = [];
		let ws: Awaited<ReturnType<typeof connectWs>> | undefined;
		let sandboxWs: Awaited<ReturnType<typeof connectWs>> | undefined;
		let sandboxProjectId: string | undefined;
		const telemetry: Array<Record<string, unknown>> = [];
		const originalDebug = console.debug;
		console.debug = (...args: unknown[]) => {
			const line = args.map(String).join(" ");
			if (!line.startsWith("[remote-state] ")) return;
			try { telemetry.push(JSON.parse(line.slice("[remote-state] ".length))); } catch { /* assertion below catches missing events */ }
		};

		runner.execFile = async (file: string, args: readonly string[], options?: any) => {
			if (commandName(file) === "git" && args.join(" ") === "remote get-url origin") {
				if (localOnly) throw new Error("no origin configured");
				return { stdout: `${remoteOrigin ?? `https://token:secret@${remoteHost}/acme/widget.git`}\n`, stderr: "" };
			}
			if (commandName(file) === "git" && args.join(" ") === "fetch --quiet") {
				gitFetches += 1;
				return { stdout: "", stderr: "" };
			}
			if (commandName(file) === "git" && args[0] === "pull") return { stdout: "Already up to date.", stderr: "" };
			if (commandName(file) === "gh" && args[0] === "pr" && args[1] === "view") {
				prReads += 1;
				const customPort = Number(remoteOrigin?.match(/:(2222|2223)\//)?.[1]);
				const number = customPort || 42;
				return {
					stdout: JSON.stringify({
						number,
						url: `https://example.github.test/acme/widget/pull/${number}`,
						title: `safe title ${number}`,
						state: "OPEN",
						mergeable: "MERGEABLE",
						headRefName: "master",
						baseRefName: "master",
					}),
					stderr: "",
				};
			}
			if (commandName(file) === "gh" && args[0] === "api") {
				return { stdout: JSON.stringify({ data: { repository: { viewerPermission: "WRITE", pullRequest: { viewerCanMergeAsAdmin: false } } } }), stderr: "" };
			}
			return originalExecFile.call(runner, file, args, options);
		};

		try {
			const originalPreferences = await apiFetch("/api/preferences");
			if (originalPreferences.ok) originalTrustedHosts = (await originalPreferences.json()).githubTrustedHosts ?? [];
			const trusted = await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ githubTrustedHosts: ["example.github.test"] }),
			});
			expect(trusted.status).toBe(200);
			ws = await connectWs(sessionId);
			const cursor = ws.messageCount();
			const gitTelemetryCursor = telemetry.length;
			const gitResponses = await Promise.all([
				apiFetch(`/api/sessions/${sessionId}/git-status?intent=explicit`),
				apiFetch(`/api/sessions/${sessionId}/git-status?intent=explicit`),
			]);
			const gitBodies = await Promise.all(gitResponses.map(async response => {
				expect(response.status).toBe(200);
				return response.json();
			}));
			expect(gitFetches).toBe(1);
			const gitTelemetry = telemetry.slice(gitTelemetryCursor).filter(event => event.source === "repository");
			expect(gitTelemetry.filter(event => event.outcome === "started")).toHaveLength(1);
			expect(gitTelemetry.filter(event => event.outcome === "success")).toHaveLength(1);
			for (const body of gitBodies) {
				expect(body).toMatchObject({ source: "repository", stale: false, observedAt: expect.any(Number), refreshedAt: expect.any(Number), ageMs: expect.any(Number) });
				expect(JSON.stringify(body)).not.toContain("token:secret");
			}

			const gitFrame = await ws.waitForFrom(cursor, message => message.type === "remote_state_snapshot" && message.sessionId === sessionId && message.resource === "git");
			expect(gitFrame.snapshot).toMatchObject({ source: "repository", stale: false, observedAt: expect.any(Number), ageMs: expect.any(Number) });
			expect(JSON.stringify(gitFrame)).not.toContain("token:secret");
			expect(JSON.stringify(gitFrame)).not.toContain("example.github.test/acme/widget.git");

			const prTelemetryCursor = telemetry.length;
			const prResponses = await Promise.all([
				apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`),
				apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`),
			]);
			const prBodies = await Promise.all(prResponses.map(async response => {
				expect(response.status).toBe(200);
				return response.json();
			}));
			expect(prReads).toBe(1);
			const prTelemetry = telemetry.slice(prTelemetryCursor).filter(event => event.source === "pull_request");
			expect(prTelemetry.filter(event => event.outcome === "started")).toHaveLength(1);
			expect(prTelemetry.filter(event => event.outcome === "success")).toHaveLength(1);
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

			// Sidebar goal demand is addressed to the viewer/global channel rather than
			// only goal-attached sockets. This unrelated session socket observes it.
			const goal = await createGoal({
				title: `remote state sidebar ${Date.now()}`,
				cwd: gitCwd(),
				worktree: false,
				autoStartTeam: false,
			});
			goalId = String(goal.id);
			if (typeof goal.projectId !== "string") throw new Error("remote-state goal did not resolve a project");
			gateway.sessionManager.getGoalStoreForProject(goal.projectId).update(goalId, {
				cwd: gitCwd(),
				repoPath: gitCwd(),
				worktreePath: gitCwd(),
				branch: `remote-state-sidebar-${Date.now()}`,
				setupStatus: "ready",
			});
			gateway.clock.advance(60_000);

			// The server derives a restricted principal from the sandbox credential.
			// Even though this socket is authorized for the session, it must not see
			// unrelated global sidebar state for the goal below.
			sandboxProjectId = goal.projectId;
			const sandboxToken = gateway.sessionManager.sandboxTokenStore.register(sandboxProjectId);
			gateway.sessionManager.sandboxTokenStore.addSession(sandboxProjectId, sessionId);
			sandboxWs = await connectWs(sessionId, sandboxToken);
			const sidebarCursor = ws.messageCount();
			const sandboxSidebarCursor = sandboxWs.messageCount();
			const beforeSidebarRead = prReads;
			const sidebarResponse = await apiFetch(`/api/goals/${goalId}/pr-status?intent=sidebar`);
			expect(sidebarResponse.status).toBe(200);
			const sidebarFrame = await ws.waitForFrom(
				sidebarCursor,
				message => message.type === "remote_state_snapshot" && message.goalId === goalId && message.resource === "pr",
			);
			expect(sidebarFrame.snapshot).toMatchObject({ source: "pr", data: { number: 42 } });
			expect(prReads).toBe(beforeSidebarRead + 1);
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(sandboxWs.messages.slice(sandboxSidebarCursor).filter(
				message => message.type === "remote_state_snapshot" && message.goalId === goalId && message.resource === "pr",
			)).toHaveLength(0);

			// Restricted sockets keep entity-addressed delivery for their authorized
			// session; only the UI-only sidebar fanout is filtered.
			await new Promise(resolve => setTimeout(resolve, 260));
			const targetedCursor = sandboxWs.messageCount();
			const beforeTargetedRead = prReads;
			const targetedResponse = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`);
			expect(targetedResponse.status).toBe(200);
			const targetedFrame = await sandboxWs.waitForFrom(
				targetedCursor,
				message => message.type === "remote_state_snapshot" && message.sessionId === sessionId && message.resource === "pr",
			);
			expect(targetedFrame.snapshot).toMatchObject({ source: "pr", data: { number: 42 } });
			expect(prReads).toBe(beforeTargetedRead + 1);

			// Cache-bust completes canonical invalidation before replying, so the next
			// automatic read is immediately eligible and remains one single flight.
			const beforeBust = prReads;
			const bust = await apiFetch(`/api/goals/${goalId}/pr-cache-bust`, { method: "POST" });
			expect(bust.status).toBe(200);
			await Promise.all([
				apiFetch(`/api/goals/${goalId}/pr-status?intent=automatic`),
				apiFetch(`/api/goals/${goalId}/pr-status?intent=automatic`),
			]);
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(prReads).toBe(beforeBust + 1);

			// Trusted-looking substrings inside an untrusted URL must not alias the
			// genuine record, trigger `gh`, or broadcast retained genuine PR data.
			for (const spoof of [
				"https://evil.example/a/https://example.github.test/acme/widget.git",
				"ssh://git@evil.example/a/git@example.github.test:acme/widget.git",
			]) {
				remoteOrigin = spoof;
				const beforeSpoof = prReads;
				const spoofCursor = ws.messageCount();
				for (const intent of ["automatic", "explicit"]) {
					const response = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=${intent}&optional=1`);
					expect(response.status).toBe(204);
				}
				await new Promise<void>(resolve => setImmediate(resolve));
				expect(prReads).toBe(beforeSpoof);
				expect(ws.messages.slice(spoofCursor).filter(message => message.type === "remote_state_snapshot" && message.resource === "pr")).toHaveLength(0);
			}
			remoteOrigin = undefined;

			// A trusted GHE hostname remains trusted on custom SSH ports, while each
			// credential-free authority owns a distinct canonical PR record.
			const beforeCustomPorts = prReads;
			remoteOrigin = "ssh://git@example.github.test:2222/acme/widget.git";
			const port2222Response = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`);
			expect(port2222Response.status).toBe(200);
			const port2222Body = await port2222Response.json();
			expect(port2222Body).toMatchObject({ data: { number: 2222 } });

			remoteOrigin = "ssh://git@example.github.test:2223/acme/widget.git";
			const coldPort2223 = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=automatic`);
			expect(coldPort2223.status).toBe(200);
			const coldPort2223Body = await coldPort2223.json();
			for (let attempt = 0; attempt < 20 && prReads < beforeCustomPorts + 2; attempt += 1) {
				await new Promise<void>(resolve => setImmediate(resolve));
			}
			expect(prReads).toBe(beforeCustomPorts + 2);
			const port2223Response = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=automatic`);
			const port2223Body = await port2223Response.json();
			expect(port2223Body).toMatchObject({ data: { number: 2223 } });

			remoteOrigin = "ssh://git@example.github.test:2222/acme/widget.git";
			const retainedPort2222 = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=automatic`);
			const retainedPort2222Body = await retainedPort2222.json();
			expect(retainedPort2222Body).toMatchObject({ data: { number: 2222 } });
			expect(prReads).toBe(beforeCustomPorts + 2);
			for (const body of [port2222Body, coldPort2223Body, port2223Body, retainedPort2222Body]) {
				expect(JSON.stringify(body)).not.toContain("example.github.test:22");
			}

			// An untrusted remote is rejected before any `gh` call; configured GHE and
			// local-only repositories retain their separate supported paths.
			remoteOrigin = undefined;
			remoteHost = "gitlab.example.test";
			const beforeUntrusted = prReads;
			const untrustedResponse = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit&optional=1`);
			expect(untrustedResponse.status).toBe(204);
			expect(prReads).toBe(beforeUntrusted);

			// A no-origin repository remains entirely local: status still works but no
			// `git fetch` is attempted by the coordinator.
			localOnly = true;
			const beforeLocalRead = gitFetches;
			const localResponse = await apiFetch(`/api/sessions/${sessionId}/git-status?intent=explicit`);
			expect(localResponse.status).toBe(200);
			expect(gitFetches).toBe(beforeLocalRead);
		} finally {
			runner.execFile = originalExecFile;
			console.debug = originalDebug;
			ws?.close();
			sandboxWs?.close();
			if (sandboxProjectId) gateway.sessionManager.sandboxTokenStore.removeSession(sandboxProjectId, sessionId);
			if (goalId) await deleteGoal(goalId);
			await deleteSession(sessionId);
			await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ githubTrustedHosts: originalTrustedHosts }),
			}).catch(() => {});
		}
	});

	test("distinguishes definitive no-PR success from cold and failed optional probes", async ({ gateway }) => {
		test.setTimeout(30_000);
		const sessionId = await createRemoteStateSession(gateway, gitCwd());
		const fixtureBranch = `fixture/no-pr-${Date.now()}`;
		gateway.sessionManager.updateSessionMeta(sessionId, { branch: fixtureBranch });
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		let prReads = 0;
		let mode: "no-pr" | "failure" = "no-pr";
		const fixtureRemote = `https://github.com/acme/definitive-no-pr-${Date.now()}.git`;
		let markNoPrStarted!: () => void;
		const noPrStarted = new Promise<void>(resolve => { markNoPrStarted = resolve; });
		let releaseNoPr!: () => void;
		const noPrGate = new Promise<void>(resolve => { releaseNoPr = resolve; });

		runner.execFile = async (file: string, args: readonly string[], options?: any) => {
			if (commandName(file) === "git" && args.join(" ") === "remote get-url origin") {
				return { stdout: `${fixtureRemote}\n`, stderr: "" };
			}
			if (commandName(file) === "gh" && args[0] === "pr" && args[1] === "view") {
				prReads += 1;
				if (mode === "no-pr") {
					markNoPrStarted();
					await noPrGate;
					const error = new Error(`no pull requests found for branch ${fixtureBranch}`);
					(error as any).stderr = `no pull requests found for branch ${fixtureBranch}`;
					throw error;
				}
				const error = new Error("network timeout while reading fixture PR state");
				(error as any).stderr = "fixture transport unavailable";
				throw error;
			}
			return originalExecFile.call(runner, file, args, options);
		};

		try {
			// Hold the fixture lookup open so an optional automatic read deterministically
			// observes cold in-flight state rather than already-completed absence.
			const barePromise = apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`);
			await noPrStarted;
			const coldResponse = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=automatic&optional=1`);
			expect(coldResponse.status).toBe(200);
			const coldBody = await coldResponse.json();
			expect(coldBody).toMatchObject({
				source: "pr",
				stale: true,
				observedAt: expect.any(Number),
				ageMs: 0,
			});
			expect(coldBody).not.toHaveProperty("data");
			expect(coldBody).not.toHaveProperty("refreshedAt");
			expect(coldBody).not.toHaveProperty("lastError");

			// The single coordinated probe reports the gh CLI's definitive no-PR
			// outcome, which is successful null state rather than a transport failure.
			releaseNoPr();
			const bareResponse = await barePromise;
			expect(bareResponse.status).toBe(200);
			const noPrBody = await bareResponse.json();
			expect(noPrBody).toMatchObject({
				data: null,
				source: "pr",
				stale: false,
				observedAt: expect.any(Number),
				refreshedAt: expect.any(Number),
				ageMs: expect.any(Number),
			});
			expect(noPrBody).not.toHaveProperty("lastError");
			expect(prReads).toBe(1);

			const readsAfterNoPr = prReads;
			const optionalResponse = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=automatic&optional=1`);
			expect(optionalResponse.status).toBe(204);
			expect(await optionalResponse.text()).toBe("");
			expect(prReads).toBe(readsAfterNoPr);

			// A failed forced refresh retains the last-good null, but lastError makes
			// it diagnostics-bearing stale state. optional=1 must not erase it as 204.
			mode = "failure";
			await new Promise(resolve => setTimeout(resolve, 260));
			const failedResponse = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit&optional=1`);
			expect(failedResponse.status).toBe(200);
			const failedBody = await failedResponse.json();
			expect(failedBody).toMatchObject({
				data: null,
				source: "pr",
				stale: true,
				lastError: "offline",
				refreshedAt: noPrBody.refreshedAt,
				observedAt: expect.any(Number),
				ageMs: expect.any(Number),
			});
			expect(prReads).toBe(readsAfterNoPr + 1);
		} finally {
			releaseNoPr();
			runner.execFile = originalExecFile;
			await deleteSession(sessionId);
		}
	});

	test("selects a working fallback locally before issuing one coordinated PR read", async ({ gateway }) => {
		test.setTimeout(30_000);
		const primaryCwd = gitCwd();
		const fallbackCwd = process.cwd();
		const sessionId = await createRemoteStateSession(gateway, primaryCwd);
		const branch = `fixture/broken-worktree-${Date.now()}`;
		gateway.sessionManager.updateSessionMeta(sessionId, { branch });
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		let prReads = 0;
		let prReadCwd: string | undefined;

		runner.execFile = async (file: string, args: readonly string[], options?: any) => {
			if (commandName(file) === "git" && args.join(" ") === "rev-parse --git-dir" && String(options?.cwd) === primaryCwd) {
				throw new Error("broken worktree git link");
			}
			if (commandName(file) === "git" && args.join(" ") === "remote get-url origin") {
				return { stdout: "https://github.com/acme/local-preflight-fallback.git\n", stderr: "" };
			}
			if (commandName(file) === "gh" && args[0] === "pr" && args[1] === "view") {
				prReads += 1;
				prReadCwd = String(options?.cwd);
				return {
					stdout: JSON.stringify({
						number: 88,
						url: "https://github.com/acme/local-preflight-fallback/pull/88",
						title: "fallback result",
						state: "OPEN",
						mergeable: "MERGEABLE",
						headRefName: branch,
						baseRefName: "main",
					}),
					stderr: "",
				};
			}
			if (commandName(file) === "gh" && args[0] === "api") {
				return { stdout: JSON.stringify({ data: { repository: { viewerPermission: "WRITE", pullRequest: { viewerCanMergeAsAdmin: false } } } }), stderr: "" };
			}
			return originalExecFile.call(runner, file, args, options);
		};

		try {
			const response = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ data: { number: 88, title: "fallback result" }, stale: false });
			expect(prReads).toBe(1);
			expect(prReadCwd).toBe(fallbackCwd);
		} finally {
			runner.execFile = originalExecFile;
			await deleteSession(sessionId);
		}
	});

	test("successful goal and sandbox session merges invalidate their shared canonical PR snapshot", async ({ gateway }) => {
		test.setTimeout(30_000);
		const hostCwd = gitCwd();
		const branch = `fixture/merge-invalidation-${Date.now()}`;
		const sessionId = await createRemoteStateSession(gateway, hostCwd);
		gateway.sessionManager.updateSessionMeta(sessionId, { branch, worktreePath: hostCwd });
		const session = gateway.sessionManager.getSession(sessionId) as any;
		session.sandboxed = true;
		session.containerId = "fixture-pr-merge-container";
		session.worktreePath = hostCwd;
		session.cwd = "/workspace/fixture-pr-merge";

		const goal = await createGoal({
			title: `remote state merge ${Date.now()}`,
			cwd: hostCwd,
			worktree: false,
			autoStartTeam: false,
		});
		const goalId = String(goal.id);
		if (typeof goal.projectId !== "string") throw new Error("merge fixture goal did not resolve a project");
		gateway.sessionManager.getGoalStoreForProject(goal.projectId).update(goalId, {
			cwd: hostCwd,
			repoPath: hostCwd,
			worktreePath: hostCwd,
			branch,
			setupStatus: "ready",
		});

		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		let prReads = 0;
		let version = 1;
		let rejectMerge = false;
		const waitForReads = async (expected: number) => {
			for (let attempt = 0; attempt < 40 && prReads < expected; attempt += 1) await new Promise<void>(resolve => setImmediate(resolve));
			expect(prReads).toBe(expected);
		};

		runner.execFile = async (file: string, args: readonly string[], options?: any) => {
			if (commandName(file) === "docker" && args.at(-1) === "git rev-parse --abbrev-ref HEAD") {
				return { stdout: `${branch}\n`, stderr: "" };
			}
			if (commandName(file) === "git" && args.join(" ") === "remote get-url origin") {
				return { stdout: "https://github.com/acme/merge-invalidation.git\n", stderr: "" };
			}
			if (commandName(file) === "gh" && args[0] === "pr" && args[1] === "view") {
				prReads += 1;
				return {
					stdout: JSON.stringify({
						number: 99,
						url: "https://github.com/acme/merge-invalidation/pull/99",
						title: `merge version ${version}`,
						state: version === 1 ? "OPEN" : "MERGED",
						mergeable: "MERGEABLE",
						headRefName: branch,
						baseRefName: "main",
					}),
					stderr: "",
				};
			}
			if (commandName(file) === "gh" && args[0] === "pr" && args[1] === "merge") {
				if (rejectMerge) throw new Error("fixture merge rejected");
				version += 1;
				return { stdout: "merged", stderr: "" };
			}
			if (commandName(file) === "gh" && args[0] === "api") {
				return { stdout: JSON.stringify({ data: { repository: { viewerPermission: "WRITE", pullRequest: { viewerCanMergeAsAdmin: false } } } }), stderr: "" };
			}
			return originalExecFile.call(runner, file, args, options);
		};

		try {
			const seeded = await Promise.all([
				apiFetch(`/api/goals/${goalId}/pr-status?intent=explicit`),
				apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`),
			]);
			for (const response of seeded) expect(await response.json()).toMatchObject({ data: { state: "OPEN", title: "merge version 1" } });
			expect(prReads).toBe(1);

			const goalMerge = await apiFetch(`/api/goals/${goalId}/pr-merge`, {
				method: "POST",
				body: JSON.stringify({ method: "squash", branch: "client-goal-display-branch" }),
			});
			expect(goalMerge.status).toBe(200);
			const afterGoalMerge = await Promise.all([
				apiFetch(`/api/goals/${goalId}/pr-status?intent=automatic`),
				apiFetch(`/api/sessions/${sessionId}/pr-status?intent=automatic`),
			]);
			const afterGoalBodies = await Promise.all(afterGoalMerge.map(response => response.json()));
			// The first SWR observer retains OPEN while a later concurrent observer may
			// already see the synchronously completed fixture refresh.
			expect(afterGoalBodies).toContainEqual(expect.objectContaining({ stale: true, data: expect.objectContaining({ state: "OPEN" }) }));
			await waitForReads(2);
			const [goalFresh, sessionFreshAfterGoal] = await Promise.all([
				apiFetch(`/api/goals/${goalId}/pr-status?intent=automatic`),
				apiFetch(`/api/sessions/${sessionId}/pr-status?intent=automatic`),
			]);
			for (const response of [goalFresh, sessionFreshAfterGoal]) {
				expect(await response.json()).toMatchObject({ stale: false, data: { state: "MERGED", title: "merge version 2" } });
			}

			const sessionMerge = await apiFetch(`/api/sessions/${sessionId}/pr-merge`, {
				method: "POST",
				body: JSON.stringify({ method: "rebase", branch: "client-session-display-branch" }),
			});
			expect(sessionMerge.status).toBe(200);
			const staleAfterSessionMerge = await apiFetch(`/api/goals/${goalId}/pr-status?intent=automatic`);
			expect(await staleAfterSessionMerge.json()).toMatchObject({ stale: true, data: { title: "merge version 2" } });
			await waitForReads(3);
			const sessionFresh = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=automatic`);
			expect(await sessionFresh.json()).toMatchObject({ stale: false, data: { title: "merge version 3" } });

			rejectMerge = true;
			const readsBeforeRejectedMerge = prReads;
			const rejectedMerge = await apiFetch(`/api/sessions/${sessionId}/pr-merge`, {
				method: "POST",
				body: JSON.stringify({ method: "merge", branch: "client-rejected-display-branch" }),
			});
			expect(rejectedMerge.status).toBe(500);
			const retained = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=automatic`);
			expect(await retained.json()).toMatchObject({ stale: false, data: { title: "merge version 3" } });
			expect(prReads).toBe(readsBeforeRejectedMerge);
		} finally {
			runner.execFile = originalExecFile;
			await deleteSession(sessionId);
			await deleteGoal(goalId);
		}
	});

	test("retains PR last-good state through categorized failures, backoff, and concurrent forced recovery", async ({ gateway }) => {
		test.setTimeout(30_000);
		const sessionId = await createRemoteStateSession(gateway, gitCwd());
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		let prReads = 0;
		let version = 1;
		let failure: string | undefined;
		let recoveryGate: Promise<void> | undefined;
		let recoveryStarted: (() => void) | undefined;
		let ws: Awaited<ReturnType<typeof connectWs>> | undefined;

		runner.execFile = async (file: string, args: readonly string[], options?: any) => {
			if (commandName(file) === "git" && args.join(" ") === "remote get-url origin") {
				return { stdout: "https://token:secret@github.com/acme/route-failure.git\n", stderr: "" };
			}
			if (commandName(file) === "gh" && args[0] === "pr" && args[1] === "view") {
				prReads += 1;
				if (failure) {
					const error = new Error(`${failure} token:secret https://secret@example.test/private`);
					(error as any).stderr = "private stderr and review body";
					throw error;
				}
				if (recoveryGate) {
					recoveryStarted?.();
					await recoveryGate;
				}
				return {
					stdout: JSON.stringify({
						number: 77,
						url: "https://github.com/acme/route-failure/pull/77",
						title: `safe version ${version}`,
						state: "OPEN",
						mergeable: "MERGEABLE",
						headRefName: "master",
						baseRefName: "master",
					}),
					stderr: "",
				};
			}
			if (commandName(file) === "gh" && args[0] === "api") {
				return { stdout: JSON.stringify({ data: { repository: { viewerPermission: "WRITE", pullRequest: { viewerCanMergeAsAdmin: false } } } }), stderr: "" };
			}
			return originalExecFile.call(runner, file, args, options);
		};

		try {
			ws = await connectWs(sessionId);
			const seededResponse = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`);
			expect(seededResponse.status).toBe(200);
			let retained = await seededResponse.json();
			expect(retained).toMatchObject({ stale: false, data: { title: "safe version 1" } });

			for (const scenario of [
				{ message: "network timeout", kind: "offline" },
				{ message: "HTTP 401 bad credentials", kind: "auth" },
				{ message: "HTTP 429 secondary rate limit", kind: "rate_limited" },
			]) {
				gateway.clock.advance(20_000);
				failure = scenario.message;
				const beforeFailure = prReads;
				const cursor = ws.messageCount();
				const staleResponse = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=automatic`);
				expect(staleResponse.status).toBe(200);
				const failureFrame = await ws.waitForFrom(
					cursor,
					message => message.type === "remote_state_snapshot" && message.resource === "pr" && message.snapshot?.lastError === scenario.kind,
				);
				expect(prReads).toBeGreaterThan(beforeFailure);
				const afterFailure = prReads;
				expect(failureFrame.snapshot).toMatchObject({
					stale: true,
					lastError: scenario.kind,
					refreshedAt: retained.refreshedAt,
					data: retained.data,
				});
				expect(JSON.stringify(failureFrame)).not.toContain("token:secret");
				expect(JSON.stringify(failureFrame)).not.toContain("private stderr");

				const duringBackoff = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=automatic`);
				expect(await duringBackoff.json()).toMatchObject({
					stale: true,
					lastError: scenario.kind,
					refreshedAt: retained.refreshedAt,
					data: retained.data,
				});
				expect(prReads).toBe(afterFailure);

				failure = undefined;
				version += 1;
				gateway.clock.advance(1);
				// Route force requests use a short real-time burst marker. Keep this
				// recovery distinct from the previous explicit cycle while the two
				// requests below still land in the same burst and join one flight.
				await new Promise(resolve => setTimeout(resolve, 260));
				let releaseRecovery!: () => void;
				let markRecoveryStarted!: () => void;
				const recoveryStartedPromise = new Promise<void>(resolve => { markRecoveryStarted = resolve; });
				recoveryStarted = markRecoveryStarted;
				recoveryGate = new Promise<void>(resolve => { releaseRecovery = resolve; });
				const beforeRecovery = prReads;
				const recovering = Promise.all([
					apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`),
					apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`),
				]);
				await recoveryStartedPromise;
				await new Promise<void>(resolve => setImmediate(resolve));
				releaseRecovery();
				const recoveryResponses = await recovering;
				recoveryGate = undefined;
				recoveryStarted = undefined;
				expect(prReads).toBe(beforeRecovery + 1);
				const recoveryBodies = await Promise.all(recoveryResponses.map(response => response.json()));
				for (const body of recoveryBodies) {
					expect(body).toMatchObject({ stale: false, data: { title: `safe version ${version}` } });
					expect(body.lastError).toBeUndefined();
				}
				retained = recoveryBodies[0];
			}
		} finally {
			recoveryGate = undefined;
			runner.execFile = originalExecFile;
			ws?.close();
			await deleteSession(sessionId);
		}
	});

	test("resolves missing PR branch metadata per sibling head without cross-record leakage", async ({ gateway }) => {
		test.setTimeout(30_000);
		const primary = gitCwd();
		const sibling = join(primary, `.remote-pr-head-sibling-${Date.now()}`);
		const siblingBranch = `remote-pr-head-sibling-${Date.now()}`;
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		await runner.execFile("git", ["worktree", "add", "-b", siblingBranch, sibling], { cwd: primary, encoding: "utf-8", timeout: 10_000 });
		const primarySession = await createRemoteStateSession(gateway, primary);
		const siblingSession = await createRemoteStateSession(gateway, sibling);
		gateway.sessionManager.updateSessionMeta(primarySession, { branch: "" });
		gateway.sessionManager.updateSessionMeta(siblingSession, { branch: "" });
		const privatePrimaryHead = "private-primary-selector";
		const privateSiblingHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		let headUnavailable = false;
		let prReads = 0;
		let primaryWs: Awaited<ReturnType<typeof connectWs>> | undefined;
		let siblingWs: Awaited<ReturnType<typeof connectWs>> | undefined;
		const telemetry: Array<Record<string, unknown>> = [];
		const originalDebug = console.debug;
		console.debug = (...args: unknown[]) => {
			const line = args.map(String).join(" ");
			if (!line.startsWith("[remote-state] ")) return;
			try { telemetry.push(JSON.parse(line.slice("[remote-state] ".length))); } catch { /* assertions below cover safety */ }
		};

		runner.execFile = async (file: string, args: readonly string[], options?: any) => {
			if (commandName(file) === "git" && args.join(" ") === "remote get-url origin") {
				return { stdout: "https://github.com/acme/private-head-isolation.git\n", stderr: "" };
			}
			if (commandName(file) === "git" && args.join(" ") === "symbolic-ref --quiet --short HEAD") {
				if (headUnavailable || String(options?.cwd) === sibling) throw new Error("detached or unavailable HEAD");
				return { stdout: `${privatePrimaryHead}\n`, stderr: "" };
			}
			if (commandName(file) === "git" && args.join(" ") === "rev-parse --verify HEAD^{commit}") {
				if (headUnavailable) throw new Error("unborn HEAD");
				if (String(options?.cwd) === sibling) return { stdout: `${privateSiblingHead}\n`, stderr: "" };
			}
			if (commandName(file) === "gh" && args[0] === "pr" && args[1] === "view") {
				prReads += 1;
				const isSibling = String(options?.cwd) === sibling;
				const number = isSibling ? 202 : 101;
				return {
					stdout: JSON.stringify({
						number,
						url: `https://github.com/acme/private-head-isolation/pull/${number}`,
						title: isSibling ? "sibling result" : "primary result",
						state: "OPEN",
						mergeable: "MERGEABLE",
						headRefName: isSibling ? "public-sibling" : "public-primary",
						baseRefName: "main",
					}),
					stderr: "",
				};
			}
			if (commandName(file) === "gh" && args[0] === "api") {
				return { stdout: JSON.stringify({ data: { repository: { viewerPermission: "WRITE", pullRequest: { viewerCanMergeAsAdmin: false } } } }), stderr: "" };
			}
			return originalExecFile.call(runner, file, args, options);
		};

		try {
			[primaryWs, siblingWs] = await Promise.all([connectWs(primarySession), connectWs(siblingSession)]);
			const primaryCursor = primaryWs.messageCount();
			const siblingCursor = siblingWs.messageCount();
			const [primaryResponse, siblingResponse] = await Promise.all([
				apiFetch(`/api/sessions/${primarySession}/pr-status?intent=explicit`),
				apiFetch(`/api/sessions/${siblingSession}/pr-status?intent=explicit`),
			]);
			expect(primaryResponse.status).toBe(200);
			expect(siblingResponse.status).toBe(200);
			const [primaryBody, siblingBody] = await Promise.all([primaryResponse.json(), siblingResponse.json()]);
			expect(primaryBody).toMatchObject({ data: { number: 101, title: "primary result" } });
			expect(siblingBody).toMatchObject({ data: { number: 202, title: "sibling result" } });
			expect(prReads).toBe(2);

			const [primaryFrame, siblingFrame] = await Promise.all([
				primaryWs.waitForFrom(primaryCursor, message => message.type === "remote_state_snapshot" && message.resource === "pr"),
				siblingWs.waitForFrom(siblingCursor, message => message.type === "remote_state_snapshot" && message.resource === "pr"),
			]);
			expect(primaryFrame.snapshot.data).toMatchObject({ number: 101 });
			expect(siblingFrame.snapshot.data).toMatchObject({ number: 202 });

			headUnavailable = true;
			const beforeUnsupported = prReads;
			const unsupported = await apiFetch(`/api/sessions/${primarySession}/pr-status?intent=explicit&optional=1`);
			expect(unsupported.status).toBe(204);
			expect(prReads).toBe(beforeUnsupported);

			const publicOutput = JSON.stringify({ primaryBody, siblingBody, primaryFrame, siblingFrame, telemetry });
			expect(publicOutput).not.toContain(privatePrimaryHead);
			expect(publicOutput).not.toContain(privateSiblingHead);
			expect(publicOutput).not.toContain("#head:");
		} finally {
			runner.execFile = originalExecFile;
			console.debug = originalDebug;
			primaryWs?.close();
			siblingWs?.close();
			await Promise.all([deleteSession(primarySession), deleteSession(siblingSession)]);
			await removeSiblingWorktree(runner, primary, sibling);
		}
	});

	test("shares refs across sibling worktrees without sharing dirty state and preserves the mutation budget", async ({ gateway }) => {
		test.setTimeout(30_000);
		const primary = gitCwd();
		const sibling = join(primary, `.remote-state-sibling-${Date.now()}`);
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
