/**
 * Browser E2E coverage for Project Drag Reorder.
 *
 * Expected command:
 *   npm run build && npx playwright test --config playwright-e2e.config.ts --project=browser tests/e2e/ui/project-drag-reorder.spec.ts
 */
import type { Locator, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createSession, deleteSession, registerProject, waitForHealth } from "../e2e-setup.js";
import { navigateToHash, openApp } from "./ui-helpers.js";

const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 375, height: 667 };

type ProjectFixture = {
	id: string;
	name: string;
	rootPath: string;
	sessionId: string;
	sessionTitle: string;
};

let createdProjects: ProjectFixture[] = [];
let projectCounter = 0;

function attr(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function projectHeader(page: Page, projectId: string): Locator {
	return page.locator(`[data-testid="project-header"][data-project-id="${attr(projectId)}"]`);
}

function projectHandle(page: Page, projectId: string): Locator {
	return page.locator(`[data-testid="project-reorder-handle"][data-project-id="${attr(projectId)}"]`);
}

function projectReorderRow(page: Page, projectId: string): Locator {
	return page.locator(`[data-project-reorder-id="${attr(projectId)}"]`);
}

function reorderMode(page: Page): Locator {
	return page.locator('[data-project-reordering="true"]');
}

function projectReorderLiveRegion(page: Page): Locator {
	return page.locator('[data-testid="project-reorder-live-region"][aria-live="polite"][aria-atomic="true"]');
}

function uniqueRootPath(label: string): string {
	const safe = label.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 24);
	const dir = join(tmpdir(), `bobbit-e2e-drag-${process.env.E2E_PORT || "p"}-${Date.now()}-${++projectCounter}-${safe}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function uniqueName(label: string): string {
	return `drag-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function createProjectFixture(label: string): Promise<ProjectFixture> {
	const name = uniqueName(label);
	const rootPath = uniqueRootPath(name);
	const project = await registerProject({ name, rootPath, seedWorkflows: false });
	const sessionId = await createSession({ cwd: rootPath, projectId: project.id });
	const sessionTitle = `session-${name}`;
	const renameResp = await apiFetch(`/api/sessions/${sessionId}`, {
		method: "PATCH",
		body: JSON.stringify({ title: sessionTitle }),
	});
	expect(renameResp.status).toBe(200);
	const fixture: ProjectFixture = { id: project.id, name, rootPath, sessionId, sessionTitle };
	createdProjects.push(fixture);
	return fixture;
}

async function resetSidebarState(page: Page): Promise<void> {
	await page.evaluate(() => {
		try {
			localStorage.removeItem("bobbit-sidebar-collapsed");
			localStorage.removeItem("bobbit-expanded-projects");
			localStorage.removeItem("bobbit-collapsed-ungrouped");
			localStorage.removeItem("bobbit-collapsed-staff");
			localStorage.removeItem("bobbit-archived-collapsed-projects");
			localStorage.setItem("bobbit-show-archived", "false");
		} catch {}
	});
}

async function openDesktop(page: Page): Promise<void> {
	await page.setViewportSize(DESKTOP);
	await openApp(page);
	await resetSidebarState(page);
	await page.reload();
	await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
}

async function openMobile(page: Page): Promise<void> {
	await page.setViewportSize(MOBILE);
	await openApp(page);
	await resetSidebarState(page);
	await page.reload();
	await page.waitForSelector("input[data-search]", { timeout: 20_000 });
}

async function waitForProjects(page: Page, projects: ProjectFixture[]): Promise<void> {
	for (const project of projects) {
		await expect(projectHeader(page, project.id), `project header for ${project.name}`).toBeVisible({ timeout: 20_000 });
		await expect(projectReorderRow(page, project.id), `reorder row for ${project.name}`).toBeAttached({ timeout: 20_000 });
		await expect(projectHandle(page, project.id), `reorder handle for ${project.name}`).toBeAttached({ timeout: 20_000 });
	}
}

async function handleIsVisuallyShown(handle: Locator): Promise<boolean> {
	return handle.evaluate((el: HTMLElement) => {
		const style = getComputedStyle(el);
		const rect = el.getBoundingClientRect();
		return style.display !== "none"
			&& style.visibility !== "hidden"
			&& Number.parseFloat(style.opacity || "1") > 0.75
			&& rect.width > 0
			&& rect.height > 0;
	});
}

async function handleIsVisuallyHidden(handle: Locator): Promise<boolean> {
	return handle.evaluate((el: HTMLElement) => {
		const style = getComputedStyle(el);
		const rect = el.getBoundingClientRect();
		return style.display === "none"
			|| style.visibility === "hidden"
			|| Number.parseFloat(style.opacity || "1") < 0.2
			|| rect.width === 0
			|| rect.height === 0;
	});
}

async function expectHandleHidden(handle: Locator, message: string): Promise<void> {
	await expect.poll(() => handleIsVisuallyHidden(handle), { message, timeout: 5_000 }).toBe(true);
}

async function expectHandleShown(handle: Locator, message: string): Promise<void> {
	await expect.poll(() => handleIsVisuallyShown(handle), { message, timeout: 5_000 }).toBe(true);
}

async function renderedProjectOrder(page: Page, projectIds: string[]): Promise<string[]> {
	return page.locator("[data-project-reorder-id]").evaluateAll((els, ids) => {
		const wanted = new Set(ids as string[]);
		const seen = new Set<string>();
		const order: string[] = [];
		for (const el of els) {
			const id = el.getAttribute("data-project-reorder-id");
			if (!id || !wanted.has(id) || seen.has(id)) continue;
			seen.add(id);
			order.push(id);
		}
		return order;
	}, projectIds);
}

async function apiProjectOrder(projectIds: string[]): Promise<string[]> {
	const resp = await apiFetch("/api/projects");
	expect(resp.status).toBe(200);
	const body = await resp.json();
	const projects = Array.isArray(body) ? body : body.projects || [];
	const wanted = new Set(projectIds);
	return projects.map((p: { id?: string }) => p.id).filter((id: string | undefined): id is string => !!id && wanted.has(id));
}

async function expectRenderedOrder(page: Page, expected: ProjectFixture[]): Promise<void> {
	const expectedIds = expected.map(p => p.id);
	await expect.poll(() => renderedProjectOrder(page, expectedIds), {
		message: `rendered project order should be ${expected.map(p => p.name).join(" → ")}`,
		timeout: 10_000,
	}).toEqual(expectedIds);
}

async function expectPersistedOrder(expected: ProjectFixture[]): Promise<void> {
	const expectedIds = expected.map(p => p.id);
	await expect.poll(() => apiProjectOrder(expectedIds), {
		message: `persisted project order should be ${expected.map(p => p.name).join(" → ")}`,
		timeout: 10_000,
	}).toEqual(expectedIds);
}

async function expectNoProjectOrderFailureDialog(page: Page): Promise<void> {
	await expect(
		page.getByText("Failed to save project order", { exact: true }),
		"successful project drag reorder must not show the save-failure dialog",
	).toHaveCount(0);
}

async function expectSessionContentsVisible(page: Page, projects: ProjectFixture[]): Promise<void> {
	for (const project of projects) {
		await expect(page.getByText(project.sessionTitle, { exact: true }), `session content for ${project.name}`).toBeVisible({ timeout: 10_000 });
	}
}

async function expectSessionContentsCollapsed(page: Page, projects: ProjectFixture[]): Promise<void> {
	for (const project of projects) {
		await expect(page.getByText(project.sessionTitle, { exact: true }), `session content should collapse for ${project.name}`).toBeHidden({ timeout: 5_000 });
	}
}

async function expectHandleActionable(handle: Locator, message: string): Promise<void> {
	await expect.poll(async () => {
		try {
			await handle.hover({ trial: true, timeout: 500 });
			return true;
		} catch {
			return false;
		}
	}, { message, timeout: 5_000 }).toBe(true);
}

async function handleCenter(handle: Locator): Promise<{ x: number; y: number }> {
	await handle.scrollIntoViewIfNeeded();
	const box = await handle.boundingBox();
	if (!box) throw new Error("project reorder handle has no bounding box");
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function handleCenterIsHitTarget(handle: Locator): Promise<boolean> {
	return handle.evaluate((el: HTMLElement) => {
		const rect = el.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return false;
		const hit = el.ownerDocument.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
		return hit === el || (!!hit && el.contains(hit));
	});
}

async function expectHandleCenterHitTarget(handle: Locator, message: string): Promise<void> {
	await expect.poll(() => handleCenterIsHitTarget(handle), { message, timeout: 5_000 }).toBe(true);
}

async function startProjectDrag(page: Page, project: ProjectFixture): Promise<void> {
	await page.bringToFront();
	const header = projectHeader(page, project.id);
	const handle = projectHandle(page, project.id);
	await expect(header, `project header for ${project.name} should be visible before dragging`).toBeVisible({ timeout: 20_000 });
	await header.hover();
	await expectHandleShown(handle, `project reorder handle for ${project.name} should be shown before dragging`);
	await expectHandleActionable(handle, `project reorder handle for ${project.name} should receive pointer events before dragging`);
	await expectHandleCenterHitTarget(handle, `project reorder handle center for ${project.name} should be hittable before dragging`);
	const start = await handleCenter(handle);
	await page.mouse.move(start.x, start.y);
	await page.mouse.down({ button: "left" });
	for (const delta of [8, 16, 28, 44, 60]) {
		await page.mouse.move(start.x, start.y + delta, { steps: 8 });
		if ((await reorderMode(page).count()) > 0) break;
	}
	await expect.poll(async () => reorderMode(page).count(), {
		message: "dragging a handle should enter temporary project reorder mode",
		timeout: 10_000,
	}).toBeGreaterThan(0);
}

async function dropProjectOn(page: Page, target: ProjectFixture, placement: "before" | "after"): Promise<void> {
	await projectReorderRow(page, target.id).scrollIntoViewIfNeeded();
	const box = await projectReorderRow(page, target.id).boundingBox();
	if (!box) throw new Error(`target project ${target.name} has no bounding box`);
	const x = box.x + box.width / 2;
	const y = placement === "before"
		? box.y + Math.min(6, Math.max(2, box.height / 4))
		: box.y + box.height - Math.min(6, Math.max(2, box.height / 4));
	await page.mouse.move(x, y, { steps: 8 });
	await page.mouse.up();
	await expect(reorderMode(page), "drop should exit temporary project reorder mode").toHaveCount(0, { timeout: 10_000 });
}

async function cancelProjectDrag(page: Page): Promise<void> {
	await page.keyboard.press("Escape");
	await page.mouse.up().catch(() => {});
	await expect(reorderMode(page), "Escape should cancel project reorder mode").toHaveCount(0, { timeout: 10_000 });
}

async function collapsedSessionTitleOrder(page: Page, sessionTitles: string[]): Promise<string[]> {
	return page.locator('[data-testid="sidebar-collapsed"] button[title]').evaluateAll((els, titles) => {
		const wanted = new Set(titles as string[]);
		return els
			.map(el => el.getAttribute("title") || "")
			.filter(title => wanted.has(title));
	}, sessionTitles);
}

async function collapseDesktopSidebar(page: Page): Promise<void> {
	await page.evaluate(() => {
		try { localStorage.setItem("bobbit-sidebar-collapsed", "true"); } catch {}
	});
	await page.reload();
	await expect(page.locator('[data-testid="sidebar-collapsed"]')).toBeVisible({ timeout: 20_000 });
}

async function waitForRemoteAgentConnected(page: Page, sessionId: string): Promise<void> {
	await page.waitForFunction(
		(sid) => {
			const appState = (window as any).__bobbitState ?? (window as any).bobbitState;
			return appState?.selectedSessionId === sid
				&& appState?.remoteAgent?.connected === true
				&& appState?.connectionStatus === "connected";
		},
		sessionId,
		{ timeout: 20_000 },
	);
}

async function blockProjectListFetches(page: Page): Promise<void> {
	await page.route("**/api/projects", async (route) => {
		if (route.request().method() === "GET") {
			await route.abort();
			return;
		}
		await route.continue();
	});
}

test.describe("Project drag reorder (browser E2E)", () => {
	test.beforeEach(async () => {
		createdProjects = [];
		await waitForHealth();
	});

	test.afterEach(async () => {
		for (const project of [...createdProjects].reverse()) {
			await deleteSession(project.sessionId).catch(() => {});
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
		}
		createdProjects = [];
	});

	test("desktop affordances, pointer reorder persistence, live sync, cancel, and collapsed sidebar order", async ({ page }) => {
		test.setTimeout(120_000);
		const alpha = await createProjectFixture("desktop-alpha");
		const beta = await createProjectFixture("desktop-beta");
		const gamma = await createProjectFixture("desktop-gamma");

		await openDesktop(page);
		await waitForProjects(page, [alpha, beta, gamma]);
		await expectRenderedOrder(page, [alpha, beta, gamma]);
		await expectSessionContentsVisible(page, [alpha, beta, gamma]);

		const header = projectHeader(page, alpha.id);
		const handle = projectHandle(page, alpha.id);

		await page.mouse.move(900, 760);
		await expectHandleHidden(handle, "desktop reorder handle should be visually hidden before hover/focus");

		await header.hover();
		await expectHandleShown(handle, "desktop reorder handle should show when the project header is hovered");

		await page.mouse.move(900, 760);
		await expectHandleHidden(handle, "desktop reorder handle should hide again after hover leaves");

		await handle.focus();
		await expectHandleShown(handle, "desktop reorder handle should show when focused");
		await page.keyboard.press("Escape");

		await header.getByText(alpha.name, { exact: true }).click();
		await expect(page.getByText(alpha.sessionTitle, { exact: true }), "clicking the project header outside the handle should collapse the project").toBeHidden({ timeout: 5_000 });
		await expect(reorderMode(page), "header click should not start reorder mode").toHaveCount(0);

		await header.getByText(alpha.name, { exact: true }).click();
		await expect(page.getByText(alpha.sessionTitle, { exact: true }), "clicking the project header again should restore expansion").toBeVisible({ timeout: 5_000 });

		await header.hover();
		await header.locator('button[title="Project settings"]').click();
		await expect(reorderMode(page), "project settings click should not start reorder mode").toHaveCount(0);
		await expectRenderedOrder(page, [alpha, beta, gamma]);

		await header.locator('button[title^="New goal in"]').click();
		await expect(reorderMode(page), "project new-goal click should not start reorder mode").toHaveCount(0);
		await expectRenderedOrder(page, [alpha, beta, gamma]);
		await page.keyboard.press("Escape");

		const peer = await page.context().newPage();
		try {
			await openDesktop(peer);
			await waitForProjects(peer, [alpha, beta, gamma]);
			await expectRenderedOrder(peer, [alpha, beta, gamma]);
			await navigateToHash(peer, `#/session/${alpha.sessionId}`);
			await waitForRemoteAgentConnected(peer, alpha.sessionId);
			await expectRenderedOrder(peer, [alpha, beta, gamma]);

			// Prove the live update comes from the WebSocket broadcast, not the
			// fallback project polling path used when no session WebSocket exists.
			await blockProjectListFetches(peer);

			await startProjectDrag(page, gamma);
			await expectSessionContentsCollapsed(page, [alpha, beta, gamma]);
			await dropProjectOn(page, alpha, "before");

			await expectRenderedOrder(page, [gamma, alpha, beta]);
			await expectPersistedOrder([gamma, alpha, beta]);
			await expectNoProjectOrderFailureDialog(page);
			await expectRenderedOrder(peer, [gamma, alpha, beta]);
			await expectSessionContentsVisible(page, [alpha, beta, gamma]);
		} finally {
			await peer.close().catch(() => {});
		}

		await startProjectDrag(page, alpha);
		await expectSessionContentsCollapsed(page, [alpha, beta, gamma]);
		await cancelProjectDrag(page);
		await expectRenderedOrder(page, [gamma, alpha, beta]);
		await expectPersistedOrder([gamma, alpha, beta]);
		await expectSessionContentsVisible(page, [alpha, beta, gamma]);

		await page.reload();
		await waitForProjects(page, [alpha, beta, gamma]);
		await expectRenderedOrder(page, [gamma, alpha, beta]);
		await expectSessionContentsVisible(page, [alpha, beta, gamma]);

		await collapseDesktopSidebar(page);
		await expect(page.locator('[data-testid="project-reorder-handle"]'), "collapsed sidebar should not render project reorder handles").toHaveCount(0);
		const expectedTitles = [gamma.sessionTitle, alpha.sessionTitle, beta.sessionTitle];
		await expect.poll(() => collapsedSessionTitleOrder(page, expectedTitles), {
			message: "collapsed sidebar should render sessions grouped in persisted project order",
			timeout: 10_000,
		}).toEqual(expectedTitles);
	});

	test("mobile handle is always visible; pointer drag reorders with temporary collapse/restore and reload persistence", async ({ page }) => {
		test.setTimeout(120_000);
		const alpha = await createProjectFixture("mobile-alpha");
		const beta = await createProjectFixture("mobile-beta");
		const gamma = await createProjectFixture("mobile-gamma");

		await openMobile(page);
		await expect(projectReorderLiveRegion(page), "mobile reorder UI should render a polite live region").toBeAttached({ timeout: 20_000 });
		await waitForProjects(page, [alpha, beta, gamma]);
		await expectRenderedOrder(page, [alpha, beta, gamma]);
		await expectSessionContentsVisible(page, [alpha, beta, gamma]);

		for (const project of [alpha, beta, gamma]) {
			await expectHandleShown(projectHandle(page, project.id), `mobile reorder handle for ${project.name} should always be visible without hover`);
		}

		await startProjectDrag(page, gamma);
		await expectSessionContentsCollapsed(page, [alpha, beta, gamma]);
		await dropProjectOn(page, alpha, "before");

		await expectRenderedOrder(page, [gamma, alpha, beta]);
		await expectPersistedOrder([gamma, alpha, beta]);
		await expectNoProjectOrderFailureDialog(page);
		await expectSessionContentsVisible(page, [alpha, beta, gamma]);

		await page.reload();
		await page.waitForSelector("input[data-search]", { timeout: 20_000 });
		await waitForProjects(page, [alpha, beta, gamma]);
		await expectRenderedOrder(page, [gamma, alpha, beta]);
		await expectSessionContentsVisible(page, [alpha, beta, gamma]);
	});
});
