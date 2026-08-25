import {
	randomUUID,
	fs,
	path,
	test,
	expect,
	nonGitCwd,
	registerProject,
	copyGitTemplate,
	sessions,
	rpcBridgeModule,
	fixtureRoots,
	seedTranscript,
	ordinaryHistory,
	setPersistedTranscriptPath,
	historyFork,
	responseJson,
	statePath,
	filesystemIdentity,
	authorPath,
	createTrackedSession,
	createTrackedSessionWithoutWorktree,
	installSandboxSessionFilesystem,
	configureSandboxOwner,
	configureSandboxBorrower,
	installHistoryForkHooks,
} from "../../support/harnesses/integration/history-fork-fixture.js";

test.describe("history fork API: worktree ownership and setup", () => {
	installHistoryForkHooks();

	test("reuse mode uses the exact live cwd and carries no worktree teardown ownership", async ({ gateway }) => {
		const sourceWorktree = path.join(nonGitCwd(), `history-source-${randomUUID()}`);
		const liveCwd = path.join(sourceWorktree, "packages", "web");
		fs.mkdirSync(liveCwd, { recursive: true });
		fixtureRoots.push(sourceWorktree);
		const sentinel = path.join(sourceWorktree, "uncommitted.txt");
		fs.writeFileSync(sentinel, "preserve working state", "utf8");

		const sourceId = await createTrackedSession(liveCwd);
		const sourceTranscript = seedTranscript(gateway, sourceId, ordinaryHistory());
		const sourceBytes = fs.readFileSync(sourceTranscript.file);
		const sourcePersisted = gateway.sessionManager.getPersistedSession(sourceId);
		gateway.sessionManager.getSessionStore(sourcePersisted.projectId).update(sourceId, {
			cwd: liveCwd,
			worktreePath: sourceWorktree,
			repoPath: nonGitCwd(),
			branch: "feature/shared-source",
		});
		gateway.sessionManager.getSession(sourceId).cwd = liveCwd;
		const sourceCoordinates = {
			cwd: liveCwd,
			worktreePath: sourceWorktree,
			repoPath: nonGitCwd(),
			branch: "feature/shared-source",
		};

		const manager = gateway.sessionManager;
		const originalCreateSession = manager.createSession;
		let capturedOptions: any;
		manager.createSession = async (...args: any[]) => {
			capturedOptions = args[4];
			return originalCreateSession.apply(manager, args);
		};
		let response: Response;
		try {
			response = await historyFork(gateway, sourceId, "selected-user", false);
		} finally {
			manager.createSession = originalCreateSession;
		}
		expect(response.status, JSON.stringify(await responseJson(response))).toBe(201);
		const fork = await response.json();
		sessions.add(fork.id);
		const forkPersisted = gateway.sessionManager.getPersistedSession(fork.id);
		expect(capturedOptions.worktreeOpts).toBeUndefined();
		expect(capturedOptions.awaitWorktreeSetup).toBeUndefined();
		expect(capturedOptions.borrowsWorktree).toBe(true);
		expect(fork.cwd).toBe(liveCwd);
		expect(forkPersisted.cwd).toBe(liveCwd);
		expect(forkPersisted.borrowsWorktree).toBe(true);
		expect(forkPersisted.worktreePath).toBeUndefined();
		expect(forkPersisted.repoPath).toBeUndefined();
		expect(forkPersisted.branch).toBeUndefined();

		await gateway.sessionManager.terminateSession(fork.id);
		expect(fs.readFileSync(sentinel, "utf8")).toBe("preserve working state");
		expect(fs.existsSync(sourceWorktree)).toBe(true);
		expect(fs.readFileSync(sourceTranscript.file).equals(sourceBytes), "source JSONL bytes remain unchanged").toBe(true);
		expect(gateway.sessionManager.getSession(sourceId), "terminating fork does not stop source").toBeTruthy();
		expect(gateway.sessionManager.getPersistedSession(sourceId)).toMatchObject(sourceCoordinates);
	});
	test("forking from a sandbox borrower flattens durable ownership to the original worktree owner", async ({ gateway }) => {
		const ownerId = await createTrackedSession();
		const borrowerId = await createTrackedSession();
		const ownerCoordinates = configureSandboxOwner(gateway, ownerId, `flatten-${randomUUID()}`);
		configureSandboxBorrower(gateway, borrowerId, ownerId, ownerCoordinates.cwd);
		seedTranscript(gateway, borrowerId, ordinaryHistory());
		expect(gateway.sessionManager.resolveSandboxWorktreeOwnerSessionId(borrowerId)).toBe(ownerId);

		const manager = gateway.sessionManager;
		const originalCreateSession = manager.createSession;
		let capturedOptions: any;
		manager.createSession = async (...args: any[]) => {
			capturedOptions = args[4];
			args[0] = nonGitCwd();
			args[4] = {
				...args[4],
				sandboxed: false,
			};
			return originalCreateSession.apply(manager, args);
		};
		let response: Response;
		try {
			response = await historyFork(gateway, borrowerId, "selected-user", false);
		} finally {
			manager.createSession = originalCreateSession;
		}

		expect(response.status, JSON.stringify(await responseJson(response))).toBe(201);
		const fork = await response.json();
		sessions.add(fork.id);
		const forkPersisted = gateway.sessionManager.getPersistedSession(fork.id);
		expect(capturedOptions.borrowedWorktreeOwnerSessionId).toBe(ownerId);
		expect(capturedOptions.borrowedWorktreeOwnerSessionId).not.toBe(borrowerId);
		expect(forkPersisted).toMatchObject({
			borrowsWorktree: true,
			borrowedWorktreeOwnerSessionId: ownerId,
		});
	});
	test("publishes, rebases, and rehydrates a sandbox history transcript using canonical container coordinates", async ({ gateway }) => {
		const sourceId = await createTrackedSession();
		const sourceCoordinates = configureSandboxOwner(gateway, sourceId, `container-coordinate-${randomUUID()}`);
		const seeded = seedTranscript(gateway, sourceId, ordinaryHistory());
		const manager = gateway.sessionManager;
		const sandboxFixture = installSandboxSessionFilesystem(gateway, "container-coordinate");
		const sourceContainerPath = `/home/node/.bobbit/agent/sessions/--canonical-source--/${sourceId}.jsonl`;
		const sourceHostPath = sandboxFixture.filesystem.hostPath(sourceContainerPath);
		fs.mkdirSync(path.dirname(sourceHostPath), { recursive: true });
		fs.writeFileSync(sourceHostPath, seeded.content, "utf8");
		setPersistedTranscriptPath(gateway, sourceId, sourceContainerPath);
		const sourceBytes = fs.readFileSync(sourceHostPath);
		const originalApplySandboxWiring = manager.applySandboxWiring;
		const originalSendCommand = rpcBridgeModule.RpcBridge.prototype.sendCommand;
		manager.applySandboxWiring = async (options: any) => {
			options.cwd = nonGitCwd();
			delete options.containerId;
			return true;
		};
		rpcBridgeModule.RpcBridge.prototype.sendCommand = function(command: any, ...rest: any[]) {
			if (command?.type === "switch_session" && typeof command.sessionPath === "string") {
				command = {
					...command,
					sessionPath: sandboxFixture.filesystem.hostPath(command.sessionPath),
				};
			}
			return originalSendCommand.call(this, command, ...rest);
		};

		let response: Response;
		try {
			response = await historyFork(gateway, sourceId, "selected-user", false);
		} finally {
			manager.applySandboxWiring = originalApplySandboxWiring;
			rpcBridgeModule.RpcBridge.prototype.sendCommand = originalSendCommand;
			sandboxFixture.restore();
		}

		expect(response.status, JSON.stringify(await responseJson(response))).toBe(201);
		const fork = await response.json();
		sessions.add(fork.id);
		const persisted = manager.getPersistedSession(fork.id);
		expect(persisted).toMatchObject({
			sandboxed: true,
			borrowsWorktree: true,
			borrowedWorktreeOwnerSessionId: sourceId,
		});
		expect(persisted.agentSessionFile).toMatch(/^\/home\/node\/\.bobbit\/agent\/sessions\//);
		const destinationBytes = fs.readFileSync(
			sandboxFixture.filesystem.hostPath(persisted.agentSessionFile),
			"utf8",
		);
		expect(destinationBytes).toContain("retained prompt");
		expect(destinationBytes).not.toContain("selected prompt");
		expect(destinationBytes).not.toContain("discarded answer");
		expect(fs.readFileSync(sourceHostPath).equals(sourceBytes)).toBe(true);
		expect(manager.getPersistedSession(sourceId)).toMatchObject({
			cwd: sourceCoordinates.cwd,
			worktreePath: sourceCoordinates.root,
			branch: sourceCoordinates.branch,
			agentSessionFile: sourceContainerPath,
		});
	});
	test("new-worktree mode uses the established fresh branch lifecycle and preserves reattempt context", async ({ gateway }) => {
		const projectRoot = path.join(gateway.bobbitDir, `history-fork-project-${randomUUID()}`);
		copyGitTemplate(projectRoot);
		const project = await registerProject({
			name: `history-fork-${randomUUID()}`,
			rootPath: projectRoot,
			seedWorkflows: false,
		});
		const sourceId = await createTrackedSessionWithoutWorktree(projectRoot, project.id);
		seedTranscript(gateway, sourceId, ordinaryHistory());
		const sourcePersisted = gateway.sessionManager.getPersistedSession(sourceId);
		gateway.sessionManager.getSessionStore(sourcePersisted.projectId).update(sourceId, {
			reattemptGoalId: "fixture-reattempt-goal",
		});

		const manager = gateway.sessionManager;
		const originalCreateSession = manager.createSession;
		let capturedOptions: any;
		manager.createSession = async (...args: any[]) => {
			capturedOptions = args[4];
			return originalCreateSession.apply(manager, args);
		};
		let response: Response;
		try {
			response = await historyFork(gateway, sourceId, "selected-user", true);
		} finally {
			manager.createSession = originalCreateSession;
		}
		expect(response.status, JSON.stringify(await responseJson(response))).toBe(201);
		const fork = await response.json();
		sessions.add(fork.id);
		const forkPersisted = gateway.sessionManager.getPersistedSession(fork.id);

		expect(filesystemIdentity(capturedOptions.worktreeOpts.repoPath)).toBe(filesystemIdentity(projectRoot));
		expect(capturedOptions.awaitWorktreeSetup).toBe(true);
		expect(capturedOptions.reattemptGoalId).toBe("fixture-reattempt-goal");
		expect(fork.status).toBe("idle");
		expect(filesystemIdentity(fork.cwd)).not.toBe(filesystemIdentity(projectRoot));
		expect(filesystemIdentity(fork.cwd)).toBe(filesystemIdentity(forkPersisted.cwd));
		expect(filesystemIdentity(forkPersisted.cwd)).not.toBe(filesystemIdentity(projectRoot));
		expect(filesystemIdentity(forkPersisted.worktreePath)).toBe(filesystemIdentity(forkPersisted.cwd));
		expect(filesystemIdentity(forkPersisted.repoPath)).toBe(filesystemIdentity(projectRoot));
		expect(forkPersisted.branch).toMatch(/^session\//);
		expect(forkPersisted.reattemptGoalId).toBe("fixture-reattempt-goal");
		expect(fs.existsSync(forkPersisted.cwd)).toBe(true);
		expect(fs.existsSync(path.join(forkPersisted.cwd, ".git"))).toBe(true);
		const forkTranscript = fs.readFileSync(forkPersisted.agentSessionFile, "utf8");
		const forkHeader = JSON.parse(forkTranscript.split(/\r?\n/, 1)[0]);
		expect(filesystemIdentity(forkHeader.cwd)).toBe(filesystemIdentity(forkPersisted.cwd));
		expect(forkTranscript).not.toContain("selected prompt");
	});
	test("awaited fresh worktree setup failures return an error and purge the destination", async ({ gateway }) => {
		const projectRoot = path.join(gateway.bobbitDir, `history-fork-failure-${randomUUID()}`);
		copyGitTemplate(projectRoot);
		const project = await registerProject({
			name: `history-fork-failure-${randomUUID()}`,
			rootPath: projectRoot,
			seedWorkflows: false,
		});
		const sourceId = await createTrackedSessionWithoutWorktree(projectRoot, project.id);
		seedTranscript(gateway, sourceId, ordinaryHistory());

		const manager = gateway.sessionManager;
		const originalCreateSession = manager.createSession;
		let capturedOptions: any;
		manager.createSession = async (...args: any[]) => {
			capturedOptions = { ...args[4], worktreeOpts: { ...args[4]?.worktreeOpts } };
			args[4] = {
				...args[4],
				worktreeOpts: { repoPath: path.join(projectRoot, "missing-repo") },
				bypassWorktreePool: true,
			};
			return originalCreateSession.apply(manager, args);
		};
		let response: Response;
		try {
			response = await historyFork(gateway, sourceId, "selected-user", true);
		} finally {
			manager.createSession = originalCreateSession;
		}

		expect(filesystemIdentity(capturedOptions.worktreeOpts.repoPath)).toBe(filesystemIdentity(projectRoot));
		expect(capturedOptions.awaitWorktreeSetup).toBe(true);
		expect(response.status).toBe(500);
		expect((await responseJson(response)).error).toContain("failed to fork session");
		expect(gateway.sessionManager.getSession(capturedOptions.sessionId)).toBeUndefined();
		expect(gateway.sessionManager.getPersistedSession(capturedOptions.sessionId)).toBeUndefined();
		expect(fs.existsSync(capturedOptions.preExistingAgentSessionFile)).toBe(false);
		expect(fs.existsSync(authorPath(gateway, capturedOptions.sessionId))).toBe(false);
		expect(fs.existsSync(statePath(gateway, "skill-sidecar", capturedOptions.sessionId, ".jsonl"))).toBe(false);
		expect(fs.existsSync(statePath(gateway, "compaction-sidecar", capturedOptions.sessionId, ".jsonl"))).toBe(false);
		expect(fs.existsSync(statePath(gateway, "proposal-drafts", capturedOptions.sessionId))).toBe(false);
	});
});
