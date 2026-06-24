// No-fork / single-source guard + schema parity
// (docs/design/experiment-runner-reporting.md §9.4). These tests make the
// "never fork the report logic" and "canonical types" invariants enforced rather
// than prose. Pure node:test; no server needed.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { buildReportModel } from "../src/shared/experiment-report/index.ts";
import type {
	ExperimentDef,
	RunRecord,
	VariantDef,
} from "../src/shared/experiment-report/types.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const sharedDir = join(projectRoot, "src/shared/experiment-report");
const packDir = join(projectRoot, "market-packs/experiment-runner");

function walk(dir: string, exts: string[]): string[] {
	const out: string[] = [];
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) out.push(...walk(full, exts));
		else if (exts.some((e) => name.endsWith(e))) out.push(full);
	}
	return out;
}

describe("single-source: median/percentile defined exactly once (in the shared lib)", () => {
	it("the shared aggregate.ts is the only definition site", () => {
		const files = walk(sharedDir, [".ts"]);
		const medianDefs = files.filter((f) => /export function median\(/.test(readFileSync(f, "utf8")));
		const pctDefs = files.filter((f) => /export function percentile\(/.test(readFileSync(f, "utf8")));
		assert.equal(medianDefs.length, 1, `median defined in: ${medianDefs.join(", ")}`);
		assert.equal(pctDefs.length, 1, `percentile defined in: ${pctDefs.join(", ")}`);
		assert.ok(medianDefs[0].endsWith("aggregate.ts"));
	});
});

describe("no-fork: pack-side files must be thin adapters, not reimplementations", () => {
	it("no local median(/percentile(/accept-stop definitions outside the shared bundle", () => {
		if (!existsSync(packDir)) {
			// The pack lives in another stream's branch; nothing to guard yet.
			return;
		}
		// Scan pack source EXCEPT the generated shared bundle (experiment-report.mjs),
		// which is allowed to contain the bundled definitions.
		const files = walk(join(packDir, "lib"), [".mjs", ".js"]).filter(
			(f) => !f.endsWith("experiment-report.mjs"),
		);
		const offenders: string[] = [];
		for (const f of files) {
			const src = readFileSync(f, "utf8");
			if (/function\s+median\s*\(/.test(src)) offenders.push(`${f}: local median()`);
			if (/function\s+percentile\s*\(/.test(src)) offenders.push(`${f}: local percentile()`);
			if (/function\s+isPlateau\s*\(/.test(src)) offenders.push(`${f}: local isPlateau()`);
		}
		assert.deepEqual(
			offenders,
			[],
			`Report logic must not fork outside src/shared/experiment-report (see reporting design §9.4):\n${offenders.join("\n")}`,
		);
	});
});

describe("schema parity: engine-written records satisfy the shared types", () => {
	// An ExperimentDef exactly as the pack-backend define/launch routes produce it.
	const def: ExperimentDef = {
		experimentId: "exp1",
		title: "Engine-written",
		mode: "ab",
		parentGoalId: "goal-parent",
		workflowId: "wf-default",
		runnable: { kind: "agent", spec: "do the thing" },
		repeats: 2,
		maxConcurrency: 2,
		variants: [
			{ armId: "A", label: "Control", metadata: { model: "x" }, inlineRoles: { coder: {} } } satisfies VariantDef,
			{ armId: "B", label: "Treatment", metadata: { model: "y" } } satisfies VariantDef,
		],
	};

	// A RunRecord exactly as collect() writes it (raw outcome + metrics inline).
	const run: RunRecord = {
		experimentId: "exp1",
		runId: "exp1:A:0",
		armId: "A",
		repeat: 0,
		childGoalId: "goal-child-a0",
		runKey: "exp1:A:0",
		status: "collected",
		rawOutcome: {
			costUsd: 0.42,
			tokensIn: 100,
			tokensOut: 50,
			gateVerdicts: { "design-doc": "passed" },
			taskCounts: { complete: 3, total: 3 },
			userMetrics: { bleu: 0.7 },
		},
		metrics: { "cost.totalUsd": 0.42, "gates.passRate": 1 },
		completionBar: "passed",
		verified: true,
		cost: { costUsd: 0.42, tokensIn: 100, tokensOut: 50 },
		spawnedAt: 1,
		settledAt: 2,
		collectedAt: 3,
	};

	it("rejected divergent field names are absent", () => {
		const runKeys = Object.keys(run);
		for (const banned of ["expId", "variantId", "candidate", "state", "startedAt", "completedAt"]) {
			assert.ok(!runKeys.includes(banned), `RunRecord must not carry rejected field ${banned}`);
		}
		// completionBar is the canonical enum, not a free string.
		assert.ok(["passed", "failed", "incomplete"].includes(run.completionBar as string));
	});

	it("the reader consumes engine records without transformation", () => {
		const model = buildReportModel({
			def,
			runs: [run, { ...run, runId: "exp1:B:0", armId: "B", metrics: { "cost.totalUsd": 0.9, "gates.passRate": 1 } }],
			metrics: [{ metricId: "cost.totalUsd", primary: true }],
		});
		assert.equal(model.experimentId, "exp1");
		assert.equal(model.mode, "ab");
		// cost.totalUsd is a min metric → cheaper arm A wins.
		const cmp = model.comparisons.find((c) => c.metricId === "cost.totalUsd");
		assert.equal(cmp?.winnerArmId, "A");
		assert.equal(model.summary.bestArmId, "A");
	});
});
