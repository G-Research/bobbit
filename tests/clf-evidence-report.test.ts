/**
 * D6 — unit tests for scripts/clf-evidence-report.mjs's pure parsing /
 * aggregation functions.
 *
 * These tests exercise ONLY the pure functions (parseJsonl, aggregate*,
 * flatten*, computeCost*, renderReport) against small synthetic JSONL/JSON
 * fixtures written under a tmp dir (file:// fixtures, per repo convention —
 * see tests/pack-marketplace.test.ts's header). No test in this file reads a
 * real `.bobbit` state dir — every fixture is constructed here.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mod = await import("../scripts/clf-evidence-report.mjs");
const {
	parseJsonl,
	aggregateToolApprove,
	flattenDecisions,
	aggregateThinkingRouter,
	aggregateLabelDistribution,
	flattenCostTurns,
	computeCostOutliers,
	computeCompactionShare,
	renderReport,
} = mod;

let TMP: string;
before(() => {
	TMP = fs.mkdtempSync(path.join(os.tmpdir(), "clf-evidence-"));
});
after(() => {
	try {
		fs.rmSync(TMP, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("parseJsonl", () => {
	it("parses well-formed lines and skips blanks", () => {
		const raw = '{"a":1}\n\n{"a":2}\n';
		assert.deepEqual(parseJsonl(raw), [{ a: 1 }, { a: 2 }]);
	});

	it("skips a corrupt partial (torn) last line without throwing", () => {
		const raw = '{"a":1}\n{"a":2';
		assert.deepEqual(parseJsonl(raw), [{ a: 1 }]);
	});

	it("returns an empty array for empty input", () => {
		assert.deepEqual(parseJsonl(""), []);
	});
});

describe("aggregateToolApprove", () => {
	it("returns all-zero shape for no entries", () => {
		const result = aggregateToolApprove([]);
		assert.equal(result.totalAsks, 0);
		assert.equal(result.verdictCoverage.select, 0);
		assert.deepEqual(result.disagreements, []);
	});

	it("builds the confusion matrix and disagreement list correctly", () => {
		const entries = [
			// agree: heuristic allow, actually granted
			{ ts: 1, sessionId: "s1", toolName: "bash", toolGroup: "shell", decision: "granted", source: "user", toolApproveDecision: { kind: "select", choice: "allow" } },
			// disagree: heuristic allow, actually denied
			{ ts: 2, sessionId: "s2", toolName: "bash", toolGroup: "shell", decision: "denied", source: "user", toolApproveDecision: { kind: "select", choice: "allow" } },
			// disagree: heuristic deny, actually granted
			{ ts: 3, sessionId: "s3", toolName: "write", toolGroup: "fs", decision: "granted", source: "user", toolApproveDecision: { kind: "select", choice: "deny" } },
			// agree: heuristic deny, actually denied
			{ ts: 4, sessionId: "s4", toolName: "write", toolGroup: "fs", decision: "denied", source: "auto", toolApproveDecision: { kind: "select", choice: "deny" } },
			// abstain — should not enter confusion matrix
			{ ts: 5, sessionId: "s5", toolName: "read", toolGroup: "fs", decision: "granted", source: "user", toolApproveDecision: { kind: "abstain" } },
			// no verdict recorded at all (pre-CLF-W2 row)
			{ ts: 6, sessionId: "s6", toolName: "read", toolGroup: "fs", decision: "denied", source: "timeout" },
		];
		const result = aggregateToolApprove(entries);
		assert.equal(result.totalAsks, 6);
		assert.equal(result.verdictCoverage.select, 4);
		assert.equal(result.verdictCoverage.abstain, 1);
		assert.equal(result.verdictCoverage.none, 1);
		assert.deepEqual(result.confusion, { allowGranted: 1, allowDenied: 1, denyGranted: 1, denyDenied: 1 });
		assert.equal(result.disagreementCount, 2);
		assert.equal(result.disagreements.length, 2);
		assert.equal(result.disagreements[0].sessionId, "s2");
		assert.equal(result.disagreements[1].sessionId, "s3");
		assert.equal(result.byDecision.granted, 3);
		assert.equal(result.byDecision.denied, 3);
	});

	it("respects the disagreementLimit option", () => {
		const entries = Array.from({ length: 10 }, (_, i) => ({
			ts: i,
			sessionId: `s${i}`,
			toolName: "bash",
			toolGroup: "shell",
			decision: "denied",
			source: "user",
			toolApproveDecision: { kind: "select", choice: "allow" },
		}));
		const result = aggregateToolApprove(entries, { disagreementLimit: 3 });
		assert.equal(result.disagreementCount, 10);
		assert.equal(result.disagreements.length, 3);
	});
});

describe("flattenDecisions", () => {
	it("flattens decisions across trace entries, filtering by point+kind and treating missing decisions[] as empty", () => {
		const traceEntries = [
			{ ts: 1, hook: "h", sessionId: "s1", providers: [], decisions: [{ ts: 1, point: "user-prompt-submit", decisionKind: "thinking", consulted: [], decision: { kind: "select", choice: "xhigh" }, ms: 1 }] },
			{ ts: 2, hook: "h", sessionId: "s2", providers: [] }, // no decisions[] at all — backward-compat
			{ ts: 3, hook: "h", sessionId: "s3", providers: [], decisions: [{ ts: 3, point: "session-spawn", decisionKind: "model-tier", consulted: [], decision: { kind: "select", choice: "mid" }, ms: 1 }] },
		];
		const thinking = flattenDecisions(traceEntries, "user-prompt-submit", "thinking");
		assert.equal(thinking.length, 1);
		assert.equal(thinking[0].sessionId, "s1");
		assert.equal(thinking[0].decision.choice, "xhigh");

		const modelTier = flattenDecisions(traceEntries, "session-spawn", "model-tier");
		assert.equal(modelTier.length, 1);
		assert.equal(modelTier[0].sessionId, "s3");

		const all = flattenDecisions(traceEntries);
		assert.equal(all.length, 2);
	});
});

describe("aggregateThinkingRouter", () => {
	it("computes select/abstain counts, applied rate, and rule breakdown", () => {
		const decisions = [
			{ ts: 1, sessionId: "s1", decision: { kind: "select", choice: "xhigh", rationale: "matched deterministic rule 'ultrathink'" }, applied: true },
			{ ts: 2, sessionId: "s2", decision: { kind: "select", choice: "xhigh", rationale: "matched deterministic rule 'think-harder'" }, applied: false },
			{ ts: 3, sessionId: "s3", decision: { kind: "abstain" } },
			{ ts: 4, sessionId: "s4", decision: { kind: "select", choice: "xhigh", rationale: "matched deterministic rule 'ultrathink'" } }, // no applied flag (observe mode)
		];
		const result = aggregateThinkingRouter(decisions);
		assert.equal(result.totalConsults, 4);
		assert.equal(result.selects, 3);
		assert.equal(result.abstains, 1);
		assert.equal(result.appliedTrue, 1);
		assert.equal(result.appliedFalse, 1);
		assert.equal(result.appliedUnknown, 1);
		assert.deepEqual(result.byRule, { ultrathink: 2, "think-harder": 1 });
		assert.equal(result.selectList.length, 3);
	});

	it("returns zeroed shape for no decisions", () => {
		const result = aggregateThinkingRouter([]);
		assert.equal(result.totalConsults, 0);
		assert.deepEqual(result.byRule, {});
	});
});

describe("aggregateLabelDistribution", () => {
	it("computes label distribution + applied rate, ignoring abstains", () => {
		const decisions = [
			{ decision: { kind: "select", choice: "frontier" }, applied: true },
			{ decision: { kind: "select", choice: "mid" }, applied: false },
			{ decision: { kind: "select", choice: "mid" } },
			{ decision: { kind: "abstain" } },
		];
		const result = aggregateLabelDistribution(decisions);
		assert.equal(result.total, 4);
		assert.equal(result.selects, 3);
		assert.equal(result.abstains, 1);
		assert.deepEqual(result.byLabel, { frontier: 1, mid: 2 });
		assert.equal(result.appliedTrue, 1);
		assert.equal(result.appliedFalse, 1);
		assert.equal(result.appliedUnknown, 1);
	});
});

describe("flattenCostTurns", () => {
	it("flattens the {sessionId: RawTurnCost[]} shape and drops malformed rows", () => {
		const data = {
			s1: [
				{ ts: 1, sessionId: "s1", seq: 1, totalCost: 0.01 },
				{ ts: 2, sessionId: "s1", seq: 2, totalCost: 0.02, trigger: "compaction:auto" },
			],
			s2: [{ ts: 3, sessionId: "s2", seq: 1 /* missing totalCost — dropped */ }],
		};
		const rows = flattenCostTurns(data);
		assert.equal(rows.length, 2);
		assert.equal(rows[0].sessionId, "s1");
		assert.equal(rows[1].trigger, "compaction:auto");
	});

	it("returns [] for malformed/absent top-level data", () => {
		assert.deepEqual(flattenCostTurns(undefined), []);
		assert.deepEqual(flattenCostTurns([1, 2, 3]), []);
		assert.deepEqual(flattenCostTurns(null), []);
	});
});

describe("computeCostOutliers", () => {
	it("flags a spike above the session's Tukey fence and skips low-row sessions", () => {
		const turns = [
			// s1: 5 turns, one clear spike
			...[0.01, 0.01, 0.01, 0.01, 1.0].map((totalCost, i) => ({ sessionId: "s1", seq: i, ts: i, totalCost })),
			// s2: only 2 turns — below minRows, must be skipped entirely
			{ sessionId: "s2", seq: 0, ts: 0, totalCost: 5.0 },
			{ sessionId: "s2", seq: 1, ts: 1, totalCost: 5.0 },
		];
		const result = computeCostOutliers(turns);
		assert.equal(result.sessionsConsidered, 1); // only s1 met minRows
		assert.equal(result.outlierCount, 1);
		assert.equal(result.outliers[0].sessionId, "s1");
		assert.equal(result.outliers[0].totalCost, 1.0);
	});

	it("returns no outliers for a flat cost distribution", () => {
		const turns = [0.01, 0.01, 0.01, 0.01, 0.01].map((totalCost, i) => ({ sessionId: "s1", seq: i, ts: i, totalCost }));
		const result = computeCostOutliers(turns);
		assert.equal(result.outlierCount, 0);
	});
});

describe("computeCompactionShare", () => {
	it("computes the compaction-tagged share and per-trigger breakdown", () => {
		const turns = [
			{ sessionId: "s1", totalCost: 1, trigger: "compaction:auto" },
			{ sessionId: "s1", totalCost: 1, trigger: "compaction:manual" },
			{ sessionId: "s1", totalCost: 1 }, // no trigger
			{ sessionId: "s1", totalCost: 1 },
		];
		const result = computeCompactionShare(turns);
		assert.equal(result.total, 4);
		assert.equal(result.compactionTagged, 2);
		assert.equal(result.share, 0.5);
		assert.deepEqual(result.byTrigger, { "compaction:auto": 1, "compaction:manual": 1 });
	});

	it("returns null share for zero rows", () => {
		const result = computeCompactionShare([]);
		assert.equal(result.total, 0);
		assert.equal(result.share, null);
	});
});

describe("renderReport", () => {
	it("degrades gracefully with 'no data yet' messaging when every source is empty", () => {
		const data = {
			toolApprove: aggregateToolApprove([]),
			thinkingRouter: aggregateThinkingRouter([]),
			modelTier: aggregateLabelDistribution([]),
			gateRisk: aggregateLabelDistribution([]),
			cost: { outliers: computeCostOutliers([]), compaction: computeCompactionShare([]) },
		};
		const report = renderReport(data, { generatedAt: 0, stateDirLabel: "/tmp/x", costStateDirLabel: "/tmp/x" });
		assert.match(report, /no data yet/i);
		assert.match(report, /\(a\) Tool-approve/);
		assert.match(report, /\(b\) Thinking-router/);
		assert.match(report, /\(c\) Model-tier \+ gate-risk/);
		assert.match(report, /\(d\) Cost/);
		// Privacy: never renders anything resembling injected prompt/file
		// content — a coarse smoke check, distinct from the report's own
		// legitimate prose explaining WHY prompt text is unavailable.
		assert.doesNotMatch(report, /lorem ipsum/i);
	});

	it("renders real data end-to-end via a real fixture dir + JSON file (file:// fixtures)", () => {
		const stateDir = path.join(TMP, "state-real");
		const auditDir = path.join(stateDir, "tool-permission-audit");
		const traceDir = path.join(stateDir, "session-context-trace");
		fs.mkdirSync(auditDir, { recursive: true });
		fs.mkdirSync(traceDir, { recursive: true });

		fs.writeFileSync(
			path.join(auditDir, "s1.jsonl"),
			[
				JSON.stringify({ ts: 1, sessionId: "s1", toolName: "bash", toolGroup: "shell", decision: "granted", source: "user", toolApproveDecision: { kind: "select", choice: "allow" } }),
				JSON.stringify({ ts: 2, sessionId: "s1", toolName: "write", toolGroup: "fs", decision: "denied", source: "user", toolApproveDecision: { kind: "select", choice: "allow" } }),
			].join("\n") + "\n",
		);

		fs.writeFileSync(
			path.join(traceDir, "s1.jsonl"),
			JSON.stringify({
				ts: 1,
				hook: "sessionSetup",
				sessionId: "s1",
				providers: [],
				decisions: [
					{ ts: 1, point: "user-prompt-submit", decisionKind: "thinking", consulted: ["builtin.thinking-router"], decision: { kind: "select", choice: "xhigh", rationale: "matched deterministic rule 'ultrathink'" }, ms: 0 },
					{ ts: 1, point: "session-spawn", decisionKind: "model-tier", consulted: ["builtin.model-tier"], decision: { kind: "select", choice: "frontier" }, ms: 0 },
					{ ts: 1, point: "gate-verify", decisionKind: "risk", consulted: ["builtin.gate-risk"], decision: { kind: "select", choice: "high" }, ms: 0 },
				],
			}) + "\n",
		);

		fs.writeFileSync(
			path.join(stateDir, "session-cost-turns.json"),
			JSON.stringify({
				s1: [
					{ ts: 1, sessionId: "s1", seq: 1, totalCost: 0.01 },
					{ ts: 2, sessionId: "s1", seq: 2, totalCost: 0.01, trigger: "compaction:auto" },
					{ ts: 3, sessionId: "s1", seq: 3, totalCost: 0.01 },
					{ ts: 4, sessionId: "s1", seq: 4, totalCost: 0.01 },
					{ ts: 5, sessionId: "s1", seq: 5, totalCost: 2.5 },
				],
			}),
		);

		// Exercise the same read+aggregate path main() uses, but call the
		// exported pure functions directly against fs reads scoped to TMP —
		// never a real `.bobbit` state dir.
		const auditEntries = fs
			.readdirSync(auditDir)
			.flatMap((f) => parseJsonl(fs.readFileSync(path.join(auditDir, f), "utf-8")));
		const traceEntries = fs
			.readdirSync(traceDir)
			.flatMap((f) => parseJsonl(fs.readFileSync(path.join(traceDir, f), "utf-8")));
		const costData = JSON.parse(fs.readFileSync(path.join(stateDir, "session-cost-turns.json"), "utf-8"));

		const data = {
			toolApprove: aggregateToolApprove(auditEntries),
			thinkingRouter: aggregateThinkingRouter(flattenDecisions(traceEntries, "user-prompt-submit", "thinking")),
			modelTier: aggregateLabelDistribution(flattenDecisions(traceEntries, "session-spawn", "model-tier")),
			gateRisk: aggregateLabelDistribution(flattenDecisions(traceEntries, "gate-verify", "risk")),
			cost: {
				outliers: computeCostOutliers(flattenCostTurns(costData)),
				compaction: computeCompactionShare(flattenCostTurns(costData)),
			},
		};

		assert.equal(data.toolApprove.totalAsks, 2);
		assert.equal(data.toolApprove.disagreementCount, 1);
		assert.equal(data.thinkingRouter.selects, 1);
		assert.equal(data.modelTier.byLabel.frontier, 1);
		assert.equal(data.gateRisk.byLabel.high, 1);
		assert.equal(data.cost.outliers.outlierCount, 1);
		assert.equal(data.cost.compaction.compactionTagged, 1);

		const report = renderReport(data, { generatedAt: 0, stateDirLabel: stateDir, costStateDirLabel: stateDir });
		assert.match(report, /Total tool-permission asks: \*\*2\*\*/);
		assert.match(report, /frontier/);
		assert.match(report, /high/);
		assert.doesNotMatch(report, /lorem ipsum/i);
	});
});
