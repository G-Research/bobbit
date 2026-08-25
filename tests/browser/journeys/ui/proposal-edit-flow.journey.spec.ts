/**
 * E2E â€” Project propose â†’ edit â†’ accept happy path for editable proposals.
 *
 * Spec: docs/design/editable-proposals.md Â§9.1.
 *
 *   1. propose_project (initial seed) â€” UI panel populates with build_command="echo old".
 *   2. edit_proposal type=project old_text="echo old" new_text="echo new" â€” server
 *      applies the edit and broadcasts proposal_update {source:"edit"};
 *      the unified onProposal callback merges it into the slot.
 *   3. User clicks Apply Changes â†’ PUT /api/projects/:id/config payload reflects
 *      the edited build_command.
 */
import { test, expect } from "../../_helpers/journey-fixture.js";
import { apiFetch, defaultProjectId, nonGitCwd } from "../../_helpers/e2e-setup.js";
import { openApp, createSessionViaUI, sendMessage } from "../../../support/harnesses/browser/legacy-ui/ui-helpers.js";

async function authenticateMockProposalTools(page: import("@playwright/test").Page, gateway: any): Promise<void> {
	const sessionId = await page.evaluate(() => {
		const state = (window as any).bobbitState ?? (window as any).__bobbitState;
		return state?.selectedSessionId as string | undefined;
	});
	const agent = sessionId ? gateway.sessionManager?.getSession(sessionId)?.rpcClient?._agent : undefined;
	if (!agent || typeof agent._gatewayPost !== "function") {
		throw new Error("proposal journey requires the in-process mock agent gateway adapter");
	}
	const sessionSecret = agent.env?.BOBBIT_SESSION_SECRET;
	if (typeof sessionSecret !== "string" || !sessionSecret) {
		throw new Error("proposal journey mock session is missing its owner capability");
	}
	const gatewayPost = agent._gatewayPost.bind(agent);
	agent._gatewayPost = (pathname: string, body: unknown, headers: Record<string, string> = {}) => gatewayPost(
		pathname,
		body,
		{ ...headers, "X-Bobbit-Session-Secret": sessionSecret },
	);
}

async function getDefaultProjectId(): Promise<string> {
	const projectId = await defaultProjectId();
	expect(projectId).toBeTruthy();
	return projectId!;
}

test.describe("Editable proposals â€” project propose â†’ edit â†’ accept", () => {
	test("propose_project then edit_proposal updates the slot live without a re-emit; accept persists edited value", async ({ page, gateway }) => {
		const projectId = await getDefaultProjectId();

		// Seed baseline so the diff has a clear "before" line.
		await apiFetch(`/api/projects/${projectId}/config`, {
			method: "PUT",
			body: JSON.stringify({ build_command: "baseline-build" }),
		});

		await openApp(page);
		await createSessionViaUI(page);
		await authenticateMockProposalTools(page, gateway);

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

		// The fixture seed describes a new project. This journey applies the edit
		// to the existing default project, so set the current schema's explicit
		// project target and replace the mock's nonexistent legacy root first.
		const sessionId = await page.evaluate(() => {
			const state = (window as any).bobbitState ?? (window as any).__bobbitState;
			return state?.selectedSessionId as string | undefined;
		});
		expect(sessionId).toBeTruthy();
		const targetEdit = await page.evaluate(async ({ sid, cwd, targetProjectId }) => {
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
		await expect.poll(
			() => page.evaluate((id) => {
				const state = (window as any).bobbitState ?? (window as any).__bobbitState;
				const slot = state?.activeProposals?.project;
				return slot?.fields?.projectId === id && slot?.mode === "registered" ? slot.rev : null;
			}, projectId),
			{ timeout: 15_000 },
		).toBeGreaterThan(1);
		const revisionBeforeSurgicalEdit = await page.evaluate(() => {
			const state = (window as any).bobbitState ?? (window as any).__bobbitState;
			return state?.activeProposals?.project?.rev as number;
		});

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

		// 4. Other prior fields and the monotonic server revision are preserved.
		const proposalAfter = await page.evaluate(() => {
			const state = (window as any).bobbitState ?? (window as any).__bobbitState;
			return state?.activeProposals?.project;
		});
		expect(proposalAfter.fields.name).toBe("Editable");
		expect(proposalAfter.fields.test_command).toBe("echo test");
		expect(proposalAfter.rev).toBeGreaterThan(revisionBeforeSurgicalEdit);

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

	test("edit-only flow does not produce a second propose_project tool card", async ({ page, gateway }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await authenticateMockProposalTools(page, gateway);

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
		const revisionBeforeEdit = await page.evaluate(() => {
			const state = (window as any).bobbitState ?? (window as any).__bobbitState;
			return state?.activeProposals?.project?.rev as number | undefined;
		});
		expect(revisionBeforeEdit).toBeGreaterThan(0);

		await sendMessage(page, "EDITABLE_PROPOSAL_EDIT");
		await page.waitForFunction(
			() => {
				const s = (window as any).bobbitState;
				return s?.activeProposals?.project?.fields?.build_command === "echo new";
			},
			null,
			{ timeout: 15_000 },
		);

		// No new propose_project tool card was created â€” the edit went
		// through the surgical `edit_proposal` path.
		const proposeCountAfter = await page
			.getByText("Project Proposal", { exact: false })
			.count();
		expect(proposeCountAfter).toBe(proposeCountBefore);
		const revisionAfterEdit = await page.evaluate(() => {
			const state = (window as any).bobbitState ?? (window as any).__bobbitState;
			return state?.activeProposals?.project?.rev as number | undefined;
		});
		expect(revisionAfterEdit).toBeGreaterThan(revisionBeforeEdit!);
	});
});
