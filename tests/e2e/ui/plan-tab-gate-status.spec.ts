/**
 * Plan-tab per-node gate status + merge/conflict E2E (Phase 5c).
 *
 * The backend stamps each descendant with `gateStatus`
 * ("pending"|"running"|"passed"|"failed") and `mergeConflict` (boolean).
 * The Plan-tab node renderer surfaces them as:
 *   - `data-plan-gate-status` on the node `<g>` + a `plan-node-gate-dot`
 *   - `data-plan-conflict="true"` + a `plan-node-conflict-pill` (mirror of
 *     the existing `plan-node-archived-pill`) shown only on conflict.
 *
 * This test creates a real parent+child via REST, archives the child (so
 * it is sourced exclusively from `GET /descendants` rather than the live
 * `state.goals` feed, which would otherwise shadow our injected fields),
 * then patches the live `/descendants` response to inject the two fields —
 * exercising the real render path with a realistic data shape without
 * depending on the backend producing a real merge conflict.
 *
 * Reference: tests/e2e/ui/plan-tab-archived-children.spec.ts.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createGoal, defaultProjectId } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

test.describe("Plan tab — per-node gate status + merge/conflict", () => {
	let parentId = "";
	let childId = "";

	test.beforeEach(async () => {
		const projectId = await defaultProjectId();
		const parent = await createGoal({ title: "Parent w/ gated child", projectId, team: false });
		parentId = parent.id as string;
		const r1 = await apiFetch(`/api/goals/${parentId}/spawn-child`, {
			method: "POST",
			body: JSON.stringify({ planId: "p1", title: "Child A", spec: "child a spec: plan-tab gate-status UI test, padded to satisfy the spec validator minimum length requirement here." }),
		});
		expect(r1.status).toBe(201);
		childId = (await r1.json()).id as string;
		// Archive the child so the Plan tab sources it from GET /descendants
		// (live state.goals would otherwise shadow our injected fields).
		const arch = await apiFetch(`/api/goals/${childId}?cascade=true`, { method: "DELETE" });
		expect([200, 204]).toContain(arch.status);
	});

	test.afterEach(async () => {
		try { await apiFetch(`/api/goals/${parentId}?cascade=true`, { method: "DELETE" }); } catch { /* */ }
	});

	/** Patch the /descendants response to stamp the child with the given fields. */
	async function injectChildFields(page: Page, fields: { gateStatus?: string; mergeConflict?: boolean }): Promise<void> {
		await page.route(/\/api\/goals\/[^/]+\/descendants(?:\?.*)?$/, async (route, req) => {
			if (req.method() !== "GET") return route.fallback();
			const resp = await route.fetch();
			const body = await resp.json() as { goals?: Array<{ id: string; [k: string]: unknown }> };
			for (const g of body.goals ?? []) {
				if (g.id === childId) Object.assign(g, fields);
			}
			await route.fulfill({ response: resp, json: body });
		});
	}

	test("node renders gate-status dot + conflict pill from descendant fields", async ({ page }) => {
		await injectChildFields(page, { gateStatus: "failed", mergeConflict: true });

		await openApp(page);
		await navigateToHash(page, `#/goal/${parentId}`);

		const planTab = page.locator('[data-testid="tab-plan"]').first();
		await expect(planTab).toBeVisible({ timeout: 15_000 });
		await planTab.click();

		await expect(page.locator('[data-testid="plan-tab"]').first()).toBeVisible({ timeout: 5_000 });

		// The node carrying the injected child must expose the gate-status +
		// conflict data attributes.
		const node = page.locator(`[data-testid="plan-node"][data-child-goal-id="${childId}"]`).first();
		await expect(node).toBeVisible({ timeout: 10_000 });
		await expect(node).toHaveAttribute("data-plan-gate-status", "failed");
		await expect(node).toHaveAttribute("data-plan-conflict", "true");

		// Gate-status dot + conflict pill render inside the node.
		await expect(page.locator('[data-testid="plan-node-gate-dot"][data-gate-status="failed"]').first())
			.toBeVisible({ timeout: 5_000 });
		await expect(page.locator('[data-testid="plan-node-conflict-pill"]').first())
			.toBeVisible({ timeout: 5_000 });
	});

	test("running gate shows dot but no conflict pill, persists across reload", async ({ page }) => {
		await injectChildFields(page, { gateStatus: "running", mergeConflict: false });

		await openApp(page);
		await navigateToHash(page, `#/goal/${parentId}`);
		await page.locator('[data-testid="tab-plan"]').first().click();
		await expect(page.locator('[data-testid="plan-node-gate-dot"][data-gate-status="running"]').first())
			.toBeVisible({ timeout: 10_000 });
		// Running, not conflicted — no conflict pill.
		await expect(page.locator('[data-testid="plan-node-conflict-pill"]')).toHaveCount(0);

		// page.route registrations survive reload in Playwright.
		await page.reload();
		await navigateToHash(page, `#/goal/${parentId}`);
		await page.locator('[data-testid="tab-plan"]').first().click();
		await expect(
			page.locator('[data-testid="plan-node-gate-dot"][data-gate-status="running"]').first(),
		).toBeVisible({ timeout: 10_000 });
	});
});
