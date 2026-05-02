/**
 * Phase 6 — system-prompt nesting stanzas (Stanza A / B / C).
 *
 * Tests the pure `buildNestingContextSection()` builder that renders zero,
 * two, or three stanzas depending on a goal's role in the nested-goals tree:
 *   - Stanza A appears for top-level (root) team-leads only
 *   - Stanza B appears for child team-leads only
 *   - Stanza C (decision rule) appears for every team goal
 *   - Non-team goals get nothing
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { buildNestingContextSection } = await import("../src/server/agent/system-prompt.ts");

const STANZA_A_HEADER = "## Goal nesting context (TOP-LEVEL ROOT)";
const STANZA_B_HEADER = "## Goal nesting context (CHILD GOAL)";
const STANZA_C_HEADER = "## When to use `subgoal` vs `team_spawn` vs `task_create`";

describe("buildNestingContextSection", () => {
	it("top-level team-lead → Stanza A + Stanza C; Stanza B absent", () => {
		const out = buildNestingContextSection({
			team: true,
			goalBranch: "goal/build-feature-abc",
		});
		assert.ok(out, "expected a non-empty section");
		assert.ok(out!.includes(STANZA_A_HEADER), "Stanza A header missing");
		assert.ok(out!.includes(STANZA_C_HEADER), "Stanza C header missing");
		assert.ok(!out!.includes(STANZA_B_HEADER), "Stanza B should be absent for top-level");
		// Stanza A specifics
		assert.ok(out!.includes("gh pr create"), "Stanza A should mention gh pr create");
		assert.ok(out!.includes("maxConcurrentChildren"), "Stanza A should mention maxConcurrentChildren");
	});

	it("child team-lead → Stanza B + Stanza C; Stanza A absent", () => {
		const out = buildNestingContextSection({
			team: true,
			goalBranch: "goal/child-slice-v0.1",
			parent: { id: "parent-id-123", title: "Parent Feature", branch: "goal/parent-feature-x" },
			root: { id: "root-id-789", title: "Root Tree", branch: "goal/root-tree-y" },
		});
		assert.ok(out, "expected a non-empty section");
		assert.ok(out!.includes(STANZA_B_HEADER), "Stanza B header missing");
		assert.ok(out!.includes(STANZA_C_HEADER), "Stanza C header missing");
		assert.ok(!out!.includes(STANZA_A_HEADER), "Stanza A should be absent for child");
		// Stanza B explicit DO-NOT-PR mandate
		assert.ok(out!.includes("DO NOT raise a PR"), "Stanza B must forbid PR raising");
	});

	it("Stanza B substitutes parent.title, parent.id, root.title, root.id", () => {
		const out = buildNestingContextSection({
			team: true,
			goalBranch: "goal/child-1",
			parent: { id: "parent-abc", title: "My Parent Goal" },
			root: { id: "root-xyz", title: "My Root Goal" },
		});
		assert.ok(out!.includes("My Parent Goal"), "parent.title substitution missing");
		assert.ok(out!.includes("parent-abc"), "parent.id substitution missing");
		assert.ok(out!.includes("My Root Goal"), "root.title substitution missing");
		assert.ok(out!.includes("root-xyz"), "root.id substitution missing");
	});

	it("Stanza B includes the goal's own branch in the 'Your branch (X) merges INTO' line", () => {
		const out = buildNestingContextSection({
			team: true,
			goalBranch: "goal/my-very-specific-branch",
			parent: { id: "p1", title: "Parent", branch: "goal/parent-branch" },
		});
		assert.ok(out!.includes("Your branch (`goal/my-very-specific-branch`) merges INTO"),
			"Stanza B missing the 'Your branch (X) merges INTO' literal");
		assert.ok(out!.includes("`goal/parent-branch`"), "Stanza B missing parent branch backtick");
	});

	it("non-team goal (assistant session) → no stanzas at all", () => {
		const out = buildNestingContextSection({ team: false });
		assert.equal(out, undefined, "non-team goals should produce undefined");
		const out2 = buildNestingContextSection({});
		assert.equal(out2, undefined, "missing team flag should produce undefined");
	});

	it("Stanza C (decision rule) lists all three primitives in a table", () => {
		const out = buildNestingContextSection({ team: true, goalBranch: "goal/x" });
		assert.ok(out!.includes("`task_create`"), "Stanza C missing task_create row");
		assert.ok(out!.includes("`team_spawn`"), "Stanza C missing team_spawn row");
		assert.ok(out!.includes("`subgoal`"), "Stanza C missing subgoal row");
		assert.ok(out!.includes("Subgoals are not free"), "Stanza C should warn that subgoals are not free");
	});
});
