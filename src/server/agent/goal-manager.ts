import { randomUUID } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { GoalStore, type GoalState, type PersistedGoal } from "./goal-store.js";
import { createWorktree, createWorktreeSet, isGitRepo, getRepoRoot, mergeChildBranchLocal, type MergeChildResult, shouldSkipRemotePush } from "../skills/git.js";
import type { WorkflowStore, Workflow } from "./workflow-store.js";
import type { WorktreePool } from "./worktree-pool.js";
import type { Component } from "./project-config-store.js";
import type { GateStore } from "./gate-store.js";

const pExecFile = promisify(execFileCb);

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

/** Defensive cap on parent-chain walks. See deriveNestingFields(). */
export const NESTING_WALK_DEPTH_CAP = 64;

/**
 * Outcome of `GoalManager.mergeChild`. Extends the underlying
 * `MergeChildResult` with push status — the push is best-effort and never
 * fails the merge.
 */
export interface MergeChildOutcome extends MergeChildResult {
	/** True when `git push origin <parent.branch>` succeeded (or push was skipped via `shouldSkipRemotePush`). */
	pushed: boolean;
	/** Error message from a failed push — non-fatal, surfaced for logging. */
	pushError?: string;
}

/**
 * Pure helper for the nested-goals lineage derivation. Given a new goal's id
 * and its (optional) parentGoalId, walk the parent chain via the lookup
 * function and:
 *   - throw if the new id appears in the chain (cycle)
 *   - cap the walk at NESTING_WALK_DEPTH_CAP to prevent infinite loops on
 *     pathological / corrupted store state
 *   - derive rootGoalId (== id for root, == parent.rootGoalId ?? parent.id
 *     otherwise) and mergeTarget ("master" for root, "parent" for child)
 *
 * Exported for unit-testing the cycle-prevention branch deterministically.
 */
export function deriveNestingFields(
	newId: string,
	parentGoalId: string | undefined | null,
	lookup: (id: string) => PersistedGoal | undefined,
): { parentGoalId?: string; rootGoalId: string; mergeTarget: "master" | "parent" } {
	if (parentGoalId === undefined || parentGoalId === null) {
		return { rootGoalId: newId, mergeTarget: "master" };
	}
	const parent = lookup(parentGoalId);
	if (!parent) {
		throw new Error(`GoalManager.createGoal: parentGoalId="${parentGoalId}" not found`);
	}
	let cursor: PersistedGoal | undefined = parent;
	let depth = 0;
	while (cursor && depth < NESTING_WALK_DEPTH_CAP) {
		if (cursor.id === newId) {
			throw new Error(
				`Cycle detected: parent ${parentGoalId} already has ${newId} in its ancestor chain`,
			);
		}
		if (!cursor.parentGoalId) break;
		cursor = lookup(cursor.parentGoalId);
		depth++;
	}
	return {
		parentGoalId,
		rootGoalId: parent.rootGoalId ?? parent.id,
		mergeTarget: "parent",
	};
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
	async createGoal(title: string, cwd: string, opts?: { spec?: string; workflowId?: string; workflowStore?: WorkflowStore; resolvedWorkflow?: Workflow; sandboxed?: boolean; enabledOptionalSteps?: string[]; projectId?: string; parentGoalId?: string }): Promise<PersistedGoal> {
		const { spec = "", workflowId, workflowStore = this.workflowStore, resolvedWorkflow, sandboxed, enabledOptionalSteps, projectId, parentGoalId } = opts ?? {};
		const team = true;
		const worktree = true;
		const now = Date.now();
		const id = randomUUID();

		// ── Nested-goal derivation (Phase 1) ─────────────────────────────
		// Auto-derive rootGoalId, mergeTarget, and prevent cycles by walking
		// the parent chain. divergencePolicy / maxConcurrentChildren are NOT
		// inherited — they are root-only semantics; the harness consults the
		// root's value at runtime. Sub-goals can store their own value but it
		// is inert (forward-compat).
		const nesting = deriveNestingFields(id, parentGoalId, (gid) => this.store.get(gid));

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

		// Persist the project association on the goal record. Previously this
		// was stamped post-hoc by `POST /api/goals`, which left subgoals
		// (created via `goal_spawn_child`) without a projectId on disk and
		// forced the sidebar to walk the parentGoalId chain to bucket them.
		// Stamping it here closes that gap server-side.
		if (projectId) {
			goal.projectId = projectId;
		}

		if (enabledOptionalSteps?.length) {
			goal.enabledOptionalSteps = enabledOptionalSteps;
		}

		// Stamp nested-goal lineage. Always set on every newly created goal
		// (root or child) — root goals get rootGoalId === id, mergeTarget
		// === "master"; children get parent's rootGoalId chain and
		// mergeTarget === "parent".
		if (nesting.parentGoalId !== undefined) {
			goal.parentGoalId = nesting.parentGoalId;
		}
		goal.rootGoalId = nesting.rootGoalId;
		goal.mergeTarget = nesting.mergeTarget;

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
		} else if (workflowId) {
			// Lesson 4.3: workflowId given but neither resolvedWorkflow nor a
			// workflowStore is available — this is the silent-fail path that
			// produced workflow-less child goals on PR #409. Fail loudly
			// instead of producing a gateless goal whose `ready-to-merge`
			// can never pass. The legacy "no workflowId, no workflowStore →
			// workflow undefined" path below is preserved for assistant
			// sessions and test fixtures.
			throw new Error(
				`GoalManager.createGoal: workflowId="${workflowId}" given but neither resolvedWorkflow nor workflowStore was provided. This is Lesson 4.3 — see docs/_phase-1-notes.md.`,
			);
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
		}
	}

	/**
	 * Phase 2 — resolve the start point for a child goal's worktree branch.
	 * Returns `parent.branch` when the goal is a child (parentGoalId set
	 * AND the parent has a branch). Returns undefined for top-level goals,
	 * for orphan rows where the parent is missing, and for parents without
	 * a branch (no-worktree assistant goals etc.) — falling back to the
	 * existing default-of-origin/master behaviour.
	 */
	private _resolveChildBaseBranch(goal: PersistedGoal): string | undefined {
		if (!goal.parentGoalId) return undefined;
		const parent = this.store.get(goal.parentGoalId);
		if (!parent || !parent.branch) {
			console.warn(
				`[goal-manager] Child goal ${goal.id} has parentGoalId="${goal.parentGoalId}" but parent has no branch — falling back to origin/master`,
			);
			return undefined;
		}
		return parent.branch;
	}

	private async _doSetupWorktree(goal: PersistedGoal): Promise<void> {
		// Compute subdirectory offset: the difference between the preliminary
		// worktreePath (repo root level) and goal.cwd (which may include offset).
		const preliminaryOffset = goal.worktreePath ? path.relative(goal.worktreePath, goal.cwd) : "";

		// Phase 2 (nested goals): when this goal has a parent, the child's
		// branch MUST be created off the parent's branch HEAD so siblings
		// spawned later see prior siblings' commits. The pool pre-builds off
		// master/primary, so we skip the pool entirely for children — a
		// claim from the pool would yield a worktree without the parent's
		// commits. See SUBGOALS-SPEC §3.2 + the user-reversed §3.4 (sandbox
		// MUST work). The same baseBranch flows into both the host
		// `createWorktree` path AND any future ProjectSandbox.createWorktree
		// path; sandbox createWorktree already accepts a `baseBranch` arg.
		const childBaseBranch = this._resolveChildBaseBranch(goal);

		// Pool-first (Phase 3): claim a pre-built worktree if one is available.
		// On success this is observably as fast as session start (~tens of ms).
		// On failure or empty pool we fall through to the legacy createWorktree path.
		// SKIPPED for child goals — see comment above.
		const pool = childBaseBranch ? null : this.poolResolver?.();
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
					const set = await createWorktreeSet(goal.repoPath!, components, goal.branch!, childBaseBranch, { worktreeRoot: worktreeRootOverride });
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
				const result = await createWorktree(goal.repoPath!, goal.branch!, { worktreeRoot: worktreeRootOverride, startPoint: childBaseBranch });
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

	/**
	 * Locally merge a child goal's branch into its parent's branch and
	 * (best-effort) push the parent branch to origin so siblings spawned
	 * later see the latest tip and CI picks up the merge.
	 *
	 * Phase 2 of nested goals. Wraps `mergeChildBranchLocal` from
	 * `skills/git.ts`. Caller (Phase 3 `runSubgoalStep`) is responsible for
	 * archiving + tearing down the child afterwards via
	 * `archiveGoalAfterMerge`.
	 *
	 * Security invariant: `child.parentGoalId === parentGoalId` MUST hold.
	 * Mismatch throws — prevents cross-tree merges (e.g. spec drift, cycle
	 * leakage, or a UI bug pointing at the wrong child).
	 *
	 * Push failure is non-fatal: the parent branch tip is still updated
	 * locally so the next agent that fetches will pick it up. We surface
	 * `pushError` so callers can log it.
	 */
	async mergeChild(parentGoalId: string, childGoalId: string): Promise<MergeChildOutcome> {
		const parent = this.store.get(parentGoalId);
		const child = this.store.get(childGoalId);
		if (!parent) {
			throw new Error(`mergeChild: parent goal not found: ${parentGoalId}`);
		}
		if (!child) {
			throw new Error(`mergeChild: child goal not found: ${childGoalId}`);
		}
		if (child.parentGoalId !== parentGoalId) {
			// Structured error so REST handlers can return 400 instead of 500.
			const err = new Error(
				`mergeChild: child ${childGoalId} has parentGoalId="${child.parentGoalId}", expected "${parentGoalId}"`,
			);
			(err as any).code = "PARENT_MISMATCH";
			throw err;
		}
		if (!parent.branch || !child.branch) {
			throw new Error(
				`mergeChild: missing branch — parent="${parent.branch}", child="${child.branch}"`,
			);
		}

		// Resolve parentCwd: prefer the primary repo's worktree path. In
		// multi-repo mode, repoWorktrees["."] is the canonical "primary"
		// repo path; in single-repo mode worktreePath is authoritative.
		const parentCwd = parent.repoWorktrees?.["."] ?? parent.worktreePath;
		if (!parentCwd) {
			throw new Error(`mergeChild: parent ${parentGoalId} has no worktreePath`);
		}

		const result = await mergeChildBranchLocal(parent.branch, child.branch, parentCwd);

		const outcome: MergeChildOutcome = { ...result, pushed: false };

		// Push parent branch to origin so siblings spawned later see the
		// merge tip. Push is best-effort and gated by shouldSkipRemotePush
		// (BOBBIT_TEST_NO_PUSH=1 in test mode). Skip on conflict — there's
		// nothing new to push and we want the worktree to stay diagnostic.
		if (!result.conflict && (result.merged || result.alreadyMerged) && !shouldSkipRemotePush()) {
			try {
				await pExecFile("git", ["push", "origin", parent.branch], { cwd: parentCwd, timeout: 30_000 });
				outcome.pushed = true;
			} catch (err) {
				outcome.pushError = err instanceof Error ? err.message : String(err);
				console.warn(`[goal-manager] mergeChild: push of "${parent.branch}" failed (non-fatal):`, outcome.pushError);
			}
		}

		return outcome;
	}

	/**
	 * Archive a child goal after its branch has been merged into its parent.
	 *
	 * Order is load-bearing (Lesson 4.2 rescue path):
	 *   1. Stamp `state: "complete"` on the live record FIRST so the
	 *      archived snapshot has state=complete on disk. The harness
	 *      short-circuits on `archived && state === "complete"` and
	 *      returns success terminal — without this stamp the rescue path
	 *      reads `state="in-progress"` on a stale record and re-spawns.
	 *   2. Archive (soft-delete) — sets archived=true / archivedAt.
	 *   3. (Caller may invoke teamManager.teardownTeam afterwards; this
	 *      method is a pure data-layer operation.)
	 *
	 * Idempotent: safe to call twice — a second invocation finds the row
	 * already complete + archived and silently returns.
	 */
	async archiveGoalAfterMerge(childId: string): Promise<void> {
		const goal = this.store.get(childId);
		if (!goal) {
			console.warn(`[goal-manager] archiveGoalAfterMerge: child ${childId} not found`);
			return;
		}
		// Idempotent — already complete and archived.
		if (goal.archived && goal.state === "complete") {
			return;
		}

		// 1. State first.
		if (goal.state !== "complete") {
			this.store.update(childId, { state: "complete" });
		}
		// 2. Archive.
		if (!goal.archived) {
			await this.archiveGoal(childId);
		}
		console.log(`[goal-manager] archiveGoalAfterMerge: child ${childId} complete + archived`);
	}

	/**
	 * Boot-time migration: backfill `state: "complete"` on archived goals
	 * whose `ready-to-merge` gate is in the `passed` state. Closes the
	 * Lesson 4.2 gap on records produced by code paths that pre-date
	 * `archiveGoalAfterMerge`.
	 *
	 * Idempotent — only writes when the record is missing the stamp.
	 * Wrapped in per-goal try/catch so one corrupt record cannot crash
	 * boot (Lesson 4.11 — "endless restart" guard).
	 */
	backfillCompleteState(gateStore: GateStore): { backfilled: number; skipped: number } {
		let backfilled = 0;
		let skipped = 0;
		for (const goal of this.store.getAll()) {
			try {
				if (goal.archived !== true) { skipped++; continue; }
				if (goal.state === "complete") { skipped++; continue; }
				const rtm = gateStore.getGate(goal.id, "ready-to-merge");
				if (!rtm || rtm.status !== "passed") { skipped++; continue; }
				this.store.update(goal.id, { state: "complete" });
				backfilled++;
				console.log(`[goal-manager] Backfilled state=complete for legacy archived goal ${goal.id}`);
			} catch (err) {
				console.warn(`[goal-manager] backfillCompleteState: skipped goal ${goal.id} due to error:`, err);
				skipped++;
			}
		}
		return { backfilled, skipped };
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

	/**
	 * Resolve the per-tree concurrency cap consulted by `runSubgoalStep` when
	 * acquiring a semaphore slot before spawning a child. Reads
	 * `maxConcurrentChildren` off the root goal record.
	 *
	 * Defaults: unset / unknown root → 3. Hard max: 8 (defensive cap on user
	 * input). Floor: 1 (never zero — would deadlock the harness).
	 *
	 * See SUBGOALS-SPEC §3.5.
	 */
	resolveRootMaxConcurrentChildren(rootGoalId: string): number {
		const root = this.store.get(rootGoalId);
		if (!root) return 3;
		const raw = root.maxConcurrentChildren ?? 3;
		return Math.max(1, Math.min(8, raw));
	}

	async updateGoal(id: string, updates: {
		title?: string;
		cwd?: string;
		state?: GoalState;
		spec?: string;
		team?: boolean;
		repoPath?: string;
		branch?: string;
		reattemptOf?: string;
		projectId?: string;
		autoStartTeam?: boolean;
		// Phase 3 nested-goals fields (Lesson 4.1 — must be settable
		// immediately after createGoal in runSubgoalStep).
		spawnedFromPlanId?: string;
		paused?: boolean;
		replanCount?: number;
		divergencePolicy?: "strict" | "balanced" | "autonomous";
		maxConcurrentChildren?: number;
		acceptanceCriteria?: string[];
	}): Promise<boolean> {
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
