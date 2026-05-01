/**
 * Unit tests for `src/app/workflow-gate-coercion.ts` — the defensive
 * coercion layer the goal-dashboard renderer uses to walk
 * `goal.workflow.gates[*]` without throwing on malformed snapshots.
 *
 * Regression context:
 *   The Gates tab on the goal dashboard rendered as a completely blank
 *   white panel for several live goals. Root cause: the renderer
 *   (`renderGateChecklist` / `renderGatePipeline` / `computeGateDepthLevels`
 *   in `src/app/goal-dashboard.ts`) reached directly into
 *   `gate.dependsOn.length`, `.map()`, and `for…of` against a workflow
 *   snapshot whose `dependsOn` could be `undefined` or persisted as
 *   snake_case `depends_on`. A single thrown `TypeError` inside Lit's
 *   render pass aborts the entire panel and is silently swallowed.
 *
 *   Server-side this was patched by:
 *     - HEAD f8383696 — normalize seeded workflows so `dependsOn` is
 *       camelCase from creation.
 *     - HEAD f68b1c36 — lazy migration in `GoalStore.load()` for goals
 *       persisted before the first fix.
 *
 *   Both fix the *persisted* shape but neither hardens the renderer.
 *   This module is the renderer-side guard: any future regression that
 *   re-introduces a malformed shape (a new schema field, an inline
 *   project workflow, an in-memory mutation glitch) MUST not blank the
 *   tab.
 *
 * Filename: `*.test.ts` so it runs under `tsx --test` against `src/`
 * directly. See `tests/goal-store-nesting.test.ts` for the same
 * convention.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	coerceDependsOn,
	coerceWorkflowGate,
	coerceWorkflowGatesForRender,
} from "../src/app/workflow-gate-coercion.ts";

describe("coerceDependsOn", () => {
	it("returns a fresh array for valid string[]", () => {
		const input = ["design-doc", "implementation"];
		const out = coerceDependsOn(input);
		assert.deepEqual(out, ["design-doc", "implementation"]);
		assert.notEqual(out, input);
	});

	it("returns [] for undefined", () => {
		assert.deepEqual(coerceDependsOn(undefined), []);
	});

	it("returns [] for null", () => {
		assert.deepEqual(coerceDependsOn(null), []);
	});

	it("returns [] for non-array (string, number, object)", () => {
		assert.deepEqual(coerceDependsOn("design-doc"), []);
		assert.deepEqual(coerceDependsOn(42), []);
		assert.deepEqual(coerceDependsOn({ "0": "design-doc" }), []);
	});

	it("filters out non-string entries silently", () => {
		assert.deepEqual(
			coerceDependsOn(["design-doc", 42, null, undefined, "implementation"]),
			["design-doc", "implementation"],
		);
	});

	it("filters out empty-string entries", () => {
		assert.deepEqual(coerceDependsOn(["", "design-doc", ""]), ["design-doc"]);
	});
});

describe("coerceWorkflowGate", () => {
	it("preserves a fully camelCase gate", () => {
		const out = coerceWorkflowGate({
			id: "implementation",
			name: "Implementation",
			dependsOn: ["design-doc"],
			content: false,
			injectDownstream: true,
			metadata: { phase: "exec" },
		});
		assert.deepEqual(out, {
			id: "implementation",
			name: "Implementation",
			dependsOn: ["design-doc"],
			content: false,
			injectDownstream: true,
			metadata: { phase: "exec" },
		});
	});

	it("falls back to snake_case `depends_on` when `dependsOn` is missing", () => {
		// Mirrors the pre-f68b1c36 persisted shape that crashed the renderer.
		const out = coerceWorkflowGate({
			id: "execution",
			name: "Execution",
			depends_on: ["plan-review"],
		});
		assert.equal(out?.id, "execution");
		assert.deepEqual(out?.dependsOn, ["plan-review"]);
	});

	it("prefers camelCase `dependsOn` over snake_case when both present", () => {
		// The lazy migration may set `dependsOn` while leaving `depends_on`
		// alongside it — camelCase is canonical.
		const out = coerceWorkflowGate({
			id: "g",
			name: "g",
			dependsOn: ["a"],
			depends_on: ["b"],
		});
		assert.deepEqual(out?.dependsOn, ["a"]);
	});

	it("defaults `dependsOn` to [] when both forms are missing", () => {
		const out = coerceWorkflowGate({ id: "design-doc", name: "Design Doc" });
		assert.deepEqual(out?.dependsOn, []);
	});

	it("defaults `dependsOn` to [] when `dependsOn` is explicitly undefined", () => {
		const out = coerceWorkflowGate({ id: "x", name: "x", dependsOn: undefined });
		assert.deepEqual(out?.dependsOn, []);
	});

	it("defaults `dependsOn` to [] when `dependsOn` is non-array (string)", () => {
		// Defensive against a future schema regression that ships a single string.
		const out = coerceWorkflowGate({ id: "x", name: "x", dependsOn: "design-doc" });
		assert.deepEqual(out?.dependsOn, []);
	});

	it("name falls back to id when missing", () => {
		const out = coerceWorkflowGate({ id: "design-doc" });
		assert.equal(out?.name, "design-doc");
	});

	it("returns null for entries with no id", () => {
		assert.equal(coerceWorkflowGate({ name: "no-id" }), null);
		assert.equal(coerceWorkflowGate({ id: "", name: "empty-id" }), null);
	});

	it("returns null for non-objects", () => {
		assert.equal(coerceWorkflowGate(null), null);
		assert.equal(coerceWorkflowGate(undefined), null);
		assert.equal(coerceWorkflowGate("design-doc"), null);
		assert.equal(coerceWorkflowGate(42), null);
	});

	it("backfills `injectDownstream` from snake_case `inject_downstream`", () => {
		const out = coerceWorkflowGate({
			id: "g",
			name: "g",
			inject_downstream: true,
		});
		assert.equal(out?.injectDownstream, true);
	});

	it("ignores non-boolean `content`", () => {
		const out = coerceWorkflowGate({ id: "g", name: "g", content: "yes" });
		assert.equal(out?.content, undefined);
	});

	it("filters non-string metadata values silently", () => {
		const out = coerceWorkflowGate({
			id: "g",
			name: "g",
			metadata: { a: "ok", b: 42, c: null },
		});
		assert.deepEqual(out?.metadata, { a: "ok" });
	});

	it("drops metadata entirely when no string values survive", () => {
		const out = coerceWorkflowGate({
			id: "g",
			name: "g",
			metadata: { a: 42, b: null },
		});
		assert.equal(out?.metadata, undefined);
	});
});

describe("coerceWorkflowGatesForRender", () => {
	it("returns [] for non-arrays (undefined, null, object, string)", () => {
		assert.deepEqual(coerceWorkflowGatesForRender(undefined), []);
		assert.deepEqual(coerceWorkflowGatesForRender(null), []);
		assert.deepEqual(coerceWorkflowGatesForRender({}), []);
		assert.deepEqual(coerceWorkflowGatesForRender("gates"), []);
	});

	it("filters out malformed gates while keeping valid ones", () => {
		const out = coerceWorkflowGatesForRender([
			{ id: "design-doc", name: "Design Doc", dependsOn: [] },
			null,
			"not-an-object",
			{ name: "no-id" },
			{ id: "implementation", name: "Implementation", depends_on: ["design-doc"] },
		]);
		assert.equal(out.length, 2);
		assert.deepEqual(out.map(g => g.id), ["design-doc", "implementation"]);
		assert.deepEqual(out[1].dependsOn, ["design-doc"]);
	});

	it("never throws on a `dependsOn: undefined` gate (the original blank-tab repro)", () => {
		const out = coerceWorkflowGatesForRender([
			{ id: "design-doc", name: "Design", dependsOn: undefined },
			{ id: "implementation", name: "Impl", dependsOn: undefined },
		]);
		assert.equal(out.length, 2);
		// Crucially: render-time consumers can do `.length` and `.map` safely.
		assert.equal(out[0].dependsOn.length, 0);
		assert.deepEqual(out.map(g => g.dependsOn), [[], []]);
	});

	it("preserves topological order from the input", () => {
		const out = coerceWorkflowGatesForRender([
			{ id: "design-doc", name: "Design Doc", dependsOn: [] },
			{ id: "implementation", name: "Implementation", dependsOn: ["design-doc"] },
			{ id: "documentation", name: "Documentation", dependsOn: ["implementation"] },
			{ id: "ready-to-merge", name: "Ready to Merge", dependsOn: ["documentation"] },
		]);
		assert.deepEqual(out.map(g => g.id), [
			"design-doc",
			"implementation",
			"documentation",
			"ready-to-merge",
		]);
	});

	it("walking the result with a depth-first topo sort never throws (renderer invariant)", () => {
		// This mirrors the topo-sort loop in `renderGateChecklist`. If the
		// coercion regresses, this test fails with a TypeError.
		const wfGates = coerceWorkflowGatesForRender([
			{ id: "a" }, // dependsOn missing
			{ id: "b", depends_on: ["a"] }, // snake_case only
			{ id: "c", dependsOn: undefined }, // explicit undefined
			{ id: "d", dependsOn: ["b", "c"] },
		]);
		const visited = new Set<string>();
		const sorted: string[] = [];
		const gateMap = new Map(wfGates.map(g => [g.id, g] as const));
		function visit(id: string): void {
			if (visited.has(id)) return;
			visited.add(id);
			const gate = gateMap.get(id);
			if (!gate) return;
			for (const dep of gate.dependsOn) visit(dep);
			sorted.push(gate.id);
		}
		assert.doesNotThrow(() => {
			for (const g of wfGates) visit(g.id);
		});
		assert.deepEqual(sorted, ["a", "b", "c", "d"]);
	});

	it("BFS depth computation never throws on coerced gates (mirrors `computeGateDepthLevels`)", () => {
		const wfGates = coerceWorkflowGatesForRender([
			{ id: "design-doc" },
			{ id: "implementation", depends_on: ["design-doc"] },
			{ id: "documentation", depends_on: ["implementation"] },
		]);
		const depthMap = new Map<string, number>();
		const gateMap = new Map(wfGates.map(g => [g.id, g] as const));
		function getDepth(id: string): number {
			if (depthMap.has(id)) return depthMap.get(id)!;
			const gate = gateMap.get(id);
			if (!gate || gate.dependsOn.length === 0) {
				depthMap.set(id, 0);
				return 0;
			}
			const d = Math.max(...gate.dependsOn.map(dep => getDepth(dep))) + 1;
			depthMap.set(id, d);
			return d;
		}
		assert.doesNotThrow(() => {
			for (const g of wfGates) getDepth(g.id);
		});
		assert.deepEqual(
			[...depthMap.entries()],
			[["design-doc", 0], ["implementation", 1], ["documentation", 2]],
		);
	});
});
