/**
 * v2 browser (geometry) — parity port of tests/e2e/ui/sidebar-reveal.spec.ts.
 * Kept in Chromium under tests2/browser/fixtures/ because it exercises
 * getBoundingClientRect / scrollIntoView / scrollTop geometry against a real
 * gateway. Import paths resolve through the tests2/browser/*.ts shims verbatim.
 *
 * Browser E2E for "Sidebar Reveal On Nav".
 *
 * On navigation to a session / goal route — both initial deep-links and in-app
 * hash changes — the sidebar must (1) expand the collapsed ancestor tree so the
 * target row renders, and (2) scroll the row into view with
 * `scrollIntoView({ block: "nearest" })`. Expansion is ephemeral: it never
 * overwrites an explicit user collapse.
 */
import { test, expect, type Page } from "../gateway-harness.js";
import {
	apiFetch,
	base,
	createGoal,
	createSession,
	defaultProject,
	defaultProjectId,
	deleteGoal,
	deleteSession,
	readE2ETokenAsync,
	startTeam,
	teardownTeam,
	waitForHealth,
	waitForSessionStatus,
} from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

const TREE_STATE_KEY = "bobbit-sidebar-tree-state:v1";
const SPEC = "Sidebar reveal-on-nav fixture goal with enough detail to satisfy validation.";
const FILLER_GOAL_COUNT = 16;

type Fixture = {
	projectId: string;
	parentGoalId: string;
	childGoalId: string;
	nestedSessionId: string;
	standaloneSessionId: string;
	fillerGoalIds: string[];
	teamGoalId: string;
	teamLeadSessionId: string;
	staffId: string;
	staffSessionId: string;
};

let fixture: Fixture;
const createdGoalIds: string[] = [];
const createdSessionIds: string[] = [];
const createdTeamGoalIds: string[] = [];
const createdStaffIds: string[] = [];

function treeKey(kind: "project-sessions" | "goal", id: string): string {
	return `sidebar-tree/v1/${kind}/${encodeURIComponent(id)}`;
}

async function createChildGoal(projectId: string, parentGoalId: string, title: string): Promise<string> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({ title, spec: SPEC, projectId, parentGoalId, team: false, worktree: false, autoStartTeam: false }),
	});
	expect(resp.status, `create child goal ${title}: ${await resp.clone().text()}`).toBe(201);
	return (await resp.json()).id as string;
}

/** Seed a clean browser state before boot; optionally pre-store explicit
 *  expansion preferences (canonicalKey → "expanded" | "collapsed"). */
async function seedBrowserState(page: Page, prefs: Record<string, "expanded" | "collapsed"> = {}): Promise<void> {
	await page.addInitScript(({ treeStateKey, expansion }: { treeStateKey: string; expansion: Record<string, "expanded" | "collapsed"> }) => {
		localStorage.removeItem("bobbit-sidebar-collapsed");
		localStorage.setItem("bobbit-show-archived", "false");
		if (Object.keys(expansion).length > 0) {
			localStorage.setItem(treeStateKey, JSON.stringify({ version: 1, expansion }));
		} else {
			localStorage.removeItem(treeStateKey);
		}
	}, { treeStateKey: TREE_STATE_KEY, expansion: prefs });
}

/** Open the app booting directly at a hash deep-link. */
async function openAppAtHash(page: Page, hash: string): Promise<void> {
	const token = await readE2ETokenAsync();
	await page.goto(`${base()}/?token=${encodeURIComponent(token)}${hash}`);
	await expect(page.locator(".sidebar-edge")).toBeVisible({ timeout: 20_000 });
}

function navRow(page: Page, navId: string) {
	return page.locator(`[data-nav-id="${navId}"]`).first();
}

async function storedPreference(page: Page, canonicalKey: string): Promise<string | undefined> {
	return page.evaluate(({ storageKey, canonicalKey }: { storageKey: string; canonicalKey: string }) => {
		const raw = localStorage.getItem(storageKey);
		if (!raw) return undefined;
		try { return JSON.parse(raw).expansion?.[canonicalKey]; } catch { return undefined; }
	}, { storageKey: TREE_STATE_KEY, canonicalKey });
}

type RowGeometry = {
	found: boolean;
	within: boolean;
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
	overflowing: boolean;
};

async function rowGeometry(page: Page, navId: string): Promise<RowGeometry> {
	return page.evaluate((navId: string) => {
		const sidebar = document.querySelector(".sidebar-edge");
		const container = sidebar?.querySelector<HTMLElement>("[data-project-reorder-list]");
		const empty = { found: false, within: false, scrollTop: -1, scrollHeight: -1, clientHeight: -1, overflowing: false };
		if (!sidebar || !container) return empty;
		let row: HTMLElement | null = null;
		for (const el of sidebar.querySelectorAll<HTMLElement>("[data-nav-id]")) {
			if (el.getAttribute("data-nav-id") === navId) { row = el; break; }
		}
		const meta = {
			scrollTop: container.scrollTop,
			scrollHeight: container.scrollHeight,
			clientHeight: container.clientHeight,
			overflowing: container.scrollHeight - container.clientHeight > 4,
		};
		if (!row) return { ...meta, found: false, within: false };
		const cr = container.getBoundingClientRect();
		const rr = row.getBoundingClientRect();
		const within = rr.top >= cr.top - 1 && rr.bottom <= cr.bottom + 1;
		return { ...meta, found: true, within };
	}, navId);
}

async function fullyVisibleNavIds(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const sidebar = document.querySelector(".sidebar-edge");
		const container = sidebar?.querySelector<HTMLElement>("[data-project-reorder-list]");
		if (!sidebar || !container) return [];
		const cr = container.getBoundingClientRect();
		const out: string[] = [];
		for (const el of sidebar.querySelectorAll<HTMLElement>("[data-nav-id]")) {
			const id = el.getAttribute("data-nav-id");
			if (!id) continue;
			const rr = el.getBoundingClientRect();
			if (rr.top >= cr.top && rr.bottom <= cr.bottom && rr.height > 0) out.push(id);
		}
		return out;
	});
}

async function setSidebarScrollTop(page: Page, value: number): Promise<void> {
	await page.evaluate((value: number) => {
		const c = document.querySelector<HTMLElement>(".sidebar-edge [data-project-reorder-list]");
		if (c) c.scrollTop = value;
	}, value);
}

async function inAppNavigate(page: Page, hash: string): Promise<void> {
	await page.evaluate((h: string) => { window.location.hash = h; }, hash);
}

test.describe("Sidebar reveal on nav", () => {
	test.beforeAll(async () => {
		await waitForHealth();
		const projectId = (await defaultProjectId())!;
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

		const prefs = await apiFetch("/api/preferences", { method: "PUT", body: JSON.stringify({ subgoalsEnabled: true }) });
		expect(prefs.status, `enable subgoals: ${await prefs.clone().text()}`).toBe(200);

		const parent = await createGoal({ title: `Reveal parent ${stamp}`, projectId, team: false, worktree: false, subgoalsAllowed: true, maxNestingDepth: 3 });
		createdGoalIds.push(parent.id);
		const childGoalId = await createChildGoal(projectId, parent.id, `Reveal child ${stamp}`);
		createdGoalIds.push(childGoalId);

		const nestedSessionId = await createSession({ projectId, goalId: childGoalId });
		const standaloneSessionId = await createSession({ projectId });
		createdSessionIds.push(nestedSessionId, standaloneSessionId);

		const fillerGoals = await Promise.all(
			Array.from({ length: FILLER_GOAL_COUNT }, (_, i) =>
				createGoal({ title: `Reveal filler ${i} ${stamp}`, projectId, team: false, worktree: false })),
		);
		const fillerGoalIds = fillerGoals.map(g => g.id);
		createdGoalIds.push(...fillerGoalIds);

		// Team goal → team-lead session. The team lead is represented in the tree
		// as a `team-lead/<id>` node (NOT a `session/<id>` node) but its DOM row
		// carries data-nav-id="session:<id>" — the exact shape the reveal bug misses.
		const teamGoal = await createGoal({ title: `Reveal team ${stamp}`, projectId, team: true, worktree: false });
		createdTeamGoalIds.push(teamGoal.id);
		const teamLeadSessionId = await startTeam(teamGoal.id);
		await waitForSessionStatus(teamLeadSessionId, "idle", 30_000);

		// Staff agent → permanent session. Staff sessions are excluded from the
		// tree entirely (rendered only under the project-staff section), so the
		// reveal must resolve them via the staff-row fallback.
		const project = await defaultProject();
		const staffResp = await apiFetch("/api/staff", {
			method: "POST",
			body: JSON.stringify({
				name: `Reveal staff ${stamp}`,
				description: "Sidebar reveal-on-nav staff fixture.",
				systemPrompt: "You are a sidebar reveal-on-nav staff fixture.",
				cwd: project.rootPath,
				projectId,
			}),
		});
		expect(staffResp.status, `create reveal staff: ${await staffResp.clone().text()}`).toBe(201);
		const staff = await staffResp.json();
		createdStaffIds.push(staff.id);
		const staffSessionId = staff.currentSessionId as string;
		expect(staffSessionId, "staff agent must have a permanent session id").toBeTruthy();

		fixture = {
			projectId, parentGoalId: parent.id, childGoalId, nestedSessionId, standaloneSessionId, fillerGoalIds,
			teamGoalId: teamGoal.id, teamLeadSessionId, staffId: staff.id, staffSessionId,
		};
	});

	test.afterAll(async () => {
		for (const id of [...createdStaffIds].reverse()) await apiFetch(`/api/staff/${id}`, { method: "DELETE" }).catch(() => {});
		createdStaffIds.length = 0;
		for (const id of [...createdTeamGoalIds].reverse()) await teardownTeam(id).catch(() => {});
		for (const id of [...createdSessionIds].reverse()) await deleteSession(id).catch(() => {});
		createdSessionIds.length = 0;
		for (const id of [...createdTeamGoalIds].reverse()) await deleteGoal(id).catch(() => {});
		createdTeamGoalIds.length = 0;
		for (const id of [...createdGoalIds].reverse()) await deleteGoal(id).catch(() => {});
		createdGoalIds.length = 0;
	});

	test("deep-link to a session nested in collapsed goals expands ancestors and scrolls the row into view", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 620 });
		await seedBrowserState(page);
		await openAppAtHash(page, `#/session/${fixture.nestedSessionId}`);

		// Ancestor goals default-collapsed → the reveal must expand them so the
		// nested session row renders and becomes the active row.
		await expect(navRow(page, `goal:${fixture.parentGoalId}`)).toBeVisible({ timeout: 15_000 });
		await expect(navRow(page, `goal:${fixture.childGoalId}`)).toBeVisible({ timeout: 10_000 });
		const sessionRow = navRow(page, `session:${fixture.nestedSessionId}`);
		await expect(sessionRow).toBeVisible({ timeout: 10_000 });
		await expect(sessionRow).toHaveAttribute("data-nav-active", "true", { timeout: 10_000 });

		await expect.poll(async () => (await rowGeometry(page, `session:${fixture.nestedSessionId}`)).within, { timeout: 10_000 })
			.toBe(true);
	});

	test("deep-link to a nested sub-goal expands the parent chain and shows the goal row", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 620 });
		await seedBrowserState(page);
		await openAppAtHash(page, `#/goal/${fixture.childGoalId}`);

		await expect(navRow(page, `goal:${fixture.parentGoalId}`)).toBeVisible({ timeout: 15_000 });
		const childRow = navRow(page, `goal:${fixture.childGoalId}`);
		await expect(childRow).toBeVisible({ timeout: 10_000 });
		await expect.poll(async () => (await rowGeometry(page, `goal:${fixture.childGoalId}`)).within, { timeout: 10_000 })
			.toBe(true);
	});

	test("in-app route change scrolls an off-screen row into view; an already-visible row does not jump", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 360 });
		await seedBrowserState(page);
		await openApp(page);
		await expect(navRow(page, `goal:${fixture.parentGoalId}`)).toBeVisible({ timeout: 15_000 });

		// Force overflow, then pin the scroll to the top so the last filler goal
		// is off-screen.
		await setSidebarScrollTop(page, 0);
		const lastGoalId = fixture.fillerGoalIds[fixture.fillerGoalIds.length - 1];
		const lastNav = `goal:${lastGoalId}`;
		await expect.poll(async () => (await rowGeometry(page, lastNav)).overflowing, { timeout: 10_000 }).toBe(true);
		expect((await rowGeometry(page, lastNav)).within, "last filler goal should start off-screen").toBe(false);

		// In-app navigation to the off-screen row must scroll it into view.
		await inAppNavigate(page, `#/goal/${lastGoalId}`);
		await expect.poll(async () => (await rowGeometry(page, lastNav)).within, { timeout: 10_000 }).toBe(true);

		// Now navigate to a DIFFERENT row that is already fully visible — the
		// reveal must not jump the scroll position (block:"nearest" no-op).
		const visible = (await fullyVisibleNavIds(page)).filter(id => id.startsWith("goal:") && id !== lastNav);
		expect(visible.length, "expected another goal row visible alongside the target").toBeGreaterThan(0);
		const scrollBefore = (await rowGeometry(page, lastNav)).scrollTop;
		await inAppNavigate(page, `#/${visible[0].replace("goal:", "goal/")}`);
		await expect(navRow(page, visible[0])).toHaveAttribute("data-nav-active", "true", { timeout: 10_000 });
		// Give any (erroneous) scroll a chance to happen, then assert it didn't.
		await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
		expect((await rowGeometry(page, lastNav)).scrollTop, "already-visible target must not move the sidebar scroll").toBe(scrollBefore);
	});

	test("ephemeral contract: off-path collapse is preserved, and an on-path explicit collapse is never overwritten", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 620 });
		// Part A: explicitly collapse the (off-path) Sessions section AND the
		// (on-path) parent goal, then deep-link to the sub-goal.
		const sessionsKey = treeKey("project-sessions", fixture.projectId);
		const parentGoalKey = treeKey("goal", fixture.parentGoalId);
		await seedBrowserState(page, { [sessionsKey]: "collapsed" });
		await openAppAtHash(page, `#/goal/${fixture.childGoalId}`);

		// The sub-goal reveal expands the parent goal (on path) but must NOT
		// touch the off-path Sessions section.
		await expect(navRow(page, `goal:${fixture.childGoalId}`)).toBeVisible({ timeout: 15_000 });
		await expect(navRow(page, `session:${fixture.standaloneSessionId}`), "off-path collapsed Sessions section stays collapsed").toBeHidden({ timeout: 10_000 });
		expect(await storedPreference(page, sessionsKey), "off-path explicit collapse preserved").toBe("collapsed");

		// Part B: explicitly collapse the parent goal (on path) and deep-link to
		// the nested session. The reveal must NOT overwrite the explicit collapse,
		// so the parent stays collapsed and the nested session row stays hidden.
		await seedBrowserState(page, { [parentGoalKey]: "collapsed" });
		await openAppAtHash(page, `#/session/${fixture.nestedSessionId}`);
		await expect(navRow(page, `goal:${fixture.parentGoalId}`)).toBeVisible({ timeout: 15_000 });
		await expect(navRow(page, `session:${fixture.nestedSessionId}`), "on-path explicit collapse must keep the nested row hidden").toBeHidden({ timeout: 10_000 });
		expect(await storedPreference(page, parentGoalKey), "on-path explicit collapse must not be overwritten").toBe("collapsed");
	});

	// Regression: team-lead sessions are `team-lead/<id>` tree nodes, not
	// `session/<id>` nodes, so the single-key session lookup misses them and the
	// collapsed goal ancestor never expands. The team-lead row (data-nav-id
	// "session:<id>") stays hidden. Fails on current code; passes after the
	// ordered fallback resolver tries the team-lead node key.
	test("deep-link to a team-lead session expands the collapsed goal and scrolls the team-lead row into view", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 620 });
		await seedBrowserState(page);
		await openAppAtHash(page, `#/session/${fixture.teamLeadSessionId}`);

		// The team goal defaults collapsed → the reveal must expand it so the
		// team-lead row renders and becomes the active row.
		await expect(navRow(page, `goal:${fixture.teamGoalId}`)).toBeVisible({ timeout: 15_000 });
		const teamLeadRow = navRow(page, `session:${fixture.teamLeadSessionId}`);
		await expect(teamLeadRow).toBeVisible({ timeout: 10_000 });
		await expect(teamLeadRow).toHaveAttribute("data-nav-active", "true", { timeout: 10_000 });

		await expect.poll(async () => (await rowGeometry(page, `session:${fixture.teamLeadSessionId}`)).within, { timeout: 10_000 })
			.toBe(true);
	});

	// Regression: staff sessions are excluded from the sidebar tree entirely and
	// render only under the project-staff section (which defaults expanded), so
	// there is NO tree node to look up. The project-staff section defaults
	// expanded (per the ephemeral contract, the reveal must NOT rely on
	// re-expanding an explicit collapse) so we instead force the staff row
	// off-screen via overflow and assert the reveal SCROLLS it into view. Fails
	// on current code (no node → attemptReveal never scrolls); passes after the
	// staff-row fallback resolver locates the staff entry and reveals it.
	test("deep-link to a staff session scrolls the off-screen staff row into view", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 360 });
		await seedBrowserState(page);
		await openApp(page);
		await expect(navRow(page, `goal:${fixture.parentGoalId}`)).toBeVisible({ timeout: 15_000 });

		// Force sidebar overflow (short viewport + many filler goals) and pin the
		// scroll to the top so the staff section — rendered below the goal forest
		// — starts off-screen but still present in the DOM.
		const staffNav = `session:${fixture.staffSessionId}`;
		await expect.poll(async () => (await rowGeometry(page, staffNav)).overflowing, { timeout: 15_000 }).toBe(true);
		await setSidebarScrollTop(page, 0);
		await expect.poll(async () => (await rowGeometry(page, staffNav)).found, { timeout: 10_000 }).toBe(true);
		expect((await rowGeometry(page, staffNav)).within, "staff row should start off-screen before navigation").toBe(false);

		// In-app navigation to the staff session must scroll its row into view.
		await inAppNavigate(page, `#/session/${fixture.staffSessionId}`);
		await expect.poll(async () => (await rowGeometry(page, staffNav)).within, { timeout: 10_000 }).toBe(true);
	});
});
