/**
 * Unit tests for PiProcessPool — warm-pool wave 1
 * (docs/design/warm-pi-process-pool.md).
 *
 * Uses a tiny synthetic "cli" script (same tactic as
 * rpc-bridge-lifecycle.test.ts) as `cliPath` so `RpcBridge.start()` spawns a
 * real, cheap, idle child process without depending on the real pi CLI.
 *
 * Pinned invariants (per the lane brief):
 *   - keying: different cwd/extension-set never shares a pool entry
 *   - staleness drain: a version mismatch discards the entry instead of
 *     reusing it
 *   - acquire-under-empty-pool falls back to cold spawn (claim() returns
 *     null; behavior identical to a miss)
 *   - bypass flag: BOBBIT_WARM_POOL default-off / opt-in via "1"/"true"
 *
 * Every `claim()` (hit OR miss) kicks off a background replenish — tests
 * always wait for in-flight fills to settle (`waitForIdle`) before
 * `drain()`, otherwise a fill landing AFTER drain() leaks a live idle child
 * process for the rest of the test run.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PiProcessPool, isWarmPoolEnabled } from "../src/server/agent/pi-process-pool.ts";
import type { RpcBridgeOptions } from "../src/server/agent/rpc-bridge.ts";

function writeIdleCli(): { dir: string; file: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pi-pool-test-"));
	const file = path.join(dir, "idle.mjs");
	// Never exits on its own; RpcBridge.stop() SIGTERMs it. No RPC handshake
	// needed for start() to resolve — it just waits ~100ms for the process to
	// not immediately crash (see rpc-bridge.ts start()). It DOES need to
	// answer `get_state` over stdin/stdout with a `{type:"response",id}`
	// envelope (rpc-bridge.ts's `processLine`) — `_fill()` now awaits one
	// real `getState()` round trip before considering an entry warm (so a
	// claim right after a fill doesn't still pay the graph-load cost), and
	// `RpcBridge.sendCommand`'s default 30s timeout would otherwise make
	// every fill in these tests hang for 30s before failing.
	fs.writeFileSync(file, `
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id) {
        process.stdout.write(JSON.stringify({ type: "response", id: msg.id, success: true, data: {} }) + "\\n");
      }
    } catch {}
  }
});
setInterval(() => {}, 1000);
`, "utf-8");
	return { dir, file };
}

function writeCrashingCli(): { dir: string; file: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pi-pool-crash-test-"));
	const file = path.join(dir, "crash.mjs");
	// Must answer `get_state` (like the idle CLI) so `_fill()`'s awaited
	// warm-up `getState()` call succeeds and the entry actually gets pushed
	// into the pool — THEN exit well after that, so the crash is observed
	// as "exited while idle IN the pool" (the health-check listener this
	// test targets), not as a fill-time spawn failure racing the warm-up call.
	fs.writeFileSync(file, `
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id) {
        process.stdout.write(JSON.stringify({ type: "response", id: msg.id, success: true, data: {} }) + "\\n");
      }
    } catch {}
  }
});
setTimeout(() => process.exit(1), 500);
`, "utf-8");
	return { dir, file };
}

const tmpDirs: string[] = [];
function makeOptionsFactory(cliFile: string, extra?: Partial<RpcBridgeOptions>) {
	return (poolOwnedId: string): RpcBridgeOptions => ({
		cliPath: cliFile,
		env: { BOBBIT_SESSION_ID: poolOwnedId },
		...extra,
	});
}

after(() => {
	for (const dir of tmpDirs) {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
	}
});

function trackedIdleCli(): string {
	const { dir, file } = writeIdleCli();
	tmpDirs.push(dir);
	return file;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000, intervalMs = 20): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise(resolve => setTimeout(resolve, intervalMs));
	}
	throw new Error("waitUntil timed out");
}

/** Wait for every key's background fill to finish before draining — a fill
 *  that lands AFTER drain() leaks a live idle child process into the rest of
 *  the test run (drain() only stops entries already pushed into the pool). */
async function waitForIdle(pool: PiProcessPool): Promise<void> {
	await waitUntil(() => pool.getStatus().every(s => !s.filling));
}

describe("PiProcessPool — bypass flag (BOBBIT_WARM_POOL)", () => {
	const original = process.env.BOBBIT_WARM_POOL;
	after(() => {
		if (original === undefined) delete process.env.BOBBIT_WARM_POOL;
		else process.env.BOBBIT_WARM_POOL = original;
	});

	it("defaults to disabled when unset", () => {
		delete process.env.BOBBIT_WARM_POOL;
		assert.equal(isWarmPoolEnabled(), false);
	});

	it("is disabled for any value other than \"1\"/\"true\"", () => {
		process.env.BOBBIT_WARM_POOL = "0";
		assert.equal(isWarmPoolEnabled(), false);
		process.env.BOBBIT_WARM_POOL = "yes";
		assert.equal(isWarmPoolEnabled(), false);
	});

	it("is enabled for \"1\" or \"true\"", () => {
		process.env.BOBBIT_WARM_POOL = "1";
		assert.equal(isWarmPoolEnabled(), true);
		process.env.BOBBIT_WARM_POOL = "true";
		assert.equal(isWarmPoolEnabled(), true);
	});
});

describe("PiProcessPool — acquire-under-empty-pool falls back to cold spawn", () => {
	it("claim() on a never-filled key returns null immediately (no blocking on the fill)", async () => {
		const pool = new PiProcessPool({ targetSize: 1, resolveVersion: () => "v1" });
		const cli = trackedIdleCli();
		const result = await pool.claim("proj::/cwd::abc123", makeOptionsFactory(cli));
		assert.equal(result, null, "an empty/unseen key must miss, not block until a fill completes");
		await waitForIdle(pool);
		await pool.drain();
	});

	it("a miss still kicks off a background fill so a LATER claim at the same key can hit", async () => {
		const pool = new PiProcessPool({ targetSize: 1, resolveVersion: () => "v1" });
		const cli = trackedIdleCli();
		const key = "proj::/cwd::later-hit";
		const factory = makeOptionsFactory(cli);

		const miss = await pool.claim(key, factory);
		assert.equal(miss, null);
		await waitForIdle(pool);
		assert.equal(pool.getMetrics().spawns, 1);

		const hit = await pool.claim(key, factory);
		assert.ok(hit, "second claim at the same key should hit the entry warmed by the first miss's background fill");
		assert.equal(typeof hit!.id, "string");
		assert.equal(pool.getMetrics().hits, 1);

		await waitForIdle(pool); // the hit's own background replenish
		await hit!.rpcClient.stop();
		await pool.drain();
	});
});

describe("PiProcessPool — keying: different cwd/extension-set never shares", () => {
	it("two distinct keys never satisfy each other's claim", async () => {
		const pool = new PiProcessPool({ targetSize: 1, resolveVersion: () => "v1" });
		const cli = trackedIdleCli();
		const keyA = "proj::/cwd/a::fingerprintA";
		const keyB = "proj::/cwd/b::fingerprintB";
		const factory = makeOptionsFactory(cli);

		// Warm keyA only.
		await pool.claim(keyA, factory);
		await waitForIdle(pool);
		assert.equal(pool.getStatus().find(s => s.key === keyA)?.ready, 1);

		// keyB must still miss even though keyA has a ready entry.
		const missB = await pool.claim(keyB, factory);
		assert.equal(missB, null, "a warm entry for keyA must never satisfy a claim for keyB");
		await waitForIdle(pool);

		// keyA's own entry is still claimable.
		const hitA = await pool.claim(keyA, factory);
		assert.ok(hitA, "keyA's own warm entry should still be claimable");

		await waitForIdle(pool);
		await hitA!.rpcClient.stop();
		await pool.drain();
	});
});

describe("PiProcessPool — staleness: piVersion mismatch discards, never reuses", () => {
	it("discards an entry warmed under an old version instead of returning it", async () => {
		let currentVersion = "v1";
		const pool = new PiProcessPool({ targetSize: 1, resolveVersion: () => currentVersion });
		const cli = trackedIdleCli();
		const key = "proj::/cwd::version-drift";
		const factory = makeOptionsFactory(cli);

		await pool.claim(key, factory); // miss, kicks off fill under "v1"
		await waitForIdle(pool);
		assert.equal(pool.getMetrics().spawns, 1);

		// Simulate a version bump (npm install swapped the package underneath
		// the idle entry) before the next claim.
		currentVersion = "v2";
		const result = await pool.claim(key, factory);
		assert.equal(result, null, "a version-mismatched entry must be discarded, not handed back as a hit");
		assert.equal(pool.getMetrics().evictedVersion, 1);
		assert.equal(pool.getMetrics().hits, 0);

		await waitForIdle(pool); // the miss's own re-fill, now under "v2"
		await pool.drain();
	});

	it("sweepOnce() evicts TTL-expired entries without a claim", async () => {
		const pool = new PiProcessPool({ targetSize: 1, ttlMs: 1, resolveVersion: () => "v1" });
		const cli = trackedIdleCli();
		const key = "proj::/cwd::ttl-sweep";
		const factory = makeOptionsFactory(cli);

		await pool.claim(key, factory); // miss, kicks off fill
		await waitForIdle(pool);
		assert.equal(pool.getStatus().find(s => s.key === key)?.ready, 1);

		await new Promise(resolve => setTimeout(resolve, 20)); // let the 1ms TTL elapse
		await pool.sweepOnce();

		assert.equal(pool.getStatus().find(s => s.key === key)?.ready, 0, "TTL-expired entry must be swept even with no claim");
		assert.equal(pool.getMetrics().evictedTtl, 1);

		await pool.drain();
	});

	it("evicts an entry that exits while idle in the pool (health check)", async () => {
		const pool = new PiProcessPool({ targetSize: 1, resolveVersion: () => "v1" });
		const { dir, file } = writeCrashingCli();
		tmpDirs.push(dir);
		const key = "proj::/cwd::exits-while-idle";

		await pool.claim(key, makeOptionsFactory(file));
		await waitUntil(() => pool.getMetrics().evictedExited >= 1);
		assert.equal(pool.getStatus().find(s => s.key === key)?.ready ?? 0, 0);

		await waitForIdle(pool);
		await pool.drain();
	});
});
