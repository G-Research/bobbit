import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { test, expect } from "../../../tests2/integration/_e2e/in-process-harness.js";
import { seedSessionTranscript } from "../../../tests2/integration/helpers/session-fixtures.js";
import {
	createStaff,
	deleteStaff,
	forkSession,
	inbox,
	installStaffForkCleanup,
	listStaff,
	sourceSnapshot,
	FAILURE_MARKER,
} from "./_helpers/staff-fork-fixtures.js";

test.describe.serial("staff session fork borrowed ownership and publication failures", () => {
	installStaffForkCleanup();

	test("borrowed-worktree mode persists destination-only borrower provenance and cleanup", async ({ gateway }) => {
		const source = await createStaff(gateway, { name: "Borrowed worktree source", worktree: false });
		seedSessionTranscript(gateway, source.currentSessionId);
		const sourceSessionBefore = structuredClone(gateway.sessionManager.getPersistedSession(source.currentSessionId));

		const result = await forkSession(gateway, source.currentSessionId, { newWorktree: false });
		expect(result.response.status, JSON.stringify(result.value)).toBe(201);
		const destination = (await listStaff(gateway)).find((staff: any) => staff.currentSessionId === result.value.id);
		const forkPersisted = gateway.sessionManager.getPersistedSession(result.value.id);
		expect(forkPersisted).toMatchObject({
			staffId: destination.id,
			cwd: sourceSessionBefore.cwd,
			borrowsWorktree: true,
			borrowedWorktreeOwnerSessionId: source.currentSessionId,
		});
		expect(forkPersisted.worktreePath).toBeUndefined();
		expect(forkPersisted.branch).toBeUndefined();
		expect(forkPersisted.repoPath).toBeUndefined();
		expect(forkPersisted.repoWorktrees).toBeUndefined();

		const deleted = await deleteStaff(gateway, destination.id);
		expect(deleted.status, await deleted.clone().text()).toBe(200);
		const staffManager = (gateway.sessionManager as any).staffRecordSource;
		expect(staffManager.getStaff(destination.id)).toBeUndefined();
		expect(gateway.sessionManager.getPersistedSession(result.value.id)?.archived).toBe(true);
		expect(staffManager.getStaff(source.id)).toMatchObject({ currentSessionId: source.currentSessionId });
		expect(gateway.sessionManager.getPersistedSession(source.currentSessionId)?.id).toBe(source.currentSessionId);
		expect(gateway.sessionManager.getPersistedSession(source.currentSessionId)?.archived).not.toBe(true);
	});

	test("stages a hidden durable staff identity before publishing its destination session, then commits it atomically", async ({ gateway }) => {
		const source = await createStaff(gateway, { name: "Publication ordering source" });
		seedSessionTranscript(gateway, source.currentSessionId);
		const manager = gateway.sessionManager as any;
		const staffManager = manager.staffRecordSource as any;
		const originalPrepare = staffManager.prepareForkedStaff;
		const originalRegister = staffManager.registerForkedStaff;
		let preparedId = "";
		let preparedSessionId = "";
		let observedDurableSession = false;
		staffManager.prepareForkedStaff = (...args: any[]) => {
			const destination = args[1];
			preparedId = destination.id;
			preparedSessionId = destination.sessionId;
			expect(manager.getPersistedSession(preparedSessionId)).toBeUndefined();
			const candidate = originalPrepare.apply(staffManager, args);
			expect(staffManager.getStaff(preparedId), "pending publication must stay off public staff surfaces").toBeUndefined();
			const context = gateway.projectContextManager.getOrCreate(destination.projectId);
			expect(context.staffStore.getIncludingPending(preparedId)?.forkPublication).toEqual({ version: 1, sessionId: preparedSessionId });
			return candidate;
		};
		staffManager.registerForkedStaff = (...args: any[]) => {
			const destination = args[1];
			const context = gateway.projectContextManager.getOrCreate(destination.projectId);
			observedDurableSession = context.sessionStore.get(destination.session.id)?.staffId === preparedId;
			expect(context.staffStore.getIncludingPending(preparedId)?.forkPublication).toEqual({ version: 1, sessionId: preparedSessionId });
			return originalRegister.apply(staffManager, args);
		};

		let result: { response: Response; value: any };
		try {
			result = await forkSession(gateway, source.currentSessionId, { newWorktree: false });
		} finally {
			staffManager.prepareForkedStaff = originalPrepare;
			staffManager.registerForkedStaff = originalRegister;
		}

		expect(result.response.status, JSON.stringify(result.value)).toBe(201);
		expect(result.value.id).toBe(preparedSessionId);
		expect(observedDurableSession).toBe(true);
		expect(staffManager.getStaff(preparedId)).toMatchObject({
			id: preparedId,
			currentSessionId: preparedSessionId,
			projectId: source.projectId,
		});
		expect(staffManager.getStaff(preparedId)?.forkPublication).toBeUndefined();
		const context = gateway.projectContextManager.getOrCreate(source.projectId);
		const durableStaff = JSON.parse(fs.readFileSync((context.staffStore as any).storeFile, "utf8"))
			.find((staff: any) => staff.id === preparedId);
		expect(durableStaff).toMatchObject({
			id: preparedId,
			currentSessionId: preparedSessionId,
			projectId: source.projectId,
		});
		expect(durableStaff.forkPublication, "successful publication must durably clear the hidden marker").toBeUndefined();
		expect((await listStaff(gateway, source.projectId)).find((staff: any) => staff.id === preparedId))
			.toMatchObject({ currentSessionId: preparedSessionId });
	});

	test("reconciles the durable destination identity after a crash between session and staff commits", async ({ gateway }) => {
		const source = await createStaff(gateway, { name: "Crash reconciliation source" });
		const sourceBefore = structuredClone(await gateway.apiJson(`/api/staff/${source.id}`));
		const manager = gateway.sessionManager as any;
		const staffManager = manager.staffRecordSource as any;
		const projectId = source.projectId as string;
		const context = gateway.projectContextManager.getOrCreate(projectId);
		const destinationStaffId = randomUUID();
		const destinationSessionId = randomUUID();
		const destinationName = `Fork: ${source.name}`;
		const now = Date.now();

		staffManager.prepareForkedStaff(sourceBefore, {
			id: destinationStaffId,
			name: destinationName,
			projectId,
			sessionId: destinationSessionId,
		});
		context.sessionStore.put({
			id: destinationSessionId,
			title: destinationName,
			cwd: source.cwd,
			agentSessionFile: "",
			createdAt: now,
			lastActivity: now,
			projectId,
			staffId: destinationStaffId,
			borrowsWorktree: true,
		});
		await context.sessionStore.flushAsync();
		const staffFile = (context.staffStore as any).storeFile as string;
		const durableCandidate = JSON.parse(fs.readFileSync(staffFile, "utf8"))
			.find((staff: any) => staff.id === destinationStaffId);
		expect(durableCandidate?.forkPublication).toEqual({ version: 1, sessionId: destinationSessionId });
		expect(staffManager.getStaff(destinationStaffId)).toBeUndefined();
		expect((await listStaff(gateway, projectId)).some((staff: any) => staff.id === destinationStaffId)).toBe(false);

		try {
			const reconciled = staffManager.reconcileForkedStaffPublications();
			expect(reconciled).toEqual({ committed: [destinationStaffId], aborted: [] });
			const destination = staffManager.getStaff(destinationStaffId);
			expect(destination).toMatchObject({
				id: destinationStaffId,
				name: destinationName,
				currentSessionId: destinationSessionId,
				projectId,
			});
			expect(destination.forkPublication).toBeUndefined();
			expect(await inbox(gateway, destinationStaffId)).toEqual([]);
			expect(await gateway.apiJson(`/api/staff/${source.id}`)).toEqual(sourceBefore);
		} finally {
			context.staffStore.remove(destinationStaffId);
			context.searchIndex?.removeStaff(destinationStaffId);
			context.sessionStore.remove(destinationSessionId);
			await context.sessionStore.flushAsync();
		}
	});

	test("rolls back a failed launch without changing or deauthorizing the source", async ({ gateway }) => {
		const source = await createStaff(gateway, { name: "Failed launch source" });
		const sourceBefore = structuredClone(await gateway.apiJson(`/api/staff/${source.id}`));
		seedSessionTranscript(gateway, source.currentSessionId);
		const manager = gateway.sessionManager as any;
		const originalCreateSession = manager.createSession;
		let options: any;
		manager.createSession = async (...args: any[]) => {
			options = args[4];
			throw new Error("STAFF_FORK_LAUNCH_FAILURE");
		};
		let result: { response: Response; value: any };
		try {
			result = await forkSession(gateway, source.currentSessionId, { newWorktree: false });
		} finally {
			manager.createSession = originalCreateSession;
		}

		expect(result.response.status).toBe(500);
		expect(result.value.error).toContain("STAFF_FORK_LAUNCH_FAILURE");
		expect(options.staffId, `${FAILURE_MARKER}: even a failed staff fork must reserve a destination-only identity`).not.toBe(source.id);
		expect(gateway.sessionManager.getSession(options.sessionId)).toBeUndefined();
		expect(gateway.sessionManager.getPersistedSession(options.sessionId)).toBeUndefined();
		expect((gateway.sessionManager as any).staffRecordSource.getStaff(options.staffId)).toBeUndefined();
		expect(gateway.projectContextManager.getOrCreate(source.projectId).staffStore.getIncludingPending(options.staffId)).toBeUndefined();
		expect(fs.existsSync(options.preExistingAgentSessionFile)).toBe(false);
		expect(sourceSnapshot(await gateway.apiJson(`/api/staff/${source.id}`))).toEqual(sourceSnapshot(sourceBefore));
		expect(gateway.sessionManager.getPersistedSession(source.currentSessionId)?.staffId).toBe(source.id);
	});

	test("rolls back the launched destination when strict staff persistence fails", async ({ gateway }) => {
		const source = await createStaff(gateway, { name: "Failed staff persistence source" });
		const sourceBefore = structuredClone(await gateway.apiJson(`/api/staff/${source.id}`));
		seedSessionTranscript(gateway, source.currentSessionId);
		const manager = gateway.sessionManager as any;
		const staffManager = manager.staffRecordSource as any;
		const originalCreateSession = manager.createSession;
		const originalRegister = staffManager.registerForkedStaff;
		let options: any;
		manager.createSession = async (...args: any[]) => {
			options = args[4];
			return originalCreateSession.apply(manager, args);
		};
		staffManager.registerForkedStaff = () => {
			throw new Error("STAFF_FORK_PERSISTENCE_FAILURE");
		};
		let result: { response: Response; value: any };
		try {
			result = await forkSession(gateway, source.currentSessionId, { newWorktree: false });
		} finally {
			manager.createSession = originalCreateSession;
			if (originalRegister === undefined) delete staffManager.registerForkedStaff;
			else staffManager.registerForkedStaff = originalRegister;
		}

		expect(result.response.status).toBe(500);
		expect(result.value.error).toContain("STAFF_FORK_PERSISTENCE_FAILURE");
		expect(gateway.sessionManager.getSession(options.sessionId)).toBeUndefined();
		expect(gateway.sessionManager.getPersistedSession(options.sessionId)).toBeUndefined();
		expect((gateway.sessionManager as any).staffRecordSource.getStaff(options.staffId)).toBeUndefined();
		expect(gateway.projectContextManager.getOrCreate(source.projectId).staffStore.getIncludingPending(options.staffId)).toBeUndefined();
		expect(fs.existsSync(options.preExistingAgentSessionFile)).toBe(false);
		expect(sourceSnapshot(await gateway.apiJson(`/api/staff/${source.id}`))).toEqual(sourceSnapshot(sourceBefore));
	});

	test("publishes nothing when the source transcript cannot be cloned", async ({ gateway }) => {
		const source = await createStaff(gateway, { name: "Failed transcript clone source" });
		const sourceBefore = structuredClone(await gateway.apiJson(`/api/staff/${source.id}`));
		const transcript = seedSessionTranscript(gateway, source.currentSessionId);
		const transcriptBefore = fs.readFileSync(transcript, "utf8");
		const staffIdsBefore = new Set((await listStaff(gateway)).map((staff: any) => staff.id));
		const sessionIdsBefore = new Set(gateway.projectContextManager.getAllLiveSessions().map((session: any) => session.id));
		const sourcePersisted = gateway.sessionManager.getPersistedSession(source.currentSessionId);
		const persistedIdsBefore = new Set(gateway.sessionManager.getSessionStore(sourcePersisted.projectId).getAll().map((session: any) => session.id));
		const manager = gateway.sessionManager as any;
		const originalRecoverSessionFile = manager.recoverSessionFile;
		const originalCopyFileSync = fs.copyFileSync;
		const missingTranscript = path.join(gateway.bobbitDir, "state", "session-prompts", `missing-${randomUUID()}.jsonl`);
		let destinationTranscript: string | undefined;
		manager.recoverSessionFile = (persisted: any) => persisted.id === source.currentSessionId
			? missingTranscript
			: originalRecoverSessionFile.call(manager, persisted);
		fs.copyFileSync = ((sourcePath: fs.PathLike, destinationPath: fs.PathLike, mode?: number) => {
			if (String(sourcePath) === missingTranscript) {
				destinationTranscript = String(destinationPath);
				throw new Error("STAFF_FORK_TRANSCRIPT_COPY_FAILURE");
			}
			return originalCopyFileSync(sourcePath, destinationPath, mode);
		}) as typeof fs.copyFileSync;

		let result: { response: Response; value: any };
		try {
			result = await forkSession(gateway, source.currentSessionId, { newWorktree: false });
		} finally {
			manager.recoverSessionFile = originalRecoverSessionFile;
			fs.copyFileSync = originalCopyFileSync;
		}

		expect(result.response.status).toBe(500);
		expect(result.value.error).toContain("STAFF_FORK_TRANSCRIPT_COPY_FAILURE");
		expect(destinationTranscript).toBeTruthy();
		expect(fs.existsSync(destinationTranscript!)).toBe(false);
		expect(new Set((await listStaff(gateway)).map((staff: any) => staff.id))).toEqual(staffIdsBefore);
		expect(new Set(gateway.projectContextManager.getAllLiveSessions().map((session: any) => session.id))).toEqual(sessionIdsBefore);
		expect(new Set(gateway.sessionManager.getSessionStore(sourcePersisted.projectId).getAll().map((session: any) => session.id))).toEqual(persistedIdsBefore);
		expect(sourceSnapshot(await gateway.apiJson(`/api/staff/${source.id}`))).toEqual(sourceSnapshot(sourceBefore));
		expect(gateway.sessionManager.getPersistedSession(source.currentSessionId)?.staffId).toBe(source.id);
		expect(fs.readFileSync(transcript, "utf8")).toBe(transcriptBefore);
	});
});
