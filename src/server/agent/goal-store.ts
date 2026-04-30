import fs from "node:fs";
import path from "node:path";
import type { Workflow } from "./workflow-store.js";
import type { Role } from "./role-store.js";

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
	/** GitHub PR URL (set by team lead after creating PR) */
	prUrl?: string;
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

	// ── nested-goals additions (see docs/design/nested-goals.md §1.1) ──

	/**
	 * Parent goal id when this goal is a child of another goal.
	 * Undefined for top-level goals (`rootGoalId === id`).
	 * Cycles are rejected at creation time by GoalManager.createGoal.
	 */
	parentGoalId?: string;

	/**
	 * Top-of-tree goal id. Always populated (== id for top-level goals).
	 * Cached for fast queries: "find all goals in the tree rooted at X".
	 */
	rootGoalId?: string;

	/**
	 * Where this goal's branch merges back to.
	 * - `"master"` (default for top-level goals) — top-level `ready-to-merge`
	 *   raises a PR to the primary branch.
	 * - `"parent"` (default for child goals) — `ready-to-merge` triggers a
	 *   local merge into the parent's branch via `goal_merge_child`. No PR.
	 * Auto-derived from parentGoalId at creation time and not edited
	 * afterwards (would imply re-parenting which is out of scope).
	 */
	mergeTarget?: "master" | "parent";

	/**
	 * Per-goal divergence policy controlling auto-approval of plan mutations.
	 * Inherited from parent if unset. Default at root: "strict".
	 */
	divergencePolicy?: "strict" | "balanced" | "autonomous";

	/**
	 * Maximum number of child goals from this goal that may run in parallel.
	 * Inherited from parent if unset. Default 3, hard max 8.
	 * Enforced by the verification harness when running phase-parallel
	 * `subgoal` verify steps. Per design §1.5, only the **root** goal's
	 * value is honoured in v1; sub-goal values are accepted on disk for
	 * forward compatibility but inert.
	 */
	maxConcurrentChildren?: number;

	/**
	 * Inline workflow snapshotted on this goal at creation. Overrides
	 * workflowId resolution. Used when the user pastes a custom workflow
	 * YAML in the New Goal dialog. Resolves before walking the parentGoalId
	 * chain (see design doc §7).
	 */
	inlineWorkflow?: Workflow;

	/**
	 * Inline role definitions snapshotted on this goal. Map keyed by role
	 * name (e.g. "coder", "qa-tester"). Scoped to this goal-tree — children
	 * can override by defining the same key, otherwise inherit via the
	 * walk-up resolver in design doc §7.
	 */
	inlineRoles?: Record<string, Role>;

	/**
	 * Acceptance criteria parsed from the goal spec markdown (§1.3).
	 * Used by the mutation classifier (§4) to detect criteria-drop
	 * violations that no policy may override.
	 */
	acceptanceCriteria?: string[];

	/**
	 * Number of post-freeze plan mutations applied to this goal.
	 * Bumped on every successful goal_plan_propose / goal_spawn_child
	 * after the goal-plan gate has been signalled. When > 5 the goal
	 * auto-pauses for human review (§4.3).
	 */
	replanCount?: number;

	/**
	 * Whether this goal is paused. While paused, the verification harness
	 * skips verify-step ticks for any signal whose goal is paused, and
	 * goal_spawn_child / goal_plan_propose under "strict" policy require
	 * paused === true to apply restructure mutations.
	 */
	paused?: boolean;
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

	// ── nested-goals secondary indexes (design §1.2) ──────────
	/** parentGoalId → set of immediate child goal ids. */
	private childrenByParent: Map<string, Set<string>> = new Map();
	/** rootGoalId → set of all descendant goal ids (incl. the root itself). */
	private byRoot: Map<string, Set<string>> = new Map();

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
							// Lazy nested-goals migration (design §1.4) — defaults
							// applied on read only. Do NOT rewrite the persisted file
							// just for these defaults; subsequent put()/update() will
							// flush the materialised values when something else changes.
							if (g.parentGoalId === undefined) {
								// top-level goal — rootGoalId == id, mergeTarget defaults to "master"
								if (!g.rootGoalId) g.rootGoalId = g.id;
								if (!g.mergeTarget) g.mergeTarget = "master";
							} else {
								// child goal — mergeTarget defaults to "parent" if missing
								if (!g.mergeTarget) g.mergeTarget = "parent";
								// rootGoalId, if missing on disk, will be filled in by
								// GoalManager.createGoal at write-time. Don't fabricate
								// it here — we don't have parent records guaranteed
								// loaded yet (they may follow in the array). Instead
								// rely on the second pass below.
							}
							this.goals.set(g.id, g);
						}
					}

					// Second pass: backfill rootGoalId for any child whose record
					// lacked it on disk (theoretical; new records always carry it).
					// O(depth × N) worst case — fine for thousands of goals.
					for (const g of this.goals.values()) {
						if (g.rootGoalId) continue;
						let cursor: PersistedGoal | undefined = g;
						const seen = new Set<string>();
						while (cursor && cursor.parentGoalId) {
							if (seen.has(cursor.id)) break; // cycle guard — should never trigger
							seen.add(cursor.id);
							const parent = this.goals.get(cursor.parentGoalId);
							if (!parent) break;
							cursor = parent;
						}
						g.rootGoalId = cursor ? cursor.id : g.id;
					}

					// Build secondary indexes from the loaded goals.
					this.rebuildIndexes();
				}
			}
		} catch (err) {
			console.error("[goal-store] Failed to load persisted goals:", err);
		}
	}

	private rebuildIndexes(): void {
		this.childrenByParent.clear();
		this.byRoot.clear();
		for (const g of this.goals.values()) {
			this.indexInsert(g);
		}
	}

	private indexInsert(g: PersistedGoal): void {
		if (g.parentGoalId) {
			let kids = this.childrenByParent.get(g.parentGoalId);
			if (!kids) {
				kids = new Set();
				this.childrenByParent.set(g.parentGoalId, kids);
			}
			kids.add(g.id);
		}
		const root = g.rootGoalId ?? g.id;
		let group = this.byRoot.get(root);
		if (!group) {
			group = new Set();
			this.byRoot.set(root, group);
		}
		group.add(g.id);
	}

	private indexRemove(g: PersistedGoal): void {
		if (g.parentGoalId) {
			const kids = this.childrenByParent.get(g.parentGoalId);
			if (kids) {
				kids.delete(g.id);
				if (kids.size === 0) this.childrenByParent.delete(g.parentGoalId);
			}
		}
		const root = g.rootGoalId ?? g.id;
		const group = this.byRoot.get(root);
		if (group) {
			group.delete(g.id);
			if (group.size === 0) this.byRoot.delete(root);
		}
	}

	private indexUpdate(prev: PersistedGoal | undefined, next: PersistedGoal): void {
		const parentChanged = prev?.parentGoalId !== next.parentGoalId;
		const rootChanged = (prev?.rootGoalId ?? prev?.id) !== (next.rootGoalId ?? next.id);
		if (!prev) {
			this.indexInsert(next);
			return;
		}
		if (!parentChanged && !rootChanged) return;
		this.indexRemove(prev);
		this.indexInsert(next);
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
		const prev = this.goals.get(goal.id);
		this.goals.set(goal.id, goal);
		this.indexUpdate(prev, goal);
		this.save();
		this.onIndexUpdate?.(goal);
	}

	get(id: string): PersistedGoal | undefined {
		return this.goals.get(id);
	}

	remove(id: string): void {
		this.generation++;
		const existing = this.goals.get(id);
		this.goals.delete(id);
		if (existing) this.indexRemove(existing);
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
		// archive() does not move the goal out of indexes — archived goals
		// stay queryable via getDescendants()/getChildren(). Live/archived
		// filtering is applied at read-time, same as today.
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
		this.generation++;
		// Snapshot prev for index diffing before mutation
		const prevSnapshot: PersistedGoal = { ...existing };
		// Strip undefined values to avoid overwriting existing fields
		const cleaned: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(updates)) {
			if (v !== undefined) cleaned[k] = v;
		}
		Object.assign(existing, cleaned, { updatedAt: Date.now() });
		this.indexUpdate(prevSnapshot, existing);
		this.save();
		this.onIndexUpdate?.(existing);
		return true;
	}

	// ── nested-goals query helpers (design §1.2) ─────────────

	/** All immediate children of `parentId`, sorted by createdAt ASC. */
	getChildren(parentId: string): PersistedGoal[] {
		const ids = this.childrenByParent.get(parentId);
		if (!ids || ids.size === 0) return [];
		const out: PersistedGoal[] = [];
		for (const id of ids) {
			const g = this.goals.get(id);
			if (g) out.push(g);
		}
		out.sort((a, b) => a.createdAt - b.createdAt);
		return out;
	}

	/**
	 * All descendants (transitive) of `rootId`, including the root itself.
	 * Sorted by createdAt ASC. Returns `[]` if the root is unknown.
	 */
	getDescendants(rootId: string): PersistedGoal[] {
		const ids = this.byRoot.get(rootId);
		if (!ids || ids.size === 0) return [];
		const out: PersistedGoal[] = [];
		for (const id of ids) {
			const g = this.goals.get(id);
			if (g) out.push(g);
		}
		out.sort((a, b) => a.createdAt - b.createdAt);
		return out;
	}

	/**
	 * Walk parentGoalId chain from `goalId`, returning ancestors
	 * **root-first** (deepest first → root last is *not* what we return —
	 * the design doc requests root-first ordering for breadcrumb
	 * rendering). The starting goal itself is **not** included.
	 *
	 * Cycle-safe: a corrupted chain is truncated when an id repeats.
	 */
	getAncestors(goalId: string): PersistedGoal[] {
		const start = this.goals.get(goalId);
		if (!start) return [];
		const chain: PersistedGoal[] = [];
		const seen = new Set<string>([goalId]);
		let cursor: PersistedGoal | undefined = start;
		while (cursor && cursor.parentGoalId) {
			if (seen.has(cursor.parentGoalId)) break; // cycle guard
			seen.add(cursor.parentGoalId);
			const parent = this.goals.get(cursor.parentGoalId);
			if (!parent) break;
			chain.push(parent);
			cursor = parent;
		}
		// chain currently runs near→far (parent, grandparent, …). Design
		// asks for root-first → reverse.
		return chain.reverse();
	}

	/** True if `descendantId` is in the subtree of `ancestorId`. O(depth). */
	isDescendantOf(descendantId: string, ancestorId: string): boolean {
		if (descendantId === ancestorId) return false;
		const seen = new Set<string>([descendantId]);
		let cursor: PersistedGoal | undefined = this.goals.get(descendantId);
		while (cursor && cursor.parentGoalId) {
			if (cursor.parentGoalId === ancestorId) return true;
			if (seen.has(cursor.parentGoalId)) return false; // cycle guard
			seen.add(cursor.parentGoalId);
			cursor = this.goals.get(cursor.parentGoalId);
		}
		return false;
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
