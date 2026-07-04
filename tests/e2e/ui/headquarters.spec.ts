/**
 * Headquarters browser E2E coverage.
 *
 * These tests pin the user-facing UX contract from docs/design/headquarters-ux.md.
 * They are intentionally expected to fail on pre-Headquarters builds where the
 * harness "default" project is still the only startup workspace.
 */
import { test, expect, type GatewayInfo } from "../gateway-harness.js";
import type { Locator, Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiFetch, registerProject, deleteSession, deleteGoal } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

const HEADQUARTERS_PROJECT_ID = "headquarters";
const HEADQUARTERS_NAME = "Headquarters";

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
	].join(", ")).first();
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
	expect(project.rootPath, "Headquarters must expose the server run directory rootPath").toBeTruthy();
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

	test("fresh server shows Headquarters with TowerControl and Quick Session creates a Headquarters session", async ({ page }) => {
		await prepareOnlyHeadquarters();
		await openApp(page);

		const hqHeader = projectHeader(page, HEADQUARTERS_PROJECT_ID);
		await expect(hqHeader).toBeVisible({ timeout: 15_000 });
		await expect(hqHeader).toContainText(HEADQUARTERS_NAME);
		await expect(headquartersIcon(hqHeader), "Headquarters sidebar header should use Lucide TowerControl").toBeVisible({ timeout: 10_000 });
		await expect(page.getByText("No projects configured")).toHaveCount(0);
		await expect(page.getByRole("button", { name: /Add Project/i }).first()).toBeVisible();

		const { id } = await createHeadquartersSessionViaSplash(page);
		const sessionResp = await apiFetch(`/api/sessions/${id}`);
		expect(sessionResp.ok, "created Headquarters session should be readable").toBe(true);
		const session = await parseJsonResponse<any>(sessionResp);
		expect(session.projectId, "created session should persist projectId=headquarters").toBe(HEADQUARTERS_PROJECT_ID);
	});

	test("New Staff uses Headquarters directly when it is the only visible project", async ({ page }) => {
		await prepareOnlyHeadquarters();
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
	});

	test("Settings hide/show persists across reload and restart without deleting Headquarters work", async ({ page, gateway }) => {
		const hq = await prepareOnlyHeadquarters();
		await openApp(page);
		const { id: sessionId } = await createHeadquartersSessionViaSplash(page);

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
		await setHeadquartersCheckbox(page, true);
		await expect(projectHeader(page, HEADQUARTERS_PROJECT_ID), "showing Headquarters should restore the anchored sidebar section").toBeVisible({ timeout: 15_000 });

		// Keep TypeScript from flagging hq as only setup validation; rootPath is part of the persisted session contract.
		expect(hq.rootPath).toBeTruthy();
	});

	test("hidden Headquarters with no user projects offers fallback Quick Session, Show Headquarters, and Add Project", async ({ page }) => {
		await prepareOnlyHeadquarters();
		await setHeadquartersVisible(false);
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

	test("Settings and config scope UI label server scope as Headquarters without a duplicate System scope", async ({ page }) => {
		await prepareOnlyHeadquarters();
		await openApp(page);

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

	test("adding a normal project keeps Headquarters first with TowerControl and normal projects with folder identity", async ({ page }) => {
		await prepareOnlyHeadquarters();
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
		const picker = page.locator('[data-testid="splash-project-picker"]').first();
		await expect(picker).toBeVisible({ timeout: 10_000 });
		const rows = picker.locator('[data-testid="splash-project-picker-item"]');
		await expect(rows.first(), "Quick Session picker should list Headquarters first").toContainText(HEADQUARTERS_NAME);
		await expect(headquartersIcon(rows.first()), "Quick Session picker should use TowerControl for Headquarters").toBeVisible({ timeout: 10_000 });
		await expect(rows.nth(1)).toContainText(normalProject.name);
		await expect(normalProjectIcon(rows.nth(1)), "normal project picker rows should keep folder identity").toBeVisible({ timeout: 10_000 });
	});

	test("no-git Headquarters goals show approved UI gating instead of branch/merge/PR affordances", async ({ page }) => {
		const hq = await prepareOnlyHeadquarters();
		const goalResp = await createNoWorktreeHeadquartersGoal(hq);

		if (goalResp.status === 201) {
			const goal = await parseJsonResponse<GoalRecord>(goalResp);
			createdGoals.add(goal.id);
			await openApp(page);
			await navigateToHash(page, `#/goal/${goal.id}`);
			await expect(page.locator(".tab").first()).toBeVisible({ timeout: 15_000 });
			await expect(page.getByText("This Headquarters goal runs in the server directory without a git worktree.", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
			await expect(page.getByText("Git branch", { exact: false }).first()).toBeVisible();
			await expect(page.getByRole("button", { name: /create pr|open pr|ready to merge|merge|reset worktree|fork|branch/i })).toHaveCount(0);
			return;
		}

		const failureText = await goalResp.text().catch(() => "");
		expect(
			failureText,
			"If no-worktree Headquarters goals are blocked at creation time, the API/UI copy should be explicit",
		).toMatch(/Headquarters goals need git\/worktree support|Goal creation for Headquarters is unavailable|not a supported git repository/i);

		await openApp(page);
		const newGoal = page.locator("button[title^='New goal']").first();
		await expect(newGoal).toBeVisible({ timeout: 15_000 });
		await newGoal.click();
		await expect(page.getByText(/Headquarters goals need git support|Goal creation for Headquarters is unavailable|not a supported git repository/i)).toBeVisible({ timeout: 10_000 });
	});
});
