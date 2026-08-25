import {
	mkdirSync,
	writeFileSync,
	join,
	awaitableRm,
	test,
	expect,
	apiFetch,
	connectWs,
	createGoal,
	deleteGoal,
	deleteSession,
	gitCwd,
	crossForceCoalescingWindow,
	unexpectedRunnerCommand,
	standardSingleRepositoryProbe,
	commandName,
	ownedHeadEvidence,
	createRemoteStateSession,
	removeSiblingWorktree,
	installRemoteStateRouteHooks,
	serverModule,
} from "../../support/harnesses/integration/remote-state-routes-fixture.js";

test.describe("remote-state coordinator routes", () => {
	installRemoteStateRouteHooks();

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
			if (commandName(file) === "docker" && args.includes("check-ref-format")) {
				return { stdout: `${branch}\n`, stderr: "" };
			}
			if (commandName(file) === "git" && args.join(" ") === "remote get-url origin") {
				return { stdout: "https://github.com/acme/merge-invalidation.git\n", stderr: "" };
			}
			if (commandName(file) === "gh" && args[0] === "pr" && args[1] === "list") {
				prReads += 1;
				return {
					stdout: JSON.stringify([{
						number: 99,
						url: "https://github.com/acme/merge-invalidation/pull/99",
						title: `merge version ${version}`,
						state: version === 1 ? "OPEN" : "MERGED",
						mergeable: "MERGEABLE",
						headRefName: branch,
						baseRefName: "main",
						...ownedHeadEvidence("acme", "merge-invalidation"),
					}]),
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
			const probe = standardSingleRepositoryProbe(file, args, hostCwd);
			if (probe) return probe;
			return unexpectedRunnerCommand(file, args, options);
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
				body: JSON.stringify({ method: "squash", branch }),
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

			crossForceCoalescingWindow();
			const sessionMerge = await apiFetch(`/api/sessions/${sessionId}/pr-merge`, {
				method: "POST",
				body: JSON.stringify({ method: "rebase", branch }),
			});
			expect(sessionMerge.status).toBe(200);
			const staleAfterSessionMerge = await apiFetch(`/api/goals/${goalId}/pr-status?intent=automatic`);
			expect(await staleAfterSessionMerge.json()).toMatchObject({ stale: true, data: { title: "merge version 2" } });
			await waitForReads(4);
			const sessionFresh = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=automatic`);
			expect(await sessionFresh.json()).toMatchObject({ stale: false, data: { title: "merge version 3" } });

			rejectMerge = true;
			crossForceCoalescingWindow();
			const readsBeforeRejectedMerge = prReads;
			const rejectedMerge = await apiFetch(`/api/sessions/${sessionId}/pr-merge`, {
				method: "POST",
				body: JSON.stringify({ method: "merge", branch }),
			});
			expect(rejectedMerge.status).toBe(500);
			const retained = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=automatic`);
			expect(await retained.json()).toMatchObject({ stale: false, data: { title: "merge version 3" } });
			expect(prReads).toBe(readsBeforeRejectedMerge + 1);
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
			if (commandName(file) === "gh" && args[0] === "pr" && args[1] === "list") {
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
					stdout: JSON.stringify([{
						number: 77,
						url: "https://github.com/acme/route-failure/pull/77",
						title: `safe version ${version}`,
						state: "OPEN",
						mergeable: "MERGEABLE",
						headRefName: args[args.indexOf("--head") + 1],
						baseRefName: "master",
						...ownedHeadEvidence("acme", "route-failure"),
					}]),
					stderr: "",
				};
			}
			if (commandName(file) === "gh" && args[0] === "api") {
				return { stdout: JSON.stringify({ data: { repository: { viewerPermission: "WRITE", pullRequest: { viewerCanMergeAsAdmin: false } } } }), stderr: "" };
			}
			const probe = standardSingleRepositoryProbe(file, args, gitCwd());
			if (probe) return probe;
			return unexpectedRunnerCommand(file, args, options);
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
				// Keep this recovery distinct from the previous explicit cycle while the
				// two requests below retain one burst timestamp and join one flight.
				crossForceCoalescingWindow();
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
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		// Head isolation is entirely runner-projected; only the final dirty-state
		// scenario below needs a native sibling worktree.
		mkdirSync(sibling, { recursive: true });
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
			if (commandName(file) === "gh" && args[0] === "pr" && args[1] === "list") {
				prReads += 1;
				return {
					stdout: JSON.stringify([{
						number: 101,
						url: "https://github.com/acme/private-head-isolation/pull/101",
						title: "primary result",
						state: "OPEN",
						mergeable: "MERGEABLE",
						headRefName: privatePrimaryHead,
						baseRefName: "main",
						...ownedHeadEvidence("acme", "private-head-isolation"),
					}]),
					stderr: "",
				};
			}
			if (commandName(file) === "gh" && args[0] === "api" && args.some(arg => arg.includes("/commits/"))) {
				prReads += 1;
				return {
					stdout: JSON.stringify([{
						number: 202,
						html_url: "https://github.com/acme/private-head-isolation/pull/202",
						title: "sibling result",
						state: "open",
						head: { ref: "public-sibling" },
						base: { ref: "main" },
					}]),
					stderr: "",
				};
			}
			if (commandName(file) === "gh" && args[0] === "api") {
				return { stdout: JSON.stringify({ data: { repository: { viewerPermission: "WRITE", pullRequest: { viewerCanMergeAsAdmin: false } } } }), stderr: "" };
			}
			const probe = standardSingleRepositoryProbe(file, args, primary);
			if (probe) return probe;
			return unexpectedRunnerCommand(file, args, options);
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
			const cleanup = await awaitableRm(sibling, { maxAttempts: 5, backoffMs: 50 });
			expect(cleanup.removed, `head-isolation fixture cleanup failed: ${String(cleanup.lastError ?? "unknown error")}`).toBe(true);
		}
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
