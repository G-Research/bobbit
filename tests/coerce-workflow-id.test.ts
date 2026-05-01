/**
 * Unit tests for `coerceWorkflowId` (dialog-helpers.ts).
 *
 * Pinned regression: brand-new projects (post `864ae63d` / #413 "No default
 * workflow scaffold") may have any subset of workflows, including none.
 * The proposal panel and New Goal dialog historically defaulted
 * `workflowId` to `"general"` or `"feature"` without checking; accepting
 * a goal proposal then yielded an opaque `400 Failed to create goal`
 * because the server falls back to looking up the missing id and throws
 * `"Workflow not found: general"`.
 *
 * `coerceWorkflowId` is the single resolution rule used at every entry
 * point. Behaviour the tests pin:
 *
 *   - empty workflow list           → returns the preferred id unchanged
 *   - preferred id is in the list   → returns it unchanged
 *   - preferred id missing          → returns first list entry's id
 *
 * See:
 *   - src/app/dialog-helpers.ts::coerceWorkflowId
 *   - src/app/dialogs.ts (fetchWorkflows callback)
 *   - src/app/render.ts::goalProposalPanel
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { coerceWorkflowId } from "../src/app/dialog-helpers.ts";

describe("coerceWorkflowId", () => {
	describe("empty workflow list", () => {
		it("returns the preferred id unchanged when no workflows exist", () => {
			// Caller's responsibility to gate Create on `available.length === 0`;
			// the helper does not synthesise a non-existent id.
			assert.equal(coerceWorkflowId("general", []), "general");
			assert.equal(coerceWorkflowId("feature", []), "feature");
			assert.equal(coerceWorkflowId("does-not-exist", []), "does-not-exist");
			assert.equal(coerceWorkflowId("", []), "");
		});
	});

	describe("preferred id is in the list", () => {
		it("returns 'general' unchanged when 'general' is available", () => {
			const wfs = [{ id: "general" }, { id: "feature" }, { id: "parent" }];
			assert.equal(coerceWorkflowId("general", wfs), "general");
		});

		it("returns 'feature' unchanged when 'feature' is available", () => {
			const wfs = [{ id: "general" }, { id: "feature" }, { id: "parent" }];
			assert.equal(coerceWorkflowId("feature", wfs), "feature");
		});

		it("returns 'parent' unchanged when 'parent' is available (child-goal flow)", () => {
			const wfs = [{ id: "general" }, { id: "feature" }, { id: "parent" }];
			assert.equal(coerceWorkflowId("parent", wfs), "parent");
		});

		it("returns the preferred id when it is the only available workflow", () => {
			assert.equal(coerceWorkflowId("custom", [{ id: "custom" }]), "custom");
		});
	});

	describe("preferred id missing — coerce to first available", () => {
		it("returns first available when 'general' is missing (post #413 brand-new project)", () => {
			// This is the headline regression case. Project assistant proposed
			// no `general` workflow; the proposal panel hardcoded "general" as
			// the default; result was `400 Workflow not found: general` on Accept.
			const wfs = [{ id: "feature" }, { id: "parent" }];
			assert.equal(coerceWorkflowId("general", wfs), "feature");
		});

		it("returns first available when 'feature' is missing (post #413 child-goal flow)", () => {
			// Sibling regression for the New Goal dialog's child-goal flow,
			// which defaults `workflowId` to "feature" per design §10.4.
			const wfs = [{ id: "general" }, { id: "parent" }];
			assert.equal(coerceWorkflowId("feature", wfs), "general");
		});

		it("returns first available regardless of alphabetical ordering — server order is preserved", () => {
			// Server returns workflows in project-config order; the helper
			// does NOT alphabetise. If the assistant lists the bespoke
			// "agent-memory" workflow first, that is what the user gets.
			const wfs = [{ id: "agent-memory-build" }, { id: "general" }];
			assert.equal(coerceWorkflowId("missing", wfs), "agent-memory-build");
		});

		it("returns the only available workflow when the list has exactly one entry", () => {
			assert.equal(coerceWorkflowId("general", [{ id: "single" }]), "single");
		});
	});

	describe("readonly array compatibility", () => {
		it("accepts a ReadonlyArray (TypeScript-only assertion)", () => {
			const wfs: ReadonlyArray<{ id: string }> = [{ id: "general" }];
			// At runtime this is structurally equivalent; the test pins the
			// TS signature so a future refactor doesn't accidentally widen.
			assert.equal(coerceWorkflowId("general", wfs), "general");
		});

		it("accepts a workflow record with extra fields (only `id` is read)", () => {
			const wfs = [
				{ id: "general", name: "General", gates: [{ id: "x" }] },
				{ id: "feature", name: "Feature", gates: [] },
			];
			assert.equal(coerceWorkflowId("missing", wfs), "general");
		});
	});
});
