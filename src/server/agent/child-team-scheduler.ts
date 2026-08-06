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
	/** Persist/broadcast a recoverable terminal scheduling state. */
	onRecovery?(recovery: SchedulerRecovery): void;
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
const MAX_TRANSIENT_ATTEMPTS = 6;
const RETRY_BASE_MS = 100;
const RETRY_MAX_MS = 5_000;
const WATCHDOG_LIMIT = 32;
const WATCHDOG_WINDOW_MS = 1_000;

/**
 * One per-root permit pool for every child-team start path. Failed starts are
 * deliberately separated from queue draining: transient failures retry from a
 * timer, never from the rejecting promise's microtask chain.
 */
export class ChildTeamScheduler {
	private semaphores = new Map<string, Semaphore>();
	private pending = new Map<string, string[]>();
	private holding = new Map<string, Set<string>>();
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
		if (!rootGoalId) {
			try { this.deps.startChildTeam(childGoalId); } catch (err) { console.error(`[scheduler] rootless start failed for ${childGoalId}:`, err); }
			return "started";
		}
		this.childRoot.set(childGoalId, rootGoalId);
		// An explicit operator/re-entry request is a new generation and clears a
		// previous visible stop. Queueing due to capacity is not a retry.
		this._newRequest(childGoalId);
		this._resetWatchdog(rootGoalId);
		// A direct request can race the pause cascade before it reaches the
		// drain's eligibility check. Park it; resume supplies the new request.
		if (this.deps.getChild(childGoalId)?.paused) {
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
		const held = this.holding.get(rootGoalId);
		const wasHolding = held?.delete(childGoalId) ?? false;
		this._removePending(rootGoalId, childGoalId);
		this._clearRequest(childGoalId);
		this.childRoot.delete(childGoalId);
		if (wasHolding) this.semaphores.get(rootGoalId)?.release();
		this._resetWatchdog(rootGoalId);
		this._startNextEligible(rootGoalId);
	}

	startNextEligible(rootGoalId: string): void { this._startNextEligible(rootGoalId); }
	pendingCount(rootGoalId: string): number { return this.pending.get(rootGoalId)?.length ?? 0; }
	/** Explicit one-action recovery endpoint/handler seam. */
	retry(childGoalId: string): StartOutcome { return this.requestStart(childGoalId); }

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
	private _request(childGoalId: string): RequestState { return this.requests.get(childGoalId) ?? this._newRequest(childGoalId); }
	private _clearRequest(childGoalId: string): void {
		const request = this.requests.get(childGoalId);
		if (request?.timer) (this.deps.clearTimer ?? clearTimeout)(request.timer);
		this.requests.delete(childGoalId);
	}
	private _markHolding(rootGoalId: string, childGoalId: string): void {
		let set = this.holding.get(rootGoalId); if (!set) { set = new Set(); this.holding.set(rootGoalId, set); } set.add(childGoalId);
	}

	private _startHolding(rootGoalId: string, childGoalId: string, sem: Semaphore): boolean {
		const request = this._request(childGoalId);
		request.attempts++;
		this._markHolding(rootGoalId, childGoalId);
		try {
			const result = this.deps.startChildTeam(childGoalId);
			if (result && typeof (result as Promise<void>).then === "function") {
				(result as Promise<void>).then(() => this._onStartSuccess(rootGoalId, childGoalId, request.generation), err => this._onStartFailure(rootGoalId, childGoalId, sem, err, request.generation));
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
		this._resetWatchdog(rootGoalId);
	}
	private _onStartFailure(rootGoalId: string, childGoalId: string, sem: Semaphore, err: unknown, generation: number): void {
		const request = this.requests.get(childGoalId);
		if (!request || request.generation !== generation) return;
		const held = this.holding.get(rootGoalId);
		if (!held?.delete(childGoalId)) return; // terminal won the race
		sem.release();
		const failure = this._failure(err);
		// A repaired stale entry gets exactly one idempotent start attempt. A
		// second failure is actionable, not a fresh transient retry sequence.
		if (request.repairAttempted) {
			this._terminal(rootGoalId, childGoalId, request, failure, true);
			this._startNextEligible(rootGoalId);
			return;
		}
		if (failure.code === "TEAM_LEAD_UNAVAILABLE" && this.deps.repairUnavailableLead) {
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
		// Preserve the original permit-leak repair: another queued sibling may run.
		// This is the only immediate failed-work re-drive counted by the inline
		// fuse; timer retries deliberately do not participate in a microtask loop.
		this._startNextEligible(rootGoalId, true);
	}
	private _scheduleRetry(rootGoalId: string, childGoalId: string, request: RequestState, _failure: Failure, forcedDelay?: number): void {
		// Keep the child visible in its root queue while its timer owns the next
		// attempt. Drains skip timer-owned entries, so this cannot re-create the
		// rejected-promise microtask loop.
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
		this._resetWatchdog(rootGoalId);
	}
	private _failure(err: unknown, fallback = "START_FAILED"): Failure {
		const e = err as { code?: unknown; message?: unknown } | undefined;
		return { code: typeof e?.code === "string" ? e.code : fallback, reason: typeof e?.message === "string" ? e.message : String(err) };
	}
	private _needsOperatorAction(code: string): boolean { return !["GOAL_NOT_FOUND", "GOAL_COMPLETE", "GOAL_ARCHIVED", "GOAL_BLOCKED", "GOAL_PAUSED"].includes(code); }
	private _enqueue(rootGoalId: string, childGoalId: string): void { let q = this.pending.get(rootGoalId); if (!q) { q = []; this.pending.set(rootGoalId, q); } if (!q.includes(childGoalId)) q.push(childGoalId); }
	private _removePending(rootGoalId: string, childGoalId: string): void { const q = this.pending.get(rootGoalId); const i = q?.indexOf(childGoalId) ?? -1; if (i >= 0) q!.splice(i, 1); }

	/** Inline fuse for a future immediate re-drive regression; no timer is involved. */
	private _recordUnproductiveRedrive(rootGoalId: string): boolean {
		const now = this._now(); let state = this.watchdogs.get(rootGoalId);
		if (!state || now - state.startedAt > WATCHDOG_WINDOW_MS) state = { count: 0, startedAt: now, tripped: false };
		state.count++; this.watchdogs.set(rootGoalId, state);
		if (state.count <= WATCHDOG_LIMIT || state.tripped) return state.tripped;
		state.tripped = true;
		for (const [child, request] of this.requests) {
			if (this.childRoot.get(child) !== rootGoalId || !request.timer) continue;
			(this.deps.clearTimer ?? clearTimeout)(request.timer);
			request.timer = undefined; // monotonic-window reset may re-drive it
		}
		console.error("[scheduler] root retry circuit breaker tripped", { rootGoalId, code: "SCHEDULER_CIRCUIT_OPEN", reason: "unproductive immediate re-drive storm" });
		this.deps.onRecovery?.({ kind: "root", rootGoalId, code: "SCHEDULER_CIRCUIT_OPEN", reason: "unproductive immediate re-drive storm", retryable: true });
		return true;
	}
	private _resetWatchdog(rootGoalId: string): void { this.watchdogs.delete(rootGoalId); }
	private _startNextEligible(rootGoalId: string, immediateFailureRedrive = false): void {
		if (immediateFailureRedrive && this._recordUnproductiveRedrive(rootGoalId)) return;
		const watchdog = this.watchdogs.get(rootGoalId);
		if (watchdog?.tripped && this._now() - watchdog.startedAt <= WATCHDOG_WINDOW_MS) return;
		if (watchdog?.tripped) this._resetWatchdog(rootGoalId);
		const sem = this.semaphores.get(rootGoalId); const q = this.pending.get(rootGoalId); if (!sem || !q?.length) return;
		let i = 0;
		while (i < q.length && sem.available > 0) {
			const childGoalId = q[i]; const child = this.deps.getChild(childGoalId);
			if (this.requests.get(childGoalId)?.timer) { i++; continue; }
			if (!child || child.archived) { q.splice(i, 1); this._clearRequest(childGoalId); this.childRoot.delete(childGoalId); continue; }
			if (child.paused) { i++; continue; }
			if (!sem.tryAcquire()) break;
			q.splice(i, 1); this._startHolding(rootGoalId, childGoalId, sem);
		}
	}
}
