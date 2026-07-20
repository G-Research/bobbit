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
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page, Route } from "@playwright/test";
import {
	apiFetch,
	createSession,
	defaultProject,
	deleteSession,
	expect,
	navigateToHash,
	openApp,
	test,
	waitForSessionStatus,
} from "../_helpers/journey-fixture.js";
import { rawApiFetch } from "../e2e-setup.js";

// Deterministic bug repro — a failure here is the bug, not a flake budget.
test.describe.configure({ retries: 0 });

const PROJECT_PROPOSAL_TAB_ID = "proposal:project";
const PANEL_SELECTOR = '[data-panel="project-proposal"]';

type ProposalMode = "registered" | "create";
type ResolvedProposalMode = ProposalMode | "provisional" | "invalid";
type ProjectRecord = {
	id: string;
	name: string;
	rootPath: string;
	provisional?: boolean;
};
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
	await expect.poll(() => page.evaluate((expectedSessionId) => {
		const state = (window as any).bobbitState;
		const remote = state?.remoteAgent;
		return state?.selectedSessionId === expectedSessionId
			&& state?.connectingSessionId === null
			&& state?.connectionStatus === "connected"
			&& remote?.gatewaySessionId === expectedSessionId
			&& typeof remote?.onProposal === "function"
			? expectedSessionId
			: null;
	}, sessionId), {
		timeout: 10_000,
		message: "selected session should finish proposal hydration before injecting project proposal",
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

function tempProjectRoot(label: string): string {
	return realpathSync(mkdtempSync(join(tmpdir(), `bobbit-project-accept-${label}-`)));
}

function samePath(left: string, right: string): boolean {
	const normalize = (value: string) => resolve(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	return normalize(left) === normalize(right);
}

async function listProjects(): Promise<ProjectRecord[]> {
	const resp = await apiFetch("/api/projects");
	const text = await resp.text();
	expect(resp.status, `list projects failed: ${text}`).toBe(200);
	const data = JSON.parse(text);
	return (Array.isArray(data) ? data : data.projects ?? []) as ProjectRecord[];
}

async function projectConfig(projectId: string): Promise<Record<string, unknown>> {
	const resp = await apiFetch(`/api/projects/${projectId}/config`);
	const text = await resp.text();
	expect(resp.status, `read config for ${projectId} failed: ${text}`).toBe(200);
	return JSON.parse(text) as Record<string, unknown>;
}

async function deleteProject(projectId: string | undefined): Promise<void> {
	if (projectId) await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
}

async function deleteProjectsAtRoot(rootPath: string): Promise<void> {
	const matches = await listProjects().catch(() => []);
	for (const project of matches) {
		if (samePath(project.rootPath, rootPath)) await deleteProject(project.id);
	}
}

async function expectProjectConfigValue(projectId: string, key: string, value: unknown): Promise<void> {
	await expect.poll(async () => (await projectConfig(projectId))[key], {
		timeout: 15_000,
		message: `accepted config should persist ${key}`,
	}).toEqual(value);
}

async function seedAndHydrateProjectProposal(
	page: Page,
	sessionId: string,
	fields: Record<string, unknown>,
	expectedMode: ResolvedProposalMode,
): Promise<ReturnType<Page["locator"]>> {
	const resp = await apiFetch(`/api/sessions/${sessionId}/proposal/project/seed`, {
		method: "POST",
		body: JSON.stringify({ args: fields }),
	});
	const text = await resp.text();
	expect(resp.status, `seed project proposal failed: ${text}`).toBe(200);
	const rev = (JSON.parse(text) as { rev?: number }).rev;
	expect(typeof rev, `seed response should carry a revision: ${text}`).toBe("number");

	await expect.poll(() => page.evaluate(({ sessionId, rev }) => {
		const slot = (window as any).bobbitState?.activeProposals?.project;
		return slot?.sessionId === sessionId && slot?.rev === rev ? slot.mode : null;
	}, { sessionId, rev }), {
		timeout: 15_000,
		message: `server-seeded project proposal should hydrate in ${expectedMode} mode`,
	}).toBe(expectedMode);

	const panel = page.locator(`${PANEL_SELECTOR}[data-mode="${expectedMode}"]`).first();
	if (!await panel.isVisible().catch(() => false)) {
		const pill = page.locator('.goal-tab-pill[title="Project Proposal"], .goal-tab-pill[title="Project"]').first();
		await expect(pill, "server-seeded Project Proposal tab should be available").toBeVisible({ timeout: 10_000 });
		await pill.click();
	}
	await expect(panel, `server-seeded ${expectedMode} project proposal panel should render`).toBeVisible({ timeout: 10_000 });
	return panel;
}

function captureProjectMutations(page: Page): string[] {
	const mutations: string[] = [];
	page.on("request", (request) => {
		if (!["POST", "PUT", "DELETE"].includes(request.method())) return;
		const url = new URL(request.url());
		if (url.pathname.startsWith("/api/projects")) mutations.push(`${request.method()} ${url.pathname}`);
	});
	return mutations;
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
			const isProvisionalSource = mode === "create";
			if (session) {
				session.projectId = projectId;
				session.assistantType = isProvisionalSource ? "project" : null;
			} else {
				state.gatewaySessions = [
					...(Array.isArray(state.gatewaySessions) ? state.gatewaySessions : []),
					{ id: sessionId, projectId, assistantType: isProvisionalSource ? "project" : null, status: "idle" },
				];
			}

			const projects = Array.isArray(state.projects) ? state.projects : [];
			const existing = projects.find((p: any) => p.id === projectId);
			if (existing) {
				existing.name = projectName;
				existing.rootPath = rootPath;
				existing.provisional = isProvisionalSource;
			} else {
				projects.push({ id: projectId, name: projectName, rootPath, provisional: isProvisionalSource });
				state.projects = projects;
			}

			state.activeProposals.project = {
				sessionId,
				// Source provenance is separate from semantic intent. Registered edit
				// fixtures carry an explicit fields.projectId; provisional fixtures are
				// create intent and rely on current sourceProjectId + assistant metadata
				// to exercise promotion in place.
				sourceProjectId: projectId,
				fields: {
					name: projectName,
					...(mode === "registered" ? { projectId } : {}),
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
	rootPath: string;
	panel: ReturnType<Page["locator"]>;
	button: ReturnType<Page["locator"]>;
}> {
	const rootPath = tempProjectRoot("provisional-config-failure");
	let sessionId: string | undefined;
	let projectId: string | undefined;
	try {
		writeFileSync(join(rootPath, "package.json"), JSON.stringify({ name: "provisional-config-failure" }));
		const createResp = await rawApiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ assistantType: "project", cwd: rootPath }),
		});
		const createText = await createResp.text();
		expect(createResp.status, createText).toBe(201);
		const createdSession = JSON.parse(createText) as { id: string; provisionalProjectId?: string };
		sessionId = createdSession.id;
		projectId = createdSession.provisionalProjectId;
		expect(projectId, "project assistant should own an isolated provisional project").toBeTruthy();

		await waitForSessionStatus(sessionId, "idle");
		await openApp(page);
		await openSession(page, sessionId);
		const panel = await seedAndHydrateProjectProposal(page, sessionId, {
			name: "Provisional Accept Repro",
			root_path: rootPath,
			test_command: "echo provisional-config-failure",
		}, "create");
		const button = panel.locator('[data-testid="proposal-primary-submit"] button').first();
		await expect(panel.locator('[data-testid="accept-label"]')).toContainText("Accept Project", { timeout: 10_000 });
		await expect(button).toBeEnabled({ timeout: 10_000 });
		return { sessionId, projectId: projectId!, rootPath, panel, button };
	} catch (err) {
		if (sessionId) await deleteSession(sessionId);
		await deleteProject(projectId);
		rmSync(rootPath, { recursive: true, force: true });
		throw err;
	}
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

test.describe("Journey: real project proposal acceptance", () => {
	test("registered-project session seeds and accepts a distinct new project without changing its source", async ({ page }) => {
		test.setTimeout(90_000);
		const source = await defaultProject();
		const sourceBefore = (await listProjects()).find((project) => project.id === source.id)!;
		const sourceConfigBefore = await projectConfig(source.id);
		const sessionId = await createSession({ projectId: source.id });
		const rootPath = tempProjectRoot("registered-create");
		const name = `Accepted New Project ${Date.now()}`;
		let createdProjectId: string | undefined;

		try {
			await waitForSessionStatus(sessionId, "idle");
			await openApp(page);
			await openSession(page, sessionId);
			const mutations = captureProjectMutations(page);
			const panel = await seedAndHydrateProjectProposal(page, sessionId, {
				name,
				root_path: rootPath,
				test_command: "echo accepted-new-project",
			}, "create");
			await expect(panel.locator('[data-testid="accept-label"]')).toContainText("Accept Project");
			const button = panel.locator('[data-testid="proposal-primary-submit"] button').first();
			await expect(button).toBeEnabled({ timeout: 10_000 });
			await button.click();

			let created: ProjectRecord | undefined;
			await expect.poll(async () => {
				created = (await listProjects()).find((project) => samePath(project.rootPath, rootPath));
				return created?.id;
			}, {
				timeout: 20_000,
				message: "accepting an absent-projectId draft should register its new root",
			}).toBeTruthy();
			createdProjectId = created!.id;
			expect(createdProjectId).not.toBe(source.id);
			expect(created!.name).toBe(name);
			await expectProjectConfigValue(createdProjectId, "test_command", "echo accepted-new-project");

			const sourceAfter = (await listProjects()).find((project) => project.id === source.id)!;
			expect(sourceAfter).toMatchObject({
				id: sourceBefore.id,
				name: sourceBefore.name,
				rootPath: sourceBefore.rootPath,
			});
			expect(await projectConfig(source.id)).toEqual(sourceConfigBefore);
			expect(mutations).toContain("POST /api/projects");
			expect(mutations).toContain(`PUT /api/projects/${createdProjectId}/config`);
			expect(mutations.some((entry) => entry.includes(`/api/projects/${source.id}`))).toBe(false);
			await expect.poll(() => page.evaluate((id) => (window as any).bobbitState?.projects?.some((project: any) => project.id === id), createdProjectId), {
				timeout: 10_000,
				message: "accepted project should appear after the sidebar project refresh",
			}).toBe(true);
			await expect(page.locator(PANEL_SELECTOR)).toHaveCount(0, { timeout: 10_000 });
		} finally {
			await deleteProjectsAtRoot(rootPath);
			await deleteSession(sessionId);
			rmSync(rootPath, { recursive: true, force: true });
		}
	});

	test("Headquarters session accepts a distinct new project without a Headquarters mutation", async ({ page }) => {
		test.setTimeout(90_000);
		const sessionId = await createSession({ projectId: "headquarters" });
		const rootPath = tempProjectRoot("headquarters-create");
		const name = `HQ Accepted Project ${Date.now()}`;
		let createdProjectId: string | undefined;

		try {
			await waitForSessionStatus(sessionId, "idle");
			await openApp(page);
			await openSession(page, sessionId);
			const mutations = captureProjectMutations(page);
			const panel = await seedAndHydrateProjectProposal(page, sessionId, {
				name,
				root_path: rootPath,
				test_command: "echo headquarters-create",
			}, "create");
			const button = panel.locator('[data-testid="proposal-primary-submit"] button').first();
			await expect(button).toBeEnabled({ timeout: 10_000 });
			await button.click();

			let created: ProjectRecord | undefined;
			await expect.poll(async () => {
				created = (await listProjects()).find((project) => samePath(project.rootPath, rootPath));
				return created?.id;
			}, {
				timeout: 20_000,
				message: "Headquarters proposal should register a distinct project",
			}).toBeTruthy();
			createdProjectId = created!.id;
			expect(createdProjectId).not.toBe("headquarters");
			await expectProjectConfigValue(createdProjectId, "test_command", "echo headquarters-create");
			expect(mutations).toContain("POST /api/projects");
			expect(
				mutations.some((entry) => (entry.startsWith("POST ") || entry.startsWith("PUT ")) && entry.includes("/api/projects/headquarters")),
				"an absent projectId must never rename, configure, or promote Headquarters",
			).toBe(false);
			await expect.poll(() => page.evaluate((id) => (window as any).bobbitState?.projects?.some((project: any) => project.id === id), createdProjectId), {
				timeout: 10_000,
				message: "Headquarters-created project should appear after sidebar refresh",
			}).toBe(true);
			const sessionResp = await apiFetch(`/api/sessions/${sessionId}`);
			expect(sessionResp.status, "ordinary Headquarters source session should remain alive after accept").toBe(200);
		} finally {
			await deleteProjectsAtRoot(rootPath);
			await deleteSession(sessionId);
			rmSync(rootPath, { recursive: true, force: true });
		}
	});

	test("explicit registered projectId accepts through edit mode only", async ({ page }) => {
		test.setTimeout(90_000);
		const source = await defaultProject();
		const sourceBefore = (await listProjects()).find((project) => project.id === source.id)!;
		const sourceConfigBefore = await projectConfig(source.id);
		const targetRoot = tempProjectRoot("explicit-edit");
		const registerResp = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "Explicit Edit Before", rootPath: targetRoot, __e2e_seed_skip__: true }),
		});
		expect(registerResp.status, await registerResp.clone().text()).toBe(201);
		const target = await registerResp.json() as ProjectRecord;
		const sessionId = await createSession({ projectId: source.id });
		const renamed = `Explicit Edit After ${Date.now()}`;

		try {
			await waitForSessionStatus(sessionId, "idle");
			await openApp(page);
			await openSession(page, sessionId);
			const mutations = captureProjectMutations(page);
			const panel = await seedAndHydrateProjectProposal(page, sessionId, {
				name: renamed,
				projectId: target.id,
				test_command: "echo explicit-edit",
			}, "registered");
			await expect(panel.locator('[data-testid="accept-label"]')).toContainText("Apply Changes");
			await panel.locator('[data-testid="proposal-primary-submit"] button').first().click();

			await expect.poll(async () => (await listProjects()).find((project) => project.id === target.id)?.name, {
				timeout: 15_000,
				message: "explicit target should be renamed by edit acceptance",
			}).toBe(renamed);
			await expectProjectConfigValue(target.id, "test_command", "echo explicit-edit");
			expect(mutations).toContain(`PUT /api/projects/${target.id}`);
			expect(mutations).toContain(`PUT /api/projects/${target.id}/config`);
			expect(mutations).not.toContain("POST /api/projects");
			expect((await listProjects()).find((project) => project.id === source.id)).toMatchObject(sourceBefore);
			expect(await projectConfig(source.id)).toEqual(sourceConfigBefore);
		} finally {
			await deleteSession(sessionId);
			await deleteProject(target.id);
			rmSync(targetRoot, { recursive: true, force: true });
		}
	});

	test("explicit unknown projectId rejects with UNKNOWN_PROJECT and retains the draft", async ({ page }) => {
		test.setTimeout(60_000);
		const source = await defaultProject();
		const sessionId = await createSession({ projectId: source.id });
		const rootPath = tempProjectRoot("unknown-target");
		const unknownId = `unknown-project-${Date.now()}`;

		try {
			await waitForSessionStatus(sessionId, "idle");
			await openApp(page);
			await openSession(page, sessionId);
			const mutations = captureProjectMutations(page);
			const panel = await seedAndHydrateProjectProposal(page, sessionId, {
				name: "Unknown Explicit Target",
				root_path: rootPath,
				projectId: unknownId,
			}, "invalid");
			const button = panel.locator('[data-testid="proposal-primary-submit"] button').first();
			await expect(button).toBeEnabled({ timeout: 10_000 });
			await button.click();

			await expect(page.getByText(/UNKNOWN_PROJECT|Unknown project/i).first()).toBeVisible({ timeout: 10_000 });
			await expect(panel, "unknown-target proposal should stay open after rejection").toBeVisible();
			await expect.poll(() => page.evaluate((id) => {
				const proposal = (window as any).bobbitState?.activeProposals?.project;
				return proposal?.fields?.projectId === id;
			}, unknownId), {
				timeout: 5_000,
				message: "UNKNOWN_PROJECT rejection must retain the original proposal draft",
			}).toBe(true);
			expect(mutations, "unknown projectId must issue no project mutation").toEqual([]);
		} finally {
			await deleteSession(sessionId);
			rmSync(rootPath, { recursive: true, force: true });
		}
	});

	test("provisional project-assistant create promotes in place and cleans up its session", async ({ page }) => {
		test.setTimeout(90_000);
		const rootPath = tempProjectRoot("provisional-promote");
		writeFileSync(join(rootPath, "package.json"), JSON.stringify({ name: "provisional-accept" }));
		const createResp = await rawApiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ assistantType: "project", cwd: rootPath }),
		});
		expect(createResp.status, await createResp.clone().text()).toBe(201);
		const createdSession = await createResp.json() as { id: string; provisionalProjectId?: string };
		const sessionId = createdSession.id;
		const provisionalProjectId = createdSession.provisionalProjectId;
		expect(provisionalProjectId, "project assistant should own a provisional project").toBeTruthy();

		try {
			await waitForSessionStatus(sessionId, "idle");
			await openApp(page);
			await openSession(page, sessionId);
			const mutations = captureProjectMutations(page);
			const panel = await seedAndHydrateProjectProposal(page, sessionId, {
				name: `Promoted Project ${Date.now()}`,
				root_path: rootPath,
				test_command: "echo promoted-config",
			}, "create");
			await panel.locator('[data-testid="proposal-primary-submit"] button').first().click();

			await expect.poll(async () => {
				const matches = (await listProjects()).filter((project) => samePath(project.rootPath, rootPath));
				return matches.length === 1 && matches[0].id === provisionalProjectId && matches[0].provisional !== true;
			}, {
				timeout: 20_000,
				message: "project assistant acceptance should promote exactly one project in place",
			}).toBe(true);
			await expectProjectConfigValue(provisionalProjectId!, "test_command", "echo promoted-config");
			expect(mutations).toContain(`POST /api/projects/${provisionalProjectId}/promote`);
			expect(mutations).toContain(`PUT /api/projects/${provisionalProjectId}/config`);
			expect(mutations).not.toContain("POST /api/projects");
			await expect.poll(async () => {
				const resp = await apiFetch("/api/sessions");
				const data = await resp.json();
				return !(data.sessions ?? data).some((session: { id: string }) => session.id === sessionId);
			}, {
				timeout: 15_000,
				message: "successful provisional acceptance should remove the assistant session",
			}).toBe(true);
			await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 }).toBe("#/");
			await expect.poll(() => page.evaluate((id) => (window as any).bobbitState?.projects?.some((project: any) => project.id === id && !project.provisional), provisionalProjectId), {
				timeout: 10_000,
				message: "promoted project should remain in the refreshed sidebar state",
			}).toBe(true);
		} finally {
			await deleteSession(sessionId);
			await deleteProject(provisionalProjectId);
			rmSync(rootPath, { recursive: true, force: true });
		}
	});
});

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
		const { sessionId, projectId, rootPath, button } = await setupProvisionalProposal(page);
		const routes = await routeProjectMutations(page, projectId, { promote: "ok", config: "abort" });

		try {
			await button.click();
			await expect.poll(routes.configAttempts, {
				timeout: 10_000,
				message: "provisional config write should be attempted after promote",
			}).toBe(1);

			await expect(
				page.getByText(/Config write failed|Failed to (write|save|apply).*config|Project proposal accept failed/i).first(),
				"PROJECT_PROPOSAL_ACCEPT_FAILURE_BUG: provisional config failure must show a clear connection error",
			).toBeVisible({ timeout: 10_000 });
			await expectProjectProposalStillActionable(page, "create");
		} finally {
			await deleteSession(sessionId);
			await deleteProject(projectId);
			rmSync(rootPath, { recursive: true, force: true });
		}
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
