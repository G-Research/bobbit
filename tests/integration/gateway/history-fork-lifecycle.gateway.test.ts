import {
	randomUUID,
	fs,
	test,
	expect,
	nonGitCwd,
	localApiFetch,
	sessionTranscriptHostPath,
	sessions,
	serverModule,
	agentSessionsDir,
	deferred,
	seedTranscript,
	ordinaryHistory,
	historyFork,
	responseJson,
	statePath,
	authorPath,
	transcriptFilesForSession,
	createTrackedSession,
	createTrackedSessionWithoutWorktree,
	registerUntrackedFixtureProject,
	installSandboxSessionFilesystem,
	configureSandboxOwner,
	configureSandboxBorrower,
	installHistoryForkHooks,
} from "../../support/harnesses/integration/history-fork-fixture.js";

test.describe("history fork API: owner and project lifecycle serialization", () => {
	installHistoryForkHooks();

	test("fork registration wins the owner FIFO before DELETE, which waits and rejects without mutation", async ({ gateway }) => {
		const sourceId = await createTrackedSession();
		const sourceCoordinates = configureSandboxOwner(gateway, sourceId, `fork-wins-${randomUUID()}`);
		const seeded = seedTranscript(gateway, sourceId, ordinaryHistory());
		const manager = gateway.sessionManager;
		const source = manager.getSession(sourceId);
		const originalCreateSession = manager.createSession;
		const originalLifecycle = manager.withSandboxWorktreeOwnerLifecycle;
		const originalSandboxManager = manager.sandboxManager;
		const createEntered = deferred<void>();
		const releaseCreate = deferred<void>();
		const deleteQueued = deferred<void>();
		const removed: string[] = [];
		let lifecycleCalls = 0;
		let sourceStopCalls = 0;
		const originalSourceStop = source.rpcClient.stop;
		let forkId = "";

		const sandboxFixture = installSandboxSessionFilesystem(gateway, "fork-wins", removed);
		manager.withSandboxWorktreeOwnerLifecycle = function(ownerId: string, operation: () => Promise<unknown>) {
			lifecycleCalls++;
			if (lifecycleCalls === 2) deleteQueued.resolve();
			return originalLifecycle.call(this, ownerId, operation);
		};
		manager.createSession = async (...args: any[]) => {
			createEntered.resolve();
			await releaseCreate.promise;
			args[0] = nonGitCwd();
			args[4] = {
				...args[4],
				sandboxed: false,
			};
			return originalCreateSession.apply(manager, args);
		};
		source.rpcClient.stop = async (...args: any[]) => {
			sourceStopCalls++;
			return originalSourceStop.apply(source.rpcClient, args);
		};

		try {
			const forkPromise = historyFork(gateway, sourceId, "selected-user", false);
			await createEntered.promise;
			const deletePromise = localApiFetch(gateway, `/api/sessions/${sourceId}`, { method: "DELETE" });
			await deleteQueued.promise;
			expect(lifecycleCalls).toBe(2);
			expect(manager.getSession(sourceId)).toBe(source);

			releaseCreate.resolve();
			const forkResponse = await forkPromise;
			expect(forkResponse.status, JSON.stringify(await responseJson(forkResponse))).toBe(201);
			const fork = await forkResponse.json();
			forkId = sessions.add(fork.id);

			const deleteResponse = await deletePromise;
			expect(deleteResponse.status).toBe(409);
			expect(await responseJson(deleteResponse)).toMatchObject({ code: "SHARED_SANDBOX_WORKTREE_IN_USE" });
		} finally {
			releaseCreate.resolve();
			manager.createSession = originalCreateSession;
			manager.withSandboxWorktreeOwnerLifecycle = originalLifecycle;
			manager.sandboxManager = originalSandboxManager;
			sandboxFixture.restore();
			source.rpcClient.stop = originalSourceStop;
		}

		expect(sourceStopCalls).toBe(0);
		expect(removed).toEqual([]);
		expect(manager.getSession(sourceId)).toBe(source);
		const preservedSource = manager.getPersistedSession(sourceId);
		expect(preservedSource?.agentSessionFile).toMatch(/^\/home\/node\/\.bobbit\/agent\/sessions\//);
		const preservedSourceHost = sessionTranscriptHostPath(sourceId, preservedSource!.agentSessionFile);
		expect(preservedSourceHost).toBeTruthy();
		expect(fs.readFileSync(preservedSourceHost!, "utf8")).toBe(seeded.content);
		expect(preservedSource?.archived).not.toBe(true);
		expect(manager.getSession(forkId)).toBeTruthy();
		expect(manager.getPersistedSession(forkId)).toMatchObject({
			borrowsWorktree: true,
			borrowedWorktreeOwnerSessionId: sourceId,
		});
		expect(sourceCoordinates.branch).toMatch(/^session\/fork-wins-/);
	});
	test("owner DELETE wins the FIFO before fork registration, which cleans artifacts and never recreates", async ({ gateway }) => {
		const sourceId = await createTrackedSession();
		const sourceCoordinates = configureSandboxOwner(gateway, sourceId, `delete-wins-${randomUUID()}`);
		seedTranscript(gateway, sourceId, ordinaryHistory());
		const manager = gateway.sessionManager;
		const source = manager.getSession(sourceId);
		const originalCreateSession = manager.createSession;
		const originalLifecycle = manager.withSandboxWorktreeOwnerLifecycle;
		const originalSandboxManager = manager.sandboxManager;
		const originalGetState = source.rpcClient.getState;
		const deleteEntered = deferred<void>();
		const releaseDelete = deferred<void>();
		const forkQueued = deferred<void>();
		const removed: string[] = [];
		let lifecycleCalls = 0;
		let createCalls = 0;
		let destinationId = "";

		const sandboxFixture = installSandboxSessionFilesystem(gateway, "delete-wins", removed);
		manager.withSandboxWorktreeOwnerLifecycle = function(ownerId: string, operation: () => Promise<unknown>) {
			lifecycleCalls++;
			if (lifecycleCalls === 2) forkQueued.resolve();
			return originalLifecycle.call(this, ownerId, operation);
		};
		source.rpcClient.getState = async () => {
			deleteEntered.resolve();
			await releaseDelete.promise;
			return { success: true, data: {} };
		};
		manager.createSession = async () => {
			createCalls++;
			throw new Error("fork must not recreate after owner termination");
		};
		serverModule.__setHistoryForkSidecarCopyFake((
			_kind: "skill" | "compaction" | "author",
			_fromSessionId: string,
			toSessionId: string,
		) => {
			destinationId = toSessionId;
			return undefined;
		});

		let deleteResponse: Response;
		let forkResponse: Response;
		try {
			const deletePromise = localApiFetch(gateway, `/api/sessions/${sourceId}`, { method: "DELETE" });
			await deleteEntered.promise;
			const forkPromise = historyFork(gateway, sourceId, "selected-user", false);
			await forkQueued.promise;
			expect(destinationId).toBeTruthy();
			expect(lifecycleCalls).toBe(2);

			releaseDelete.resolve();
			deleteResponse = await deletePromise;
			forkResponse = await forkPromise;
		} finally {
			releaseDelete.resolve();
			serverModule.__clearHistoryForkSidecarCopyFake();
			manager.createSession = originalCreateSession;
			manager.withSandboxWorktreeOwnerLifecycle = originalLifecycle;
			manager.sandboxManager = originalSandboxManager;
			sandboxFixture.restore();
			source.rpcClient.getState = originalGetState;
		}

		expect(deleteResponse!.status).toBe(200);
		expect(forkResponse!.status).toBe(422);
		expect(await responseJson(forkResponse!)).toEqual({
			error: "The source session is no longer available for history forking",
			code: "HISTORY_FORK_SOURCE_UNAVAILABLE",
		});
		expect(createCalls).toBe(0);
		expect(removed).toEqual([sourceCoordinates.branch]);
		expect(manager.getSession(sourceId)).toBeUndefined();
		expect(manager.getPersistedSession(sourceId)?.archived).toBe(true);
		expect(manager.getSession(destinationId)).toBeUndefined();
		expect(manager.getPersistedSession(destinationId)).toBeUndefined();
		expect(transcriptFilesForSession(agentSessionsDir, destinationId)).toEqual([]);
		expect(fs.existsSync(authorPath(gateway, destinationId))).toBe(false);
		expect(fs.existsSync(statePath(gateway, "skill-sidecar", destinationId, ".jsonl"))).toBe(false);
		expect(fs.existsSync(statePath(gateway, "compaction-sidecar", destinationId, ".jsonl"))).toBe(false);
		expect(fs.existsSync(statePath(gateway, "proposal-drafts", destinationId))).toBe(false);
		expect(fs.existsSync(statePath(gateway, "tool-content", destinationId))).toBe(false);
	});
	test("project DELETE terminates a shared-worktree borrower before its owner and removes the owner worktree once", async ({ gateway }) => {
		const project = await registerUntrackedFixtureProject(gateway, "project-delete-borrower-order");
		const ownerId = await createTrackedSessionWithoutWorktree(project.rootPath, project.id);
		const borrowerId = await createTrackedSessionWithoutWorktree(project.rootPath, project.id);
		const ownerCoordinates = configureSandboxOwner(gateway, ownerId, `project-delete-${randomUUID()}`);
		configureSandboxBorrower(gateway, borrowerId, ownerId, ownerCoordinates.cwd);

		const manager = gateway.sessionManager;
		const projectContexts = gateway.projectContextManager;
		const registry = projectContexts.getRegistry();
		const initialContext = projectContexts.getOrCreate(project.id);
		expect(initialContext).toBeTruthy();
		expect(registry.get(project.id)).toMatchObject({ id: project.id });

		const originalTerminateSession = manager.terminateSession;
		const originalSandboxManager = manager.sandboxManager;
		const terminationOrder: string[] = [];
		const removed: string[] = [];
		let response: Response | undefined;
		const sandboxFixture = installSandboxSessionFilesystem(gateway, "project-delete", removed);
		manager.terminateSession = async (sessionId: string) => {
			terminationOrder.push(sessionId);
			return originalTerminateSession.call(manager, sessionId);
		};

		try {
			response = await localApiFetch(gateway, `/api/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" });
		} finally {
			manager.terminateSession = originalTerminateSession;
			manager.sandboxManager = originalSandboxManager;
			sandboxFixture.restore();
			if (response?.status !== 200) {
				await manager.terminateSession(borrowerId).catch(() => undefined);
				await manager.terminateSession(ownerId).catch(() => undefined);
				await localApiFetch(gateway, `/api/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" }).catch(() => undefined);
			}
		}

		expect(response!.status, JSON.stringify(await responseJson(response!))).toBe(200);
		expect(await response!.json()).toEqual({ ok: true });
		expect(terminationOrder).toEqual([borrowerId, ownerId]);
		expect(removed).toEqual([ownerCoordinates.branch]);
		expect(manager.getSession(borrowerId)).toBeUndefined();
		expect(manager.getSession(ownerId)).toBeUndefined();
		expect(manager.getAllSessionsRaw().filter((session: any) => session.projectId === project.id)).toEqual([]);
		expect(Array.from(projectContexts.all()).some((context: any) => context.project.id === project.id)).toBe(false);
		expect(registry.get(project.id)).toBeUndefined();
	});
	test("history borrower registration wins the owner FIFO and makes concurrent project DELETE return a typed 409", async ({ gateway, scope }) => {
		const project = await registerUntrackedFixtureProject(gateway, "project-delete-borrower-wins");
		scope.trackProject(project.id);
		const sourceId = await createTrackedSessionWithoutWorktree(project.rootPath, project.id);
		const sourceCoordinates = configureSandboxOwner(gateway, sourceId, `project-delete-fork-wins-${randomUUID()}`);
		const seeded = seedTranscript(gateway, sourceId, ordinaryHistory());
		const manager = gateway.sessionManager;
		const source = manager.getSession(sourceId);
		const projectContexts = gateway.projectContextManager;
		const registry = projectContexts.getRegistry();
		const initialContext = projectContexts.getOrCreate(project.id);
		expect(initialContext).toBeTruthy();

		const originalCreateSession = manager.createSession;
		const originalLifecycle = manager.withSandboxWorktreeOwnerLifecycle;
		const originalSandboxManager = manager.sandboxManager;
		const originalSourceStop = source.rpcClient.stop;
		const createEntered = deferred<void>();
		const releaseCreate = deferred<void>();
		const projectDeleteQueued = deferred<void>();
		const removed: string[] = [];
		let lifecycleCalls = 0;
		let sourceStopCalls = 0;
		let forkId = "";
		let deletePromise: Promise<Response> | undefined;
		let deleteResponse: Response | undefined;

		const sandboxFixture = installSandboxSessionFilesystem(gateway, "project-delete-fork-wins", removed);
		manager.withSandboxWorktreeOwnerLifecycle = function(ownerId: string, operation: () => Promise<unknown>) {
			lifecycleCalls++;
			if (lifecycleCalls === 2) projectDeleteQueued.resolve();
			return originalLifecycle.call(this, ownerId, operation);
		};
		manager.createSession = async (...args: any[]) => {
			createEntered.resolve();
			await releaseCreate.promise;
			args[0] = project.rootPath;
			args[4] = {
				...args[4],
				sandboxed: false,
			};
			const created = await originalCreateSession.apply(manager, args);
			configureSandboxBorrower(gateway, created.id, sourceId, sourceCoordinates.cwd);
			return created;
		};
		source.rpcClient.stop = async (...args: any[]) => {
			sourceStopCalls++;
			return originalSourceStop.apply(source.rpcClient, args);
		};

		try {
			const forkPromise = historyFork(gateway, sourceId, "selected-user", false);
			await createEntered.promise;
			deletePromise = localApiFetch(gateway, `/api/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" });
			await projectDeleteQueued.promise;
			expect(lifecycleCalls).toBe(2);
			expect(manager.getSession(sourceId)).toBe(source);

			releaseCreate.resolve();
			const forkResponse = await forkPromise;
			expect(forkResponse.status, JSON.stringify(await responseJson(forkResponse))).toBe(201);
			const fork = await forkResponse.json();
			forkId = sessions.add(fork.id);
			deleteResponse = await deletePromise;
		} finally {
			releaseCreate.resolve();
			if (deletePromise && !deleteResponse) deleteResponse = await deletePromise.catch(() => undefined);
			manager.createSession = originalCreateSession;
			manager.withSandboxWorktreeOwnerLifecycle = originalLifecycle;
			manager.sandboxManager = originalSandboxManager;
			sandboxFixture.restore();
			source.rpcClient.stop = originalSourceStop;
		}

		expect(deleteResponse!.status).toBe(409);
		expect(await responseJson(deleteResponse!)).toMatchObject({ code: "SHARED_SANDBOX_WORKTREE_IN_USE" });
		expect(sourceStopCalls).toBe(0);
		expect(removed).toEqual([]);
		expect(manager.getSession(sourceId)).toBe(source);
		const preservedSource = manager.getPersistedSession(sourceId);
		expect(preservedSource?.agentSessionFile).toMatch(/^\/home\/node\/\.bobbit\/agent\/sessions\//);
		const preservedSourceHost = sessionTranscriptHostPath(sourceId, preservedSource!.agentSessionFile);
		expect(preservedSourceHost).toBeTruthy();
		expect(fs.readFileSync(preservedSourceHost!, "utf8")).toBe(seeded.content);
		expect(preservedSource?.archived).not.toBe(true);
		expect(manager.getSession(forkId)).toBeTruthy();
		expect(manager.getPersistedSession(forkId)).toMatchObject({
			projectId: project.id,
			sandboxed: true,
			borrowsWorktree: true,
			borrowedWorktreeOwnerSessionId: sourceId,
		});
		expect(manager.resolveSandboxWorktreeOwnerSessionId(forkId)).toBe(sourceId);
		expect(projectContexts.getOrCreate(project.id)).toBe(initialContext);
		expect(registry.get(project.id)).toMatchObject({ id: project.id });
		expect(sourceCoordinates.branch).toMatch(/^session\/project-delete-fork-wins-/);
	});
});
