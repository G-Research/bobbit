/**
 * Source-pin tests for known silent merge-loss regressions.
 *
 * Each test here pins a single load-bearing symbol or substring that has
 * previously vanished from the codebase via silent merge-conflict
 * resolution. The pins are deliberately blunt — they read the owning file
 * as text and assert a unique substring exists. A behavioural unit test
 * would not catch the bug class because the surrounding code is intact;
 * only the wiring is dropped.
 *
 * If one of these tests fails: DO NOT delete the test. The fix is to
 * restore the dropped block from the referenced restoration commit and
 * keep the pin in place. Each pin includes the original-add commit and
 * the most recent restoration commit so future agents can see how many
 * times the same hunk has been silently dropped.
 *
 * See docs/audit/silent-merge-loss-2026-05-15.md for the full audit.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(REPO_ROOT, p), "utf-8");

describe("Source pin — merge-loss invariants", () => {
	it("server.ts dispatches tryHandleNestedGoalRoute (restored by ea921d7b)", () => {
		const text = read("src/server/server.ts");
		assert.ok(
			text.includes("tryHandleNestedGoalRoute("),
			"src/server/server.ts must call tryHandleNestedGoalRoute() in handleApiRoute.\n" +
			"Without this dispatch every nested-goal REST route (descendants, subgoal\n" +
			"CRUD, plan endpoints) returns 404 silently. Team-leads then fail to spawn\n" +
			"children with no actionable error. Originally added in the nested-goal\n" +
			"routes change; restored by ea921d7b after a silent merge loss.\n" +
			"DO NOT delete this pin — restore the dropped dispatch instead.",
		);
	});

	it("server.ts dispatches the /api/lsp/:method route (restored by 43811c86)", () => {
		const text = read("src/server/server.ts");
		assert.ok(
			text.includes("/^\\/api\\/lsp\\/([a-z_]+)$/"),
			"src/server/server.ts must contain the /api/lsp/:method regex matcher\n" +
			"and POST dispatch for LSP tool requests. Without it every lsp_* tool\n" +
			"call (definition, references, hover, diagnostics, etc.) returns 404\n" +
			"and the tool extensions silently fall back to grep + read, masking the\n" +
			"failure. Restored by 43811c86 after a silent merge loss that broke LSP\n" +
			"adoption across every agent on the branch.\n" +
			"DO NOT delete this pin — restore the dropped block instead.",
		);
	});

	it("server.ts wires groupPolicyStore.setSubgoalsEnabledGetter (restored by 415acda6)", () => {
		const text = read("src/server/server.ts");
		assert.ok(
			text.includes("groupPolicyStore.setSubgoalsEnabledGetter("),
			"src/server/server.ts must call groupPolicyStore.setSubgoalsEnabledGetter\n" +
			"during boot to inject the preferences getter that gates the Children\n" +
			"tool group (goal_spawn_child, goal_plan_propose, goal_decide_mutation).\n" +
			"Without this call the getter stays undefined, getSubgoalsEnabled() returns\n" +
			"false unconditionally, and every team-lead loses those tools silently.\n" +
			"This regression has hit the codebase repeatedly — restored by 415acda6\n" +
			"most recently. DO NOT delete this pin.\n" +
			"Independently pinned by tests/server-subgoals-getter-wired.test.ts.",
		);
	});

	it("server.ts exposes /api/goals/:id/descendants route (restored by 2c08b07e)", () => {
		const text = read("src/server/server.ts");
		assert.ok(
			text.includes("/^\\/api\\/goals\\/([^/]+)\\/descendants$/"),
			"src/server/server.ts must contain the /api/goals/:goalId/descendants\n" +
			"GET handler. Without it the Plan tab silently drops all archived\n" +
			"children from the descendant list. Restored by 2c08b07e after a silent\n" +
			"merge loss that broke the Plan tab archived rollup for a full UI session.\n" +
			"DO NOT delete this pin — restore the dropped route instead.",
		);
	});

	it("server.ts exposes /api/goals/:id/tree-cost route (restored by 2c08b07e)", () => {
		const text = read("src/server/server.ts");
		assert.ok(
			text.includes("/^\\/api\\/goals\\/([^/]+)\\/tree-cost$/"),
			"src/server/server.ts must contain the /api/goals/:goalId/tree-cost GET\n" +
			"handler. Without it the cost rollup shows zero archived spend and the\n" +
			"Plan tab dashboard silently underreports total cost. Restored by 2c08b07e\n" +
			"alongside the descendants route. DO NOT delete this pin.",
		);
	});

	it("render.ts contains goal-form-subgoals-toggle testid (restored by a35d7f34)", () => {
		const text = read("src/app/render.ts");
		assert.ok(
			text.includes("goal-form-subgoals-toggle"),
			"src/app/render.ts::renderGoalForm must render the 'Allow subgoals'\n" +
			"checkbox with data-testid=\"goal-form-subgoals-toggle\" in the goal\n" +
			"proposal modal. Originally shipped in 492d88e1, silently dropped during\n" +
			"a later merge, restored by a35d7f34. Without it operators cannot\n" +
			"disable subgoal spawning per-goal at creation time.\n" +
			"DO NOT delete this pin — keep it alongside\n" +
			"tests/proposal-form-controls-source-pinned.test.ts.",
		);
	});

	it("render.ts contains goal-form-max-depth testid (restored by a35d7f34)", () => {
		const text = read("src/app/render.ts");
		assert.ok(
			text.includes("goal-form-max-depth"),
			"src/app/render.ts::renderGoalForm must render the 'Max depth' number\n" +
			"input with data-testid=\"goal-form-max-depth\". Originally shipped in\n" +
			"492d88e1, silently dropped during a later merge, restored by a35d7f34.\n" +
			"Without it operators cannot tighten the per-goal nesting cap at\n" +
			"creation time. DO NOT delete this pin.",
		);
	});

	// ----------------------------------------------------------------------
	// Proposal-modal Workflow/Roles tabs pins (this proposal-modal-tabs fix).
	//
	// Regression commit: 46e21256 "Merge child: plan-propose UX + dependsOn
	// fallback (d4be2150)" silently dropped the entire inline-workflow +
	// inline-roles editor surface from src/app/render.ts. The pre-merge
	// parent (46e21256^1) had 13 references to `inlineWorkflowYaml` and 11
	// to `inlineRolesYaml`; the merge result has zero of either. The merge
	// took the trunk side of render.ts wholesale (-617 net lines) without
	// preserving the proposal-modal customisation surface.
	//
	// The replacement landed by this proposal-modal-tabs fix is NOT the old
	// YAML <details>+textarea UX — it is a tabbed surface that reuses the
	// main Workflows/Roles page renderers (see
	// docs/audit/silent-merge-loss-2026-05-15.md and the gated design doc).
	// The pins below assert the *new* user-facing surface exists; deleting
	// them or weakening them to allow the old YAML textareas is a hard fail.
	// ----------------------------------------------------------------------

	it("render.ts wires draft inlineWorkflow state into the proposal modal (this proposal-modal-tabs fix)", () => {
		const text = read("src/app/render.ts");
		assert.ok(
			text.includes("inlineWorkflow"),
			"src/app/render.ts must reference `inlineWorkflow` somewhere in the\n" +
			"goal proposal modal — it is the draft-scoped customised-workflow\n" +
			"snapshot the Workflow tab edits and the submit path forwards as the\n" +
			"`workflow` field of createGoal. Regression commit 46e21256 silently\n" +
			"dropped the entire inline-workflow editor surface from render.ts (13\n" +
			"`inlineWorkflowYaml` refs at 46e21256^1 → 0 at 46e21256). Restored\n" +
			"by this proposal-modal-tabs fix as a tabbed surface reusing the\n" +
			"Workflows page renderers — NOT the old YAML textarea. If this pin\n" +
			"fails, restore the proposal modal's Workflow tab rather than the old\n" +
			"<details>+textarea block. DO NOT delete this pin.",
		);
	});

	it("render.ts wires draft inlineRoles state into the proposal modal (this proposal-modal-tabs fix)", () => {
		const text = read("src/app/render.ts");
		assert.ok(
			text.includes("inlineRoles"),
			"src/app/render.ts must reference `inlineRoles` somewhere in the\n" +
			"goal proposal modal — it is the draft-scoped per-role customisation\n" +
			"map the Roles tab edits and the submit path forwards to createGoal.\n" +
			"Regression commit 46e21256 silently dropped the entire inline-roles\n" +
			"editor surface from render.ts (11 `inlineRolesYaml` refs at 46e21256^1\n" +
			"→ 0 at 46e21256). Restored by this proposal-modal-tabs fix as a\n" +
			"tabbed surface reusing the Roles page renderers — NOT the old YAML\n" +
			"textarea. If this pin fails, restore the proposal modal's Roles tab\n" +
			"rather than the old <details>+textarea block. DO NOT delete this pin.",
		);
	});

	it("render.ts renders the proposal-modal Workflow tab (this proposal-modal-tabs fix)", () => {
		const text = read("src/app/render.ts");
		assert.ok(
			text.includes('data-testid="goal-proposal-tab-workflow"'),
			"src/app/render.ts must render the proposal modal's Workflow tab\n" +
			"button with data-testid=\"goal-proposal-tab-workflow\". This is the\n" +
			"user-visible affordance that lets operators inspect/customise the\n" +
			"selected workflow for a goal at creation time. Regression commit\n" +
			"46e21256 silently dropped the entire inline-workflow editor surface\n" +
			"from render.ts; this proposal-modal-tabs fix restores it as a tab\n" +
			"alongside Goal and Roles. DO NOT delete this pin — restore the\n" +
			"dropped tab button instead.",
		);
	});

	it("render.ts renders the proposal-modal Roles tab (this proposal-modal-tabs fix)", () => {
		const text = read("src/app/render.ts");
		assert.ok(
			text.includes('data-testid="goal-proposal-tab-roles"'),
			"src/app/render.ts must render the proposal modal's Roles tab button\n" +
			"with data-testid=\"goal-proposal-tab-roles\". This is the user-visible\n" +
			"affordance that lets operators inspect/customise per-goal role\n" +
			"overrides at creation time. Regression commit 46e21256 silently\n" +
			"dropped the entire inline-roles editor surface from render.ts; this\n" +
			"proposal-modal-tabs fix restores it as a tab alongside Goal and\n" +
			"Workflow. DO NOT delete this pin — restore the dropped tab button\n" +
			"instead.",
		);
	});

	it("api.ts createGoal opts include `workflow` (this proposal-modal-tabs fix)", () => {
		const text = read("src/app/api.ts");
		// Pin the opts-field name `workflow` on the createGoal signature. We
		// match the parameter declaration shape so the pin doesn't false-fire
		// on incidental uses of the word "workflow" elsewhere in the file.
		assert.ok(
			/createGoal\([\s\S]*?workflow\?\s*:/.test(text),
			"src/app/api.ts::createGoal opts must declare a `workflow?: …` field.\n" +
			"This is the wire field the proposal modal uses to send a draft-scoped\n" +
			"customised inline workflow (snapshotted onto the goal). Regression\n" +
			"commit 46e21256 silently dropped the UI that fed this field; this\n" +
			"proposal-modal-tabs fix restores the UI and depends on the wire\n" +
			"field staying in the createGoal signature. DO NOT delete this pin —\n" +
			"restore the dropped opts field instead.",
		);
	});

	it("api.ts createGoal opts include `inlineRoles` (this proposal-modal-tabs fix)", () => {
		const text = read("src/app/api.ts");
		assert.ok(
			/createGoal\([\s\S]*?inlineRoles\?\s*:/.test(text),
			"src/app/api.ts::createGoal opts must declare an `inlineRoles?: …`\n" +
			"field. This is the wire field the proposal modal uses to send\n" +
			"draft-scoped per-role customisations (snapshotted onto the goal).\n" +
			"Regression commit 46e21256 silently dropped the UI that fed this\n" +
			"field; this proposal-modal-tabs fix restores the UI and depends on\n" +
			"the wire field staying in the createGoal signature. DO NOT delete\n" +
			"this pin — restore the dropped opts field instead.",
		);
	});
});
