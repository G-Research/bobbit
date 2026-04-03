import { randomUUID } from "node:crypto";
import { StaffStore, type PersistedStaff, type StaffState, type StaffTrigger } from "./staff-store.js";
import type { SessionManager } from "./session-manager.js";
import type { ProjectContextManager } from "./project-context-manager.js";
import { createWorktree, cleanupWorktree } from "../skills/git.js";

function sanitiseBranchName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

export class StaffManager {
	private pcm: ProjectContextManager;

	constructor(pcm: ProjectContextManager) {
		this.pcm = pcm;
	}

	private getStore(projectId: string): StaffStore {
		const ctx = this.pcm.getOrCreate(projectId);
		if (ctx) return ctx.staffStore;
		throw new Error(`Cannot resolve staff store: project "${projectId}" not found`);
	}

	private findStoreForStaff(id: string): { store: StaffStore; staff: PersistedStaff; projectId: string } | null {
		for (const ctx of this.pcm.all()) {
			const staff = ctx.staffStore.get(id);
			if (staff) return { store: ctx.staffStore, staff, projectId: ctx.project.id };
		}
		return null;
	}

	async createStaff(
		name: string,
		description: string,
		systemPrompt: string,
		cwd: string,
		sessionManager: SessionManager,
		opts?: { triggers?: StaffTrigger[]; roleId?: string; projectId?: string },
	): Promise<PersistedStaff> {
		const now = Date.now();
		const id = randomUUID();
		const projectId = opts?.projectId;
		if (!projectId) {
			throw new Error("Cannot create staff: projectId is required");
		}

		// Auto-assign UUIDs to triggers missing IDs
		const triggers = (opts?.triggers ?? []).map((t) => ({
			...t,
			id: t.id || randomUUID(),
		}));

		const staff: PersistedStaff = {
			id,
			name,
			description,
			systemPrompt,
			cwd,
			state: "active",
			triggers,
			memory: "",
			roleId: opts?.roleId,
			createdAt: now,
			updatedAt: now,
			projectId,
		};
		// Create a worktree for this staff agent
		const shortId = randomUUID().slice(0, 8);
		const branchName = "staff-" + sanitiseBranchName(name) + "-" + shortId;
		const worktreeResult = await createWorktree(cwd, branchName);
		staff.worktreePath = worktreeResult.worktreePath;
		staff.branch = worktreeResult.branchName;

		const store = this.getStore(projectId);
		store.put(staff);

		const searchIndex = this.pcm.getOrCreate(projectId)?.searchIndex;
		searchIndex?.indexStaff(staff, projectId);

		// Create the permanent session for this staff agent
		try {
			let fullPrompt = staff.systemPrompt;
			if (staff.memory) {
				fullPrompt += "\n\n---\n\n## Pinned Context\n\n" + staff.memory;
			}
			const session = await sessionManager.createSession(worktreeResult.worktreePath, undefined, undefined, undefined, {
				rolePrompt: fullPrompt,
				env: { BOBBIT_STAFF_ID: id },
				sandboxed: sessionManager.isSandboxEnabled,
			});
			session.staffId = id;
			sessionManager.updateSessionMeta(session.id, { worktreePath: worktreeResult.worktreePath });
			await sessionManager.persistSessionMetadata(session);
			store.update(id, { currentSessionId: session.id });
			staff.currentSessionId = session.id;
		} catch (err) {
			// Clean up the orphaned worktree on failure
			try {
				await cleanupWorktree(cwd, worktreeResult.worktreePath, branchName, true);
				console.log(`[staff-manager] Cleaned up orphaned worktree after createStaff failure: ${worktreeResult.worktreePath}`);
			} catch (cleanupErr) {
				console.error(`[staff-manager] Failed to clean up orphaned worktree ${worktreeResult.worktreePath}:`, cleanupErr);
			}
			store.remove(id);
			searchIndex?.removeStaff(id);
			throw err;
		}

		return staff;
	}

	getStaff(id: string): PersistedStaff | undefined {
		return this.findStoreForStaff(id)?.staff;
	}

	listStaff(projectId?: string): PersistedStaff[] {
		if (projectId) {
			const ctx = this.pcm.getOrCreate(projectId);
			return ctx ? ctx.staffStore.getAll() : [];
		}
		const all: PersistedStaff[] = [];
		for (const ctx of this.pcm.all()) {
			all.push(...ctx.staffStore.getAll());
		}
		return all;
	}

	updateStaff(
		id: string,
		updates: {
			name?: string;
			description?: string;
			systemPrompt?: string;
			cwd?: string;
			state?: StaffState;
			triggers?: StaffTrigger[];
			memory?: string;
			roleId?: string;
			currentSessionId?: string;
		},
	): boolean {
		// Auto-assign UUIDs to triggers missing IDs
		if (updates.triggers) {
			updates.triggers = updates.triggers.map((t) => ({
				...t,
				id: t.id || randomUUID(),
			}));
		}
		const found = this.findStoreForStaff(id);
		if (!found) return false;
		const ok = found.store.update(id, updates);
		if (ok) {
			const staff = found.store.get(id);
			if (staff) {
				const searchIndex = this.pcm.getOrCreate(found.projectId)?.searchIndex;
				searchIndex?.indexStaff(staff, found.projectId);
			}
		}
		return ok;
	}

	async deleteStaff(id: string, sessionManager: SessionManager): Promise<boolean> {
		const found = this.findStoreForStaff(id);
		if (!found) return false;
		const { store, staff } = found;

		// Terminate the permanent session if it exists
		if (staff.currentSessionId) {
			try {
				await sessionManager.terminateSession(staff.currentSessionId);
			} catch (err) {
				console.error(`[staff-manager] Failed to terminate session ${staff.currentSessionId} for staff ${id}:`, err);
			}
		}

		// Clean up the worktree if it exists
		if (staff.worktreePath) {
			try {
				await cleanupWorktree(staff.cwd, staff.worktreePath, staff.branch, true);
			} catch (err) {
				console.error(`[staff-manager] Failed to clean up worktree for staff ${id}:`, err);
			}
		}

		store.remove(id);
		const searchIndex = this.pcm.getOrCreate(found.projectId)?.searchIndex;
		searchIndex?.removeStaff(id);
		return true;
	}

	/**
	 * Update a specific trigger's runtime state (lastFired, lastSeenSha).
	 */
	updateTriggerState(
		staffId: string,
		triggerId: string,
		updates: { lastFired?: number; lastSeenSha?: string },
	): boolean {
		const found = this.findStoreForStaff(staffId);
		if (!found) return false;
		const { store, staff } = found;

		const trigger = staff.triggers.find((t) => t.id === triggerId);
		if (!trigger) return false;

		if (updates.lastFired !== undefined) trigger.lastFired = updates.lastFired;
		if (updates.lastSeenSha !== undefined) trigger.lastSeenSha = updates.lastSeenSha;

		store.update(staffId, { triggers: staff.triggers });
		return true;
	}

	/**
	 * Wake a staff agent: enqueue a prompt on its permanent session.
	 * If the session doesn't exist yet (legacy migration), create one first.
	 * If the session subprocess is terminated, restore it before enqueuing.
	 */
	async wake(
		staffId: string,
		prompt: string | undefined,
		sessionManager: SessionManager,
	): Promise<string> {
		const found = this.findStoreForStaff(staffId);
		if (!found) throw new Error("Staff agent not found");
		const { store, staff } = found;
		if (staff.state !== "active") throw new Error(`Staff agent is ${staff.state}, cannot wake`);

		const wakePrompt = prompt || "You have been woken. Review your memory and carry out your mission.";

		// Legacy migration: if no permanent session exists, create one
		if (!staff.currentSessionId) {
			let fullPrompt = staff.systemPrompt;
			if (staff.memory) {
				fullPrompt += "\n\n---\n\n## Pinned Context\n\n" + staff.memory;
			}
			const sessionCwd = staff.worktreePath ?? staff.cwd;
			const session = await sessionManager.createSession(sessionCwd, undefined, undefined, undefined, {
				rolePrompt: fullPrompt,
				env: { BOBBIT_STAFF_ID: staffId },
				sandboxed: sessionManager.isSandboxEnabled,
			});
			session.staffId = staffId;
			await sessionManager.persistSessionMetadata(session);
			store.update(staffId, { currentSessionId: session.id, lastWakeAt: Date.now() });

			await sessionManager.enqueuePrompt(session.id, wakePrompt);
			console.log(`[staff-manager] Woke staff "${staff.name}" (${staffId}) → session ${session.id} (legacy migration)`);
			return session.id;
		}

		// Ensure the session subprocess is alive (restore if terminated)
		const session = sessionManager.getSession(staff.currentSessionId);
		if (!session || session.status === "terminated") {
			try {
				await sessionManager.ensureSessionAlive(staff.currentSessionId);
			} catch {
				// Session was deleted — clear and recreate
				console.log(`[staff-manager] Session ${staff.currentSessionId} unrecoverable, creating new one for "${staff.name}"`);
				store.update(staffId, { currentSessionId: undefined as any });
				staff.currentSessionId = undefined as any;
				return this.wake(staffId, prompt, sessionManager);
			}
		}

		// Enqueue the wake prompt on the existing session
		await sessionManager.enqueuePrompt(staff.currentSessionId, wakePrompt);

		// Update last wake time
		store.update(staffId, { lastWakeAt: Date.now() });

		console.log(`[staff-manager] Woke staff "${staff.name}" (${staffId}) → session ${staff.currentSessionId}`);
		return staff.currentSessionId;
	}
}
