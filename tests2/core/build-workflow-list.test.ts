/**
 * Reproducing test — workflowless goal-assistant prompt hard-stop.
 *
 * `buildWorkflowListText` is the single source for the `{{AVAILABLE_WORKFLOWS}}`
 * placeholder injected into the goal-assistant system prompt (extracted from
 * `SessionManager._buildWorkflowList`). For a workflowless project the empty
 * branch currently returns a hard-stop sentinel that flatly forbids
 * `propose_goal` — contradicting the UI guard (proposal-panels.ts), the
 * `propose_goal` inlineWorkflow contract, and the goal-manager backstop, all of
 * which permit a goal when a valid `inlineWorkflow` is supplied.
 *
 * These assertions are EXPECTED TO FAIL against the current wording. That is
 * intentional: this is the reproducing test. They pass once the empty branch is
 * reworded to (a) not forbid propose_goal and (b) mention the inline-workflow
 * escape hatch.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { buildWorkflowListText } from "../../src/server/agent/session-manager.ts";
import type { Workflow } from "../../src/server/agent/workflow-store.ts";

describe("buildWorkflowListText — workflowless empty branch", () => {
	it("does NOT forbid propose_goal for a workflowless project", () => {
		const text = buildWorkflowListText([]);
		assert.doesNotMatch(
			text,
			/You CANNOT propose a goal yet/i,
			"empty-workflow branch must NOT flatly forbid propose_goal — a workflowless project may still create a goal with a valid inlineWorkflow (mirroring the UI guard, propose_goal contract, and goal-manager backstop)",
		);
	});

	it("mentions the inline-workflow escape hatch", () => {
		const text = buildWorkflowListText([]);
		assert.match(
			text,
			/inline ?workflow/i,
			"empty-workflow branch must point the assistant at the inline-workflow escape hatch (supply a valid inlineWorkflow) rather than stopping",
		);
	});

	it("formats a bullet per workflow in the non-empty case", () => {
		const wf = {
			id: "review-flow",
			name: "Review Flow",
			description: "A demo workflow",
			gates: [{ name: "design-doc" }, { name: "review-findings" }],
		} as unknown as Workflow;
		const text = buildWorkflowListText([wf]);
		assert.match(text, /review-flow/, "non-empty case must list the workflow id");
		assert.match(text, /design-doc, review-findings/, "non-empty case must list the workflow gate names");
		assert.doesNotMatch(text, /no workflows configured/i, "non-empty case must not emit the empty-branch sentinel");
	});
});
