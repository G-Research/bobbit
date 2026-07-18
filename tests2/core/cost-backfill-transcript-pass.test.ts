import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "vitest";

import {
	backfillLegacyCostGoalIdsFromTranscripts,
	extractTranscriptGoalId,
} from "../../src/server/agent/cost-backfill.ts";
import { RECOVERY_IO_CONCURRENCY } from "../../src/server/agent/bounded-async-work.ts";
import type { CostTracker } from "../../src/server/agent/cost-tracker.ts";
import {
	CostRecoveryFsFake,
	Deferred,
	FakeCostTracker,
	drainMicrotasksUntil,
} from "../harness/cost-recovery-fakes.ts";

const ROOT = path.resolve("/virtual/transcript-sessions");
const GOAL_A = "deadbeef-1111-2222-3333-444455556666";
const GOAL_B = "cafebabe-aaaa-bbbb-cccc-ddddeeeeffff";
const GOAL_UNKNOWN = "00000000-9999-9999-9999-000000000000";

function asCostTracker(fake: FakeCostTracker): CostTracker {
	return fake as unknown as CostTracker;
}

function transcript(goalId: string, marker = "BOBBIT_GOAL_ID"): string {
	return `header\n${marker}=${goalId}\ntruncated-final-line`;
}

function logger() {
	const logs: string[] = [];
	return {
		logs,
		logger: { log: (message: string) => logs.push(message), warn: () => undefined },
	};
}

function run(
	costs: FakeCostTracker,
	fs: CostRecoveryFsFake,
	extra: Partial<{
		goals: Array<{ id: string }>;
		maxLines: number;
		maxBytes: number;
		deadlineMs: number;
		clock: { now(): number };
		logger: ReturnType<typeof logger>["logger"];
	}> = {},
) {
	return backfillLegacyCostGoalIdsFromTranscripts({
		costTracker: asCostTracker(costs),
		agentSessionsRoot: ROOT,
		goals: extra.goals ?? [{ id: GOAL_A }, { id: GOAL_B }],
		fs,
		...(extra.maxLines === undefined ? {} : { maxLines: extra.maxLines }),
		...(extra.maxBytes === undefined ? {} : { maxBytes: extra.maxBytes }),
		...(extra.deadlineMs === undefined ? {} : { deadlineMs: extra.deadlineMs }),
		...(extra.clock === undefined ? {} : { clock: extra.clock }),
		logger: extra.logger ?? logger().logger,
	});
}

describe("extractTranscriptGoalId confidence parity", () => {
	it("returns undefined when no known UUID appears", () => {
		assert.equal(extractTranscriptGoalId("", new Set([GOAL_A])), undefined);
	});
	it("returns undefined when UUID exists but is not in knownGoalIds", () => {
		assert.equal(extractTranscriptGoalId(`BOBBIT_GOAL_ID=${GOAL_UNKNOWN}`, new Set([GOAL_A])), undefined);
	});
	it("returns undefined when multiple distinct known UUIDs appear", () => {
		assert.equal(extractTranscriptGoalId(`BOBBIT_GOAL_ID=${GOAL_A} also ${GOAL_B}`, new Set([GOAL_A, GOAL_B])), undefined);
	});
	it("returns the single known UUID near BOBBIT_GOAL_ID", () => {
		assert.equal(extractTranscriptGoalId(`BOBBIT_GOAL_ID=${GOAL_A}`, new Set([GOAL_A])), GOAL_A);
	});
	it("returns the single known UUID in --goal CLI arg", () => {
		assert.equal(extractTranscriptGoalId(`agent --goal ${GOAL_A} --foo`, new Set([GOAL_A])), GOAL_A);
	});
	it("returns the single known UUID when worktree goal-<slug>-<id8> matches", () => {
		assert.equal(extractTranscriptGoalId(`Working Directory: /wt/goal-my-feature-${GOAL_A.slice(0, 8)}/src ${GOAL_A}`, new Set([GOAL_A])), GOAL_A);
	});
	it("returns the single known UUID near goal-context markers", () => {
		assert.equal(extractTranscriptGoalId(`# Goal\nGoal id: ${GOAL_A}\n## Spec`, new Set([GOAL_A])), GOAL_A);
	});
	it("returns undefined for prose-only references", () => {
		assert.equal(extractTranscriptGoalId(`some chatter says see goal ${GOAL_A} later`, new Set([GOAL_A])), undefined);
	});
});

describe("async transcript cost recovery", () => {
	function oneTranscript(sessionId: string, body: string) {
		const fs = new CostRecoveryFsFake();
		const slug = path.join(ROOT, "fixture");
		fs.directory(ROOT, ["fixture"])
			.directory(slug, [`${sessionId}.jsonl`])
			.file(path.join(slug, `${sessionId}.jsonl`), body);
		return fs;
	}

	it("high-confidence Working Directory + system prompt hit stamps matching real goal", async () => {
		const costs = new FakeCostTracker({ s1: {} });
		const result = await run(costs, oneTranscript("s1", `Working Directory: /wt/goal-x-${GOAL_A.slice(0, 8)}\nBOBBIT_GOAL_ID=${GOAL_A}`), { goals: [{ id: GOAL_A }] });
		assert.deepEqual(result, { stamped: 1, unattributable: 0, skipped: 0 });
		assert.equal(costs.entries.get("s1")?.goalId, GOAL_A);
	});

	it("two distinct real goal ids in same transcript stays unmapped", async () => {
		const costs = new FakeCostTracker({ ambiguous: {} });
		const result = await run(costs, oneTranscript("ambiguous", `# Goal\n${GOAL_A}\n${GOAL_B}`));
		assert.deepEqual(result, { stamped: 0, unattributable: 1, skipped: 0 });
	});

	it("UUID hit that is not in knownGoalIds stays unmapped", async () => {
		const costs = new FakeCostTracker({ unknown: {} });
		await run(costs, oneTranscript("unknown", `BOBBIT_GOAL_ID=${GOAL_UNKNOWN}`), { goals: [{ id: GOAL_A }] });
		assert.equal(costs.entries.get("unknown")?.goalId, undefined);
	});

	it("truncated mid-line jsonl survives without crashing", async () => {
		const costs = new FakeCostTracker({ truncated: {} });
		await run(costs, oneTranscript("truncated", `{"text":"BOBBIT_GOAL_ID=${GOAL_A}`), { goals: [{ id: GOAL_A }] });
		assert.equal(costs.entries.get("truncated")?.goalId, GOAL_A);
	});

	it("missing jsonl for sessionId leaves entry unmapped without crash", async () => {
		const costs = new FakeCostTracker({ missing: {} });
		assert.deepEqual(await run(costs, new CostRecoveryFsFake(), { goals: [{ id: GOAL_A }] }), { stamped: 0, unattributable: 1, skipped: 0 });
	});

	it("already-stamped entries are not revisited by transcript pass", async () => {
		const fs = oneTranscript("done", transcript(GOAL_A));
		const costs = new FakeCostTracker({ done: { goalId: "goal-prior" } });
		await run(costs, fs, { goals: [{ id: GOAL_A }] });
		assert.equal(costs.entries.get("done")?.goalId, "goal-prior");
		assert.deepEqual(fs.calls, []);
	});

	it("empty unmapped set is a no-op", async () => {
		assert.deepEqual(await run(new FakeCostTracker({}), new CostRecoveryFsFake()), { stamped: 0, unattributable: 0, skipped: 0 });
	});

	it("knownGoalIds empty leaves entries unattributable", async () => {
		const fs = oneTranscript("pending", transcript(GOAL_A));
		const costs = new FakeCostTracker({ pending: {} });
		assert.deepEqual(await run(costs, fs, { goals: [] }), { stamped: 0, unattributable: 1, skipped: 0 });
		assert.deepEqual(fs.calls, []);
	});

	it("does no filesystem work for empty unstamped or empty known-goal sets", async () => {
		const doneFs = new CostRecoveryFsFake();
		assert.deepEqual(
			await run(new FakeCostTracker({ done: { goalId: "goal-existing" } }), doneFs),
			{ stamped: 0, unattributable: 0, skipped: 0 },
		);
		assert.deepEqual(doneFs.calls, []);

		const noGoalsFs = new CostRecoveryFsFake();
		assert.deepEqual(
			await run(new FakeCostTracker({ pending: {} }), noGoalsFs, { goals: [] }),
			{ stamped: 0, unattributable: 1, skipped: 0 },
		);
		assert.deepEqual(noGoalsFs.calls, []);
	});

	it("accepts exact and timestamp-prefixed names, rejects unrelated/non-files, and uses the first listing match", async () => {
		const fs = new CostRecoveryFsFake();
		const firstSlug = path.join(ROOT, "first");
		const secondSlug = path.join(ROOT, "second");
		const exact = path.join(firstSlug, "s-exact.jsonl");
		const prefixed = path.join(firstSlug, "2026-01-01T00-00-00Z_s-prefixed.jsonl");
		const firstChoice = path.join(firstSlug, "000_s-choice.jsonl");
		const laterChoice = path.join(secondSlug, "s-choice.jsonl");
		const nonFile = path.join(firstSlug, "s-nonfile.jsonl");
		const choiceGate = new Deferred();
		fs.directory(ROOT, ["first", "second"])
			.directory(firstSlug, [
				"s-exact.jsonl",
				"2026-01-01T00-00-00Z_s-prefixed.jsonl",
				"almost_s-unrelated.jsonl.bak",
				"000_s-choice.jsonl",
				"s-nonfile.jsonl",
			])
			.directory(secondSlug, ["s-choice.jsonl"])
			.file(exact, transcript(GOAL_A))
			.file(prefixed, transcript(GOAL_B))
			.file(firstChoice, transcript(GOAL_A))
			.file(laterChoice, transcript(GOAL_B))
			.file(nonFile, transcript(GOAL_A))
			.statAs(nonFile, { isDirectory: true, isFile: false })
			.block("read", firstChoice, choiceGate);
		const costs = new FakeCostTracker({
			"s-exact": {},
			"s-prefixed": {},
			"s-unrelated": {},
			"s-choice": {},
			"s-nonfile": {},
		});
		const out = logger();

		const pending = run(costs, fs, { logger: out.logger });
		await drainMicrotasksUntil(() => fs.callsFor("read", firstChoice).length === 1);
		assert.equal(fs.callsFor("open", laterChoice).length, 0,
			"a later listing candidate must not race the contractual first match");
		choiceGate.resolve();
		const result = await pending;

		assert.deepEqual(result, { stamped: 3, unattributable: 2, skipped: 0 });
		assert.deepEqual(costs.goalMap(), {
			"s-exact": GOAL_A,
			"s-prefixed": GOAL_B,
			"s-unrelated": undefined,
			"s-choice": GOAL_A,
			"s-nonfile": undefined,
		});
		assert.deepEqual(costs.resolverOrders, [["s-exact", "s-prefixed", "s-unrelated", "s-choice", "s-nonfile"]]);
		assert.deepEqual(out.logs, [
			"[cost-backfill] transcript-pass stamped goalId on 3 additional entries; 2 still unattributable",
		]);
	});

	it("caps header bytes and lines while retaining a truncated final line", async () => {
		const fs = new CostRecoveryFsFake();
		const slug = path.join(ROOT, "headers");
		const truncatedPath = path.join(slug, "s-truncated.jsonl");
		const lineLimitedPath = path.join(slug, "s-lines.jsonl");
		const truncated = `prefix BOBBIT_GOAL_ID=${GOAL_A}`;
		fs.directory(ROOT, ["headers"])
			.directory(slug, ["s-truncated.jsonl", "s-lines.jsonl"])
			.file(truncatedPath, `${truncated}THIS-MUST-NOT-BE-READ`)
			.file(lineLimitedPath, `line one\nline two\nBOBBIT_GOAL_ID=${GOAL_A}\n`);
		const costs = new FakeCostTracker({ "s-truncated": {}, "s-lines": {} });

		const result = await run(costs, fs, {
			goals: [{ id: GOAL_A }],
			maxBytes: Buffer.byteLength(truncated),
			maxLines: 2,
		});

		assert.deepEqual(result, { stamped: 1, unattributable: 1, skipped: 0 });
		assert.equal(costs.entries.get("s-truncated")?.goalId, GOAL_A);
		assert.equal(costs.entries.get("s-lines")?.goalId, undefined);
		assert.deepEqual(
			fs.callsFor("read").map((call) => call.length),
			[Buffer.byteLength(truncated), Buffer.byteLength(truncated)],
		);
		assert.equal(fs.callsFor("readFile").length, 0, "transcript headers must never use whole-file reads");
	});

	it("isolates missing roots, unreadable directories/stats/opens/reads/closes, and preserves successful siblings", async () => {
		const missingCosts = new FakeCostTracker({ missing: {} });
		assert.deepEqual(
			await run(missingCosts, new CostRecoveryFsFake(), { goals: [{ id: GOAL_A }] }),
			{ stamped: 0, unattributable: 1, skipped: 0 },
		);
		const unreadableRootCosts = new FakeCostTracker({ unreadable: {} });
		const unreadableRootFs = new CostRecoveryFsFake().directory(ROOT, []).fail("readdir", ROOT);
		assert.deepEqual(
			await run(unreadableRootCosts, unreadableRootFs, { goals: [{ id: GOAL_A }] }),
			{ stamped: 0, unattributable: 1, skipped: 0 },
		);

		const fs = new CostRecoveryFsFake();
		const unreadableSlug = path.join(ROOT, "unreadable");
		const goodSlug = path.join(ROOT, "good");
		const paths = Object.fromEntries(
			["stat-fails", "open-fails", "read-fails", "close-fails", "malformed", "success"].map((sid) => [sid, path.join(goodSlug, `${sid}.jsonl`)]),
		) as Record<string, string>;
		fs.directory(ROOT, ["unreadable", "good"])
			.directory(unreadableSlug, [])
			.directory(goodSlug, Object.keys(paths).map((sid) => `${sid}.jsonl`))
			.fail("readdir", unreadableSlug);
		for (const filePath of Object.values(paths)) fs.file(filePath, transcript(GOAL_A));
		fs.file(paths["malformed"]!, "{not-json-and-no-goal-id");
		fs.fail("stat", paths["stat-fails"]!)
			.fail("open", paths["open-fails"]!)
			.fail("read", paths["read-fails"]!)
			.fail("close", paths["close-fails"]!);
		const costs = new FakeCostTracker({
			"stat-fails": {},
			"open-fails": {},
			"read-fails": {},
			"close-fails": {},
			malformed: {},
			success: {},
		});

		const result = await run(costs, fs, { goals: [{ id: GOAL_A }] });

		assert.deepEqual(result, { stamped: 2, unattributable: 4, skipped: 0 });
		assert.equal(costs.entries.get("close-fails")?.goalId, GOAL_A,
			"a close failure must not replace a successful bounded read");
		assert.equal(costs.entries.get("success")?.goalId, GOAL_A);
		assert.equal(costs.entries.get("read-fails")?.goalId, undefined);
		assert.equal(fs.callsFor("close", paths["read-fails"]!).length, 1,
			"the handle must close even when its read rejects");
	});

	it("keeps wide scans within the shared cap, allows microtask progress, and applies results in input order", async () => {
		const fs = new CostRecoveryFsFake();
		const slug = path.join(ROOT, "wide");
		const sessionIds = Array.from({ length: 29 }, (_, index) => `session-${index}`);
		const readGate = new Deferred();
		fs.directory(ROOT, ["wide"])
			.directory(slug, sessionIds.map((sid) => `${sid}.jsonl`))
			.blockAll("read", readGate);
		for (const sid of sessionIds) fs.file(path.join(slug, `${sid}.jsonl`), transcript(GOAL_A));
		const costs = new FakeCostTracker(Object.fromEntries(sessionIds.map((sid) => [sid, {}])));

		let settled = false;
		let unrelatedMicrotaskRan = false;
		const pending = run(costs, fs, { goals: [{ id: GOAL_A }] }).finally(() => { settled = true; });
		queueMicrotask(() => { unrelatedMicrotaskRan = true; });
		await drainMicrotasksUntil(() => fs.callsFor("read").length === RECOVERY_IO_CONCURRENCY);

		assert.equal(unrelatedMicrotaskRan, true);
		assert.equal(settled, false);
		assert.equal(fs.maxActive, RECOVERY_IO_CONCURRENCY);
		assert.equal(fs.callsFor("read").length, RECOVERY_IO_CONCURRENCY);

		readGate.resolve();
		const result = await pending;
		assert.deepEqual(result, { stamped: sessionIds.length, unattributable: 0, skipped: 0 });
		assert.ok(fs.maxActive <= RECOVERY_IO_CONCURRENCY);
		assert.deepEqual(costs.resolverOrders, [sessionIds]);
		assert.deepEqual(costs.goalMap(), Object.fromEntries(sessionIds.map((sid) => [sid, GOAL_A])));
	});

	it("starts work at the exact deadline, finishes claimed sessions, and reports the exact unclaimed suffix", async () => {
		const fs = new CostRecoveryFsFake();
		const slug = path.join(ROOT, "deadline");
		const sessionIds = Array.from({ length: RECOVERY_IO_CONCURRENCY + 2 }, (_, index) => `deadline-${index}`);
		const readGate = new Deferred();
		fs.directory(ROOT, ["deadline"])
			.directory(slug, sessionIds.map((sid) => `${sid}.jsonl`))
			.blockAll("read", readGate);
		for (const sid of sessionIds) fs.file(path.join(slug, `${sid}.jsonl`), transcript(GOAL_A));
		const costs = new FakeCostTracker(Object.fromEntries(sessionIds.map((sid) => [sid, {}])));
		const out = logger();
		let clockCalls = 0;
		const clock = {
			now() {
				clockCalls += 1;
				if (clockCalls === 1) return 100;
				if (clockCalls <= RECOVERY_IO_CONCURRENCY + 1) return 110;
				return 111;
			},
		};

		const pending = run(costs, fs, {
			goals: [{ id: GOAL_A }],
			deadlineMs: 10,
			clock,
			logger: out.logger,
		});
		await drainMicrotasksUntil(() => fs.callsFor("read").length === RECOVERY_IO_CONCURRENCY);
		assert.equal(fs.callsFor("read").length, RECOVERY_IO_CONCURRENCY,
			"elapsed === deadline must still claim the initial capped batch");
		readGate.resolve();
		const result = await pending;

		assert.deepEqual(result, {
			stamped: RECOVERY_IO_CONCURRENCY,
			unattributable: 2,
			skipped: 2,
		});
		assert.deepEqual(
			costs.goalMap(),
			Object.fromEntries(sessionIds.map((sid, index) => [sid, index < RECOVERY_IO_CONCURRENCY ? GOAL_A : undefined])),
		);
		assert.deepEqual(out.logs, [
			`[cost-backfill] transcript-pass stamped goalId on ${RECOVERY_IO_CONCURRENCY} additional entries; 2 still unattributable (deadline reached; 2 session(s) skipped)`,
		]);
	});
});
