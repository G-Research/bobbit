/**
 * Journey — Project propose → edit → accept happy path for editable proposals.
 *
 * Spec: docs/design/editable-proposals.md §9.1.
 *
 *   1. propose_project (initial seed) — UI panel populates with build_command="echo old".
 *   2. edit_proposal type=project old_text="echo old" new_text="echo new" — server
 *      applies the edit and broadcasts proposal_update {source:"edit"};
 *      the unified onProposal callback merges it into the slot.
 *   3. User clicks Apply Changes → PUT /api/projects/:id/config payload reflects
 *      the edited build_command.
 */
import { test, expect } from "../../e2e/gateway-harness.js";
import { apiFetch, defaultProjectId, nonGitCwd } from "../../e2e/e2e-setup.js";
import { openApp, createSessionViaUI, sendMessage } from "../../e2e/ui/ui-helpers.js";

async function getDefaultProjectId(): Promise<string> {
	const projectId = await defaultProjectId();
	expect(projectId).toBeTruthy();
	return projectId!;
}

test.describe("Editable proposals — project propose → edit → accept", () => {
	test("propose_project then edit_proposal updates the slot live without a re-emit; accept persists edited value", async ({ page }) => {
		const projectId = await getDefaultProjectId();

		// Seed baseline so the diff has a clear "before" line.
		await apiFetch(`/api/projects/${projectId}/config`, {
			method: "PUT",
			body: JSON.stringify({ build_command: "baseline-build" }),
		});

		await openApp(page);
		await createSessionViaUI(page);

		// 1. Initial propose_project. Mock-agent trigger
		//    EDITABLE_PROPOSAL_INITIAL emits propose_project with
		//    build_command:"echo old".
		await sendMessage(page, "EDITABLE_PROPOSAL_INITIAL");

		// Wait for the slot to populate with build_command="echo old".
		await page.waitForFunction(
			() => {
				const s = (window as any).bobbitState;
				const fields = s?.activeProposals?.project?.fields;
				return fields?.build_command === "echo old";
			},
			null,
			{ timeout: 20_000 },
		);

		// Project panel must be visible.
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

		// 2. Trigger the edit. EDITABLE_PROPOSAL_EDIT emits an
		//    edit_proposal tool call which the mock-agent translates
		//    into a POST /api/sessions/:id/proposal/project/edit. The
		//    server applies the edit and broadcasts proposal_update.
		await sendMessage(page, "EDITABLE_PROPOSAL_EDIT");

		// 3. Slot.fields.build_command must flip live, no re-emit needed.
		await page.waitForFunction(
			() => {
				const s = (window as any).bobbitState;
				return s?.activeProposals?.project?.fields?.build_command === "echo new";
			},
			null,
			{ timeout: 15_000 },
		);

		// 4. Other prior fields preserved.
		const fieldsAfter = await page.evaluate(
			() => (window as any).bobbitState?.activeProposals?.project?.fields,
		);
		expect(fieldsAfter.name).toBe("Editable");
		expect(fieldsAfter.test_command).toBe("echo test");

		// 5. Click Apply Changes (registered mode).
		const applyBtn = panel
			.locator("button", { has: page.locator('[data-testid="accept-label"]') })
			.first();
		await expect(applyBtn).toBeEnabled({ timeout: 10_000 });
		await applyBtn.click();

		// 6. Slot clears and panel disappears.
		await page.waitForFunction(
			() => !(window as any).bobbitState?.activeProposals?.project,
			null,
			{ timeout: 15_000 },
		);
		await expect(panel).toBeHidden({ timeout: 10_000 });

		// 7. Server config reflects the EDITED value.
		const cfg = await (
			await apiFetch(`/api/projects/${projectId}/config`)
		).json();
		expect(cfg.build_command).toBe("echo new");
	});

	test("edit-only flow does not produce a second propose_project tool card", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);

		await sendMessage(page, "EDITABLE_PROPOSAL_INITIAL");
		await page.waitForFunction(
			() => {
				const s = (window as any).bobbitState;
				return s?.activeProposals?.project?.fields?.build_command === "echo old";
			},
			null,
			{ timeout: 20_000 },
		);

		const panel = page.locator('[data-panel="project-proposal"]').first();
		await expect(panel).toBeVisible({ timeout: 15_000 });

		const proposeCountBefore = await page.getByText("Project Proposal", { exact: false }).count();

		await sendMessage(page, "EDITABLE_PROPOSAL_EDIT");
		await page.waitForFunction(
			() => {
				const s = (window as any).bobbitState;
				return s?.activeProposals?.project?.fields?.build_command === "echo new";
			},
			null,
			{ timeout: 15_000 },
		);

		// No new propose_project tool card was created — the edit went
		// through the surgical `edit_proposal` path.
		const proposeCountAfter = await page
			.getByText("Project Proposal", { exact: false })
			.count();
		expect(proposeCountAfter).toBe(proposeCountBefore);
	});
});
