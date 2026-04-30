import { randomUUID } from "node:crypto";
import path from "node:path";
import { GoalStore, type GoalState, type PersistedGoal } from "./goal-store.js";
import { createWorktree, createWorktreeSet, isGitRepo, getRepoRoot, mergeChildBranchLocal } from "../skills/git.js";
import type { WorkflowStore, Workflow, VerifyStep } from "./workflow-store.js";
import type { WorktreePool } from "./worktree-pool.js";
import type { Component } from "./project-config-store.js";
import type { Role } from "./role-store.js";
import { parseAcceptanceCriteria } from "./acceptance-criteria.js";

/**
 * Sanitize a goal title into a valid git branch name.
 * Lowercase, replace non-alphanumeric with hyphens, trim, truncate.
 */
function toBranchName(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 10) || "goal";
}


/**
 * Buffered plan mutation, awaiting user approval via
 * `POST /api/goals/:id/mutation/:requestId/decision`.
 *
 * Phase 4 task 4.3 introduces only the **storage** + apply/reject
 * primitives. Phase 5 task 5.2 wires the classifier that decides when a
 * mutation must be buffered (vs. auto-applied or rejected outright). Until
 * 5.2 lands, nothing populates `pendingMutations` in production paths;
 * tests cover the storage shape via direct buffer/apply/reject calls.
 *
 * Two mutation kinds are supported up-front so 5.2 doesn't need to revisit
 * this surface:
 *   - `plan-replace`     — swap a gate's `verify[]` (PATCH /plan)
 *   - `child-spawn`      — off-plan child creation (POST /spawn-child)
 *
 * `applyBufferedMutation` returns the same shape the REST decision
 * endpoint surfaces in its `applied` field.
 *
 * See `docs/design/nested-goals.md` §10.5 + §8 + §9.
 */
export interface BufferedPlanReplace {
	kind: "plan-replace";
	goalId: string;
	gateId: string;
	planSteps: VerifyStep[];
	replanReason?: string;
	/** Optimistic-concurrency cursor at buffer time. */
	expectedReplanCount?: number;
	createdAt: number;
}

export interface BufferedChildSpawn {
	kind: "child-spawn";
	goalId: string;
	/** Frozen request body passed to `POST /api/goals/:id/spawn-child`. */
	spawnPayload: Record<string, unknown>;
	createdAt: number;
}

export type BufferedMutation = BufferedPlanReplace | BufferedChildSpawn;

export interface AppliedMutationResult {
	plan?: VerifyStep[];
	childGoalId?: string;
}

export class GoalManager {
	private store: GoalStore;
	private workflowStore?: WorkflowStore;
	/**
	 * Per-goal pending plan-mutation buffer, keyed by `requestId` (§10.5).
	 *
	 * Phase 4 task 4.3 owns the storage + apply/reject primitives. Phase 5
	 * task 5.2 will populate the map from the classifier and clear it on
	 * `goal_mutation_resolved`. Cleared on goal archive / delete.
	 */
	private pendingMutations = new Map<string, BufferedMutation>();
	/** Track in-flight worktree setups to prevent concurrent calls for the same goal. */
	private _setupsInFlight = new Set<string>();
	/**
	 * Per-goal worktree base-branch override, set by createGoal and read by
	 * _doSetupWorktree. Not persisted — the start-point is only relevant once
	 * during initial worktree creation.
	 */
	private _setupBaseBranch = new Map<string, string>();
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
	async createGoal(title: string, cwd: string, opts?: {
		spec?: string;
		workflowId?: string;
		workflowStore?: WorkflowStore;
		resolvedWorkflow?: Workflow;
		sandboxed?: boolean;
		enabledOptionalSteps?: string[];
		projectId?: string;
		// ── nested-goals additions (design §3.1) ──
		parentGoalId?: string;
		inlineWorkflow?: Workflow;
		inlineRoles?: Record<string, Role>;
		divergencePolicy?: "strict" | "balanced" | "autonomous";
		maxConcurrentChildren?: number;
		/** Override base branch for the worktree (defaults to remote primary
		 *  for top-level goals; to parent.branch for child goals). */
		baseBranch?: string;
	}): Promise<PersistedGoal> {
		const { spec = "", workflowId, workflowStore = this.workflowStore, resolvedWorkflow, sandboxed, enabledOptionalSteps, projectId } = opts ?? {};
		const { parentGoalId, inlineWorkflow, inlineRoles, divergencePolicy, maxConcurrentChildren, baseBranch } = opts ?? {};
		const team = true;
		const worktree = true;
		const now = Date.now();
		const id = randomUUID();

		// Resolve parent + invariants (design §3.1).
		let parent: PersistedGoal | undefined;
		if (parentGoalId) {
			parent = this.store.get(parentGoalId);
			if (!parent) {
				throw new Error(`Parent goal not found: ${parentGoalId}`);
			}
			if (parent.archived) {
				throw new Error(`Parent goal is archived: ${parentGoalId}`);
			}
			// Single-project tree (Decision #12).
			if (projectId !== undefined && parent.projectId !== undefined && parent.projectId !== projectId) {
				throw new Error(`Cross-project nesting is not supported (parent project ${parent.projectId} != ${projectId})`);
			}
			// Cycle defence — walk ancestor chain. Mathematically impossible at
			// creation (the new id has no descendants yet) but guard against
			// corrupt store state where the parent's chain would loop.
			const ancestors = this.store.getAncestors(parentGoalId);
			const seen = new Set<string>([parentGoalId]);
			for (const a of ancestors) {
				if (seen.has(a.id)) {
					throw new Error(`Cycle detected in parent chain at goal ${a.id}`);
				}
				seen.add(a.id);
			}
			if (seen.has(id)) {
				throw new Error(`Cycle detected: new goal id ${id} appears in parent chain`);
			}
		}

		let worktreePath: string | undefined;
		let branch: string | undefined;
		let repoPath: string | undefined;
		let goalCwd = cwd;
		let setupStatus: "ready" | "preparing" = "ready";

		// Detect git repo root — needed for team operations even without a worktree.
		// Multi-repo: override `repoPath` with the project's container root so the
		// per-repo worktrees land beneath one shared `<rootPath>-wt/<branch>/`.
		const components = projectId && this.componentsResolver ? this.componentsResolver(projectId) : undefined;
		const isMulti = !!components && components.some(c => c.repo !== ".");
		const projectRoot = projectId && this.projectRootResolver ? this.projectRootResolver(projectId) : undefined;
		if (isMulti && projectRoot) {
			repoPath = projectRoot;
		} else if (await isGitRepo(cwd)) {
			repoPath = await getRepoRoot(cwd);
		}

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

		// Derive nested-goals fields (design §3.1 step 4 + 5).
		const rootGoalId = parent ? (parent.rootGoalId ?? parent.id) : id;
		const mergeTarget: "master" | "parent" = parent ? "parent" : "master";

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
			rootGoalId,
			mergeTarget,
		};

		if (parentGoalId) goal.parentGoalId = parentGoalId;
		if (inlineWorkflow) goal.inlineWorkflow = JSON.parse(JSON.stringify(inlineWorkflow));
		if (inlineRoles) goal.inlineRoles = JSON.parse(JSON.stringify(inlineRoles));
		if (divergencePolicy) goal.divergencePolicy = divergencePolicy;
		if (typeof maxConcurrentChildren === "number") {
			goal.maxConcurrentChildren = maxConcurrentChildren;
		}
		const effectiveBaseBranch = baseBranch ?? parent?.branch;
		if (effectiveBaseBranch) {
			// In-memory only — _doSetupWorktree consumes it on first setup.
			this._setupBaseBranch.set(id, effectiveBaseBranch);
		}

		// Acceptance-criteria parsed once at creation (design §3.1 step 6).
		const criteria = parseAcceptanceCriteria(spec);
		if (criteria.length > 0) {
			goal.acceptanceCriteria = criteria;
		}

		if (enabledOptionalSteps?.length) {
			goal.enabledOptionalSteps = enabledOptionalSteps;
		}

		// Snapshot workflow onto goal. Resolution order:
		//   1. Caller passed `resolvedWorkflow` (from config cascade) — use it.
		//   2. Caller passed `workflowId` only — read from the inline workflow store.
		//   3. Neither — fall back to "general".
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
			// Default to "general" workflow when none specified.
			const defaultWf = workflowStore.get("general");
			if (defaultWf) {
				goal.workflowId = "general";
				goal.workflow = JSON.parse(JSON.stringify(defaultWf));
			} else if (workflowStore.getAll().length === 0) {
				throw new Error(NO_WORKFLOWS_MSG);
			}
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
			this._setupBaseBranch.delete(goalId);
		}
	}

	private async _doSetupWorktree(goal: PersistedGoal): Promise<void> {
		// Compute subdirectory offset: the difference between the preliminary
		// worktreePath (repo root level) and goal.cwd (which may include offset).
		const preliminaryOffset = goal.worktreePath ? path.relative(goal.worktreePath, goal.cwd) : "";

		// Resolve the per-goal base-branch override (set by createGoal for
		// children of a parent goal, or via opts.baseBranch). Top-level goals
		// without an override fall through to createWorktree's default of
		// `origin/<primary>`.
		const startPoint = this._setupBaseBranch.get(goal.id);

		// Pool-first (Phase 3): claim a pre-built worktree if one is available.
		// On success this is observably as fast as session start (~tens of ms).
		// On failure or empty pool we fall through to the legacy createWorktree path.
		//
		// Child goals MUST bypass the pool: pool worktrees branch off the project's
		// primary, but children must branch off the parent's branch HEAD at spawn
		// time so they observe the parent's commits (design §3.1 step 5, §3.0
		// invariant 2). The presence of a baseBranch override is a sufficient
		// signal: createGoal sets it for every child and for any caller-explicit
		// override. Top-level pool path is unchanged.
		const skipPool = !!startPoint || !!goal.parentGoalId;
		const pool = skipPool ? null : this.poolResolver?.();
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
				if (isMulti && components) {
					// Multi-repo passes baseBranch through to createWorktreeSet so all
					// per-repo worktrees branch off the parent's tip when the goal is
					// a child (design §3.0 invariant 2).
					const set = await createWorktreeSet(goal.repoPath!, components, goal.branch!, startPoint, { worktreeRoot: worktreeRootOverride });
					// Per-component setup commands run after the worktree set lands.
					// Non-fatal on failure (worktree is still usable). See worktree-setup.ts.
					try {
						const { runComponentSetups } = await import("../skills/worktree-setup.js");
						const { execFile } = await import("node:child_process");
						const { promisify } = await import("node:util");
						const pExecFile = promisify(execFile);
						await runComponentSetups({
							components,
							branchContainer: set.container,
							primaryWorktreeRoot: goal.repoPath!,
							exec: async (cmd, cwd, env) => {
								await pExecFile("sh", ["-c", cmd], { cwd, env, timeout: 120_000 });
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
				const result = await createWorktree(goal.repoPath!, goal.branch!, { worktreeRoot: worktreeRootOverride, startPoint });
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
	 * Resolve the effective divergence policy for a goal by walking up its
	 * parentGoalId chain. Returns the goal's own value, else the first
	 * ancestor that defines one, else `"strict"`. Design §1.5.
	 */
	resolveDivergencePolicy(goalId: string): "strict" | "balanced" | "autonomous" {
		const goal = this.store.get(goalId);
		if (!goal) return "strict";
		if (goal.divergencePolicy) return goal.divergencePolicy;
		// getAncestors returns root-first; we want nearest-ancestor-first to
		// honour "first set value wins" walking up the chain.
		const ancestors = this.store.getAncestors(goalId).slice().reverse();
		for (const a of ancestors) {
			if (a.divergencePolicy) return a.divergencePolicy;
		}
		return "strict";
	}

	/**
	 * Resolve the root goal's `maxConcurrentChildren`, clamped to [1, 8].
	 * Default 3. Per design §1.5 only the root's value is honoured in v1
	 * — sub-goal values are inert. The argument is the **root** goal id;
	 * callers should pass `goal.rootGoalId ?? goal.id`.
	 */
	resolveRootMaxConcurrentChildren(rootGoalId: string): number {
		const root = this.store.get(rootGoalId);
		const raw = root?.maxConcurrentChildren;
		if (typeof raw !== "number" || !Number.isFinite(raw)) return 3;
		return Math.max(1, Math.min(8, Math.floor(raw)));
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
		// Drop any buffered mutations targeting this goal — they're stale.
		if (archived) {
			for (const [reqId, mutation] of this.pendingMutations) {
				if (mutation.goalId === id) this.pendingMutations.delete(reqId);
			}
		}
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

	async updateGoal(id: string, updates: { title?: string; cwd?: string; state?: GoalState; spec?: string; team?: boolean; repoPath?: string; branch?: string; prUrl?: string; reattemptOf?: string; projectId?: string; autoStartTeam?: boolean }): Promise<boolean> {
		const existing = this.store.get(id);
		if (!existing) return false;

		// If toggling team mode ON for a non-team goal, auto-create worktree
		if (updates.team === true && !existing.team && !existing.worktreePath) {
			const cwd = updates.cwd ?? existing.cwd;
			if (await isGitRepo(cwd)) {
				const repoRoot = await getRepoRoot(cwd);
				const title = updates.title ?? existing.title;
				const branch = `goal/${toBranchName(title)}-${id.slice(0, 8)}`;
				try {
					const result = await createWorktree(repoRoot, branch);
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

	/**
	 * Locally merge a child goal's branch into the parent goal's branch.
	 *
	 * Wraps `mergeChildBranchLocal` (see `docs/design/nested-goals.md` §3.3):
	 * resolves the parent goal record, finds its worktree, and dispatches to
	 * the git helper. Throws if the parent has no worktree (i.e. the parent's
	 * setup never completed) — the caller (verification harness or the
	 * `goal_merge_child` tool) should treat that as a hard error.
	 *
	 * Does NOT mark the child goal complete or fan out events — those are
	 * the verification harness / team-manager's responsibility (§2.3).
	 *
	 * @returns Result of the merge attempt. On clean merge:
	 *   `{ merged: true, conflict: false, commitSha }`. On conflict:
	 *   `{ merged: false, conflict: true, output }`.
	 */
	async mergeChild(
		parentGoalId: string,
		childGoalId: string,
	): Promise<{ merged: boolean; conflict: boolean; commitSha?: string; output: string }> {
		const parent = this.store.get(parentGoalId);
		if (!parent) {
			throw new Error(`mergeChild: parent goal not found: ${parentGoalId}`);
		}
		const child = this.store.get(childGoalId);
		if (!child) {
			throw new Error(`mergeChild: child goal not found: ${childGoalId}`);
		}
		if (child.parentGoalId !== parentGoalId) {
			const pid = child.parentGoalId ?? "<none>";
			throw new Error(
				`mergeChild: goal ${childGoalId} is not a child of ${parentGoalId} (parentGoalId=${pid})`,
			);
		}
		if (!parent.worktreePath) {
			throw new Error(`mergeChild: parent goal ${parentGoalId} has no worktree`);
		}
		if (!parent.branch) {
			throw new Error(`mergeChild: parent goal ${parentGoalId} has no branch`);
		}
		if (!child.branch) {
			throw new Error(`mergeChild: child goal ${childGoalId} has no branch`);
		}
		return await mergeChildBranchLocal(parent.worktreePath, parent.branch, child.branch);
	}

	// ── Pending plan-mutation buffer (§10.5) ────────────────────────

	/**
	 * Buffer a mutation for later apply/reject via the decision endpoint.
	 * Idempotent on `requestId` — calling twice with the same id replaces
	 * the previous buffered entry (5.2 may want to refresh the payload).
	 */
	bufferMutation(requestId: string, mutation: BufferedMutation): void {
		if (!requestId) throw new Error("bufferMutation: requestId is required");
		if (!mutation || typeof mutation !== "object") {
			throw new Error("bufferMutation: mutation payload is required");
		}
		this.pendingMutations.set(requestId, mutation);
	}

	/** Inspect a buffered mutation without consuming it. */
	getBufferedMutation(requestId: string): BufferedMutation | undefined {
		return this.pendingMutations.get(requestId);
	}

	/** Test/diagnostic helper. Not used by production code paths. */
	listBufferedMutationIds(goalId?: string): string[] {
		const ids: string[] = [];
		for (const [id, m] of this.pendingMutations) {
			if (!goalId || m.goalId === goalId) ids.push(id);
		}
		return ids;
	}

	/**
	 * Apply a buffered mutation and remove it from the buffer.
	 *
	 * Returns the `applied` payload the REST decision endpoint surfaces in
	 * its 200 response (see §8 / §10.5):
	 *   - `plan-replace`  → `{ plan: VerifyStep[] }`
	 *   - `child-spawn`   → `{ childGoalId }` (5.2 fills this in once it
	 *                       wires the off-plan-spawn flow; 4.3 returns an
	 *                       empty object so the storage shape is exercised
	 *                       without committing to spawn semantics here.)
	 *
	 * Throws if `requestId` is unknown — callers should treat that as a
	 * stale/duplicate-decision case and surface 404.
	 */
	applyBufferedMutation(requestId: string): AppliedMutationResult {
		const mutation = this.pendingMutations.get(requestId);
		if (!mutation) {
			throw new Error(`applyBufferedMutation: unknown requestId ${requestId}`);
		}
		// Remove first so any throw downstream still drops the entry —
		// the user already decided; we don't want a half-applied retry.
		this.pendingMutations.delete(requestId);

		if (mutation.kind === "plan-replace") {
			const goal = this.store.get(mutation.goalId);
			if (!goal) {
				throw new Error(`applyBufferedMutation: goal ${mutation.goalId} not found`);
			}
			if (!goal.workflow) {
				throw new Error(`applyBufferedMutation: goal ${mutation.goalId} has no workflow snapshot`);
			}
			const gate = goal.workflow.gates.find(g => g.id === mutation.gateId);
			if (!gate) {
				throw new Error(
					`applyBufferedMutation: gate ${mutation.gateId} not found in goal ${mutation.goalId}`,
				);
			}
			gate.verify = mutation.planSteps;
			const frozen = gate.metadata?.frozen === "true";
			const nextReplan = (goal.replanCount ?? 0) + (frozen ? 1 : 0);
			if (frozen) {
				this.store.update(mutation.goalId, { workflow: goal.workflow, replanCount: nextReplan });
			} else {
				this.store.update(mutation.goalId, { workflow: goal.workflow });
			}
			return { plan: gate.verify };
		}

		// child-spawn: 4.3 doesn't perform the spawn here — 5.2 will. We
		// surface an empty payload so callers can post-decide without
		// pretending a child was created. The decision endpoint still
		// returns `resolved: true`; clients then re-fetch the goal tree.
		return {};
	}

	/**
	 * Drop a buffered mutation. Idempotent on unknown ids in the sense that
	 * the caller can use the boolean return to decide whether to broadcast
	 * `goal_mutation_resolved`. Returns `true` if a buffer was dropped,
	 * `false` if `requestId` was unknown.
	 */
	rejectBufferedMutation(requestId: string): boolean {
		return this.pendingMutations.delete(requestId);
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

		// Drop any buffered mutations targeting this goal — they're stale.
		for (const [reqId, mutation] of this.pendingMutations) {
			if (mutation.goalId === id) this.pendingMutations.delete(reqId);
		}
		this.store.remove(id);
		return true;
	}
}
