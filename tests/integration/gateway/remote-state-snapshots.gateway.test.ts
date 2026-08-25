import {
	join,
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
	installRemoteStateRouteHooks,
} from "../../support/harnesses/integration/remote-state-routes-fixture.js";

test.describe("remote-state coordinator routes", () => {
	installRemoteStateRouteHooks();

	test("coalesces session Git and PR reads and only broadcasts redacted snapshot envelopes", async ({ gateway }) => {
		test.setTimeout(30_000);
		const sessionId = await createRemoteStateSession(gateway, gitCwd());
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		let gitFetches = 0;
		let prReads = 0;
		const permissionApiCalls: string[][] = [];
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
			if (commandName(file) === "gh" && args[0] === "pr" && args[1] === "list") {
				prReads += 1;
				const customApiPort = Number(remoteOrigin?.match(/^https:\/\/[^/]+:(8443)\//)?.[1]);
				const number = customApiPort || 42;
				const responseHost = customApiPort ? `example.github.test:${customApiPort}` : "example.github.test";
				return {
					stdout: JSON.stringify([{
						number,
						url: `https://${responseHost}/acme/widget/pull/${number}`,
						title: `safe title ${number}`,
						state: "OPEN",
						mergeable: "MERGEABLE",
						headRefName: args[args.indexOf("--head") + 1],
						baseRefName: customApiPort ? "private/base" : "master",
						...ownedHeadEvidence("acme", "widget"),
					}]),
					stderr: "",
				};
			}
			if (commandName(file) === "gh" && args[0] === "api") {
				permissionApiCalls.push([...args]);
				if (args.includes("graphql")) {
					// A missing GraphQL repository still takes the best-effort branch-rules
					// path, and every API call must stay on the exact trusted GHE authority.
					return { stdout: JSON.stringify({ data: { repository: null } }), stderr: "" };
				}
				const endpoint = String(args.at(-1));
				if (endpoint.includes("/rules/branches/")) return { stdout: JSON.stringify([{ ruleset_id: 73 }]), stderr: "" };
				if (endpoint.endsWith("/rulesets/73")) return { stdout: JSON.stringify({ current_user_can_bypass: "pull_requests_only" }), stderr: "" };
				throw new Error(`unexpected permission API args: ${args.join(" ")}`);
			}
			const probe = standardSingleRepositoryProbe(file, args, gitCwd());
			if (probe) return probe;
			return unexpectedRunnerCommand(file, args, options);
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
			expect(gitTelemetry, "successful repository lifecycle events must stay out of the normal server log").toHaveLength(0);
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
			expect(prTelemetry, "successful PR lifecycle events must stay out of the normal server log").toHaveLength(0);
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
			crossForceCoalescingWindow();
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

			// SSH transport ports do not become GitHub API authorities. Equivalent
			// SSH forms share one PR record, while a real HTTPS API port stays distinct.
			const beforeCustomPorts = prReads;
			remoteOrigin = "ssh://git@example.github.test:2222/acme/widget.git";
			// This SSH remote intentionally aliases the earlier HTTPS PR identity.
			// Cross the explicit-refresh coalescing window deterministically so this
			// observes a new authority-pinned permission cycle on every runner speed.
			crossForceCoalescingWindow();
			const sshPermissionStart = permissionApiCalls.length;
			const sshResponse = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`);
			expect(sshResponse.status).toBe(200);
			const sshBody = await sshResponse.json();
			expect(sshBody).toMatchObject({ data: { number: 42, url: "https://example.github.test/acme/widget/pull/42" } });
			const sshPermissionCalls = permissionApiCalls.slice(sshPermissionStart);
			expect(sshPermissionCalls).toHaveLength(3);
			expect(sshPermissionCalls.every(args => (
				args[0] === "api" && args[1] === "--hostname" && args[2] === "example.github.test"
			))).toBe(true);

			remoteOrigin = "ssh://git@example.github.test:2223/acme/widget.git";
			const equivalentSsh = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=automatic`);
			expect(equivalentSsh.status).toBe(200);
			expect(await equivalentSsh.json()).toMatchObject({ data: { number: 42 } });
			expect(prReads).toBe(beforeCustomPorts + 1);

			remoteOrigin = "https://example.github.test:8443/acme/widget.git";
			const apiPortPermissionStart = permissionApiCalls.length;
			const apiPortResponse = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`);
			expect(apiPortResponse.status).toBe(200);
			const apiPortBody = await apiPortResponse.json();
			expect(apiPortBody).toMatchObject({ data: { number: 8443, url: "https://example.github.test:8443/acme/widget/pull/8443" } });
			const apiPortPermissionCalls = permissionApiCalls.slice(apiPortPermissionStart);
			expect(apiPortPermissionCalls).toHaveLength(3);
			expect(apiPortPermissionCalls.every(args => (
				args[0] === "api" && args[1] === "--hostname" && args[2] === "example.github.test:8443"
			))).toBe(true);
			expect(apiPortPermissionCalls.some(args => String(args.at(-1)).includes("private%2Fbase"))).toBe(true);
			expect(prReads).toBe(beforeCustomPorts + 2);
			for (const body of [sshBody, apiPortBody]) {
				expect(JSON.stringify(body)).not.toContain("ssh://");
				expect(JSON.stringify(body)).not.toContain("token:secret");
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
			if (commandName(file) === "gh" && args[0] === "pr" && args[1] === "list") {
				prReads += 1;
				if (mode === "no-pr") {
					markNoPrStarted();
					await noPrGate;
					return { stdout: "[]", stderr: "" };
				}
				const error = new Error("network timeout while reading fixture PR state");
				(error as any).stderr = "fixture transport unavailable";
				throw error;
			}
			const probe = standardSingleRepositoryProbe(file, args, gitCwd());
			if (probe) return probe;
			return unexpectedRunnerCommand(file, args, options);
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
			crossForceCoalescingWindow();
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
		const fallbackCwd = join(primaryCwd, `.owned-pr-fallback-${Date.now()}`);
		const sessionId = await createRemoteStateSession(gateway, primaryCwd);
		const branch = `fixture/broken-worktree-${Date.now()}`;
		gateway.sessionManager.updateSessionMeta(sessionId, { branch, repoPath: fallbackCwd });
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		let prReads = 0;
		let prReadCwd: string | undefined;

		runner.execFile = async (file: string, args: readonly string[], options?: any) => {
			if (commandName(file) === "git" && args.join(" ") === "rev-parse --git-dir") {
				if (String(options?.cwd) === primaryCwd) throw new Error("broken worktree git link");
				if (String(options?.cwd) === fallbackCwd) return { stdout: ".git\n", stderr: "" };
			}
			if (commandName(file) === "git" && args.join(" ") === "remote get-url origin") {
				return { stdout: "https://github.com/acme/local-preflight-fallback.git\n", stderr: "" };
			}
			if (commandName(file) === "gh" && args[0] === "pr" && args[1] === "list") {
				prReads += 1;
				prReadCwd = String(options?.cwd);
				return {
					stdout: JSON.stringify([{
						number: 88,
						url: "https://github.com/acme/local-preflight-fallback/pull/88",
						title: "fallback result",
						state: "OPEN",
						mergeable: "MERGEABLE",
						headRefName: branch,
						baseRefName: "main",
						...ownedHeadEvidence("acme", "local-preflight-fallback"),
					}]),
					stderr: "",
				};
			}
			if (commandName(file) === "gh" && args[0] === "api") {
				return { stdout: JSON.stringify({ data: { repository: { viewerPermission: "WRITE", pullRequest: { viewerCanMergeAsAdmin: false } } } }), stderr: "" };
			}
			if (commandName(file) === "git" && args[0] === "check-ref-format" && args[1] === "--branch") {
				return { stdout: `${String(args[2])}\n`, stderr: "" };
			}
			return unexpectedRunnerCommand(file, args, options);
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
});
