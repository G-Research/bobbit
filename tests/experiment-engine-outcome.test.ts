// Live outcome-parsing regression guard — pins engine.parseRawOutcome /
// createGoalReader against the REAL gateway REST shapes (src/server/server.ts),
// closing the gap the code-quality review found: the API E2E injected
// pre-normalized RawOutcome stubs via ctx.goalReader and never exercised the
// actual parser, so the wrong field names (totalCostUsd/tokensIn, gate id/verdict,
// GET /api/goals/:goalId) shipped undetected.
//
// Authoritative shapes:
//   GET /api/goals/:id/cost  → { inputTokens, outputTokens, cacheReadTokens,
//                                cacheWriteTokens, totalCost, cacheHitRate }
//   GET /api/goals/:id/gates → { gates: [ { gateId, status, name, ... } ] }
//   GET /api/goals/:id/tasks → { tasks: [ { state, ... } ] }
//   GET /api/goals           → { generation, goals: [ PersistedGoal incl. metadata ] }
//   (there is NO GET /api/goals/:goalId single-goal endpoint)
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	parseRawOutcome,
	isSettledFromRaw,
	completionBarFromRaw,
	createGoalReader,
} from "../market-packs/experiment-runner/lib/engine.mjs";

// ── parseRawOutcome against the EXACT REST shapes ─────────────────────────────
describe("parseRawOutcome: real gateway REST shapes", () => {
	it("maps the real cost shape (totalCost/inputTokens/outputTokens/cacheHitRate)", () => {
		const raw = parseRawOutcome({
			cost: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 50, cacheWriteTokens: 10, totalCost: 0.42, cacheHitRate: 0.25 },
		});
		assert.equal(raw.costUsd, 0.42);
		assert.equal(raw.tokensIn, 1200);
		assert.equal(raw.tokensOut, 340);
		assert.equal(raw.cacheHitRate, 0.25);
		// The cost endpoint carries no wall-clock; without meta it stays absent.
		assert.equal(raw.wallClockMs, undefined);
	});

	it("keeps tolerant fallbacks for legacy/unit-stub cost names", () => {
		const raw = parseRawOutcome({ cost: { totalCostUsd: 0.9, tokensIn: 5, tokensOut: 7, wallClockMs: 1234 } });
		assert.equal(raw.costUsd, 0.9);
		assert.equal(raw.tokensIn, 5);
		assert.equal(raw.tokensOut, 7);
		assert.equal(raw.wallClockMs, 1234);
	});

	it("reads gates keyed by gateId/status (mixed → incomplete, not settled)", () => {
		const raw = parseRawOutcome({
			gates: { gates: [{ gateId: "design-doc", status: "passed", name: "Design" }, { gateId: "review", status: "pending" }] },
		});
		assert.deepEqual(raw.gateVerdicts, { "design-doc": "passed", review: "pending" });
		assert.equal(isSettledFromRaw(raw), false);
		assert.equal(completionBarFromRaw(raw), "incomplete");
	});

	it("treats an all-passed gate set as settled + passed", () => {
		const raw = parseRawOutcome({ gates: { gates: [{ gateId: "build", status: "passed" }, { gateId: "review", status: "passed" }] } });
		assert.deepEqual(raw.gateVerdicts, { build: "passed", review: "passed" });
		assert.equal(isSettledFromRaw(raw), true);
		assert.equal(completionBarFromRaw(raw), "passed");
	});

	it("maps a human-bypassed gate to passed (accepted pass)", () => {
		const raw = parseRawOutcome({ gates: { gates: [{ gateId: "build", status: "passed" }, { gateId: "review", status: "bypassed" }] } });
		assert.deepEqual(raw.gateVerdicts, { build: "passed", review: "passed" });
		assert.equal(isSettledFromRaw(raw), true);
		assert.equal(completionBarFromRaw(raw), "passed");
	});

	it("maps a failed gate to failed completion bar", () => {
		const raw = parseRawOutcome({ gates: { gates: [{ gateId: "build", status: "passed" }, { gateId: "review", status: "failed" }] } });
		assert.equal(isSettledFromRaw(raw), true);
		assert.equal(completionBarFromRaw(raw), "failed");
	});

	it("reads task counts from the real { tasks: [{ state }] } shape", () => {
		const raw = parseRawOutcome({ tasks: { tasks: [{ state: "complete" }, { state: "todo" }, { state: "complete" }] } });
		assert.deepEqual(raw.taskCounts, { complete: 2, total: 3 });
	});

	it("derives wallClockMs + userMetrics from a PersistedGoal meta object", () => {
		const meta = { id: "g1", createdAt: 1000, updatedAt: 4000, metadata: { experiment: { userMetrics: { objective: 7 } } } };
		const raw = parseRawOutcome({ meta });
		assert.equal(raw.wallClockMs, 3000);
		assert.deepEqual(raw.userMetrics, { objective: 7 });
	});

	it("prefers archivedAt over updatedAt for wall-clock and leaves it absent when not determinable", () => {
		assert.equal(parseRawOutcome({ meta: { createdAt: 1000, archivedAt: 2500, updatedAt: 9999 } }).wallClockMs, 1500);
		assert.equal(parseRawOutcome({ meta: { id: "g", metadata: {} } }).wallClockMs, undefined);
	});

	it("never throws on empty / malformed input", () => {
		assert.deepEqual(parseRawOutcome(), {});
		assert.deepEqual(parseRawOutcome({ cost: null, gates: 5, tasks: "x", meta: undefined }), {});
	});
});

// ── createGoalReader against an injected fetch returning the REAL shapes ──────
describe("createGoalReader: assembles a RawOutcome from live REST responses", () => {
	const GOAL_ID = "child-goal-7";
	const goalsList = {
		generation: 3,
		goals: [
			{ id: "other", createdAt: 1, updatedAt: 2, metadata: {} },
			{ id: GOAL_ID, createdAt: 10_000, updatedAt: 25_000, metadata: { experiment: { userMetrics: { objective: 42 } } } },
		],
	};
	const responses: Record<string, unknown> = {
		[`/api/goals/${GOAL_ID}/cost`]: { inputTokens: 800, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.31, cacheHitRate: 0.5 },
		[`/api/goals/${GOAL_ID}/gates`]: { gates: [{ gateId: "design-doc", status: "passed" }, { gateId: "review", status: "bypassed" }] },
		[`/api/goals/${GOAL_ID}/tasks`]: { tasks: [{ state: "complete" }, { state: "complete" }, { state: "todo" }] },
		"/api/goals": goalsList,
	};

	function makeFetch(seen: string[]) {
		return async (url: string) => {
			const path = url.replace("https://gw", "");
			seen.push(path);
			const body = responses[path];
			if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
			return { ok: true, status: 200, json: async () => body };
		};
	}

	it("readOutcome() assembles a correct RawOutcome through the real parser", async () => {
		const seen: string[] = [];
		const reader = createGoalReader({ fetchImpl: makeFetch(seen) as any, creds: { gatewayUrl: "https://gw", token: "tok" } });
		const raw = await reader.readOutcome(GOAL_ID);

		assert.equal(raw.costUsd, 0.31);
		assert.equal(raw.tokensIn, 800);
		assert.equal(raw.tokensOut, 200);
		assert.equal(raw.cacheHitRate, 0.5);
		assert.deepEqual(raw.gateVerdicts, { "design-doc": "passed", review: "passed" });
		assert.deepEqual(raw.taskCounts, { complete: 2, total: 3 });
		assert.deepEqual(raw.userMetrics, { objective: 42 });
		assert.equal(raw.wallClockMs, 15_000); // updatedAt − createdAt from the goals list
		assert.equal(isSettledFromRaw(raw), true);
		assert.equal(completionBarFromRaw(raw), "passed");

		// meta MUST hit the list endpoint, NOT a (non-existent) single-goal endpoint.
		assert.ok(seen.includes("/api/goals"));
		assert.ok(!seen.some((p) => p === `/api/goals/${GOAL_ID}`));
	});

	it("meta() resolves the goal by id from the goals list", async () => {
		const reader = createGoalReader({ fetchImpl: makeFetch([]) as any, creds: { gatewayUrl: "https://gw" } });
		const meta = await reader.meta(GOAL_ID);
		assert.equal(meta.id, GOAL_ID);
		assert.deepEqual(meta.metadata.experiment.userMetrics, { objective: 42 });
		const missing = await reader.meta("nope");
		assert.equal(missing, null);
	});

	it("never throws when the gateway is unreachable (returns an empty RawOutcome)", async () => {
		const reader = createGoalReader({ fetchImpl: (async () => { throw new Error("network"); }) as any, creds: { gatewayUrl: "https://gw" } });
		const raw = await reader.readOutcome(GOAL_ID);
		assert.deepEqual(raw, {});
	});
});
