/**
 * SWARM-W1 — hard resource governor.
 *
 * design/swarm-orchestration.md §6 "Resource governor — must be HARD" /
 * §14 item 1 (must-fix #1): the design's critique found the proposed
 * governor was spawn-boundary-only (`pause-and-ask` at semaphore `acquire`)
 * — advisory, not a ceiling. An already-running worker on a frontier model
 * can blow arbitrarily past budget because nothing enforces a per-node
 * `tokenBudget` at the turn layer, and token accounting lags (post-turn).
 *
 * This module is the HARD half:
 *   1. A per-node (per swarm-sibling-goal) token ceiling, checked at the
 *      turn boundary (every `message_end` — see `session-manager.ts`
 *      `trackCostFromEvent`, the only place cumulative usage becomes known).
 *      Breach → `abort-turn` (soft: abort just the in-flight turn, the
 *      sibling can still reach a terminal state and be captured).
 *   2. A hard-kill backstop at `ceiling * hardKillMarginMultiplier` — a
 *      turn that ignores/outraces the abort (or a runaway loop that racks up
 *      usage across turns) still gets stopped. Graceful pause is the common
 *      case, NEVER the only stop (design §6).
 *   3. A straggler wall-clock deadline per node, independent of token spend
 *      — a HUNG (non-terminal, non-crashed) worker means the barrier never
 *      fires; the swarm must always be able to converge (design §6/§7).
 *
 * Pure logic — no I/O, no timers owned here except the straggler
 * `setTimeout` (trivially fake-able via the injectable `now`/`schedule`).
 * Wiring (aborting an `RpcBridge` turn, hard-killing via
 * `SessionManager.terminateSession`, releasing the scheduler permit via
 * `notifyChildTerminal`) lives in the callers (`session-manager.ts`,
 * `swarm-best-of-n.ts`) — this module only decides.
 */

export interface SwarmNodeBudget {
	/** Hard per-node token ceiling (inputTokens + outputTokens), enforced at the turn boundary. */
	tokenBudget: number;
	/**
	 * Hard-kill backstop multiplier over `tokenBudget`. Defaults to 1.5 — a
	 * turn that already breached `tokenBudget` (and got an `abort-turn`) but
	 * keeps accumulating usage past `tokenBudget * hardKillMarginMultiplier`
	 * gets the WHOLE session terminated, not just the turn aborted again.
	 */
	hardKillMarginMultiplier?: number;
	/** Straggler wall-clock deadline in ms, measured from `registerNode`. */
	wallClockMs: number;
}

export type SwarmGovernorAction =
	| { kind: "ok" }
	| { kind: "abort-turn"; reason: string; totalTokens: number; tokenBudget: number }
	| { kind: "hard-kill"; reason: string; totalTokens: number; tokenBudget: number };

interface NodeState {
	budget: Required<SwarmNodeBudget>;
	registeredAt: number;
	/** Set once an `abort-turn` has already been issued, so repeat breaches escalate to hard-kill rather than re-issuing the same soft action forever. */
	abortIssued: boolean;
	stragglerTimer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_HARD_KILL_MARGIN = 1.5;

export class SwarmGovernor {
	private nodes = new Map<string, NodeState>();
	private readonly now: () => number;
	private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	private readonly clear: (t: ReturnType<typeof setTimeout>) => void;

	constructor(opts?: {
		now?: () => number;
		schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
		clear?: (t: ReturnType<typeof setTimeout>) => void;
	}) {
		this.now = opts?.now ?? Date.now;
		this.schedule = opts?.schedule ?? ((fn, ms) => setTimeout(fn, ms));
		this.clear = opts?.clear ?? ((t) => clearTimeout(t));
	}

	/**
	 * Register a swarm-sibling node under governance. Idempotent per
	 * `goalId` — a re-register (e.g. a resumed/restarted node) resets the
	 * clock and re-arms the straggler watch.
	 *
	 * `onStraggler` fires exactly once, at `wallClockMs` after registration,
	 * UNLESS `unregisterNode` is called first (the caller's job: call it from
	 * the same terminal path that already calls `notifyChildTerminal`).
	 */
	registerNode(goalId: string, budget: SwarmNodeBudget, onStraggler: (reason: string) => void): void {
		this.unregisterNode(goalId); // clear any prior timer before re-arming
		const resolved: Required<SwarmNodeBudget> = {
			tokenBudget: budget.tokenBudget,
			hardKillMarginMultiplier: budget.hardKillMarginMultiplier ?? DEFAULT_HARD_KILL_MARGIN,
			wallClockMs: budget.wallClockMs,
		};
		const state: NodeState = { budget: resolved, registeredAt: this.now(), abortIssued: false };
		if (Number.isFinite(resolved.wallClockMs) && resolved.wallClockMs > 0) {
			state.stragglerTimer = this.schedule(() => {
				// The node may have gone terminal in the same tick the timer
				// fires (race) — re-check it's still registered before firing.
				if (this.nodes.get(goalId) === state) {
					onStraggler(`straggler wall-clock deadline (${resolved.wallClockMs}ms) exceeded`);
				}
			}, resolved.wallClockMs);
		}
		this.nodes.set(goalId, state);
	}

	/** Stop governing a node (terminal reached). Idempotent — a no-op for an unknown/already-unregistered goalId. Always clears the straggler timer, even if `wallClockMs` was never armed. */
	unregisterNode(goalId: string): void {
		const state = this.nodes.get(goalId);
		if (!state) return;
		if (state.stragglerTimer) this.clear(state.stragglerTimer);
		this.nodes.delete(goalId);
	}

	/** Whether `goalId` is currently under governance (registered, not yet unregistered). */
	isRegistered(goalId: string): boolean {
		return this.nodes.has(goalId);
	}

	/**
	 * Turn-boundary check — call with the CUMULATIVE token total (inputTokens
	 * + outputTokens) for the node's session every time it becomes known
	 * (`trackCostFromEvent`'s `message_end` hook). Unregistered nodes always
	 * return `ok` (zero overhead / zero behavior change for non-swarm
	 * sessions — the governor never sees them).
	 */
	checkTokenBudget(goalId: string, cumulativeTotalTokens: number): SwarmGovernorAction {
		const state = this.nodes.get(goalId);
		if (!state) return { kind: "ok" };
		const { tokenBudget, hardKillMarginMultiplier } = state.budget;
		if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) return { kind: "ok" };
		const hardCeiling = tokenBudget * hardKillMarginMultiplier;
		if (cumulativeTotalTokens >= hardCeiling) {
			return {
				kind: "hard-kill",
				reason: `token spend ${cumulativeTotalTokens} >= hard-kill ceiling ${hardCeiling} (tokenBudget ${tokenBudget} x margin ${hardKillMarginMultiplier})`,
				totalTokens: cumulativeTotalTokens,
				tokenBudget,
			};
		}
		if (cumulativeTotalTokens >= tokenBudget) {
			state.abortIssued = true;
			return {
				kind: "abort-turn",
				reason: `token spend ${cumulativeTotalTokens} >= tokenBudget ${tokenBudget}`,
				totalTokens: cumulativeTotalTokens,
				tokenBudget,
			};
		}
		return { kind: "ok" };
	}

	/** Test/diagnostic: number of currently-governed nodes. */
	get size(): number {
		return this.nodes.size;
	}
}
