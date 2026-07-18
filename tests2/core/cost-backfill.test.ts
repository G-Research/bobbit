import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "vitest";

import {
	backfillLegacyCostGoalIds,
	buildSidecarGoalIdIndex,
} from "../../src/server/agent/cost-backfill.ts";
import { RECOVERY_IO_CONCURRENCY } from "../../src/server/agent/bounded-async-work.ts";
import { UNATTRIBUTABLE_LEGACY_GOAL_ID, type CostTracker } from "../../src/server/agent/cost-tracker.ts";
import {
	CostRecoveryFsFake,
	Deferred,
	FakeCostTracker,
	drainMicrotasksUntil,
	sidecarJson,
	sidecarPath,
} from "../harness/cost-recovery-fakes.ts";

const ROOT = path.resolve("/virtual/cost-agent-sessions");

function tracker(entries: Record<string, { goalId?: string }>): FakeCostTracker {
	return new FakeCostTracker(entries);
}

function asCostTracker(fake: FakeCostTracker): CostTracker {
	return fake as unknown as CostTracker;
}

function sessionManager(records: Record<string, { goalId?: string; teamGoalId?: string; agentSessionFile?: string }>) {
	return {
		getPersistedSession(sessionId: string) {
			const record = records[sessionId];
			return record ? { ...record } : undefined;
		},
	};
}

function logger() {
	const logs: string[] = [];
	const warnings: string[] = [];
	return {
		logs,
		warnings,
		logger: {
			log: (message: string) => logs.push(message),
			warn: (message: string) => warnings.push(message),
		},
	};
}

describe("async cost sidecar recovery", () => {
	async function liveBackfill(records: Record<string, { goalId?: string; teamGoalId?: string }>, entries: Record<string, { goalId?: string }> = { s1: {} }) {
		const costs = tracker(entries);
		const fs = new CostRecoveryFsFake();
		const result = await backfillLegacyCostGoalIds({
			costTracker: asCostTracker(costs), sessionManager: sessionManager(records), agentSessionsRoot: ROOT, fs, logger: logger().logger,
		});
		return { costs, fs, result };
	}

	it("exports UNATTRIBUTABLE_LEGACY_GOAL_ID sentinel", () => {
		assert.match(UNATTRIBUTABLE_LEGACY_GOAL_ID, /^__.+__$/);
	});

	it("path 1: live session — stamps from getPersistedSession(sid).goalId", async () => {
		const { costs, result } = await liveBackfill({ s1: { goalId: "goal-live" } });
		assert.deepEqual(result, { stamped: 1, unattributable: 0 });
		assert.equal(costs.entries.get("s1")?.goalId, "goal-live");
	});

	it("path 1: live session — falls back to teamGoalId when goalId is unset", async () => {
		const { costs } = await liveBackfill({ s1: { goalId: "goal-fallback", teamGoalId: "goal-team" } });
		assert.equal(costs.entries.get("s1")?.goalId, "goal-team");
	});

	it("path 2: purged-style record (no goalId/teamGoalId) — stamps from sidecar at agentSessionFile path", async () => {
		const fs = new CostRecoveryFsFake();
		const jsonl = path.resolve("/virtual/adjacent/s2.jsonl");
		fs.file(path.resolve("/virtual/adjacent/s2.bobbit.json"), sidecarJson("s2", "goal-sidecar"));
		const costs = tracker({ s2: {} });
		const result = await backfillLegacyCostGoalIds({ costTracker: asCostTracker(costs), sessionManager: sessionManager({ s2: { agentSessionFile: jsonl } }), agentSessionsRoot: ROOT, fs, logger: logger().logger });
		assert.deepEqual(result, { stamped: 1, unattributable: 0 });
		assert.equal(costs.entries.get("s2")?.goalId, "goal-sidecar");
	});

	it("path 3: no mapping — entry stays unstamped and aggregates under UNATTRIBUTABLE_LEGACY_GOAL_ID", async () => {
		const { costs, result } = await liveBackfill({}, { ghost: {} });
		assert.deepEqual(result, { stamped: 0, unattributable: 1 });
		assert.equal(costs.entries.get("ghost")?.goalId, undefined);
		assert.equal(UNATTRIBUTABLE_LEGACY_GOAL_ID, "__unattributable__");
	});

	it("already-stamped entries are left strictly untouched (write-once preserved)", async () => {
		const { costs, fs, result } = await liveBackfill({ done: { goalId: "goal-wrong" } }, { done: { goalId: "goal-original" } });
		assert.deepEqual(result, { stamped: 0, unattributable: 0 });
		assert.equal(costs.entries.get("done")?.goalId, "goal-original");
		assert.deepEqual(fs.calls, []);
	});

	it("generation bumps when ≥1 entry was stamped; no bump when zero stamped", async () => {
		const stamped = await liveBackfill({ s1: { goalId: "goal" } });
		const noOp = await liveBackfill({}, {});
		assert.equal(stamped.costs.generation, 1);
		assert.equal(noOp.costs.generation, 0);
	});

	it("persists stamps to disk so a subsequent CostTracker reload sees them", async () => {
		const { costs } = await liveBackfill({ s1: { goalId: "goal-persisted" } });
		const recoveredSnapshot = new FakeCostTracker({ s1: { goalId: costs.entries.get("s1")?.goalId } });
		assert.equal(recoveredSnapshot.entries.get("s1")?.goalId, "goal-persisted");
	});

	it("mixed batch — stamps live + sidecar entries, leaves the ghost unattributable in one pass", async () => {
		const { costs, result } = await liveBackfill({ live: { goalId: "goal-live" } }, { live: {}, ghost: {}, done: { goalId: "goal-prior" } });
		assert.deepEqual(result, { stamped: 1, unattributable: 1 });
		assert.deepEqual(costs.goalMap(), { live: "goal-live", ghost: undefined, done: "goal-prior" });
	});

	it("is idempotent — a second invocation stamps 0 and does not bump generation", async () => {
		const costs = tracker({ s1: {} });
		const fs = new CostRecoveryFsFake();
		const options = { costTracker: asCostTracker(costs), sessionManager: sessionManager({ s1: { goalId: "goal" } }), agentSessionsRoot: ROOT, fs, logger: logger().logger };
		assert.equal((await backfillLegacyCostGoalIds(options)).stamped, 1);
		assert.equal((await backfillLegacyCostGoalIds(options)).stamped, 0);
		assert.equal(costs.generation, 1);
	});

	it("does no I/O or generation mutation when no unstamped entries exist", async () => {
		const costs = tracker({ done: { goalId: "goal-existing" } });
		const fs = new CostRecoveryFsFake();
		const out = logger();

		const result = await backfillLegacyCostGoalIds({
			costTracker: asCostTracker(costs),
			sessionManager: sessionManager({}),
			agentSessionsRoot: ROOT,
			fs,
			logger: out.logger,
		});

		assert.deepEqual(result, { stamped: 0, unattributable: 0 });
		assert.equal(costs.generation, 0);
		assert.deepEqual(fs.calls, []);
		assert.deepEqual(out.logs, []);
	});

	it("preserves live, adjacent-sidecar, and global-index priority with one lazy index", async () => {
		const fs = new CostRecoveryFsFake();
		const slug = path.join(ROOT, "global-slug");
		const adjacentDir = path.resolve("/virtual/adjacent");
		const teamJsonl = path.join(adjacentDir, "team.jsonl");
		const goalJsonl = path.join(adjacentDir, "goal.jsonl");
		const adjacentJsonl = path.join(adjacentDir, "adjacent.jsonl");
		const fallbackJsonl = path.join(adjacentDir, "missing-adjacent.jsonl");
		fs.directory(ROOT, ["global-slug"])
			.directory(slug, ["global.bobbit.json", "adjacent-copy.bobbit.json", "fallback.bobbit.json"])
			.file(sidecarPath(slug, "global"), sidecarJson("global", "goal-global"))
			.file(sidecarPath(slug, "adjacent-copy"), sidecarJson("adjacent", "goal-global-wrong"))
			.file(sidecarPath(slug, "fallback"), sidecarJson("fallback", "goal-global-fallback"))
			.file(sidecarPath(adjacentDir, "team"), sidecarJson("team", "goal-adjacent-wrong"))
			.file(sidecarPath(adjacentDir, "goal"), sidecarJson("goal", "goal-adjacent-wrong"))
			.file(sidecarPath(adjacentDir, "adjacent"), sidecarJson("adjacent", "goal-adjacent"));
		const costs = tracker({
			team: {},
			goal: {},
			adjacent: {},
			fallback: {},
			global: {},
			ghost: {},
			done: { goalId: "goal-existing" },
		});
		const out = logger();

		const result = await backfillLegacyCostGoalIds({
			costTracker: asCostTracker(costs),
			sessionManager: sessionManager({
				team: { teamGoalId: "goal-team", goalId: "goal-fallback", agentSessionFile: teamJsonl },
				goal: { goalId: "goal-live", agentSessionFile: goalJsonl },
				adjacent: { agentSessionFile: adjacentJsonl },
				fallback: { agentSessionFile: fallbackJsonl },
			}),
			agentSessionsRoot: ROOT,
			fs,
			logger: out.logger,
		});

		assert.deepEqual(result, { stamped: 5, unattributable: 1 });
		assert.deepEqual(costs.goalMap(), {
			team: "goal-team",
			goal: "goal-live",
			adjacent: "goal-adjacent",
			fallback: "goal-global-fallback",
			global: "goal-global",
			ghost: undefined,
			done: "goal-existing",
		});
		assert.deepEqual(costs.resolverOrders, [["team", "goal", "adjacent", "fallback", "global", "ghost"]]);
		assert.equal(fs.callsFor("readFile", sidecarPath(adjacentDir, "team")).length, 0);
		assert.equal(fs.callsFor("readFile", sidecarPath(adjacentDir, "goal")).length, 0);
		assert.equal(fs.callsFor("readdir", ROOT).length, 1, "all unresolved workers must share one index build");
		assert.deepEqual(out.logs, [
			"[cost-backfill] stamped goalId on 5 entries; 1 still unattributable",
		]);
		assert.equal(costs.generation, 1);
	});

	it("keeps first sidecar in listing order despite completion order and isolates malformed/unreadable siblings", async () => {
		const fs = new CostRecoveryFsFake();
		const firstSlug = path.join(ROOT, "first");
		const laterSlug = path.join(ROOT, "later");
		const unreadableSlug = path.join(ROOT, "unreadable");
		const badStat = path.join(ROOT, "bad-stat");
		const notDirectory = path.join(ROOT, "plain-file");
		const firstDuplicate = sidecarPath(firstSlug, "duplicate-first");
		const laterDuplicate = sidecarPath(laterSlug, "duplicate-later");
		const firstGate = new Deferred();
		fs.directory(ROOT, ["first", "bad-stat", "unreadable", "plain-file", "later"])
			.directory(firstSlug, [
				"duplicate-first.bobbit.json",
				"malformed.bobbit.json",
				"invalid-version.bobbit.json",
				"read-fails.bobbit.json",
				"good-sibling.bobbit.json",
				"ignored.txt",
			])
			.directory(unreadableSlug, ["never.bobbit.json"])
			.directory(laterSlug, ["duplicate-later.bobbit.json", "later-good.bobbit.json"])
			.file(notDirectory, "not a directory")
			.file(firstDuplicate, sidecarJson("duplicate", "goal-first"))
			.file(sidecarPath(firstSlug, "malformed"), "{")
			.file(sidecarPath(firstSlug, "invalid-version"), sidecarJson("invalid", "goal-invalid", { version: 2 }))
			.file(sidecarPath(firstSlug, "read-fails"), sidecarJson("failed", "goal-failed"))
			.file(sidecarPath(firstSlug, "good-sibling"), sidecarJson("good-sibling", "goal-sibling"))
			.file(laterDuplicate, sidecarJson("duplicate", "goal-later"))
			.file(sidecarPath(laterSlug, "later-good"), sidecarJson("later-good", "goal-later-good"))
			.fail("stat", badStat)
			.fail("readdir", unreadableSlug)
			.fail("readFile", sidecarPath(firstSlug, "read-fails"))
			.block("readFile", firstDuplicate, firstGate);

		let settled = false;
		const pending = buildSidecarGoalIdIndex(ROOT, logger().logger, fs).finally(() => { settled = true; });
		await drainMicrotasksUntil(() => fs.callsFor("readFile", laterDuplicate).length === 1);
		assert.equal(settled, false, "the later duplicate may finish while the first listing entry is deferred");
		firstGate.resolve();
		const index = await pending;

		assert.deepEqual([...index], [
			["duplicate", "goal-first"],
			["good-sibling", "goal-sibling"],
			["later-good", "goal-later-good"],
		]);
	});

	it("returns an empty index for missing/unreadable roots and preserves the root warning", async () => {
		const missingFs = new CostRecoveryFsFake();
		const missingOut = logger();
		assert.deepEqual(
			[...(await buildSidecarGoalIdIndex(ROOT, missingOut.logger, missingFs))],
			[],
		);
		assert.deepEqual(missingOut.warnings, []);

		const unreadableFs = new CostRecoveryFsFake().directory(ROOT, []).fail("readdir", ROOT, new Error("denied"));
		const unreadableOut = logger();
		assert.deepEqual(
			[...(await buildSidecarGoalIdIndex(ROOT, unreadableOut.logger, unreadableFs))],
			[],
		);
		assert.deepEqual(unreadableOut.warnings, [
			`[cost-backfill] Failed to read agent sessions root ${ROOT}: Error: denied`,
		]);
	});

	it("bounds a wide scan, remains scheduler-friendly while deferred, and completes every item", async () => {
		assert.ok(RECOVERY_IO_CONCURRENCY > 0);
		const fs = new CostRecoveryFsFake();
		const readGate = new Deferred();
		const slugs = Array.from({ length: 37 }, (_, index) => `slug-${index}`);
		fs.directory(ROOT, slugs).blockAll("readFile", readGate);
		for (let index = 0; index < slugs.length; index += 1) {
			const slugDir = path.join(ROOT, slugs[index]!);
			fs.directory(slugDir, [`session-${index}.bobbit.json`])
				.file(sidecarPath(slugDir, `session-${index}`), sidecarJson(`session-${index}`, `goal-${index}`));
		}

		let settled = false;
		let unrelatedMicrotaskRan = false;
		const pending = buildSidecarGoalIdIndex(ROOT, logger().logger, fs).finally(() => { settled = true; });
		queueMicrotask(() => { unrelatedMicrotaskRan = true; });
		await drainMicrotasksUntil(() => fs.callsFor("readFile").length === RECOVERY_IO_CONCURRENCY);

		assert.equal(unrelatedMicrotaskRan, true);
		assert.equal(settled, false);
		assert.equal(fs.maxActive, RECOVERY_IO_CONCURRENCY);
		assert.equal(fs.callsFor("readFile").length, RECOVERY_IO_CONCURRENCY,
			"no work beyond the fixed worker cap may start while all workers are blocked");

		readGate.resolve();
		const index = await pending;
		assert.equal(index.size, slugs.length);
		assert.equal(fs.callsFor("readFile").length, slugs.length);
		assert.ok(fs.maxActive <= RECOVERY_IO_CONCURRENCY);
		assert.deepEqual([...index.keys()], slugs.map((_, index) => `session-${index}`));
	});
});
