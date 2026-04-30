/**
 * Unit tests for the nested-goal baseline template variables (`mergeBase`,
 * `rootGoalBranch`) populated into `builtinVars` by the verification harness.
 *
 * Covers design doc §3.2:
 *   - Top-level goal: mergeBase = origin/<primary>, rootGoalBranch = goal.branch.
 *   - Child goal: mergeBase = origin/<parent.branch>, rootGoalBranch = root.branch.
 *   - Grandchild (3-level): mergeBase tracks the immediate parent (NOT the
 *     root); rootGoalBranch tracks the root.
 *   - Legacy goal lacking parentGoalId/rootGoalId: defaults applied as if
 *     top-level.
 *
 * Also asserts that `buildReviewPrompt` consumes `mergeBase` for the diff/log
 * forms instead of hard-coding `origin/<primary>`. The trunk-context line
 * (`Primary branch: <master>`) is preserved because reviewers still need to
 * know what's on the trunk.
 *
 * Filename note: written as `*.test.ts` (not `*.spec.ts`) to source-import
 * directly from `src/`, matching the `tests/goal-manager-nesting.test.ts`
 * convention.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	buildReviewPrompt,
	computeNestedBaselineVars,
} from "../src/server/agent/verification-harness.ts";

// ────────────────────────────────────────────────────────────────────
// computeNestedBaselineVars — the pure helper that powers builtinVars.
// ────────────────────────────────────────────────────────────────────

describe("computeNestedBaselineVars", () => {
	it("top-level goal: mergeBase = origin/<primary>, rootGoalBranch = goal.branch", () => {
		const goal = { branch: "goal/foo-123" };
		const out = computeNestedBaselineVars(goal, "master", () => undefined);
		assert.equal(out.mergeBase, "origin/master");
		assert.equal(out.rootGoalBranch, "goal/foo-123");
	});

	it("top-level goal with non-master primary", () => {
		const goal = { branch: "goal/foo-123" };
		const out = computeNestedBaselineVars(goal, "main", () => undefined);
		assert.equal(out.mergeBase, "origin/main");
		assert.equal(out.rootGoalBranch, "goal/foo-123");
	});

	it("child goal: mergeBase = origin/<parent.branch>, rootGoalBranch = root.branch", () => {
		const root = { id: "root-1", branch: "goal/parent-foo" };
		const child = {
			branch: "goal/child-bar",
			parentGoalId: "root-1",
			rootGoalId: "root-1",
		};
		const lookup = (id: string) => (id === "root-1" ? root : undefined);
		const out = computeNestedBaselineVars(child, "master", lookup);
		assert.equal(out.mergeBase, "origin/goal/parent-foo");
		// Root === parent here, so rootGoalBranch matches the parent's branch.
		assert.equal(out.rootGoalBranch, "goal/parent-foo");
	});

	it("grandchild (3-level): mergeBase points at parent, rootGoalBranch points at root", () => {
		const root = { id: "root-1", branch: "goal/root-top" };
		const middle = {
			id: "mid-1",
			branch: "goal/middle-mid",
			parentGoalId: "root-1",
			rootGoalId: "root-1",
		};
		const grandchild = {
			branch: "goal/grand-leaf",
			parentGoalId: "mid-1",
			rootGoalId: "root-1",
		};
		const lookup = (id: string) => {
			if (id === "root-1") return root;
			if (id === "mid-1") return middle;
			return undefined;
		};
		const out = computeNestedBaselineVars(grandchild, "master", lookup);
		// Critical invariant: mergeBase tracks the IMMEDIATE parent, not the root.
		assert.equal(out.mergeBase, "origin/goal/middle-mid");
		assert.notEqual(out.mergeBase, "origin/goal/root-top");
		// rootGoalBranch tracks the root.
		assert.equal(out.rootGoalBranch, "goal/root-top");
	});

	it("legacy goal lacking parentGoalId and rootGoalId: defaults applied (treated as top-level)", () => {
		const legacy = { branch: "goal/legacy-xyz" };
		const out = computeNestedBaselineVars(legacy, "master", () => undefined);
		assert.equal(out.mergeBase, "origin/master");
		assert.equal(out.rootGoalBranch, "goal/legacy-xyz");
	});

	it("legacy: undefined goal record falls back to top-level defaults", () => {
		const out = computeNestedBaselineVars(undefined, "master", () => undefined, "fallback-branch");
		assert.equal(out.mergeBase, "origin/master");
		// Falls back to the supplied fallback branch (rather than HEAD) when goal
		// record is missing — matches verifyGateSignal's `goalBranch` arg semantics.
		assert.equal(out.rootGoalBranch, "fallback-branch");
	});

	it("child with missing parent record: mergeBase falls back to origin/<primary>", () => {
		const child = {
			branch: "goal/orphan-child",
			parentGoalId: "ghost-parent",
			rootGoalId: "ghost-parent",
		};
		// lookup returns undefined for everything → simulates a stale id.
		const out = computeNestedBaselineVars(child, "master", () => undefined);
		assert.equal(out.mergeBase, "origin/master");
		// rootGoalBranch falls back to the goal's own branch when the chain
		// can't be resolved.
		assert.equal(out.rootGoalBranch, "goal/orphan-child");
	});

	it("child with rootGoalId missing but parent chain resolvable: walk up to root", () => {
		const root = { id: "root-1", branch: "goal/walked-root" };
		const middle = {
			id: "mid-1",
			branch: "goal/walked-middle",
			parentGoalId: "root-1",
			// rootGoalId omitted on the middle record — simulating a legacy gap.
		};
		const grandchild = {
			branch: "goal/walked-leaf",
			parentGoalId: "mid-1",
			// rootGoalId also omitted — must fall back to the parent walk.
		};
		const lookup = (id: string) => {
			if (id === "root-1") return root;
			if (id === "mid-1") return middle;
			return undefined;
		};
		const out = computeNestedBaselineVars(grandchild, "master", lookup);
		assert.equal(out.mergeBase, "origin/goal/walked-middle");
		assert.equal(out.rootGoalBranch, "goal/walked-root");
	});
});

// ────────────────────────────────────────────────────────────────────
// buildReviewPrompt — uses mergeBase for diff/log forms but keeps the
// trunk-context line (`Primary branch: ${master}`) intact.
// ────────────────────────────────────────────────────────────────────

describe("buildReviewPrompt: mergeBase consumed by diff/log forms", () => {
	it("top-level goal: diff forms use origin/<primary> via mergeBase, trunk line intact", async () => {
		const gate = { id: "implementation", depends_on: ["design-doc"] };
		const prompt = await buildReviewPrompt(
			{ promptTemplate: "role\n{{REVIEW_CONTEXT}}", name: "reviewer" },
			{ name: "Code quality", prompt: "Review code." },
			"/tmp/cwd",
			{
				branch: "goal/x",
				master: "main",
				mergeBase: "origin/main",
				rootGoalBranch: "goal/x",
				cwd: "/tmp/cwd",
				commit: "abc",
				goal_spec: "",
			},
			undefined,
			undefined,
			"spec",
			new Map(),
			gate,
		);
		// Diff/log forms use mergeBase (== origin/main here).
		assert.match(prompt, /git diff origin\/main\.\.\.HEAD/);
		assert.match(prompt, /git log --oneline origin\/main\.\.HEAD/);
		// Trunk-context line preserved.
		assert.match(prompt, /Primary branch: main/);
	});

	it("child goal: diff forms use origin/<parent.branch>, NOT origin/<primary>", async () => {
		const gate = { id: "implementation", depends_on: ["design-doc"] };
		const prompt = await buildReviewPrompt(
			{ promptTemplate: "role\n{{REVIEW_CONTEXT}}", name: "reviewer" },
			{ name: "Code quality", prompt: "Review the child's delta." },
			"/tmp/cwd",
			{
				branch: "goal/child-bar",
				master: "main",
				mergeBase: "origin/goal/parent-foo",
				rootGoalBranch: "goal/parent-foo",
				cwd: "/tmp/cwd",
				commit: "def",
				goal_spec: "",
			},
			undefined,
			undefined,
			"spec",
			new Map(),
			gate,
		);
		// Diff baseline must point at the parent's branch.
		assert.match(prompt, /git diff origin\/goal\/parent-foo\.\.\.HEAD/);
		assert.match(prompt, /git log --oneline origin\/goal\/parent-foo\.\.HEAD/);
		// Must NOT diff against the trunk for child goals.
		assert.doesNotMatch(prompt, /git diff origin\/main\.\.\.HEAD/);
		assert.doesNotMatch(prompt, /git log --oneline origin\/main\.\.HEAD/);
		// Trunk-context line still mentions the primary branch (it represents
		// "what's on the trunk", not the diff baseline).
		assert.match(prompt, /Primary branch: main/);
		// Baseline line records the parent's branch, not master.
		assert.match(prompt, /Baseline: .*origin\/goal\/parent-foo/);
	});

	it("legacy goal without mergeBase: falls back to origin/<primary>", async () => {
		const gate = { id: "implementation", depends_on: ["design-doc"] };
		const prompt = await buildReviewPrompt(
			{ promptTemplate: "role\n{{REVIEW_CONTEXT}}", name: "reviewer" },
			{ name: "Code quality", prompt: "Review code." },
			"/tmp/cwd",
			{
				branch: "goal/legacy",
				master: "main",
				cwd: "/tmp/cwd",
				commit: "abc",
				goal_spec: "",
				// No mergeBase / rootGoalBranch — older callers / legacy goals.
			},
			undefined,
			undefined,
			"spec",
			new Map(),
			gate,
		);
		// Falls back to origin/<primary> — preserves backward-compat behaviour.
		assert.match(prompt, /git diff origin\/main\.\.\.HEAD/);
	});
});
