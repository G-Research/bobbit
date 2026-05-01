/**
 * E2E — Project propose → edit → accept happy path for editable proposals.
 *
 * Spec: docs/design/editable-proposals.md §9.1 (row "Project propose → edit →
 * accept happy path"). Drives the mock agent through:
 *
 *   1. propose_project (initial seed; UI panel shows "echo old")
 *   2. edit_proposal type=project old_text="echo old" new_text="echo new"
 *      — surgical edit; the panel re-hydrates from the broadcast
 *      `proposal_update { source: "edit" }` event without a full re-emit.
 *   3. User clicks Apply Changes → PUT /api/projects/:id/config payload
 *      reflects the edited build_command.
 *
 * NOTE — Slice F is authored against the spec; runtime correctness depends on
 * Slices B (server proposal-files + REST + WS), C (view_proposal /
 * edit_proposal tools + propose_* /seed POST) and E (session-manager unified
 * onProposal callback merging the broadcast). Each test is currently fixme'd
 * with a TODO referencing the integration slice. Remove the fixmes once Slice
 * E lands.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, createSessionViaUI, sendMessage } from "./ui-helpers.js";

async function getDefaultProjectId(): Promise<string> {
	const resp = await apiFetch("/api/projects");
	const data = await resp.json();
	const projects = Array.isArray(data) ? data : (data.projects || []);
	expect(projects.length).toBeGreaterThan(0);
	return projects[0].id;
}

test.describe("Editable proposals — project propose → edit → accept", () => {
	test.fixme(
		"propose_project then edit_proposal updates panel without re-emit; accept persists edited value",
		async ({ page }) => {
			// TODO(slice-E): unfixme once Slices B+C+D+E land. Until then the
			// edit_proposal tool, REST endpoints, and unified onProposal
			// callback don't exist, so the second update never reaches the UI.
			const projectId = await getDefaultProjectId();

			// Seed baseline so the diff has a clear "before" line.
			await apiFetch(`/api/projects/${projectId}/config`, {
				method: "PUT",
				body: JSON.stringify({ build_command: "baseline-build" }),
			});

			await openApp(page);
			await createSessionViaUI(page);

			// 1. Initial propose_project. The mock agent's
			//    `EDITABLE_PROPOSAL_INITIAL` trigger (added in Slice F mock-agent
			//    extensions, see TODO at end of file) emits:
			//      propose_project { name: "Editable", root_path: "/tmp/editable",
			//                        build_command: "echo old" }
			await sendMessage(page, "EDITABLE_PROPOSAL_INITIAL");

			const panel = page.locator('[data-panel="project-proposal"]').first();
			await expect(panel).toBeVisible({ timeout: 15_000 });

			// 2. Assert the panel reflects the initial build_command. The diff
			//    view surfaces "echo old" as the proposed value for build_command.
			//    We assert against the panel's text content rather than a specific
			//    structural selector so this remains stable across the unification
			//    refactor (which doesn't touch the bespoke panel).
			await expect(panel).toContainText("echo old", { timeout: 10_000 });

			// 3. Trigger the edit. The mock agent's `EDITABLE_PROPOSAL_EDIT`
			//    trigger (Slice F mock-agent extension) calls the `edit_proposal`
			//    tool with type=project, old_text="echo old", new_text="echo new".
			//    The server applies the edit, re-parses, and broadcasts
			//    `proposal_update { source: "edit" }`. The unified onProposal
			//    callback merges the new fields into state.activeProposals.project.
			await sendMessage(page, "EDITABLE_PROPOSAL_EDIT");

			// 4. Panel updates LIVE without a full re-emit. The "echo old" string
			//    must disappear and "echo new" must appear. If the merge is
			//    broken (regression of bug C from the project-proposal staleness
			//    bug — replacing instead of shallow-merging), this fails.
			await expect(panel).toContainText("echo new", { timeout: 10_000 });
			await expect(panel).not.toContainText("echo old");

			// 5. Click Apply Changes. The accept path issues
			//    PUT /api/projects/:id/config with the merged fields, then
			//    DELETE /api/sessions/:id/proposal/project to drop the on-disk file.
			const applyBtn = panel
				.locator("button", { has: page.locator('[data-testid="accept-label"]') })
				.first();
			await expect(applyBtn).toBeEnabled({ timeout: 10_000 });
			await applyBtn.click();

			// 6. Panel disappears; the session stays connected.
			await expect(panel).toBeHidden({ timeout: 10_000 });
			await expect(page.locator("textarea").first()).toBeVisible();

			// 7. Server config reflects the EDITED value, not the initial one.
			const cfg = await (await apiFetch(`/api/projects/${projectId}/config`)).json();
			expect(cfg.build_command).toBe("echo new");
		},
	);

	test.fixme(
		"edit-only flow (no second propose_*) does not re-emit panel data — single source of truth is the on-disk file",
		async ({ page }) => {
			// TODO(slice-E): unfixme once edit_proposal broadcasts
			// proposal_update { source: "edit" } and the client merges it.
			// This is the regression test that distinguishes "agent re-emitted
			// the whole payload" (bad — costs tokens) from "agent only edited"
			// (good — file-on-disk is the source of truth).
			await openApp(page);
			await createSessionViaUI(page);

			await sendMessage(page, "EDITABLE_PROPOSAL_INITIAL");
			const panel = page.locator('[data-panel="project-proposal"]').first();
			await expect(panel).toBeVisible({ timeout: 15_000 });
			await expect(panel).toContainText("echo old", { timeout: 10_000 });

			// Snapshot the propose_project tool-call count BEFORE the edit. The
			// edit must not produce a second propose_project call.
			const proposeCountBefore = await page
				.getByText("Project Proposal", { exact: false })
				.count();

			await sendMessage(page, "EDITABLE_PROPOSAL_EDIT");
			await expect(panel).toContainText("echo new", { timeout: 10_000 });

			// Tool-call count for propose_project should be unchanged. Only an
			// `edit_proposal` tool card may have been added.
			const proposeCountAfter = await page
				.getByText("Project Proposal", { exact: false })
				.count();
			expect(proposeCountAfter).toBe(proposeCountBefore);
		},
	);
});

/*
 * Mock-agent triggers required by this spec (added in Slice F or Slice C):
 *
 *   EDITABLE_PROPOSAL_INITIAL → emits a single propose_project tool call:
 *     {
 *       name: "Editable",
 *       root_path: "/tmp/editable",
 *       build_command: "echo old",
 *       test_command: "echo test",
 *     }
 *
 *   EDITABLE_PROPOSAL_EDIT → emits a single edit_proposal tool call:
 *     {
 *       type: "project",
 *       old_text: "echo old",
 *       new_text: "echo new",
 *     }
 *
 * Both keep the trigger-substring convention used by the rest of
 * tests/e2e/mock-agent-core.mjs (see PROJECT_PROPOSAL / GOAL_PROPOSAL /
 * MULTI_COMPONENT_PROPOSAL handlers).
 */
