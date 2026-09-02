/** Editable and multi-component project-proposal journeys. */
import { test, expect, openApp, apiFetch, defaultProjectId } from "../../support/helpers/browser/journeys/journey-fixture.js";
import { createSessionViaUI, sendMessage } from "../../support/helpers/browser/journeys/journey-fixture.js";
import { nonGitCwd } from "../../support/harnesses/browser/e2e-setup.js";
import { authenticateMockProposalTools } from "../../support/helpers/browser/journeys/proposal-helpers.js";

// Ported from proposal-edit-flow.spec.ts (audit: proposals GAP, mutant BR54):
// an editable project proposal panel exposes its Apply/Accept button via the
// accept-label testid, and applying the (live-edited) proposal persists.
test.describe("Journey: Editable Project Proposal", () => {
	test("edit_proposal updates the slot live; Apply (accept-label) persists edited value", async ({ page, gateway }) => {
		test.setTimeout(90_000);
		const projectId = await defaultProjectId();
		expect(projectId).toBeTruthy();
		await openApp(page);
		await createSessionViaUI(page);
		await authenticateMockProposalTools(page, gateway);

		// Initial propose_project → slot populates with build_command="echo old".
		await sendMessage(page, "EDITABLE_PROPOSAL_INITIAL");
		await page.waitForFunction(
			() => {
				const s = (window as any).bobbitState ?? (window as any).__bobbitState;
				return s?.activeProposals?.project?.fields?.build_command === "echo old";
			},
			null,
			{ timeout: 20_000 },
		);
		const panel = page.locator('[data-panel="project-proposal"]').first();
		await expect(panel).toBeVisible({ timeout: 15_000 });

		// This is an existing-project edit journey: make the target explicit and
		// replace the mock's legacy nonexistent /tmp path with the harness temp root.
		// The server edit keeps the persisted draft and browser slot in sync.
		const sessionId = await page.evaluate(() => {
			const s = (window as any).bobbitState ?? (window as any).__bobbitState;
			return s?.selectedSessionId as string | undefined;
		});
		expect(sessionId).toBeTruthy();
		const targetEdit = await page.evaluate(async ({ sid, cwd, targetProjectId }) => {
			// Proposal mutation is a human-operator action. Keep this request on the
			// mounted app's origin so the browser's signed operator cookie, rather
			// than the Node harness bearer token, authenticates the owner explicitly.
			const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}/proposal/project/edit`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					old_text: "root_path: /tmp/editable",
					new_text: `root_path: ${JSON.stringify(cwd)}\nprojectId: ${targetProjectId}`,
				}),
			});
			return { status: response.status, text: await response.text() };
		}, { sid: sessionId!, cwd: nonGitCwd(), targetProjectId: projectId });
		expect(targetEdit.status, `explicit project target edit failed: ${targetEdit.text}`).toBe(200);
		await page.waitForFunction(
			(id) => {
				const s = (window as any).bobbitState ?? (window as any).__bobbitState;
				return s?.activeProposals?.project?.fields?.projectId === id
					&& s?.activeProposals?.project?.mode === "registered";
			},
			projectId,
			{ timeout: 15_000 },
		);

		// Surgical edit → slot flips live to "echo new" with no propose_project re-emit.
		await sendMessage(page, "EDITABLE_PROPOSAL_EDIT");
		await page.waitForFunction(
			() => {
				const s = (window as any).bobbitState ?? (window as any).__bobbitState;
				return s?.activeProposals?.project?.fields?.build_command === "echo new";
			},
			null,
			{ timeout: 15_000 },
		);

		// The Apply button is located via the accept-label testid (the mutant target).
		const acceptLabel = panel.locator('[data-testid="accept-label"]').first();
		await expect(acceptLabel).toBeVisible({ timeout: 15_000 });
		// Accept is gated by `streaming`; wait for the agent to go idle so the
		// button reflects its enabled (name-present) state.
		await page.waitForFunction(
			() => ((window as any).bobbitState ?? (window as any).__bobbitState)?.remoteAgent?.state?.status === "idle",
			null,
			{ timeout: 20_000 },
		);
		const applyBtn = panel.locator("button", { has: page.locator('[data-testid="accept-label"]') }).first();
		await expect(applyBtn).toBeEnabled({ timeout: 10_000 });
		await applyBtn.click();

		// Slot clears and panel disappears once the edited config is applied.
		await page.waitForFunction(
			() => !((window as any).bobbitState ?? (window as any).__bobbitState)?.activeProposals?.project,
			null,
			{ timeout: 15_000 },
		);
		await expect(panel).toBeHidden({ timeout: 10_000 });
		const config = await (await apiFetch(`/api/projects/${projectId}/config`)).json();
		expect(config.build_command).toBe("echo new");
	});

	// Ported from project-assistant.spec.ts (audit: proposals/project-assistant
	// GAP, mutant BR57): a multi-component propose_project renders structured
	// component cards in the Components view and per-component + all-components
	// workflow cards under the Workflows tab.
	test("multi-component project proposal renders component + workflow cards", async ({ page }) => {
		test.setTimeout(90_000);
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "MULTI_COMPONENT_PROPOSAL");

		const panel = page.locator('[data-panel="project-proposal"]').first();
		await expect(panel).toBeVisible({ timeout: 20_000 });

		// Components view (default) renders both structured component cards.
		await expect(panel.locator('[data-testid="component-card-api"]')).toBeVisible({ timeout: 20_000 });
		await expect(panel.locator('[data-testid="component-card-web"]')).toBeVisible({ timeout: 10_000 });

		// Switch to the Workflows tab — per-component + all-components cards
		// (mutant target: workflow-card-<id>) must render.
		await panel.locator('[data-testid="view-tab-workflows"]').click();
		await expect(panel.locator('[data-testid="workflow-card-feature-api"]')).toBeVisible({ timeout: 15_000 });
		await expect(panel.locator('[data-testid="workflow-card-feature-web"]')).toBeVisible({ timeout: 10_000 });
		await expect(panel.locator('[data-testid="workflow-card-all-components"]')).toBeVisible({ timeout: 10_000 });
	});
});
