import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, connectWs, createGoal, createSession, deleteGoal, deleteSession, gitCwd } from "./_e2e/e2e-setup.js";

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
		let remoteHost = "example.github.test";
		let remoteOrigin: string | undefined;
		let goalId: string | undefined;
		let originalTrustedHosts: unknown = [];
		let ws: Awaited<ReturnType<typeof connectWs>> | undefined;
		const telemetry: Array<Record<string, unknown>> = [];
		const originalDebug = console.debug;
		console.debug = (...args: unknown[]) => {
			const line = args.map(String).join(" ");
			if (!line.startsWith("[remote-state] ")) return;
			try { telemetry.push(JSON.parse(line.slice("[remote-state] ".length))); } catch { /* assertion below catches missing events */ }
		};

		runner.execFile = async (file: string, args: readonly string[], options?: any) => {
			if (file === "git" && args.join(" ") === "remote get-url origin") {
				if (localOnly) throw new Error("no origin configured");
				return { stdout: `${remoteOrigin ?? `https://token:secret@${remoteHost}/acme/widget.git`}\n`, stderr: "" };
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
			const sidebarCursor = ws.messageCount();
			const sidebarResponse = await apiFetch(`/api/goals/${goalId}/pr-status?intent=sidebar`);
			expect(sidebarResponse.status).toBe(200);
			const sidebarFrame = await ws.waitForFrom(
				sidebarCursor,
				message => message.type === "remote_state_snapshot" && message.goalId === goalId && message.resource === "pr",
			);
			expect(sidebarFrame.snapshot).toMatchObject({ source: "pr", data: { number: 42 } });

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

			// An untrusted remote is rejected before any `gh` call; configured GHE and
			// local-only repositories retain their separate supported paths.
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
			if (goalId) await deleteGoal(goalId);
			await deleteSession(sessionId);
			await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ githubTrustedHosts: originalTrustedHosts }),
			}).catch(() => {});
		}
	});

	test("retains PR last-good state through categorized failures, backoff, and concurrent forced recovery", async ({ gateway }) => {
		test.setTimeout(30_000);
		const sessionId = await createSession({ cwd: gitCwd() });
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		let prReads = 0;
		let version = 1;
		let failure: string | undefined;
		let recoveryGate: Promise<void> | undefined;
		let recoveryStarted: (() => void) | undefined;
		let ws: Awaited<ReturnType<typeof connectWs>> | undefined;

		runner.execFile = async (file: string, args: readonly string[], options?: any) => {
			if (file === "git" && args.join(" ") === "remote get-url origin") {
				return { stdout: "https://token:secret@github.com/acme/route-failure.git\n", stderr: "" };
			}
			if (file === "gh" && args[0] === "pr" && args[1] === "view") {
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
			if (file === "gh" && args[0] === "api") {
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

	test("shares refs across sibling worktrees without sharing dirty state and preserves the mutation budget", async ({ gateway }) => {
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
		let resolveFetchStarted!: () => void;
		let releaseFetch!: () => void;
		const fetchStarted = new Promise<void>(resolve => { resolveFetchStarted = resolve; });
		const fetchReleased = new Promise<void>(resolve => { releaseFetch = resolve; });
		const isolatedRemote = `https://token:secret@example.github.test/acme/widget-${Date.now()}.git`;
		let primaryWs: Awaited<ReturnType<typeof connectWs>> | undefined;
		let siblingWs: Awaited<ReturnType<typeof connectWs>> | undefined;

		runner.execFile = async (file: string, args: readonly string[], options?: any) => {
			if (file === "git" && args.join(" ") === "remote get-url origin") {
				return { stdout: `${isolatedRemote}\n`, stderr: "" };
			}
			if (file === "git" && args.join(" ") === "fetch --quiet") {
				fetches += 1;
				resolveFetchStarted();
				await fetchReleased;
				return { stdout: "", stderr: "" };
			}
			if (file === "git" && args[0] === "pull") return { stdout: "Already up to date.", stderr: "" };
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
			await runner.execFile("git", ["worktree", "remove", "--force", sibling], { cwd: primary, encoding: "utf-8", timeout: 10_000 });
			rmSync(sibling, { recursive: true, force: true });
		}
	});
});
