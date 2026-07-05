/**
 * SWARM-W1 — hard resource governor (design/swarm-orchestration.md §6,
 * must-fix #1 + straggler wall-clock hard-kill).
 *
 * Pure-logic tests against `SwarmGovernor` directly — no server wiring.
 * Verifies:
 *   - an unregistered (non-swarm) goal is always `{kind:"ok"}` — zero
 *     overhead / zero behavior change for every existing session.
 *   - a token spend crossing `tokenBudget` yields `abort-turn` (soft).
 *   - a token spend crossing `tokenBudget * hardKillMarginMultiplier`
 *     yields `hard-kill` (the backstop — never just advisory).
 *   - `unregisterNode` (called from the terminal path) disarms BOTH the
 *     token-budget check and the straggler timer.
 *   - the straggler wall-clock deadline fires exactly once via the
 *     injectable clock/scheduler, and does NOT fire if the node is
 *     unregistered first (a node that reaches terminal before its
 *     deadline must never be treated as a straggler).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SwarmGovernor } from "../src/server/agent/swarm-governor.ts";

describe("SwarmGovernor — token-budget turn-boundary enforcement", () => {
	it("an unregistered goal always returns ok (zero overhead for non-swarm sessions)", () => {
		const gov = new SwarmGovernor();
		assert.deepEqual(gov.checkTokenBudget("not-a-swarm-goal", 10_000_000), { kind: "ok" });
	});

	it("returns ok below the token budget, abort-turn at/above it", () => {
		const gov = new SwarmGovernor();
		gov.registerNode("g1", { tokenBudget: 1000, wallClockMs: 0 }, () => { throw new Error("must not fire — wallClockMs disabled"); });
		assert.deepEqual(gov.checkTokenBudget("g1", 500), { kind: "ok" });
		const action = gov.checkTokenBudget("g1", 1000);
		assert.equal(action.kind, "abort-turn");
	});

	it("escalates to hard-kill once spend crosses tokenBudget * hardKillMarginMultiplier — never JUST advisory", () => {
		const gov = new SwarmGovernor();
		gov.registerNode("g2", { tokenBudget: 1000, hardKillMarginMultiplier: 1.5, wallClockMs: 0 }, () => {});
		assert.equal(gov.checkTokenBudget("g2", 1000).kind, "abort-turn");
		assert.equal(gov.checkTokenBudget("g2", 1499).kind, "abort-turn", "still below the 1500 hard-kill ceiling");
		const hardKill = gov.checkTokenBudget("g2", 1500);
		assert.equal(hardKill.kind, "hard-kill");
	});

	it("defaults hardKillMarginMultiplier to 1.5 when omitted", () => {
		const gov = new SwarmGovernor();
		gov.registerNode("g3", { tokenBudget: 100, wallClockMs: 0 }, () => {});
		assert.equal(gov.checkTokenBudget("g3", 149).kind, "abort-turn");
		assert.equal(gov.checkTokenBudget("g3", 150).kind, "hard-kill");
	});

	it("unregisterNode disarms the token-budget check — a terminal node is never re-checked", () => {
		const gov = new SwarmGovernor();
		gov.registerNode("g4", { tokenBudget: 100, wallClockMs: 0 }, () => {});
		gov.unregisterNode("g4");
		assert.deepEqual(gov.checkTokenBudget("g4", 999_999), { kind: "ok" });
	});

	it("a zero/non-finite tokenBudget disables the token check entirely (treated as unbudgeted, not zero-tolerance)", () => {
		const gov = new SwarmGovernor();
		gov.registerNode("g5", { tokenBudget: 0, wallClockMs: 0 }, () => {});
		assert.deepEqual(gov.checkTokenBudget("g5", 1_000_000), { kind: "ok" });
	});
});

describe("SwarmGovernor — straggler wall-clock hard-kill (design §6/§7: the swarm must always be able to converge)", () => {
	it("fires onStraggler exactly once at the configured deadline via the injectable scheduler", () => {
		const scheduled: Array<{ fn: () => void; ms: number }> = [];
		const gov = new SwarmGovernor({
			schedule: (fn, ms) => { scheduled.push({ fn, ms }); return {} as any; },
			clear: () => {},
		});
		let firedReason: string | undefined;
		gov.registerNode("straggler-1", { tokenBudget: 0, wallClockMs: 5000 }, (reason) => { firedReason = reason; });
		assert.equal(scheduled.length, 1);
		assert.equal(scheduled[0].ms, 5000);
		assert.equal(firedReason, undefined, "must not fire before the scheduled callback runs");
		scheduled[0].fn();
		assert.match(firedReason!, /straggler wall-clock/);
	});

	it("does NOT fire if unregisterNode is called before the timer runs (a normal terminal beats a slow straggler clock)", () => {
		const scheduled: Array<{ fn: () => void; ms: number }> = [];
		const cleared: unknown[] = [];
		const gov = new SwarmGovernor({
			schedule: (fn, ms) => { const t = { fn, ms }; scheduled.push(t); return t as any; },
			clear: (t) => { cleared.push(t); },
		});
		let fired = false;
		gov.registerNode("straggler-2", { tokenBudget: 0, wallClockMs: 5000 }, () => { fired = true; });
		gov.unregisterNode("straggler-2");
		assert.equal(cleared.length, 1, "the straggler timer must be cleared on unregister");
		// Even if the (already-cleared, in a real setTimeout) callback somehow ran, the
		// governor's own re-check (`this.nodes.get(goalId) === state`) guards against it:
		scheduled[0].fn();
		assert.equal(fired, false);
	});

	it("re-registering the same goalId resets the clock and re-arms a fresh timer (defensive — resumed/restarted node)", () => {
		let scheduleCalls = 0;
		const cleared: unknown[] = [];
		const gov = new SwarmGovernor({
			schedule: (fn, ms) => { scheduleCalls++; return { fn, ms } as any; },
			clear: (t) => { cleared.push(t); },
		});
		gov.registerNode("g6", { tokenBudget: 0, wallClockMs: 1000 }, () => {});
		gov.registerNode("g6", { tokenBudget: 0, wallClockMs: 1000 }, () => {});
		assert.equal(scheduleCalls, 2);
		assert.equal(cleared.length, 1, "the FIRST timer must be cleared before arming the second");
	});

	it("isRegistered reflects registration state; size counts governed nodes", () => {
		const gov = new SwarmGovernor({ schedule: () => ({} as any), clear: () => {} });
		assert.equal(gov.isRegistered("g7"), false);
		gov.registerNode("g7", { tokenBudget: 0, wallClockMs: 0 }, () => {});
		assert.equal(gov.isRegistered("g7"), true);
		assert.equal(gov.size, 1);
		gov.unregisterNode("g7");
		assert.equal(gov.isRegistered("g7"), false);
		assert.equal(gov.size, 0);
	});

	it("a zero/absent wallClockMs never arms a straggler timer", () => {
		let scheduleCalls = 0;
		const gov = new SwarmGovernor({ schedule: () => { scheduleCalls++; return {} as any; }, clear: () => {} });
		gov.registerNode("g8", { tokenBudget: 0, wallClockMs: 0 }, () => {});
		assert.equal(scheduleCalls, 0);
	});
});
