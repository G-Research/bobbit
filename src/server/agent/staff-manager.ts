import { randomUUID } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { StaffStore, normalizeStaffAccessory, type PersistedStaff, type StaffState, type StaffTrigger } from "./staff-store.js";
import { buildStaffSystemPrompt } from "./role-prompt.js";
import type { SessionManager } from "./session-manager.js";
import type { ProjectContextManager } from "./project-context-manager.js";
import type { InboxManager } from "./inbox-manager.js";
import { SYSTEM_PROJECT_ID } from "./project-registry.js";
import type { Component } from "./project-config-store.js";
import { createWorktree, createWorktreeSet, cleanupWorktree, resolveBaseRef } from "../skills/git.js";
import { runComponentSetups } from "../skills/worktree-setup.js";
import { execShellCommand } from "./shell-util.js";
import { shouldCreateWorktree } from "./worktree-decision.js";
import { resolveWorktreeSupport } from "./worktree-support.js";

const execFile = promisify(execFileCb);

function sanitiseBranchName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function offsetCwd(repoPath: string | undefined, cwd: string, worktreePath: string): string {
	if (!repoPath) return worktreePath;
	const relativeOffset = path.relative(repoPath, cwd);
	if (!relativeOffset || relativeOffset === "." || relativeOffset.startsWith("..") || path.isAbsolute(relativeOffset)) {
		return worktreePath;
	}
	return path.join(worktreePath, relativeOffset);
}

interface StaffWorktreePlan {
	branchName?: string;
	repoPath?: string;
	worktreePath?: string;
	repoWorktrees?: Record<string, string>;
	sessionCwd: string;
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
	 * Validate a triggers array before persistence.
	 *
	 * - Goal lifecycle triggers (`goal_created`, `goal_archived`) MUST carry a
	 *   non-empty trimmed `prompt`. The push-based dispatcher passes the prompt
	 *   straight through to the inbox entry with no fallback, so an empty prompt
	 *   would produce a useless wake.
	 * - Other trigger types are unchecked here (existing behaviour: optional
	 *   prompt with the engine synthesising one if missing).
	 *
	 * Throws a plain `Error` on failure so callers (REST routes) can surface
	 * the message via `jsonError(400, err)`. Safe to call with `undefined`
	 * (skipped) so PUT routes can pass `body.triggers` directly.
	 */
	validateTriggers(triggers: StaffTrigger[] | undefined): void {
		if (!triggers) return;
		if (!Array.isArray(triggers)) {
			throw new Error("triggers must be an array");
		}
		for (const t of triggers) {
			if (t && (t.type === "goal_created" || t.type === "goal_archived")) {
				if (typeof t.prompt !== "string" || t.prompt.trim().length === 0) {
					throw new Error(`Trigger of type ${t.type} requires a non-empty prompt`);
				}
			}
		}
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
	 * Project changes intentionally drop runtime metadata from the previous
	 * project. The next staff wake creates a fresh session rooted at the target
	 * project instead of continuing from the old cwd/worktree.
	 */
	async reassignProject(staffId: string, newProjectId: string, sessionManager?: SessionManager): Promise<PersistedStaff | null> {
		const found = this.findStoreForStaff(staffId);
		if (!found) return null;
		const newCtx = this.pcm.getOrCreate(newProjectId);
		if (!newCtx) throw new Error(`Cannot re-assign staff: project "${newProjectId}" not found`);
		if (newCtx.project.hidden || newCtx.project.id === SYSTEM_PROJECT_ID) {
			throw new Error("Cannot re-assign staff to a hidden or system project");
		}
		if (found.projectId === newProjectId && found.staff.projectId === newProjectId) {
			return found.staff;
		}

		const oldSessionId = found.staff.currentSessionId;
		if (oldSessionId && sessionManager) {
			try {
				const terminated = await sessionManager.terminateSession(oldSessionId);
				if (!terminated) await sessionManager.storeArchive(oldSessionId);
			} catch (err) {
				console.warn(`[staff-manager] Failed to terminate old session ${oldSessionId} while re-assigning staff ${staffId}:`, err);
				try { await sessionManager.storeArchive(oldSessionId); } catch { /* best-effort */ }
			}
		}

		// Pull from old search index, drop from old store.
		const oldCtx = this.pcm.getOrCreate(found.projectId);
		oldCtx?.searchIndex?.removeStaff(staffId);
		found.store.remove(staffId);

		// Re-home: clone with updated projectId/cwd, but do not carry runtime
		// metadata from the previous project's cwd/worktree/session.
		const {
			worktreePath: _worktreePath,
			branch: _branch,
			repoPath: _repoPath,
			repoWorktrees: _repoWorktrees,
			currentSessionId: _currentSessionId,
			...rest
		} = found.staff;
		const moved: PersistedStaff = {
			...rest,
			cwd: newCtx.project.rootPath,
			projectId: newProjectId,
			updatedAt: Date.now(),
		};
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

	private async projectSupportsWorktree(projectId: string, cwd: string): Promise<{ supported: boolean; repoPath?: string; multiRepo: boolean; components: Component[] }> {
		const ctx = this.pcm.getOrCreate(projectId);
		if (!ctx) return { supported: false, multiRepo: false, components: [] };
		const components = ctx.projectConfigStore.getComponents();
		// Single source of truth shared with the session path (server.ts) and the
		// goal path (goal-manager.ts). A poly-repo (non-git container + git
		// sub-repos) resolves `supported:true`, `repoPath = projectRoot`,
		// `multiRepo:true` — identical to a regular session. A project with no
		// worktree-able git repo resolves `supported:false` (graceful no-worktree).
		const support = await resolveWorktreeSupport(components, ctx.project.rootPath, cwd);
		return { ...support, components };
	}

	private async provisionStaffWorktree(projectId: string, name: string, id: string, cwd: string, worktree?: boolean): Promise<StaffWorktreePlan> {
		if (worktree === false) return { sessionCwd: cwd };

		const support = await this.projectSupportsWorktree(projectId, cwd);
		if (!shouldCreateWorktree({ worktree }, support.supported) || !support.repoPath) {
			return { sessionCwd: cwd };
		}

		const ctx = this.pcm.getOrCreate(projectId);
		if (!ctx) throw new Error(`Cannot create staff worktree: project "${projectId}" not found`);
		const shortId = id.slice(0, 8);
		const safeName = sanitiseBranchName(name) || "agent";
		let branchName = "staff-" + safeName + "-" + shortId;
		const configuredBaseRef = ctx.projectConfigStore.get("base_ref") || undefined;
		const worktreeRoot = ctx.projectConfigStore.get("worktree_root") || undefined;
		let worktreePath: string;
		let repoWorktrees: Record<string, string> | undefined;

		if (support.multiRepo) {
			const set = await createWorktreeSet(support.repoPath, support.components, branchName, undefined, { worktreeRoot, configuredBaseRef });
			// createWorktreeSet skips a non-git `.` container entry; if NO git
			// sub-repo remained it returns an empty set (no container created).
			// Fall back to no-worktree (session cwd unchanged) rather than pointing
			// at a non-existent container.
			if (set.worktrees.length === 0) return { sessionCwd: cwd };
			worktreePath = set.container;
			repoWorktrees = Object.fromEntries(set.worktrees.map(w => [w.repo, w.worktreePath]));
		} else {
			const worktreeResult = await createWorktree(support.repoPath, branchName, { configuredBaseRef, worktreeRoot });
			worktreePath = worktreeResult.worktreePath;
			branchName = worktreeResult.branchName;
		}

		if (support.components.length > 0) {
			try {
				await runComponentSetups({
					components: support.components,
					branchContainer: worktreePath,
					primaryWorktreeRoot: support.repoPath,
					exec: async (cmd, setupCwd, env) => {
						await execShellCommand(cmd, { cwd: setupCwd, env, timeout: 120_000 });
					},
				});
			} catch (err) {
				console.warn(`[staff-manager] runComponentSetups failed while creating staff worktree for ${id} (non-fatal):`, err);
			}
		}

		return {
			branchName,
			repoPath: support.repoPath,
			worktreePath,
			repoWorktrees,
			sessionCwd: offsetCwd(support.repoPath, cwd, worktreePath),
		};
	}

	private staffSessionCwd(staff: PersistedStaff, projectId: string): string {
		if (!staff.worktreePath) return staff.cwd;
		const ctx = this.pcm.getOrCreate(projectId);
		const repoPath = staff.repoPath ?? ctx?.project.rootPath;
		return offsetCwd(repoPath, staff.cwd, staff.worktreePath);
	}

	private staffWorktreeEntries(staff: PersistedStaff, projectId?: string): Array<{ repo: string; repoPath: string; worktreePath: string }> {
		if (!staff.worktreePath) return [];
		const ctx = projectId ? this.pcm.getOrCreate(projectId) : undefined;
		const repoPath = staff.repoPath ?? ctx?.project.rootPath ?? staff.cwd;
		if (staff.repoWorktrees && Object.keys(staff.repoWorktrees).length > 0) {
			return Object.entries(staff.repoWorktrees).map(([repo, worktreePath]) => ({
				repo,
				repoPath: repo === "." ? repoPath : path.join(repoPath, repo),
				worktreePath,
			}));
		}
		return [{ repo: ".", repoPath, worktreePath: staff.worktreePath }];
	}

	private staffSessionWorktreeMeta(staff: PersistedStaff, projectId?: string): { worktreePath: string; branch?: string; repoPath?: string; repoWorktrees?: Record<string, string> } | undefined {
		if (!staff.worktreePath) return undefined;
		const ctx = projectId ? this.pcm.getOrCreate(projectId) : undefined;
		const repoPath = staff.repoPath ?? ctx?.project.rootPath;
		return {
			worktreePath: staff.worktreePath,
			...(staff.branch ? { branch: staff.branch } : {}),
			...(repoPath ? { repoPath } : {}),
			...(staff.repoWorktrees ? { repoWorktrees: staff.repoWorktrees } : {}),
		};
	}

	private async cleanupStaffWorktree(staff: PersistedStaff, projectId?: string): Promise<void> {
		const entries = this.staffWorktreeEntries(staff, projectId);
		if (entries.length === 0) return;
		const results = await Promise.allSettled(entries.map(entry => cleanupWorktree(entry.repoPath, entry.worktreePath, staff.branch, true)));
		for (const result of results) {
			if (result.status === "rejected") {
				console.error(`[staff-manager] Failed to clean up one worktree for staff ${staff.id}:`, result.reason);
			}
		}
		if (staff.repoWorktrees && staff.worktreePath) {
			try { fs.rmSync(staff.worktreePath, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	}

	async createStaff(
		name: string,
		description: string,
		systemPrompt: string,
		cwd: string,
		sessionManager: SessionManager,
		opts?: { triggers?: StaffTrigger[]; roleId?: string; projectId?: string; sandboxed?: boolean; worktree?: boolean; accessory?: string },
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

		// When the caller didn't supply a usable accessory (absent/empty/"none")
		// but selected a role, default the persisted accessory to the role's
		// accessory. This mirrors the edit-UI pre-fill so API- and proposal-created
		// role staff also inherit the role's accessory. An explicit accessory wins.
		let effectiveAccessory = opts?.accessory;
		if ((!effectiveAccessory || effectiveAccessory === "none") && opts?.roleId) {
			const role = sessionManager.getRoleManager?.()?.getRole(opts.roleId);
			if (role?.accessory && role.accessory !== "none") effectiveAccessory = role.accessory;
		}

		const staff: PersistedStaff = {
			id,
			name,
			description,
			systemPrompt,
			// Persist the selected project cwd. Worktree-backed staff launch at the
			// matching offset inside their worktree, but this remains the anchor for
			// project scoping and cleanup.
			cwd,
			state: "active",
			triggers,
			memory: "",
			roleId: opts?.roleId,
			accessory: normalizeStaffAccessory(effectiveAccessory),
			createdAt: now,
			updatedAt: now,
			projectId,
			// Per-staff sandbox preference: persisted at creation and used
			// directly on every spawn/wake. The project's sandbox config is
			// NEVER consulted anywhere in the staff path.
			sandboxed: opts?.sandboxed ?? false,
		};

		const worktreePlan = await this.provisionStaffWorktree(projectId, name, id, cwd, opts?.worktree);
		if (worktreePlan.worktreePath && worktreePlan.branchName) {
			staff.worktreePath = worktreePlan.worktreePath;
			staff.branch = worktreePlan.branchName;
			if (worktreePlan.repoPath) staff.repoPath = worktreePlan.repoPath;
			if (worktreePlan.repoWorktrees) staff.repoWorktrees = worktreePlan.repoWorktrees;
		}

		const store = this.getStore(projectId);
		store.put(staff);

		const searchIndex = this.pcm.getOrCreate(projectId)?.searchIndex;
		searchIndex?.indexStaff(staff, projectId);

		// Create the permanent session for this staff agent
		try {
			// Prepend the role's prompt context (when roleId set) ahead of the
			// staff's own systemPrompt + pinned memory. roleManager comes from the
			// session manager so the staff path reuses the regular-session resolver.
			const fullPrompt = buildStaffSystemPrompt(staff, sessionManager.getRoleManager?.());
			// Per-staff sandbox preference: read straight from the persisted
			// record. The project-level setting is NEVER consulted here.
			const effectiveSandboxed = staff.sandboxed;
			// Lazy per-project sandbox init — surfaces bootstrap errors up-front
			// instead of mid-session-spawn. Idempotent; safe if already initialised.
			if (effectiveSandboxed) {
				const sm = sessionManager.getSandboxManager?.();
				if (sm) await sm.ensureForProject(projectId);
			}
			const session = await sessionManager.createSession(worktreePlan.sessionCwd, undefined, undefined, undefined, {
				rolePrompt: fullPrompt,
				// Pass roleName so session-setup can apply role-keyed model/thinking-level
				// overrides at spawn time. Without this, `plan.role ?? plan.roleName` falls
				// through to undefined and the resolvers return defaults — staff roles with
				// `model`/`thinkingLevel` overrides would be silently ignored.
				roleName: staff.roleId,
				accessory: staff.accessory,
				env: { BOBBIT_STAFF_ID: id },
				// Persisted so inbox tools survive respawn — see
				// `tests/staff-session-staffid-persistence.test.ts`. Threads staffId
				// through opts → plan → persistOnce so it lands in PersistedSession.
				// Without this, on respawn `restoreSession` reads `ps.staffId =
				// undefined` → no `BOBBIT_STAFF_ID` env → inbox tools refuse to
				// register (see `defaults/tools/inbox/extension.ts`).
				staffId: id,
				sandboxed: effectiveSandboxed,
				sandboxBranch: effectiveSandboxed ? staff.branch : undefined,
				projectId,
			});
			// Belt-and-braces in-memory sync. `createSession` already propagates
			// `staffId` to the persisted record via the plan, but the live
			// `SessionInfo` object is built inside `executePlan` and doesn't
			// currently mirror the field back — keep this assignment until the
			// next refactor wires it through `SessionInfo` directly.
			session.staffId = id;
			sessionManager.setTitle(session.id, staff.name);
			const worktreeMeta = this.staffSessionWorktreeMeta(staff, projectId);
			if (worktreeMeta) sessionManager.updateSessionMeta(session.id, worktreeMeta);
			await sessionManager.persistSessionMetadata(session);
			store.update(id, { currentSessionId: session.id });
			staff.currentSessionId = session.id;
		} catch (err) {
			// Clean up the orphaned worktree on failure
			try {
				await this.cleanupStaffWorktree(staff, projectId);
				if (staff.worktreePath) console.log(`[staff-manager] Cleaned up orphaned worktree after createStaff failure: ${staff.worktreePath}`);
			} catch (cleanupErr) {
				console.error(`[staff-manager] Failed to clean up orphaned worktree ${staff.worktreePath}:`, cleanupErr);
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
			accessory?: string;
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
				await this.cleanupStaffWorktree(staff, found.projectId);
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
		// Sandboxed staff refresh inside the container; host-side worktree refresh is skipped.
		if (staff.sandboxed) return;

		const ctx = this.pcm.getOrCreate(projectId);
		const configuredBaseRef = ctx?.projectConfigStore.get("base_ref") || undefined;
		const entries = this.staffWorktreeEntries(staff, projectId);
		for (const entry of entries) {
			const wt = entry.worktreePath;
			try {
				await execFile("git", ["fetch", "origin"], { cwd: wt, timeout: 60_000 });
			} catch (err) {
				console.warn(`[staff-manager] git fetch failed in ${wt} (non-fatal):`, err);
				continue; // Can't rebase this repo without fetch
			}

			try {
				// Resolve the rebase target via the centralised `resolveBaseRef` helper.
				// When the project has a configured `base_ref`, that's the integration
				// target we rebase onto; otherwise we fall back to today's behaviour
				// (`git symbolic-ref refs/remotes/origin/HEAD`). The helper returns the
				// full ref including any `origin/` prefix, so we use it directly.
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
					branchContainer: staff.worktreePath,
					primaryWorktreeRoot: staff.repoPath ?? ctx?.project.rootPath ?? staff.cwd,
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
			const fullPrompt = buildStaffSystemPrompt(staff, sessionManager.getRoleManager?.());
			const sessionCwd = this.staffSessionCwd(staff, found.projectId);
			const session = await sessionManager.createSession(sessionCwd, undefined, undefined, undefined, {
				rolePrompt: fullPrompt,
				roleName: staff.roleId,
				accessory: staff.accessory,
				env: { BOBBIT_STAFF_ID: staffId },
				// Persisted so inbox tools survive respawn — see
				// `tests/staff-session-staffid-persistence.test.ts`. Same contract as
				// `createStaff` above.
				staffId,
				sandboxed: staff.sandboxed,
				sandboxBranch: staff.sandboxed ? staff.branch : undefined,
				projectId: found.projectId,
			});
			session.staffId = staffId;
			sessionManager.setTitle(session.id, staff.name);
			const worktreeMeta = this.staffSessionWorktreeMeta(staff, found.projectId);
			if (worktreeMeta) sessionManager.updateSessionMeta(session.id, worktreeMeta);
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

		sessionManager.updateSessionMeta(staff.currentSessionId, { accessory: staff.accessory });
		await this.refreshWorktree(staff, found.projectId);

		return staff.currentSessionId;
	}
}
