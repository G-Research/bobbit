/**
 * Browser E2E for sidebar tree local-state durability across gateway restart.
 */
import { test, expect, type GatewayInfo, type Page } from "../gateway-harness.js";
import { apiFetch, createGoal, createSession, defaultProjectId, deleteGoal, deleteSession } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

const TREE_STATE_KEY = "bobbit-sidebar-tree-state:v1";
const INDENT_KEY = "bobbit:sidebar-tree-indent";
const CUSTOM_INDENT_PX = 24;
const SPEC = "Sidebar restart durability fixture goal with enough detail for validation.";

const createdGoalIds: string[] = [];
const createdSessionIds: string[] = [];

type RestartFixture = {
	projectId: string;
	parentId: string;
	childId: string;
	sessionId: string;
};

function treeKey(kind: "project-sessions" | "goal", id: string): string {
	return `sidebar-tree/v1/${kind}/${encodeURIComponent(id)}`;
}

function sessionsHeader(page: Page, projectId: string) {
	return page.locator(`[data-nav-id="ungrouped-header:${projectId}"]`).first();
}

function sessionRow(page: Page, sessionId: string) {
	return page.locator(`[data-nav-id="session:${sessionId}"]`).first();
}

function goalRow(page: Page, goalId: string) {
	return page.locator(`[data-nav-id="goal:${goalId}"]`).first();
}

async function createChildGoal(projectId: string, parentGoalId: string, title: string): Promise<{ id: string; [k: string]: unknown }> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title,
			spec: SPEC,
			projectId,
			parentGoalId,
			team: false,
			worktree: false,
			autoStartTeam: false,
		}),
	});
	expect(resp.status, `create child goal ${title}: ${await resp.clone().text()}`).toBe(201);
	return resp.json();
}

async function createRestartFixture(): Promise<RestartFixture> {
	const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
	const projectId = await defaultProjectId();
	const prefs = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ subgoalsEnabled: true }),
	});
	expect(prefs.status, `enable subgoals: ${await prefs.clone().text()}`).toBe(200);

	const parent = await createGoal({
		title: `Restart parent ${stamp}`,
		projectId,
		team: false,
		worktree: false,
		subgoalsAllowed: true,
		maxNestingDepth: 3,
	});
	createdGoalIds.push(parent.id);

	const child = await createChildGoal(projectId, parent.id, `Restart child ${stamp}`);
	createdGoalIds.push(child.id);

	const sessionId = await createSession({ projectId });
	createdSessionIds.push(sessionId);

	return { projectId, parentId: parent.id, childId: child.id, sessionId };
}

async function seedCleanBrowserState(page: Page): Promise<void> {
	await page.addInitScript(({ treeStateKey, indentKey, indentPx }) => {
		if (!sessionStorage.getItem("bobbit-e2e-sidebar-restart-seeded")) {
			localStorage.removeItem(treeStateKey);
			localStorage.removeItem("bobbit-sidebar-collapsed");
			localStorage.removeItem("bobbit-expanded-projects");
			localStorage.removeItem("bobbit-expanded-goals");
			localStorage.removeItem("bobbit-collapsed-ungrouped");
			localStorage.removeItem("bobbit-collapsed-staff");
			localStorage.removeItem("bobbit-archived-collapsed-projects");
			localStorage.removeItem("gateway.sessionId");
			sessionStorage.setItem("bobbit-e2e-sidebar-restart-seeded", "1");
		}
		localStorage.setItem(indentKey, String(indentPx));
	}, { treeStateKey: TREE_STATE_KEY, indentKey: INDENT_KEY, indentPx: CUSTOM_INDENT_PX });
}

async function runtimeIndentPx(page: Page): Promise<number> {
	return page.evaluate(() => Number.parseFloat(
		getComputedStyle(document.documentElement).getPropertyValue("--sidebar-tree-nested-goal-indent").trim(),
	));
}

async function waitForRuntimeIndent(page: Page, expected: number): Promise<void> {
	await expect.poll(() => runtimeIndentPx(page), { timeout: 5_000 }).toBeCloseTo(expected, 0);
}

async function storedTreePreference(page: Page, canonicalKey: string): Promise<string | undefined> {
	return page.evaluate(({ storageKey, canonicalKey }) => {
		const raw = localStorage.getItem(storageKey);
		if (!raw) return undefined;
		return JSON.parse(raw).expansion?.[canonicalKey];
	}, { storageKey: TREE_STATE_KEY, canonicalKey });
}

async function storedIndent(page: Page): Promise<string | null> {
	return page.evaluate((key) => localStorage.getItem(key), INDENT_KEY);
}

async function waitForSidebarScaffold(page: Page, fixture: RestartFixture): Promise<void> {
	await expect(page.locator("[data-testid='sidebar-expanded']").first()).toBeVisible({ timeout: 20_000 });
	await expect(sessionsHeader(page, fixture.projectId)).toBeVisible({ timeout: 10_000 });
	await expect(goalRow(page, fixture.parentId)).toBeVisible({ timeout: 10_000 });
}

async function crashAndRestart(gateway: GatewayInfo, page: Page): Promise<void> {
	await gateway.crash();
	if (!page.isClosed()) {
		await page.waitForFunction(() => {
			const s = (window as any).bobbitState;
			return !!s && s.connectionStatus !== "connected";
		}, undefined, { timeout: 5_000 }).catch(() => { /* best-effort */ });
	}

	await gateway.restart();
	await expect.poll(async () => {
		try { return (await apiFetch("/api/health")).ok; } catch { return false; }
	}, { timeout: 20_000, intervals: [250], message: "gateway should be healthy after restart" }).toBe(true);

	if (!page.isClosed()) {
		await page.waitForFunction(() => {
			const s = (window as any).bobbitState;
			return !!s && s.connectionStatus === "connected";
		}, undefined, { timeout: 15_000, polling: 250 }).catch(() => { /* reload below also reconnects */ });
	}
}

test.describe("Sidebar tree restart durability", () => {
	test.afterEach(async () => {
		for (const id of [...createdSessionIds].reverse()) await deleteSession(id).catch(() => {});
		createdSessionIds.length = 0;
		for (const id of [...createdGoalIds].reverse()) await deleteGoal(id).catch(() => {});
		createdGoalIds.length = 0;
	});

	test("explicit tree expansion choices and indentation survive gateway restart plus reload", async ({ page, gateway }) => {
		test.setTimeout(90_000);
		const fixture = await createRestartFixture();
		const sessionsKey = treeKey("project-sessions", fixture.projectId);
		const parentGoalKey = treeKey("goal", fixture.parentId);

		await page.setViewportSize({ width: 1280, height: 900 });
		await seedCleanBrowserState(page);
		await openApp(page);
		await waitForSidebarScaffold(page, fixture);
		await expect(sessionRow(page, fixture.sessionId)).toBeVisible({ timeout: 10_000 });
		await waitForRuntimeIndent(page, CUSTOM_INDENT_PX);
		await expect(goalRow(page, fixture.childId), "child goal starts hidden because parent goals are default-collapsed").toBeHidden();

		await sessionsHeader(page, fixture.projectId).click();
		await expect(sessionRow(page, fixture.sessionId), "explicitly collapsed default-expanded Sessions section hides its session row").toBeHidden({ timeout: 5_000 });
		await goalRow(page, fixture.parentId).click();
		await expect(goalRow(page, fixture.childId), "explicitly expanded default-collapsed parent goal shows its child").toBeVisible({ timeout: 5_000 });

		expect(await storedTreePreference(page, sessionsKey)).toBe("collapsed");
		expect(await storedTreePreference(page, parentGoalKey)).toBe("expanded");
		expect(await storedIndent(page)).toBe(String(CUSTOM_INDENT_PX));

		await crashAndRestart(gateway, page);
		await page.reload({ waitUntil: "domcontentloaded" });
		await waitForSidebarScaffold(page, fixture);

		await expect(sessionRow(page, fixture.sessionId), "collapsed Sessions preference should survive restart/reload").toBeHidden({ timeout: 5_000 });
		await expect(goalRow(page, fixture.childId), "expanded parent goal preference should survive restart/reload").toBeVisible({ timeout: 5_000 });
		expect(await storedTreePreference(page, sessionsKey)).toBe("collapsed");
		expect(await storedTreePreference(page, parentGoalKey)).toBe("expanded");
		expect(await storedIndent(page)).toBe(String(CUSTOM_INDENT_PX));
		await waitForRuntimeIndent(page, CUSTOM_INDENT_PX);
	});
});
