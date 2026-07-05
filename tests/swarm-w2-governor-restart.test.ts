/**
 * SWARM-W2 — `SwarmGovernor.registerNode`'s `opts.elapsedMs` (restart-resume,
 * design/swarm-orchestration.md §11 Wave 2 "restart-resume"; carried forward
 * explicitly by docs/design/swarm-orchestration-w1.md's "Deliberately NOT
 * built this wave" note).
 *
 * A restart re-arm must NOT grant a straggler a fresh full `wallClockMs`
 * budget measured from the restart moment — that would let an unbounded
 * number of restarts keep resetting the clock forever, defeating the
 * guarantee that a swarm always converges (design §6/§7). These tests pin
 * the elapsed-time-aware arithmetic directly against the injectable
 * scheduler, independent of any restart-sweep wiring (see
 * `swarm-w2-restart-resume.test.ts` for the boot-sweep integration).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SwarmGovernor } from "../src/server/agent/swarm-governor.ts";

describe("SwarmGovernor.registerNode — elapsedMs (restart re-arm)", () => {
	it("schedules the straggler timer for wallClockMs - elapsedMs, not the full wallClockMs", () => {
		const scheduled: Array<{ fn: () => void; ms: number }> = [];
		const gov = new SwarmGovernor({ schedule: (fn, ms) => { scheduled.push({ fn, ms }); return {} as any; }, clear: () => {} });
		gov.registerNode("g1", { tokenBudget: 0, wallClockMs: 10_000 }, () => {}, { elapsedMs: 4_000 });
		assert.equal(scheduled.length, 1);
		assert.equal(scheduled[0].ms, 6_000, "only the REMAINING wall-clock budget should be scheduled");
	});

	it("a node already past its deadline before re-arm fires (almost) immediately, not never", () => {
		const scheduled: Array<{ fn: () => void; ms: number }> = [];
		const gov = new SwarmGovernor({ schedule: (fn, ms) => { scheduled.push({ fn, ms }); return {} as any; }, clear: () => {} });
		let fired = false;
		gov.registerNode("g2", { tokenBudget: 0, wallClockMs: 10_000 }, () => { fired = true; }, { elapsedMs: 50_000 });
		assert.equal(scheduled.length, 1);
		assert.equal(scheduled[0].ms, 0, "clamped at zero, never negative — fires on the next tick rather than being silently un-governed");
		scheduled[0].fn();
		assert.equal(fired, true);
	});

	it("omitting opts (or elapsedMs:0) behaves exactly as a fresh registration — no behavior change for the non-restart path", () => {
		const scheduled: Array<{ fn: () => void; ms: number }> = [];
		const gov = new SwarmGovernor({ schedule: (fn, ms) => { scheduled.push({ fn, ms }); return {} as any; }, clear: () => {} });
		gov.registerNode("g3", { tokenBudget: 0, wallClockMs: 5_000 }, () => {});
		gov.registerNode("g4", { tokenBudget: 0, wallClockMs: 5_000 }, () => {}, { elapsedMs: 0 });
		assert.equal(scheduled[0].ms, 5_000);
		assert.equal(scheduled[1].ms, 5_000);
	});

	it("the straggler reason string flags that this was a restart re-arm when elapsedMs > 0", () => {
		const scheduled: Array<{ fn: () => void; ms: number }> = [];
		const gov = new SwarmGovernor({ schedule: (fn, ms) => { scheduled.push({ fn, ms }); return {} as any; }, clear: () => {} });
		let reason: string | undefined;
		gov.registerNode("g5", { tokenBudget: 0, wallClockMs: 10_000 }, (r) => { reason = r; }, { elapsedMs: 2_000 });
		scheduled[0].fn();
		assert.match(reason!, /re-armed after restart/);
	});

	it("token-budget enforcement is unaffected by elapsedMs — only the wall-clock timer is adjusted", () => {
		const gov = new SwarmGovernor({ schedule: () => ({} as any), clear: () => {} });
		gov.registerNode("g6", { tokenBudget: 1000, wallClockMs: 0 }, () => {}, { elapsedMs: 999_999 });
		assert.equal(gov.checkTokenBudget("g6", 500).kind, "ok");
		assert.equal(gov.checkTokenBudget("g6", 1000).kind, "abort-turn");
	});
});
