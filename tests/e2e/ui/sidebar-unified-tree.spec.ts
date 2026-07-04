/**
 * Browser E2E for the unified sidebar tree's representative real-app nodes.
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, type Page, type GatewayInfo } from "../gateway-harness.js";
import {
	apiFetch,
	createGoal,
	createSession,
	deleteGoal,
	deleteSession,
	nonGitCwd,
	registerProject,
	startTeam,
	teardownTeam,
	waitForHealth,
	waitForSessionStatus,
} from "../e2e-setup.js";
import { navigateToHash, openApp } from "./ui-helpers.js";

const TREE_KEY_PREFIX = "sidebar-tree/v1";
const SPEC = "Unified sidebar tree browser E2E fixture, padded to satisfy goal spec validation.";

type ProjectFixture = { id: string; rootPath: string; [k: string]: unknown };

type UnifiedTreeFixture = {
	project: ProjectFixture;
	subgoalParentId: string;
	subgoalChildId: string;
	teamGoalId: string;
	teamLeadId: string;
	parentSessionId: string;
	firstClassChildId: string;
	liveDelegateId: string;
	archivedDelegateId: string;
	archivedStandaloneId: string;
	staffId: string;
	staffSessionId?: string | null;
};

function key(kind: string, id: string, query = ""): string {
	return `${TREE_KEY_PREFIX}/${kind}/${encodeURIComponent(id)}${query}`;
}

function treeKey(kind: string, id: string): string {
	return key(kind, id);
}

function sidebar(page: Page) {
	return page.locator("[data-testid='sidebar-expanded']").first();
}

function byTreeKey(page: Page, canonicalKey: string) {
	return sidebar(page).locator(`[data-tree-key="${canonicalKey}"]`).first();
}

function rowByNavId(page: Page, navId: string) {
	return sidebar(page).locator(`[data-nav-id="${navId}"]`).first();
}

function sessionRow(page: Page, sessionId: string) {
	return sidebar(page).locator(`[data-session-id="${sessionId}"]`).first();
}

function goalEntry(page: Page, goalId: string) {
	return sidebar(page).locator(`[data-goal-id="${goalId}"]`).first();
}

async function pressCtrlArrow(page: Page, key: "ArrowLeft" | "ArrowRight"): Promise<void> {
	await page.evaluate((k) => {
		window.dispatchEvent(new KeyboardEvent("keydown", {
			key: k,
			code: k,
			ctrlKey: true,
			metaKey: true,
			bubbles: true,
			cancelable: true,
		}));
	}, key);
}

async function createChildGoal(projectId: string, parentGoalId: string, title: string): Promise<string> {
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
	expect(resp.status, `create child goal failed: ${await resp.clone().text().catch(() => "")}`).toBe(201);
	return (await resp.json()).id as string;
}

async function createFirstClassChild(projectId: string, parentSessionId: string): Promise<string> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({
			projectId,
			cwd: nonGitCwd(),
			worktree: false,
			parentSessionId,
			childKind: "host-agents",
			readOnly: true,
		}),
	});
	expect(resp.status, `create first-class child failed: ${await resp.clone().text().catch(() => "")}`).toBe(201);
	return (await resp.json()).id as string;
}

async function createDelegate(parentSessionId: string, label: string): Promise<string> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({
			delegateOf: parentSessionId,
			instructions: `${label} delegate fixture`,
			cwd: nonGitCwd(),
		}),
	});
	expect(resp.status, `create delegate failed: ${await resp.clone().text().catch(() => "")}`).toBe(201);
	return (await resp.json()).id as string;
}

async function createStaff(project: ProjectFixture): Promise<{ id: string; currentSessionId?: string | null }> {
	const resp = await apiFetch("/api/staff", {
		method: "POST",
		body: JSON.stringify({
			name: `UnifiedTreeStaff${Date.now().toString(36)}`,
			description: "Unified sidebar tree staff section fixture.",
			systemPrompt: "Stay idle for unified sidebar tree section coverage.",
			cwd: project.rootPath,
			projectId: project.id,
			worktree: false,
			sandboxed: false,
		}),
	});
	expect(resp.status, `create staff failed: ${await resp.clone().text().catch(() => "")}`).toBe(201);
	return await resp.json() as { id: string; currentSessionId?: string | null };
}

async function waitForArchivedSession(sessionId: string): Promise<void> {
	await expect.poll(async () => {
		const resp = await apiFetch("/api/sessions?include=archived&limit=200");
		if (!resp.ok) return false;
		const body = await resp.json();
		const sessions = (body.sessions ?? []) as Array<{ id: string; archived?: boolean }>;
		const delegates = (body.archivedDelegates ?? []) as Array<{ id: string }>;
		return sessions.some((s) => s.id === sessionId && s.archived) || delegates.some((s) => s.id === sessionId);
	}, { timeout: 15_000 }).toBe(true);
}

async function createFixture(gateway: GatewayInfo): Promise<UnifiedTreeFixture> {
	await waitForHealth();
	const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
	const rootPath = join(tmpdir(), `bobbit-unified-tree-${stamp}`);
	mkdirSync(rootPath, { recursive: true });
	const project = await registerProject({ name: `unified-tree-${stamp}`, rootPath });

	const prefs = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ subgoalsEnabled: true }),
	});
	expect(prefs.status, `enable subgoals failed: ${await prefs.clone().text().catch(() => "")}`).toBe(200);

	const subgoalParent = await createGoal({
		title: `Unified subgoal parent ${stamp}`,
		projectId: project.id,
		team: false,
		worktree: false,
		autoStartTeam: false,
		subgoalsAllowed: true,
		maxNestingDepth: 3,
		spec: SPEC,
	});
	const subgoalChildId = await createChildGoal(project.id, subgoalParent.id as string, `Unified subgoal child ${stamp}`);

	const teamGoal = await createGoal({
		title: `Unified team goal ${stamp}`,
		projectId: project.id,
		team: true,
		worktree: false,
		autoStartTeam: false,
		spec: SPEC,
	});
	const teamLeadId = await startTeam(teamGoal.id as string);
	await waitForSessionStatus(teamLeadId, "idle");

	const parentSessionId = await createSession({ projectId: project.id });
	await waitForSessionStatus(parentSessionId, "idle");
	const firstClassChildId = await createFirstClassChild(project.id, parentSessionId);
	await waitForSessionStatus(firstClassChildId, "idle");
	const liveDelegateId = await createDelegate(parentSessionId, `live-${stamp}`);
	await waitForSessionStatus(liveDelegateId, "idle");
	const archivedDelegateId = await createDelegate(parentSessionId, `archived-${stamp}`);
	await waitForSessionStatus(archivedDelegateId, "idle");
	await deleteSession(archivedDelegateId);
	await waitForArchivedSession(archivedDelegateId);

	const archivedStandaloneId = await createSession({ projectId: project.id });
	await waitForSessionStatus(archivedStandaloneId, "idle");
	await deleteSession(archivedStandaloneId);
	await waitForArchivedSession(archivedStandaloneId);

	const staff = await createStaff(project);
	if (staff.currentSessionId) {
		await waitForSessionStatus(staff.currentSessionId, "idle").catch(() => {});
	}

	// The gateway object is referenced so the typed fixture import stays intentional;
	// session secrets are not needed for this browser-only tree coverage.
	expect(gateway.baseURL).toContain("http");

	return {
		project,
		subgoalParentId: subgoalParent.id as string,
		subgoalChildId,
		teamGoalId: teamGoal.id as string,
		teamLeadId,
		parentSessionId,
		firstClassChildId,
		liveDelegateId,
		archivedDelegateId,
		archivedStandaloneId,
		staffId: staff.id,
		staffSessionId: staff.currentSessionId,
	};
}

test.describe("Unified sidebar tree representative nodes", () => {
	test("renders canonical project, section, goal, team, child, delegate, and archived nodes with chevron keyboard toggles", async ({ page, gateway }) => {
		const fixture = await createFixture(gateway);
		const sessionIds = [
			fixture.staffSessionId,
			fixture.archivedStandaloneId,
			fixture.archivedDelegateId,
			fixture.liveDelegateId,
			fixture.firstClassChildId,
			fixture.parentSessionId,
			fixture.teamLeadId,
		].filter((id): id is string => !!id);

		try {
			await page.setViewportSize({ width: 1280, height: 900 });
			await page.addInitScript(() => {
				localStorage.removeItem("bobbit-sidebar-tree-state:v1");
				localStorage.removeItem("bobbit-expanded-projects");
				localStorage.removeItem("bobbit-expanded-goals");
				localStorage.removeItem("bobbit-collapsed-ungrouped");
				localStorage.removeItem("bobbit-collapsed-staff");
				localStorage.removeItem("bobbit-archived-collapsed-projects");
				localStorage.removeItem("bobbit-collapsed-team-leads");
				localStorage.removeItem("bobbit-collapsed-first-class-parents");
				localStorage.removeItem("bobbit-expanded-delegate-parents");
				localStorage.setItem("bobbit-show-archived", "true");
				localStorage.setItem("bobbit-show-busy", "true");
				localStorage.setItem("bobbit-show-read", "true");
			});
			await openApp(page);
			await expect(sidebar(page)).toBeVisible({ timeout: 20_000 });
			await expect.poll(() => page.evaluate(() => document.body.dataset.shortcutsReady === "1"), { timeout: 15_000 }).toBe(true);

			// Project and canonical project sections.
			await expect(rowByNavId(page, `project:${fixture.project.id}`)).toBeVisible({ timeout: 15_000 });
			await expect(byTreeKey(page, treeKey("project", fixture.project.id))).toBeVisible();
			await expect(rowByNavId(page, `ungrouped-header:${fixture.project.id}`)).toBeVisible();
			await expect(byTreeKey(page, treeKey("project-sessions", fixture.project.id))).toBeVisible();
			await expect(rowByNavId(page, `staff-header:${fixture.project.id}`)).toBeVisible();
			await expect(byTreeKey(page, treeKey("project-staff", fixture.project.id))).toBeVisible();
			await expect(rowByNavId(page, `archived-header:${fixture.project.id}`)).toBeVisible();
			await expect(byTreeKey(page, treeKey("project-archived", fixture.project.id))).toBeVisible();
			await expect(sessionRow(page, fixture.archivedStandaloneId)).toBeVisible();

			// Parent sub-goal node is visible, while its child sub-goal is collapsed by default.
			await expect(goalEntry(page, fixture.subgoalParentId)).toBeVisible({ timeout: 15_000 });
			await expect(byTreeKey(page, treeKey("goal", fixture.subgoalParentId))).toBeVisible();
			await expect(goalEntry(page, fixture.subgoalChildId)).toHaveCount(0);

			await rowByNavId(page, `goal:${fixture.subgoalParentId}`).click();
			await expect(goalEntry(page, fixture.subgoalChildId)).toBeVisible({ timeout: 10_000 });
			await expect(byTreeKey(page, treeKey("goal", fixture.subgoalChildId))).toBeVisible();

			// Team lead row under a team goal.
			await expect(goalEntry(page, fixture.teamGoalId)).toBeVisible({ timeout: 15_000 });
			if (!(await sessionRow(page, fixture.teamLeadId).isVisible().catch(() => false))) {
				await rowByNavId(page, `goal:${fixture.teamGoalId}`).click();
			}
			await expect(sessionRow(page, fixture.teamLeadId)).toBeVisible({ timeout: 10_000 });
			await expect(byTreeKey(page, treeKey("team-lead", fixture.teamLeadId))).toBeVisible();

			// First-class child session group and live delegate rows under a standalone parent session.
			const parentSessionRow = sessionRow(page, fixture.parentSessionId);
			await expect(parentSessionRow).toBeVisible({ timeout: 10_000 });
			await expect(parentSessionRow.locator(".sidebar-chevron-glyph")).toHaveText("▾");
			await expect(sessionRow(page, fixture.firstClassChildId)).toBeVisible();
			await expect(sessionRow(page, fixture.liveDelegateId)).toBeVisible();

			// Archived delegates are deterministically creatable; their group is collapsed until explicitly opened.
			const archivedGroup = sidebar(page)
				.locator(`[data-testid='sidebar-archived-delegate-group-toggle'][data-session-id="${fixture.parentSessionId}"]`)
				.first();
			await expect(archivedGroup).toBeVisible();
			await expect(archivedGroup).toHaveAttribute("data-expanded", "false");
			await expect(sessionRow(page, fixture.archivedDelegateId)).toHaveCount(0);
			await archivedGroup.click();
			await expect(archivedGroup).toHaveAttribute("data-expanded", "true");
			await expect(sessionRow(page, fixture.archivedDelegateId)).toBeVisible({ timeout: 10_000 });

			// Keyboard expand/collapse for chevron-bearing rows works for goal rows and session-backed rows.
			await navigateToHash(page, `#/goal/${fixture.subgoalParentId}`);
			await expect(rowByNavId(page, `goal:${fixture.subgoalParentId}`)).toHaveAttribute("data-nav-active", "true", { timeout: 10_000 });
			await pressCtrlArrow(page, "ArrowLeft");
			await expect(goalEntry(page, fixture.subgoalChildId)).toHaveCount(0);
			await pressCtrlArrow(page, "ArrowRight");
			await expect(goalEntry(page, fixture.subgoalChildId)).toBeVisible({ timeout: 10_000 });

			await navigateToHash(page, `#/session/${fixture.parentSessionId}`);
			await expect(rowByNavId(page, `session:${fixture.parentSessionId}`)).toHaveAttribute("data-nav-active", "true", { timeout: 10_000 });
			await pressCtrlArrow(page, "ArrowLeft");
			await expect(sessionRow(page, fixture.firstClassChildId)).toHaveCount(0);
			await expect(sessionRow(page, fixture.liveDelegateId)).toHaveCount(0);
			await pressCtrlArrow(page, "ArrowRight");
			await expect(sessionRow(page, fixture.firstClassChildId)).toBeVisible({ timeout: 10_000 });
			await expect(sessionRow(page, fixture.liveDelegateId)).toBeVisible();

			await navigateToHash(page, `#/session/${fixture.firstClassChildId}`);
			await expect(rowByNavId(page, `session:${fixture.firstClassChildId}`)).toHaveAttribute("data-nav-active", "true", { timeout: 10_000 });
			await pressCtrlArrow(page, "ArrowLeft");
			await expect(sessionRow(page, fixture.liveDelegateId)).toBeVisible();
		} finally {
			if (fixture.staffId) await apiFetch(`/api/staff/${fixture.staffId}`, { method: "DELETE" }).catch(() => {});
			await teardownTeam(fixture.teamGoalId).catch(() => {});
			for (const id of sessionIds) await deleteSession(id).catch(() => {});
			await deleteGoal(fixture.subgoalChildId).catch(() => {});
			await deleteGoal(fixture.subgoalParentId).catch(() => {});
			await deleteGoal(fixture.teamGoalId).catch(() => {});
			await apiFetch(`/api/projects/${fixture.project.id}`, { method: "DELETE" }).catch(() => {});
		}
	});
});
