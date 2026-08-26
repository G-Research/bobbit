import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	symlinkSync,
	tmpdir,
	join,
	awaitableRm,
	test,
	expect,
	apiFetch,
	createGoal,
	deleteGoal,
	deleteSession,
	registerProject,
	unexpectedRunnerCommand,
	commandName,
	ownedHeadEvidence,
	ownedHeadEvidenceForSlug,
	createRemoteStateSession,
	installRemoteStateRouteHooks,
	handoffRemoteStateRouteRunner,
} from "../../support/harnesses/integration/remote-state-routes-fixture.js";

test.describe("remote-state coordinator routes", () => {
	installRemoteStateRouteHooks();

	test("binds goal, session, and sandbox PR operations to the requested multi-repository component", async ({ gateway }) => {
		test.setTimeout(30_000);
		const fixtureRoot = mkdtempSync(join(tmpdir(), "bobbit-pr-component-containment-"));
		const apiRepo = join(fixtureRoot, "api");
		const webRepo = join(fixtureRoot, "web");
		const worktreeRoot = join(fixtureRoot, "worktrees");
		const apiWorktree = join(worktreeRoot, "branch", "api");
		const aliasedWebWorktree = join(worktreeRoot, "branch", "web");
		for (const directory of [apiRepo, webRepo, apiWorktree]) mkdirSync(directory, { recursive: true });
		// A lexical web coordinate canonicalizes to the healthy API sibling. Junction
		// mode also exercises Windows without requiring developer-mode symlink rights.
		symlinkSync(apiWorktree, aliasedWebWorktree, process.platform === "win32" ? "junction" : "dir");
		const canonicalApiWorktree = realpathSync(aliasedWebWorktree);
		const branch = "41"; // Numeric branch names remain heads, never PR-number selectors.

		const project = await registerProject({
			name: `PR component containment ${Date.now()}`,
			rootPath: fixtureRoot,
			components: [
				{ name: "api", repo: "api" },
				{ name: "web", repo: "web", relative_path: "src" },
			],
			config: { worktree_root: worktreeRoot },
			seedWorkflows: false,
		});
		const goal = await createGoal({
			projectId: project.id,
			title: `Web component PR ${Date.now()}`,
			cwd: webRepo,
			worktree: false,
			autoStartTeam: false,
		});
		const goalId = String(goal.id);
		const productionRepoWorktrees = { api: apiWorktree, web: aliasedWebWorktree };
		gateway.sessionManager.getGoalStoreForProject(project.id).update(goalId, {
			cwd: join(aliasedWebWorktree, "src"),
			worktreePath: worktreeRoot,
			repoPath: fixtureRoot,
			repoWorktrees: productionRepoWorktrees,
			branch,
			setupStatus: "ready",
		});

		const normalSessionId = await createRemoteStateSession(gateway, webRepo, project.id);
		gateway.sessionManager.updateSessionMeta(normalSessionId, {
			branch,
			repoPath: fixtureRoot,
			worktreePath: worktreeRoot,
			repoWorktrees: productionRepoWorktrees,
		});
		const normalSession = gateway.sessionManager.getSession(normalSessionId) as any;
		normalSession.cwd = join(aliasedWebWorktree, "src");
		normalSession.repoPath = fixtureRoot;
		normalSession.worktreePath = worktreeRoot;
		normalSession.repoWorktrees = productionRepoWorktrees;

		const sandboxSessionId = await createRemoteStateSession(gateway, webRepo, project.id);
		gateway.sessionManager.updateSessionMeta(sandboxSessionId, {
			branch,
			repoPath: fixtureRoot,
			worktreePath: worktreeRoot,
			repoWorktrees: productionRepoWorktrees,
		});
		const sandboxSession = gateway.sessionManager.getSession(sandboxSessionId) as any;
		sandboxSession.sandboxed = true;
		sandboxSession.containerId = "fixture-web-component";
		sandboxSession.cwd = "/workspace-wt/branch/web/src";
		sandboxSession.repoPath = fixtureRoot;
		sandboxSession.worktreePath = worktreeRoot;
		sandboxSession.repoWorktrees = productionRepoWorktrees;

		const gitProbeCwds: string[] = [];
		const ghCalls: Array<{ args: string[]; cwd: string }> = [];
		const apiSentinel = "WRONG API COMPONENT SENTINEL";
		const routeExecFile = async (file: string, args: readonly string[], options?: any) => {
			const command = commandName(file);
			const cwd = String(options?.cwd ?? "");
			if (command === "docker" && args.includes("rev-parse") && args.includes("--abbrev-ref")) {
				return { stdout: `${branch}\n`, stderr: "" };
			}
			if (command === "docker" && args.includes("check-ref-format")) {
				return { stdout: `${branch}\n`, stderr: "" };
			}
			if (command === "git" && args.join(" ") === `check-ref-format --branch ${branch}`) {
				return { stdout: `${branch}\n`, stderr: "" };
			}
			if (command === "git" && args.join(" ") === "rev-parse --path-format=absolute --git-common-dir") {
				gitProbeCwds.push(cwd);
				if (cwd === webRepo) return { stdout: `${join(webRepo, ".git")}\n`, stderr: "" };
				if (cwd === apiRepo || cwd === canonicalApiWorktree || cwd === join(canonicalApiWorktree, "src")) {
					return { stdout: `${join(apiRepo, ".git")}\n`, stderr: "" };
				}
				throw new Error("unknown repository identity");
			}
			if (command === "git" && args.join(" ") === "rev-parse --show-toplevel") {
				gitProbeCwds.push(cwd);
				if (cwd === webRepo || cwd === apiRepo) return { stdout: `${cwd}\n`, stderr: "" };
				throw new Error("unknown configured component source");
			}
			if (command === "git" && args.join(" ") === "rev-parse --git-dir") {
				gitProbeCwds.push(cwd);
				if (cwd === webRepo || cwd === canonicalApiWorktree || cwd === apiRepo) return { stdout: ".git\n", stderr: "" };
				throw new Error("broken requested component worktree");
			}
			if (command === "git" && args.join(" ") === "remote get-url origin") {
				return { stdout: cwd === webRepo
					? "https://github.com/acme/owned-web.git\n"
					: "https://github.com/private/wrong-api.git\n", stderr: "" };
			}
			if (command === "gh") {
				ghCalls.push({ args: [...args], cwd });
				if (args[0] === "pr" && args[1] === "merge") return { stdout: "merged", stderr: "" };
				if (args[0] === "api") {
					return { stdout: JSON.stringify({ data: { repository: { viewerPermission: "WRITE", pullRequest: { viewerCanMergeAsAdmin: false } } } }), stderr: "" };
				}
				const repoIndex = args.indexOf("--repo");
				const headIndex = args.indexOf("--head");
				const correctRepo = args[repoIndex + 1] === "acme/owned-web";
				return {
					stdout: JSON.stringify([correctRepo ? {
						number: 41,
						url: "https://github.com/acme/owned-web/pull/41",
						title: "owned web component",
						state: "OPEN",
						mergeable: "MERGEABLE",
						headRefName: args[headIndex + 1],
						baseRefName: "main",
						...ownedHeadEvidence("acme", "owned-web"),
					} : {
						number: 666,
						url: "https://github.com/private/wrong-api/pull/666",
						title: apiSentinel,
						headRefName: branch,
					}]),
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
			const routeCases = [
				{ base: `/api/goals/${goalId}`, kind: "goal" },
				{ base: `/api/sessions/${normalSessionId}`, kind: "session" },
				{ base: `/api/sessions/${sandboxSessionId}`, kind: "sandbox" },
			];
			for (const routeCase of routeCases) {
				const status = await apiFetch(`${routeCase.base}/pr-status?intent=explicit`);
				expect(status.status, `${routeCase.kind} status`).toBe(200);
				expect(await status.json()).toMatchObject({ data: { number: 41, title: "owned web component" } });
				const merge = await apiFetch(`${routeCase.base}/pr-merge`, {
					method: "POST",
					body: JSON.stringify({ method: "rebase", branch }),
				});
				expect(merge.status, `${routeCase.kind} merge`).toBe(200);
			}
			// Every configured source is validated locally as an exact Git top-level;
			// the aliased worktree is then rejected by identity. GitHub reads and
			// destructive actions still use only the authoritative web source fallback.
			expect(gitProbeCwds).toContain(apiRepo);
			expect(gitProbeCwds).toContain(join(canonicalApiWorktree, "src"));
			expect(JSON.stringify(ghCalls)).not.toContain(apiSentinel);
			for (const call of ghCalls.filter(call => call.args[0] === "pr" && call.args[1] === "list")) {
				expect(call.cwd).toBe(webRepo);
				expect(call.args.slice(0, 6)).toEqual(["pr", "list", "--repo", "acme/owned-web", "--head", branch]);
			}
			for (const call of ghCalls.filter(call => call.args[0] === "pr" && call.args[1] === "merge")) {
				expect(call.cwd).toBe(webRepo);
				expect(call.args.slice(0, 5)).toEqual(["pr", "merge", "41", "--repo", "acme/owned-web"]);
			}
		} finally {
			restoreRunner();
			await Promise.all([deleteSession(normalSessionId), deleteSession(sandboxSessionId), deleteGoal(goalId)]);
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			await awaitableRm(fixtureRoot, { maxAttempts: 5, backoffMs: 50 });
		}
	});

	test("keeps genuine root and nested repositories bound to their exact PR targets", async ({ gateway }) => {
		test.setTimeout(30_000);
		const projectRoot = mkdtempSync(join(tmpdir(), "bobbit-pr-root-nested-"));
		const nestedSource = join(projectRoot, "packages", "nested");
		const worktreeRoot = mkdtempSync(join(tmpdir(), "bobbit-pr-root-nested-wt-"));
		const branchContainer = join(worktreeRoot, "branch");
		const rootWorktree = branchContainer;
		const nestedWorktree = join(branchContainer, "packages", "nested");
		mkdirSync(nestedSource, { recursive: true });
		mkdirSync(nestedWorktree, { recursive: true });
		const branch = "feature/root-and-nested";

		const project = await registerProject({
			name: `Root nested PR binding ${Date.now()}`,
			rootPath: projectRoot,
			components: [
				{ name: "root", repo: "." },
				{ name: "nested", repo: "packages/nested" },
			],
			config: { worktree_root: worktreeRoot },
			seedWorkflows: false,
		});
		const goals = await Promise.all([
			createGoal({ projectId: project.id, title: `Root PR ${Date.now()}`, cwd: projectRoot, worktree: false, autoStartTeam: false }),
			createGoal({ projectId: project.id, title: `Nested PR ${Date.now()}`, cwd: nestedSource, worktree: false, autoStartTeam: false }),
		]);
		const [rootGoalId, nestedGoalId] = goals.map(goal => String(goal.id));
		const repoWorktrees = { ".": rootWorktree, "packages/nested": nestedWorktree };
		const goalStore = gateway.sessionManager.getGoalStoreForProject(project.id);
		goalStore.update(rootGoalId, {
			cwd: rootWorktree,
			worktreePath: branchContainer,
			repoPath: projectRoot,
			repoWorktrees,
			branch,
			setupStatus: "ready",
		});
		goalStore.update(nestedGoalId, {
			cwd: nestedWorktree,
			worktreePath: branchContainer,
			repoPath: projectRoot,
			repoWorktrees,
			branch,
			setupStatus: "ready",
		});

		const repositoryByCwd = new Map([
			[projectRoot, { topLevel: projectRoot, commonDir: join(projectRoot, ".git"), slug: "acme/root-repository", number: 101, title: "root repository PR" }],
			[rootWorktree, { topLevel: rootWorktree, commonDir: join(projectRoot, ".git"), slug: "acme/root-repository", number: 101, title: "root repository PR" }],
			[nestedSource, { topLevel: nestedSource, commonDir: join(nestedSource, ".git"), slug: "acme/nested-repository", number: 202, title: "nested repository PR" }],
			[nestedWorktree, { topLevel: nestedWorktree, commonDir: join(nestedSource, ".git"), slug: "acme/nested-repository", number: 202, title: "nested repository PR" }],
		]);
		const ghCalls: Array<{ args: string[]; cwd: string }> = [];
		const routeExecFile = async (file: string, args: readonly string[], options?: any) => {
			const command = commandName(file);
			const cwd = String(options?.cwd ?? "");
			const repository = repositoryByCwd.get(cwd);
			if (command === "git" && args.join(" ") === "rev-parse --show-toplevel") {
				if (!repository || (cwd !== projectRoot && cwd !== nestedSource)) throw new Error("not a configured source");
				return { stdout: `${repository.topLevel}\n`, stderr: "" };
			}
			if (command === "git" && args.join(" ") === "rev-parse --path-format=absolute --git-common-dir") {
				if (!repository) throw new Error("unknown repository");
				return { stdout: `${repository.commonDir}\n`, stderr: "" };
			}
			if (command === "git" && args.join(" ") === "rev-parse --git-dir") {
				if (!repository) throw new Error("unknown repository");
				return { stdout: ".git\n", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "remote get-url origin") {
				if (!repository) throw new Error("unknown repository");
				return { stdout: `https://github.com/${repository.slug}.git\n`, stderr: "" };
			}
			if (command === "git" && args.join(" ") === `check-ref-format --branch ${branch}`) {
				return { stdout: `${branch}\n`, stderr: "" };
			}
			if (command === "gh") {
				ghCalls.push({ args: [...args], cwd });
				if (args[0] === "pr" && args[1] === "list") {
					if (!repository) throw new Error("GitHub read escaped configured repository");
					const repoIndex = args.indexOf("--repo");
					if (args[repoIndex + 1] !== repository.slug) throw new Error("GitHub repository selector mismatch");
					return {
						stdout: JSON.stringify([{
							number: repository.number,
							url: `https://github.com/${repository.slug}/pull/${repository.number}`,
							title: repository.title,
							state: "OPEN",
							mergeable: "MERGEABLE",
							headRefName: branch,
							baseRefName: "main",
							...ownedHeadEvidenceForSlug(repository.slug),
						}]),
						stderr: "",
					};
				}
				if (args[0] === "pr" && args[1] === "merge") return { stdout: "merged", stderr: "" };
				if (args[0] === "api") {
					return { stdout: JSON.stringify({ data: { repository: { viewerPermission: "WRITE", pullRequest: { viewerCanMergeAsAdmin: false } } } }), stderr: "" };
				}
			}
			return unexpectedRunnerCommand(file, args, options);
		};
		const restoreRunner = await handoffRemoteStateRouteRunner(gateway, [
			{ owner: "goals", id: rootGoalId },
			{ owner: "goals", id: nestedGoalId },
		], routeExecFile);

		try {
			const routeCases = [
				{ goalId: rootGoalId, repository: repositoryByCwd.get(rootWorktree)! },
				{ goalId: nestedGoalId, repository: repositoryByCwd.get(nestedWorktree)! },
			];
			for (const routeCase of routeCases) {
				const status = await apiFetch(`/api/goals/${routeCase.goalId}/pr-status?intent=explicit`);
				expect(status.status).toBe(200);
				expect(await status.json()).toMatchObject({
					stale: false,
					data: { number: routeCase.repository.number, title: routeCase.repository.title },
				});
				const merge = await apiFetch(`/api/goals/${routeCase.goalId}/pr-merge`, {
					method: "POST",
					body: JSON.stringify({ method: "rebase", branch }),
				});
				expect(merge.status).toBe(200);
			}

			const listCalls = ghCalls.filter(call => call.args[0] === "pr" && call.args[1] === "list");
			expect(listCalls.some(call => call.cwd === rootWorktree && call.args.includes("acme/root-repository"))).toBe(true);
			expect(listCalls.some(call => call.cwd === nestedWorktree && call.args.includes("acme/nested-repository"))).toBe(true);
			const mergeCalls = ghCalls.filter(call => call.args[0] === "pr" && call.args[1] === "merge");
			expect(mergeCalls).toEqual(expect.arrayContaining([
				expect.objectContaining({ cwd: rootWorktree, args: expect.arrayContaining(["101", "acme/root-repository"]) }),
				expect.objectContaining({ cwd: nestedWorktree, args: expect.arrayContaining(["202", "acme/nested-repository"]) }),
			]));
		} finally {
			restoreRunner();
			await Promise.all(goals.map(goal => deleteGoal(String(goal.id))));
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			await Promise.all([
				awaitableRm(projectRoot, { maxAttempts: 5, backoffMs: 50 }),
				awaitableRm(worktreeRoot, { maxAttempts: 5, backoffMs: 50 }),
			]);
		}
	});

	test("allows a selected trusted PR repository beside local-only and GitLab components", async ({ gateway }) => {
		test.setTimeout(30_000);
		const projectRoot = mkdtempSync(join(tmpdir(), "bobbit-pr-mixed-"));
		const nestedSource = join(projectRoot, "packages", "nested");
		const worktreeRoot = mkdtempSync(join(tmpdir(), "bobbit-pr-mixed-wt-"));
		const rootWorktree = join(worktreeRoot, "branch");
		const nestedWorktree = join(rootWorktree, "packages", "nested");
		mkdirSync(nestedSource, { recursive: true });
		mkdirSync(nestedWorktree, { recursive: true });
		const branch = "feature/mixed-polyrepo";
		const project = await registerProject({
			name: `Mixed PR routes ${Date.now()}`,
			rootPath: projectRoot,
			components: [
				{ name: "root", repo: "." },
				{ name: "nested", repo: "packages/nested" },
			],
			config: { worktree_root: worktreeRoot },
			seedWorkflows: false,
		});
		const goals = await Promise.all([
			createGoal({ projectId: project.id, title: `Mixed root ${Date.now()}`, cwd: projectRoot, worktree: false, autoStartTeam: false }),
			createGoal({ projectId: project.id, title: `Mixed nested ${Date.now()}`, cwd: nestedSource, worktree: false, autoStartTeam: false }),
		]);
		const [rootGoalId, nestedGoalId] = goals.map(goal => String(goal.id));
		const repoWorktrees = { ".": rootWorktree, "packages/nested": nestedWorktree };
		const goalStore = gateway.sessionManager.getGoalStoreForProject(project.id);
		for (const [goalId, cwd] of [[rootGoalId, rootWorktree], [nestedGoalId, nestedWorktree]] as const) {
			goalStore.update(goalId, {
				cwd,
				worktreePath: rootWorktree,
				repoPath: projectRoot,
				repoWorktrees,
				branch,
				setupStatus: "ready",
			});
		}

		type RepositoryFixture = { kind: "root" | "nested"; source: string; commonDir: string; slug: string; number: number; title: string };
		const rootRepository: RepositoryFixture = {
			kind: "root", source: projectRoot, commonDir: join(projectRoot, ".git"),
			slug: "acme/mixed-root", number: 301, title: "trusted root PR",
		};
		const nestedRepository: RepositoryFixture = {
			kind: "nested", source: nestedSource, commonDir: join(nestedSource, ".git"),
			slug: "acme/mixed-nested", number: 302, title: "trusted nested PR",
		};
		const repositoryByCwd = new Map<string, RepositoryFixture>([
			[projectRoot, rootRepository], [rootWorktree, rootRepository],
			[nestedSource, nestedRepository], [nestedWorktree, nestedRepository],
		]);
		let rootOrigin: string | undefined = `https://github.com/${rootRepository.slug}.git`;
		let nestedOrigin: string | undefined = "https://gitlab.example.test/acme/mixed-nested.git";
		const originFor = (repository: RepositoryFixture): string | undefined => repository.kind === "root" ? rootOrigin : nestedOrigin;
		const ghCalls: Array<{ args: string[]; cwd: string }> = [];
		const routeExecFile = async (file: string, args: readonly string[], options?: any) => {
			const command = commandName(file);
			const cwd = String(options?.cwd ?? "");
			const repository = repositoryByCwd.get(cwd);
			if (command === "git" && args.join(" ") === "rev-parse --show-toplevel") {
				if (!repository || cwd !== repository.source) throw new Error("not a configured source");
				return { stdout: `${repository.source}\n`, stderr: "" };
			}
			if (command === "git" && args.join(" ") === "rev-parse --path-format=absolute --git-common-dir") {
				if (!repository) throw new Error("unknown repository");
				return { stdout: `${repository.commonDir}\n`, stderr: "" };
			}
			if (command === "git" && args.join(" ") === "rev-parse --git-dir") {
				if (!repository) throw new Error("unknown repository");
				return { stdout: ".git\n", stderr: "" };
			}
			if (command === "git" && args.join(" ") === "remote get-url origin") {
				const origin = repository && originFor(repository);
				if (!origin) throw new Error("no origin configured");
				return { stdout: `${origin}\n`, stderr: "" };
			}
			if (command === "git" && args.join(" ") === `check-ref-format --branch ${branch}`) return { stdout: `${branch}\n`, stderr: "" };
			if (command === "gh") {
				ghCalls.push({ args: [...args], cwd });
				if (!repository || !originFor(repository)?.includes("github.com")) throw new Error("gh reached an untrusted component");
				if (args[0] === "pr" && args[1] === "list") {
					return { stdout: JSON.stringify([{
						number: repository.number,
						url: `https://github.com/${repository.slug}/pull/${repository.number}`,
						title: repository.title,
						state: "OPEN",
						mergeable: "MERGEABLE",
						headRefName: branch,
						baseRefName: "main",
						...ownedHeadEvidenceForSlug(repository.slug),
					}]), stderr: "" };
				}
				if (args[0] === "pr" && args[1] === "merge") return { stdout: "merged", stderr: "" };
				if (args[0] === "api") return { stdout: JSON.stringify({ data: { repository: { viewerPermission: "WRITE", pullRequest: { viewerCanMergeAsAdmin: false } } } }), stderr: "" };
			}
			return unexpectedRunnerCommand(file, args, options);
		};
		const restoreRunner = await handoffRemoteStateRouteRunner(gateway, [
			{ owner: "goals", id: rootGoalId },
			{ owner: "goals", id: nestedGoalId },
		], routeExecFile);

		const exerciseOrientation = async (trusted: { goalId: string; cwd: string; repository: RepositoryFixture }, untrustedGoalId: string) => {
			const trustedStatus = await apiFetch(`/api/goals/${trusted.goalId}/pr-status?intent=explicit`);
			expect(trustedStatus.status).toBe(200);
			expect(await trustedStatus.json()).toMatchObject({ data: { number: trusted.repository.number, title: trusted.repository.title } });
			const trustedMerge = await apiFetch(`/api/goals/${trusted.goalId}/pr-merge`, {
				method: "POST", body: JSON.stringify({ method: "rebase", branch }),
			});
			expect(trustedMerge.status).toBe(200);
			const callsBeforeUntrusted = ghCalls.length;
			expect((await apiFetch(`/api/goals/${untrustedGoalId}/pr-status?intent=explicit&optional=1`)).status).toBe(204);
			expect((await apiFetch(`/api/goals/${untrustedGoalId}/pr-merge`, {
				method: "POST", body: JSON.stringify({ method: "rebase", branch }),
			})).status).toBe(409);
			expect(ghCalls.length).toBe(callsBeforeUntrusted);
		};

		try {
			await exerciseOrientation({ goalId: rootGoalId, cwd: rootWorktree, repository: rootRepository }, nestedGoalId);
			rootOrigin = undefined;
			nestedOrigin = `https://github.com/${nestedRepository.slug}.git`;
			await exerciseOrientation({ goalId: nestedGoalId, cwd: nestedWorktree, repository: nestedRepository }, rootGoalId);
			for (const { cwd, repository } of [
				{ cwd: rootWorktree, repository: rootRepository },
				{ cwd: nestedWorktree, repository: nestedRepository },
			]) {
				const mergeCall = ghCalls.find(call => call.cwd === cwd && call.args[0] === "pr" && call.args[1] === "merge");
				expect(mergeCall?.args.slice(0, 5)).toEqual(["pr", "merge", String(repository.number), "--repo", repository.slug]);
			}
		} finally {
			restoreRunner();
			await Promise.all(goals.map(goal => deleteGoal(String(goal.id))));
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			await Promise.all([
				awaitableRm(projectRoot, { maxAttempts: 5, backoffMs: 50 }),
				awaitableRm(worktreeRoot, { maxAttempts: 5, backoffMs: 50 }),
			]);
		}
	});
});
