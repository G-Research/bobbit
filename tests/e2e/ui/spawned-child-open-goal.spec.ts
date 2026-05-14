/**
 * Browser E2E for the spawned-child "Open goal →" navigation.
 *
 * Pins the design in `docs/design/spawned-child-open-goal.md` (per the
 * Design Document gate on goal/spawned-ch-319cae63):
 *
 *   1. Active child   → click navigates to `#/goal/<childId>` and the
 *                       goal dashboard becomes visible.
 *   2. Cross-project  → `window.__bobbitState.activeProjectId` switches
 *                       to the child's project after navigation.
 *   3. Archived child → click still navigates; the dashboard renders with
 *                       the existing "Archived" badge.
 *   4. Blocked child  → resolvable child navigates without any console
 *                       errors from tab-visibility helpers (no-crash proxy
 *                       for `state: "blocked"` goals that are otherwise
 *                       routed identically to active goals).
 *   5. Missing/purged → unresolvable goalId shows a header toast with the
 *                       exact text `Goal no longer exists (id=<first 8>)`
 *                       and the app does NOT fall through to the empty
 *                       landing view.
 *
 * Render pattern mirrors `children-tool-renderers.spec.ts` — mount the
 * `goal_spawn_child` renderer directly into an in-page sandbox div via
 * the production `__bobbitRenderTool` / `__bobbitLitRender` hooks. The
 * click handler manipulates `window.location.hash`, which the real app's
 * `hashchange` listener consumes — so the test exercises the full
 * renderer + router + dashboard pipeline.
 *
 * NOTE on production status: these tests target the post-fix behavior
 * described in the design doc. Until the implementation task lands they
 * are expected to fail in three concrete ways, which doubles as a
 * regression pin:
 *   - The renderer writes `#goal-dashboard/<id>` directly (no leading
 *     slash) instead of going through `setHashRoute("goal-dashboard", id)`,
 *     so `getRouteFromHash()` returns `view: "landing"`.
 *   - `renderGoalDashboard()` does not yet carry
 *     `data-testid="goal-dashboard"` on its root container.
 *   - `handleHashChange()` does not yet resolve the goalId across projects
 *     or show the `Goal no longer exists` toast.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createGoal, defaultProjectId, deleteGoal } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHORT = (id: string): string => id.slice(0, 8);

async function setSubgoalsFlag(value: boolean): Promise<void> {
	const resp = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ subgoalsEnabled: value }),
	});
	expect(resp.status).toBe(200);
}

/** Mount the `goal_spawn_child` renderer into an in-page sandbox div so we
 *  can click the real production `Open goal →` button without standing up
 *  a full team-lead session transcript. */
async function mountSpawnChild(
	page: Page,
	childGoalId: string,
	opts?: { title?: string; planId?: string },
): Promise<void> {
	await page.waitForFunction(
		() => Boolean((window as any).__bobbitRenderTool) && Boolean((window as any).__bobbitLitRender),
		null,
		{ timeout: 10_000 },
	);
	await page.evaluate(({ childGoalId, title, planId }) => {
		let host = document.getElementById("e2e-render-host");
		if (!host) {
			host = document.createElement("div");
			host.id = "e2e-render-host";
			host.setAttribute("data-testid", "e2e-render-host");
			// Position on top of the app so the button is always clickable.
			host.style.cssText = "position:fixed;top:8px;right:8px;z-index:99999;background:rgba(0,0,0,0.05);padding:8px;border-radius:6px;";
			document.body.appendChild(host);
		}
		host.innerHTML = "";
		const renderTool = (window as any).__bobbitRenderTool;
		const litRender = (window as any).__bobbitLitRender;
		const result = {
			role: "toolResult",
			toolCallId: "t-spawn-1",
			toolName: "goal_spawn_child",
			isError: false,
			content: [{ type: "text", text: JSON.stringify({ id: childGoalId }) }],
			timestamp: Date.now(),
		};
		const out = renderTool(
			"goal_spawn_child",
			{ title: title || "E2E child", planId: planId || "plan-x", spec: "spawned-child open-goal navigation E2E" },
			result,
			false,
			{},
		);
		litRender(out.content, host);
	}, { childGoalId, title: opts?.title, planId: opts?.planId });

	await expect(
		page.locator("#e2e-render-host [data-testid='children-spawn-open-goal']"),
	).toBeVisible({ timeout: 10_000 });
}

/** Click the Open goal button and remove the sandbox host so the dashboard
 *  is not visually occluded by the host overlay during assertions. */
async function clickOpenGoal(page: Page): Promise<void> {
	await page.locator("#e2e-render-host [data-testid='children-spawn-open-goal']").click();
	// Drop the overlay so dashboard assertions can locate elements freely.
	await page.evaluate(() => {
		document.getElementById("e2e-render-host")?.remove();
	});
}

/** Read `window.__bobbitState.activeProjectId` from the page. */
async function activeProjectId(page: Page): Promise<string | null> {
	return page.evaluate(() => {
		const s = (window as any).__bobbitState || (window as any).bobbitState;
		return s ? (s.activeProjectId ?? null) : null;
	});
}

test.describe("Spawned Child — Open goal navigation", () => {
	test.beforeEach(async () => {
		await setSubgoalsFlag(true);
	});

	test("active child: click navigates to #/goal/<childId> and dashboard renders @smoke", async ({ page }) => {
		const projectId = await defaultProjectId();
		const parent = await createGoal({ title: "Open-goal parent", projectId, team: false });
		const childResp = await apiFetch(`/api/goals/${parent.id}/spawn-child`, {
			method: "POST",
			body: JSON.stringify({
				planId: "p-active",
				title: "Active child",
				spec: "spawned-child open-goal navigation E2E — active child goal padded to meet spec validator length.",
			}),
		});
		expect(childResp.status).toBe(201);
		const child = await childResp.json() as { id: string };

		await openApp(page);
		// Land on the parent dashboard so the previous route is concrete.
		await navigateToHash(page, `#/goal/${parent.id}`);
		await expect(page.locator(".dashboard-container")).toBeVisible({ timeout: 15_000 });

		await mountSpawnChild(page, child.id, { title: "Active child" });
		await clickOpenGoal(page);

		await expect.poll(
			() => page.evaluate(() => window.location.hash),
			{ timeout: 10_000 },
		).toBe(`#/goal/${child.id}`);

		await expect(page.locator("[data-testid='goal-dashboard']")).toBeVisible({ timeout: 15_000 });
	});

	test("cross-project child: activeProjectId switches to the child's project", async ({ page }) => {
		const parentProjectId = await defaultProjectId();
		const parent = await createGoal({ title: "Cross-project parent", projectId: parentProjectId, team: false });

		// Create an entirely separate project to host the child goal.
		const childProjectDir = mkdtempSync(join(tmpdir(), "bobbit-open-goal-xp-"));
		const projResp = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: `open-goal-xp-${Date.now()}`, rootPath: childProjectDir }),
		});
		expect(projResp.status).toBe(201);
		const childProject = await projResp.json() as { id: string };

		const child = await createGoal({
			title: "Cross-project child",
			projectId: childProject.id,
			team: false,
		});

		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${parent.id}`);
			await expect(page.locator(".dashboard-container")).toBeVisible({ timeout: 15_000 });
			// Confirm the active project is the parent's project before clicking.
			expect(await activeProjectId(page)).toBe(parentProjectId);

			await mountSpawnChild(page, child.id, { title: "Cross-project child" });
			await clickOpenGoal(page);

			await expect.poll(
				() => page.evaluate(() => window.location.hash),
				{ timeout: 10_000 },
			).toBe(`#/goal/${child.id}`);
			await expect(page.locator("[data-testid='goal-dashboard']")).toBeVisible({ timeout: 15_000 });

			await expect.poll(
				() => activeProjectId(page),
				{ timeout: 10_000 },
			).toBe(childProject.id);
		} finally {
			await deleteGoal(child.id).catch(() => {});
			await apiFetch(`/api/projects/${childProject.id}`, { method: "DELETE" }).catch(() => {});
			try { rmSync(childProjectDir, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	});

	test("archived child: dashboard renders with archived badge", async ({ page }) => {
		const projectId = await defaultProjectId();
		const parent = await createGoal({ title: "Archived parent", projectId, team: false });
		const childResp = await apiFetch(`/api/goals/${parent.id}/spawn-child`, {
			method: "POST",
			body: JSON.stringify({
				planId: "p-archived",
				title: "Archived child",
				spec: "spawned-child open-goal navigation E2E — archived child goal padded to meet spec validator length.",
			}),
		});
		expect(childResp.status).toBe(201);
		const child = await childResp.json() as { id: string };

		// Archive the child via the same REST surface deleteGoal uses.
		const archResp = await apiFetch(`/api/goals/${child.id}?cascade=true`, { method: "DELETE" });
		expect(archResp.status).toBeLessThan(400);

		await openApp(page);
		await navigateToHash(page, `#/goal/${parent.id}`);
		await expect(page.locator(".dashboard-container")).toBeVisible({ timeout: 15_000 });

		await mountSpawnChild(page, child.id, { title: "Archived child" });
		await clickOpenGoal(page);

		await expect.poll(
			() => page.evaluate(() => window.location.hash),
			{ timeout: 10_000 },
		).toBe(`#/goal/${child.id}`);
		await expect(page.locator("[data-testid='goal-dashboard']")).toBeVisible({ timeout: 15_000 });

		// Existing "Archived" pill/button (renderTeamButton / renderSessionButton).
		await expect(
			page.locator("[data-testid='goal-dashboard']").getByText("Archived", { exact: true }).first(),
		).toBeVisible({ timeout: 10_000 });
	});

	test("resolvable child: navigation produces no console errors (blocked-state proxy)", async ({ page }) => {
		// `state: "blocked"` goals are routed identically to active goals
		// (per design § Archived / blocked behavior). The bar here is that
		// the dashboard's tab-visibility helpers do not crash on the
		// resolvable child. We capture console errors throughout the click
		// and assert none fire.
		const projectId = await defaultProjectId();
		const parent = await createGoal({ title: "Blocked-proxy parent", projectId, team: false });
		const childResp = await apiFetch(`/api/goals/${parent.id}/spawn-child`, {
			method: "POST",
			body: JSON.stringify({
				planId: "p-blocked",
				title: "Blocked-proxy child",
				spec: "spawned-child open-goal navigation E2E — blocked-proxy child padded to meet spec validator length.",
			}),
		});
		expect(childResp.status).toBe(201);
		const child = await childResp.json() as { id: string };

		const consoleErrors: string[] = [];
		page.on("console", (msg) => {
			if (msg.type() === "error") consoleErrors.push(msg.text());
		});
		page.on("pageerror", (err) => {
			consoleErrors.push(String(err?.message || err));
		});

		await openApp(page);
		await navigateToHash(page, `#/goal/${parent.id}`);
		await expect(page.locator(".dashboard-container")).toBeVisible({ timeout: 15_000 });

		await mountSpawnChild(page, child.id, { title: "Blocked-proxy child" });
		await clickOpenGoal(page);

		await expect.poll(
			() => page.evaluate(() => window.location.hash),
			{ timeout: 10_000 },
		).toBe(`#/goal/${child.id}`);
		await expect(page.locator("[data-testid='goal-dashboard']")).toBeVisible({ timeout: 15_000 });

		// Let the browser flush a microtask + animation frame so any deferred
		// dashboard-tab errors propagate before we assert.
		await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => r())));
		// Filter out unrelated harness noise (network 404s during dev loaders).
		const relevant = consoleErrors.filter((line) => /goal|dashboard|tab|undefined|cannot read|null/i.test(line));
		expect(relevant, `Unexpected console errors during open-goal: ${relevant.join("\n")}`).toEqual([]);
	});

	test("missing/purged child: shows toast and does not fall through to landing", async ({ page }) => {
		const projectId = await defaultProjectId();
		const parent = await createGoal({ title: "Missing-child parent", projectId, team: false });
		// A well-formed UUID that the server has never seen. Hex-only to
		// satisfy the `[a-f0-9-]+` route regex used by `setHashRoute`.
		const missingId = "deadbeef-0000-4000-8000-000000000000";

		await openApp(page);
		await navigateToHash(page, `#/goal/${parent.id}`);
		await expect(page.locator(".dashboard-container")).toBeVisible({ timeout: 15_000 });
		const parentHash = await page.evaluate(() => window.location.hash);
		expect(parentHash).toBe(`#/goal/${parent.id}`);

		await mountSpawnChild(page, missingId, { title: "Purged child" });
		await clickOpenGoal(page);

		// Toast must appear with the exact `id=<first 8 chars>` text.
		const toast = page.locator("[data-testid='header-toast']");
		await expect(toast).toBeVisible({ timeout: 10_000 });
		await expect(toast).toHaveText(`Goal no longer exists (id=${SHORT(missingId)})`);

		// We must NOT have fallen through to the empty landing view. Either
		// the hash was restored to the previous concrete route, or — at
		// worst — the in-memory view still renders a dashboard. Both are
		// acceptable per the design doc; landing (`#/` or empty hash) is not.
		const hashAfter = await page.evaluate(() => window.location.hash);
		expect(hashAfter, "hash must not collapse to landing").not.toBe("#/");
		expect(hashAfter, "hash must not be empty").not.toBe("");

		// The landing splash carries the well-known empty-state copy. It
		// must be absent regardless of the exact post-toast hash form.
		await expect(
			page.getByText(/Select a session from the sidebar or create a new one/i),
		).toHaveCount(0);
	});
});
