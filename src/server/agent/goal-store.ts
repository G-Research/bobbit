import fs from "node:fs";
import path from "node:path";
import { normalizeWorkflow, type Workflow } from "./workflow-store.js";

export type GoalState = "todo" | "in-progress" | "complete" | "shelved";

export interface PersistedGoal {
	id: string;
	title: string;
	cwd: string;
	state: GoalState;
	/** Markdown spec content (inline) */
	spec: string;
	createdAt: number;
	updatedAt: number;
	/** Git worktree path (if goal has its own worktree) */
	worktreePath?: string;
	/** Git branch name for this goal's worktree */
	branch?: string;
	/** The original repo path (for worktree cleanup) */
	repoPath?: string;
	/** Which project this goal belongs to */
	projectId?: string;
	/** Whether this is a team goal with Team Lead orchestration */
	team?: boolean;
	/** Session ID of the Team Lead agent (for team goals) */
	teamLeadSessionId?: string;
	/** Gate types to skip requirement enforcement for */
	skipGateRequirements?: string[];
	/** ID of the workflow template this goal was created from */
	workflowId?: string;
	/** Frozen snapshot of the workflow at goal creation time */
	workflow?: Workflow;
	/** Worktree setup status: ready (done/not needed), preparing (in progress), error (failed) */
	setupStatus?: "ready" | "preparing" | "error";
	/** Error message when setupStatus === "error" */
	setupError?: string;
	/** If this goal is a re-attempt of another goal, the original goal's ID */
	reattemptOf?: string;
	/** Whether this goal has been archived (soft-deleted) */
	archived?: boolean;
	/** Epoch ms when the goal was archived */
	archivedAt?: number;
	/** Whether team agents should run in Docker sandbox */
	sandboxed?: boolean;
	/** Whether to automatically start the team after worktree setup (defaults to true) */
	autoStartTeam?: boolean;
	/** Names of optional verification steps enabled for this goal */
	enabledOptionalSteps?: string[];
	/** Per-repo worktree paths (multi-repo only). Single-repo uses flat worktreePath. */
	repoWorktrees?: Record<string, string>;

	// ── Nested goals & DAG subgoals (Phase 1 data model) ─────────────────
	// All fields below are optional and lazy-migrated. Top-level (non-nested)
	// goals leave them undefined; the data layer never backfills defaults —
	// callers compute defaults at use sites. See docs/goals-workflows-tasks.md
	// "Nested goals (Phase 1 data model)".

	/** Parent goal ID (undefined for root goals). */
	parentGoalId?: string;
	/** Root of this goal's tree (== id for root, == parent's rootGoalId for children). */
	rootGoalId?: string;
	/** Where this goal's branch merges: "master" for root, "parent" for children. Auto-derived at createGoal. */
	mergeTarget?: "master" | "parent";
	/** Mutation policy for post-freeze plan changes. Default "balanced". Only meaningful on root. */
	divergencePolicy?: "strict" | "balanced" | "autonomous";
	/** Max parallel children across the tree. Only meaningful on root. Default 3, hard max 8. */
	maxConcurrentChildren?: number;
	/** Acceptance criteria parsed from spec, used by criteria-coverage check. */
	acceptanceCriteria?: string[];
	/** Subgoal idempotency key — set immediately after createGoal in runSubgoalStep (stamp `spawnedFromPlanId` IMMEDIATELY after createGoal — no awaits between). */
	spawnedFromPlanId?: string;
	/**
	 * Sibling planIds this child depends on (Phase 5 — explicit DAG). Empty
	 * or undefined → the child is a parallel sibling at column 0. Stamped
	 * at spawn-time alongside `spawnedFromPlanId`. Validated upstream by
	 * `depends-on-validation.ts` (no self-deps, no unknown refs, no cycles).
	 */
	dependsOnPlanIds?: string[];
	/**
	 * Paused flag — user can pause a goal mid-flight (children may inherit via cascade).
	 * Paused children do NOT count as in-flight for `anyInFlightChild`/parent nudge
	 * suppression — paused != failed; the parent (or user) must act before the child can resume.
	 */
	paused?: boolean;
	/** Increments on every successful post-freeze mutation. > 5 triggers auto-pause. */
	replanCount?: number;
	/**
	 * Optional role hint set by `goal_spawn_child` when the parent specifies
	 * which role should pick up the child first. Read by the child team-lead's
	 * system prompt to bias the first delegation; not enforced — the team-lead
	 * is free to pick a different role if the work demands it.
	 */
	suggestedRole?: string;
	/**
	 * The team-lead session id that spawned this child via `goal_spawn_child`
	 * (or the equivalent fallback path). Lets the sidebar render sub-goals
	 * visually under their spawning team-lead, so collapsing the team-lead
	 * also hides the sub-goals it spawned (matches the user's mental model
	 * — "this team-lead owns this work"). Optional — sub-goals created via
	 * REST without a session context (E2E tests, manual user clicks) leave
	 * this undefined and render at the parent-goal level as before.
	 */
	spawnedBySessionId?: string;
	/**
	 * Ephemeral role definitions snapshotted onto this goal at creation time.
	 * Resolved BEFORE the project/server/builtin role-store cascade by
	 * `resolveRole(goal, name, roleStore)` (src/server/agent/resolve-role.ts).
	 *
	 * Mirrors the `goal.workflow` snapshot pattern: the live store is bypassed
	 * for any name present here, so the goal's verification gates and team
	 * spawns can use one-off roles that don't pollute the project's role
	 * library. Subsequent edits to the project's role store don't affect
	 * already-running goals — the snapshot is frozen.
	 *
	 * Inheritance: when `goal_spawn_child` spawns a child, the parent's
	 * `inlineRoles` are merged into the child's (`{...parent, ...body}`),
	 * with the child's own additions overriding parent definitions of the
	 * same name. See server.ts spawn-child handler.
	 */
	inlineRoles?: Record<string, import("./role-store.js").Role>;

	// ── Subgoal nesting-limit overrides (per-goal) ───────────────────────
	// Both optional, lazy-migrated to undefined. System prefs supply
	// defaults; per-goal values are TIGHTENING overrides only (the system
	// pref is the ceiling). See subgoal-nesting-limit.ts.

	/** Per-goal subgoals-allowed override. `false` disables even when system ON. */
	subgoalsAllowed?: boolean;
	/** Per-goal max nesting depth override (root=1, +1 per hop). Cannot exceed system pref. */
	maxNestingDepth?: number;
}

/**
 * Simple JSON file store for goals.
 * Goals persist across server restarts.
 */
export class GoalStore {
	private readonly storeDir: string;
	private readonly storeFile: string;
	private goals: Map<string, PersistedGoal> = new Map();
	/** Monotonically increasing counter — bumped on every mutation. Resets to 0 on server restart. */
	private generation = 0;

	constructor(stateDir: string) {
		this.storeDir = stateDir;
		this.storeFile = path.join(stateDir, "goals.json");
		this.load();
	}

	private load(): void {
		try {
			if (fs.existsSync(this.storeFile)) {
				const data = JSON.parse(fs.readFileSync(this.storeFile, "utf-8"));
				if (Array.isArray(data)) {
					for (const g of data) {
						if (g.id) {
							// Migrate legacy 'swarm' field to 'team'
							if (g.swarm !== undefined && g.team === undefined) {
								g.team = g.swarm;
								delete g.swarm;
							}
							// Migrate skipArtifactRequirements → skipGateRequirements
							if (g.skipArtifactRequirements && !g.skipGateRequirements) {
								g.skipGateRequirements = g.skipArtifactRequirements;
								delete g.skipArtifactRequirements;
							}
							// Default setupStatus for existing goals
							if (!g.setupStatus) {
								g.setupStatus = "ready";
							}
							// Lazy-migrate workflow snapshots that were written
							// in YAML shape (snake_case `depends_on`,
							// `inject_downstream`) — pre-fix inline workflows
							// bypassed normalization and broke gate_signal
							// with "gateDef.dependsOn is not iterable".
							// R-010: drop malformed inlineRoles (must be a plain object)
							// before they reach resolveRole() and crash team-spawn.
							if (g.inlineRoles && (typeof g.inlineRoles !== "object" || Array.isArray(g.inlineRoles))) {
								console.warn(`[goal-store] Dropping malformed inlineRoles on goal ${g.id}`);
								delete g.inlineRoles;
							}
							if (g.workflow && typeof g.workflow === "object") {
								const needsNormalize = Array.isArray(g.workflow.gates) && g.workflow.gates.some((gate: Record<string, unknown>) =>
									gate && typeof gate === "object" && !Array.isArray((gate as { dependsOn?: unknown }).dependsOn));
								if (needsNormalize) {
									const normalized = normalizeWorkflow(g.workflow, g.workflow.id || g.workflowId || "");
									if (normalized) g.workflow = normalized;
								}
							}
							this.goals.set(g.id, g);
						}
					}
				}
			}
		} catch (err) {
			console.error("[goal-store] Failed to load persisted goals:", err);
		}
	}

	private save(): void {
		try {
			if (!fs.existsSync(this.storeDir)) {
				fs.mkdirSync(this.storeDir, { recursive: true });
			}
			const data = Array.from(this.goals.values());
			fs.writeFileSync(this.storeFile, JSON.stringify(data, null, 2), "utf-8");
		} catch (err) {
			console.error("[goal-store] Failed to save goals:", err);
		}
	}

	/** Current generation counter — bumped on every mutation. */
	getGeneration(): number {
		return this.generation;
	}

	/** Optional callback invoked after any goal mutation (put/update/archive). */
	onIndexUpdate?: (goal: PersistedGoal) => void;

	/** Bump generation without mutating goal data (e.g. when gate status changes). */
	bumpGeneration(): void {
		this.generation++;
	}

	put(goal: PersistedGoal): void {
		this.generation++;
		this.goals.set(goal.id, goal);
		this.save();
		this.onIndexUpdate?.(goal);
	}

	get(id: string): PersistedGoal | undefined {
		return this.goals.get(id);
	}

	remove(id: string): void {
		this.generation++;
		this.goals.delete(id);
		this.save();
	}

	getAll(): PersistedGoal[] {
		return Array.from(this.goals.values());
	}

	archive(id: string): boolean {
		const existing = this.goals.get(id);
		if (!existing) return false;
		this.generation++;
		existing.archived = true;
		existing.archivedAt = Date.now();
		this.save();
		this.onIndexUpdate?.(existing);
		return true;
	}

	getLive(): PersistedGoal[] {
		return Array.from(this.goals.values()).filter(g => !g.archived);
	}

	getArchived(): PersistedGoal[] {
		return Array.from(this.goals.values()).filter(g => g.archived === true);
	}

	update(id: string, updates: Partial<Omit<PersistedGoal, "id" | "createdAt">>): boolean {
		const existing = this.goals.get(id);
		if (!existing) return false;
		// Strip undefined values to avoid overwriting existing fields
		const cleaned: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(updates)) {
			if (v !== undefined) cleaned[k] = v;
		}
		// R-007: skip the write entirely when no field actually changes.
		// `updateGoal({})` after the cleaned-undefined sweep used to bump
		// generation, rewrite goals.json, and emit a goal_state_changed
		// cascade for nothing. Return value still indicates "goal exists"
		// (true) rather than "a write happened" — callers historically
		// only used it as a found/not-found signal.
		const existingAsRec = existing as unknown as Record<string, unknown>;
		const changed = Object.keys(cleaned).some(k => existingAsRec[k] !== cleaned[k]);
		if (!changed) return true;
		this.generation++;
		Object.assign(existing, cleaned, { updatedAt: Date.now() });
		this.save();
		this.onIndexUpdate?.(existing);
		return true;
	}

	/**
	 * Paginated listing of archived goals, sorted by archivedAt DESC.
	 * @param limit Max items per page
	 * @param afterCursor archivedAt timestamp — return items with archivedAt < cursor
	 */
	listArchivedGoalsPaginated(limit: number, afterCursor?: number): { goals: PersistedGoal[]; total: number; hasMore: boolean; nextCursor?: number } {
		let archived = this.getArchived().sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
		const total = archived.length;
		if (afterCursor !== undefined) {
			archived = archived.filter(g => (g.archivedAt ?? 0) < afterCursor);
		}
		const page = archived.slice(0, limit);
		const hasMore = archived.length > limit;
		const nextCursor = page.length > 0 ? page[page.length - 1].archivedAt : undefined;
		return { goals: page, total, hasMore, nextCursor };
	}
}
