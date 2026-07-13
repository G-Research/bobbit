// Pins that tests/e2e/ledger-lease-bridge.mjs (the Playwright-safe lease client)
// and scripts/testing-v2/ledger.mjs (the vitest/CLI lease implementation) speak
// the SAME on-disk lease protocol, so the global concurrency caps hold across the
// browser tier AND the vitest tier AND concurrent runs. If someone changes one
// side's ledger dir / lock rule / leases shape / cap resolution without the
// other, this test fails — see the INVARIANT note in ledger-lease-bridge.mjs.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it, beforeAll, afterAll } from "vitest";

// Both modules resolve their state dir from os.tmpdir()/bobbit-test-v2-ledger and
// read os.tmpdir() live on each call, so pointing TEMP/TMP/TMPDIR at a fresh dir
// fully isolates this test from the real ledger (and concurrent runs).
const origEnv = {
	TEMP: process.env.TEMP,
	TMP: process.env.TMP,
	TMPDIR: process.env.TMPDIR,
	BOBBIT_V2_MAX_BROWSER: process.env.BOBBIT_V2_MAX_BROWSER,
	BOBBIT_V2_TOTAL_CORES: process.env.BOBBIT_V2_TOTAL_CORES,
	BOBBIT_V2_LEDGER_PARENT: process.env.BOBBIT_V2_LEDGER_PARENT,
	BOBBIT_V2_SLOTS_VITEST: process.env.BOBBIT_V2_SLOTS_VITEST,
};
let isolatedTmp: string;

async function loadBoth() {
	const ledger: any = await import("../../scripts/testing-v2/ledger.mjs");
	const bridge: any = await import("../../tests/e2e/ledger-lease-bridge.mjs");
	return { ledger, bridge };
}

describe("ledger-lease-bridge ↔ ledger.mjs interop", () => {
	beforeAll(() => {
		isolatedTmp = mkdtempSync(join(tmpdir(), "lease-interop-"));
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

	it("resolves identical caps (budget-caps.json, env override, opts.cap)", async () => {
		const { ledger, bridge } = await loadBoth();
		delete process.env.BOBBIT_V2_MAX_BROWSER;
		assert.equal(bridge.leaseCap("browser"), ledger.leaseCap("browser"), "budget-caps.json browser cap must match");
		assert.equal(bridge.leaseCap("gateway-boot"), ledger.leaseCap("gateway-boot"), "gateway-boot cap must match");
		process.env.BOBBIT_V2_MAX_BROWSER = "7";
		assert.equal(bridge.leaseCap("browser"), 7, "bridge honors env override");
		assert.equal(ledger.leaseCap("browser"), 7, "ledger honors env override");
		delete process.env.BOBBIT_V2_MAX_BROWSER;
		assert.equal(bridge.leaseCap("browser", { cap: 3 }), 3);
		assert.equal(ledger.leaseCap("browser", { cap: 3 }), 3);
	});

	it("caps standalone vitest below parent-ledger grants", async () => {
		const { ledger } = await loadBoth();
		const standalone = ledger.reserveWorkerSlots("vitest", { coalesceMs: 0, totalCores: 24 });
		try {
			assert.equal(standalone.managedByParent, false);
			assert.equal(standalone.workerSlots, 2, "direct vitest verification runs should use the stability throttle");
			const snapshot = ledger.readLedger({ totalCores: 24 });
			const record = snapshot.reservations.find((r: any) => r.id === standalone.reservationId);
			assert.equal(record?.workerSlots, 2, "the persisted reservation must match the returned standalone cap");
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
});
