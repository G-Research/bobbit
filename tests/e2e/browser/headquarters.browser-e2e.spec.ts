/**
 * Headquarters browser E2E coverage.
 *
 * These tests pin the user-facing UX contract from docs/design/headquarters-ux.md.
 * They are intentionally expected to fail on pre-Headquarters builds where the
 * harness "default" project is still the only startup workspace.
 *
 * Coverage mapping (all boundaries remain real-browser + real-gateway E2E):
 * - same-root startup/scope selection + same-root hide/restart → same-root journey
 * - server-root preflight + fresh Quick Session + New Staff → Headquarters-only journey
 * - settings/config scope + hide/reload/restart + hidden fallback → Headquarters-only journey
 * - no-worktree goal UI → Headquarters-only journey
 * - added normal-project identity/picker ordering → Headquarters-only journey
 * No assertion moved to a cheaper tier; compatible states only share one page lifecycle.
 */
import { test, expect, type GatewayInfo } from "../gateway-harness.js";
import type { Locator, Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { apiFetch, registerProject, deleteSession, deleteGoal } from "../e2e-setup.js";
import { openApp, navigateToHash } from "../ui/ui-helpers.js";

const HEADQUARTERS_PROJECT_ID = "headquarters";
const HEADQUARTERS_NAME = "Headquarters";
const STARTUP_SAME_ROOT_PROJECT_ID = "same-root-startup-project";
const STARTUP_SAME_ROOT_PROJECT_NAME = "Same Root Startup Project";

test.use({ splitHeadquartersServerRoot: true, sameRootProjectAtStartup: true });

type ProjectRecord = {
	id: string;
	name: string;
	rootPath: string;
	kind?: string;
	hidden?: boolean;
};

type GoalRecord = { id: string; [key: string]: unknown };

const createdSessions = new Set<string>();
const createdGoals = new Set<string>();
const createdProjects = new Set<string>();
const createdDirs = new Set<string>();

function projectHeader(page: Page, projectId: string): Locator {
	return page.locator(`[data-testid="project-header"][data-project-id="${projectId}"]`).first();
}

function headquartersIcon(scope: Locator): Locator {
	return scope.locator([
		'[data-testid="headquarters-icon"]',
		'[data-project-icon="headquarters"]',
		'svg.lucide-tower-control',
		'svg[class*="lucide-tower-control"]',
		'[data-lucide="tower-control"]',
	].join(", ")).first();
}

function normalProjectIcon(scope: Locator): Locator {
	return scope.locator([
		'[data-testid="project-folder-icon"]',
		'[data-project-icon="normal"]',
		'svg.lucide-folder-open',
		'svg[class*="lucide-folder-open"]',
		'[data-lucide="folder-open"]',
		'svg.lucide-folder',
		'svg[class*="lucide-folder"]',
		'[data-lucide="folder"]',
	].join(", ")).first();
}

function canonicalPath(p: string): string {
	try { return realpathSync(p); } catch { return path.resolve(p); }
}

function samePath(a: string, b: string): boolean {
	const ra = canonicalPath(a);
	const rb = canonicalPath(b);
	return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

function expectSamePath(actual: string, expected: string, label: string): void {
	expect(samePath(actual, expected), `${label}: expected ${actual} to equal ${expected}`).toBe(true);
}

async function parseJsonResponse<T = any>(resp: Response): Promise<T> {
	const text = await resp.text();
	return text ? JSON.parse(text) as T : {} as T;
}

async function listVisibleProjects(): Promise<ProjectRecord[]> {
	const resp = await apiFetch("/api/projects");
	expect(resp.ok, `GET /api/projects failed: ${resp.status} ${await resp.clone().text().catch(() => "")}`).toBe(true);
	const body = await parseJsonResponse<any>(resp);
	const projects = Array.isArray(body) ? body : (body.projects ?? []);
	return projects as ProjectRecord[];
}

async function getHeadquartersProject(): Promise<ProjectRecord> {
	const resp = await apiFetch(`/api/projects/${HEADQUARTERS_PROJECT_ID}`);
	expect(
		resp.ok,
		`GET /api/projects/${HEADQUARTERS_PROJECT_ID} should resolve the built-in workspace: ${resp.status} ${await resp.clone().text().catch(() => "")}`,
	).toBe(true);
	const project = await parseJsonResponse<ProjectRecord>(resp);
	expect(project.id, "Headquarters must use the stable project id").toBe(HEADQUARTERS_PROJECT_ID);
	expect(project.name, "Headquarters must use the stable display name").toBe(HEADQUARTERS_NAME);
	expect(project.rootPath, "Headquarters must expose its isolated Headquarters directory rootPath").toBeTruthy();
	return project;
}

async function setHeadquartersVisible(visible: boolean): Promise<void> {
	const resp = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ showHeadquartersInProjectLists: visible }),
	});
	expect(resp.ok, `PUT /api/preferences showHeadquartersInProjectLists=${visible} failed`).toBe(true);
}

async function prepareOnlyHeadquarters(): Promise<ProjectRecord> {
	await setHeadquartersVisible(true);
	const hq = await getHeadquartersProject();
	for (const project of await listVisibleProjects()) {
		if (project.id === HEADQUARTERS_PROJECT_ID || project.kind === "headquarters") continue;
		await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" });
	}
	await expect.poll(async () => (await listVisibleProjects()).map((p) => p.id), {
		timeout: 10_000,
		message: "only Headquarters should remain visible after normal projects are removed",
	}).toEqual([HEADQUARTERS_PROJECT_ID]);
	return hq;
}

async function createHeadquartersSessionViaSplash(page: Page): Promise<{ id: string; requestBody: Record<string, unknown> }> {
	const cta = page.locator('[data-testid="splash-new-session-label"], [data-testid="splash-quick-session-label"]').first();
	await expect(cta, "fresh Headquarters splash should expose a Quick Session CTA").toBeVisible({ timeout: 15_000 });
	await expect(cta).toContainText("Quick Session");

	const sessionCreated = page.waitForResponse((resp) =>
		resp.url().includes("/api/sessions") && resp.request().method() === "POST",
		{ timeout: 30_000 },
	);
	await cta.click();
	const resp = await sessionCreated;
	expect(resp.ok(), `Quick Session POST /api/sessions should succeed: ${resp.status()}`).toBe(true);
	const requestBody = resp.request().postDataJSON?.() ?? JSON.parse(resp.request().postData() || "{}");
	expect(requestBody.projectId, "Quick Session should target Headquarters directly when it is the only visible project").toBe(HEADQUARTERS_PROJECT_ID);
	const body = await resp.json();
	expect(body.id, "Quick Session response should include a session id").toBeTruthy();
	createdSessions.add(body.id);

	await expect(page).toHaveURL(/#\/session\//, { timeout: 20_000 });
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
	return { id: body.id, requestBody };
}

async function openHeadquartersGeneralSettings(page: Page): Promise<Locator> {
	await navigateToHash(page, "#/settings/system/general");
	await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible({ timeout: 15_000 });
	const checkbox = page
		.getByLabel("Show Headquarters in project lists")
		.or(page.locator("label", { hasText: "Show Headquarters in project lists" }).locator('input[type="checkbox"]'))
		.first();
	await expect(checkbox, "Settings should expose the Headquarters visibility checkbox").toBeVisible({ timeout: 10_000 });
	return checkbox;
}

async function setHeadquartersCheckbox(page: Page, checked: boolean): Promise<void> {
	const checkbox = await openHeadquartersGeneralSettings(page);
	const prefSaved = page.waitForResponse((resp) =>
		resp.url().includes("/api/preferences") && resp.request().method() === "PUT",
		{ timeout: 10_000 },
	);
	await checkbox.setChecked(checked);
	const resp = await prefSaved;
	expect(resp.ok(), `Settings checkbox should persist showHeadquartersInProjectLists=${checked}`).toBe(true);
	await expect(checkbox).toBeChecked({ checked, timeout: 10_000 });
}

async function crashAndRestart(gateway: GatewayInfo, page: Page): Promise<void> {
	await gateway.crash();
	if (!page.isClosed()) {
		await page.waitForFunction(() => {
			const state = (window as any).bobbitState;
			return !!state && state.connectionStatus !== "connected";
		}, undefined, { timeout: 5_000 }).catch(() => {});
	}
	await gateway.restart();
	await expect.poll(async () => {
		try { return (await apiFetch("/api/health")).ok; } catch { return false; }
	}, { timeout: 20_000, intervals: [250], message: "gateway should be healthy after restart" }).toBe(true);
}

function uniqueProjectDir(label: string): string {
	const dir = mkdtempSync(join(tmpdir(), `bobbit-hq-${label}-`));
	mkdirSync(dir, { recursive: true });
	createdDirs.add(dir);
	return dir;
}

async function createNormalProject(name: string): Promise<ProjectRecord> {
	const project = await registerProject({ name, rootPath: uniqueProjectDir(name), seedWorkflows: false }) as ProjectRecord;
	createdProjects.add(project.id);
	return project;
}

async function startupSameRootProject(gateway: GatewayInfo): Promise<ProjectRecord> {
	await setHeadquartersVisible(true);
	for (const project of await listVisibleProjects()) {
		if (project.id === HEADQUARTERS_PROJECT_ID || samePath(project.rootPath, gateway.serverRoot)) continue;
		await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" });
	}
	const projects = await listVisibleProjects();
	const sameRoot = projects.find((project) => samePath(project.rootPath, gateway.serverRoot));
	expect(sameRoot, `expected startup same-root project at ${gateway.serverRoot}`).toBeTruthy();
	return sameRoot!;
}

async function createSessionViaSplashPicker(page: Page, projectName: string): Promise<{ id: string; requestBody: Record<string, unknown> }> {
	const splash = page.locator('[data-testid="splash-new-session-label"], [data-testid="splash-quick-session-label"]').first();
	await expect(splash).toBeVisible({ timeout: 15_000 });
	await expect(splash).toContainText("Quick Session");
	await splash.click();
	const picker = page.locator('[data-testid="splash-project-picker"]').first();
	await expect(picker).toBeVisible({ timeout: 10_000 });
	const row = picker.locator('[data-testid="splash-project-picker-item"]').filter({ hasText: projectName }).first();
	await expect(row, `project picker should contain ${projectName}`).toBeVisible({ timeout: 10_000 });
	const sessionCreated = page.waitForResponse((resp) =>
		resp.url().includes("/api/sessions") && resp.request().method() === "POST",
		{ timeout: 30_000 },
	);
	await row.click();
	const resp = await sessionCreated;
	expect(resp.ok(), `Quick Session POST /api/sessions should succeed: ${resp.status()}`).toBe(true);
	const requestBody = resp.request().postDataJSON?.() ?? JSON.parse(resp.request().postData() || "{}");
	const body = await resp.json();
	expect(body.id, "Quick Session response should include a session id").toBeTruthy();
	createdSessions.add(body.id);
	await expect(page).toHaveURL(/#\/session\//, { timeout: 20_000 });
	return { id: body.id, requestBody };
}

async function openAddProjectDialog(page: Page): Promise<void> {
	await openApp(page);
	await page.locator("button").filter({ hasText: "Add Project" }).first().click();
	await expect(page.locator('input[placeholder="/path/to/project"]')).toBeVisible({ timeout: 10_000 });
}

async function waitForPreflight(page: Page, timeoutMs = 10_000): Promise<Locator> {
	const panel = page.locator('[data-testid="preflight-panel"]').first();
	await expect(panel).toBeVisible({ timeout: timeoutMs });
	await expect.poll(async () => {
		const rows = await page.locator('[data-testid="preflight-check"]').count();
		const loading = await panel.getAttribute("data-loading");
		return rows > 0 || loading === null;
	}, { timeout: timeoutMs }).toBe(true);
	return panel;
}

async function createNoWorktreeHeadquartersGoal(hq: ProjectRecord): Promise<Response> {
	return apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: `HQ no-git goal ${Date.now()}`,
			spec: "Browser E2E no-git Headquarters goal coverage with enough detail for validation.",
			cwd: hq.rootPath,
			projectId: HEADQUARTERS_PROJECT_ID,
			worktree: false,
			autoStartTeam: false,
		}),
	});
}

async function cleanupCreatedArtifacts(): Promise<void> {
	for (const id of Array.from(createdGoals).reverse()) await deleteGoal(id).catch(() => {});
	createdGoals.clear();
	for (const id of Array.from(createdSessions).reverse()) await deleteSession(id).catch(() => {});
	createdSessions.clear();
	for (const id of Array.from(createdProjects).reverse()) await apiFetch(`/api/projects/${id}`, { method: "DELETE" }).catch(() => {});
	createdProjects.clear();
	for (const dir of Array.from(createdDirs).reverse()) rmSync(dir, { recursive: true, force: true });
	createdDirs.clear();
	await setHeadquartersVisible(true).catch(() => {});
}

test.describe("Headquarters browser UX", () => {
	test.describe.configure({ timeout: 120_000 });

	test.afterEach(async () => {
		await cleanupCreatedArtifacts();
	});

	test("same-root project stays distinct through scope selection, visibility changes, and restart", async ({ page, gateway }) => {
		let sameRootProject: ProjectRecord;

		await test.step("startup renders distinct Headquarters and same-root project identities", async () => {
			sameRootProject = await startupSameRootProject(gateway);
			expect(sameRootProject.id).toBe(STARTUP_SAME_ROOT_PROJECT_ID);
			expect(sameRootProject.name).toBe(STARTUP_SAME_ROOT_PROJECT_NAME);
			expectSamePath(sameRootProject.rootPath, gateway.serverRoot, "startup same-root normal project rootPath");
			const hq = await getHeadquartersProject();
			expectSamePath(hq.rootPath, gateway.bobbitDir, "BOBBIT_DIR Headquarters rootPath");

			await openApp(page);
			const hqHeader = projectHeader(page, HEADQUARTERS_PROJECT_ID);
			const sameRootHeader = projectHeader(page, sameRootProject.id);
			await expect(hqHeader).toBeVisible({ timeout: 15_000 });
			await expect(sameRootHeader).toBeVisible({ timeout: 15_000 });
			const headerIds = await page.locator('[data-testid="project-header"][data-project-id]').evaluateAll((els) =>
				els.map((el) => (el as HTMLElement).dataset.projectId).filter(Boolean),
			);
			expect(new Set(headerIds.slice(0, 2)), "both Headquarters and the same-root project appear at the top").toEqual(new Set([HEADQUARTERS_PROJECT_ID, sameRootProject.id]));
			expect(headerIds.indexOf(sameRootProject.id), "same-root project registered before Headquarters sorts ahead of it").toBeLessThan(headerIds.indexOf(HEADQUARTERS_PROJECT_ID));
			await expect(headquartersIcon(hqHeader), "Headquarters row should use TowerControl").toBeVisible({ timeout: 10_000 });
			await expect(normalProjectIcon(sameRootHeader), "same-root normal project should keep folder identity").toBeVisible({ timeout: 10_000 });
			await expect(headquartersIcon(sameRootHeader), "same-root normal project must not use TowerControl").toHaveCount(0);
		});

		await test.step("Quick Session picker targets each same-path scope explicitly", async () => {
			const splash = page.locator('[data-testid="splash-new-session-label"], [data-testid="splash-quick-session-label"]').first();
			await expect(splash).toBeVisible({ timeout: 10_000 });
			await splash.click();
			const picker = page.locator('[data-testid="splash-project-picker"]').first();
			await expect(picker).toBeVisible({ timeout: 10_000 });
			const rows = picker.locator('[data-testid="splash-project-picker-item"]');
			const hqRow = rows.filter({ hasText: HEADQUARTERS_NAME }).first();
			const sameRootRow = rows.filter({ hasText: sameRootProject.name }).first();
			await expect(hqRow, "picker should list Headquarters").toBeVisible({ timeout: 10_000 });
			await expect(headquartersIcon(hqRow), "picker should use TowerControl for Headquarters").toBeVisible({ timeout: 10_000 });
			await expect(sameRootRow, "picker should list the same-root normal project").toBeVisible({ timeout: 10_000 });
			await expect(normalProjectIcon(sameRootRow), "picker should use folder identity for same-root normal project").toBeVisible({ timeout: 10_000 });
			await page.keyboard.press("Escape");

			const hqSession = await createSessionViaSplashPicker(page, HEADQUARTERS_NAME);
			expect(hqSession.requestBody.projectId).toBe(HEADQUARTERS_PROJECT_ID);
			let sessionResp = await apiFetch(`/api/sessions/${hqSession.id}`);
			expect(sessionResp.ok).toBe(true);
			let session = await parseJsonResponse<any>(sessionResp);
			expect(session.projectId).toBe(HEADQUARTERS_PROJECT_ID);
			expectSamePath(session.cwd, gateway.bobbitDir, "Headquarters Quick Session cwd");
			try {
				await deleteSession(hqSession.id);
				createdSessions.delete(hqSession.id);
			} catch { /* afterEach retries tracked cleanup */ }

			await openApp(page);
			const normalSession = await createSessionViaSplashPicker(page, sameRootProject.name);
			expect(normalSession.requestBody.projectId).toBe(sameRootProject.id);
			sessionResp = await apiFetch(`/api/sessions/${normalSession.id}`);
			expect(sessionResp.ok).toBe(true);
			session = await parseJsonResponse<any>(sessionResp);
			expect(session.projectId).toBe(sameRootProject.id);
			expectSamePath(session.cwd, gateway.serverRoot, "same-root normal Quick Session cwd");
			try {
				await deleteSession(normalSession.id);
				createdSessions.delete(normalSession.id);
			} catch { /* afterEach retries tracked cleanup */ }
		});

		await test.step("hiding and restarting Headquarters preserves the same-root normal project", async () => {
			await setHeadquartersCheckbox(page, false);
			await expect(projectHeader(page, HEADQUARTERS_PROJECT_ID)).toHaveCount(0);
			await expect(projectHeader(page, sameRootProject.id), "hiding Headquarters must not hide the same-root normal project").toBeVisible({ timeout: 15_000 });

			await crashAndRestart(gateway, page);
			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(projectHeader(page, HEADQUARTERS_PROJECT_ID), "hidden preference should persist across restart").toHaveCount(0);
			await expect(projectHeader(page, sameRootProject.id), "same-root normal project should persist across restart").toBeVisible({ timeout: 15_000 });
			const projects = await listVisibleProjects();
			expect(projects.map((project) => project.id)).toContain(sameRootProject.id);
			expect(projects.map((project) => project.id)).not.toContain(HEADQUARTERS_PROJECT_ID);

			await setHeadquartersCheckbox(page, true);
			await expect(projectHeader(page, HEADQUARTERS_PROJECT_ID)).toBeVisible({ timeout: 15_000 });
			await expect(projectHeader(page, sameRootProject.id)).toBeVisible({ timeout: 15_000 });
		});
	});

	test("Headquarters-only browser lifecycle preserves every server-workspace affordance", async ({ page, gateway }) => {
		let hq: ProjectRecord;
		let sessionId = "";

		await test.step("server-root Add Project preflight cannot archive Headquarters", async () => {
			hq = await prepareOnlyHeadquarters();
			await openAddProjectDialog(page);
			const input = page.locator('input[placeholder="/path/to/project"]').first();
			await input.fill(gateway.serverRoot);
			const panel = await waitForPreflight(page);
			await expect(panel).toHaveAttribute("data-has-fail", "0");
			await expect(panel).toContainText(/Headquarters|server run directory/i);
			await expect(page.locator('[data-testid="preflight-archive-cta"]'), "same-root Add Project must not offer to archive/delete Headquarters state").toHaveCount(0);
			const continueButton = page.locator("button").filter({ hasText: "Continue" }).first();
			await expect(continueButton, "server run directory should be addable as an explicit normal project").toBeEnabled();
		});

		await test.step("fresh Headquarters renders its identity and creates a direct Quick Session", async () => {
			await openApp(page);
			const hqHeader = projectHeader(page, HEADQUARTERS_PROJECT_ID);
			await expect(hqHeader).toBeVisible({ timeout: 15_000 });
			await expect(hqHeader).toContainText(HEADQUARTERS_NAME);
			await expect(headquartersIcon(hqHeader), "Headquarters sidebar header should use Lucide TowerControl").toBeVisible({ timeout: 10_000 });
			await expect(page.getByText("No projects configured")).toHaveCount(0);
			await expect(page.getByRole("button", { name: /Add Project/i }).first()).toBeVisible();

			({ id: sessionId } = await createHeadquartersSessionViaSplash(page));
			const sessionResp = await apiFetch(`/api/sessions/${sessionId}`);
			expect(sessionResp.ok, "created Headquarters session should be readable").toBe(true);
			const session = await parseJsonResponse<any>(sessionResp);
			expect(session.projectId, "created session should persist projectId=headquarters").toBe(HEADQUARTERS_PROJECT_ID);
			expectSamePath(session.cwd, gateway.bobbitDir, "created Headquarters session cwd");
		});

		await test.step("New Staff targets Headquarters directly", async () => {
			await openApp(page);
			await expect(projectHeader(page, HEADQUARTERS_PROJECT_ID)).toBeVisible({ timeout: 15_000 });
			const sessionCreated = page.waitForResponse((resp) =>
				resp.url().includes("/api/sessions") && resp.request().method() === "POST",
				{ timeout: 30_000 },
			);
			const newStaffBtn = page.locator("button[title^='New staff agent']").first();
			await expect(newStaffBtn).toBeVisible({ timeout: 15_000 });
			await newStaffBtn.click();
			const resp = await sessionCreated;
			expect(resp.ok(), `New Staff assistant session should be created: ${resp.status()}`).toBe(true);
			const requestBody = resp.request().postDataJSON?.() ?? JSON.parse(resp.request().postData() || "{}");
			expect(requestBody.assistantType).toBe("staff");
			expect(requestBody.projectId, "staff assistant should target Headquarters without opening Add Project").toBe(HEADQUARTERS_PROJECT_ID);
			const body = await resp.json();
			if (body.id) createdSessions.add(body.id);
			await expect(page).toHaveURL(/#\/session\//, { timeout: 20_000 });
			await expect(page.locator('[data-panel="staff-proposal"]').first()).toBeVisible({ timeout: 20_000 });
			await expect(page.getByText("Sandbox (Docker)").first()).toBeVisible({ timeout: 20_000 });
			if (body.id) {
				try {
					await deleteSession(body.id);
					createdSessions.delete(body.id);
				} catch { /* afterEach retries tracked cleanup */ }
			}
		});

		await test.step("settings and config pages expose one Headquarters server scope", async () => {
			await navigateToHash(page, "#/settings/system/general");
			await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible({ timeout: 15_000 });
			const settingsHeadquartersScope = page.getByTestId("settings-headquarters-scope");
			await expect(settingsHeadquartersScope).toBeVisible({ timeout: 10_000 });
			await expect(settingsHeadquartersScope).toContainText(HEADQUARTERS_NAME);
			await expect(headquartersIcon(settingsHeadquartersScope), "Settings scope row should use TowerControl for Headquarters").toBeVisible({ timeout: 10_000 });
			await expect(page.getByRole("button", { name: "System", exact: true }), "Settings should not expose both System and Headquarters scopes").toHaveCount(0);

			await navigateToHash(page, "#/roles");
			await expect(page.getByRole("heading", { name: "Roles" })).toBeVisible({ timeout: 15_000 });
			await expect(page.getByRole("button", { name: HEADQUARTERS_NAME }).first()).toBeVisible({ timeout: 10_000 });
			await expect(page.getByRole("button", { name: "System", exact: true }), "Config pages should relabel the server scope as Headquarters").toHaveCount(0);
		});

		await test.step("no-worktree Headquarters goal omits git and merge affordances", async () => {
			const goalResp = await createNoWorktreeHeadquartersGoal(hq);
			if (goalResp.status === 201) {
				const goal = await parseJsonResponse<GoalRecord>(goalResp);
				createdGoals.add(goal.id);
				await openApp(page);
				await navigateToHash(page, `#/goal/${goal.id}`);
				await expect(page.locator(".tab").first()).toBeVisible({ timeout: 15_000 });
				await expect(page.getByText(/This Headquarters goal runs in the Headquarters directory without a git worktree\./i).first()).toBeVisible({ timeout: 15_000 });
				await expect(page.getByText("Git branch", { exact: false }).first()).toBeVisible();
				await expect(page.getByRole("button", { name: /create pr|open pr|ready to merge|merge|reset worktree|fork|branch/i })).toHaveCount(0);
				try {
					await deleteGoal(goal.id);
					createdGoals.delete(goal.id);
				} catch { /* afterEach retries tracked cleanup */ }
			} else {
				const failureText = await goalResp.text().catch(() => "");
				expect(failureText, "If no-worktree Headquarters goals are blocked at creation time, the API/UI copy should be explicit")
					.toMatch(/Headquarters goals need git\/worktree support|Goal creation for Headquarters is unavailable|not a supported git repository/i);
				await openApp(page);
				const newGoal = page.locator("button[title^='New goal']").first();
				await expect(newGoal).toBeVisible({ timeout: 15_000 });
				await newGoal.click();
				await expect(page.getByText(/Headquarters goals need git support|Goal creation for Headquarters is unavailable|not a supported git repository/i)).toBeVisible({ timeout: 10_000 });
			}
		});

		await test.step("hidden preference and existing work survive browser reload and gateway restart", async () => {
			await setHeadquartersCheckbox(page, false);
			await expect(projectHeader(page, HEADQUARTERS_PROJECT_ID), "hidden Headquarters should disappear from normal sidebar project lists").toHaveCount(0);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("textarea").first(), "active Headquarters session should remain reachable after hiding Headquarters").toBeVisible({ timeout: 20_000 });
			let sessionResp = await apiFetch(`/api/sessions/${sessionId}`);
			expect(sessionResp.ok, "hiding Headquarters must not delete active Headquarters sessions").toBe(true);
			expect((await parseJsonResponse<any>(sessionResp)).projectId).toBe(HEADQUARTERS_PROJECT_ID);

			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
			await expect(projectHeader(page, HEADQUARTERS_PROJECT_ID), "hidden preference should persist across browser reload").toHaveCount(0);
			await crashAndRestart(gateway, page);
			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
			await expect(projectHeader(page, HEADQUARTERS_PROJECT_ID), "hidden preference should persist across server restart").toHaveCount(0);
			sessionResp = await apiFetch(`/api/sessions/${sessionId}`);
			expect(sessionResp.ok, "Headquarters session should survive restart while Headquarters is hidden").toBe(true);
			const checkbox = await openHeadquartersGeneralSettings(page);
			await expect(checkbox, "visibility checkbox should reflect persisted hidden state").not.toBeChecked();
		});

		await test.step("hidden empty state offers Quick Session, Show Headquarters, and Add Project recovery", async () => {
			await expect.poll(async () => (await listVisibleProjects()).map((p) => p.id), {
				timeout: 10_000,
				message: "Headquarters hide preference should remove it only from normal project lists",
			}).toEqual([]);
			await openApp(page);
			await expect(page.getByText("Headquarters is hidden from project lists.").first()).toBeVisible({ timeout: 15_000 });
			await expect(page.getByRole("button", { name: "Quick Session in Headquarters" }).first()).toBeVisible();
			await expect(page.getByRole("button", { name: "Show Headquarters" }).first()).toBeVisible();
			await expect(page.getByRole("button", { name: /Add Project/i }).first()).toBeVisible();
			await expect(page.getByText("No projects configured")).toHaveCount(0);

			const shown = page.waitForResponse((resp) =>
				resp.url().includes("/api/preferences") && resp.request().method() === "PUT",
				{ timeout: 10_000 },
			);
			await page.getByRole("button", { name: "Show Headquarters" }).first().click();
			const resp = await shown;
			expect(resp.ok(), "Show Headquarters fallback action should persist the preference").toBe(true);
			await expect(projectHeader(page, HEADQUARTERS_PROJECT_ID)).toBeVisible({ timeout: 15_000 });
		});

		await test.step("adding a normal project preserves project identities and picker ordering", async () => {
			const normalProject = await createNormalProject(`HQ Sibling ${Date.now()}`);
			await openApp(page);
			await expect(projectHeader(page, HEADQUARTERS_PROJECT_ID)).toBeVisible({ timeout: 15_000 });
			await expect(projectHeader(page, normalProject.id)).toBeVisible({ timeout: 15_000 });
			const headerIds = await page.locator('[data-testid="project-header"][data-project-id]').evaluateAll((els) =>
				els.map((el) => (el as HTMLElement).dataset.projectId).filter(Boolean),
			);
			expect(headerIds[0], "Headquarters should be anchored first in the sidebar when normal projects exist").toBe(HEADQUARTERS_PROJECT_ID);
			await expect(headquartersIcon(projectHeader(page, HEADQUARTERS_PROJECT_ID))).toBeVisible({ timeout: 10_000 });
			await expect(normalProjectIcon(projectHeader(page, normalProject.id)), "normal projects should keep the usual folder/project identity").toBeVisible({ timeout: 10_000 });
			await expect(headquartersIcon(projectHeader(page, normalProject.id)), "normal project rows should not use TowerControl").toHaveCount(0);

			const splash = page.locator('[data-testid="splash-new-session-label"], [data-testid="splash-quick-session-label"]').first();
			await expect(splash).toBeVisible({ timeout: 10_000 });
			await splash.click();
			const rows = page.locator('[data-testid="splash-project-picker-item"]');
			await expect(rows.first(), "Quick Session picker should list Headquarters first").toContainText(HEADQUARTERS_NAME);
			await expect(headquartersIcon(rows.first()), "Quick Session picker should use TowerControl for Headquarters").toBeVisible({ timeout: 10_000 });
			await expect(rows.nth(1)).toContainText(normalProject.name);
			await expect(normalProjectIcon(rows.nth(1)), "normal project picker rows should keep folder identity").toBeVisible({ timeout: 10_000 });
		});
	});
});
