import { randomUUID } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { StaffStore, type PersistedStaff, type StaffState, type StaffTrigger } from "./staff-store.js";
import type { SessionManager } from "./session-manager.js";
import type { ProjectContextManager } from "./project-context-manager.js";
import type { InboxManager } from "./inbox-manager.js";
import { SYSTEM_PROJECT_ID } from "./project-registry.js";
import { createWorktree, cleanupWorktree, resolveBaseRef } from "../skills/git.js";
import { runComponentSetups } from "../skills/worktree-setup.js";
import { execShellCommand } from "./shell-util.js";

const execFile = promisify(execFileCb);

function sanitiseBranchName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

export class StaffManager {
	private pcm: ProjectContextManager;
	private inboxManager: InboxManager | null = null;

	constructor(pcm: ProjectContextManager) {
		this.pcm = pcm;
		this.logOrphansOnce();
	}

	/**
	 * Late-bound inbox manager wiring — set from `server.ts` boot after both
	 * `StaffManager` and `InboxManager` are constructed. Used solely by
	 * `deleteStaff` to wipe the per-staff inbox file. The nudger never
	 * touches `StaffManager.inboxManager`; it has its own direct binding.
	 */
	setInboxManager(inboxManager: InboxManager): void {
		this.inboxManager = inboxManager;
	}

	/**
	 * Log any orphaned staff (missing projectId or persisted under the synthetic
	 * system project) one time during construction. This surfaces legacy records
	 * that won't render under any real project's Sessions bucket until the user
	 * re-homes them via the orphan banner.
	 */
	private logOrphansOnce(): void {
		try {
			for (const s of this.listOrphaned()) {
				console.log(`[staff-manager] orphaned staff: id=${s.id} name=${s.name}${s.projectId ? ` (projectId=${s.projectId})` : " (no projectId)"}`);
			}
		} catch (err) {
			console.warn("[staff-manager] orphan scan failed:", err);
		}
	}

	/**
	 * Return staff records that are not anchored to a real project: either
	 * missing `projectId` outright, or persisted under the synthetic system
	 * project. The sidebar surfaces these in an orphan banner with a one-click
	 * re-assignment flow.
	 */
	listOrphaned(): PersistedStaff[] {
		const orphans: PersistedStaff[] = [];
		for (const ctx of this.pcm.all()) {
			for (const staff of ctx.staffStore.getAll()) {
				if (!staff.projectId || staff.projectId === SYSTEM_PROJECT_ID || ctx.project.id === SYSTEM_PROJECT_ID) {
					orphans.push(staff);
				}
			}
		}
		return orphans;
	}

	/**
	 * Re-home a staff record to a different project. Moves the persisted record
	 * between per-project stores, updates `staff.projectId`, and re-indexes
	 * search under the new project. Used by the orphan banner's "Assign to
	 * project…" flow.
	 *
	 * Note: worktree path and branch are preserved as-is — those live on disk
	 * under the original project's worktree root. Refreshing the worktree on
	 * the next wake will rebase against whatever primary branch is canonical
	 * for the new project.
	 */
	reassignProject(staffId: string, newProjectId: string): PersistedStaff | null {
		const found = this.findStoreForStaff(staffId);
		if (!found) return null;
		if (found.projectId === newProjectId && found.staff.projectId === newProjectId) {
			return found.staff;
		}
		const newCtx = this.pcm.getOrCreate(newProjectId);
		if (!newCtx) throw new Error(`Cannot re-assign staff: project "${newProjectId}" not found`);

		// Pull from old search index, drop from old store.
		const oldCtx = this.pcm.getOrCreate(found.projectId);
		oldCtx?.searchIndex?.removeStaff(staffId);
		found.store.remove(staffId);

		// Re-home: clone with updated projectId and put into the new project's store.
		const moved: PersistedStaff = { ...found.staff, projectId: newProjectId, updatedAt: Date.now() };
		newCtx.staffStore.put(moved);
		newCtx.searchIndex?.indexStaff(moved, newProjectId);
		return moved;
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
		opts?: { triggers?: StaffTrigger[]; roleId?: string; projectId?: string; sandboxed?: boolean },
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
			// Per-staff sandbox preference: persisted at creation and used
			// directly on every spawn/wake. The project's sandbox config is
			// NEVER consulted anywhere in the staff path.
			sandboxed: opts?.sandboxed ?? false,
		};
		// Create a worktree for this staff agent
		const shortId = randomUUID().slice(0, 8);
		const branchName = "staff-" + sanitiseBranchName(name) + "-" + shortId;
		// Thread the project's configured `base_ref` so the staff worktree branches
		// from the configured integration target and tracks it as upstream. See
		// docs/design/base-ref.md.
		const projectCtx = this.pcm.getOrCreate(projectId);
		const configuredBaseRef = projectCtx?.projectConfigStore.get("base_ref") || undefined;
		const worktreeResult = await createWorktree(cwd, branchName, { configuredBaseRef });
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
			// Per-staff sandbox preference: read straight from the persisted
			// record. The project-level setting is NEVER consulted here.
			const effectiveSandboxed = staff.sandboxed;
			// Lazy per-project sandbox init — surfaces bootstrap errors up-front
			// instead of mid-session-spawn. Idempotent; safe if already initialised.
			if (effectiveSandboxed) {
				const sm = sessionManager.getSandboxManager?.();
				if (sm) await sm.ensureForProject(projectId);
			}
			const session = await sessionManager.createSession(worktreeResult.worktreePath, undefined, undefined, undefined, {
				rolePrompt: fullPrompt,
				// Pass roleName so session-setup can apply role-keyed model/thinking-level
				// overrides at spawn time. Without this, `plan.role ?? plan.roleName` falls
				// through to undefined and the resolvers return defaults — staff roles with
				// `model`/`thinkingLevel` overrides would be silently ignored.
				roleName: staff.roleId,
				env: { BOBBIT_STAFF_ID: id },
				sandboxed: effectiveSandboxed,
				sandboxBranch: effectiveSandboxed ? branchName : undefined,
				projectId,
			});
			session.staffId = id;
			sessionManager.setTitle(session.id, staff.name);
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
			contextPolicy?: "preserve" | "compact";
			/** Updated by `InboxNudger.applyPolicyThenNudge`; no longer mutated by `StaffManager`. */
			lastWakeAt?: number;
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

		// Wipe the per-staff inbox file. No-op if the inbox manager isn't wired
		// (test paths that construct StaffManager directly without server.ts).
		try {
			this.inboxManager?.removeAll(id);
		} catch (err) {
			console.error(`[staff-manager] inbox removeAll failed for staff ${id}:`, err);
		}
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
	 * Refresh a staff agent's worktree: rebase onto the primary branch and
	 * re-run the project's worktree setup command (e.g. npm ci).
	 * Non-fatal — logs warnings on failure so the agent can still operate.
	 */
	private async refreshWorktree(staff: PersistedStaff, projectId: string): Promise<void> {
		if (!staff.worktreePath) return;

		// Skip refresh for sandboxed staff — their worktree lives inside the container
		const ctx = this.pcm.getOrCreate(projectId);
		if (ctx?.projectConfigStore.get("sandbox") === "docker") return;

		const wt = staff.worktreePath;
		try {
			await execFile("git", ["fetch", "origin"], { cwd: wt, timeout: 60_000 });
		} catch (err) {
			console.warn(`[staff-manager] git fetch failed in ${wt} (non-fatal):`, err);
			return; // Can't rebase without fetch
		}

		try {
			// Resolve the rebase target via the centralised `resolveBaseRef` helper.
			// When the project has a configured `base_ref`, that's the integration
			// target we rebase onto; otherwise we fall back to today's behaviour
			// (`git symbolic-ref refs/remotes/origin/HEAD`). The helper returns the
			// full ref including any `origin/` prefix, so we use it directly.
			const configuredBaseRef = ctx?.projectConfigStore.get("base_ref") || undefined;
			const { ref: rebaseTarget } = await resolveBaseRef(wt, configuredBaseRef);
			if (!rebaseTarget || rebaseTarget === "HEAD" || rebaseTarget.startsWith("-")) {
				console.warn(`[staff-manager] Could not resolve rebase target in ${wt} (got "${rebaseTarget}"), skipping rebase`);
			} else {
				// `resolveBaseRef` returns `origin/<branch>` for remote bases and the
				// bare branch name for local bases. For staff rebase we want to track
				// the remote tip when configured remotely; for local bases we rebase
				// against the local branch directly.
				await execFile("git", ["rebase", rebaseTarget], { cwd: wt, timeout: 60_000 });
			}
		} catch (err) {
			console.warn(`[staff-manager] git rebase failed in ${wt} (non-fatal):`, err);
			// Abort any in-progress rebase to leave worktree in a usable state
			try { await execFile("git", ["rebase", "--abort"], { cwd: wt }); } catch { /* ignore */ }
		}

		// Run per-component worktree setup commands (e.g. npm ci). The canonical
		// source of truth is `components[*].worktreeSetupCommand`; we no longer
		// read the legacy top-level `worktree_setup_command` key (that was
		// migrated onto the default component on first boot).
		const components = ctx?.projectConfigStore.getComponents() ?? [];
		if (components.some(c => c.worktreeSetupCommand)) {
			try {
				await runComponentSetups({
					components,
					branchContainer: wt,
					primaryWorktreeRoot: staff.cwd,
					exec: async (cmd, cwd, env) => {
						await execShellCommand(cmd, { cwd, env, timeout: 120_000 });
					},
				});
			} catch (err) {
				console.warn(`[staff-manager] runComponentSetups failed for ${staff.id} (non-fatal):`, err);
			}
		}
	}

	/**
	 * Ensure the staff agent has a live, ready-to-use session, returning its id.
	 *
	 * Three branches:
	 *   1. **Legacy migration** — `currentSessionId` is missing. Create a fresh
	 *      permanent session with the staff's system prompt + pinned memory.
	 *   2. **Subprocess recovery** — the session exists but its agent CLI has
	 *      exited (status `terminated`). Restore it via `ensureSessionAlive`;
	 *      if that fails the session record itself is gone, clear
	 *      `currentSessionId` and recurse into the legacy-migration branch.
	 *   3. **Healthy** — session is live. Just refresh the worktree (rebase +
	 *      deps) so the agent runs on the current primary branch.
	 *
	 * Sandbox init (`sandboxManager.ensureForProject`) and `refreshWorktree`
	 * always run before returning so the session is ready to receive prompts.
	 * Throws if the staff isn't `active`.
	 *
	 * Replaces the deleted public `wake()` method — the inbox nudger now
	 * decides *when* to wake; this helper handles the *how*.
	 */
	async ensureSessionForStaff(staffId: string, sessionManager: SessionManager): Promise<string> {
		const found = this.findStoreForStaff(staffId);
		if (!found) throw new Error("Staff agent not found");
		const { store, staff } = found;
		if (staff.state !== "active") throw new Error(`Staff agent is ${staff.state}, cannot ensure session`);

		// Branch 1: legacy migration — no permanent session yet, create one
		if (!staff.currentSessionId) {
			let fullPrompt = staff.systemPrompt;
			if (staff.memory) {
				fullPrompt += "\n\n---\n\n## Pinned Context\n\n" + staff.memory;
			}
			const sessionCwd = staff.worktreePath ?? staff.cwd;
			const session = await sessionManager.createSession(sessionCwd, undefined, undefined, undefined, {
				rolePrompt: fullPrompt,
				roleName: staff.roleId,
				env: { BOBBIT_STAFF_ID: staffId },
				sandboxed: staff.sandboxed,
				sandboxBranch: staff.sandboxed ? staff.branch : undefined,
				projectId: found.projectId,
			});
			session.staffId = staffId;
			sessionManager.setTitle(session.id, staff.name);
			await sessionManager.persistSessionMetadata(session);
			store.update(staffId, { currentSessionId: session.id });
			staff.currentSessionId = session.id;
			console.log(`[staff-manager] Created permanent session for staff "${staff.name}" (${staffId}) → ${session.id} (legacy migration)`);
			return session.id;
		}

		// Branch 2: subprocess recovery
		const session = sessionManager.getSession(staff.currentSessionId);
		if (!session || session.status === "terminated") {
			try {
				await sessionManager.ensureSessionAlive(staff.currentSessionId);
			} catch {
				console.log(`[staff-manager] Session ${staff.currentSessionId} unrecoverable, creating new one for "${staff.name}"`);
				store.update(staffId, { currentSessionId: undefined as any });
				staff.currentSessionId = undefined as any;
				return this.ensureSessionForStaff(staffId, sessionManager);
			}
		}

		// Branch 3: healthy — lazy per-project sandbox init + worktree refresh
		if (staff.sandboxed) {
			const sm = sessionManager.getSandboxManager?.();
			if (sm) {
				try {
					await sm.ensureForProject(found.projectId);
				} catch (err) {
					console.error(`[staff-manager] Sandbox ensure failed for project ${found.projectId}:`, err);
					throw err;
				}
			}
		}

		await this.refreshWorktree(staff, found.projectId);

		return staff.currentSessionId;
	}
}
