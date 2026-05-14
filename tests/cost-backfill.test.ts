/**
 * Tests for the boot-time legacy cost `goalId` backfill helper.
 *
 * Covers (per design doc "legacy cost goalId backfill + unattributable surface"):
 *
 *   1. Live persisted session — `getPersistedSession(sid)?.goalId ?? .teamGoalId`
 *      maps the cost entry; stamped on disk.
 *   2. Purged session with sidecar — `getPersistedSession` returns a record that
 *      points at an `agentSessionFile` (jsonl path) but carries NO goalId/teamGoalId.
 *      Helper falls through to `readSessionSidecar(<jsonl>)` and uses `teamGoalId`.
 *   3. No mapping anywhere — entry stays unstamped and shows up in the
 *      `CostTracker.getUnattributableLegacyCost()` aggregate. Sentinel
 *      `UNATTRIBUTABLE_LEGACY_GOAL_ID` is exported and constant.
 *   4. Pre-stamped entries — left strictly untouched (write-once).
 *   5. Generation bump — `getGeneration()` increases iff at least one entry was
 *      stamped. A boot with zero unstamped entries must NOT bump the generation
 *      (cache invalidation must be precise).
 *
 * The helper module (`src/server/agent/cost-backfill.ts`) is created by the
 * implementation task. These tests document the contract that module must
 * satisfy. The `CostTracker.getUnattributableLegacyCost()` /
 * `UNATTRIBUTABLE_LEGACY_GOAL_ID` additions are also pinned here.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cost-backfill-helper-"));
process.env.BOBBIT_DIR = tmpDir;
const stateDir = path.join(tmpDir, "state");
fs.mkdirSync(stateDir, { recursive: true });
const COSTS_FILE = path.join(stateDir, "session-costs.json");
const SEEDED_JSONL_DIR = path.join(stateDir, "seeded-sessions");
fs.mkdirSync(SEEDED_JSONL_DIR, { recursive: true });

const { CostTracker } = await import("../src/server/agent/cost-tracker.ts");
const { writeSessionSidecar } = await import("../src/server/agent/session-sidecar.ts");
const {
	backfillLegacyCostGoalIds,
	UNATTRIBUTABLE_LEGACY_GOAL_ID,
} = await import("../src/server/agent/cost-backfill.ts");

/** Minimal session-manager stub conforming to the helper's interface. */
function makeSessionManager(map: Record<string, Partial<{
	goalId: string;
	teamGoalId: string;
	agentSessionFile: string;
	transcriptPath: string;
	path: string;
	jsonlPath: string;
}>>) {
	return {
		getPersistedSession(sessionId: string) {
			const v = map[sessionId];
			return v ? { ...v } : undefined;
		},
	};
}

function seedCosts(entries: Record<string, { totalCost?: number; inputTokens?: number; outputTokens?: number; goalId?: string }>): void {
	const out: Record<string, unknown> = {};
	for (const [sid, e] of Object.entries(entries)) {
		out[sid] = {
			inputTokens: e.inputTokens ?? 0,
			outputTokens: e.outputTokens ?? 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalCost: e.totalCost ?? 0,
			...(e.goalId ? { goalId: e.goalId } : {}),
		};
	}
	fs.writeFileSync(COSTS_FILE, JSON.stringify(out), "utf-8");
}

/** Write a real .jsonl + sidecar.json pair at a predictable path. */
function seedSidecar(sessionId: string, teamGoalId: string): string {
	const jsonlPath = path.join(SEEDED_JSONL_DIR, `${sessionId}.jsonl`);
	fs.writeFileSync(jsonlPath, "", "utf-8");
	writeSessionSidecar(jsonlPath, {
		version: 1,
		bobbitSessionId: sessionId,
		agentSessionId: `agent-${sessionId}`,
		role: "coder",
		teamGoalId,
		title: `session ${sessionId}`,
		createdAt: Date.now(),
	});
	return jsonlPath;
}

describe("backfillLegacyCostGoalIds + unattributable surface", () => {
	beforeEach(() => {
		try { fs.unlinkSync(COSTS_FILE); } catch { /* ok */ }
		// Wipe seeded sidecars between tests for isolation.
		for (const f of fs.readdirSync(SEEDED_JSONL_DIR)) {
			try { fs.unlinkSync(path.join(SEEDED_JSONL_DIR, f)); } catch { /* ok */ }
		}
	});

	after(() => {
		try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
	});

	it("exports UNATTRIBUTABLE_LEGACY_GOAL_ID sentinel", () => {
		assert.equal(typeof UNATTRIBUTABLE_LEGACY_GOAL_ID, "string");
		assert.ok(UNATTRIBUTABLE_LEGACY_GOAL_ID.length > 0);
		// Must look like a sentinel, not a real goalId — guard against the
		// implementation accidentally using a plausible-looking goal id.
		assert.match(UNATTRIBUTABLE_LEGACY_GOAL_ID, /^__.+__$/);
	});

	it("path 1: live session — stamps from getPersistedSession(sid).goalId", () => {
		seedCosts({ s1: { totalCost: 0.001 } });
		const tracker = new CostTracker(stateDir);
		const sessionManager = makeSessionManager({ s1: { goalId: "goal-live" } });
		const { stamped, unattributable } = backfillLegacyCostGoalIds({ costTracker: tracker, sessionManager, stateDir });
		assert.equal(stamped, 1);
		assert.equal(unattributable, 0);
		assert.equal(tracker.getSessionCost("s1")?.goalId, "goal-live");
	});

	it("path 1: live session — falls back to teamGoalId when goalId is unset", () => {
		seedCosts({ s1: { totalCost: 0.001 } });
		const tracker = new CostTracker(stateDir);
		const sessionManager = makeSessionManager({ s1: { teamGoalId: "goal-team" } });
		const { stamped } = backfillLegacyCostGoalIds({ costTracker: tracker, sessionManager, stateDir });
		assert.equal(stamped, 1);
		assert.equal(tracker.getSessionCost("s1")?.goalId, "goal-team");
	});

	it("path 2: purged-style record (no goalId/teamGoalId) — stamps from sidecar at agentSessionFile path", () => {
		seedCosts({ s2: { totalCost: 0.002 } });
		// Sidecar carries the mapping.
		const jsonlPath = seedSidecar("s2", "goal-sidecar");
		const tracker = new CostTracker(stateDir);
		// Session record exists but has no goal stamp — mirrors a session that
		// was partially purged or never carried a goalId at create time. The
		// helper must use the jsonl path on the record to locate the sidecar.
		const sessionManager = makeSessionManager({ s2: { agentSessionFile: jsonlPath } });
		const { stamped, unattributable } = backfillLegacyCostGoalIds({ costTracker: tracker, sessionManager, stateDir });
		assert.equal(stamped, 1, "sidecar fallback must stamp the entry");
		assert.equal(unattributable, 0);
		assert.equal(tracker.getSessionCost("s2")?.goalId, "goal-sidecar");
	});

	it("path 3: no mapping — entry stays unstamped and aggregates under UNATTRIBUTABLE_LEGACY_GOAL_ID", () => {
		seedCosts({ ghost: { totalCost: 0.005, inputTokens: 1000, outputTokens: 500 } });
		const tracker = new CostTracker(stateDir);
		const sessionManager = makeSessionManager({});
		const { stamped, unattributable } = backfillLegacyCostGoalIds({ costTracker: tracker, sessionManager, stateDir });
		assert.equal(stamped, 0);
		assert.equal(unattributable, 1);
		assert.equal(tracker.getSessionCost("ghost")?.goalId, undefined,
			"ghost entry must stay unstamped (no parent invention)");

		// Unattributable aggregate must surface the residual.
		const agg = tracker.getUnattributableLegacyCost();
		assert.equal(agg.totalCost, 0.005);
		assert.equal(agg.inputTokens, 1000);
		assert.equal(agg.outputTokens, 500);

		// Importantly — getGoalCost(UNATTRIBUTABLE_LEGACY_GOAL_ID) must NOT
		// silently return the residual. The sentinel is for surfacing in the
		// UI, not for routing real goal aggregation. Otherwise computeTreeCost
		// could double-count if the sentinel ever appeared as a real goal.
		const sentinelTotal = tracker.getGoalCost(UNATTRIBUTABLE_LEGACY_GOAL_ID);
		assert.equal(sentinelTotal.totalCost, 0,
			"sentinel must NOT collect residuals through getGoalCost — getUnattributableLegacyCost is the only surface");
	});

	it("already-stamped entries are left strictly untouched (write-once preserved)", () => {
		seedCosts({
			s1: { totalCost: 0.001, goalId: "goal-original" },
			s2: { totalCost: 0.002 },
		});
		const tracker = new CostTracker(stateDir);
		// Try to overwrite s1's stamp; helper must skip it.
		const sessionManager = makeSessionManager({
			s1: { goalId: "goal-WRONG" },
			s2: { goalId: "goal-new" },
		});
		const { stamped } = backfillLegacyCostGoalIds({ costTracker: tracker, sessionManager, stateDir });
		assert.equal(stamped, 1, "only the previously-unstamped entry should be touched");
		assert.equal(tracker.getSessionCost("s1")?.goalId, "goal-original");
		assert.equal(tracker.getSessionCost("s2")?.goalId, "goal-new");
	});

	it("generation bumps when ≥1 entry was stamped; no bump when zero stamped", () => {
		// Case A — at least one stamp → generation must increase.
		seedCosts({ s1: { totalCost: 0.001 } });
		const trackerA = new CostTracker(stateDir);
		const genBeforeA = trackerA.getGeneration();
		const resA = backfillLegacyCostGoalIds({
			costTracker: trackerA,
			sessionManager: makeSessionManager({ s1: { goalId: "g" } }),
			stateDir,
		});
		assert.equal(resA.stamped, 1);
		assert.ok(trackerA.getGeneration() > genBeforeA,
			"generation must bump on a successful stamp so tree-cost cache invalidates");

		// Case B — nothing to stamp → generation must NOT change.
		// Either the store is empty, or every entry is already stamped, or no
		// resolver returns a mapping. We use the empty-store case for clarity.
		try { fs.unlinkSync(COSTS_FILE); } catch { /* ok */ }
		const trackerB = new CostTracker(stateDir);
		const genBeforeB = trackerB.getGeneration();
		const resB = backfillLegacyCostGoalIds({
			costTracker: trackerB,
			sessionManager: makeSessionManager({}),
			stateDir,
		});
		assert.equal(resB.stamped, 0);
		assert.equal(trackerB.getGeneration(), genBeforeB,
			"generation must NOT bump when no entries were stamped (precise cache invalidation)");
	});

	it("persists stamps to disk so a subsequent CostTracker reload sees them", () => {
		seedCosts({ s1: { totalCost: 0.003 } });
		const t1 = new CostTracker(stateDir);
		const sessionManager = makeSessionManager({ s1: { goalId: "goal-persisted" } });
		backfillLegacyCostGoalIds({ costTracker: t1, sessionManager, stateDir });

		const onDisk = JSON.parse(fs.readFileSync(COSTS_FILE, "utf-8"));
		assert.equal(onDisk.s1.goalId, "goal-persisted");

		const t2 = new CostTracker(stateDir);
		assert.equal(t2.getSessionCost("s1")?.goalId, "goal-persisted");
	});

	it("mixed batch — stamps live + sidecar entries, leaves the ghost unattributable in one pass", () => {
		const jsonlPath = seedSidecar("s-side", "goal-side");
		seedCosts({
			"s-live":  { totalCost: 0.010 },
			"s-side":  { totalCost: 0.020 },
			"s-ghost": { totalCost: 0.030, inputTokens: 7, outputTokens: 3 },
			"s-done":  { totalCost: 0.040, goalId: "goal-prior" },
		});
		const tracker = new CostTracker(stateDir);
		const sessionManager = makeSessionManager({
			"s-live": { goalId: "goal-live" },
			"s-side": { agentSessionFile: jsonlPath },
			// s-ghost and s-done deliberately absent / pre-stamped.
		});
		const { stamped, unattributable } = backfillLegacyCostGoalIds({
			costTracker: tracker, sessionManager, stateDir,
		});
		assert.equal(stamped, 2, "live + sidecar both stamped");
		assert.equal(unattributable, 1, "ghost remains unattributable");

		assert.equal(tracker.getSessionCost("s-live")?.goalId, "goal-live");
		assert.equal(tracker.getSessionCost("s-side")?.goalId, "goal-side");
		assert.equal(tracker.getSessionCost("s-ghost")?.goalId, undefined);
		assert.equal(tracker.getSessionCost("s-done")?.goalId, "goal-prior");

		// Unattributable aggregate must reflect ONLY the ghost.
		const agg = tracker.getUnattributableLegacyCost();
		assert.equal(agg.totalCost, 0.030);
		assert.equal(agg.inputTokens, 7);
		assert.equal(agg.outputTokens, 3);
	});

	it("is idempotent — a second invocation stamps 0 and does not bump generation", () => {
		seedCosts({ s1: { totalCost: 0.001 } });
		const tracker = new CostTracker(stateDir);
		const sessionManager = makeSessionManager({ s1: { goalId: "goal-X" } });

		const first = backfillLegacyCostGoalIds({ costTracker: tracker, sessionManager, stateDir });
		assert.equal(first.stamped, 1);
		const genAfterFirst = tracker.getGeneration();

		const second = backfillLegacyCostGoalIds({ costTracker: tracker, sessionManager, stateDir });
		assert.equal(second.stamped, 0, "second invocation is a no-op");
		assert.equal(tracker.getGeneration(), genAfterFirst, "no spurious cache invalidation");
	});
});
