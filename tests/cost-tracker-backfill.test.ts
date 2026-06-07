/**
 * Tests for `CostTracker.backfillGoalIds` — one-shot lazy migration that
 * stamps `goalId` onto legacy cost entries from a resolver (typically
 * `sessionStore.get(sid)?.goalId`).
 *
 * Verifies: resolver-driven stamping, idempotency, disk persistence,
 * already-stamped entries are skipped (write-once invariant preserved).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cost-tracker-backfill-"));
process.env.BOBBIT_DIR = tmpDir;
fs.mkdirSync(path.join(tmpDir, "state"), { recursive: true });

const STORE_FILE = path.join(tmpDir, "state", "session-costs.json");
const stateDir = path.join(tmpDir, "state");

const { CostTracker } = await import("../src/server/agent/cost-tracker.ts");

describe("CostTracker.backfillGoalIds", () => {
	beforeEach(() => {
		try { fs.unlinkSync(STORE_FILE); } catch { /* ok */ }
	});

	after(() => {
		try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
	});

	it("stamps unstamped entries via the resolver and returns the count", () => {
		// Pre-seed legacy data on disk (no goalId field anywhere).
		fs.writeFileSync(STORE_FILE, JSON.stringify({
			s1: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.001 },
			s2: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.002 },
			s3: { inputTokens: 30, outputTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.003 },
		}), "utf-8");

		const tracker = new CostTracker(stateDir);
		const map: Record<string, string> = { s1: "goal-1", s2: "goal-1", s3: "goal-2" };
		const n = tracker.backfillGoalIds((sid) => map[sid]);
		assert.equal(n, 3);
		assert.equal(tracker.getSessionCost("s1")?.goalId, "goal-1");
		assert.equal(tracker.getSessionCost("s2")?.goalId, "goal-1");
		assert.equal(tracker.getSessionCost("s3")?.goalId, "goal-2");

		// Aggregation now works without sessionIds.
		assert.equal(tracker.getGoalCost("goal-1").totalCost, 0.003);
		assert.equal(tracker.getGoalCost("goal-2").totalCost, 0.003);
	});

	it("is idempotent — a second call stamps 0", () => {
		fs.writeFileSync(STORE_FILE, JSON.stringify({
			s1: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.001 },
		}), "utf-8");
		const tracker = new CostTracker(stateDir);
		const resolver = () => "goal-1";

		assert.equal(tracker.backfillGoalIds(resolver), 1);
		assert.equal(tracker.backfillGoalIds(resolver), 0);
	});

	it("skips entries the resolver cannot identify (returns undefined)", () => {
		fs.writeFileSync(STORE_FILE, JSON.stringify({
			s1: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.001 },
			s2: { inputTokens: 20, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.002 },
		}), "utf-8");
		const tracker = new CostTracker(stateDir);
		const n = tracker.backfillGoalIds((sid) => sid === "s1" ? "goal-1" : undefined);
		assert.equal(n, 1);
		assert.equal(tracker.getSessionCost("s1")?.goalId, "goal-1");
		assert.equal(tracker.getSessionCost("s2")?.goalId, undefined);
	});

	it("skips already-stamped entries (write-once preserved)", () => {
		const tracker = new CostTracker(stateDir);
		tracker.recordUsage("s1", { cost: 0.001 }, "goal-original");
		const n = tracker.backfillGoalIds(() => "goal-different");
		assert.equal(n, 0);
		assert.equal(tracker.getSessionCost("s1")?.goalId, "goal-original");
	});

	it("persists stamped goalId to disk (survives reload)", () => {
		fs.writeFileSync(STORE_FILE, JSON.stringify({
			s1: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.001 },
		}), "utf-8");
		const t1 = new CostTracker(stateDir);
		t1.backfillGoalIds(() => "goal-1");

		const onDisk = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
		assert.equal(onDisk.s1.goalId, "goal-1");

		const t2 = new CostTracker(stateDir);
		assert.equal(t2.getSessionCost("s1")?.goalId, "goal-1");
	});

	it("returns 0 (no save) when nothing needs stamping", () => {
		// Empty store — no write should occur.
		const tracker = new CostTracker(stateDir);
		const n = tracker.backfillGoalIds(() => "goal-1");
		assert.equal(n, 0);
	});
});
