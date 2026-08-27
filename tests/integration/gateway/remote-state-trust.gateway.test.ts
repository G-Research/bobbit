import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	writeFileSync,
	EventEmitter,
	tmpdir,
	PassThrough,
	join,
	awaitableRm,
	test,
	expect,
	apiFetch,
	createGoal,
	deleteGoal,
	deleteSession,
	gitCwd,
	nonGitCwd,
	registerProject,
	createCommandSpawnAdapter,
	crossForceCoalescingWindow,
	unexpectedRunnerCommand,
	standardSingleRepositoryProbe,
	commandName,
	credentialHelperResult,
	ownedHeadEvidence,
	createRemoteStateSession,
	installRemoteStateRouteHooks,
} from "../../support/harnesses/integration/remote-state-routes-fixture.js";

test.describe("remote-state coordinator routes", () => {
	installRemoteStateRouteHooks();

	test("trusts a gh-config-only enterprise host for status, permissions, merge, and trust checks", async ({ gateway }) => {
		test.setTimeout(30_000);
		const host = "ghe.config-only.test";
		const unknownHost = "unknown.config-only.test";
		const ghConfigDir = realpathSync(mkdtempSync(join(nonGitCwd(), "gh-config-")));
		writeFileSync(join(ghConfigDir, "hosts.yml"), `${host}:\n    user: route-fixture\n`, "utf8");
		const previousGhConfigDir = process.env.GH_CONFIG_DIR;
		process.env.GH_CONFIG_DIR = ghConfigDir;
		const branch = `fixture/gh-config-host-${Date.now()}`;
		let sessionId: string | undefined;
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		let remoteHost = host;
		let discoveryCalls = 0;
		const remoteGhCalls: string[][] = [];
		let originalTrustedHosts: unknown = [];

		try {
			sessionId = await createRemoteStateSession(gateway, gitCwd());
			gateway.sessionManager.updateSessionMeta(sessionId, { branch });
			runner.execFile = async (file: string, args: readonly string[], options?: any) => {
				const command = commandName(file);
				if (command === "git" && args.join(" ") === "remote get-url origin") {
					return { stdout: `https://${remoteHost}/acme/widget.git\n`, stderr: "" };
				}
				if (command === "gh" && args[0] === "auth" && args[1] === "status") {
					discoveryCalls += 1;
					return unexpectedRunnerCommand(file, args, options);
				}
				if (command === "gh") {
					remoteGhCalls.push([...args]);
					if (args[0] === "pr" && args[1] === "list") {
						return {
							stdout: JSON.stringify([{
								number: 74,
								url: `https://${host}/acme/widget/pull/74`,
								title: "Configured enterprise host",
								state: "OPEN",
								mergeable: "MERGEABLE",
								headRefName: branch,
								baseRefName: "main",
								...ownedHeadEvidence("acme", "widget"),
							}]),
							stderr: "",
						};
					}
					if (args[0] === "api") {
						return {
							stdout: JSON.stringify({ data: { repository: { viewerPermission: "ADMIN", pullRequest: { viewerCanMergeAsAdmin: true } } } }),
							stderr: "",
						};
					}
					if (args[0] === "pr" && args[1] === "merge") return { stdout: "merged", stderr: "" };
				}
				const probe = standardSingleRepositoryProbe(file, args, gitCwd());
				if (probe) return probe;
				return unexpectedRunnerCommand(file, args, options);
			};

			const originalPreferences = await apiFetch("/api/preferences");
			if (originalPreferences.ok) originalTrustedHosts = (await originalPreferences.json()).githubTrustedHosts ?? [];
			expect((await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ githubTrustedHosts: [] }),
			})).status).toBe(200);
			// The fork-scoped gateway may have cached discovery from an earlier
			// integration file. Cross the short resolver TTL deterministically.
			gateway.clock.advance(60_000);

			const trustedCheck = await apiFetch(`/api/github/trusted-hosts/check?host=${host.toUpperCase()}.`);
			expect(trustedCheck.status).toBe(200);
			expect(await trustedCheck.json()).toEqual({ host, trusted: true });
			const unknownCheck = await apiFetch(`/api/github/trusted-hosts/check?host=${unknownHost}`);
			expect(await unknownCheck.json()).toEqual({ host: unknownHost, trusted: false });
			expect((await apiFetch("/api/github/trusted-hosts/check?host=https%3A%2F%2Fevil.test%2Fpath")).status).toBe(400);

			const status = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`);
			expect(status.status).toBe(200);
			expect(await status.json()).toMatchObject({ data: { number: 74, title: "Configured enterprise host", viewerIsAdmin: true, viewerCanMergeAsAdmin: true } });

			const merge = await apiFetch(`/api/sessions/${sessionId}/pr-merge`, {
				method: "POST",
				body: JSON.stringify({ method: "squash", branch }),
			});
			expect(merge.status).toBe(200);
			expect(discoveryCalls).toBe(0);
			expect(remoteGhCalls.find(args => args[0] === "pr" && args[1] === "list")?.slice(0, 4)).toEqual([
				"pr", "list", "--repo", `${host}/acme/widget`,
			]);
			const permissionCalls = remoteGhCalls.filter(args => args[0] === "api");
			expect(permissionCalls.length).toBeGreaterThan(0);
			expect(permissionCalls.every(args => args[1] === "--hostname" && args[2] === host)).toBe(true);
			expect(remoteGhCalls.find(args => args[0] === "pr" && args[1] === "merge")?.slice(0, 5)).toEqual([
				"pr", "merge", "74", "--repo", `${host}/acme/widget`,
			]);

			remoteHost = unknownHost;
			const callsBeforeUnknown = remoteGhCalls.length;
			expect((await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit&optional=1`)).status).toBe(204);
			expect((await apiFetch(`/api/sessions/${sessionId}/pr-merge`, {
				method: "POST",
				body: JSON.stringify({ method: "squash", branch }),
			})).status).toBe(409);
			expect(remoteGhCalls).toHaveLength(callsBeforeUnknown);
		} finally {
			runner.execFile = originalExecFile;
			if (previousGhConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
			else process.env.GH_CONFIG_DIR = previousGhConfigDir;
			// Expire the fixture discovery so its host cannot bleed into the next test.
			gateway.clock.advance(60_000);
			try {
				if (sessionId) await deleteSession(sessionId);
			} finally {
				await apiFetch("/api/preferences", {
					method: "PUT",
					body: JSON.stringify({ githubTrustedHosts: originalTrustedHosts }),
				}).catch(() => {});
				const cleanup = await awaitableRm(ghConfigDir, { maxAttempts: 5, backoffMs: 50 });
				expect(cleanup.removed, `GH_CONFIG_DIR fixture cleanup failed: ${String(cleanup.lastError ?? "unknown error")}`).toBe(true);
			}
		}
	});

	test("admits only credential-vouched unlisted enterprise hosts to exact-bound PR lookup", async ({ gateway }) => {
		test.setTimeout(30_000);
		const vouchedHost = `credential-vouched-${Date.now()}.invalid`;
		const unvouchedHost = `credential-unvouched-${Date.now()}.invalid`;
		const branch = `fixture/credential-vouched-${Date.now()}`;
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		const originalSpawn = runner.spawn;
		const originalOwnedTreeCapability = runner.supportsOwnedTreeSpawn;
		const previousEnterpriseTokens = new Map<string, string | undefined>(
			["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].map(name => [name, process.env[name]] as const),
		);
		let remoteHost = vouchedHost;
		let sessionId: string | undefined;
		let goalId: string | undefined;
		let originalTrustedHosts: unknown = [];
		const ghCalls: string[][] = [];
		const probes: Array<{ file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; request: string }> = [];

		try {
			// The production trust object reads the environment at admission time. Clear
			// host-class ambient tokens for this fixture only, then restore them exactly.
			delete process.env.GH_ENTERPRISE_TOKEN;
			delete process.env.GITHUB_ENTERPRISE_TOKEN;
			sessionId = await createRemoteStateSession(gateway, gitCwd());
			gateway.sessionManager.updateSessionMeta(sessionId, { branch });
			const goal = await createGoal({
				title: `credential trust merge boundary ${Date.now()}`,
				cwd: gitCwd(),
				worktree: false,
				autoStartTeam: false,
			});
			goalId = String(goal.id);
			if (typeof goal.projectId !== "string") throw new Error("fixture goal project unavailable");
			gateway.sessionManager.getGoalStoreForProject(goal.projectId).update(goalId, {
				cwd: gitCwd(),
				repoPath: gitCwd(),
				worktreePath: gitCwd(),
				branch,
				setupStatus: "ready",
			});

			runner.spawn = createCommandSpawnAdapter(
				() => { throw new Error("credential fixture received an ordinary spawn"); },
				((file: string, args: readonly string[], options?: any) => {
					const tracked = credentialHelperResult(remoteHost === vouchedHost
						? `protocol=https\nhost=${vouchedHost}\nusername=route-fixture\npassword=fixture-secret\n`
						: `protocol=https\nhost=${unvouchedHost}\nusername=route-fixture\n`);
					const probe = {
						file: commandName(file),
						args: [...args],
						cwd: String(options?.cwd ?? ""),
						env: options?.env ?? {},
						request: "",
					};
					probes.push(probe);
					tracked.child.stdin.on("data", (chunk: Buffer) => { probe.request += chunk.toString("utf8"); });
					return tracked;
				}) as any,
			);
			runner.supportsOwnedTreeSpawn = true;
			runner.execFile = async (file: string, args: readonly string[], options?: any) => {
				const command = commandName(file);
				if (command === "git" && args.join(" ") === "remote get-url origin") {
					return { stdout: `https://${remoteHost}/acme/widget.git\n`, stderr: "" };
				}
				if (command === "gh") {
					ghCalls.push([...args]);
					if (args[0] === "pr" && args[1] === "list") {
						return {
							stdout: JSON.stringify([{
								number: 91,
								url: `https://${vouchedHost}/acme/widget/pull/91`,
								title: "Credential-vouched enterprise host",
								state: "OPEN",
								mergeable: "MERGEABLE",
								headRefName: branch,
								baseRefName: "main",
								...ownedHeadEvidence("acme", "widget"),
							}]),
							stderr: "",
						};
					}
					if (args[0] === "api") throw new Error("fixture GraphQL unavailable");
					if (args[0] === "repo" && args[1] === "view") {
						return { stdout: JSON.stringify({ viewerPermission: "ADMIN" }), stderr: "" };
					}
				}
				const standard = standardSingleRepositoryProbe(file, args, gitCwd());
				if (standard) return standard;
				return unexpectedRunnerCommand(file, args, options);
			};

			const originalPreferences = await apiFetch("/api/preferences");
			if (originalPreferences.ok) originalTrustedHosts = (await originalPreferences.json()).githubTrustedHosts ?? [];
			expect((await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ githubTrustedHosts: [] }),
			})).status).toBe(200);
			gateway.clock.advance(60_000);
			expect(await (await apiFetch(`/api/github/trusted-hosts/check?host=${vouchedHost}`)).json())
				.toEqual({ host: vouchedHost, trusted: false });

			const vouched = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`);
			expect(vouched.status).toBe(200);
			expect(await vouched.json()).toMatchObject({
				source: "pr",
				stale: false,
				data: { number: 91, viewerIsAdmin: true },
			});
			expect(ghCalls.find(args => args[0] === "pr" && args[1] === "list")?.slice(0, 6)).toEqual([
				"pr", "list", "--repo", `${vouchedHost}/acme/widget`, "--head", branch,
			]);
			expect(ghCalls.filter(args => args[0] === "api").every(args => (
				args[1] === "--hostname" && args[2] === vouchedHost
			))).toBe(true);
			expect(ghCalls.find(args => args[0] === "repo" && args[1] === "view")).toEqual([
				"repo", "view", "--repo", `${vouchedHost}/acme/widget`, "--json", "viewerPermission",
			]);
			expect(probes).toHaveLength(1);
			expect(probes[0]).toMatchObject({
				file: "git",
				args: ["credential", "fill"],
				request: `url=https://${vouchedHost}\n\n`,
			});
			expect(probes[0].cwd).not.toBe(gitCwd());
			expect(probes[0].cwd.startsWith(tmpdir())).toBe(true);
			expect(probes[0].env.GIT_TERMINAL_PROMPT).toBe("0");
			expect(probes[0].env.GCM_INTERACTIVE).toBe("never");

			crossForceCoalescingWindow();
			expect((await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`)).status).toBe(200);
			expect(probes).toHaveLength(1);

			// Credential-derived trust is status-only. Both destructive routes must use
			// listed-host admission and fail before another probe or any gh operation.
			const probesBeforeMerge = probes.length;
			const ghCallsBeforeMerge = ghCalls.length;
			for (const mergeUrl of [
				`/api/sessions/${sessionId}/pr-merge`,
				`/api/goals/${goalId}/pr-merge`,
			]) {
				const merge = await apiFetch(mergeUrl, {
					method: "POST",
					body: JSON.stringify({ method: "squash", branch }),
				});
				expect(merge.status, mergeUrl).toBe(409);
				expect(await merge.json()).toEqual({ error: "PR repository unavailable" });
			}
			expect(probes).toHaveLength(probesBeforeMerge);
			expect(ghCalls).toHaveLength(ghCallsBeforeMerge);

			remoteHost = unvouchedHost;
			const ghCallsBeforeUnvouched = ghCalls.length;
			const unavailable = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit&optional=1`);
			expect(unavailable.status).toBe(204);
			expect(probes).toHaveLength(2);
			expect(probes[1].request).toBe(`url=https://${unvouchedHost}\n\n`);
			expect(ghCalls).toHaveLength(ghCallsBeforeUnvouched);
		} finally {
			runner.execFile = originalExecFile;
			runner.spawn = originalSpawn;
			if (originalOwnedTreeCapability === undefined) delete runner.supportsOwnedTreeSpawn;
			else runner.supportsOwnedTreeSpawn = originalOwnedTreeCapability;
			for (const [name, value] of previousEnterpriseTokens) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			gateway.clock.advance(60_000);
			try {
				await Promise.all([
					sessionId ? deleteSession(sessionId) : Promise.resolve(),
					goalId ? deleteGoal(goalId) : Promise.resolve(),
				]);
			} finally {
				await apiFetch("/api/preferences", {
					method: "PUT",
					body: JSON.stringify({ githubTrustedHosts: originalTrustedHosts }),
				}).catch(() => {});
			}
		}
	});

	test("serializes staggered explicit credential refreshes before exact-bound PR lookup", async ({ gateway }) => {
		test.setTimeout(30_000);
		const host = `credential-serialized-${Date.now()}.invalid`;
		const branch = `fixture/credential-serialized-${Date.now()}`;
		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		const originalSpawn = runner.spawn;
		const originalOwnedTreeCapability = runner.supportsOwnedTreeSpawn;
		const previousEnterpriseTokens = new Map<string, string | undefined>(
			["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].map(name => [name, process.env[name]] as const),
		);
		let sessionId: string | undefined;
		let originalTrustedHosts: unknown = [];
		let activeTrees = 0;
		let maxActiveTrees = 0;
		let remoteReads = 0;
		const ghCalls: string[][] = [];
		const probes: Array<{
			request: string;
			complete: (trusted: boolean) => void;
		}> = [];
		const routeRequests: Array<Promise<Response>> = [];
		const waitForCount = async (read: () => number, expected: number) => {
			// Count event-loop time, not turns: under a loaded full lane, 100 empty
			// setImmediate turns can finish before the route's filesystem work does.
			const deadline = Date.now() + 5_000;
			while (read() < expected && Date.now() < deadline) {
				await new Promise<void>(resolve => setTimeout(resolve, 1));
			}
			expect(read()).toBe(expected);
		};

		try {
			delete process.env.GH_ENTERPRISE_TOKEN;
			delete process.env.GITHUB_ENTERPRISE_TOKEN;
			sessionId = await createRemoteStateSession(gateway, gitCwd());
			gateway.sessionManager.updateSessionMeta(sessionId, { branch });

			runner.spawn = createCommandSpawnAdapter(
				() => { throw new Error("credential serialization fixture received an ordinary spawn"); },
				((_file: string, _args: readonly string[]) => {
					const child: any = new EventEmitter();
					child.stdout = new PassThrough();
					child.stdin = new PassThrough();
					child.kill = () => { throw new Error("credential serialization fixture must use owned-tree control"); };
					activeTrees++;
					maxActiveTrees = Math.max(maxActiveTrees, activeTrees);
					let reaped = false;
					let completed = false;
					const probe = {
						request: "",
						complete: (trusted: boolean) => {
							if (completed) return;
							completed = true;
							child.stdout.end(trusted
								? `protocol=https\nhost=${host}\nusername=route-fixture\npassword=fixture-secret\n`
								: `protocol=https\nhost=${host}\nusername=route-fixture\n`);
							child.emit("close", 0, null);
						},
					};
					child.stdin.on("data", (chunk: Buffer) => { probe.request += chunk.toString("utf8"); });
					probes.push(probe);
					return {
						child,
						ownershipReady: Promise.resolve(),
						killTree: () => {},
						waitForTreeExit: async () => {
							if (!reaped) { reaped = true; activeTrees--; }
							return true;
						},
						killed: () => false,
						timedOut: () => false,
					};
				}) as any,
			);
			runner.supportsOwnedTreeSpawn = true;
			runner.execFile = async (file: string, args: readonly string[], options?: any) => {
				const command = commandName(file);
				if (command === "git" && args.join(" ") === "remote get-url origin") {
					remoteReads++;
					return { stdout: `https://${host}/acme/widget.git\n`, stderr: "" };
				}
				if (command === "gh") {
					ghCalls.push([...args]);
					if (args[0] === "pr" && args[1] === "list") {
						return {
							stdout: JSON.stringify([{
								number: 93,
								url: `https://${host}/acme/widget/pull/93`,
								title: "Serialized credential refresh",
								state: "OPEN",
								mergeable: "MERGEABLE",
								headRefName: branch,
								baseRefName: "main",
								...ownedHeadEvidence("acme", "widget"),
							}]),
							stderr: "",
						};
					}
					if (args[0] === "api") throw new Error("fixture GraphQL unavailable");
					if (args[0] === "repo" && args[1] === "view") {
						return { stdout: JSON.stringify({ viewerPermission: "ADMIN" }), stderr: "" };
					}
				}
				const standard = standardSingleRepositoryProbe(file, args, gitCwd());
				if (standard) return standard;
				return unexpectedRunnerCommand(file, args, options);
			};

			const originalPreferences = await apiFetch("/api/preferences");
			if (originalPreferences.ok) originalTrustedHosts = (await originalPreferences.json()).githubTrustedHosts ?? [];
			expect((await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ githubTrustedHosts: [] }),
			})).status).toBe(200);
			gateway.clock.advance(60_000);

			routeRequests.push(apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit&optional=1`));
			await waitForCount(() => probes.length, 1);
			expect(activeTrees).toBe(1);

			// Each request advances the refresh generation after the prior helper tree
			// has started. They must update one queued successor, not spawn siblings.
			routeRequests.push(apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit&optional=1`));
			await waitForCount(() => remoteReads, 2);
			routeRequests.push(apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit&optional=1`));
			await waitForCount(() => remoteReads, 3);
			expect(probes).toHaveLength(1);
			expect(activeTrees).toBe(1);
			expect(ghCalls).toHaveLength(0);

			probes[0].complete(true);
			await waitForCount(() => probes.length, 2);
			expect(probes[1].request).toBe(`url=https://${host}\n\n`);
			expect(activeTrees).toBe(1);
			expect(maxActiveTrees).toBe(1);
			expect(ghCalls).toHaveLength(0);

			probes[1].complete(true);
			const responses = await Promise.all(routeRequests);
			// Each route keeps its own refresh-generation view even though G1 and G2
			// share one successor internally. Only the latest caller may authorize.
			expect(responses.map(response => response.status)).toEqual([204, 204, 200]);
			expect(activeTrees).toBe(0);
			expect(maxActiveTrees).toBe(1);
			expect(probes).toHaveLength(2);
			const prLookups = ghCalls.filter(args => args[0] === "pr" && args[1] === "list");
			expect(prLookups).toHaveLength(1);
			expect(prLookups[0].slice(0, 6)).toEqual([
				"pr", "list", "--repo", `${host}/acme/widget`, "--head", branch,
			]);
			expect(ghCalls.filter(args => args[0] === "api").every(args => (
				args[1] === "--hostname" && args[2] === host
			))).toBe(true);
			expect(ghCalls.find(args => args[0] === "repo" && args[1] === "view")).toEqual([
				"repo", "view", "--repo", `${host}/acme/widget`, "--json", "viewerPermission",
			]);
		} finally {
			// Restore shared runner state before any cleanup await. A stale helper may
			// schedule a serialized successor in a microtask; that successor must use
			// the normal fenced runner rather than leaking this fixture into later tests.
			runner.execFile = originalExecFile;
			runner.spawn = originalSpawn;
			if (originalOwnedTreeCapability === undefined) delete runner.supportsOwnedTreeSpawn;
			else runner.supportsOwnedTreeSpawn = originalOwnedTreeCapability;
			for (const [name, value] of previousEnterpriseTokens) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			// Keep releasing fixture-owned helper trees until every route settles. A
			// failed precondition can occur before the first tree is created, so a fixed
			// number of drain turns could leave a late request pending.
			let routesSettled = false;
			const settlingRoutes = Promise.allSettled(routeRequests).then(() => { routesSettled = true; });
			while (!routesSettled) {
				for (const probe of probes) probe.complete(false);
				await new Promise<void>(resolve => setTimeout(resolve, 1));
			}
			await settlingRoutes;
			gateway.clock.advance(60_000);
			try {
				if (sessionId) await deleteSession(sessionId);
			} finally {
				await apiFetch("/api/preferences", {
					method: "PUT",
					body: JSON.stringify({ githubTrustedHosts: originalTrustedHosts }),
				}).catch(() => {});
			}
		}
	});

	test("credential-vouches only the selected repository in a multi-repository PR status lookup", async ({ gateway }) => {
		test.setTimeout(30_000);
		const projectRoot = mkdtempSync(join(tmpdir(), "bobbit-pr-credential-selected-"));
		const selectedSource = join(projectRoot, "selected");
		const siblingSource = join(projectRoot, "sibling");
		mkdirSync(selectedSource, { recursive: true });
		mkdirSync(siblingSource, { recursive: true });
		const selectedHost = `selected-credential-${Date.now()}.invalid`;
		const siblingHost = `unrelated-sibling-${Date.now()}.invalid`;
		const branch = `fixture/selected-credential-${Date.now()}`;
		const project = await registerProject({
			name: `Selected credential repository ${Date.now()}`,
			rootPath: projectRoot,
			components: [
				{ name: "selected", repo: "selected" },
				{ name: "sibling", repo: "sibling" },
			],
			seedWorkflows: false,
		});
		const sessionId = await createRemoteStateSession(gateway, selectedSource, project.id);
		gateway.sessionManager.updateSessionMeta(sessionId, { branch, repoPath: projectRoot });
		const session = gateway.sessionManager.getSession(sessionId) as any;
		session.cwd = selectedSource;
		session.repoPath = projectRoot;

		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		const originalSpawn = runner.spawn;
		const originalOwnedTreeCapability = runner.supportsOwnedTreeSpawn;
		const previousEnterpriseTokens = new Map<string, string | undefined>(
			["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].map(name => [name, process.env[name]] as const),
		);
		const probes: Array<{ request: string; cwd: string }> = [];
		const ghCalls: Array<{ args: string[]; cwd: string }> = [];
		const repositoryFor = (cwd: string) => {
			if (cwd === selectedSource) return {
				host: selectedHost,
				slug: "acme/selected-repository",
				commonDir: join(selectedSource, ".git"),
			};
			if (cwd === siblingSource) return {
				host: siblingHost,
				slug: "acme/unrelated-sibling",
				commonDir: join(siblingSource, ".git"),
			};
			return undefined;
		};

		try {
			delete process.env.GH_ENTERPRISE_TOKEN;
			delete process.env.GITHUB_ENTERPRISE_TOKEN;
			runner.spawn = createCommandSpawnAdapter(
				() => { throw new Error("credential fixture received an ordinary spawn"); },
				((_file: string, _args: readonly string[], options?: any) => {
					const tracked = credentialHelperResult(
						`protocol=https\nhost=${selectedHost}\nusername=route-fixture\npassword=fixture-secret\n`,
					);
					const probe = { request: "", cwd: String(options?.cwd ?? "") };
					probes.push(probe);
					tracked.child.stdin.on("data", (chunk: Buffer) => { probe.request += chunk.toString("utf8"); });
					return tracked;
				}) as any,
			);
			runner.supportsOwnedTreeSpawn = true;
			runner.execFile = async (file: string, args: readonly string[], options?: any) => {
				const command = commandName(file);
				const cwd = String(options?.cwd ?? "");
				const repository = repositoryFor(cwd);
				if (command === "git" && args.join(" ") === "rev-parse --show-toplevel") {
					if (!repository) throw new Error("not a configured repository source");
					return { stdout: `${cwd}\n`, stderr: "" };
				}
				if (command === "git" && args.join(" ") === "rev-parse --path-format=absolute --git-common-dir") {
					if (!repository) throw new Error("unknown repository identity");
					return { stdout: `${repository.commonDir}\n`, stderr: "" };
				}
				if (command === "git" && args.join(" ") === "rev-parse --git-dir") {
					if (cwd !== selectedSource) throw new Error("PR execution escaped selected repository");
					return { stdout: ".git\n", stderr: "" };
				}
				if (command === "git" && args.join(" ") === "remote get-url origin") {
					if (!repository) throw new Error("unknown repository remote");
					return { stdout: `https://${repository.host}/${repository.slug}.git\n`, stderr: "" };
				}
				if (command === "git" && args.join(" ") === `check-ref-format --branch ${branch}`) {
					return { stdout: `${branch}\n`, stderr: "" };
				}
				if (command === "gh") {
					ghCalls.push({ args: [...args], cwd });
					if (cwd !== selectedSource) throw new Error("gh escaped selected repository");
					if (args[0] === "pr" && args[1] === "list") {
						return { stdout: JSON.stringify([{
							number: 119,
							url: `https://${selectedHost}/acme/selected-repository/pull/119`,
							title: "selected credential repository",
							state: "OPEN",
							mergeable: "MERGEABLE",
							headRefName: branch,
							baseRefName: "main",
							...ownedHeadEvidence("acme", "selected-repository"),
						}]), stderr: "" };
					}
					if (args[0] === "api") {
						return {
							stdout: JSON.stringify({ data: { repository: { viewerPermission: "WRITE", pullRequest: { viewerCanMergeAsAdmin: false } } } }),
							stderr: "",
						};
					}
				}
				return unexpectedRunnerCommand(file, args, options);
			};

			const status = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit`);
			expect(status.status).toBe(200);
			expect(await status.json()).toMatchObject({
				stale: false,
				data: { number: 119, title: "selected credential repository" },
			});
			expect(probes).toEqual([expect.objectContaining({
				request: `url=https://${selectedHost}\n\n`,
			})]);
			expect(probes[0].cwd).not.toBe(selectedSource);
			expect(probes[0].request).not.toContain(siblingHost);
			const listCall = ghCalls.find(call => call.args[0] === "pr" && call.args[1] === "list");
			expect(listCall).toMatchObject({ cwd: selectedSource });
			expect(listCall?.args.slice(0, 6)).toEqual([
				"pr", "list", "--repo", `${selectedHost}/acme/selected-repository`, "--head", branch,
			]);
			expect(ghCalls.filter(call => call.args[0] === "api").every(call => (
				call.args[1] === "--hostname" && call.args[2] === selectedHost
			))).toBe(true);
			expect(JSON.stringify(ghCalls)).not.toContain(siblingHost);
		} finally {
			runner.execFile = originalExecFile;
			runner.spawn = originalSpawn;
			if (originalOwnedTreeCapability === undefined) delete runner.supportsOwnedTreeSpawn;
			else runner.supportsOwnedTreeSpawn = originalOwnedTreeCapability;
			for (const [name, value] of previousEnterpriseTokens) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			await deleteSession(sessionId);
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			const cleanup = await awaitableRm(projectRoot, { maxAttempts: 5, backoffMs: 50 });
			expect(cleanup.removed, `selected credential fixture cleanup failed: ${String(cleanup.lastError ?? "unknown error")}`).toBe(true);
		}
	});

	test("rejects an unlisted configured sibling alias without probing it or invoking gh", async ({ gateway }) => {
		test.setTimeout(30_000);
		const projectRoot = mkdtempSync(join(tmpdir(), "bobbit-pr-credential-alias-"));
		const selectedSource = join(projectRoot, "selected");
		const siblingSource = join(projectRoot, "sibling");
		mkdirSync(selectedSource, { recursive: true });
		mkdirSync(siblingSource, { recursive: true });
		const host = `credential-alias-${Date.now()}.invalid`;
		const branch = `fixture/credential-alias-${Date.now()}`;
		const commonDir = join(projectRoot, ".git", "shared");
		const project = await registerProject({
			name: `Credential repository alias ${Date.now()}`,
			rootPath: projectRoot,
			components: [
				{ name: "selected", repo: "selected" },
				{ name: "sibling", repo: "sibling" },
			],
			seedWorkflows: false,
		});
		const sessionId = await createRemoteStateSession(gateway, selectedSource, project.id);
		gateway.sessionManager.updateSessionMeta(sessionId, { branch, repoPath: projectRoot });
		const session = gateway.sessionManager.getSession(sessionId) as any;
		session.cwd = selectedSource;
		session.repoPath = projectRoot;

		const runner = (gateway.sessionManager as any).commandRunner;
		const originalExecFile = runner.execFile;
		const originalSpawn = runner.spawn;
		const originalOwnedTreeCapability = runner.supportsOwnedTreeSpawn;
		const previousEnterpriseTokens = new Map<string, string | undefined>(
			["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].map(name => [name, process.env[name]] as const),
		);
		const probes: Array<{ request: string; cwd: string }> = [];
		let ghCalls = 0;

		try {
			delete process.env.GH_ENTERPRISE_TOKEN;
			delete process.env.GITHUB_ENTERPRISE_TOKEN;
			runner.spawn = createCommandSpawnAdapter(
				() => { throw new Error("credential alias fixture received an ordinary spawn"); },
				((_file: string, _args: readonly string[], options?: any) => {
					const tracked = credentialHelperResult(
						`protocol=https\nhost=${host}\nusername=route-fixture\npassword=fixture-secret\n`,
					);
					const probe = { request: "", cwd: String(options?.cwd ?? "") };
					probes.push(probe);
					tracked.child.stdin.on("data", (chunk: Buffer) => { probe.request += chunk.toString("utf8"); });
					return tracked;
				}) as any,
			);
			runner.supportsOwnedTreeSpawn = true;
			runner.execFile = async (file: string, args: readonly string[], options?: any) => {
				const command = commandName(file);
				const cwd = String(options?.cwd ?? "");
				const configuredSource = cwd === selectedSource || cwd === siblingSource;
				if (command === "git" && args.join(" ") === "rev-parse --show-toplevel") {
					if (!configuredSource) throw new Error("not a configured repository source");
					return { stdout: `${cwd}\n`, stderr: "" };
				}
				if (command === "git" && args.join(" ") === "rev-parse --path-format=absolute --git-common-dir") {
					if (!configuredSource) throw new Error("unknown repository identity");
					return { stdout: `${commonDir}\n`, stderr: "" };
				}
				if (command === "git" && args.join(" ") === "remote get-url origin") {
					if (!configuredSource) throw new Error("unknown repository remote");
					return { stdout: `https://${host}/acme/shared-repository.git\n`, stderr: "" };
				}
				if (command === "gh") {
					ghCalls += 1;
					throw new Error("ambiguous configured repository reached gh");
				}
				return unexpectedRunnerCommand(file, args, options);
			};

			const status = await apiFetch(`/api/sessions/${sessionId}/pr-status?intent=explicit&optional=1`);
			expect(status.status).toBe(204);
			expect(await status.text()).toBe("");
			expect(probes).toEqual([expect.objectContaining({
				request: `url=https://${host}\n\n`,
			})]);
			expect(probes[0].cwd).not.toBe(selectedSource);
			expect(probes[0].request).not.toContain(siblingSource);
			expect(ghCalls).toBe(0);
		} finally {
			runner.execFile = originalExecFile;
			runner.spawn = originalSpawn;
			if (originalOwnedTreeCapability === undefined) delete runner.supportsOwnedTreeSpawn;
			else runner.supportsOwnedTreeSpawn = originalOwnedTreeCapability;
			for (const [name, value] of previousEnterpriseTokens) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			await deleteSession(sessionId);
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			const cleanup = await awaitableRm(projectRoot, { maxAttempts: 5, backoffMs: 50 });
			expect(cleanup.removed, `credential alias fixture cleanup failed: ${String(cleanup.lastError ?? "unknown error")}`).toBe(true);
		}
	});
});
