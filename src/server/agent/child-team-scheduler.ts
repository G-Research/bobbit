/**
 * Unified per-root child-team scheduler.
 *
 * THE single authority for how many child teams run concurrently under one
 * goal tree. Before this module the per-root concurrency cap lived only in
 * `VerificationHarness.runSubgoalStep` (the harness-driven plan path); direct
 * `goal_spawn_child` REST spawns, `POST /api/goals` child creation, and the
 * `integrate-child` dependency auto-unblock all started child teams WITHOUT
 * acquiring a permit — so the cap could be bypassed (e.g. cap=1 + several
 * spawn-child calls start multiple teams; one merge that unblocks several
 * dependents starts them all at once).
 *
 * Every code path that would START a child team now routes through this
 * scheduler:
 *   - harness `runSubgoalStep` (via the shared per-root `Semaphore`, blocking
 *     acquire + long hold across the child's lifecycle), and
 *   - the REST/POST start paths (via `requestStart`, a NON-blocking try —
 *     either it starts now under a permit, or the child is parked
 *     capacity-blocked and enqueued).
 *
 * The semaphore IS the scheduler — there is NO poll loop. A permit is freed by
 * a terminal child event (`notifyTerminal`: merge / archive / completion) or by
 * the harness releasing its held permit (`startNextEligible`), and that release
 * synchronously starts the next eligible queued child. Live `PATCH /policy`
 * cap resizes apply in place via `resize` (and pay down / pick up pending work).
 *
 * Capacity bookkeeping is in-memory (like the original per-root semaphore) and
 * keyed by `rootGoalId`.
 */

import { Semaphore } from "./semaphore.js";

/** Minimal child-goal projection the scheduler needs for eligibility checks. */
export interface SchedulerChildView {
	archived?: boolean;
	state?: string;
	rootGoalId?: string;
	parentGoalId?: string;
}

export interface ChildTeamSchedulerDeps {
	/**
	 * Resolve the per-root concurrency cap. SHOULD already be integer-clamped
	 * to `[1, 8]` (e.g. `goalManager.resolveRootMaxConcurrentChildren`); the
	 * `Semaphore` floors/min-clamps defensively regardless.
	 */
	resolveCap(rootGoalId: string): number;
	/** Read a child goal record (or undefined if unknown / evaporated). */
	getChild(childGoalId: string): SchedulerChildView | undefined;
	/**
	 * Start a child's team (worktree setup + team start + broadcasts). MUST be
	 * fire-and-forget safe (the scheduler never awaits it) and idempotent
	 * enough to tolerate a re-entry. Implementations should flip a
	 * capacity-blocked child's `state` back to a runnable value.
	 */
	startChildTeam(childGoalId: string): void;
}

export type StartOutcome = "started" | "capacity-blocked";

export class ChildTeamScheduler {
	/** Per-root concurrency semaphore, lazily created on first use. */
	private semaphores = new Map<string, Semaphore>();
	/** Per-root FIFO queue of capacity-blocked childGoalIds (deps already satisfied). */
	private pending = new Map<string, string[]>();
	/** Per-root set of childGoalIds currently holding a permit started by this scheduler. */
	private holding = new Map<string, Set<string>>();
	/** Reverse index childGoalId → rootGoalId so terminal events can find the root even post-archive. */
	private childRoot = new Map<string, string>();

	constructor(private deps: ChildTeamSchedulerDeps) {}

	/**
	 * Lazily create (or fetch) the per-root semaphore. Used by the harness so
	 * its existing blocking `acquire()` / `release()` model keeps working while
	 * sharing the same permit pool as the REST start paths.
	 */
	getSemaphore(rootGoalId: string): Semaphore {
		let sem = this.semaphores.get(rootGoalId);
		if (!sem) {
			const cap = this.deps.resolveCap(rootGoalId);
			sem = new Semaphore(Number.isFinite(cap) ? cap : 3);
			this.semaphores.set(rootGoalId, sem);
		}
		return sem;
	}

	/**
	 * Resize the cached per-root cap in place (live `PATCH /policy`). Returns
	 * `false` when no semaphore has been created yet (lazy creation will read
	 * the fresh cap). Growing may free slots, so we attempt to start the next
	 * eligible queued children afterwards.
	 */
	resize(rootGoalId: string, newMax: number): boolean {
		const sem = this.semaphores.get(rootGoalId);
		if (!sem) return false;
		sem.resize(newMax);
		this._startNextEligible(rootGoalId);
		return true;
	}

	/**
	 * Request a child-team start. NON-blocking: either a permit is available
	 * (acquire + start now → `"started"`) or the child is parked
	 * capacity-blocked and enqueued FIFO (`"capacity-blocked"`). The caller is
	 * responsible for stamping the child's `state` to `blocked` on the
	 * capacity-blocked outcome (the scheduler flips it back when it later
	 * starts the team).
	 */
	requestStart(childGoalId: string): StartOutcome {
		const rootGoalId = this._rootOf(childGoalId);
		if (!rootGoalId) {
			// No resolvable root (should not happen for a child) — start without
			// a cap rather than strand the child.
			this.deps.startChildTeam(childGoalId);
			return "started";
		}
		this.childRoot.set(childGoalId, rootGoalId);
		const sem = this.getSemaphore(rootGoalId);
		if (sem.tryAcquire()) {
			this._markHolding(rootGoalId, childGoalId);
			this.deps.startChildTeam(childGoalId);
			return "started";
		}
		this._enqueue(rootGoalId, childGoalId);
		return "capacity-blocked";
	}

	/**
	 * Terminal child event (merge / archive / completion). Releases the permit
	 * the child held (if any), removes it from the capacity queue (if parked),
	 * and starts the next eligible queued child. Idempotent — a child that
	 * never held a permit nor was queued is a no-op (e.g. a harness-managed
	 * child whose permit is released by the harness itself).
	 */
	notifyTerminal(childGoalId: string): void {
		const rootGoalId = this.childRoot.get(childGoalId) ?? this._rootOf(childGoalId);
		if (!rootGoalId) return;
		const held = this.holding.get(rootGoalId);
		const wasHolding = held?.delete(childGoalId) ?? false;
		this._removePending(rootGoalId, childGoalId);
		this.childRoot.delete(childGoalId);
		if (wasHolding) {
			const sem = this.semaphores.get(rootGoalId);
			if (sem) sem.release();
		}
		this._startNextEligible(rootGoalId);
	}

	/**
	 * Called by the harness AFTER it releases its own held permit (the harness
	 * owns its permit lifecycle via the shared `Semaphore` directly). Drives the
	 * next REST/POST capacity-blocked child into a freed slot — so the cap stays
	 * unified across the harness and REST start paths.
	 */
	startNextEligible(rootGoalId: string): void {
		this._startNextEligible(rootGoalId);
	}

	/** Test/diagnostic: number of capacity-blocked children queued for a root. */
	pendingCount(rootGoalId: string): number {
		return this.pending.get(rootGoalId)?.length ?? 0;
	}

	private _rootOf(childGoalId: string): string | undefined {
		const c = this.deps.getChild(childGoalId);
		return c?.rootGoalId ?? c?.parentGoalId ?? this.childRoot.get(childGoalId);
	}

	private _markHolding(rootGoalId: string, childGoalId: string): void {
		let set = this.holding.get(rootGoalId);
		if (!set) { set = new Set(); this.holding.set(rootGoalId, set); }
		set.add(childGoalId);
	}

	private _enqueue(rootGoalId: string, childGoalId: string): void {
		let q = this.pending.get(rootGoalId);
		if (!q) { q = []; this.pending.set(rootGoalId, q); }
		if (!q.includes(childGoalId)) q.push(childGoalId);
	}

	private _removePending(rootGoalId: string, childGoalId: string): void {
		const q = this.pending.get(rootGoalId);
		if (!q) return;
		const i = q.indexOf(childGoalId);
		if (i >= 0) q.splice(i, 1);
	}

	/**
	 * Drain the capacity queue into freed permits. Stops when no permits are
	 * available or the queue is exhausted. Stale entries (archived / evaporated
	 * children) are dropped without consuming a permit.
	 */
	private _startNextEligible(rootGoalId: string): void {
		const sem = this.semaphores.get(rootGoalId);
		if (!sem) return;
		const q = this.pending.get(rootGoalId);
		if (!q || q.length === 0) return;
		while (q.length > 0 && sem.available > 0) {
			const next = q[0];
			const c = this.deps.getChild(next);
			if (!c || c.archived === true) {
				// Stale pending entry — drop it, do not consume a permit.
				q.shift();
				this.childRoot.delete(next);
				continue;
			}
			if (!sem.tryAcquire()) break;
			q.shift();
			this._markHolding(rootGoalId, next);
			this.deps.startChildTeam(next);
		}
	}
}
