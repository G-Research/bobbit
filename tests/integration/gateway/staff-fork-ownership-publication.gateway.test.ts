import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { test, expect } from "../../../tests2/integration/_e2e/in-process-harness.js";
import { registerProject } from "../../../tests2/integration/_e2e/e2e-setup.js";
import { copyGitTemplate } from "../../../tests2/harness/git-template.js";
import { seedSessionTranscript } from "../../../tests2/integration/helpers/session-fixtures.js";
import {
	createStaff,
	deleteStaff,
	forkSession,
	installStaffForkCleanup,
	listStaff,
	sourceSnapshot,
} from "./_helpers/staff-fork-fixtures.js";

test.describe.serial("staff session fork ownership and publication failures", () => {
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

	test("new-worktree mode gives source and destination disjoint durable ownership", async ({ gateway }) => {
		const root = path.join(gateway.bobbitDir, `staff-fork-worktree-${randomUUID()}`);
		copyGitTemplate(root);
		const project = await registerProject({
			name: `staff-fork-worktree-${randomUUID()}`,
			rootPath: root,
			seedWorkflows: false,
		});
		let source: any;
		let destination: any;
		try {
			source = await createStaff(gateway, {
				name: "Owned worktree source",
				projectId: project.id,
				cwd: root,
				worktree: true,
			});
			seedSessionTranscript(gateway, source.currentSessionId);
			const result = await forkSession(gateway, source.currentSessionId, { newWorktree: true });
			expect(result.response.status, JSON.stringify(result.value)).toBe(201);
			destination = (await listStaff(gateway, project.id)).find((staff: any) => staff.currentSessionId === result.value.id);
			const sourcePersisted = gateway.sessionManager.getPersistedSession(source.currentSessionId);
			const destinationPersisted = gateway.sessionManager.getPersistedSession(result.value.id);

			expect(destinationPersisted.staffId).toBe(destination.id);
			expect(destinationPersisted.borrowsWorktree).not.toBe(true);
			expect(destinationPersisted.worktreePath).toBeTruthy();
			expect(destinationPersisted.branch).toMatch(/^session\//);
			expect(destinationPersisted.worktreePath).not.toBe(sourcePersisted.worktreePath);
			expect(destinationPersisted.branch).not.toBe(sourcePersisted.branch);
			expect(fs.existsSync(destinationPersisted.worktreePath)).toBe(true);
			expect(fs.existsSync(sourcePersisted.worktreePath)).toBe(true);

			const destinationWorktree = destinationPersisted.worktreePath;
			const sourceWorktree = sourcePersisted.worktreePath;
			expect((await deleteStaff(gateway, destination.id)).status).toBe(200);
			destination = undefined;
			expect(fs.existsSync(destinationWorktree)).toBe(false);
			expect(fs.existsSync(sourceWorktree)).toBe(true);
			expect((gateway.sessionManager as any).staffRecordSource.getStaff(source.id)).toBeTruthy();
		} finally {
			if (destination?.id) await deleteStaff(gateway, destination.id).catch(() => undefined);
			if (source?.id) await deleteStaff(gateway, source.id).catch(() => undefined);
			await gateway.api(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => undefined);
			fs.rmSync(root, { recursive: true, force: true });
		}
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


});
