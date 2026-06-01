import { randomUUID } from "node:crypto";
import path from "node:path";
import { GoalStore, type GoalState, type PersistedGoal } from "./goal-store.js";
import { createWorktree, createWorktreeSet, isGitRepo, getRepoRoot } from "../skills/git.js";
import { resolveWorktreeSupport } from "./worktree-support.js";
import type { WorkflowStore, Workflow } from "./workflow-store.js";
import type { WorktreePool } from "./worktree-pool.js";
import type { Component } from "./project-config-store.js";

/**
 * Sanitize a goal title into a valid git branch name.
 * Lowercase, replace non-alphanumeric with hyphens, truncate, trim.
 *
 * Trim must run *after* the slice so truncation can't reintroduce a
 * trailing hyphen (the `e2e-speed--` artefact). Exported for pinning
 * tests; see `tests/team-branch-shape.test.ts`.
 */
export function toBranchName(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.slice(0, 14)
		.replace(/^-+|-+$/g, "") || "goal";
}


export class GoalManager {
	private store: GoalStore;
	private workflowStore?: WorkflowStore;
	/** Track in-flight worktree setups to prevent concurrent calls for the same goal. */
	private _setupsInFlight = new Set<string>();
	/**
	 * Resolver that looks up the worktree pool for this goal's project.
	 * Wired by the server at startup once SessionManager owns the pools.
	 * When set, `_doSetupWorktree` claims through the pool first and only
	 * falls back to a fresh `createWorktree` if the pool is empty.
	 */
	private poolResolver?: () => WorktreePool | null | undefined;
	/**
	 * Resolve the components[] for a goal's project. When set and the project
	 * has any `repo !== "."` component, `_doSetupWorktree` uses
	 * `createWorktreeSet()` instead of the single-repo `createWorktree()`
	 * fallback. Single-repo behavior is unchanged.
	 */
	private componentsResolver?: (projectId: string) => Component[];
	/**
	 * Resolve the project's `rootPath` for multi-repo goal creation. When set
	 * and the project is multi-repo, `createGoal` overrides the detected
	 * `repoPath` (which would otherwise point at one of the sibling repos) to
	 * the project's container directory. Single-repo behavior is unchanged.
	 */
	private projectRootResolver?: (projectId: string) => string | undefined;

	constructor(goalStore: GoalStore, workflowStore?: WorkflowStore) {
		this.store = goalStore;
		this.workflowStore = workflowStore;
		// Mark any goals stuck in "preparing" from a previous run as error
		this._recoverStuckSetups();
	}

	/**
	 * Wire a pool resolver. Phase 3: goal worktrees go through the pool first,
	 * matching the session path so goals are observably as fast as sessions
	 * when the pool is warm.
	 */
	setPoolResolver(resolver: () => WorktreePool | null | undefined): void {
		this.poolResolver = resolver;
	}

	/**
	 * Wire the components resolver. When unset (or returning a single-component
	 * list), goal worktrees use the legacy `createWorktree` fallback.
	 */
	setComponentsResolver(resolver: (projectId: string) => Component[]): void {
		this.componentsResolver = resolver;
	}

	/** Wire a project-rootPath resolver (Phase 4a multi-repo goal creation). */
	setProjectRootResolver(resolver: (projectId: string) => string | undefined): void {
		this.projectRootResolver = resolver;
	}

	/** Wire a project worktree_root resolver (project-level override of <rootPath>-wt/). */
	private worktreeRootResolver?: (projectId: string) => string | undefined;
	setWorktreeRootResolver(resolver: (projectId: string) => string | undefined): void {
		this.worktreeRootResolver = resolver;
	}

	/** Wire a project base_ref resolver — the configured branch ref (`base_ref` setting)
	 *  used as the worktree start-point and branch upstream. Empty/undefined falls back
	 *  to today's `resolveRemotePrimary`. See docs/design/base-ref.md. */
	private baseRefResolver?: (projectId: string) => string | undefined;
	setBaseRefResolver(resolver: (projectId: string) => string | undefined): void {
		this.baseRefResolver = resolver;
	}

	/**
	 * On startup, scan for goals stuck in setupStatus === "preparing"
	 * and mark them as "error" (setup was interrupted by server restart).
	 */
	private _recoverStuckSetups(): void {
		for (const goal of this.store.getAll()) {
			if (goal.setupStatus === "preparing") {
				this.store.update(goal.id, {
					setupStatus: "error",
					setupError: "Setup interrupted by server restart",
				});
				console.warn(`[goal-manager] Marked goal "${goal.title}" (${goal.id}) as error — setup was interrupted by server restart`);
			}
		}
	}

	/**
	 * Create a goal instantly — persists to disk and returns immediately.
	 * Does NOT create the worktree. Call setupWorktree() separately after responding.
	 */
	async createGoal(title: string, cwd: string, opts?: { spec?: string; workflowId?: string; workflowStore?: WorkflowStore; resolvedWorkflow?: Workflow; sandboxed?: boolean; enabledOptionalSteps?: string[]; projectId?: string }): Promise<PersistedGoal> {
		const { spec = "", workflowId, workflowStore = this.workflowStore, resolvedWorkflow, sandboxed, enabledOptionalSteps, projectId } = opts ?? {};
		const team = true;
		const worktree = true;
		const now = Date.now();
		const id = randomUUID();

		let worktreePath: string | undefined;
		let branch: string | undefined;
		let repoPath: string | undefined;
		let goalCwd = cwd;
		let setupStatus: "ready" | "preparing" = "ready";

		// Detect git repo root — needed for team operations even without a worktree.
		// Single source of truth shared with the session path (server.ts) and the
		// staff path (staff-manager.ts): a multi-repo project resolves to its
		// container root as `repoPath` (per-repo worktrees land beneath one shared
		// `<rootPath>-wt/<branch>/`) ONLY when at least one component is a git repo
		// root; otherwise it falls back to the single-repo `isGitRepo(cwd)` probe,
		// and to no-worktree when that also fails (never throws).
		const components = projectId && this.componentsResolver ? this.componentsResolver(projectId) : undefined;
		const projectRoot = projectId && this.projectRootResolver ? this.projectRootResolver(projectId) : undefined;
		const support = await resolveWorktreeSupport(components ?? [], projectRoot, cwd);
		if (support.supported) repoPath = support.repoPath;

		// Compute worktree path and branch (but don't create yet)
		if (worktree && repoPath) {
			branch = `goal/${toBranchName(title)}-${id.slice(0, 8)}`;
			worktreePath = path.join(path.resolve(repoPath, "..", `${path.basename(repoPath)}-wt`), branch.replace(/\//g, "-"));
			// Apply subdirectory offset: if project rootPath (cwd) is a subdirectory of the
			// git repo, the worktree cwd must point to the same subdirectory within the worktree.
			const relativeOffset = path.relative(repoPath, cwd);
			goalCwd = relativeOffset && relativeOffset !== "." ? path.join(worktreePath, relativeOffset) : worktreePath;
			setupStatus = "preparing";
		}

		const goal: PersistedGoal = {
			id,
			title,
			cwd: goalCwd,
			state: "todo",
			spec,
			createdAt: now,
			updatedAt: now,
			worktreePath,
			branch,
			repoPath,
			team,
			setupStatus,
			sandboxed,
		};

		if (enabledOptionalSteps?.length) {
			goal.enabledOptionalSteps = enabledOptionalSteps;
		}

		// Snapshot workflow onto goal. Resolution order:
		//   1. Caller passed `resolvedWorkflow` (from config cascade) — use it.
		//   2. Caller passed `workflowId` only — read from the inline workflow store.
		//   3. Neither — fall back to the first workflow in the store
		//      (insertion order preserves config-cascade priority).
		// If we can't resolve a workflow at all, throw a clear error so
		// `POST /api/goals` surfaces a 400 instead of silently creating a
		// gateless goal. See docs/design/multi-repo-components.md §3.4.
		const NO_WORKFLOWS_MSG =
			"This project has no workflows configured. Run project setup or generate workflows from Settings → project tab.";
		if (workflowId && resolvedWorkflow) {
			// Use pre-resolved workflow (from config cascade)
			goal.workflowId = workflowId;
			goal.workflow = JSON.parse(JSON.stringify(resolvedWorkflow));
		} else if (workflowId && workflowStore) {
			const wf = workflowStore.get(workflowId);
			if (!wf) {
				// If the store has nothing at all, surface the canonical message.
				if (workflowStore.getAll().length === 0) {
					throw new Error(NO_WORKFLOWS_MSG);
				}
				throw new Error(`Workflow not found: ${workflowId}`);
			}
			goal.workflowId = workflowId;
			goal.workflow = JSON.parse(JSON.stringify(wf));
		} else if (!workflowId && workflowStore) {
			// No id supplied — fall back to the first workflow in the store.
			// Order is insertion order, which preserves config-cascade priority
			// (project > user > defaults). If the store is empty, surface the
			// canonical NO_WORKFLOWS_MSG so the UI can show the empty-workflows
			// banner. Never names a literal workflow id (no "general" magic).
			const all = workflowStore.getAll();
			if (all.length === 0) {
				throw new Error(NO_WORKFLOWS_MSG);
			}
			const first = all[0];
			goal.workflowId = first.id;
			goal.workflow = JSON.parse(JSON.stringify(first));
		}

		this.store.put(goal);
		return goal;
	}

	/**
	 * Async worktree setup — called after createGoal() returns.
	 * Retries once on failure. Updates setupStatus accordingly.
	 */
	async setupWorktree(goalId: string): Promise<void> {
		const goal = this.store.get(goalId);
		if (!goal || !goal.repoPath || !goal.branch) {
			throw new Error(`Goal ${goalId} not found or missing repo/branch info`);
		}

		// Prevent concurrent setup calls for the same goal
		if (this._setupsInFlight.has(goalId)) {
			return;
		}
		this._setupsInFlight.add(goalId);

		try {
			await this._doSetupWorktree(goal);
		} finally {
			this._setupsInFlight.delete(goalId);
		}
	}

	private async _doSetupWorktree(goal: PersistedGoal): Promise<void> {
		// Compute subdirectory offset: the difference between the preliminary
		// worktreePath (repo root level) and goal.cwd (which may include offset).
		const preliminaryOffset = goal.worktreePath ? path.relative(goal.worktreePath, goal.cwd) : "";

		// Pool-first (Phase 3): claim a pre-built worktree if one is available.
		// On success this is observably as fast as session start (~tens of ms).
		// On failure or empty pool we fall through to the legacy createWorktree path.
		const pool = this.poolResolver?.();
		if (pool) {
			try {
				const claim = await pool.claim(goal.branch!);
				if (claim) {
					const offsetCwd = preliminaryOffset && preliminaryOffset !== "."
						? path.join(claim.worktreePath, preliminaryOffset)
						: claim.worktreePath;
					const updates: Parameters<typeof this.store.update>[1] = {
						worktreePath: claim.worktreePath,
						cwd: offsetCwd,
						setupStatus: "ready",
						setupError: undefined,
					};
					if (claim.worktrees && claim.worktrees.length > 0) {
						updates.repoWorktrees = Object.fromEntries(
							claim.worktrees.map(w => [w.repo, w.worktreePath]),
						);
					}
					this.store.update(goal.id, updates);
					console.log(`[goal-manager] Worktree claimed from pool for goal "${goal.title}": ${claim.worktreePath} (branch: ${goal.branch}${claim.degraded ? ", degraded" : ""})`);
					return;
				}
			} catch (err) {
				console.warn(`[goal-manager] Pool claim failed for goal "${goal.title}" — falling back to createWorktree:`, err);
			}
		}

		// If multi-repo and we have a components resolver, use createWorktreeSet.
		const components = goal.projectId && this.componentsResolver
			? this.componentsResolver(goal.projectId)
			: undefined;
		const isMulti = !!components && components.some(c => c.repo !== ".");

		let lastError: unknown;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const worktreeRootOverride = goal.projectId && this.worktreeRootResolver
					? this.worktreeRootResolver(goal.projectId) : undefined;
				const configuredBaseRef = goal.projectId && this.baseRefResolver
					? this.baseRefResolver(goal.projectId) : undefined;
				if (isMulti && components) {
					const set = await createWorktreeSet(goal.repoPath!, components, goal.branch!, undefined, { worktreeRoot: worktreeRootOverride, configuredBaseRef });
					// Defense-in-depth: if no worktree-able git sub-repo remained
					// (createWorktreeSet skips the non-git container and non-git
					// sub-repos), fall back gracefully to no-worktree. The goal
					// should run in its ORIGINAL project cwd with no worktree —
					// the precomputed worktreePath/cwd point at a branch container
					// that was never created, so restore the no-worktree state:
					// clear worktreePath/repoWorktrees and reset cwd to the
					// un-offset project cwd. resolveWorktreeSupport normally
					// prevents reaching here (repoPath stays unset, so
					// setupWorktree isn't called), but guard anyway.
					if (set.worktrees.length === 0) {
						this._restoreNoWorktree(goal, preliminaryOffset);
						console.warn(`[goal-manager] No worktree-able repo for goal "${goal.title}" — proceeding without a worktree`);
						return;
					}
					// Per-component setup commands run after the worktree set lands.
					// Non-fatal on failure (worktree is still usable). See worktree-setup.ts.
					try {
						const { runComponentSetups } = await import("../skills/worktree-setup.js");
						const { execShellCommand } = await import("./shell-util.js");
						await runComponentSetups({
							components,
							branchContainer: set.container,
							primaryWorktreeRoot: goal.repoPath!,
							exec: async (cmd, cwd, env) => {
								await execShellCommand(cmd, { cwd, env, timeout: 120_000 });
							},
						});
					} catch (err) {
						console.warn(`[goal-manager] runComponentSetups failed for goal "${goal.title}" (non-fatal):`, err);
					}
					const offsetCwd = preliminaryOffset && preliminaryOffset !== "."
						? path.join(set.container, preliminaryOffset)
						: set.container;
					const repoWorktrees = Object.fromEntries(
						set.worktrees.map(w => [w.repo, w.worktreePath]),
					);
					this.store.update(goal.id, {
						worktreePath: set.container,
						cwd: offsetCwd,
						repoWorktrees,
						setupStatus: "ready",
						setupError: undefined,
					});
					console.log(`[goal-manager] Multi-repo worktree set ready for goal "${goal.title}" at ${set.container}`);
					return;
				}
				const result = await createWorktree(goal.repoPath!, goal.branch!, { worktreeRoot: worktreeRootOverride, configuredBaseRef });
				// Per-component setup — non-fatal on failure. Mirrors the multi-repo
				// branch above so component.relativePath is honored.
				if (components && components.length > 0) {
					try {
						const { runComponentSetups } = await import("../skills/worktree-setup.js");
						const { execShellCommand } = await import("./shell-util.js");
						await runComponentSetups({
							components,
							branchContainer: result.worktreePath,
							primaryWorktreeRoot: goal.repoPath!,
							exec: async (cmd, cwd, env) => {
								await execShellCommand(cmd, { cwd, env, timeout: 120_000 });
							},
						});
					} catch (err) {
						console.warn(`[goal-manager] runComponentSetups failed for goal "${goal.title}" (non-fatal):`, err);
					}
				}
				// Apply the subdirectory offset to the actual worktree path
				const offsetCwd = preliminaryOffset && preliminaryOffset !== "."
					? path.join(result.worktreePath, preliminaryOffset)
					: result.worktreePath;
				// Update goal with actual worktree path and mark as ready
				this.store.update(goal.id, {
					worktreePath: result.worktreePath,
					cwd: offsetCwd,
					setupStatus: "ready",
					setupError: undefined,
				});
				console.log(`[goal-manager] Worktree ready for goal "${goal.title}": ${result.worktreePath} (branch: ${goal.branch})`);
				return;
			} catch (err) {
				lastError = err;
				console.error(`[goal-manager] Worktree setup attempt ${attempt + 1} failed for goal "${goal.title}":`, err);
				if (attempt === 0) {
					// Brief delay before retry
					await new Promise(resolve => setTimeout(resolve, 1000));
				}
			}
		}

		// Both attempts failed
		this.store.update(goal.id, {
			setupStatus: "error",
			setupError: String(lastError),
		});
		throw lastError;
	}

	/**
	 * Restore a goal to a no-worktree state when worktree setup produced no
	 * worktree (e.g. createWorktreeSet skipped every non-git sub-repo). The
	 * precomputed worktreePath/cwd (set in createGoal) point at a branch
	 * container that was never created, so we must:
	 *   - clear worktreePath + repoWorktrees, and
	 *   - reset cwd to the ORIGINAL project cwd (the un-offset goal cwd, before
	 *     the worktree offset was applied) = repoPath + the same subdirectory
	 *     offset that createGoal computed via path.relative(repoPath, cwd).
	 * setupStatus becomes "ready" with no setupError. The goal then runs in its
	 * original project cwd with no worktree — mirroring resolveWorktreeSupport
	 * returning unsupported.
	 *
	 * `store.update` strips undefined values (so it can't clear fields); mutate
	 * the live goal reference directly to delete worktreePath/repoWorktrees.
	 */
	private _restoreNoWorktree(goal: PersistedGoal, preliminaryOffset: string): void {
		const originalCwd = preliminaryOffset && preliminaryOffset !== "."
			? path.join(goal.repoPath!, preliminaryOffset)
			: goal.repoPath!;
		const live = this.store.get(goal.id);
		if (live) {
			delete live.worktreePath;
			delete live.repoWorktrees;
		}
		this.store.update(goal.id, { cwd: originalCwd, setupStatus: "ready", setupError: undefined });
	}

	/**
	 * Setup worktree then start team. Used when autoStartTeam is enabled.
	 * Uses a callback to avoid circular dependency with TeamManager.
	 */
	async setupWorktreeAndStartTeam(goalId: string, startTeamFn: () => Promise<any>): Promise<void> {
		await this.setupWorktree(goalId);
		await startTeamFn();
	}

	/**
	 * Retry setup for a goal in error state.
	 * Returns true if retry was initiated, false if goal not found or not in error state.
	 */
	retrySetup(goalId: string): boolean {
		const goal = this.store.get(goalId);
		if (!goal || goal.setupStatus !== "error") {
			return false;
		}
		this.store.update(goalId, {
			setupStatus: "preparing",
			setupError: undefined,
		});
		return true;
	}

	async archiveGoal(id: string): Promise<boolean> {
		const goal = this.store.get(id);
		if (!goal) return false;
		const archived = this.store.archive(id);
		// Phase 4a multi-repo cleanup: best-effort, fire-and-forget per-repo
		// worktree removal + remote branch deletion in parallel. Single-repo
		// goal cleanup remains owned by session purge (worktree shared with the
		// team-lead session) so we only fan out when repoWorktrees is set.
		if (archived && goal.repoWorktrees && goal.repoPath && goal.branch && Object.keys(goal.repoWorktrees).length > 0) {
			const { cleanupWorktree } = await import("../skills/git.js");
			const entries = Object.entries(goal.repoWorktrees);
			Promise.allSettled(entries.map(([repo, wt]) => {
				const repoPath = repo === "." ? goal.repoPath! : path.join(goal.repoPath!, repo);
				return cleanupWorktree(repoPath, wt, goal.branch, true);
			})).catch(() => { /* swallow — best-effort */ });
		}
		return archived;
	}

	listLiveGoals(): PersistedGoal[] {
		return this.store.getLive();
	}

	listArchivedGoals(): PersistedGoal[] {
		return this.store.getArchived();
	}

	getGoal(id: string): PersistedGoal | undefined {
		return this.store.get(id);
	}

	/** Current generation counter from the underlying store. */
	getGoalGeneration(): number {
		return this.store.getGeneration();
	}

	/** Expose the underlying store for cross-cutting concerns (e.g. gate status bumping generation). */
	getGoalStore(): GoalStore {
		return this.store;
	}

	listGoals(): PersistedGoal[] {
		return this.store.getAll();
	}

	async updateGoal(id: string, updates: { title?: string; cwd?: string; state?: GoalState; spec?: string; team?: boolean; repoPath?: string; branch?: string; reattemptOf?: string; projectId?: string; autoStartTeam?: boolean }): Promise<boolean> {
		const existing = this.store.get(id);
		if (!existing) return false;

		// If toggling team mode ON for a non-team goal, auto-create worktree
		if (updates.team === true && !existing.team && !existing.worktreePath) {
			const cwd = updates.cwd ?? existing.cwd;
			if (await isGitRepo(cwd)) {
				const repoRoot = await getRepoRoot(cwd);
				const title = updates.title ?? existing.title;
				const branch = `goal/${toBranchName(title)}-${id.slice(0, 8)}`;
				const projectIdForBase = updates.projectId ?? existing.projectId;
				const configuredBaseRef = projectIdForBase && this.baseRefResolver
					? this.baseRefResolver(projectIdForBase) : undefined;
				try {
					const result = await createWorktree(repoRoot, branch, { configuredBaseRef });
					updates.repoPath = repoRoot;
					updates.branch = branch;
					// Also update cwd to the worktree
					updates.cwd = result.worktreePath;
					console.log(`[goal-manager] Created worktree for upgraded team goal "${title}": ${result.worktreePath} (branch: ${branch})`);
				} catch (err) {
					console.error(`[goal-manager] Failed to create worktree when upgrading to team goal:`, err);
				}
			}
		}

		return this.store.update(id, updates);
	}

	async deleteGoal(id: string): Promise<boolean> {
		const goal = this.store.get(id);
		if (!goal) return false;

		// Worktrees are preserved for 7-day archive — do NOT clean them up here.
		// The team teardown (called by server.ts before deleteGoal) archives all
		// sessions via terminateSession/dismissRole, which preserves worktree paths
		// in the archived session metadata. The periodic purge cleans them up later.
		if (goal?.team) {
			console.log(`[goal-manager] Deleting team goal "${goal.title}" — worktrees preserved for archived session review`);
		}

		this.store.remove(id);
		return true;
	}
}
