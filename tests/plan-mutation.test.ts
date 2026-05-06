/**
 * Phase 4 — `classifyMutation` plan-mutation classifier.
 *
 * Pure module; no I/O, no fixtures beyond raw input arrays. Each case
 * targets a distinct row of the SUBGOALS-SPEC §3.6 decision matrix or
 * one of the criteria-coverage edge cases.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyMutation, type ClassifierPlanStep } from "../src/server/agent/plan-mutation.ts";

function step(planId: string, opts: Partial<ClassifierPlanStep> & { phase?: number; spec?: string; title?: string } = {}): ClassifierPlanStep {
	return {
		planId,
		phase: opts.phase,
		spec: opts.spec ?? `spec for ${planId}`,
		title: opts.title ?? `Title ${planId}`,
		subgoal: opts.subgoal ?? {
			planId,
			title: opts.title ?? `Title ${planId}`,
			spec: opts.spec ?? `spec for ${planId}`,
		},
	};
}

describe("classifyMutation", () => {
	it("noop: identical steps", () => {
		const steps = [step("a", { phase: 1 }), step("b", { phase: 2 })];
		const r = classifyMutation({
			current: steps,
			proposed: steps.map(s => ({ ...s })),
			rootAcceptanceCriteria: [],
			rootSpec: "",
		});
		assert.equal(r.kind, "noop");
		assert.equal(r.diff.added.length, 0);
		assert.equal(r.diff.removed.length, 0);
		assert.equal(r.diff.modified.length, 0);
	});

	it("fix-up: leaf added at existing phase, no dep changes", () => {
		const current = [step("a", { phase: 1 }), step("b", { phase: 2 })];
		const proposed = [...current, step("c", { phase: 1 })];
		const r = classifyMutation({
			current,
			proposed,
			rootAcceptanceCriteria: [],
			rootSpec: "",
		});
		assert.equal(r.kind, "fix-up");
		assert.deepEqual(r.diff.added, ["c"]);
	});

	it("expansion: new phase added (phase > max)", () => {
		const current = [step("a", { phase: 1 }), step("b", { phase: 2 })];
		const proposed = [...current, step("c", { phase: 3 })];
		const r = classifyMutation({
			current,
			proposed,
			rootAcceptanceCriteria: [],
			rootSpec: "",
		});
		assert.equal(r.kind, "expansion");
		assert.deepEqual(r.diff.added, ["c"]);
	});

	it("expansion: existing step's phase increased", () => {
		const current = [step("a", { phase: 1 }), step("b", { phase: 2 })];
		const proposed = [step("a", { phase: 1 }), step("b", { phase: 3 })];
		const r = classifyMutation({
			current,
			proposed,
			rootAcceptanceCriteria: [],
			rootSpec: "",
		});
		assert.equal(r.kind, "expansion");
		assert.deepEqual(r.diff.phaseChanges, ["b"]);
	});

	it("restructure: step removed", () => {
		const current = [step("a", { phase: 1 }), step("b", { phase: 2 })];
		const proposed = [step("a", { phase: 1 })];
		const r = classifyMutation({
			current,
			proposed,
			rootAcceptanceCriteria: [],
			rootSpec: "",
		});
		assert.equal(r.kind, "restructure");
		assert.deepEqual(r.diff.removed, ["b"]);
	});

	it("restructure: existing step's phase DECREASED", () => {
		const current = [step("a", { phase: 1 }), step("b", { phase: 2 })];
		const proposed = [step("a", { phase: 1 }), step("b", { phase: 1 })];
		const r = classifyMutation({
			current,
			proposed,
			rootAcceptanceCriteria: [],
			rootSpec: "",
		});
		assert.equal(r.kind, "restructure");
	});

	it("criteria-drop: criterion not present in spec union", () => {
		const current = [step("a", { phase: 1 })];
		const proposed = [...current, step("b", { phase: 1, spec: "unrelated content" })];
		const r = classifyMutation({
			current,
			proposed,
			rootAcceptanceCriteria: ["foo"],
			rootSpec: "the root says nothing relevant",
		});
		assert.equal(r.kind, "criteria-drop");
		assert.deepEqual(r.uncoveredCriteria, ["foo"]);
	});

	it("criteria-drop: case-insensitive whitespace-normalised match — covered", () => {
		// criterion has uppercase letters, proposed spec has lowercase + extra whitespace
		const current = [step("a", { phase: 1, spec: "" })];
		const proposed = [step("a", { phase: 1, spec: "this contains foo bar baz" })];
		const r = classifyMutation({
			current,
			proposed,
			rootAcceptanceCriteria: ["Foo BAR"],
			rootSpec: "",
		});
		assert.notEqual(r.kind, "criteria-drop");
		assert.equal(r.uncoveredCriteria, undefined);
	});

	it("criteria-drop: whitespace-normalised match (collapsed runs) — covered", () => {
		// criterion has double-space; spec has single-space
		const current = [step("a", { phase: 1, spec: "" })];
		const proposed = [step("a", { phase: 1, spec: "leading text foo bar trailing" })];
		const r = classifyMutation({
			current,
			proposed,
			rootAcceptanceCriteria: ["foo  bar"],
			rootSpec: "",
		});
		assert.notEqual(r.kind, "criteria-drop");
	});

	it("criteria-drop: criterion ONLY carried by a removed step (not in root spec) — flagged", () => {
		// E2E suite recommendation 3: when a criterion appears only in the
		// removed step's spec (root spec doesn't carry it), the classifier
		// must flip restructure → criteria-drop. Ensures coverage union is
		// computed against the PROPOSED step set, not current.
		const current = [
			step("a", { phase: 1, spec: "covers foo" }),
			step("b", { phase: 1, spec: "covers bar — the only mention" }),
		];
		const proposed = [step("a", { phase: 1, spec: "covers foo" })]; // dropped b
		const r = classifyMutation({
			current,
			proposed,
			rootAcceptanceCriteria: ["foo", "bar"],
			rootSpec: "", // root spec carries neither criterion
		});
		assert.equal(r.kind, "criteria-drop", `expected criteria-drop, got ${r.kind}`);
		assert.deepEqual(r.uncoveredCriteria, ["bar"]);
		// Step "b" was removed → diff should report it.
		assert.deepEqual(r.diff.removed, ["b"]);
	});

	it("criteria-drop: removing a step whose criterion is ALSO in root spec → restructure (not criteria-drop)", () => {
		// Mirror of the above: when the criterion is carried verbatim in the
		// root spec, removing the step that mentions it does NOT drop coverage.
		// Verifies the union {rootSpec ∪ proposed.specs} is consulted.
		const current = [
			step("a", { phase: 1, spec: "covers foo" }),
			step("b", { phase: 1, spec: "covers bar" }),
		];
		const proposed = [step("a", { phase: 1, spec: "covers foo" })]; // dropped b
		const r = classifyMutation({
			current,
			proposed,
			rootAcceptanceCriteria: ["bar"],
			rootSpec: "the root explicitly mentions bar",
		});
		// Structurally a restructure (step removed without pause).
		assert.equal(r.kind, "restructure");
		assert.equal(r.uncoveredCriteria, undefined);
	});

	it("criteria-drop OVERRIDES expansion: structurally expansion + uncovered criterion → criteria-drop", () => {
		const current = [step("a", { phase: 1, spec: "" })];
		const proposed = [step("a", { phase: 1, spec: "" }), step("b", { phase: 2, spec: "unrelated" })];
		const r = classifyMutation({
			current,
			proposed,
			rootAcceptanceCriteria: ["important criterion"],
			rootSpec: "",
		});
		assert.equal(r.kind, "criteria-drop");
		assert.deepEqual(r.uncoveredCriteria, ["important criterion"]);
	});

	it("diff field reports added/removed/modified/phaseChanges", () => {
		const current = [
			step("a", { phase: 1, title: "A" }),
			step("b", { phase: 2, title: "B" }),
			step("c", { phase: 2, title: "C" }),
		];
		const proposed = [
			// a: phase changed (modify + phaseChange) — but increased so still expansion
			step("a", { phase: 2, title: "A" }),
			// b: title changed (modified, no phase)
			step("b", { phase: 2, title: "B-renamed" }),
			// c removed
			// d added at existing max phase 2 (fix-up territory)
			step("d", { phase: 2, title: "D" }),
		];
		const r = classifyMutation({
			current,
			proposed,
			rootAcceptanceCriteria: [],
			rootSpec: "",
		});
		// Removed → restructure (most severe).
		assert.equal(r.kind, "restructure");
		assert.deepEqual(r.diff.added.sort(), ["d"]);
		assert.deepEqual(r.diff.removed.sort(), ["c"]);
		assert.ok(r.diff.modified.includes("a"));
		assert.ok(r.diff.modified.includes("b"));
		assert.deepEqual(r.diff.phaseChanges, ["a"]);
	});

	it("noop: title/spec/workflowId/role unchanged on existing planIds", () => {
		const current = [{
			planId: "x",
			phase: 1,
			title: "X",
			spec: "spec",
			subgoal: { planId: "x", title: "X", spec: "spec", workflowId: "feature", suggestedRole: "coder" },
		}];
		const proposed = [{
			planId: "x",
			phase: 1,
			title: "X",
			spec: "spec",
			subgoal: { planId: "x", title: "X", spec: "spec", workflowId: "feature", suggestedRole: "coder" },
		}];
		const r = classifyMutation({
			current, proposed,
			rootAcceptanceCriteria: [],
			rootSpec: "",
		});
		assert.equal(r.kind, "noop");
	});

	it("fix-up: workflowId changed on existing step (no phase change, no removal)", () => {
		const current = [{
			planId: "x",
			phase: 1,
			title: "X",
			spec: "spec",
			subgoal: { planId: "x", title: "X", spec: "spec", workflowId: "feature" },
		}];
		const proposed = [{
			planId: "x",
			phase: 1,
			title: "X",
			spec: "spec",
			subgoal: { planId: "x", title: "X", spec: "spec", workflowId: "parent" },
		}];
		const r = classifyMutation({
			current, proposed,
			rootAcceptanceCriteria: [],
			rootSpec: "",
		});
		assert.equal(r.kind, "fix-up");
		assert.deepEqual(r.diff.modified, ["x"]);
	});

	it("criterion split across two adjacent step specs does NOT pass coverage (R-013)", () => {
		// Steps are normalised individually then `.join("\n")`'d, so a
		// criterion that straddles the boundary between two step specs
		// must NOT match — the literal "\n" sits between them and the
		// criterion (which has no "\n") can't span it. This pins the
		// segment-boundary contract.
		const current: ClassifierPlanStep[] = [];
		const proposed = [
			step("a", { phase: 1, spec: "this step ends with: foo bar" }),
			step("b", { phase: 1, spec: "baz then more text" }),
		];
		const r = classifyMutation({
			current,
			proposed,
			rootAcceptanceCriteria: ["foo bar baz"],
			rootSpec: "",
		});
		assert.equal(r.kind, "criteria-drop");
		assert.deepEqual(r.uncoveredCriteria, ["foo bar baz"]);
	});

	it("criterion fully inside one step spec passes coverage (positive control)", () => {
		const proposed = [step("a", { phase: 1, spec: "this step covers foo bar baz inline" })];
		const r = classifyMutation({
			current: [],
			proposed,
			rootAcceptanceCriteria: ["foo bar baz"],
			rootSpec: "",
		});
		assert.equal(r.kind, "expansion");
		assert.equal(r.uncoveredCriteria, undefined);
	});

	it("uncoveredCriteria empty when all criteria covered by rootSpec", () => {
		const r = classifyMutation({
			current: [],
			proposed: [step("a", { phase: 1 })],
			rootAcceptanceCriteria: ["a thing", "another thing"],
			rootSpec: "we do A THING and we do another thing here",
		});
		// Structurally an expansion (added a step at phase 1, max was 0).
		assert.equal(r.kind, "expansion");
		assert.equal(r.uncoveredCriteria, undefined);
	});
});
