/**
 * Sidebar keyboard navigation representative real-app smoke.
 * The exhaustive visible-row/order/wrap/archive matrix lives in the file://
 * fixture at tests/ui-fixtures/sidebar-keyboard-nav-fixture.spec.ts.
 */
import { test, expect, type Page } from "../gateway-harness.js";
import {
	apiFetch,
	createSession,
	createGoal,
	deleteSession,
	deleteGoal,
	nonGitCwd,
	waitForHealth,
} from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MARK = "SIDEBAR_NAV_CONTRACT";

async function registerProject(name: string): Promise<{ id: string; rootPath: string; name: string }> {
	const rootPath = join(
		tmpdir(),
		`bobbit-e2e-navkb-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	mkdirSync(rootPath, { recursive: true });
	const resp = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name, rootPath }),
	});
	expect(resp.status).toBe(201);
	const data = await resp.json();
	return { id: data.id, rootPath, name };
}

async function pressCtrlArrow(
	page: Page,
	key: "ArrowDown" | "ArrowUp" | "ArrowLeft" | "ArrowRight",
): Promise<void> {
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

async function nextFrame(page: Page): Promise<void> {
	await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
}

type ActiveNavSnapshot = {
	id: string | null;
	activeIds: string[];
	fallbackIds: string[];
	keyboardNavActiveId: string | null;
	selectedSessionId: string | null;
	connectingSessionId: string | null;
	hash: string;
};

async function activeNavSnapshot(page: Page): Promise<ActiveNavSnapshot> {
	return page.evaluate(() => {
		const idsFor = (selector: string) => Array.from(document.querySelectorAll(selector))
			.map((el) => el.getAttribute("data-nav-id"))
			.filter((id): id is string => !!id);
		const activeIds = idsFor("[data-nav-id][data-nav-active='true']");
		// Legacy class/attribute fallback is only for diagnostics and pre-contract
		// renders. The contract-active row is data-nav-active=true; querying class
		// selectors first can read a stale selected session during route churn.
		const fallbackIds = idsFor("[data-nav-id].sidebar-session-active, [data-nav-id].sidebar-active, [data-nav-id][data-active='true']");
		const state = (window as any).__bobbitState ?? (window as any).bobbitState ?? {};
		return {
			id: activeIds[0] ?? fallbackIds[0] ?? null,
			activeIds,
			fallbackIds,
			keyboardNavActiveId: state.keyboardNavActiveId ?? null,
			selectedSessionId: state.selectedSessionId ?? null,
			connectingSessionId: state.connectingSessionId ?? null,
			hash: window.location.hash,
		};
	});
}

async function activeNavId(page: Page): Promise<string | null> {
	return (await activeNavSnapshot(page)).id;
}

async function navIdsInDomOrder(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const sidebar = document.querySelector(".sidebar-edge");
		if (!sidebar) return [];
		const out: string[] = [];
		const seen = new Set<string>();
		for (const el of sidebar.querySelectorAll("[data-nav-id]")) {
			const id = el.getAttribute("data-nav-id");
			if (id && !seen.has(id)) {
				seen.add(id);
				out.push(id);
			}
		}
		return out;
	});
}

function sameOrder(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((id, idx) => id === b[idx]);
}

async function waitForStableNavOrder(
	page: Page,
	requiredIds: string[] = [],
	absentIds: string[] = [],
): Promise<string[]> {
	const deadline = Date.now() + 10_000;
	let previous: string[] | null = null;
	let stableFrames = 0;
	let latest: string[] = [];
	while (Date.now() < deadline) {
		await nextFrame(page);
		latest = await navIdsInDomOrder(page);
		const hasRequired = requiredIds.every((id) => latest.includes(id));
		const hasNoAbsent = absentIds.every((id) => !latest.includes(id));
		if (latest.length > 0 && hasRequired && hasNoAbsent && previous && sameOrder(latest, previous)) {
			stableFrames += 1;
			if (stableFrames >= 2) return latest;
		} else {
			stableFrames = 0;
		}
		previous = latest;
	}
	throw new Error(`${MARK}: sidebar nav order did not stabilize; latest=${JSON.stringify(latest)} required=${JSON.stringify(requiredIds)} absent=${JSON.stringify(absentIds)}`);
}

async function waitForShortcutsReady(page: Page): Promise<void> {
	await expect.poll(() => page.evaluate(() => document.body.dataset.shortcutsReady === "1"), {
		timeout: 15_000,
	}).toBe(true);
}

function expectedHashForNavId(navId: string | null): string | null {
	if (!navId) return null;
	const sep = navId.indexOf(":");
	if (sep < 0) return null;
	const kind = navId.slice(0, sep);
	const id = navId.slice(sep + 1);
	switch (kind) {
		case "session": return `#/session/${id}`;
		case "goal": return `#/goal/${id}`;
		case "project": return `#/settings/${id}/general`;
		case "staff-header": return "#/staff";
		case "ungrouped-header":
		case "archived-header": return "#/";
		default: return null;
	}
}

async function waitForActiveNavId(page: Page, expected: string | null): Promise<void> {
	const deadline = Date.now() + 10_000;
	let latest: ActiveNavSnapshot | null = null;
	while (Date.now() < deadline) {
		await nextFrame(page);
		latest = await activeNavSnapshot(page);
		const contractActiveIsSettled = latest.activeIds.length <= 1;
		if (contractActiveIsSettled && latest.id === expected) return;
	}
	throw new Error(`${MARK}: expected active nav ${JSON.stringify(expected)}; latest=${JSON.stringify(latest)}`);
}

async function waitForNavSettled(page: Page, expected: string | null): Promise<void> {
	const expectedHash = expectedHashForNavId(expected);
	const expectedSessionId = expected?.startsWith("session:") ? expected.slice("session:".length) : null;
	const deadline = Date.now() + 10_000;
	let latest: ActiveNavSnapshot | null = null;
	while (Date.now() < deadline) {
		await nextFrame(page);
		latest = await activeNavSnapshot(page);
		const contractActiveIsSettled = latest.activeIds.length <= 1;
		const routeIsSettled = !expectedHash || latest.hash === expectedHash;
		const sessionIsSettled = !expectedSessionId || latest.selectedSessionId === expectedSessionId;
		if (contractActiveIsSettled && latest.id === expected && routeIsSettled && sessionIsSettled) return;
	}
	throw new Error(`${MARK}: expected settled nav ${JSON.stringify(expected)} hash=${JSON.stringify(expectedHash)}; latest=${JSON.stringify(latest)}`);
}

async function resetNavStart(page: Page): Promise<void> {
	await page.evaluate(() => {
		window.history.replaceState({}, "", "#/");
		const state = (window as any).__bobbitState ?? (window as any).bobbitState;
		if (state) {
			state.keyboardNavActiveId = null;
			state.selectedSessionId = null;
			state.goalDashboardId = null;
			state.connectingSessionId = null;
			state.remoteAgent = null;
		}
		(window as any).__bobbitRenderApp?.();
	});
	await waitForActiveNavId(page, null);
}

async function walkDown(page: Page, steps: number, expectedOrder: string[]): Promise<Array<string | null>> {
	const visited: Array<string | null> = [];
	for (let i = 0; i < steps; i++) {
		const expected = expectedOrder[i % expectedOrder.length];
		await pressCtrlArrow(page, "ArrowDown");
		await waitForNavSettled(page, expected);
		visited.push(await activeNavId(page));
	}
	return visited;
}

async function walkDownRange(page: Page, expectedOrder: string[], from: number, toInclusive: number): Promise<void> {
	for (let i = from; i <= toInclusive; i++) {
		const expected = expectedOrder[i % expectedOrder.length];
		await pressCtrlArrow(page, "ArrowDown");
		await waitForNavSettled(page, expected);
	}
}

test.describe("Sidebar keyboard navigation contract", () => {
	let project: { id: string; rootPath: string; name: string } | undefined;
	const createdSessionIds: string[] = [];
	let liveGoalId: string | undefined;
	const createdGoalIds: string[] = [];

	test.beforeAll(async () => {
		await waitForHealth();
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		project = await registerProject(`navkb-alpha-${stamp}`);

		const goal = await createGoal({
			title: `KBNavGoalA-${stamp}`,
			projectId: project.id,
			worktree: false,
			cwd: nonGitCwd(),
		});
		liveGoalId = goal.id;
		createdGoalIds.push(goal.id);
		createdSessionIds.push(await createSession({ projectId: project.id, goalId: goal.id }));
		createdSessionIds.push(await createSession({ projectId: project.id }));
	});

	test.afterAll(async () => {
		for (const s of createdSessionIds) await deleteSession(s).catch(() => {});
		for (const g of createdGoalIds) await deleteGoal(g).catch(() => {});
		if (project) await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
	});

	function buildRequiredNavIds(): string[] {
		return [
			`project:${project!.id}`,
			`goal:${liveGoalId}`,
			...createdSessionIds.map((id) => `session:${id}`),
		];
	}

	async function openSidebar(page: Page): Promise<void> {
		await page.addInitScript(() => {
			localStorage.setItem("bobbit-show-archived", "false");
		});
		await openApp(page);
		await waitForShortcutsReady(page);
		await expect(page.locator(".sidebar-edge")).toBeVisible({ timeout: 10_000 });
	}

	test("real app Ctrl+Arrow journey walks rows, wraps, and routes goal/session destinations", async ({ page }) => {
		await openSidebar(page);
		const domOrder = await waitForStableNavOrder(page, buildRequiredNavIds());
		expect(domOrder.length, `${MARK}: sidebar must emit data-nav-id rows`).toBeGreaterThan(3);
		const kinds = new Set(domOrder.map((id) => id.split(":")[0]));
		for (const k of ["project", "goal", "session"]) {
			expect(kinds.has(k), `${MARK}: sidebar missing data-nav-id of kind "${k}"`).toBe(true);
		}

		await resetNavStart(page);
		const visitedDown = await walkDown(page, domOrder.length + 1, domOrder);
		expect(visitedDown.slice(0, domOrder.length), `${MARK}: Ctrl+ArrowDown must visit rows in DOM order`).toEqual(domOrder);
		expect(visitedDown[domOrder.length], `${MARK}: Ctrl+ArrowDown must wrap to first row`).toBe(domOrder[0]);

		await pressCtrlArrow(page, "ArrowUp");
		await waitForNavSettled(page, domOrder[domOrder.length - 1]);
		expect(await activeNavId(page), `${MARK}: Ctrl+ArrowUp from first row must wrap to last`).toBe(domOrder[domOrder.length - 1]);

		const goalEntry = `goal:${liveGoalId}`;
		const goalIndex = domOrder.indexOf(goalEntry);
		expect(goalIndex, `${MARK}: sidebar must include live goal row`).toBeGreaterThanOrEqual(0);
		await resetNavStart(page);
		await walkDownRange(page, domOrder, 0, goalIndex);
		const goalSnapshot = await activeNavSnapshot(page);
		expect(goalSnapshot.id, `${MARK}: goal row must be active before asserting route`).toBe(goalEntry);
		expect(goalSnapshot.hash, `${MARK}: landing on goal header must route to goal dashboard`).toBe(`#/goal/${liveGoalId}`);

		const nextSessionIndex = domOrder.findIndex((id, idx) => idx > goalIndex && id.startsWith("session:"));
		expect(nextSessionIndex, `${MARK}: goal journey must expose a following session row`).toBeGreaterThan(goalIndex);
		const nextSession = domOrder[nextSessionIndex];
		await walkDownRange(page, domOrder, goalIndex + 1, nextSessionIndex);
		const sessionId = nextSession.split(":")[1];
		const sessionSnapshot = await activeNavSnapshot(page);
		expect(sessionSnapshot.hash, `${MARK}: landing on session row must route to session`).toContain(`#/session/${sessionId}`);
		expect(sessionSnapshot.selectedSessionId, `${MARK}: landing on session row must select session`).toBe(sessionId);
	});
});
