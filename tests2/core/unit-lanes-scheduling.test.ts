// Pins the unit-lanes ORCHESTRATOR scheduling contract so `npm run test:unit`
// (scripts/testing-v2/run-unit-lanes.mjs) reliably completes within the gate
// wall-time budget instead of collapsing to a serial run.
//
// THE BUG THIS GUARDS AGAINST: run-unit-lanes is an orchestrator that spawns
// MULTIPLE independent `vitest run --project ...` processes. Vitest 3.2 still
// produced worker-RPC timeouts on Windows when all concurrent lanes used the old
// two-fork default, so Windows now defaults each lane to one fork while other
// platforms keep two. A single one-fork integration lane then narrowly exceeded
// the gate wall time, so Windows cost-balances its integration files over two
// disjoint one-fork jobs, with at most three jobs active at once to avoid the
// four-process starvation seen in gates; non-Windows retains the single integration
// job and grant-only concurrency. Its wall time is designed to be max(lanes), not
// Σ(lanes). Earlier it reserved its budget via
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
//      exceeds the safe per-process cap, maxConcurrent stays within the ledger
//      grant, and Windows additionally caps active lane jobs at three so the lanes
//      overlap without four-process starvation.
//   3. signal/error cleanup kills every active lane process tree and releases the
//      single ledger reservation, preventing timed-out gates from leaking either.
import { EventEmitter } from "node:events";
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

	it("uses one fork per Windows lane by default while preserving overrides and non-Windows defaults", async () => {
		const { defaultPerLaneForkCap, resolvePerLaneForkCap } = await loadLanes();
		assert.equal(defaultPerLaneForkCap("win32"), 1);
		assert.equal(defaultPerLaneForkCap("linux"), 2);
		assert.equal(defaultPerLaneForkCap("darwin"), 2);
		assert.equal(resolvePerLaneForkCap({ platform: "win32", override: undefined }), 1);
		assert.equal(resolvePerLaneForkCap({ platform: "win32", override: "garbage" }), 1, "invalid overrides use the Windows default");
		assert.equal(resolvePerLaneForkCap({ platform: "linux", override: "garbage" }), 2, "invalid overrides use the non-Windows default");
		assert.equal(resolvePerLaneForkCap({ platform: "win32", override: "3" }), 3, "an explicit override is preserved");
		assert.equal(resolvePerLaneForkCap({ platform: "win32", override: "0" }), 1, "explicit values remain clamped to one");
	});

	it("defaults Windows integration to two shards while preserving overrides and non-Windows behavior", async () => {
		const { defaultIntegrationShardCount, resolveIntegrationShardCount } = await loadLanes();
		assert.equal(defaultIntegrationShardCount("win32"), 2);
		assert.equal(defaultIntegrationShardCount("linux"), 1);
		assert.equal(defaultIntegrationShardCount("darwin"), 1);
		assert.equal(resolveIntegrationShardCount({ platform: "win32", override: undefined }), 2);
		assert.equal(resolveIntegrationShardCount({ platform: "win32", override: "" }), 2);
		assert.equal(resolveIntegrationShardCount({ platform: "win32", override: "garbage" }), 2, "invalid overrides use the Windows default");
		assert.equal(resolveIntegrationShardCount({ platform: "linux", override: "garbage" }), 1, "invalid overrides use the non-Windows default");
		assert.equal(resolveIntegrationShardCount({ platform: "win32", override: "3" }), 3, "an explicit override is preserved");
		assert.equal(resolveIntegrationShardCount({ platform: "win32", override: "0" }), 1, "explicit values remain clamped to one");
	});

	it("cost-balances Windows integration into disjoint shards with exact file and project coverage", async () => {
		const { planLaneJobs } = await loadLanes();
		const files = [
			"tests2/integration/real-heavy.test.ts",
			"tests2/integration/fake-heavy.test.ts",
			"tests2/integration/real-light.test.ts",
			"tests2/integration/fake-light.test.ts",
		];
		const costs = new Map([
			[files[0], 8_000],
			[files[1], 7_000],
			[files[2], 5_000],
			[files[3], 6_000],
		]);
		const jobs = planLaneJobs({
			laneNames: ["integration"],
			platform: "win32",
			integrationShardOverride: undefined,
			integrationFiles: files,
			integrationCosts: costs,
		});
		assert.deepEqual(jobs.map((job: any) => job.name), ["integration-1", "integration-2"]);
		for (const job of jobs) {
			assert.deepEqual(job.projects, ["v2-integration", "v2-integration-fake"], "both disjoint unit integration projects remain selected");
		}
		const selected = jobs.flatMap((job: any) => job.files);
		assert.deepEqual([...selected].sort(), [...files].sort(), "the shard union must preserve every integration file");
		assert.equal(new Set(selected).size, files.length, "no integration file may be selected by more than one shard");
		assert.deepEqual(jobs.map((job: any) => job.files.reduce((sum: number, file: string) => sum + costs.get(file)!, 0)), [13_000, 13_000], "shards are balanced by recorded cost, not merely file count");
	});

	it("keeps non-Windows and explicit one-shard integration runs unfiltered", async () => {
		const { planLaneJobs } = await loadLanes();
		const files = ["tests2/integration/a.test.ts", "tests2/integration/b.test.ts"];
		for (const options of [
			{ platform: "linux", integrationShardOverride: undefined },
			{ platform: "win32", integrationShardOverride: "1" },
		]) {
			const jobs = planLaneJobs({ laneNames: ["integration"], integrationFiles: files, ...options });
			assert.deepEqual(jobs, [{ name: "integration", projects: ["v2-integration", "v2-integration-fake"], files: undefined }]);
		}
	});

	it("caps the four-job Windows default at three concurrent lanes", async () => {
		const { planLaneConcurrency, defaultConcurrentLaneJobCap, defaultPerLaneForkCap, planLaneJobs } = await loadLanes();
		const jobs = planLaneJobs({
			laneNames: ["core", "integration", "dom"],
			platform: "win32",
			integrationFiles: ["tests2/integration/a.test.ts", "tests2/integration/b.test.ts"],
		});
		assert.equal(jobs.length, 4, "core + two integration shards + dom");
		assert.equal(defaultConcurrentLaneJobCap("win32"), 3);
		const plan = planLaneConcurrency({
			grant: 8,
			perLaneCap: defaultPerLaneForkCap("win32"),
			jobCount: jobs.length,
			concurrentJobCap: defaultConcurrentLaneJobCap("win32"),
		});
		assert.deepEqual(plan, { perLane: 1, maxConcurrent: 3 });
	});

	it("preserves non-Windows grant scheduling and Windows fork/shard overrides", async () => {
		const { planLaneConcurrency, defaultConcurrentLaneJobCap, resolvePerLaneForkCap, planLaneJobs } = await loadLanes();
		assert.equal(defaultConcurrentLaneJobCap("linux"), Number.POSITIVE_INFINITY);
		assert.equal(defaultConcurrentLaneJobCap("darwin"), Number.POSITIVE_INFINITY);
		assert.deepEqual(planLaneConcurrency({
			grant: 8,
			perLaneCap: 2,
			jobCount: 4,
			concurrentJobCap: defaultConcurrentLaneJobCap("linux"),
		}), { perLane: 2, maxConcurrent: 4 }, "non-Windows remains limited only by its ledger grant");

		const jobs = planLaneJobs({
			laneNames: ["core", "integration", "dom"],
			platform: "win32",
			integrationShardOverride: "3",
			integrationFiles: [
				"tests2/integration/a.test.ts",
				"tests2/integration/b.test.ts",
				"tests2/integration/c.test.ts",
			],
		});
		assert.equal(jobs.length, 5, "explicit three-shard override remains effective");
		assert.deepEqual(planLaneConcurrency({
			grant: 8,
			perLaneCap: resolvePerLaneForkCap({ platform: "win32", override: "2" }),
			jobCount: jobs.length,
			concurrentJobCap: defaultConcurrentLaneJobCap("win32"),
		}), { perLane: 2, maxConcurrent: 3 }, "fork override is preserved while active jobs stay capped");
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

	it("planLaneConcurrency keeps instantaneous forks and active jobs within their caps", async () => {
		const { planLaneConcurrency } = await loadLanes();
		for (const grant of [1, 2, 3, 4, 6, 8, 12]) {
			for (const cap of [1, 2, 3]) {
				for (const jobCount of [1, 3, 5]) {
					for (const concurrentJobCap of [1, 3, Number.POSITIVE_INFINITY]) {
						const { perLane, maxConcurrent } = planLaneConcurrency({ grant, perLaneCap: cap, jobCount, concurrentJobCap });
						assert.ok(maxConcurrent * perLane <= grant, `inFlight forks ${maxConcurrent * perLane} must be <= grant ${grant} (cap=${cap}, jobs=${jobCount})`);
						assert.ok(maxConcurrent >= 1, "maxConcurrent must be >= 1 (always make progress)");
						assert.ok(maxConcurrent <= jobCount, `maxConcurrent ${maxConcurrent} must not exceed jobCount ${jobCount}`);
						if (Number.isFinite(concurrentJobCap)) {
							assert.ok(maxConcurrent <= concurrentJobCap, `maxConcurrent ${maxConcurrent} must not exceed job cap ${concurrentJobCap}`);
						}
					}
				}
			}
		}
	});

	it("REGRESSION: the single-process throttle (grant=2) collapses lanes to serial", async () => {
		const { planLaneConcurrency } = await loadLanes();
		// This is exactly the old broken path: reserveWorkerSlots("vitest") returned
		// STANDALONE_VITEST_CAP=2 with the former two-fork lane default, forcing
		// maxConcurrent=1 (serial).
		const plan = planLaneConcurrency({ grant: 2, perLaneCap: 2, jobCount: 3 });
		assert.equal(plan.perLane, 2);
		assert.equal(plan.maxConcurrent, 1, "grant=2 forces serial lanes — the timeout bug");
	});

	it("the fair orchestrator grant runs the 3 lanes concurrently with a two-fork cap", async () => {
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

	it("cleanup is idempotent and reaps every child tree, heartbeat, and ledger reservation", async () => {
		const { createRunCleanup } = await loadLanes();
		const killed: unknown[] = [];
		const cleared: unknown[] = [];
		let releases = 0;
		const cleanup = createRunCleanup({
			release: () => { releases += 1; },
			killTree: (child: unknown) => { killed.push(child); },
			clearTimer: (timer: unknown) => { cleared.push(timer); },
		});
		const first = { pid: 101 };
		const second = { pid: 102 };
		cleanup.track(first);
		cleanup.track(second);
		cleanup.untrack(first);
		cleanup.setHeartbeat("heartbeat");
		cleanup.cleanup();
		cleanup.cleanup();
		assert.deepEqual(killed, [second], "only the still-active child tree is killed");
		assert.deepEqual(cleared, ["heartbeat"]);
		assert.equal(releases, 1, "the ledger reservation is released exactly once");

		const late = { pid: 103 };
		cleanup.track(late);
		assert.deepEqual(killed, [second, late], "a child tracked after cleanup is killed immediately");
	});

	it("kills Windows and POSIX lane process trees through the platform seam", async () => {
		const { killLaneProcessTree } = await loadLanes();
		const taskkills: unknown[][] = [];
		const childSignals: string[] = [];
		killLaneProcessTree({ pid: 4242, kill: (signal: string) => childSignals.push(signal) }, {
			platform: "win32",
			spawnSyncImpl: (...args: unknown[]) => { taskkills.push(args); },
		});
		assert.equal(taskkills.length, 1);
		assert.equal(taskkills[0][0], "taskkill.exe");
		assert.deepEqual(taskkills[0][1], ["/PID", "4242", "/T", "/F"]);
		assert.deepEqual(childSignals, ["SIGKILL"], "the root kill is a fallback after taskkill /T");

		const groupKills: unknown[][] = [];
		killLaneProcessTree({ pid: 5252 }, {
			platform: "linux",
			killImpl: (...args: unknown[]) => { groupKills.push(args); },
		});
		assert.deepEqual(groupKills, [[-5252, "SIGKILL"]], "POSIX kills the detached process group");
	});

	it("signal, exception, rejection, and exit handlers always reap children and release the ledger", async () => {
		const { createRunCleanup, installRunTerminationHandlers } = await loadLanes();
		const cases = [
			{ event: "SIGINT", payload: undefined, exitCode: 130 },
			{ event: "SIGTERM", payload: undefined, exitCode: 143 },
			{ event: "SIGHUP", payload: undefined, exitCode: 129 },
			{ event: "uncaughtException", payload: new Error("boom"), exitCode: 1 },
			{ event: "unhandledRejection", payload: new Error("rejected"), exitCode: 1 },
		] as const;
		for (const testCase of cases) {
			const target = new EventEmitter() as EventEmitter & { exit(code: number): void; exitCodes: number[] };
			target.exitCodes = [];
			target.exit = (code: number) => { target.exitCodes.push(code); };
			const killed: unknown[] = [];
			let releases = 0;
			const cleanup = createRunCleanup({
				release: () => { releases += 1; },
				killTree: (child: unknown) => { killed.push(child); },
			});
			const child = { pid: 6000 + testCase.exitCode };
			cleanup.track(child);
			const reported: unknown[][] = [];
			const uninstall = installRunTerminationHandlers(cleanup, {
				processTarget: target,
				reportError: (...args: unknown[]) => { reported.push(args); },
			});
			if (testCase.payload === undefined) target.emit(testCase.event);
			else target.emit(testCase.event, testCase.payload);
			assert.deepEqual(killed, [child], `${testCase.event} must kill the child tree`);
			assert.equal(releases, 1, `${testCase.event} must release the ledger`);
			assert.deepEqual(target.exitCodes, [testCase.exitCode]);
			assert.equal(reported.length, testCase.payload === undefined ? 0 : 1);
			uninstall();
		}

		const target = new EventEmitter() as EventEmitter & { exit(code: number): void };
		target.exit = () => { throw new Error("exit must not be called by the exit hook"); };
		const killed: unknown[] = [];
		let releases = 0;
		const cleanup = createRunCleanup({
			release: () => { releases += 1; },
			killTree: (child: unknown) => { killed.push(child); },
		});
		const child = { pid: 7000 };
		cleanup.track(child);
		const uninstall = installRunTerminationHandlers(cleanup, { processTarget: target });
		target.emit("exit", 1);
		assert.deepEqual(killed, [child]);
		assert.equal(releases, 1);
		uninstall();
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
