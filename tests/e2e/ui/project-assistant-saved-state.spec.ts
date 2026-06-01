/**
 * Project Assistant Saved State — browser E2E.
 *
 * After clicking "Apply Changes" on a registered-mode project proposal in a
 * project-assistant session, the proposal panel must render a "Changes Saved"
 * confirmation view with a "Terminate Project Assistant" button instead of
 * the "Waiting for project analysis…" empty state. The saved state must
 * survive a page reload, must be replaced by a new proposal when one arrives,
 * and the Terminate button must tear down the assistant session.
 *
 * Coverage:
 *   1. Apply Changes → "Changes Saved" + Terminate button visible.
 *   2. Reload → saved state persists (restored from project draft).
 *   3. Click Terminate → confirm → session deleted, navigated to landing.
 *   4. New project_proposal arrives mid-saved-state → form replaces "Changes
 *      Saved".
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, defaultProjectId } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

const PROJECT_PROPOSAL_TAB_ID = "proposal:project";
const REGISTERED_PROJECT_PROPOSAL_SELECTOR = '[data-panel="project-proposal"][data-mode="registered"]';

/** Create a project-assistant session bound to an already-registered project
 *  (so `resolveProjectMode` returns "registered"). Returns the session ID. */
async function createRegisteredProjectAssistant(projectId: string, cwd: string): Promise<string> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ assistantType: "project", projectId, cwd }),
	});
	expect(resp.status).toBe(201);
	const data = await resp.json();
	return data.id as string;
}

/** Navigate to a session via hash route and wait for the textarea. */
async function openSession(page: Page, sessionId: string): Promise<void> {
	await page.evaluate((id: string) => { window.location.hash = `#/session/${id}`; }, sessionId);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
}

/** Write a synthetic project proposal directly into client state. Used to
 *  exercise the panel without round-tripping through the mock agent (which
 *  drives the full propose_project flow). The Apply Changes click still
 *  exercises the real PUT /api/projects/:id/config server path. */
async function writeRegisteredProjectProposalState(
	page: Page,
	sessionId: string,
	rootPath: string,
): Promise<void> {
	await page.evaluate(({ sessionId, rootPath, projectTabId }) => {
		const w = window as any;
		const state = w.bobbitState;
		if (!state) throw new Error("bobbitState missing");
		state.activeProposals.project = {
			sessionId,
			fields: {
				name: "Saved State Test Project",
				root_path: rootPath,
				build_command: "npm run build",
				test_command: "npm test",
			},
			streaming: false,
			mode: "registered",
			rev: 1,
		};
		state.assistantHasProposal = true;
		state.assistantTab = "preview";
		state.previewPanelActiveTab = "project";
		state.previewPanelTab = "project";
		if (!state.panelWorkspaceActiveBySession || typeof state.panelWorkspaceActiveBySession !== "object" || Array.isArray(state.panelWorkspaceActiveBySession)) {
			state.panelWorkspaceActiveBySession = {};
		}
		state.panelWorkspaceActiveBySession[sessionId] = projectTabId;
		state.activePanelTabId = projectTabId;
		if (state.panelWorkspace && typeof state.panelWorkspace === "object") {
			state.panelWorkspace.activeTabId = projectTabId;
		}
	}, { sessionId, rootPath, projectTabId: PROJECT_PROPOSAL_TAB_ID });
}

async function injectProjectProposal(
	page: Page,
	sessionId: string,
	projectId: string,
	rootPath: string,
): Promise<void> {
	// Initial project-assistant draft hydration can finish after the first
	// visible chat paint and clear the synthetic slot. Keep rendering the
	// desired state until the registered panel and its scoped button are ready.
	await expect.poll(async () => {
		await writeRegisteredProjectProposalState(page, sessionId, rootPath);
		await forceRender(page);

		const clientReady = await page.evaluate(({ sessionId, projectId }) => {
			const state = (window as any).bobbitState;
			const session = state?.gatewaySessions?.find((s: any) => s.id === sessionId);
			return state?.selectedSessionId === sessionId
				&& state?.assistantType === "project"
				&& session?.projectId === projectId;
		}, { sessionId, projectId });
		if (!clientReady) return "client-hydrating";

		const panel = page.locator(REGISTERED_PROJECT_PROPOSAL_SELECTOR).first();
		const visible = await panel.isVisible().catch(() => false);
		if (!visible) return "panel-not-registered";
		const label = (await panel.locator('[data-testid="accept-label"]').first().textContent().catch(() => "")) ?? "";
		const enabled = await panel.getByRole("button", { name: /Apply Changes/ }).first().isEnabled().catch(() => false);
		return label.includes("Apply Changes") && enabled ? "ready" : "button-not-ready";
	}, {
		timeout: 10_000,
		intervals: [100, 250, 500],
	}).toBe("ready");
}

/** Force a renderApp() pass and wait for the paint to land. Directly
 *  invoking the E2E render hook avoids the viewport-toggle race where the
 *  proposal panel can still be on the empty state when the accept click starts. */
async function forceRender(page: Page): Promise<void> {
	await page.evaluate(() => {
		const trigger = (window as any).__bobbitRenderApp;
		if (typeof trigger !== "function") throw new Error("__bobbitRenderApp missing");
		trigger();
		return new Promise<void>((resolve) => {
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
		});
	});
}

async function expectRegisteredProposalReady(page: Page): Promise<{ panel: Locator; applyButton: Locator }> {
	const panel = page.locator(REGISTERED_PROJECT_PROPOSAL_SELECTOR).first();
	await expect(panel).toBeVisible({ timeout: 10_000 });

	const acceptLabel = panel.locator('[data-testid="accept-label"]').first();
	await expect(acceptLabel).toContainText("Apply Changes", { timeout: 10_000 });

	const applyButton = panel.locator('[data-testid="proposal-primary-submit"]').getByRole("button", { name: /Apply Changes/ }).first();
	await expect(applyButton).toBeVisible({ timeout: 10_000 });
	await expect(applyButton).toBeEnabled({ timeout: 10_000 });
	return { panel, applyButton };
}

/** Programmatically flip the per-session accepted flag, mirroring what the
 *  real `acceptRegisteredProjectProposal()` flow does after a successful
 *  config PUT. Used for step 3 (re-arm the saved state after step 4 has
 *  replaced it with a new proposal) so we don't have to round-trip a second
 *  Apply Changes click against an unchanged proposal payload. */
async function markAccepted(
	page: Page,
	sessionId: string,
): Promise<void> {
	await page.evaluate(({ sessionId }) => {
		const w = window as any;
		const state = w.bobbitState;
		state.projectProposalAcceptedBySessionId[sessionId] = true;
		delete state.activeProposals.project;
		state.assistantHasProposal = false;
	}, { sessionId });
}

test.describe("Project Assistant Saved State", () => {
	test("Apply Changes shows Changes Saved + Terminate button; survives reload; new proposal replaces it", async ({ page }) => {
		const projectId = await defaultProjectId();
		expect(projectId).toBeTruthy();

		// Look up project rootPath so the proposal's root_path matches reality.
		const projects = await (await apiFetch("/api/projects")).json() as any[];
		const project = (Array.isArray(projects) ? projects : projects.projects).find((p: any) => p.id === projectId);
		expect(project).toBeTruthy();

		const sessionId = await createRegisteredProjectAssistant(projectId!, project.rootPath);

		await openApp(page);
		await openSession(page, sessionId);

		// 1. Inject a registered-mode proposal and trigger the "accepted" flag
		//    via the same code path Apply Changes uses (sets the per-session
		//    flag + persists the draft).
		await injectProjectProposal(page, sessionId, projectId!, project.rootPath);
		const { applyButton } = await expectRegisteredProposalReady(page);

		// Click the real "Apply Changes" accept button — this exercises the
		// production acceptRegisteredProjectProposal() flow including the
		// PUT /api/projects/:id/config request and the saveProjectDraft call.
		await applyButton.click();

		// 1a. "Changes Saved" view appears with the Terminate button.
		const heading = page.locator('[data-testid="project-changes-saved-heading"]');
		await expect(heading).toBeVisible({ timeout: 10_000 });
		await expect(heading).toHaveText("Changes Saved");
		const termBtn = page.getByRole("button", { name: "Terminate Project Assistant" });
		await expect(termBtn).toBeVisible();
		await expect(page.locator('[data-panel="project-proposal"][data-state="accepted"]')).toBeVisible();

		// 2. Reload → state restored from on-disk project draft. Poll the
		// server for the persisted draft so we observe the 300 ms debounced
		// saveProjectDraft flush as a real outcome rather than sleeping. The
		// `accepted: true` flag in the serialized draft is what powers the
		// post-reload "Changes Saved" view.
		await expect.poll(async () => {
			const resp = await apiFetch(`/api/sessions/${sessionId}/draft?type=project`);
			if (!resp.ok) return false;
			const data = await resp.json().catch(() => ({}));
			return data?.data?.accepted === true;
		}, { timeout: 5_000 }).toBe(true);
		await page.reload();
		await openSession(page, sessionId);
		await expect(page.locator('[data-testid="project-changes-saved-heading"]')).toBeVisible({ timeout: 15_000 });
		await expect(page.getByRole("button", { name: "Terminate Project Assistant" })).toBeVisible();

		// 4. (Done before destructive Terminate — order matters.) Deliver a new
		//    project_proposal mid-saved-state → form replaces "Changes Saved".
		await injectProjectProposal(page, sessionId, projectId!, project.rootPath);
		// Trigger a render; the unified onProposal callback only runs for
		// real WS events, so we manually clear the flag here too — this
		// mirrors what onProposal does (`delete state.projectProposalAcceptedBySessionId[sessionId]`).
		await page.evaluate(({ sessionId }) => {
			const w = window as any;
			delete w.bobbitState.projectProposalAcceptedBySessionId[sessionId];
		}, { sessionId });
		await forceRender(page);
		await expect(page.locator('[data-panel="project-proposal"][data-state="accepted"]')).toHaveCount(0, { timeout: 5_000 });
		await expectRegisteredProposalReady(page);

		// 3. Re-accept (so the saved state returns), then click Terminate
		//    Project Assistant and confirm. Session should be deleted and the
		//    user navigated to landing.
		await markAccepted(page, sessionId);
		await forceRender(page);
		await expect(page.locator('[data-testid="project-changes-saved-heading"]')).toBeVisible({ timeout: 10_000 });

		const termBtn2 = page.getByRole("button", { name: "Terminate Project Assistant" });
		await termBtn2.click();
		// Confirm dialog — destructive button labelled "Terminate". THREE buttons on
		// the page share/contain that accessible name: the persistent toolbar
		// "Terminate session" action (name "Terminate"), the panel trigger
		// "Terminate Project Assistant", and this dialog's confirm. The old
		// `{ name: "Terminate" }.last()` was a DOM-order gamble across them (the
		// flake); `{ exact: true }` still matched two (toolbar + dialog) → strict
		// violation. Scope to the confirm dialog via its unique Cancel + Terminate
		// footer pair (the toolbar Terminate has no Cancel sibling) so we target
		// ONLY the dialog confirm button, regardless of the others.
		const confirmDialogFooter = page
			.getByRole("button", { name: "Cancel", exact: true })
			.locator("xpath=..");
		const confirmBtn = confirmDialogFooter.getByRole("button", { name: "Terminate", exact: true });
		await expect(confirmBtn).toBeVisible({ timeout: 5_000 });
		await confirmBtn.click();

		// Session should be gone from the active sessions list (DELETE archives
		// the live session; the active list filters archived rows out).
		await expect.poll(async () => {
			const resp = await apiFetch("/api/sessions");
			const data = await resp.json();
			const sessions = (data?.sessions ?? data) as Array<{ id: string }>;
			return sessions.find(s => s.id === sessionId) ? "present" : "gone";
		}, { timeout: 10_000 }).toBe("gone");

		// URL should land on landing (no #/session/<id>).
		await expect.poll(
			() => page.evaluate(() => window.location.hash),
			{ timeout: 10_000 },
		).not.toContain(`#/session/${sessionId}`);
	});
});
