/**
 * Reproducing test for the "Fix sidebar keyboard nav" goal.
 *
 * Verifies the contracts that the goal spec promises for Ctrl+Up/Down/Left/Right
 * sidebar navigation. Every assertion below MUST FAIL on the current goal-branch
 * HEAD — this is the TDD "expect: failure" gate.
 *
 * Failing assertions are intentionally tagged with the marker
 * `SIDEBAR_NAV_CONTRACT` so the reproducing-test gate's `error_pattern` can
 * uniquely identify a real contract-failure (vs. infrastructure noise).
 *
 * Expected current-HEAD failure modes:
 *   1. Every selectable sidebar row should carry a `data-nav-id="<kind>:<id>"`
 *      attribute (project header, goal header, session row, ungrouped header,
 *      staff header, archived header). Currently NO rows do — the FIRST
 *      assertion blocks here.
 *   2. The "active row" highlight should extend beyond session rows to every
 *      row kind. Currently only sessions get `.sidebar-session-active`.
 *   3. `Ctrl+ArrowDown` / `Ctrl+ArrowUp` should walk the rendered DOM order
 *      and visit every visible row. Currently `navigateSession()` builds its
 *      own flat order that skips project / goal / section headers.
 *   4. `Ctrl+ArrowRight` / `Ctrl+ArrowLeft` shortcuts to expand / collapse a
 *      group header without moving the cursor — currently unregistered.
 *   5. Auto-opening the matching pane (goal dashboard, project settings,
 *      staff list, splash) on Ctrl+↑/↓ landing — currently absent.
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

/** Dispatch a Ctrl+<arrow> keydown straight at `window` so the app's
 *  shortcut registry receives it regardless of which element has focus.
 *  Sets BOTH ctrlKey and metaKey to match the registry's platform-aware
 *  `ctrlOrMeta` check (mac uses metaKey, win/linux uses ctrlKey). */
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

/** Read the active row's `data-nav-id`. Active = whichever row carries the
 *  sidebar's active-row class. The goal spec extends the existing
 *  `.sidebar-session-active` (or sibling `.sidebar-active*`) class to every
 *  row kind. */
async function activeNavId(page: Page): Promise<string | null> {
	return await page.evaluate(() => {
		const sel = [
			"[data-nav-id].sidebar-session-active",
			"[data-nav-id].sidebar-active",
			"[data-nav-id][data-nav-active='true']",
			"[data-nav-id][data-active='true']",
		].join(", ");
		const el = document.querySelector(sel);
		return el ? el.getAttribute("data-nav-id") : null;
	});
}

/** Read every visible sidebar row's `data-nav-id` in DOM (= render) order. */
async function navIdsInDomOrder(page: Page): Promise<string[]> {
	return await page.evaluate(() => {
		const sidebar = document.querySelector(".sidebar-edge");
		if (!sidebar) return [];
		const els = sidebar.querySelectorAll("[data-nav-id]");
		return Array.from(els)
			.map((el) => el.getAttribute("data-nav-id"))
			.filter((v): v is string => !!v);
	});
}

/** Wait for the app's shortcut listeners to attach before dispatching. */
async function waitForShortcutsReady(page: Page): Promise<void> {
	await expect
		.poll(() => page.evaluate(() => document.body.dataset.shortcutsReady === "1"), {
			timeout: 15_000,
		})
		.toBe(true);
}

test.describe("Sidebar keyboard navigation contract (TDD repro)", () => {
	let projectA: { id: string; rootPath: string; name: string } | undefined;
	let projectB: { id: string; rootPath: string; name: string } | undefined;
	const createdSessionIds: string[] = [];
	const createdGoalIds: string[] = [];

	test.beforeAll(async () => {
		await waitForHealth();
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		projectA = await registerProject(`navkb-alpha-${stamp}`);
		projectB = await registerProject(`navkb-bravo-${stamp}`);

		// Project A: one goal containing one session.
		const goalA = await createGoal({
			title: `KBNavGoalA-${stamp}`,
			projectId: projectA.id,
			worktree: false,
			cwd: nonGitCwd(),
		});
		createdGoalIds.push(goalA.id);
		const sA = await createSession({ projectId: projectA.id, goalId: goalA.id });
		createdSessionIds.push(sA);

		// Project A: one ungrouped session.
		const sAUng = await createSession({ projectId: projectA.id });
		createdSessionIds.push(sAUng);

		// Project B: one goal + one session under it.
		const goalB = await createGoal({
			title: `KBNavGoalB-${stamp}`,
			projectId: projectB.id,
			worktree: false,
			cwd: nonGitCwd(),
		});
		createdGoalIds.push(goalB.id);
		const sB = await createSession({ projectId: projectB.id, goalId: goalB.id });
		createdSessionIds.push(sB);
	});

	test.afterAll(async () => {
		for (const g of createdGoalIds) await deleteGoal(g).catch(() => {});
		for (const s of createdSessionIds) await deleteSession(s).catch(() => {});
		if (projectA) await apiFetch(`/api/projects/${projectA.id}`, { method: "DELETE" }).catch(() => {});
		if (projectB) await apiFetch(`/api/projects/${projectB.id}`, { method: "DELETE" }).catch(() => {});
	});

	// -------------------------------------------------------------------
	// 1. Every selectable sidebar row carries a data-nav-id attribute.
	// -------------------------------------------------------------------
	test("every visible sidebar row exposes data-nav-id", async ({ page }) => {
		await openApp(page);
		await waitForShortcutsReady(page);

		// Give the sidebar a beat to render goals/projects after the WS hydration.
		await expect(page.locator(".sidebar-edge")).toBeVisible({ timeout: 10_000 });

		const navIds = await navIdsInDomOrder(page);
		expect(
			navIds.length,
			`${MARK}: sidebar must emit data-nav-id on every selectable row (got ${navIds.length})`,
		).toBeGreaterThan(0);

		// We expect at least one project, one goal, and one session row.
		const kinds = new Set(navIds.map((id) => id.split(":")[0]));
		for (const k of ["project", "goal", "session"]) {
			expect(
				kinds.has(k),
				`${MARK}: sidebar missing data-nav-id of kind "${k}" (saw kinds=${[...kinds].join(",")})`,
			).toBe(true);
		}
	});

	// -------------------------------------------------------------------
	// 2. Ctrl+ArrowDown from the top walks the DOM order across two projects.
	// -------------------------------------------------------------------
	test("Ctrl+ArrowDown walks rendered DOM order across projects + wraps", async ({ page }) => {
		await openApp(page);
		await waitForShortcutsReady(page);
		await expect(page.locator(".sidebar-edge")).toBeVisible({ timeout: 10_000 });

		const domOrder = await navIdsInDomOrder(page);
		expect(
			domOrder.length,
			`${MARK}: sidebar must emit data-nav-id rows`,
		).toBeGreaterThan(3);

		// Reset to a known starting point: navigate to splash so no row is yet active.
		await page.evaluate(() => { window.location.hash = "#/"; });

		// Press Ctrl+ArrowDown once for each visible row + 1 (to test wrap).
		const visited: Array<string | null> = [];
		for (let i = 0; i < domOrder.length + 1; i++) {
			await pressCtrlArrow(page, "ArrowDown");
			// Give the renderer a tick to settle.
			await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
			visited.push(await activeNavId(page));
		}

		// The first N visits must match DOM order top-to-bottom.
		const firstN = visited.slice(0, domOrder.length);
		expect(
			firstN,
			`${MARK}: Ctrl+ArrowDown must visit every data-nav-id row in DOM order`,
		).toEqual(domOrder);

		// Wrap: the (N+1)th visit should be the first row again.
		expect(
			visited[domOrder.length],
			`${MARK}: Ctrl+ArrowDown must wrap from last row back to first`,
		).toBe(domOrder[0]);
	});

	// -------------------------------------------------------------------
	// 3. Ctrl+ArrowUp wraps from the first row to the last.
	// -------------------------------------------------------------------
	test("Ctrl+ArrowUp from the first visible row wraps to the last", async ({ page }) => {
		await openApp(page);
		await waitForShortcutsReady(page);
		await expect(page.locator(".sidebar-edge")).toBeVisible({ timeout: 10_000 });

		const domOrder = await navIdsInDomOrder(page);
		expect(domOrder.length, `${MARK}: need rows to test wrap`).toBeGreaterThan(1);

		// Land on the first row.
		await page.evaluate(() => { window.location.hash = "#/"; });
		await pressCtrlArrow(page, "ArrowDown");
		await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
		expect(
			await activeNavId(page),
			`${MARK}: first Ctrl+ArrowDown should land on the first DOM row`,
		).toBe(domOrder[0]);

		// Now ArrowUp — must wrap to the last row.
		await pressCtrlArrow(page, "ArrowUp");
		await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
		expect(
			await activeNavId(page),
			`${MARK}: Ctrl+ArrowUp from the first row must wrap to the last row`,
		).toBe(domOrder[domOrder.length - 1]);
	});

	// -------------------------------------------------------------------
	// 4. Search filters the keyboard-nav cycle.
	// -------------------------------------------------------------------
	test("search query restricts Ctrl+ArrowDown to filtered-visible rows", async ({ page }) => {
		await openApp(page);
		await waitForShortcutsReady(page);
		await expect(page.locator(".sidebar-edge")).toBeVisible({ timeout: 10_000 });

		const searchInput = page.locator("input[data-search]");
		await searchInput.click();
		await searchInput.fill("KBNavGoalA");
		// Wait for the 200ms search debounce to land in client state. The app
		// exposes `window.bobbitState` for diagnostics; poll its `searchQuery`
		// field rather than a flat sleep.
		await expect
			.poll(
				() => page.evaluate(() => (window as any).bobbitState?.searchQuery ?? ""),
				{ timeout: 5_000 },
			)
			.toBe("KBNavGoalA");

		const filtered = await navIdsInDomOrder(page);
		expect(
			filtered.length,
			`${MARK}: search must still render at least one nav row`,
		).toBeGreaterThan(0);

		await page.evaluate(() => { window.location.hash = "#/"; });
		const visited = new Set<string>();
		for (let i = 0; i < filtered.length + 2; i++) {
			await pressCtrlArrow(page, "ArrowDown");
			await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
			const id = await activeNavId(page);
			if (id) visited.add(id);
		}
		// Cycling must only visit rows that are currently in the filtered list.
		for (const v of visited) {
			expect(
				filtered.includes(v),
				`${MARK}: Ctrl+ArrowDown under search visited "${v}" which is not in the filtered DOM order [${filtered.join(",")}]`,
			).toBe(true);
		}
	});

	// -------------------------------------------------------------------
	// 5. Collapsing a project removes its children from the cycle.
	// -------------------------------------------------------------------
	test("collapsing a project hides its children from Ctrl+ArrowDown cycle", async ({ page }) => {
		await openApp(page);
		await waitForShortcutsReady(page);
		await expect(page.locator(".sidebar-edge")).toBeVisible({ timeout: 10_000 });

		// Find Project A's project header by data-nav-id and collapse it via its chevron.
		// Collapse path is implementation-defined; we use the well-known chevron title
		// pattern ("Collapse project") if available, else click the header itself.
		const before = await navIdsInDomOrder(page);
		expect(before.length, `${MARK}: need rows present before collapse`).toBeGreaterThan(2);

		const projectNavId = `project:${projectA!.id}`;
		// Locate the project header's row. Implementation must tag the header
		// with data-nav-id; if not present, the test fails here with MARK.
		const headerLocator = page.locator(`[data-nav-id="${projectNavId}"]`);
		expect(
			await headerLocator.count(),
			`${MARK}: Project A header must have data-nav-id="${projectNavId}"`,
		).toBeGreaterThan(0);

		// Click the chevron / toggle inside the header to collapse it.
		// Implementation may use a button with title containing "Collapse" or
		// the header itself toggles on click.
		const collapseBtn = headerLocator.locator(
			"button[title*='Collapse' i], button[aria-label*='Collapse' i], [data-action='collapse']",
		).first();
		if (await collapseBtn.count()) {
			await collapseBtn.click();
		} else {
			// Fall back to clicking the header. If the renderer treats the click
			// as "open settings" the test will fail downstream — which is fine.
			await headerLocator.first().click();
		}
		await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));

		const after = await navIdsInDomOrder(page);
		// Project A's goal + sessions should NOT appear in the new DOM order.
		// Slice from projectA exclusive to the next project header (or end).
		const projAIdx = before.indexOf(projectNavId);
		let nextProjIdx = before.length;
		for (let i = projAIdx + 1; i < before.length; i++) {
			if (before[i].startsWith("project:")) { nextProjIdx = i; break; }
		}
		const projectAChildren = before.slice(projAIdx + 1, nextProjIdx);
		for (const child of projectAChildren) {
			expect(
				after.includes(child),
				`${MARK}: after collapsing ${projectNavId}, child row "${child}" must be removed from the cycle`,
			).toBe(false);
		}
	});

	// -------------------------------------------------------------------
	// 6. Ctrl+ArrowRight expands a collapsed group; Ctrl+ArrowLeft collapses
	//    an expanded one. Neither moves the active row.
	// -------------------------------------------------------------------
	test("Ctrl+ArrowRight/Left expand+collapse without moving the cursor", async ({ page }) => {
		await openApp(page);
		await waitForShortcutsReady(page);
		await expect(page.locator(".sidebar-edge")).toBeVisible({ timeout: 10_000 });

		const projectNavId = `project:${projectA!.id}`;

		// Park the active row on the Project A header by Ctrl+ArrowDown stepping.
		await page.evaluate(() => { window.location.hash = "#/"; });
		// Step down until active matches the project header — bounded by DOM size + 1.
		const dom = await navIdsInDomOrder(page);
		let landed = false;
		for (let i = 0; i < dom.length + 1; i++) {
			await pressCtrlArrow(page, "ArrowDown");
			await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
			if ((await activeNavId(page)) === projectNavId) {
				landed = true;
				break;
			}
		}
		expect(
			landed,
			`${MARK}: must be able to land active row on project header via Ctrl+ArrowDown`,
		).toBe(true);

		// Press Ctrl+ArrowLeft to collapse, then Ctrl+ArrowRight to re-expand.
		const childrenBefore = (await navIdsInDomOrder(page)).filter(
			(id) => id.startsWith("goal:") || id.startsWith("session:"),
		);

		await pressCtrlArrow(page, "ArrowLeft");
		await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
		expect(
			await activeNavId(page),
			`${MARK}: Ctrl+ArrowLeft on group header must not move the active row`,
		).toBe(projectNavId);
		const afterCollapse = (await navIdsInDomOrder(page)).filter(
			(id) => id.startsWith("goal:") || id.startsWith("session:"),
		);
		expect(
			afterCollapse.length,
			`${MARK}: Ctrl+ArrowLeft on an expanded project header must collapse it (children gone)`,
		).toBeLessThan(childrenBefore.length);

		await pressCtrlArrow(page, "ArrowRight");
		await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
		expect(
			await activeNavId(page),
			`${MARK}: Ctrl+ArrowRight on group header must not move the active row`,
		).toBe(projectNavId);
		const afterExpand = (await navIdsInDomOrder(page)).filter(
			(id) => id.startsWith("goal:") || id.startsWith("session:"),
		);
		expect(
			afterExpand.length,
			`${MARK}: Ctrl+ArrowRight on a collapsed project header must re-expand it`,
		).toBeGreaterThanOrEqual(childrenBefore.length);
	});

	// -------------------------------------------------------------------
	// 7. Auto-open: landing on a goal header opens the goal dashboard.
	// -------------------------------------------------------------------
	test("Ctrl+ArrowDown landing on a goal header auto-opens the goal dashboard", async ({ page }) => {
		await openApp(page);
		await waitForShortcutsReady(page);
		await expect(page.locator(".sidebar-edge")).toBeVisible({ timeout: 10_000 });

		const dom = await navIdsInDomOrder(page);
		const goalEntry = dom.find((id) => id.startsWith("goal:"));
		expect(
			goalEntry,
			`${MARK}: sidebar must include a goal row in nav order`,
		).toBeTruthy();
		const goalId = goalEntry!.split(":")[1];

		await page.evaluate(() => { window.location.hash = "#/"; });
		let landed = false;
		for (let i = 0; i < dom.length + 1; i++) {
			await pressCtrlArrow(page, "ArrowDown");
			await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
			if ((await activeNavId(page)) === goalEntry) {
				landed = true;
				break;
			}
		}
		expect(
			landed,
			`${MARK}: Ctrl+ArrowDown must be able to land active row on goal header "${goalEntry}"`,
		).toBe(true);

		// After landing, the hash route must reflect the goal dashboard.
		const hash = await page.evaluate(() => window.location.hash);
		expect(
			hash,
			`${MARK}: landing on a goal header must auto-open the goal dashboard for ${goalId} (hash=${hash})`,
		).toContain(goalId);
		expect(
			hash,
			`${MARK}: landing on a goal header must route to /goal/<id> (hash=${hash})`,
		).toMatch(/#\/goal\//);
	});
});
