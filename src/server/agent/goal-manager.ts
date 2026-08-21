import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GoalStore, type GoalState, type PersistedGoal } from "./goal-store.js";
import { createWorktree, createWorktreeSet, isGitRepo, getRepoRoot, mergeChildBranchLocal, type MergeChildResult, type RemoteGitPolicy } from "../skills/git.js";
import { resolveWorktreeSupport } from "./worktree-support.js";
import { normalizeWorkflow, type WorkflowStore, type Workflow } from "./workflow-store.js";
import type { WorktreePool } from "./worktree-pool.js";
import type { Component } from "./project-config-store.js";
import type { GateStore } from "./gate-store.js";
import type { TeamStore } from "./team-store.js";
import type { SessionStore } from "./session-store.js";
import { isWorktreePathReferencedByLiveSession, type WorktreeReferenceRecord } from "./worktree-reference-guard.js";
import { cleanupGateDiagnosticsForGoal } from "./gate-diagnostics-cleanup.js";
import { resolveSetupTimeoutMs } from "../skills/worktree-setup.js";
import { resolveGoalMetadata, type GoalMetadata } from "./goal-metadata.js";
import { realClock, realCommandRunner, type Clock, type CommandRunner } from "../gateway-deps.js";
import { isHeadquartersProject } from "./project-registry.js";

/** Final worktree paths produced by provisioning, before the goalProvisioned hook + ready flip. */
type ProvisionedWorktree = {
	worktreePath: string;
	cwd: string;
	repoWorktrees?: Record<string, string>;
};

/**
 * Context passed to the injected `goalProvisioned` dispatcher. The server
 * wires this to LifecycleHub so the hook can run arbitrary extension code with
 * the goal's resolved metadata at every worktree provisioning point.
 */
export interface GoalProvisionedContext {
	goalId: string;
	projectId?: string;
	worktreePath: string;
	cwd: string;
	branch?: string;
	metadata: GoalMetadata;
}

/**
 * Canonical workspace coordinates supplied only by the owner-scoped session
 * promotion path. GoalManager copies them verbatim and never provisions,
 * renames, sets up, or assumes ownership of the checkout.
 */
export interface AdoptedGoalWorkspace {
	ownerSessionId: string;
	cwd: string;
	worktreePath: string;
	branch: string;
	repoPath: string;
	repoWorktrees?: Record<string, string>;
	sandboxed?: boolean;
}

function assertAdoptedGoalWorkspace(value: AdoptedGoalWorkspace): void {
	for (const field of ["ownerSessionId", "cwd", "worktreePath", "branch", "repoPath"] as const) {
		if (typeof value[field] !== "string" || value[field].length === 0) {
			throw new Error(`GoalManager.createGoal: adoptedWorkspace.${field} must be a non-empty string`);
		}
	}
	if (value.repoWorktrees !== undefined) {
		if (!value.repoWorktrees || Array.isArray(value.repoWorktrees)
			|| Object.values(value.repoWorktrees).some(pathValue => typeof pathValue !== "string" || pathValue.length === 0)) {
			throw new Error("GoalManager.createGoal: adoptedWorkspace.repoWorktrees must contain non-empty string paths");
		}
	}
	if (value.sandboxed !== undefined && typeof value.sandboxed !== "boolean") {
		throw new Error("GoalManager.createGoal: adoptedWorkspace.sandboxed must be boolean");
	}
}

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

/** Defensive cap on parent-chain walks. See deriveNestingFields(). */
export const NESTING_WALK_DEPTH_CAP = 64;

/** Outcome of locally merging a child goal into its parent. */
export interface MergeChildOutcome extends MergeChildResult {
	/** Per-component outcomes for multi-repo goals, keyed by component repo. */
	repos?: Record<string, MergeChildResult>;
}

/**
 * Derive nested-goal lineage. Walks the parent chain via `lookup`,
 * throws on cycle, caps at NESTING_WALK_DEPTH_CAP. Root: rootGoalId===id,
 * mergeTarget==="master". Child: parent's rootGoalId, mergeTarget==="parent".
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
	/**
	 * Authoritative per-goal setup transactions. Initial setup and retry callers
	 * join the same promise, so no caller can observe an in-progress setup as a
	 * reason to start a team early.
	 */
	private _setupsInFlight = new Map<string, Promise<void>>();
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
	/** Resolve the configured base ref (e.g. master) for a project. Used by
	 * setupWorktreeAndStartTeam to create the worktree from the right base
	 * branch. Set by server.ts on startup. */
	private baseRefResolver?: (projectId: string) => string | undefined;
	private liveSessionResolver?: () => WorktreeReferenceRecord[];
	private readonly diagnosticsStateDir?: string;
	private readonly commandRunner: CommandRunner;
	private readonly clock: Clock;
	private readonly remotePolicy: RemoteGitPolicy;
	private readonly worktreeSetupRuntime: { skipNpmCi?: boolean; recordSetupPath?: string };
	setBaseRefResolver(resolver: (projectId: string) => string | undefined): void {
		this.baseRefResolver = resolver;
	}
	/** Returns the configured base ref for a project, if set. */
	getBaseRef(projectId: string): string | undefined {
		return this.baseRefResolver?.(projectId);
	}

	setLiveSessionResolver(resolver: () => WorktreeReferenceRecord[]): void {
		this.liveSessionResolver = resolver;
	}

	/**
	 * Injected `goalProvisioned` dispatcher. Wired by the server to route into
	 * the shared LifecycleHub. Narrow seam so this data-layer module stays free
	 * of any LifecycleHub/extension-host import. When unset, provisioning is a
	 * no-op for the hook (current behaviour).
	 */
	private goalProvisionedDispatcher?: (ctx: GoalProvisionedContext) => Promise<void>;
	private goalArchiveReconciler?: (goalId: string) => Promise<unknown>;
	setGoalProvisionedDispatcher(dispatcher: (ctx: GoalProvisionedContext) => Promise<void>): void {
		this.goalProvisionedDispatcher = dispatcher;
	}

	/** Late-bound cross-store cleanup invoked only after archive intent is durable. */
	setGoalArchiveReconciler(reconciler: ((goalId: string) => Promise<unknown>) | undefined): void {
		this.goalArchiveReconciler = reconciler;
	}

	/**
	 * Resolve a goal's effective metadata by deep-merging its `parentGoalId`
	 * ancestry (descendant wins). Single source of truth — every consumption
	 * edge (providers/bridge, tools, prompt order, the goalProvisioned hook)
	 * reads this so a treatment can never leak across the goal/agent tree.
	 */
	getEffectiveGoalMetadata(goalId: string | undefined): GoalMetadata {
		return resolveGoalMetadata(this.store, goalId);
	}

	/**
	 * Dispatch the `goalProvisioned` lifecycle hook with the goal's resolved
	 * metadata. Runs at EVERY worktree provisioning (cold creation AND pool
	 * claims — both return through `_provisionGoalWorktree`) so filesystem
	 * treatments land on every worktree in the subtree, not once per goal.
	 * Non-fatal: errors are logged and swallowed so a hook failure never blocks
	 * goal start.
	 */
	private async _dispatchGoalProvisioned(goal: PersistedGoal, worktreePath: string, cwd: string): Promise<void> {
		if (!this.goalProvisionedDispatcher) return;
		try {
			await this.goalProvisionedDispatcher({
				goalId: goal.id,
				projectId: goal.projectId,
				worktreePath,
				cwd,
				branch: goal.branch,
				metadata: this.getEffectiveGoalMetadata(goal.id),
			});
		} catch (err) {
			console.warn(`[goal-manager] goalProvisioned dispatch failed for goal "${goal.title}" (non-fatal):`, err);
		}
	}

	private getSessionsForWorktreeGuard(): WorktreeReferenceRecord[] {
		if (this.liveSessionResolver) return this.liveSessionResolver();
		try {
			const storeDir = (this.store as unknown as { storeDir?: string }).storeDir;
			if (!storeDir) return [];
			const sessionFile = path.join(storeDir, "sessions.json");
			if (!fs.existsSync(sessionFile)) return [];
			const raw = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
			if (Array.isArray(raw)) return raw as WorktreeReferenceRecord[];
			if (Array.isArray(raw?.sessions)) return raw.sessions as WorktreeReferenceRecord[];
			if (raw && typeof raw === "object") return Object.values(raw).filter(Array.isArray).flat() as WorktreeReferenceRecord[];
		} catch {
			// Best-effort guard; missing/corrupt session store should not block archive.
		}
		return [];
	}

	private forceHeadquartersNoWorktree(goal: PersistedGoal): void {
		const live = this.store.get(goal.id) ?? goal;
		delete live.worktreePath;
		delete live.repoWorktrees;
		delete live.repoPath;
		delete live.branch;
		live.cwd = goal.projectId && this.projectRootResolver
			? this.projectRootResolver(goal.projectId) ?? live.cwd
			: live.cwd;
		// Field removals and ready are published in one whole-record update. GoalStore
		// enforces the canonical setup transition invariant for `put`, including
		// removal of a stale active setupError.
		live.setupStatus = "ready";
		this.store.put(live);
	}

	constructor(goalStore: GoalStore, workflowStore?: WorkflowStore, stateDir?: string, deps: { commandRunner?: CommandRunner; clock?: Clock; remotePolicy?: RemoteGitPolicy; worktreeSetupRuntime?: { skipNpmCi?: boolean; recordSetupPath?: string } } = {}) {
		this.store = goalStore;
		this.workflowStore = workflowStore;
		this.diagnosticsStateDir = stateDir ?? (goalStore as unknown as { storeDir?: string }).storeDir;
		this.commandRunner = deps.commandRunner ?? realCommandRunner;
		this.clock = deps.clock ?? realClock;
		this.remotePolicy = deps.remotePolicy ?? {};
		this.worktreeSetupRuntime = deps.worktreeSetupRuntime ?? {};
		// Lazy-migrate legacy paused=true + unresolved-deps goals to state='blocked'
		// BEFORE recovering stuck setups, so that newly-blocked goals don't get
		// their setupStatus incorrectly marked 'error'. See docs/design/pause-cascade.md.
		this._migratePausedDepsToBlocked();
		// Mark any goals stuck in "preparing" from a previous run as error.
		// Runs AFTER migration so that state='blocked' goals (which legitimately
		// have setupStatus='preparing' pending dep-resolution) are excluded.
		this._recoverStuckSetups();
	}

	/**
	 * Boot migration: legacy `paused: true` goals whose deps are still unmet
	 * become `state: 'blocked', paused: false`. Explicit operator pauses carry
	 * provenance and are preserved regardless of dependency state. Records without
	 * provenance retain the prior inference for backwards compatibility.
	 */
	private _migratePausedDepsToBlocked(): void {
		const all = this.store.getAll();
		for (const goal of all) {
			if (!goal.paused || goal.archived || goal.pauseSource === "operator") continue;
			const deps = goal.dependsOnPlanIds;
			if (!deps || deps.length === 0) continue;
			const allResolved = deps.every(depPid => {
				const depSib = all.find(g =>
					g.parentGoalId === goal.parentGoalId &&
					g.spawnedFromPlanId === depPid);
				return !!depSib && depSib.state === "complete";
			});
			if (allResolved) continue;
			this.store.update(goal.id, { state: "blocked", paused: false });
			console.log(`[goal-manager] Migrated goal ${goal.id} ("${goal.title}") from paused=true to state='blocked' (unresolved deps)`);
		}
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
	 * Wire a project-level default worktree-setup timeout resolver. Returns the
	 * project's `worktree_setup_timeout_ms` (number or numeric string, or
	 * undefined). Used as the middle tier in `resolveSetupTimeoutMs` between a
	 * per-goal override and the 120s default.
	 */
	private worktreeSetupTimeoutResolver?: (projectId: string) => number | string | undefined;
	setWorktreeSetupTimeoutResolver(resolver: (projectId: string) => number | string | undefined): void {
		this.worktreeSetupTimeoutResolver = resolver;
	}

	/**
	 * On startup, scan for goals stuck in setupStatus === "preparing" or
	 * "retrying" and mark them as "error" (setup was interrupted by restart).
	 */
	private _recoverStuckSetups(): void {
		for (const goal of this.store.getAll()) {
			if (goal.setupStatus === "preparing" || goal.setupStatus === "retrying") {
				if (isHeadquartersProject(goal.projectId)) {
					this.forceHeadquartersNoWorktree(goal);
					continue;
				}
				// Skip goals in state='blocked' — they legitimately have
				// setupStatus='preparing' while waiting for deps to merge.
				// Their setup will begin when integrate-child auto-unblocks them.
				if (goal.state === "blocked") continue;
				this.store.transitionSetup(goal.id, "error", "Setup interrupted by server restart");
				console.warn(`[goal-manager] Marked goal "${goal.title}" (${goal.id}) as error — setup was interrupted by server restart`);
			}
		}
	}

	/**
	 * Create a goal instantly — persists to disk and returns immediately.
	 * Does NOT create the worktree. Call setupWorktree() separately after responding.
	 */
	async createGoal(title: string, cwd: string, opts?: { spec?: string; workflowId?: string; workflowStore?: WorkflowStore; resolvedWorkflow?: Workflow; sandboxed?: boolean; enabledOptionalSteps?: string[]; projectId?: string; parentGoalId?: string; inlineRoles?: Record<string, import("./role-store.js").Role>; subgoalsAllowed?: boolean; maxNestingDepth?: number; divergencePolicy?: "strict" | "balanced" | "autonomous"; maxConcurrentChildren?: number; metadata?: Record<string, unknown>; worktree?: boolean; adoptedWorkspace?: AdoptedGoalWorkspace; team?: boolean }): Promise<PersistedGoal> {
		const { spec = "", workflowId, workflowStore = this.workflowStore, resolvedWorkflow, sandboxed, enabledOptionalSteps, projectId, parentGoalId, inlineRoles, subgoalsAllowed, maxNestingDepth, divergencePolicy, maxConcurrentChildren, metadata, adoptedWorkspace, team = true } = opts ?? {};
		const headquartersGoal = isHeadquartersProject(projectId);
		if (adoptedWorkspace) {
			assertAdoptedGoalWorkspace(adoptedWorkspace);
			if (headquartersGoal) {
				throw new Error("GoalManager.createGoal: headquarters sessions cannot adopt a worktree");
			}
		}
		const worktree = !headquartersGoal && opts?.worktree !== false;
		const now = Date.now();
		const id = randomUUID();

		// Derive rootGoalId / mergeTarget; prevent cycles. divergencePolicy /
		// maxConcurrentChildren are root-only (not inherited).
		const nesting = deriveNestingFields(id, parentGoalId, (gid) => this.store.get(gid));

		let worktreePath: string | undefined = adoptedWorkspace?.worktreePath;
		let branch: string | undefined = adoptedWorkspace?.branch;
		let repoPath: string | undefined = adoptedWorkspace?.repoPath;
		let goalCwd = adoptedWorkspace?.cwd ?? cwd;
		let setupStatus: "ready" | "preparing" = "ready";

		// Detect git repo root — needed for team operations even without a worktree.
		// Single source of truth shared with the session path (server.ts) and the
		// staff path (staff-manager.ts): a multi-repo project resolves to its
		// container root as `repoPath` (per-repo worktrees land beneath one shared
		// `<rootPath>-wt/<branch>/`) ONLY when at least one component is a git repo
		// root; otherwise it falls back to the single-repo `isGitRepo(cwd)` probe,
		// and to no-worktree when that also fails (never throws).
		if (!headquartersGoal && !adoptedWorkspace) {
			const components = projectId && this.componentsResolver ? this.componentsResolver(projectId) : undefined;
			const projectRoot = projectId && this.projectRootResolver ? this.projectRootResolver(projectId) : undefined;
			const configuredBaseRef = projectId && this.baseRefResolver ? this.baseRefResolver(projectId) : undefined;
			const support = await resolveWorktreeSupport(components ?? [], projectRoot, cwd, undefined, { configuredBaseRef, commandRunner: this.commandRunner });
			if (support.supported) repoPath = support.repoPath;
		}

		// Compute worktree path and branch (but don't create yet)
		if (!adoptedWorkspace && worktree && repoPath) {
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
			...(adoptedWorkspace ? {
				worktreeOwnerSessionId: adoptedWorkspace.ownerSessionId,
				repoWorktrees: adoptedWorkspace.repoWorktrees
					? structuredClone(adoptedWorkspace.repoWorktrees)
					: undefined,
			} : {}),
			branch,
			repoPath,
			team,
			setupStatus,
			sandboxed: adoptedWorkspace ? adoptedWorkspace.sandboxed : sandboxed,
		};

		// Stamp projectId so subgoals don't need a parentGoalId-chain walk.
		if (projectId) {
			goal.projectId = projectId;
		}

		if (enabledOptionalSteps?.length) {
			goal.enabledOptionalSteps = enabledOptionalSteps;
		}

		// Snapshot inline roles onto the goal (freeze-at-creation, deep-clone).
		// resolveRole() reads this snapshot first.
		if (inlineRoles && Object.keys(inlineRoles).length > 0) {
			goal.inlineRoles = structuredClone(inlineRoles);
		}

		// Per-goal subgoal-nesting overrides. Stored as-is; the policy module
		// (subgoal-nesting-limit.ts) computes the effective ceiling at
		// spawn-time so the system pref can never be exceeded.
		if (subgoalsAllowed !== undefined) goal.subgoalsAllowed = subgoalsAllowed;
		if (maxNestingDepth !== undefined && Number.isFinite(maxNestingDepth)) {
			goal.maxNestingDepth = maxNestingDepth;
		}

		// Per-goal metadata (arbitrary, namespaced keys). Persist only a non-empty
		// plain object (deep-cloned to freeze it at creation); absent metadata
		// preserves today's behaviour byte-for-byte at every edge.
		if (metadata && typeof metadata === "object" && !Array.isArray(metadata) && Object.keys(metadata).length > 0) {
			goal.metadata = structuredClone(metadata);
		}

		// Root-only orchestration policy. divergencePolicy and
		// maxConcurrentChildren are tree-wide concepts owned by the root
		// (resolved at the root for the per-root scheduler/semaphore), so they
		// are only stamped when this goal IS the root (no parent). Children
		// inherit the root's values at resolve-time and must not carry their own.
		const isRoot = nesting.parentGoalId === undefined;
		if (isRoot && divergencePolicy !== undefined) {
			goal.divergencePolicy = divergencePolicy;
		}
		if (isRoot && maxConcurrentChildren !== undefined && Number.isFinite(maxConcurrentChildren)) {
			goal.maxConcurrentChildren = Math.max(1, Math.min(8, Math.floor(maxConcurrentChildren)));
		}

		// Stamp nested-goal lineage. Root: rootGoalId===id, mergeTarget==="master".
		// Child: inherits parent's rootGoalId, mergeTarget==="parent".
		if (nesting.parentGoalId !== undefined) {
			goal.parentGoalId = nesting.parentGoalId;
		}
		goal.rootGoalId = nesting.rootGoalId;
		goal.mergeTarget = nesting.mergeTarget;

		// Snapshot workflow onto goal. Resolution order:
		//   1. Caller passed `resolvedWorkflow` (from config cascade) — use it.
		//   2. Caller passed `workflowId` only — read from the inline workflow store.
		//   3. Neither — fall back to the first workflow in the store
		//      (insertion order preserves config-cascade priority).
		// `normalizeWorkflow` converts snake_case inline workflows to
		// runtime camelCase — critical for gate_signal (see AGENTS.md
		// "gateDef.dependsOn is not iterable").
		// If we can't resolve a workflow at all, throw a clear error so
		// `POST /api/goals` surfaces a 400 instead of silently creating a
		// gateless goal. See docs/design/multi-repo-components.md §3.4.
		const NO_WORKFLOWS_MSG =
			"This project has no workflows configured. Run project setup or generate workflows from Settings → project tab.";
		if (workflowId && resolvedWorkflow) {
			const normalized = normalizeWorkflow(resolvedWorkflow, workflowId) ?? resolvedWorkflow;
			goal.workflowId = workflowId;
			goal.workflow = structuredClone(normalized);
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
			goal.workflow = structuredClone(wf);
		} else if (workflowId) {
			// workflowId given but no resolvedWorkflow or workflowStore: fail
			// loudly instead of producing a gateless goal. The "no workflowId,
			// no workflowStore → workflow undefined" path below is preserved
			// for assistant sessions and test fixtures.
			throw new Error(
				`GoalManager.createGoal: workflowId="${workflowId}" given but neither resolvedWorkflow nor workflowStore was provided. This is WorkflowStore-required invariant — see docs/_phase-1-notes.md.`,
			);
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

		await this.store.putStrict(goal);
		return goal;
	}

	/**
	 * Async worktree setup — called after createGoal() returns. Every caller for
	 * a goal joins the same transaction, including retry callers, and receives
	 * its real success/failure rather than a premature no-op.
	 */
	setupWorktree(goalId: string): Promise<void> {
		const active = this._setupsInFlight.get(goalId);
		if (active) return active;

		// Install the promise before executing setup. Promise.resolve().then()
		// defers execution one microtask so a same-turn duplicate joins even if a
		// setup implementation performs synchronous work before its first await.
		const setup = Promise.resolve().then(() => this._runSetupWorktree(goalId));
		this._setupsInFlight.set(goalId, setup);
		void setup.then(
			() => { if (this._setupsInFlight.get(goalId) === setup) this._setupsInFlight.delete(goalId); },
			() => { if (this._setupsInFlight.get(goalId) === setup) this._setupsInFlight.delete(goalId); },
		);
		return setup;
	}

	private async _runSetupWorktree(goalId: string): Promise<void> {
		const goal = this.store.get(goalId);
		if (!goal) {
			throw new Error(`Goal ${goalId} not found or missing repo/branch info`);
		}
		if (isHeadquartersProject(goal.projectId)) {
			this.forceHeadquartersNoWorktree(goal);
			return;
		}
		if (goal.setupStatus === "ready") return;
		if (goal.setupStatus === "error") {
			throw new Error(`Goal ${goalId} setup is in error; retry it before starting a team`);
		}

		try {
			if (!goal.repoPath || !goal.branch) {
				throw new Error(`Goal ${goalId} not found or missing repo/branch info`);
			}
			await this._doSetupWorktree(goal);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// A setup transaction owns the active diagnostic. This overwrites any
			// stale failure only when the current transaction actually failed.
			await this.store.transitionSetupStrict(goalId, "error", message || "Worktree setup failed");
			throw err;
		}
	}

	/**
	 * Resolve the start-point branch for a child goal. Returns
	 * `parent.branch` for children with a branched parent; undefined for
	 * top-level goals, orphan rows, or branchless parents (assistant
	 * goals) — the warn-and-fallback for the latter is the bug-prevention
	 * path; do not collapse.
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

		// Provision the worktree (pool claim, or create + per-component setup).
		// _provisionGoalWorktree owns the retry loop; the goalProvisioned hook runs
		// ONCE afterward, outside that loop, so a hook failure never re-creates the
		// worktree.
		const provisioned = await this._provisionGoalWorktree(goal, preliminaryOffset);
		if (provisioned === "no-worktree") return;

		// Dispatch the goalProvisioned lifecycle hook with resolved metadata. Runs
		// at every provisioning (incl. pool claims, which return through
		// _provisionGoalWorktree above) so metadata-driven filesystem treatments
		// land on every worktree in the subtree. Non-fatal — never blocks start.
		await this._dispatchGoalProvisioned(goal, provisioned.worktreePath, provisioned.cwd);

		// This is the sole ready publication for a provisioned worktree. Strict
		// persistence makes the verified state durable before a caller may start a
		// Team Lead, and transitionSetupStrict atomically removes any stale error.
		await this.store.transitionSetupStrict(goal.id, "ready", {
			worktreePath: provisioned.worktreePath,
			cwd: provisioned.cwd,
			repoWorktrees: provisioned.repoWorktrees,
		});
		console.log(`[goal-manager] Worktree ready for goal "${goal.title}": ${provisioned.worktreePath} (branch: ${goal.branch})`);
	}

	/**
	 * Resolve the worktree-setup timeout: per-goal override → project
	 * `worktree_setup_timeout_ms` → the 120s default. Single source of truth
	 * for both per-component and per-goal setup timeouts.
	 */
	private resolveGoalSetupTimeout(goal: PersistedGoal): number {
		const projectTimeoutMs = goal.projectId && this.worktreeSetupTimeoutResolver
			? this.worktreeSetupTimeoutResolver(goal.projectId)
			: undefined;
		return resolveSetupTimeoutMs({ projectTimeoutMs });
	}

	/**
	 * Provision the goal's worktree: claim from the pool, or create it (single-
	 * or multi-repo) running per-component setup, retrying only worktree
	 * creation. Returns the final paths WITHOUT flipping setupStatus to "ready"
	 * (the caller does that after the goalProvisioned hook). Returns "no-worktree" when
	 * no worktree-able repo remained (already restored to the no-worktree
	 * state). Throws after all attempts fail; the authoritative transaction
	 * records setupStatus:"error" at its outer boundary.
	 */
	private async _provisionGoalWorktree(goal: PersistedGoal, preliminaryOffset: string): Promise<ProvisionedWorktree | "no-worktree"> {
		if (isHeadquartersProject(goal.projectId)) {
			this.forceHeadquartersNoWorktree(goal);
			return "no-worktree";
		}

		// Resolved timeout for per-component setup commands run here.
		const setupTimeoutMs = this.resolveGoalSetupTimeout(goal);

		// Child goals branch off the parent's HEAD so siblings see prior
		// siblings' commits. The pool pre-builds off master, so we skip the
		// pool for children (a pool claim would lack the parent's commits).
		const childBaseBranch = this._resolveChildBaseBranch(goal);

		// Pool-first: claim a pre-built worktree (skipped for children).
		const pool = childBaseBranch ? null : this.poolResolver?.();
		if (pool) {
			try {
				const claim = await pool.claim(goal.branch!);
				if (claim) {
					const offsetCwd = preliminaryOffset && preliminaryOffset !== "."
						? path.join(claim.worktreePath, preliminaryOffset)
						: claim.worktreePath;
					const repoWorktrees = claim.worktrees && claim.worktrees.length > 0
						? Object.fromEntries(claim.worktrees.map(w => [w.repo, w.worktreePath]))
						: undefined;
					console.log(`[goal-manager] Worktree claimed from pool for goal "${goal.title}": ${claim.worktreePath} (branch: ${goal.branch}${claim.degraded ? ", degraded" : ""})`);
					// Pool fill already ran per-component setup; the goalProvisioned
					// hook is goal-specific and still runs (caller) before ready flips.
					return { worktreePath: claim.worktreePath, cwd: offsetCwd, repoWorktrees };
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
					const set = await createWorktreeSet(goal.repoPath!, components, goal.branch!, childBaseBranch, { worktreeRoot: worktreeRootOverride, configuredBaseRef, commandRunner: this.commandRunner, remotePolicy: this.remotePolicy });
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
						return "no-worktree";
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
							timeoutMs: setupTimeoutMs,
							skipNpmCi: this.worktreeSetupRuntime.skipNpmCi,
							recordSetupPath: this.worktreeSetupRuntime.recordSetupPath,
							execHandlesTimeout: true,
							exec: async (cmd, cwd, env, timeoutMs) => {
								await execShellCommand(cmd, { cwd, env, timeout: timeoutMs });
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
					console.log(`[goal-manager] Multi-repo worktree set provisioned for goal "${goal.title}" at ${set.container}`);
					return { worktreePath: set.container, cwd: offsetCwd, repoWorktrees };
				}
				const result = await createWorktree(goal.repoPath!, goal.branch!, { worktreeRoot: worktreeRootOverride, startPoint: childBaseBranch, configuredBaseRef, commandRunner: this.commandRunner, remotePolicy: this.remotePolicy });
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
							timeoutMs: setupTimeoutMs,
							skipNpmCi: this.worktreeSetupRuntime.skipNpmCi,
							recordSetupPath: this.worktreeSetupRuntime.recordSetupPath,
							execHandlesTimeout: true,
							exec: async (cmd, cwd, env, timeoutMs) => {
								await execShellCommand(cmd, { cwd, env, timeout: timeoutMs });
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
				console.log(`[goal-manager] Worktree provisioned for goal "${goal.title}": ${result.worktreePath} (branch: ${goal.branch})`);
				return { worktreePath: result.worktreePath, cwd: offsetCwd };
			} catch (err) {
				lastError = err;
				console.error(`[goal-manager] Worktree setup attempt ${attempt + 1} failed for goal "${goal.title}":`, err);
				if (attempt === 0) {
					// Brief delay before retry
					await new Promise<void>(resolve => this.clock.setTimeout(() => resolve(), 1000));
				}
			}
		}

		// Both attempts failed. `_runSetupWorktree` records the single current
		// diagnostic so all failure paths use the same canonical transition.
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
		this.store.transitionSetup(goal.id, "ready", { cwd: originalCwd });
	}

	/**
	 * Setup worktree then start team. Used when autoStartTeam is enabled.
	 * Uses a callback to avoid circular dependency with TeamManager.
	 */
	async setupWorktreeAndStartTeam(goalId: string, startTeamFn: () => Promise<any>): Promise<void> {
		await this.setupWorktree(goalId);
		// Do not trust the object read before setup — another lifecycle operation
		// may have archived, paused, or failed it while provisioning was awaited.
		// The ready transition itself is a strict persistence boundary.
		const verified = this.store.get(goalId);
		if (!verified || verified.setupStatus !== "ready") {
			throw new Error(`Goal ${goalId} setup did not reach verified ready; refusing to start team`);
		}
		await startTeamFn();
	}

	/**
	 * Enter retrying state for a failed setup. Concurrent retry requests are
	 * accepted while retrying/preparing so each route invocation joins the
	 * per-goal setup promise instead of reporting a misleading conflict.
	 */
	retrySetup(goalId: string): boolean {
		const goal = this.store.get(goalId);
		if (!goal) return false;
		if (goal.setupStatus === "retrying" || (goal.setupStatus === "preparing" && this._setupsInFlight.has(goalId))) {
			return true;
		}
		if (goal.setupStatus !== "error") return false;
		this.store.transitionSetup(goalId, "retrying");
		return true;
	}

	/**
	 * Locally merge a child's branch into its parent's branch (child goals
	 * merge LOCALLY into parent branch — no PR and no remote publication).
	 * Publication, when explicitly requested elsewhere, is a separate operation.
	 *
	 * Multi-repo component repositories merge sequentially and expose each result
	 * in `repos`. If a later component conflicts, an earlier component may remain
	 * successfully merged locally: successful merges are not destructively rolled
	 * back. The child remains live so callers can repair the conflict and retry.
	 *
	 * Security invariant: `child.parentGoalId === parentGoalId` MUST hold;
	 * mismatch throws PARENT_MISMATCH (prevents cross-tree merges).
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
			const err = new Error(
				`mergeChild: missing branch — parent="${parent.branch}", child="${child.branch}"`,
			);
			(err as any).code = "GOAL_GIT_UNAVAILABLE";
			throw err;
		}

		const parentRepoWorktrees = parent.repoWorktrees;
		const childRepoWorktrees = child.repoWorktrees;
		if (parentRepoWorktrees && Object.keys(parentRepoWorktrees).length > 0) {
			const matchingRepos = childRepoWorktrees
				? Object.keys(parentRepoWorktrees).filter(repo => !!childRepoWorktrees[repo])
				: [];
			if (matchingRepos.length === 0) {
				const err = new Error(`mergeChild: parent and child have no matching repository worktrees`);
				(err as any).code = "GOAL_GIT_UNAVAILABLE";
				throw err;
			}

			const repos: Record<string, MergeChildResult> = {};
			for (const repo of matchingRepos) {
				repos[repo] = await mergeChildBranchLocal(
					parent.branch,
					child.branch,
					parentRepoWorktrees[repo],
					this.commandRunner,
					this.remotePolicy,
				);
			}
			const results = Object.values(repos);
			const conflict = results.some(result => result.conflict);
			const allTerminal = results.every(result => result.merged || result.alreadyMerged);
			return {
				merged: !conflict && allTerminal && results.some(result => result.merged),
				alreadyMerged: !conflict && results.every(result => result.alreadyMerged),
				conflict,
				output: matchingRepos
					.map(repo => `[${repo}] ${repos[repo].output}`.trimEnd())
					.join("\n"),
				repos,
			};
		}

		if (!parent.worktreePath) {
			const err = new Error(`mergeChild: parent ${parentGoalId} has no worktreePath`);
			(err as any).code = "GOAL_GIT_UNAVAILABLE";
			throw err;
		}

		return mergeChildBranchLocal(parent.branch, child.branch, parent.worktreePath, this.commandRunner, this.remotePolicy);
	}

	/**
	 * Archive a child goal after its branch has been merged into its parent.
	 *
	 * Order is load-bearing (stale-pointer invalidation rescue path):
	 *   1. Stamp `state: "complete"` on the live record FIRST so the
	 *      archived snapshot has state=complete on disk. The harness
	 *      short-circuits on `archived && state === "complete"` and
	 *      returns success terminal — without this stamp the rescue path
	 *      reads `state="in-progress"` on a stale record and re-spawns.
	 *   2. Archive (soft-delete) — sets archived=true / archivedAt and invokes
	 *      the authoritative team reconciliation boundary. Callers must not
	 *      destructively tear down the team before this boundary snapshots it.
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
		// 1. State first, through the same strict completion boundary as direct
		// team completion so the durable goalCompleted fact cannot be skipped.
		if (goal.state !== "complete") {
			await this.updateGoal(childId, { state: "complete" });
		}
		// 2. Archive. Always replay the boundary for an already-archived child:
		// a prior crash may have committed goal intent but not session cleanup.
		await this.archiveGoal(childId);
		console.log(`[goal-manager] archiveGoalAfterMerge: child ${childId} complete + archived`);
	}

	/**
	 * Boot-time backfill: stamp state="complete" on archived goals whose
	 * `ready-to-merge` gate already passed. Idempotent; per-goal try/catch.
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

	/**
	 * Boot-time backfill: stamp `spawnedBySessionId` on legacy sub-goals.
	 * Lookup: (1) parent team's `teamLeadSessionId`; (2) sessionStore
	 * fallback (single team-lead match only — ambiguous parents skipped).
	 * Idempotent; per-goal try/catch.
	 */
	backfillSpawnedBySessionId(teamStore: TeamStore, sessionStore?: SessionStore): { backfilled: number; skipped: number } {
		let backfilled = 0;
		let skipped = 0;
		for (const goal of this.store.getAll()) {
			try {
				if (!goal.parentGoalId) { skipped++; continue; }
				if (goal.spawnedBySessionId) { skipped++; continue; }
				let tlSession: string | undefined = teamStore.get(goal.parentGoalId)?.teamLeadSessionId ?? undefined;
				if (!tlSession && sessionStore) {
					const candidates = sessionStore.getAll().filter(s =>
						s.role === "team-lead"
						&& (s.teamGoalId === goal.parentGoalId || s.goalId === goal.parentGoalId)
					);
					if (candidates.length === 1) {
						tlSession = candidates[0].id;
					}
				}
				if (!tlSession) { skipped++; continue; }
				this.store.update(goal.id, { spawnedBySessionId: tlSession });
				backfilled++;
				console.log(`[goal-manager] Backfilled spawnedBySessionId=${tlSession} for legacy sub-goal ${goal.id}`);
			} catch (err) {
				console.warn(`[goal-manager] backfillSpawnedBySessionId: skipped goal ${goal.id} due to error:`, err);
				skipped++;
			}
		}
		return { backfilled, skipped };
	}

	async archiveGoal(id: string): Promise<boolean> {
		const goal = this.store.get(id);
		if (!goal) return false;
		// Publish terminal intent exactly once and durably before any cross-store
		// cleanup. archiveStrict rolls memory back on persistence failure, and also
		// publishes adopted-goal archival before its promoted lead is terminated.
		const archived = await this.store.archiveStrict(id);
		let reconciledTeamOwnership = false;
		if (archived) {
			try {
				await cleanupGateDiagnosticsForGoal(id, this.diagnosticsStateDir);
			} catch (err) {
				console.warn(`[goal-manager] Failed to clean gate diagnostics for archived goal ${id}:`, err);
			}
			try {
				const result = await this.goalArchiveReconciler?.(id) as {
					archivedSessionIds?: unknown[];
					suppressedSessionIds?: unknown[];
					teamRemoved?: boolean;
					teamEntryRetained?: boolean;
				} | undefined;
				reconciledTeamOwnership = !!result && (
					(result.archivedSessionIds?.length ?? 0) > 0
					|| (result.suppressedSessionIds?.length ?? 0) > 0
					|| result.teamRemoved === true
					|| result.teamEntryRetained === true
				);
			} catch (err) {
				// A failed reconciliation may already have selected team-owned evidence;
				// conservatively leave goal worktrees for the retry/purge lifecycle.
				reconciledTeamOwnership = true;
				// Archive is already committed. Cleanup remains reconstructable from
				// teamGoalId/team-state and must never roll back a successful merge.
				console.error(`[goal-manager] Archived-goal reconciliation blocked for ${id}:`, err);
			}
		}
		// Multi-repo cleanup: best-effort per-repo worktree + remote-branch
		// removal for standalone goals. Durable team mode remains authoritative
		// recovery evidence after reconciliation removes every live session/team
		// row, so retries must never fall back to generic destructive cleanup.
		if (archived && goal.team !== true && !reconciledTeamOwnership && goal.repoWorktrees && goal.repoPath && goal.branch && Object.keys(goal.repoWorktrees).length > 0) {
			const { cleanupWorktree } = await import("../skills/git.js");
			const entries = Object.entries(goal.repoWorktrees);
			const sessions = this.getSessionsForWorktreeGuard();
			Promise.allSettled(entries.map(([repo, wt]) => {
				if (isWorktreePathReferencedByLiveSession(wt, sessions)) {
					console.log(`[goal-manager] Skipping shared goal worktree cleanup for archived goal ${goal.id}: ${wt}`);
					return Promise.resolve();
				}
				const repoPath = repo === "." ? goal.repoPath! : path.join(goal.repoPath!, repo);
				return cleanupWorktree(repoPath, wt, goal.branch, true, this.commandRunner, this.remotePolicy);
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

	/** Expose the underlying store. */
	getGoalStore(): GoalStore {
		return this.store;
	}

	listGoals(): PersistedGoal[] {
		return this.store.getAll();
	}

	/**
	 * Per-tree concurrency cap for `runSubgoalStep`. Reads root's
	 * `maxConcurrentChildren`. Defaults: 5 (single source of truth for the
	 * unset default — the proposal panel only stores a value when the user
	 * overrides it, so an absent field must resolve to the same default here).
	 *
	 * C4: the result is ALWAYS an integer in [1, 8]. A fractional stored
	 * value (e.g. `1.5`) is floored before clamping so it can never let an
	 * extra child slip through the per-root semaphore (`Math.floor(1.5) === 1`).
	 * `Math.floor` runs before the clamp so a value like `8.9` floors to `8`
	 * (in-range) rather than being rejected. `NaN` falls back to the floor `1`.
	 */
	resolveRootMaxConcurrentChildren(rootGoalId: string): number {
		const root = this.store.get(rootGoalId);
		if (!root) return 5;
		const raw = Math.floor(Number(root.maxConcurrentChildren ?? 5));
		if (!Number.isFinite(raw)) return 1;
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
		// Nested-goals fields. spawnedFromPlanId MUST be settable immediately
		// after createGoal (no awaits between) — see runSubgoalStep.
		spawnedFromPlanId?: string;
		paused?: boolean;
		pauseSource?: "operator" | "legacy-deps";
		replanCount?: number;
		divergencePolicy?: "strict" | "balanced" | "autonomous";
		maxConcurrentChildren?: number;
		/** Per-goal sub-goal opt-in (editable post-creation via PATCH /policy). */
		subgoalsAllowed?: boolean;
		/** Per-goal nesting cap (clamped to system ceiling at the route layer). */
		maxNestingDepth?: number;
		acceptanceCriteria?: string[];
		suggestedRole?: string;
		spawnedBySessionId?: string;
		/** Durable merge-conflict flag for child goals (Plan-tab data contract). */
		mergeConflict?: boolean;
		/** Visible scheduler terminal/circuit-breaker recovery state. */
		schedulerRecovery?: PersistedGoal["schedulerRecovery"];
	}): Promise<boolean> {
		const existing = this.store.get(id);
		if (!existing) return false;

		// If toggling team mode ON for a non-team goal, auto-create worktree
		if (updates.team === true && !existing.team && !existing.worktreePath && !isHeadquartersProject(existing.projectId)) {
			const cwd = updates.cwd ?? existing.cwd;
			if (await isGitRepo(cwd, this.commandRunner)) {
				const repoRoot = await getRepoRoot(cwd, this.commandRunner);
				const title = updates.title ?? existing.title;
				const branch = `goal/${toBranchName(title)}-${id.slice(0, 8)}`;
				try {
					const result = await createWorktree(repoRoot, branch, { commandRunner: this.commandRunner, remotePolicy: this.remotePolicy });
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

		return this.store.updateStrict(id, updates);
	}

	/** Narrow explicit deletion because GoalStore.update deliberately ignores undefined fields. */
	async clearSchedulerRecovery(id: string): Promise<boolean> {
		return this.store.clearSchedulerRecovery(id);
	}

	/**
	 * Compensate a promotion attempt only when the goal still carries the exact
	 * source-session provenance. This deliberately removes metadata only: the
	 * adopted checkout, branch, sandbox, transcript, and source session remain
	 * owned by their original lifecycle and are never cleaned here.
	 */
	async deleteAdoptedGoalAttempt(id: string, ownerSessionId: string): Promise<boolean> {
		const goal = this.store.get(id);
		if (!goal || goal.archived || goal.state !== "todo" || goal.worktreeOwnerSessionId !== ownerSessionId) return false;
		try {
			await cleanupGateDiagnosticsForGoal(id, this.diagnosticsStateDir);
		} catch (err) {
			console.warn(`[goal-manager] Failed to clean gate diagnostics for compensated adopted goal ${id}:`, err);
		}
		this.store.remove(id);
		await this.store.flush();
		return true;
	}

	async deleteGoal(id: string): Promise<boolean> {
		const goal = this.store.get(id);
		if (!goal) return false;

		// Worktrees preserved for 7-day archive (cleaned by periodic purge).
		if (goal?.team) {
			console.log(`[goal-manager] Deleting team goal "${goal.title}" — worktrees preserved for archived session review`);
		}

		try {
			await cleanupGateDiagnosticsForGoal(id, this.diagnosticsStateDir);
		} catch (err) {
			console.warn(`[goal-manager] Failed to clean gate diagnostics for deleted goal ${id}:`, err);
		}

		this.store.remove(id);
		return true;
	}
}
