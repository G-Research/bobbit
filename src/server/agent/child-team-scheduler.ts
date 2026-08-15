import { Semaphore } from "./semaphore.js";

/** Minimal child-goal projection used for scheduling eligibility. */
export interface SchedulerChildView {
	archived?: boolean;
	state?: string;
	rootGoalId?: string;
	parentGoalId?: string;
	paused?: boolean;
}

export interface SchedulerRecovery {
	kind: "child" | "root";
	rootGoalId: string;
	childGoalId?: string;
	/** Durable restart intent for a root circuit-breaker recovery. */
	affectedChildGoalIds?: string[];
	code: string;
	reason: string;
	retryable: boolean;
}

type Timer = ReturnType<typeof setTimeout>;
type Failure = { code: string; reason: string };
type RequestState = { generation: number; attempts: number; terminal: boolean; repairAttempted: boolean; timer?: Timer };
type Watchdog = { count: number; startedAt: number; tripped: boolean };

export interface ChildTeamSchedulerDeps {
	resolveCap(rootGoalId: string): number;
	getChild(childGoalId: string): SchedulerChildView | undefined;
	/** Must propagate setup/team-start rejections; a rejection never owns a permit. */
	startChildTeam(childGoalId: string): void | Promise<void>;
	/**
	 * Optional authoritative team liveness check. A live lead may predate this
	 * scheduler (for example after a gateway restart), so it must not consume a
	 * new scheduler permit or be relabelled capacity-blocked.
	 */
	hasLiveTeam?(childGoalId: string): boolean;
	/** Persist/broadcast a recoverable terminal scheduling state. */
	onRecovery?(recovery: SchedulerRecovery): void;
	/** Clear a child recovery when a fresh scheduler generation begins. */
	onChildRecoveryCleared?(childGoalId: string): void;
	/** Clear a root circuit-breaker recovery after an automatic/progress reset. */
	onRootRecoveryCleared?(rootGoalId: string): void;
	/** Repair a stale team record before the single TEAM_LEAD_UNAVAILABLE retry. */
	repairUnavailableLead?(childGoalId: string): void | Promise<void>;
	now?(): number;
	setTimer?(callback: () => void, delayMs: number): Timer;
	clearTimer?(timer: Timer): void;
}

export type StartOutcome = "started" | "capacity-blocked";

const PERMANENT_CODES = new Set([
	"TEAM_ALREADY_ACTIVE", "GOAL_NOT_FOUND", "GOAL_ARCHIVED", "TEAM_DISABLED",
	"GOAL_BLOCKED", "GOAL_COMPLETE", "GOAL_SHELVED", "GOAL_PAUSED",
]);
const MAX_TRANSIENT_ATTEMPTS = 8;
const RETRY_BASE_MS = 100;
const RETRY_MAX_MS = 5_000;
const WATCHDOG_LIMIT = 32;
const WATCHDOG_WINDOW_MS = 1_000;

/**
 * One per-root permit pool for every child-team start path. A child request is
 * single-flight from its first acquire until it becomes terminal: duplicate
 * requests may re-drive parked work, but never mint a generation or permit.
 */
export class ChildTeamScheduler {
	private semaphores = new Map<string, Semaphore>();
	private pending = new Map<string, string[]>();
	/** child → generation token for every acquired permit. */
	private holding = new Map<string, Map<string, number>>();
	private childRoot = new Map<string, string>();
	private requests = new Map<string, RequestState>();
	private watchdogs = new Map<string, Watchdog>();

	constructor(private deps: ChildTeamSchedulerDeps) {}

	getSemaphore(rootGoalId: string): Semaphore {
		let sem = this.semaphores.get(rootGoalId);
		if (!sem) {
			const cap = this.deps.resolveCap(rootGoalId);
			sem = new Semaphore(Number.isFinite(cap) ? cap : 3);
			this.semaphores.set(rootGoalId, sem);
		}
		return sem;
	}

	resize(rootGoalId: string, newMax: number): boolean {
		const sem = this.semaphores.get(rootGoalId);
		if (!sem) return false;
		sem.resize(newMax);
		this._startNextEligible(rootGoalId);
		return true;
	}

	requestStart(childGoalId: string): StartOutcome {
		const rootGoalId = this._rootOf(childGoalId);
		// Holding includes successful starts whose request has been cleared. They
		// still own a permit until notifyTerminal, so a duplicate cannot acquire.
		if (rootGoalId && this._isHolding(rootGoalId, childGoalId)) return "started";
		// The scheduler loses its in-memory holding/request state on a gateway
		// restart, while TeamManager still owns a live lead. Treat that as the
		// desired already-started state before allocating a new permit.
		if (this._discardIfLive(rootGoalId, childGoalId)) return "started";
		if (!rootGoalId) {
			try { this.deps.startChildTeam(childGoalId); } catch (err) { console.error(`[scheduler] rootless start failed for ${childGoalId}:`, err); }
			return "started";
		}
		this.childRoot.set(childGoalId, rootGoalId);
		const existing = this.requests.get(childGoalId);
		if (existing && !existing.terminal) {
			// Resume/dependency re-entry wakes a paused, already-queued generation;
			// it is not a new operator retry and therefore cannot supersede it.
			if (!existing.timer && !this.deps.getChild(childGoalId)?.paused) this._startNextEligible(rootGoalId);
			return this._isHolding(rootGoalId, childGoalId) ? "started" : "capacity-blocked";
		}
		this._newRequest(childGoalId);
		this.deps.onChildRecoveryCleared?.(childGoalId);
		this._clearWatchdog(rootGoalId);
		if (this.deps.getChild(childGoalId)?.paused) {
			// A paused request owns no permit, but it must initialise the root pool
			// so resume can wake this tracked intent through _startNextEligible.
			this.getSemaphore(rootGoalId);
			this._enqueue(rootGoalId, childGoalId);
			return "capacity-blocked";
		}
		const sem = this.getSemaphore(rootGoalId);
		if (sem.tryAcquire()) return this._startHolding(rootGoalId, childGoalId, sem) ? "started" : "capacity-blocked";
		this._enqueue(rootGoalId, childGoalId);
		return "capacity-blocked";
	}

	notifyTerminal(childGoalId: string): void {
		const rootGoalId = this.childRoot.get(childGoalId) ?? this._rootOf(childGoalId);
		if (!rootGoalId) return;
		const wasHolding = this._releaseHeldStart(rootGoalId, childGoalId);
		this._removePending(rootGoalId, childGoalId);
		this._clearRequest(childGoalId);
		this.childRoot.delete(childGoalId);
		this.deps.onChildRecoveryCleared?.(childGoalId);
		if (wasHolding) this.semaphores.get(rootGoalId)?.release();
		this._clearWatchdog(rootGoalId);
		this._startNextEligible(rootGoalId);
	}

	startNextEligible(rootGoalId: string): void { this._startNextEligible(rootGoalId); }
	pendingCount(rootGoalId: string): number { return this.pending.get(rootGoalId)?.length ?? 0; }
	/**
	 * Whether this child still has scheduler-owned start intent. This includes
	 * queued, held, retrying, and terminal paused requests so lifecycle callers
	 * can wake an existing request without inventing a new team start.
	 */
	isTracked(childGoalId: string): boolean {
		return this.requests.has(childGoalId) || this.childRoot.has(childGoalId);
	}
	/** Explicit one-action child recovery. */
	retry(childGoalId: string): StartOutcome { return this.requestStart(childGoalId); }
	/**
	 * Explicit root recovery re-drives only its root, never starts the root
	 * itself. The route owns consuming the durable recovery record after its
	 * targets have been dispatched, so clearing its in-memory fuse must not
	 * invoke the automatic/progress recovery-cleared callback.
	 */
	retryRoot(rootGoalId: string): void {
		this._clearWatchdog(rootGoalId, false);
		this._startNextEligible(rootGoalId);
	}

	private _rootOf(childGoalId: string): string | undefined {
		const c = this.deps.getChild(childGoalId);
		return c?.rootGoalId ?? c?.parentGoalId ?? this.childRoot.get(childGoalId);
	}
	private _now(): number { return this.deps.now?.() ?? Date.now(); }
	private _newRequest(childGoalId: string): RequestState {
		const old = this.requests.get(childGoalId);
		if (old?.timer) (this.deps.clearTimer ?? clearTimeout)(old.timer);
		const next = { generation: (old?.generation ?? 0) + 1, attempts: 0, terminal: false, repairAttempted: false };
		this.requests.set(childGoalId, next);
		return next;
	}
	private _clearRequest(childGoalId: string): void {
		const request = this.requests.get(childGoalId);
		if (request?.timer) (this.deps.clearTimer ?? clearTimeout)(request.timer);
		this.requests.delete(childGoalId);
	}
	private _markHolding(rootGoalId: string, childGoalId: string, generation: number): void {
		let held = this.holding.get(rootGoalId);
		if (!held) { held = new Map(); this.holding.set(rootGoalId, held); }
		held.set(childGoalId, generation);
	}
	private _isHolding(rootGoalId: string, childGoalId: string): boolean {
		return this.holding.get(rootGoalId)?.has(childGoalId) ?? false;
	}
	/** Release exactly the matching acquire. Omitted token is terminal cleanup. */
	private _releaseHeldStart(rootGoalId: string, childGoalId: string, generation?: number): boolean {
		const held = this.holding.get(rootGoalId);
		if (!held || !held.has(childGoalId)) return false;
		if (generation !== undefined && held.get(childGoalId) !== generation) return false;
		held.delete(childGoalId);
		return true;
	}

	private _startHolding(rootGoalId: string, childGoalId: string, sem: Semaphore): boolean {
		const request = this.requests.get(childGoalId) ?? this._newRequest(childGoalId);
		request.attempts++;
		this._markHolding(rootGoalId, childGoalId, request.generation);
		try {
			const result = this.deps.startChildTeam(childGoalId);
			if (result && typeof (result as Promise<void>).then === "function") {
				(result as Promise<void>).then(
					() => this._onStartSuccess(rootGoalId, childGoalId, request.generation),
					err => this._onStartFailure(rootGoalId, childGoalId, sem, err, request.generation),
				);
			} else this._onStartSuccess(rootGoalId, childGoalId, request.generation);
			return true;
		} catch (err) {
			this._onStartFailure(rootGoalId, childGoalId, sem, err, request.generation);
			return false;
		}
	}
	private _onStartSuccess(rootGoalId: string, childGoalId: string, generation: number): void {
		const request = this.requests.get(childGoalId);
		if (!request || request.generation !== generation) return;
		if (request.timer) (this.deps.clearTimer ?? clearTimeout)(request.timer);
		this.requests.delete(childGoalId);
		this.deps.onChildRecoveryCleared?.(childGoalId);
		this._clearWatchdog(rootGoalId);
	}
	private _onStartFailure(rootGoalId: string, childGoalId: string, sem: Semaphore, err: unknown, generation: number): void {
		// Release before inspecting the generation. Even a defensive stale
		// callback must never leave its permit held forever.
		if (!this._releaseHeldStart(rootGoalId, childGoalId, generation)) return;
		sem.release();
		const request = this.requests.get(childGoalId);
		if (!request || request.generation !== generation) return;
		const failure = this._failure(err);
		// Only the repeated unavailable-lead error means the repair itself did
		// not help. An unrelated failure after repair remains normally transient.
		if (request.repairAttempted && failure.code === "TEAM_LEAD_UNAVAILABLE") {
			this._terminal(rootGoalId, childGoalId, request, failure, true);
			this._startNextEligible(rootGoalId);
			return;
		}
		if (failure.code === "TEAM_LEAD_UNAVAILABLE" && this.deps.repairUnavailableLead && !request.repairAttempted) {
			request.repairAttempted = true;
			Promise.resolve(this.deps.repairUnavailableLead(childGoalId)).then(
				() => this._scheduleRetry(rootGoalId, childGoalId, request, failure, 0),
				repairErr => this._terminal(rootGoalId, childGoalId, request, this._failure(repairErr, "TEAM_LEAD_UNAVAILABLE"), true),
			);
			this._startNextEligible(rootGoalId);
			return;
		}
		if (PERMANENT_CODES.has(failure.code) || failure.code === "TEAM_LEAD_UNAVAILABLE") {
			this._terminal(rootGoalId, childGoalId, request, failure, this._needsOperatorAction(failure.code));
			this._startNextEligible(rootGoalId);
			return;
		}
		if (request.attempts >= MAX_TRANSIENT_ATTEMPTS) {
			this._terminal(rootGoalId, childGoalId, request, { code: "RETRY_EXHAUSTED", reason: `${failure.code}: ${failure.reason}` }, true);
			this._startNextEligible(rootGoalId);
			return;
		}
		this._scheduleRetry(rootGoalId, childGoalId, request, failure);
		// Preserve the async permit-leak repair: a queued sibling may run now.
		this._startNextEligible(rootGoalId, true);
	}
	private _scheduleRetry(rootGoalId: string, childGoalId: string, request: RequestState, _failure: Failure, forcedDelay?: number): void {
		if (request.terminal || this.requests.get(childGoalId) !== request) return;
		this._enqueue(rootGoalId, childGoalId);
		const generation = request.generation;
		const delay = forcedDelay ?? Math.min(RETRY_BASE_MS * 2 ** Math.max(0, request.attempts - 1), RETRY_MAX_MS);
		request.timer = (this.deps.setTimer ?? setTimeout)(() => {
			const current = this.requests.get(childGoalId);
			if (!current || current.generation !== generation || current.terminal) return;
			current.timer = undefined;
			const child = this.deps.getChild(childGoalId);
			if (!child || child.archived || child.paused) return;
			this._enqueue(rootGoalId, childGoalId);
			this._startNextEligible(rootGoalId);
		}, delay);
	}
	private _terminal(rootGoalId: string, childGoalId: string, request: RequestState, failure: Failure, retryable: boolean): void {
		if (request.terminal) return;
		request.terminal = true;
		if (request.timer) (this.deps.clearTimer ?? clearTimeout)(request.timer);
		this._removePending(rootGoalId, childGoalId);
		console.error("[scheduler] terminal child start failure", { rootGoalId, childGoalId, code: failure.code, reason: failure.reason, generation: request.generation });
		if (this.deps.getChild(childGoalId)) this.deps.onRecovery?.({ kind: "child", rootGoalId, childGoalId, code: failure.code, reason: failure.reason, retryable });
		this._clearWatchdog(rootGoalId);
	}
	private _failure(err: unknown, fallback = "START_FAILED"): Failure {
		const e = err as { code?: unknown; message?: unknown } | undefined;
		return { code: typeof e?.code === "string" ? e.code : fallback, reason: typeof e?.message === "string" ? e.message : String(err) };
	}
	private _needsOperatorAction(code: string): boolean { return !["GOAL_NOT_FOUND", "GOAL_COMPLETE", "GOAL_ARCHIVED", "GOAL_BLOCKED", "GOAL_PAUSED"].includes(code); }
	private _enqueue(rootGoalId: string, childGoalId: string): void {
		let q = this.pending.get(rootGoalId); if (!q) { q = []; this.pending.set(rootGoalId, q); }
		if (!q.includes(childGoalId)) q.push(childGoalId);
	}
	private _removePending(rootGoalId: string, childGoalId: string): void {
		const q = this.pending.get(rootGoalId); const i = q?.indexOf(childGoalId) ?? -1;
		if (i >= 0) q!.splice(i, 1);
	}
	/** Drop obsolete scheduler work for a lead that was already live elsewhere. */
	private _discardIfLive(rootGoalId: string | undefined, childGoalId: string): boolean {
		if (!this.deps.hasLiveTeam?.(childGoalId)) return false;
		if (rootGoalId) this._removePending(rootGoalId, childGoalId);
		this._clearRequest(childGoalId);
		this.childRoot.delete(childGoalId);
		this.deps.onChildRecoveryCleared?.(childGoalId);
		return true;
	}

	/** Inline fuse for a future immediate re-drive regression; no timer is involved. */
	private _recordUnproductiveRedrive(rootGoalId: string): boolean {
		const now = this._now(); let state = this.watchdogs.get(rootGoalId);
		if (!state || now - state.startedAt > WATCHDOG_WINDOW_MS) state = { count: 0, startedAt: now, tripped: false };
		state.count++; this.watchdogs.set(rootGoalId, state);
		if (state.count <= WATCHDOG_LIMIT || state.tripped) return state.tripped;
		state.tripped = true;
		// Delayed retry timers intentionally survive a circuit trip. This fuse
		// only contains an immediate microtask storm; cancelling timers would make
		// slow but recoverable work disappear without an operator action.
		const affectedChildGoalIds = [...new Set(this.pending.get(rootGoalId) ?? [])];
		console.error("[scheduler] root retry circuit breaker tripped", { rootGoalId, affectedChildGoalIds, code: "SCHEDULER_CIRCUIT_OPEN", reason: "unproductive immediate re-drive storm" });
		this.deps.onRecovery?.({ kind: "root", rootGoalId, affectedChildGoalIds, code: "SCHEDULER_CIRCUIT_OPEN", reason: "unproductive immediate re-drive storm", retryable: true });
		return true;
	}
	private _clearWatchdog(rootGoalId: string, notifyRecoveryCleared = true): void {
		const tripped = this.watchdogs.get(rootGoalId)?.tripped === true;
		this.watchdogs.delete(rootGoalId);
		if (tripped && notifyRecoveryCleared) this.deps.onRootRecoveryCleared?.(rootGoalId);
	}
	private _startNextEligible(rootGoalId: string, immediateFailureRedrive = false): void {
		if (immediateFailureRedrive && this._recordUnproductiveRedrive(rootGoalId)) return;
		const watchdog = this.watchdogs.get(rootGoalId);
		if (watchdog?.tripped && this._now() - watchdog.startedAt <= WATCHDOG_WINDOW_MS) return;
		if (watchdog?.tripped) this._clearWatchdog(rootGoalId);
		const sem = this.semaphores.get(rootGoalId); const q = this.pending.get(rootGoalId);
		if (!sem || !q?.length) return;
		let i = 0;
		while (i < q.length && sem.available > 0) {
			const childGoalId = q[i]; const child = this.deps.getChild(childGoalId);
			if (this._discardIfLive(rootGoalId, childGoalId)) { continue; }
			if (this.requests.get(childGoalId)?.timer) { i++; continue; }
			if (!child || child.archived) { q.splice(i, 1); this._clearRequest(childGoalId); this.childRoot.delete(childGoalId); continue; }
			if (child.paused) { i++; continue; }
			if (!sem.tryAcquire()) break;
			q.splice(i, 1);
			this._startHolding(rootGoalId, childGoalId, sem);
		}
	}
}
