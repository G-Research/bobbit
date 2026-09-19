// Pins that tests/e2e/ledger-lease-bridge.mjs (the Playwright-safe lease client)
// and scripts/testing-v2/ledger.mjs (the vitest/CLI lease implementation) speak
// the SAME on-disk lease protocol, so the global concurrency caps hold across the
// browser tier AND the vitest tier AND concurrent runs. If someone changes one
// side's ledger dir / lock rule / leases shape / cap resolution without the
// other, this test fails — see the INVARIANT note in ledger-lease-bridge.mjs.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { describe, it, beforeAll, afterAll } from "vitest";
import {
	runFixtureCommandWithBackend,
	type FixtureCommandBackend,
} from "../../../tests/support/harnesses/shared/spawn-with-retry.js";

// The production ledger deliberately lives under the OS temp root so all
// workflow runs on one machine share its caps. This fixture must never use
// that real pool: an explicit, per-file root avoids inheriting a busy lease
// from a browser/E2E process or another unit run.
const origEnv = {
	BOBBIT_V2_LEDGER_DIR: process.env.BOBBIT_V2_LEDGER_DIR,
	BOBBIT_V2_MAX_BROWSER: process.env.BOBBIT_V2_MAX_BROWSER,
	BOBBIT_V2_TOTAL_CORES: process.env.BOBBIT_V2_TOTAL_CORES,
	BOBBIT_V2_LEDGER_PARENT: process.env.BOBBIT_V2_LEDGER_PARENT,
	BOBBIT_V2_SLOTS_VITEST: process.env.BOBBIT_V2_SLOTS_VITEST,
};
const LEDGER_MODULE_URL = pathToFileURL(
	resolve("scripts/testing-v2/ledger.mjs"),
).href;
type NativeSpawn = typeof import("node:child_process").spawn;
type SpawnGuardState = { originals?: { spawn?: NativeSpawn } };
const SPAWN_GUARD_STATE = Symbol.for("bobbit.tests.tier1-spawn-guard-state");
const LEDGER_CHILD_SCRIPT = `
const ledger = await import(process.env.BOBBIT_TEST_LEDGER_MODULE_URL);
const reservation = ledger.reserveWorkerSlots("vitest", { coalesceMs: 0, totalCores: 16 });
process.stdout.write(JSON.stringify({
	ledgerDir: ledger.ledgerDir(),
	tmpdir: (await import("node:os")).tmpdir(),
	reservations: ledger.readLedger({ totalCores: 16 }).reservations,
}) + "\\n");
if (process.env.BOBBIT_TEST_LEDGER_HOLD === "1") {
	process.stdin.resume();
	await new Promise((resolve) => process.stdin.once("data", resolve));
}
reservation.release();
`;

// This pre-guard bootstrap command owns both coordinators. The tier-1 test
// itself only invokes the harness-approved fixture runner; the subprocess fence
// remains closed for all test logic while the bootstrap proves real processes
// with separate temp roots share one explicit ledger.
const TWO_PROCESS_LEDGER_SCRIPT = `
import { spawn } from "node:child_process";

const workerScript = ${JSON.stringify(LEDGER_CHILD_SCRIPT)};
const [firstRoot, secondRoot, ledgerRoot] = process.argv.slice(1);
const start = (tempRoot, hold) => spawn(process.execPath, ["--input-type=module", "--eval", workerScript], {
	env: {
		...process.env,
		TEMP: tempRoot,
		TMP: tempRoot,
		TMPDIR: tempRoot,
		BOBBIT_V2_LEDGER_DIR: ledgerRoot,
		BOBBIT_TEST_LEDGER_HOLD: hold ? "1" : "0",
	},
	stdio: ["pipe", "pipe", "pipe"],
});
const awaitFirstJson = (child) => new Promise((resolve, reject) => {
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += chunk;
		const newline = output.indexOf("\\n");
		if (newline >= 0) resolve(JSON.parse(output.slice(0, newline)));
	});
	child.once("error", reject);
	child.once("exit", (code) => reject(new Error(\`ledger child exited before reservation (\${code})\`)));
});
const awaitExit = (child) => new Promise((resolve, reject) => {
	let stderr = "";
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	child.once("error", reject);
	child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(\`ledger child exited \${code}: \${stderr}\`)));
});
const first = start(firstRoot, true);
const firstExit = awaitExit(first);
try {
	const firstState = await awaitFirstJson(first);
	const second = start(secondRoot, false);
	const secondExit = awaitExit(second);
	const secondState = await awaitFirstJson(second);
	await secondExit;
	process.stdout.write(JSON.stringify({ firstPid: first.pid, secondPid: second.pid, firstState, secondState }) + "\\n");
} finally {
	first.stdin.end("release\\n");
	await firstExit;
}
`;
let isolatedTmp: string;

async function loadBoth() {
	const ledger: any = await import("../../../scripts/testing-v2/ledger.mjs");
	const bridge: any = await import("../../../tests/e2e/ledger-lease-bridge.mjs");
	return { ledger, bridge };
}

function seedLeases(leases: Array<Record<string, unknown>>) {
	const ledgerRoot = process.env.BOBBIT_V2_LEDGER_DIR!;
	mkdirSync(ledgerRoot, { recursive: true });
	writeFileSync(join(ledgerRoot, "leases.json"), `${JSON.stringify({ generation: 1, leases }, null, 2)}\n`);
}

function rawLeases(): any[] {
	return JSON.parse(readFileSync(join(process.env.BOBBIT_V2_LEDGER_DIR!, "leases.json"), "utf8")).leases;
}

function preGuardFixtureBackend(): FixtureCommandBackend {
	const state = (process as NodeJS.Process & { [SPAWN_GUARD_STATE]?: SpawnGuardState })[SPAWN_GUARD_STATE];
	const spawn = state?.originals?.spawn;
	if (!spawn) throw new Error("ledger multi-process fixture requires the spawn preserved before the tier-1 guard");
	return {
		spawn(file, args, options) {
			const child = spawn(file, [...args], options);
			return {
				onStdout: listener => { child.stdout.on("data", listener); },
				onStderr: listener => { child.stderr.on("data", listener); },
				onError: listener => { child.once("error", listener); },
				onClose: listener => { child.once("close", listener); },
				kill: signal => { child.kill(signal); },
			};
		},
		schedule(callback, delayMs) {
			const timer = setTimeout(callback, delayMs);
			return { cancel: () => clearTimeout(timer), unref: () => timer.unref() };
		},
		sleep: delayMs => delayMs === 0 ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, delayMs)),
	};
}

async function runTwoProcessLedgerFixture(ledgerRoot: string) {
	const result = await runFixtureCommandWithBackend(process.execPath, [
		"--input-type=module",
		"--eval",
		TWO_PROCESS_LEDGER_SCRIPT,
		join(isolatedTmp, "worker-a"),
		join(isolatedTmp, "worker-b"),
		ledgerRoot,
	], {
		attempts: 1,
		env: {
			...process.env,
			BOBBIT_TEST_LEDGER_MODULE_URL: LEDGER_MODULE_URL,
		},
	}, preGuardFixtureBackend());
	return JSON.parse(result.stdout) as {
		firstPid: number;
		secondPid: number;
		firstState: any;
		secondState: any;
	};
}

describe("ledger-lease-bridge ↔ ledger.mjs interop", () => {
	beforeAll(() => {
		isolatedTmp = mkdtempSync(join(tmpdir(), "lease-interop-"));
		process.env.BOBBIT_V2_LEDGER_DIR = join(isolatedTmp, "ledger");
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

	it("shares an explicit ledger root across processes with distinct temp roots", async () => {
		const ledgerRoot = join(isolatedTmp, "two-process-ledger");
		const { firstPid, secondPid, firstState, secondState } = await runTwoProcessLedgerFixture(ledgerRoot);

		assert.equal(firstState.ledgerDir, ledgerRoot);
		assert.equal(secondState.ledgerDir, ledgerRoot);
		assert.notEqual(firstState.tmpdir, secondState.tmpdir);
		assert.equal(secondState.reservations.length, 2);
		assert.deepEqual(
			new Set(secondState.reservations.map((reservation: any) => reservation.pid)),
			new Set([firstPid, secondPid]),
			"the second coordinator must observe the first reservation in the shared ledger",
		);
	});

	it("resolves identical caps (budget-caps.json, env override, opts.cap)", async () => {
		const { ledger, bridge } = await loadBoth();
		const canonicalCapsPath = resolve("tests", "support", "data", "quality", "budgets", "budget-caps.json");
		const canonicalCaps = JSON.parse(readFileSync(canonicalCapsPath, "utf8"));
		assert.equal(canonicalCaps["gateway-boot"], 4);
		assert.equal(canonicalCaps.browser, 4);
		assert.equal(canonicalCapsPath.replaceAll("\\", "/").endsWith("tests/support/data/quality/budgets/budget-caps.json"), true);
		delete process.env.BOBBIT_V2_MAX_BROWSER;
		assert.equal(ledger.leaseCap("browser"), canonicalCaps.browser, "ledger must consume the canonical browser cap");
		assert.equal(bridge.leaseCap("browser"), ledger.leaseCap("browser"), "budget-caps.json browser cap must match");
		assert.equal(bridge.leaseCap("gateway-boot"), ledger.leaseCap("gateway-boot"), "gateway-boot cap must match");
		process.env.BOBBIT_V2_MAX_BROWSER = "7";
		assert.equal(bridge.leaseCap("browser"), 7, "bridge honors env override");
		assert.equal(ledger.leaseCap("browser"), 7, "ledger honors env override");
		delete process.env.BOBBIT_V2_MAX_BROWSER;
		assert.equal(bridge.leaseCap("browser", { cap: 3 }), 3);
		assert.equal(ledger.leaseCap("browser", { cap: 3 }), 3);
	});

	it("gives standalone Vitest the same ledger-governed cap as parent grants", async () => {
		const { ledger } = await loadBoth();
		const standalone = ledger.reserveWorkerSlots("vitest", { coalesceMs: 0, totalCores: 24 });
		try {
			assert.equal(standalone.managedByParent, false);
			assert.equal(standalone.workerSlots, 8, "Vitest 4 direct runs should use the full ledger-governed grant");
			const snapshot = ledger.readLedger({ totalCores: 24 });
			const record = snapshot.reservations.find((r: any) => r.id === standalone.reservationId);
			assert.equal(record?.workerSlots, 8, "the persisted reservation must match the returned standalone cap");
		} finally {
			standalone.release();
		}

		const parent = ledger.reserveParentBundle({ coalesceMs: 0, totalCores: 24 });
		try {
			assert.equal(parent.vitest, 8, "run-v2 parent-ledger fast path still grants the full vitest split");
		} finally {
			parent.release();
		}

		process.env.BOBBIT_V2_LEDGER_PARENT = "parent-test";
		process.env.BOBBIT_V2_SLOTS_VITEST = "8";
		try {
			const child = ledger.reserveWorkerSlots("vitest", { coalesceMs: 0, totalCores: 24 });
			assert.equal(child.managedByParent, true);
			assert.equal(child.workerSlots, 8, "child configs must preserve an explicit parent grant");
		} finally {
			delete process.env.BOBBIT_V2_LEDGER_PARENT;
			delete process.env.BOBBIT_V2_SLOTS_VITEST;
		}
	});

	it("a lease taken by one impl is SEEN by the other (shared cross-process pool)", async () => {
		const { ledger, bridge } = await loadBoth();
		// Fill the browser pool to cap=2 via the BRIDGE.
		const b1 = await bridge.acquireLease("browser", { cap: 2, timeoutMs: 5000 });
		const b2 = await bridge.acquireLease("browser", { cap: 2, timeoutMs: 5000 });
		assert.equal(b1.forced, false);
		assert.equal(b2.forced, false);
		// The LEDGER must now see the pool at cap → a short-timeout acquire fail-opens
		// (forced). This proves the ledger reads the bridge's leases from the same file.
		const l3 = await ledger.acquireLease("browser", { cap: 2, timeoutMs: 600 });
		assert.equal(l3.forced, true, "ledger must see the bridge's leases and hit the cap");
		l3.release(); // drop the forced entry so it doesn't itself occupy a slot
		// Release one bridge lease; a fresh ledger acquire now gets a real (non-forced)
		// slot — proving release visibility across implementations.
		b1.release();
		const l4 = await ledger.acquireLease("browser", { cap: 2, timeoutMs: 4000 });
		assert.equal(l4.forced, false, "ledger must get the slot freed by the bridge");
		b2.release();
		l4.release();
		const after = ledger.readLeases();
		assert.equal(after.leases.filter((x: any) => x.pool === "browser").length, 0, "all leases released");
	});

	it("fails strict acquisition at the bounded deadline without exceeding the cap", async () => {
		const { ledger, bridge } = await loadBoth();
		for (const [name, implementation] of [["ledger", ledger], ["bridge", bridge]] as const) {
			const pool = `strict-timeout-${name}`;
			const holder = await implementation.acquireLease(pool, { cap: 1, timeoutMs: 100 });
			let now = 0;
			let sleeps = 0;
			await assert.rejects(
				implementation.acquireLease(pool, {
					cap: 1,
					timeoutMs: 10,
					strict: true,
					now: () => now,
					sleep: async () => { sleeps++; now = 11; },
				}),
				(error: any) => {
					assert.equal(error.code, "LEASE_ACQUIRE_TIMEOUT");
					assert.match(error.message, new RegExp(`pool=${pool} cap=1 timeoutMs=10`));
					assert.equal(error.message.includes(isolatedTmp), false, "timeout diagnostics must not expose paths");
					return true;
				},
			);
			assert.equal(sleeps, 1, "the injected deadline must bound acquisition deterministically");
			const held = ledger.readLeases().leases.filter((lease: any) => lease.pool === pool);
			assert.equal(held.length, 1, "strict timeout must not write an over-cap lease");
			assert.equal(held[0].forced, false);
			holder.release();
		}
	});

	it("rejects strict acquisition when the clock crosses its deadline during the lock", async () => {
		const { ledger, bridge } = await loadBoth();
		for (const [name, implementation] of [["ledger", ledger], ["bridge", bridge]] as const) {
			seedLeases([]);
			const readings = [0, 0, 0, 11];
			let clockReads = 0;
			await assert.rejects(
				implementation.acquireLease(`strict-lock-deadline-${name}`, {
					cap: 1,
					timeoutMs: 10,
					strict: true,
					now: () => readings[clockReads++] ?? 11,
					sleep: async () => assert.fail("a deadline crossed while locking must not poll"),
				}),
				(error: any) => {
					assert.equal(error.code, "LEASE_ACQUIRE_TIMEOUT");
					assert.equal(error.message.includes(isolatedTmp), false, "timeout diagnostics must stay sanitized");
					return true;
				},
			);
			assert.ok(clockReads >= 4, "the deadline must be re-checked inside the locked callback");
			assert.equal(rawLeases().length, 0, "strict acquisition must not publish a lease after its deadline");
		}
	});

	it("retains aged live MCP holders while reclaiming aged gateway boots", async () => {
		const { ledger, bridge } = await loadBoth();
		for (const [name, implementation] of [["ledger", ledger], ["bridge", bridge]] as const) {
			const agedAt = new Date(Date.now() - 300_000).toISOString();
			seedLeases([{ id: `aged-mcp-${name}`, pool: "mcp-browser", pid: process.pid, at: agedAt, forced: false }]);
			let now = 0;
			await assert.rejects(
				implementation.acquireLease("mcp-browser", {
					cap: 1,
					timeoutMs: 10,
					strict: true,
					now: () => now,
					sleep: async () => { now = 11; },
				}),
				(error: any) => error.code === "LEASE_ACQUIRE_TIMEOUT",
			);
			assert.deepEqual(
				rawLeases().map(lease => lease.id),
				[`aged-mcp-${name}`],
				"a live MCP holder beyond the generic 180s backstop must retain the singleton slot",
			);

			seedLeases([{ id: `aged-boot-${name}`, pool: "gateway-boot", pid: process.pid, at: agedAt, forced: false }]);
			const gatewayLease = await implementation.acquireLease("gateway-boot", {
				cap: 1,
				timeoutMs: 10,
				strict: true,
				now: () => 0,
				sleep: async () => assert.fail("an aged gateway boot should be reclaimed immediately"),
			});
			assert.equal(gatewayLease.forced, false);
			assert.equal(rawLeases().some(lease => lease.id === `aged-boot-${name}`), false);
			gatewayLease.release();
		}
	});

	it("preserves generic fail-open leases while MCP waiters acquire after a valid holder releases", async () => {
		const { ledger, bridge } = await loadBoth();
		const genericPool = "generic-fail-open";
		const genericHolder = await ledger.acquireLease(genericPool, { cap: 1, timeoutMs: 100 });
		let genericNow = 0;
		const forced = await ledger.acquireLease(genericPool, {
			cap: 1,
			timeoutMs: 10,
			now: () => genericNow,
			sleep: async () => { genericNow = 11; },
		});
		assert.equal(forced.forced, true, "generic lease users must remain fail-open");
		forced.release();
		genericHolder.release();

		for (const [name, waiterImplementation, holderImplementation] of [
			["ledger", ledger, bridge],
			["bridge", bridge, ledger],
		] as const) {
			const holder = await holderImplementation.acquireLease("mcp-browser", { cap: 1, timeoutMs: 100 });
			let now = 0;
			let sleeps = 0;
			const waiter = await waiterImplementation.acquireLease("mcp-browser", {
				cap: 1,
				timeoutMs: 300_000,
				strict: true,
				now: () => now,
				sleep: async () => {
					sleeps++;
					now = 120_001;
					holder.release();
				},
			});
			assert.equal(sleeps, 1, `${name} waiter must survive a valid holder beyond the generic 120s timeout`);
			assert.equal(waiter.forced, false);
			assert.equal(ledger.readLeases().leases.filter((lease: any) => lease.pool === "mcp-browser").length, 1);
			waiter.release();
			const generationAfterRelease = ledger.readLeases().generation;
			waiter.release();
			assert.equal(ledger.readLeases().generation, generationAfterRelease, "release must be idempotent");
			assert.equal(ledger.readLeases().leases.filter((lease: any) => lease.pool === "mcp-browser").length, 0);
		}
	});
});
