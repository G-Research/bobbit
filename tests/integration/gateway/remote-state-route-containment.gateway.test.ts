import {
	mkdtempSync,
	tmpdir,
	dirname,
	join,
	awaitableRm,
	test,
	expect,
	apiFetch,
	apiFetchAtCurrentForceEpoch,
	connectWs,
	createGoal,
	deleteGoal,
	deleteSession,
	gitCwd,
	nonGitCwd,
	registerProject,
	crossForceCoalescingWindow,
	unexpectedRunnerCommand,
	standardSingleRepositoryProbe,
	commandName,
	ownedHeadEvidence,
	createRemoteStateSession,
	installRemoteStateRouteHooks,
	handoffRemoteStateRouteRunner,
} from "../../support/harnesses/integration/remote-state-routes-fixture.js";

test.describe("remote-state coordinator routes", () => {
	installRemoteStateRouteHooks();

	test("seals the drained predecessor force epoch before installing the asserted PR runner", async ({ gateway }) => {
		const ownedCwd = gitCwd();
		const goal = await createGoal({
			title: `PR runner handoff ${Date.now()}`,
			cwd: ownedCwd,
			worktree: false,
			autoStartTeam: false,
		});
		const goalId = String(goal.id);
		if (typeof goal.projectId !== "string") throw new Error("fixture goal project unavailable");
		gateway.sessionManager.getGoalStoreForProject(goal.projectId).update(goalId, {
			cwd: ownedCwd,
			repoPath: ownedCwd,
			worktreePath: ownedCwd,
			branch: "fixture/final-binding-handoff",
			setupStatus: "ready",
		});

		const runner = (gateway.sessionManager as any).commandRunner;
		const defaultExecFile = runner.execFile;
		let predecessorActive = false;
		let predecessorReads = 0;
		let predecessorStartedResolve!: () => void;
		const predecessorStarted = new Promise<void>(resolve => { predecessorStartedResolve = resolve; });
		let releasePredecessor!: () => void;
		const predecessorGate = new Promise<void>(resolve => { releasePredecessor = resolve; });
		runner.execFile = async (file: string, args: readonly string[], options?: any) => {
			if (commandName(file) === "git" && args.join(" ") === "remote get-url origin") {
				return { stdout: "https://github.com/acme/epoch-owner.git\n", stderr: "" };
			}
			if (commandName(file) === "gh" && args[0] === "pr" && args[1] === "list") {
				predecessorReads += 1;
				predecessorActive = true;
				predecessorStartedResolve();
				await predecessorGate;
				predecessorActive = false;
				return { stdout: "[]", stderr: "" };
			}
			const probe = standardSingleRepositoryProbe(file, args, ownedCwd);
			if (probe) return probe;
			return unexpectedRunnerCommand(file, args, options);
		};

		let assertedPrReads = 0;
		const assertedExecFile = async (file: string, args: readonly string[], options?: any) => {
			if (commandName(file) === "git" && args.join(" ") === "remote get-url origin") {
				return { stdout: "https://github.com/acme/epoch-owner.git\n", stderr: "" };
			}
			if (commandName(file) === "gh" && args[0] === "pr" && args[1] === "list") {
				assertedPrReads += 1;
				return { stdout: JSON.stringify([{
					number: 71,
					url: "https://github.com/acme/epoch-owner/pull/71",
					title: "asserted runner owns first read",
					state: "OPEN",
					mergeable: "MERGEABLE",
					headRefName: "fixture/final-binding-handoff",
					baseRefName: "main",
					...ownedHeadEvidence("acme", "epoch-owner"),
				}]), stderr: "" };
			}
			const probe = standardSingleRepositoryProbe(file, args, ownedCwd);
			if (probe) return probe;
			return unexpectedRunnerCommand(file, args, options);
		};

		let restoreRunner: (() => void) | undefined;
		try {
			let handoffSettled = false;
			const handoff = handoffRemoteStateRouteRunner(
				gateway,
				[{ owner: "goals", id: goalId }],
				assertedExecFile,
			).then(restore => {
				handoffSettled = true;
				return restore;
			});
			await predecessorStarted;
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(handoffSettled, "runner handoff must drain predecessor PR work").toBe(false);
			expect(predecessorActive).toBe(true);
			expect(predecessorReads).toBe(1);
			releasePredecessor();
			restoreRunner = await handoff;
			expect(predecessorActive).toBe(false);

			// Deliberately stay in the fixture's current force epoch. The handoff—not
			// a retry, cache clear, elapsed timer, or the apiFetch burst wrapper—must
			// make this first post-drain read authoritative for the installed runner.
			const status = await apiFetchAtCurrentForceEpoch(`/api/goals/${goalId}/pr-status?intent=explicit`);
			expect(status.status).toBe(200);
			expect(await status.json()).toMatchObject({
				stale: false,
				data: { number: 71, title: "asserted runner owns first read" },
			});
			expect(predecessorReads).toBe(1);
			expect(assertedPrReads).toBe(1);
		} finally {
			releasePredecessor();
			restoreRunner?.();
			runner.execFile = defaultExecFile;
			await deleteGoal(goalId);
		}
	});

	test("rejects caller-injected and ambient repositories for numeric goal, session, and sandbox PR routes", async ({ gateway }) => {
		test.setTimeout(30_000);
		const ownedCwd = mkdtempSync(join(tmpdir(), "bobbit-numeric-pr-owner-"));
		const outsideRepo = join(dirname(ownedCwd), `outside-pr-injection-${Date.now()}`);
		const project = await registerProject({
			name: `Numeric PR containment ${Date.now()}`,
			rootPath: ownedCwd,
			components: [{ name: "owner", repo: "." }],
			seedWorkflows: false,
		});
		const goal = await createGoal({
			projectId: project.id,
			title: `PR containment goal ${Date.now()}`,
			cwd: ownedCwd,
			worktree: false,
			autoStartTeam: false,
		});
		const goalId = String(goal.id);
		const goalStore = gateway.sessionManager.getGoalStoreForProject(project.id);
		goalStore.update(goalId, {
			cwd: ownedCwd,
			repoPath: ownedCwd,
			worktreePath: join(ownedCwd, ".missing-goal-worktree"),
			branch: "17",
			setupStatus: "ready",
		});

		// repoPath is structural lifecycle metadata. A normal goal update may change
		// the display branch, but cannot manufacture a fallback repository binding.
		const poisonedPut = await apiFetch(`/api/goals/${goalId}`, {
			method: "PUT",
			body: JSON.stringify({ branch: "17", repoPath: outsideRepo }),
		});
		expect(poisonedPut.status).toBe(400);
		expect(await poisonedPut.text()).toContain("repoPath");
		const persistedGoal = await (await apiFetch(`/api/goals/${goalId}`)).json();
		expect(persistedGoal.repoPath).toBe(ownedCwd);
		expect(persistedGoal.repoPath).not.toBe(outsideRepo);

		const normalSessionId = await createRemoteStateSession(gateway, ownedCwd, project.id);
		gateway.sessionManager.updateSessionMeta(normalSessionId, {
			branch: "18",
			repoPath: outsideRepo,
			worktreePath: join(ownedCwd, ".missing-session-worktree"),
		});
		const sandboxSessionId = await createRemoteStateSession(gateway, ownedCwd, project.id);
		gateway.sessionManager.updateSessionMeta(sandboxSessionId, {
			branch: "19",
			repoPath: outsideRepo,
			worktreePath: join(ownedCwd, ".missing-sandbox-worktree"),
		});
		const sandboxSession = gateway.sessionManager.getSession(sandboxSessionId) as any;
		sandboxSession.sandboxed = true;
		sandboxSession.containerId = "fixture-numeric-pr-containment";
		sandboxSession.cwd = "/workspace/unavailable-owner";

		const sandboxProjectId = String(sandboxSession.projectId);
		const sandboxToken = gateway.sessionManager.sandboxTokenStore.register(sandboxProjectId);
		gateway.sessionManager.sandboxTokenStore.addSession(sandboxProjectId, sandboxSessionId);
		const [observerWs, sandboxWs] = await Promise.all([
			connectWs(normalSessionId),
			connectWs(sandboxSessionId, sandboxToken),
		]);
		const probedCwds: string[] = [];
		let ghCalls = 0;
		const privateSentinel = "PRIVATE OUTSIDE PR SENTINEL";

		const routeExecFile = async (file: string, args: readonly string[], options?: any) => {
			const command = commandName(file);
			const cwd = String(options?.cwd ?? "");
			if (cwd) probedCwds.push(cwd);
			if (command === "docker" && args.at(-1) === "git rev-parse --abbrev-ref HEAD") {
				return { stdout: "19\n", stderr: "" };
			}
			if (command === "git" && (args.join(" ") === "rev-parse --git-dir" || args.join(" ") === "rev-parse --show-toplevel")) {
				if (cwd === outsideRepo || cwd === process.cwd()) return { stdout: cwd, stderr: "" };
				throw new Error("owned PR repositories are unavailable");
			}
			if (command === "gh") {
				ghCalls += 1;
				return {
					stdout: JSON.stringify({
						number: 17,
						url: "https://github.com/private/outside/pull/17",
						title: privateSentinel,
						state: "OPEN",
						headRefName: "private-head",
						baseRefName: "private-base",
					}),
					stderr: "",
				};
			}
			return unexpectedRunnerCommand(file, args, options);
		};
		const restoreRunner = await handoffRemoteStateRouteRunner(gateway, [
			{ owner: "goals", id: goalId },
			{ owner: "sessions", id: normalSessionId },
			{ owner: "sessions", id: sandboxSessionId },
		], routeExecFile);

		try {
			const observerCursor = observerWs.messageCount();
			const sandboxCursor = sandboxWs.messageCount();
			const routeCases = [
				{ kind: "goal", id: goalId, branch: "17" },
				{ kind: "session", id: normalSessionId, branch: "18" },
				{ kind: "session", id: sandboxSessionId, branch: "19" },
			];
			const publicBodies: string[] = [];
			for (const routeCase of routeCases) {
				const base = `/api/${routeCase.kind === "goal" ? "goals" : "sessions"}/${routeCase.id}`;
				const status = await apiFetch(`${base}/pr-status?intent=explicit&optional=1`);
				expect(status.status, `${routeCase.kind} numeric status must fail closed`).toBe(204);
				publicBodies.push(await status.text());
				const merge = await apiFetch(`${base}/pr-merge`, {
					method: "POST",
					body: JSON.stringify({ method: "squash", branch: routeCase.branch }),
				});
				expect(merge.status, `${routeCase.kind} numeric merge must fail closed`).toBe(409);
				publicBodies.push(await merge.text());
			}

			expect(ghCalls).toBe(0);
			expect(probedCwds).not.toContain(outsideRepo);
			expect(probedCwds).not.toContain(process.cwd());
			await new Promise<void>(resolve => setImmediate(resolve));
			const publicOutput = JSON.stringify({
				publicBodies,
				observerFrames: observerWs.messages.slice(observerCursor),
				sandboxFrames: sandboxWs.messages.slice(sandboxCursor),
			});
			expect(publicOutput).not.toContain(privateSentinel);
			expect(publicOutput).not.toContain("private-head");
			expect(observerWs.messages.slice(observerCursor).filter(message => message.type === "remote_state_snapshot" && message.resource === "pr")).toHaveLength(0);
			expect(sandboxWs.messages.slice(sandboxCursor).filter(message => message.type === "remote_state_snapshot" && message.resource === "pr")).toHaveLength(0);
		} finally {
			restoreRunner();
			observerWs.close();
			sandboxWs.close();
			gateway.sessionManager.sandboxTokenStore.removeSession(sandboxProjectId, sandboxSessionId);
			await Promise.all([
				deleteSession(normalSessionId),
				deleteSession(sandboxSessionId),
				deleteGoal(goalId),
			]);
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			await awaitableRm(ownedCwd, { maxAttempts: 5, backoffMs: 50 });
		}
	});

	test("rejects selector abuse and binds numeric and slash heads to the owned repository", async ({ gateway }) => {
		test.setTimeout(30_000);
		const ownedCwd = gitCwd();
		const goal = await createGoal({
			title: `PR selector binding ${Date.now()}`,
			cwd: ownedCwd,
			worktree: false,
			autoStartTeam: false,
		});
		const goalId = String(goal.id);
		if (typeof goal.projectId !== "string") throw new Error("fixture goal project unavailable");
		const goalStore = gateway.sessionManager.getGoalStoreForProject(goal.projectId);
		const ghCalls: string[][] = [];
		const outsideSentinel = "PRIVATE REPOSITORY SENTINEL";
		const credentialSentinel = "PRIVATE-PR-CREDENTIAL";
		let returnOutsideResult = false;
		let unsafeUrl: string | undefined;

		const routeExecFile = async (file: string, args: readonly string[], options?: any) => {
			const command = commandName(file);
			if (command === "git" && args.join(" ") === "remote get-url origin") {
				return { stdout: "https://github.com/acme/owned-selector.git\n", stderr: "" };
			}
			if (command === "gh") {
				ghCalls.push([...args]);
				if (args[0] === "pr" && args[1] === "view") {
					return { stdout: JSON.stringify({ title: outsideSentinel }), stderr: "" };
				}
				if (args[0] === "pr" && args[1] === "merge") return { stdout: "merged", stderr: "" };
				if (args[0] === "api") {
					return { stdout: JSON.stringify({ data: { repository: { viewerPermission: "WRITE", pullRequest: { viewerCanMergeAsAdmin: false } } } }), stderr: "" };
				}
				const head = args[args.indexOf("--head") + 1];
				const wrongRepo = args[args.indexOf("--repo") + 1] !== "acme/owned-selector";
				const current = {
					number: head === "17" ? 117 : 118,
					url: unsafeUrl ?? `https://github.com/acme/owned-selector/pull/${head === "17" ? 117 : 118}`,
					title: `owned ${head}`,
					state: "OPEN",
					updatedAt: "2026-02-01T00:00:00.000Z",
					mergeable: "MERGEABLE",
					headRefName: head,
					baseRefName: "main",
					headRepository: { name: "owned-selector" },
					headRepositoryOwner: { login: "acme" },
					isCrossRepository: false,
				};
				const results = wrongRepo || returnOutsideResult ? [{
					number: 999,
					url: "https://github.com/private/outside/pull/999",
					title: outsideSentinel,
					headRefName: head,
				}] : head === "17" ? [{
					number: 17,
					url: "https://github.com/acme/owned-selector/pull/17",
					title: "historical owned 17",
					state: "MERGED",
					updatedAt: "2026-01-01T00:00:00.000Z",
					headRefName: head,
					headRepository: { name: "owned-selector" },
					headRepositoryOwner: { login: "acme" },
					isCrossRepository: false,
				}, current] : [current];
				return { stdout: JSON.stringify(results), stderr: "" };
			}
			const probe = standardSingleRepositoryProbe(file, args, ownedCwd);
			if (probe) return probe;
			return unexpectedRunnerCommand(file, args, options);
		};
		const restoreRunner = await handoffRemoteStateRouteRunner(
			gateway,
			[{ owner: "goals", id: goalId }],
			routeExecFile,
		);

		try {
			for (const attacker of [
				"https://github.com/private/outside/pull/123",
				"--repo=private/outside",
				"-R",
				"bad\nhead",
			]) {
				goalStore.update(goalId, { cwd: ownedCwd, repoPath: ownedCwd, worktreePath: ownedCwd, branch: attacker, setupStatus: "ready" });
				const before = ghCalls.length;
				const status = await apiFetch(`/api/goals/${goalId}/pr-status?intent=explicit&optional=1`);
				expect(status.status, attacker).toBe(204);
				const merge = await apiFetch(`/api/goals/${goalId}/pr-merge`, {
					method: "POST",
					body: JSON.stringify({ method: "squash", branch: attacker }),
				});
				expect(merge.status, attacker).toBe(409);
				expect(ghCalls).toHaveLength(before);
			}

			goalStore.update(goalId, { cwd: ownedCwd, repoPath: ownedCwd, worktreePath: ownedCwd, branch: "17", setupStatus: "ready" });
			const numericStatus = await apiFetch(`/api/goals/${goalId}/pr-status?intent=explicit`);
			expect(numericStatus.status).toBe(200);
			expect(await numericStatus.json()).toMatchObject({ data: { number: 117, title: "owned 17" } });
			const numericLookup = ghCalls.find(args => args[0] === "pr" && args[1] === "list");
			expect(numericLookup?.slice(0, 6)).toEqual(["pr", "list", "--repo", "acme/owned-selector", "--head", "17"]);
			expect(ghCalls.some(args => args[0] === "pr" && args[1] === "view")).toBe(false);

			returnOutsideResult = true;
			crossForceCoalescingWindow();
			const escaped = await apiFetch(`/api/goals/${goalId}/pr-status?intent=explicit`);
			expect(escaped.status).toBe(200);
			const escapedBody = await escaped.json();
			expect(escapedBody).toMatchObject({ stale: true, lastError: "unavailable", data: { number: 117, title: "owned 17" } });
			expect(JSON.stringify(escapedBody)).not.toContain(outsideSentinel);
			returnOutsideResult = false;
			crossForceCoalescingWindow();
			const recovered = await apiFetch(`/api/goals/${goalId}/pr-status?intent=explicit`);
			expect(recovered.status).toBe(200);
			expect(await recovered.json()).toMatchObject({ stale: false, data: { number: 117 } });

			unsafeUrl = `https://${credentialSentinel}:secret@github.com/acme/owned-selector/pull/117`;
			crossForceCoalescingWindow();
			const rejectedCredentialUrl = await apiFetch(`/api/goals/${goalId}/pr-status?intent=explicit`);
			const rejectedCredentialBody = await rejectedCredentialUrl.json();
			expect(rejectedCredentialBody).toMatchObject({ stale: true, lastError: "unavailable", data: { number: 117 } });
			expect(JSON.stringify(rejectedCredentialBody)).not.toContain(credentialSentinel);
			unsafeUrl = undefined;
			crossForceCoalescingWindow();
			expect(await (await apiFetch(`/api/goals/${goalId}/pr-status?intent=explicit`)).json()).toMatchObject({ stale: false, data: { number: 117 } });

			const callsBeforeInjectedMerge = ghCalls.length;
			const injectedMerge = await apiFetch(`/api/goals/${goalId}/pr-merge`, {
				method: "POST",
				body: JSON.stringify({ method: "squash", branch: "https://github.com/private/outside/pull/123" }),
			});
			expect(injectedMerge.status).toBe(409);
			expect(ghCalls.slice(callsBeforeInjectedMerge).some(args => args[0] === "pr" && args[1] === "merge")).toBe(false);

			const merge = await apiFetch(`/api/goals/${goalId}/pr-merge`, {
				method: "POST",
				body: JSON.stringify({ method: "rebase", branch: "17" }),
			});
			expect(merge.status).toBe(200);
			expect([...ghCalls].reverse().find(args => args[0] === "pr" && args[1] === "merge")?.slice(0, 5)).toEqual([
				"pr", "merge", "117", "--repo", "acme/owned-selector",
			]);

			goalStore.update(goalId, { branch: "feature/slash.ok" });
			const slash = await apiFetch(`/api/goals/${goalId}/pr-status?intent=explicit`);
			expect(slash.status).toBe(200);
			expect(await slash.json()).toMatchObject({ data: { number: 118, title: "owned feature/slash.ok" } });
			const publicOutput = JSON.stringify({ numericLookup, ghCalls });
			expect(publicOutput).not.toContain(outsideSentinel);
		} finally {
			restoreRunner();
			await deleteGoal(goalId);
		}
	});

	test("uses the owned project repository for broken sandbox status and merge", async ({ gateway }) => {
		test.setTimeout(30_000);
		const sessionId = await createRemoteStateSession(gateway, gitCwd());
		const branch = "23";
		const ownedRepo = join(gitCwd(), `.owned-project-repo-${Date.now()}`);
		const missingWorktree = join(nonGitCwd(), `missing-sandbox-worktree-${Date.now()}`);
		gateway.sessionManager.updateSessionMeta(sessionId, { branch, worktreePath: missingWorktree, repoPath: ownedRepo });
		const session = gateway.sessionManager.getSession(sessionId) as any;
		session.sandboxed = true;
		session.containerId = "fixture-owned-pr-fallback";
		session.cwd = "/workspace/broken-worktree";

		const projectId = String(session.projectId);
		const sandboxToken = gateway.sessionManager.sandboxTokenStore.register(projectId);
		gateway.sessionManager.sandboxTokenStore.addSession(projectId, sessionId);
		const sandboxWs = await connectWs(sessionId, sandboxToken);
		const ambientCwd = process.cwd();
		const ghCwds: string[] = [];
		let prReads = 0;
		let prMerges = 0;

		const routeExecFile = async (file: string, args: readonly string[], options?: any) => {
			const cwd = String(options?.cwd ?? "");
			if (commandName(file) === "docker" && args.at(-1) === "git rev-parse --abbrev-ref HEAD") {
				return { stdout: `${branch}\n`, stderr: "" };
			}
			if (commandName(file) === "git" && args.join(" ") === "rev-parse --git-dir") {
				if (cwd === ownedRepo || cwd === ambientCwd) return { stdout: ".git\n", stderr: "" };
				throw new Error("broken host worktree");
			}
			if (commandName(file) === "docker" && args.includes("check-ref-format")) {
				return { stdout: `${branch}\n`, stderr: "" };
			}
			if (commandName(file) === "git" && args.join(" ") === "remote get-url origin") {
				return { stdout: cwd === ownedRepo
					? "https://github.com/acme/owned.git\n"
					: "https://github.com/private/ambient.git\n", stderr: "" };
			}
			if (commandName(file) === "gh") {
				ghCwds.push(cwd);
				if (args[0] === "pr" && args[1] === "merge") {
					prMerges += 1;
					return { stdout: "merged", stderr: "" };
				}
				if (args[0] === "api") {
					return { stdout: JSON.stringify({ data: { repository: { viewerPermission: "WRITE", pullRequest: { viewerCanMergeAsAdmin: false } } } }), stderr: "" };
				}
				prReads += 1;
				return {
					stdout: JSON.stringify([{
						number: 23,
						url: "https://github.com/acme/owned/pull/23",
						title: "owned fallback",
						state: "OPEN",
						mergeable: "MERGEABLE",
						headRefName: branch,
						baseRefName: "main",
						...ownedHeadEvidence("acme", "owned"),
					}]),
					stderr: "",
				};
			}
			return unexpectedRunnerCommand(file, args, options);
		};
		const restoreRunner = await handoffRemoteStateRouteRunner(
			gateway,
			[{ owner: "sessions", id: sessionId }],
			routeExecFile,
		);

		try {
			const cursor = sandboxWs.messageCount();
			const status = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`);
			expect(status.status).toBe(200);
			expect(await status.json()).toMatchObject({ data: { number: 23, title: "owned fallback" } });
			const frame = await sandboxWs.waitForFrom(
				cursor,
				message => message.type === "remote_state_snapshot" && message.sessionId === sessionId && message.resource === "pr",
			);
			expect(frame.snapshot).toMatchObject({ data: { number: 23, title: "owned fallback" } });

			const merge = await apiFetch(`/api/sessions/${sessionId}/pr-merge`, {
				method: "POST",
				body: JSON.stringify({ method: "rebase", branch }),
			});
			expect(merge.status).toBe(200);
			expect(prReads).toBe(1);
			expect(prMerges).toBe(1);
			expect(ghCwds.every(cwd => cwd === ownedRepo)).toBe(true);
			expect(ghCwds).not.toContain(ambientCwd);
		} finally {
			restoreRunner();
			sandboxWs.close();
			await deleteSession(sessionId);
		}
	});
});
