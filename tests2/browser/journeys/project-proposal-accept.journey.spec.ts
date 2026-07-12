/**
 * Journey: Project proposal Accept/Apply — REPRODUCING TEST.
 *
 * Pins the bug where project proposal Accept/Apply can silently no-op or
 * continue through failures: no in-flight button state, duplicate clicks can
 * invoke duplicate mutations, and rename/config failures can be swallowed while
 * the proposal is cleared.
 *
 * EXPECTED TO FAIL on current HEAD with PROJECT_PROPOSAL_ACCEPT_PENDING_BUG and
 * PROJECT_PROPOSAL_ACCEPT_FAILURE_BUG until the accept flow exposes pending
 * state, surfaces errors, and stops cleanup on failure.
 */
import type { Page, Route } from "@playwright/test";
import {
	apiFetch,
	createSession,
	defaultProject,
	expect,
	navigateToHash,
	openApp,
	test,
	waitForSessionStatus,
} from "../_helpers/journey-fixture.js";

// Deterministic bug repro — a failure here is the bug, not a flake budget.
test.describe.configure({ retries: 0 });

const PROJECT_PROPOSAL_TAB_ID = "proposal:project";
const PANEL_SELECTOR = '[data-panel="project-proposal"]';

type ProposalMode = "registered" | "provisional";
type ProjectRouteControls = {
	renameAttempts: () => number;
	configAttempts: () => number;
	promoteAttempts: () => number;
	releaseRename: () => void;
	releaseConfig: () => void;
	releasePromote: () => void;
};

async function openSession(page: Page, sessionId: string): Promise<void> {
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
	await expect.poll(() => page.evaluate(() => (window as any).bobbitState?.selectedSessionId ?? null), {
		timeout: 10_000,
		message: "selected session should hydrate before injecting project proposal",
	}).toBe(sessionId);
}

async function openProjectProposalWorkspaceTab(sessionId: string): Promise<void> {
	const resp = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace/open`, {
		method: "POST",
		body: JSON.stringify({
			tab: {
				id: PROJECT_PROPOSAL_TAB_ID,
				kind: "proposal",
				title: "Project Proposal",
				label: "Project",
				source: { type: "proposal", proposalType: "project", sessionId },
				updatedAt: Date.now(),
			},
		}),
	});
	const text = await resp.text();
	expect(resp.status, `open project proposal workspace tab failed: ${text}`).toBe(200);
}

async function forceRender(page: Page): Promise<void> {
	await page.evaluate(() => {
		const trigger = (window as any).__bobbitRenderApp;
		if (typeof trigger !== "function") throw new Error("__bobbitRenderApp missing");
		trigger();
		return new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
	});
}

async function injectProjectProposal(page: Page, opts: {
	sessionId: string;
	projectId: string;
	projectName: string;
	rootPath: string;
	mode: ProposalMode;
}): Promise<void> {
	await openProjectProposalWorkspaceTab(opts.sessionId);
	await expect.poll(async () => {
		await page.evaluate(({ sessionId, projectId, projectName, rootPath, mode, projectTabId }) => {
			const w = window as any;
			const state = w.bobbitState ?? w.__bobbitState;
			if (!state) throw new Error("bobbitState missing");

			const session = state.gatewaySessions?.find((s: any) => s.id === sessionId);
			if (session) {
				session.projectId = projectId;
				session.assistantType = mode === "provisional" ? "project" : null;
			} else {
				state.gatewaySessions = [
					...(Array.isArray(state.gatewaySessions) ? state.gatewaySessions : []),
					{ id: sessionId, projectId, assistantType: mode === "provisional" ? "project" : null, status: "idle" },
				];
			}

			const projects = Array.isArray(state.projects) ? state.projects : [];
			const existing = projects.find((p: any) => p.id === projectId);
			if (existing) {
				existing.name = projectName;
				existing.rootPath = rootPath;
				existing.provisional = mode === "provisional";
			} else {
				projects.push({ id: projectId, name: projectName, rootPath, provisional: mode === "provisional" });
				state.projects = projects;
			}

			state.activeProposals.project = {
				sessionId,
				// Project proposals pin their target project id at creation time so
				// accept promotes/writes the intended project even after a background
				// refreshSessions() poll mutates the session→project link. Mirror that
				// real data model here instead of relying solely on the mutable
				// session list (which the 5s poll would revert to the base project id).
				projectId,
				fields: {
					name: projectName,
					root_path: rootPath,
					build_command: "echo project proposal accept build",
					test_command: "echo project proposal accept test",
				},
				streaming: false,
				mode,
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
		}, { ...opts, projectTabId: PROJECT_PROPOSAL_TAB_ID });
		await forceRender(page);
		const panel = page.locator(`${PANEL_SELECTOR}[data-mode="${opts.mode}"]`).first();
		if (!await panel.isVisible().catch(() => false)) return "panel-not-visible";
		const enabled = await panel.locator('[data-testid="proposal-primary-submit"] button').first().isEnabled().catch(() => false);
		return enabled ? "ready" : "button-disabled";
	}, {
		timeout: 10_000,
		intervals: [100, 150, 250],
		message: `${opts.mode} project proposal should be visible and actionable`,
	}).toBe("ready");
}

async function setupRegisteredProposal(page: Page, testName: string): Promise<{
	sessionId: string;
	projectId: string;
	rootPath: string;
	panel: ReturnType<Page["locator"]>;
	button: ReturnType<Page["locator"]>;
	label: ReturnType<Page["locator"]>;
}> {
	const project = await defaultProject();
	const sessionId = await createSession({ projectId: project.id });
	await waitForSessionStatus(sessionId, "idle");
	await openApp(page);
	await openSession(page, sessionId);
	await injectProjectProposal(page, {
		sessionId,
		projectId: project.id,
		projectName: `Accept Repro ${testName}`,
		rootPath: project.rootPath,
		mode: "registered",
	});
	const panel = page.locator(`${PANEL_SELECTOR}[data-mode="registered"]`).first();
	const button = panel.locator('[data-testid="proposal-primary-submit"] button').first();
	const label = panel.locator('[data-testid="accept-label"]').first();
	await expect(label).toContainText("Apply Changes", { timeout: 10_000 });
	await expect(button).toBeEnabled({ timeout: 10_000 });
	return { sessionId, projectId: project.id, rootPath: project.rootPath, panel, button, label };
}

async function setupProvisionalProposal(page: Page): Promise<{
	sessionId: string;
	projectId: string;
	panel: ReturnType<Page["locator"]>;
	button: ReturnType<Page["locator"]>;
}> {
	const baseProject = await defaultProject();
	const sessionId = await createSession({ projectId: baseProject.id });
	await waitForSessionStatus(sessionId, "idle");
	await openApp(page);
	await openSession(page, sessionId);
	const projectId = `e2e-provisional-project-${Date.now()}`;
	await injectProjectProposal(page, {
		sessionId,
		projectId,
		projectName: "Provisional Accept Repro",
		rootPath: baseProject.rootPath,
		mode: "provisional",
	});
	const panel = page.locator(`${PANEL_SELECTOR}[data-mode="provisional"]`).first();
	const button = panel.locator('[data-testid="proposal-primary-submit"] button').first();
	await expect(panel.locator('[data-testid="accept-label"]')).toContainText("Accept Project", { timeout: 10_000 });
	await expect(button).toBeEnabled({ timeout: 10_000 });
	return { sessionId, projectId, panel, button };
}

async function routeProjectMutations(page: Page, projectId: string, opts?: {
	rename?: "ok" | "delay" | "abort";
	config?: "ok" | "delay" | "abort";
	promote?: "ok" | "delay" | "abort";
}): Promise<ProjectRouteControls> {
	let renameAttempts = 0;
	let configAttempts = 0;
	let promoteAttempts = 0;
	let releaseRename = () => {};
	let releaseConfig = () => {};
	let releasePromote = () => {};
	const renameGate = new Promise<void>((resolve) => { releaseRename = resolve; });
	const configGate = new Promise<void>((resolve) => { releaseConfig = resolve; });
	const promoteGate = new Promise<void>((resolve) => { releasePromote = resolve; });

	async function finish(route: Route, behavior: "ok" | "delay" | "abort" | undefined, gate: Promise<void>, body: Record<string, unknown>): Promise<void> {
		if (behavior === "abort") {
			await route.abort("failed");
			return;
		}
		if (behavior === "delay") await gate;
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(body),
		});
	}

	await page.route("**/api/projects/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname;
		if (path === `/api/projects/${projectId}` && request.method() === "PUT") {
			renameAttempts += 1;
			await finish(route, opts?.rename ?? "ok", renameGate, { id: projectId, name: "renamed" });
			return;
		}
		if (path === `/api/projects/${projectId}/config` && request.method() === "PUT") {
			configAttempts += 1;
			await finish(route, opts?.config ?? "ok", configGate, { ok: true });
			return;
		}
		if (path === `/api/projects/${projectId}/promote` && request.method() === "POST") {
			promoteAttempts += 1;
			await finish(route, opts?.promote ?? "ok", promoteGate, { id: projectId, name: "promoted", provisional: false });
			return;
		}
		await route.continue();
	});

	return {
		renameAttempts: () => renameAttempts,
		configAttempts: () => configAttempts,
		promoteAttempts: () => promoteAttempts,
		releaseRename,
		releaseConfig,
		releasePromote,
	};
}

async function expectProjectProposalStillActionable(page: Page, mode: ProposalMode): Promise<void> {
	const panel = page.locator(`${PANEL_SELECTOR}[data-mode="${mode}"]`).first();
	await expect(panel, `PROJECT_PROPOSAL_ACCEPT_FAILURE_BUG: ${mode} proposal panel should remain visible after accept failure`).toBeVisible({ timeout: 10_000 });
	await expect(
		panel.locator('[data-testid="proposal-primary-submit"] button').first(),
		`PROJECT_PROPOSAL_ACCEPT_FAILURE_BUG: ${mode} proposal button should remain actionable after accept failure`,
	).toBeEnabled({ timeout: 10_000 });
	await expect.poll(() => page.evaluate(() => Boolean((window as any).bobbitState?.activeProposals?.project)), {
		timeout: 10_000,
		message: `PROJECT_PROPOSAL_ACCEPT_FAILURE_BUG: ${mode} proposal must not be cleared after accept failure`,
	}).toBe(true);
}

test.describe("Journey: project proposal accept/apply no-op regression", () => {
	test("registered Apply Changes shows pending feedback and suppresses duplicate rename while in flight", async ({ page }) => {
		test.setTimeout(60_000);
		const { projectId, button, label } = await setupRegisteredProposal(page, "pending");
		const routes = await routeProjectMutations(page, projectId, { rename: "delay", config: "ok" });

		try {
			await button.click();
			await expect.poll(routes.renameAttempts, {
				timeout: 10_000,
				message: "registered rename request should start after Apply Changes click",
			}).toBe(1);

			await expect(button, "PROJECT_PROPOSAL_ACCEPT_PENDING_BUG: Apply Changes button must disable while project proposal accept is in flight").toBeDisabled({ timeout: 5_000 });
			await expect(label, "PROJECT_PROPOSAL_ACCEPT_PENDING_BUG: Apply Changes label must show visible pending feedback while in flight").toContainText(/Applying|Saving|Pending/i, { timeout: 5_000 });

			if (await button.isEnabled()) await button.click();
			await expect.poll(routes.renameAttempts, {
				timeout: 5_000,
				message: "PROJECT_PROPOSAL_ACCEPT_PENDING_BUG: duplicate Apply click must not start a second rename request",
			}).toBe(1);
		} finally {
			routes.releaseRename();
			routes.releaseConfig();
		}
	});

	test("registered rename failure surfaces an error and leaves the proposal actionable", async ({ page }) => {
		test.setTimeout(60_000);
		const { projectId, button } = await setupRegisteredProposal(page, "rename-failure");
		const routes = await routeProjectMutations(page, projectId, { rename: "abort", config: "ok" });

		await button.click();
		await expect.poll(routes.renameAttempts, {
			timeout: 10_000,
			message: "registered rename request should be attempted",
		}).toBe(1);

		await expect(
			page.getByText(/Failed to (rename|update|apply).*project|Project proposal accept failed/i).first(),
			"PROJECT_PROPOSAL_ACCEPT_FAILURE_BUG: registered rename failure must show a clear connection error",
		).toBeVisible({ timeout: 10_000 });
		await expectProjectProposalStillActionable(page, "registered");
	});

	test("provisional config failure surfaces an error and does not clear the project proposal", async ({ page }) => {
		test.setTimeout(60_000);
		const { projectId, button } = await setupProvisionalProposal(page);
		const routes = await routeProjectMutations(page, projectId, { promote: "ok", config: "abort" });

		await button.click();
		await expect.poll(routes.configAttempts, {
			timeout: 10_000,
			message: "provisional config write should be attempted after promote",
		}).toBe(1);

		await expect(
			page.getByText(/Config write failed|Failed to (write|save|apply).*config|Project proposal accept failed/i).first(),
			"PROJECT_PROPOSAL_ACCEPT_FAILURE_BUG: provisional config failure must show a clear connection error",
		).toBeVisible({ timeout: 10_000 });
		await expectProjectProposalStillActionable(page, "provisional");
	});

	test("registered Apply Changes success clears the proposal panel", async ({ page }) => {
		test.setTimeout(60_000);
		const { projectId, button } = await setupRegisteredProposal(page, "success");
		await routeProjectMutations(page, projectId, { rename: "ok", config: "ok" });

		await button.click();
		await expect.poll(() => page.evaluate(() => Boolean((window as any).bobbitState?.activeProposals?.project)), {
			timeout: 15_000,
			message: "registered Apply Changes success should clear active project proposal",
		}).toBe(false);
		await expect(page.locator(PANEL_SELECTOR), "registered Apply Changes success should close the proposal panel").toHaveCount(0, { timeout: 10_000 });
	});
});
