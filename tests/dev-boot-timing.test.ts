import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	recordBootTiming,
	readBootTimings,
	BOOT_TIMING_FILE,
	type BootTimingSample,
} from "../src/server/dev-boot-timing.ts";

let stateDir: string;

function sample(extra: Partial<BootTimingSample> = {}): BootTimingSample {
	return {
		reason: "post-snapshot-paint",
		isReload: true,
		total_ms: 412.5,
		route: "#/session/abc",
		sessionId: "abc",
		transcriptMessages: 42,
		marks: [{ name: "modules-evaluated", t: 180 }, { name: "first-paint", t: 240 }],
		...extra,
	};
}

beforeEach(() => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-boot-timing-"));
});

afterEach(() => {
	try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("dev-boot-timing sink", () => {
	it("appends a sample as one JSON line and stamps receivedAt", () => {
		const written = recordBootTiming(sample(), stateDir);
		assert.equal(written, path.join(stateDir, BOOT_TIMING_FILE));

		const raw = fs.readFileSync(written!, "utf-8");
		const lines = raw.split("\n").filter((l) => l.trim());
		assert.equal(lines.length, 1);
		const parsed = JSON.parse(lines[0]);
		assert.equal(parsed.sessionId, "abc");
		assert.equal(parsed.transcriptMessages, 42);
		assert.equal(typeof parsed.receivedAt, "string");
		assert.ok(!Number.isNaN(Date.parse(parsed.receivedAt)));
	});

	it("creates the state dir if missing", () => {
		const nested = path.join(stateDir, "deep", "state");
		const written = recordBootTiming(sample(), nested);
		assert.ok(written && fs.existsSync(written));
	});

	it("readBootTimings returns samples oldest→newest and respects limit", () => {
		for (let i = 0; i < 5; i++) recordBootTiming(sample({ sessionId: `s${i}` }), stateDir);
		const all = readBootTimings(50, stateDir);
		assert.equal(all.length, 5);
		assert.deepEqual(all.map((s) => s.sessionId), ["s0", "s1", "s2", "s3", "s4"]);

		const last2 = readBootTimings(2, stateDir);
		assert.deepEqual(last2.map((s) => s.sessionId), ["s3", "s4"]);
	});

	it("returns [] when the file does not exist", () => {
		assert.deepEqual(readBootTimings(50, stateDir), []);
	});

	it("rejects non-object and array samples", () => {
		assert.equal(recordBootTiming(null, stateDir), null);
		assert.equal(recordBootTiming("nope", stateDir), null);
		assert.equal(recordBootTiming([1, 2, 3], stateDir), null);
		assert.equal(readBootTimings(50, stateDir).length, 0);
	});

	it("rejects oversized samples without writing", () => {
		const huge = sample({ note: "x".repeat(70 * 1024) } as Partial<BootTimingSample>);
		assert.equal(recordBootTiming(huge, stateDir), null);
		assert.equal(readBootTimings(50, stateDir).length, 0);
	});

	it("trims the log to the most-recent entries once it passes the byte cap", () => {
		// ~4 KB per line × 400 lines ≈ 1.6 MB > 1 MB cap → trims to last 300.
		const pad = "y".repeat(4 * 1024);
		for (let i = 0; i < 400; i++) recordBootTiming(sample({ sessionId: `n${i}`, pad } as Partial<BootTimingSample>), stateDir);
		const kept = readBootTimings(1000, stateDir);
		assert.ok(kept.length <= 300, `expected ≤300 retained lines, got ${kept.length}`);
		// The newest sample must survive the trim.
		assert.equal(kept[kept.length - 1].sessionId, "n399");
	});

	it("skips malformed lines when reading", () => {
		recordBootTiming(sample({ sessionId: "good" }), stateDir);
		fs.appendFileSync(path.join(stateDir, BOOT_TIMING_FILE), "{not json}\n", "utf-8");
		recordBootTiming(sample({ sessionId: "good2" }), stateDir);
		const parsed = readBootTimings(50, stateDir);
		assert.deepEqual(parsed.map((s) => s.sessionId), ["good", "good2"]);
	});
});
