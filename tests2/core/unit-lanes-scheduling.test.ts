// Pins the unit-lanes ORCHESTRATOR scheduling contract so `npm run test:unit`
// (scripts/testing-v2/run-unit-lanes.mjs) reliably completes within the gate
// wall-time budget instead of collapsing to a serial run.
//
// THE BUG THIS GUARDS AGAINST: run-unit-lanes is an orchestrator that spawns
// MULTIPLE independent `vitest run --project ...` processes, each capped at a
// Windows-RPC-safe per-process fork count (default 2). Its wall time is designed
// to be max(lanes), not Σ(lanes). Earlier it reserved its budget via
// reserveWorkerSlots("vitest"), which returns the SINGLE-PROCESS throttle
// STANDALONE_VITEST_CAP (=2). Feeding that (=2) into the scheduler as the TOTAL
// budget forced perLane=2 ⇒ maxConcurrent=floor(2/2)=1 ⇒ the lanes ran SERIALLY
// (core THEN integration THEN dom), so the gate command timed out at ~1200s while
// integration was still running and dom was still queued.
//
// THE FIX (pinned here):
//   1. ledger.reserveVitestLaneBudget() gives the orchestrator the FAIR CORE grant
//      (up to VITEST_CAP), NOT the single-process throttle — while
//      reserveWorkerSlots("vitest") standalone is UNCHANGED at 2 (a single direct
//      vitest process must still stay under the RPC-safe per-process cap).
//   2. planLaneConcurrency() distributes that grant across lanes: perLane never
//      exceeds the safe per-process cap, and maxConcurrent = floor(grant/perLane)
//      so the lanes actually overlap.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it, beforeAll, afterAll } from "vitest";

// Both the ledger and the lanes runner resolve their ledger dir from os.tmpdir()
// live on each call, so pointing TEMP/TMP/TMPDIR at a fresh dir fully isolates
// this test from the real ledger and any concurrent run.
const origEnv = {
	TEMP: process.env.TEMP,
	TMP: process.env.TMP,
	TMPDIR: process.env.TMPDIR,
	BOBBIT_V2_TOTAL_CORES: process.env.BOBBIT_V2_TOTAL_CORES,
	BOBBIT_V2_LEDGER_PARENT: process.env.BOBBIT_V2_LEDGER_PARENT,
	BOBBIT_V2_SLOTS_VITEST: process.env.BOBBIT_V2_SLOTS_VITEST,
};
let isolatedTmp: string;

async function loadLedger() {
	return (await import("../../scripts/testing-v2/ledger.mjs")) as any;
}
async function loadLanes() {
	return (await import("../../scripts/testing-v2/run-unit-lanes.mjs")) as any;
}

describe("unit-lanes orchestrator scheduling", () => {
	beforeAll(() => {
		isolatedTmp = mkdtempSync(join(tmpdir(), "unit-lanes-sched-"));
		process.env.TEMP = isolatedTmp;
		process.env.TMP = isolatedTmp;
		process.env.TMPDIR = isolatedTmp;
		process.env.BOBBIT_V2_TOTAL_CORES = "24";
		delete process.env.BOBBIT_V2_LEDGER_PARENT;
		delete process.env.BOBBIT_V2_SLOTS_VITEST;
	});
	afterAll(() => {
		for (const [k, v] of Object.entries(origEnv)) {
			if (v === undefined) delete (process.env as any)[k];
			else (process.env as any)[k] = v;
		}
		try { rmSync(isolatedTmp, { recursive: true, force: true }); } catch { /* best-effort */ }
	});

	it("planLaneConcurrency never raises a lane above the per-process fork cap", async () => {
		const { planLaneConcurrency } = await loadLanes();
		for (const grant of [1, 2, 3, 4, 6, 8, 12]) {
			for (const cap of [1, 2, 3]) {
				const { perLane } = planLaneConcurrency({ grant, perLaneCap: cap, jobCount: 3 });
				assert.ok(perLane <= cap, `perLane ${perLane} must not exceed per-process cap ${cap} (grant=${grant})`);
				assert.ok(perLane <= grant, `perLane ${perLane} must not exceed grant ${grant}`);
				assert.ok(perLane >= 1, "perLane must be >= 1");
			}
		}
	});

	it("planLaneConcurrency keeps instantaneous forks (maxConcurrent*perLane) within the grant", async () => {
		const { planLaneConcurrency } = await loadLanes();
		for (const grant of [1, 2, 3, 4, 6, 8, 12]) {
			for (const cap of [1, 2, 3]) {
				for (const jobCount of [1, 3, 5]) {
					const { perLane, maxConcurrent } = planLaneConcurrency({ grant, perLaneCap: cap, jobCount });
					assert.ok(maxConcurrent * perLane <= grant, `inFlight forks ${maxConcurrent * perLane} must be <= grant ${grant} (cap=${cap}, jobs=${jobCount})`);
					assert.ok(maxConcurrent >= 1, "maxConcurrent must be >= 1 (always make progress)");
					assert.ok(maxConcurrent <= jobCount, `maxConcurrent ${maxConcurrent} must not exceed jobCount ${jobCount}`);
				}
			}
		}
	});

	it("REGRESSION: the single-process throttle (grant=2) collapses lanes to serial", async () => {
		const { planLaneConcurrency } = await loadLanes();
		// This is exactly the old broken path: reserveWorkerSlots("vitest") returned
		// STANDALONE_VITEST_CAP=2, perLaneCap default 2 ⇒ maxConcurrent=1 (serial).
		const plan = planLaneConcurrency({ grant: 2, perLaneCap: 2, jobCount: 3 });
		assert.equal(plan.perLane, 2);
		assert.equal(plan.maxConcurrent, 1, "grant=2 forces serial lanes — the timeout bug");
	});

	it("FIX: the fair orchestrator grant runs the 3 lanes concurrently", async () => {
		const { planLaneConcurrency } = await loadLanes();
		// The fair core grant (8 on a 24-core box) opens the scheduler back up so
		// all three lanes overlap: perLane stays at the safe cap, maxConcurrent >= 3.
		const plan = planLaneConcurrency({ grant: 8, perLaneCap: 2, jobCount: 3 });
		assert.equal(plan.perLane, 2, "each lane still runs at the safe per-process cap");
		assert.equal(plan.maxConcurrent, 3, "all three lanes run concurrently (wall = max(lanes))");
		// A mid grant of 6 still runs all three (6/2 = 3); 4 runs two waves.
		assert.equal(planLaneConcurrency({ grant: 6, perLaneCap: 2, jobCount: 3 }).maxConcurrent, 3);
		assert.equal(planLaneConcurrency({ grant: 4, perLaneCap: 2, jobCount: 3 }).maxConcurrent, 2);
	});

	it("reserveVitestLaneBudget grants the FAIR core budget, not the single-process throttle", async () => {
		const ledger = await loadLedger();
		// Standalone single-process vitest MUST stay at the RPC-safe throttle (=2):
		// this is the invariant the fix must not relax.
		const single = ledger.reserveWorkerSlots("vitest", { coalesceMs: 0, totalCores: 24 });
		try {
			assert.equal(single.workerSlots, 2, "a single direct vitest process must stay at STANDALONE_VITEST_CAP");
		} finally {
			single.release();
		}
		// The orchestrator gets a fair core grant (> the single-process throttle, up
		// to VITEST_CAP=8), enabling maxConcurrent > 1.
		const orch = ledger.reserveVitestLaneBudget({ coalesceMs: 0, totalCores: 24 });
		try {
			assert.equal(orch.managedByParent, false);
			assert.ok(orch.workerSlots > 2, `orchestrator budget ${orch.workerSlots} must exceed the single-process throttle (2)`);
			assert.ok(orch.workerSlots <= 8, `orchestrator budget ${orch.workerSlots} must not exceed VITEST_CAP (8)`);
			// The persisted reservation is the run's SINGLE ledger entry (lanes reuse it).
			const snap = ledger.readLedger({ totalCores: 24 });
			const rec = snap.reservations.find((r: any) => r.id === orch.reservationId);
			assert.equal(rec?.workerSlots, orch.workerSlots, "the persisted reservation must match the returned grant");
			assert.equal(snap.reservations.length, 1, "the orchestrator holds exactly ONE ledger entry for the run");
			// The fair grant unblocks concurrency: maxConcurrent >= 3 for the 3 lanes.
			const { planLaneConcurrency } = await loadLanes();
			const plan = planLaneConcurrency({ grant: orch.workerSlots, perLaneCap: 2, jobCount: 3 });
			assert.ok(plan.maxConcurrent >= 3, `fair grant ${orch.workerSlots} must run all 3 lanes concurrently, got maxConcurrent=${plan.maxConcurrent}`);
		} finally {
			orch.release();
		}
	});

	it("reserveVitestLaneBudget REUSES a parent grant (preserves run-v2 ledger behavior)", async () => {
		const ledger = await loadLedger();
		process.env.BOBBIT_V2_LEDGER_PARENT = "parent-test";
		process.env.BOBBIT_V2_SLOTS_VITEST = "8";
		try {
			const child = ledger.reserveVitestLaneBudget({ coalesceMs: 0, totalCores: 24 });
			assert.equal(child.managedByParent, true, "under a parent, the orchestrator must reuse the grant");
			assert.equal(child.workerSlots, 8, "child must preserve the explicit parent grant");
			// A managed reuse must NOT register a second ledger entry.
			const snap = ledger.readLedger({ totalCores: 24 });
			assert.equal(snap.reservations.length, 0, "parent-managed reuse must not register its own reservation");
			child.release();
		} finally {
			delete process.env.BOBBIT_V2_LEDGER_PARENT;
			delete process.env.BOBBIT_V2_SLOTS_VITEST;
		}
	});
});
