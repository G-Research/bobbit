// Pins the Vitest 4 unit-lane scheduler: three concurrent suites on a 24-core
// box each reserve eight workers, start core/integration/DOM immediately, and
// distribute the whole grant as 3+4+1 without bypassing the shared ledger.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it, beforeAll, afterAll } from "vitest";

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

const jobs = [
	{ name: "core", weight: 3 },
	{ name: "integration", weight: 4 },
	{ name: "dom", weight: 1 },
];

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

	it("allocates the normal eight-worker grant as core=3, integration=4, dom=1", async () => {
		const { planLaneWorkers } = await loadLanes();
		const plan = planLaneWorkers({ grant: 8, jobs });
		assert.deepEqual(plan.workers, { core: 3, integration: 4, dom: 1 });
		assert.equal(plan.maxConcurrent, 3, "all three lanes must start immediately");
		assert.equal(plan.used, 8, "the full reservation must do useful work");
	});

	it("never oversubscribes a grant and queues only when fewer than three workers exist", async () => {
		const { planLaneWorkers } = await loadLanes();
		for (const grant of [1, 2, 3, 4, 6, 8, 12]) {
			const plan = planLaneWorkers({ grant, jobs });
			const allocated = Object.values(plan.workers).reduce((sum: number, n: any) => sum + Number(n), 0);
			if (grant >= jobs.length) {
				assert.equal(allocated, grant, `grant=${grant} must be fully allocated`);
				assert.equal(plan.maxConcurrent, jobs.length, `grant=${grant} must not queue a lane`);
			} else {
				assert.equal(plan.maxConcurrent, grant, `grant=${grant} can run only ${grant} one-worker lane(s)`);
			}
		}
	});

	it("grants three staggered standalone unit suites eight workers each with no queue", async () => {
		const ledger = await loadLedger();
		const reservations: any[] = [];
		try {
			for (let i = 0; i < 3; i++) {
				reservations.push(ledger.reserveVitestLaneBudget({ coalesceMs: 0, totalCores: 24 }));
			}
			assert.deepEqual(reservations.map((r) => r.workerSlots), [8, 8, 8]);
			const snap = ledger.readLedger({ totalCores: 24 });
			assert.equal(snap.reservations.length, 3);
			assert.equal(snap.reservations.reduce((sum: number, r: any) => sum + r.workerSlots, 0), 24);

			const { planLaneWorkers } = await loadLanes();
			for (const reservation of reservations) {
				assert.equal(planLaneWorkers({ grant: reservation.workerSlots, jobs }).maxConcurrent, 3);
			}
		} finally {
			for (const reservation of reservations.reverse()) reservation.release();
		}
	});

	it("gives direct Vitest the same ledger-governed cap as the lane orchestrator", async () => {
		const ledger = await loadLedger();
		const direct = ledger.reserveWorkerSlots("vitest", { coalesceMs: 0, totalCores: 24 });
		try {
			assert.equal(direct.workerSlots, 8);
			const snap = ledger.readLedger({ totalCores: 24 });
			assert.equal(snap.reservations.length, 1);
			assert.equal(snap.reservations[0].workerSlots, 8);
		} finally {
			direct.release();
		}
	});

	it("reuses a parent grant without registering a second ledger entry", async () => {
		const ledger = await loadLedger();
		process.env.BOBBIT_V2_LEDGER_PARENT = "parent-test";
		process.env.BOBBIT_V2_SLOTS_VITEST = "8";
		try {
			const child = ledger.reserveVitestLaneBudget({ coalesceMs: 0, totalCores: 24 });
			assert.equal(child.managedByParent, true);
			assert.equal(child.workerSlots, 8);
			assert.equal(ledger.readLedger({ totalCores: 24 }).reservations.length, 0);
			child.release();
		} finally {
			delete process.env.BOBBIT_V2_LEDGER_PARENT;
			delete process.env.BOBBIT_V2_SLOTS_VITEST;
		}
	});
});
