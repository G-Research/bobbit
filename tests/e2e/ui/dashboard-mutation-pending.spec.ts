/**
 * Dashboard mutation-pending approval card + restart-safe rehydration E2E.
 *
 * Spec: approval surfaces are the in-chat `<mutation-pending-card>` AND a
 * dashboard mutation-pending card, both hitting
 * `POST /api/goals/:id/mutation/:requestId/decision`; pending requests are
 * persisted (restart-safe). This test exercises the dashboard surface:
 *
 *   1. The card appears on dashboard load, driven by an initial fetch of
 *      `GET /api/goals/:id/mutations/pending` (rehydration).
 *   2. It SURVIVES a reload (re-fetched from the same endpoint).
 *   3. Approve / reject posts the decision and clears the card.
 *
 * The pending request and the decision POST are stubbed with `page.route`
 * (same pattern as plan-tab-gate-status.spec.ts) so the test stays
 * deterministic without driving a real frozen-plan expansion through the
 * classifier. The endpoint itself is unit-tested in
 * tests/api-goals-mutations-pending.test.ts.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createGoal, defaultProjectId } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

test.describe("Dashboard mutation-pending card", () => {
	let goalId = "";

	test.beforeEach(async () => {
		const projectId = await defaultProjectId();
		const goal = await createGoal({ title: "Goal w/ pending mutation", projectId, team: false });
		goalId = goal.id as string;
	});

	test.afterEach(async () => {
		try { await apiFetch(`/api/goals/${goalId}?cascade=true`, { method: "DELETE" }); } catch { /* */ }
	});

	/**
	 * Stub the pending-mutations endpoint with a single expansion request.
	 * `active()` controls whether the request is still pending (so an approve
	 * /reject can flip it to empty, mimicking the server removing it).
	 */
	async function stubPending(page: Page, requestId: string, active: () => boolean): Promise<void> {
		await page.route(/\/api\/goals\/[^/]+\/mutations\/pending(?:\?.*)?$/, async (route, req) => {
			if (req.method() !== "GET") return route.fallback();
			const pending = active()
				? [{
					requestId,
					goalId,
					kind: "expansion",
					summary: "Add a verification step for the new auth flow",
					diff: { added: [], removed: [], changed: [] },
					proposedSteps: [],
					createdAt: Date.now(),
					expiresAt: Date.now() + 60_000,
				}]
				: [];
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ pending }) });
		});
	}

	test("card appears on load, survives reload, and clears on approve", async ({ page }) => {
		const requestId = "req-approve-1";
		let pendingActive = true;
		await stubPending(page, requestId, () => pendingActive);

		// Stub the decision POST so it never needs real authz; flip pending off.
		await page.route(/\/api\/goals\/[^/]+\/mutation\/[^/]+\/decision$/, async (route, req) => {
			if (req.method() !== "POST") return route.fallback();
			pendingActive = false;
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ applied: true }) });
		});

		await openApp(page);
		await navigateToHash(page, `#/goal/${goalId}`);

		// 1. Card appears from the initial rehydration fetch.
		const card = page.locator('[data-testid="dashboard-mutation-pending-card"]').first();
		await expect(card).toBeVisible({ timeout: 15_000 });
		await expect(page.locator('[data-testid="dashboard-mutation-pending-summary"]').first())
			.toContainText("Add a verification step");

		// 2. Survives reload (re-fetched from the endpoint).
		await page.reload();
		await navigateToHash(page, `#/goal/${goalId}`);
		await expect(page.locator('[data-testid="dashboard-mutation-pending-card"]').first())
			.toBeVisible({ timeout: 15_000 });

		// 3. Approve posts the decision and clears the card.
		await page.locator('[data-testid="dashboard-mutation-pending-approve"]').first().click();
		await expect(page.locator('[data-testid="dashboard-mutation-pending-card"]')).toHaveCount(0, { timeout: 10_000 });
	});

	test("reject clears the card", async ({ page }) => {
		const requestId = "req-reject-1";
		let pendingActive = true;
		await stubPending(page, requestId, () => pendingActive);
		await page.route(/\/api\/goals\/[^/]+\/mutation\/[^/]+\/decision$/, async (route, req) => {
			if (req.method() !== "POST") return route.fallback();
			pendingActive = false;
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ applied: false }) });
		});

		await openApp(page);
		await navigateToHash(page, `#/goal/${goalId}`);

		await expect(page.locator('[data-testid="dashboard-mutation-pending-card"]').first())
			.toBeVisible({ timeout: 15_000 });

		await page.locator('[data-testid="dashboard-mutation-pending-reject"]').first().click();
		await expect(page.locator('[data-testid="dashboard-mutation-pending-card"]')).toHaveCount(0, { timeout: 10_000 });
	});

	test("card is NOT cleared when the decision POST returns a non-OK status", async ({ page }) => {
		const requestId = "req-nonok-1";
		// Pending stays active for the whole test — the server never removes it
		// because the decision is rejected with a 409.
		await stubPending(page, requestId, () => true);

		let decisionPosts = 0;
		// `gatewayFetch` resolves (does not throw) for 4xx/5xx, so the client must
		// inspect `res.ok` and keep the card when the decision is refused.
		await page.route(/\/api\/goals\/[^/]+\/mutation\/[^/]+\/decision$/, async (route, req) => {
			if (req.method() !== "POST") return route.fallback();
			decisionPosts++;
			await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "RESTRUCTURE_REQUIRES_PAUSE" }) });
		});

		await openApp(page);
		await navigateToHash(page, `#/goal/${goalId}`);

		const card = page.locator('[data-testid="dashboard-mutation-pending-card"]').first();
		await expect(card).toBeVisible({ timeout: 15_000 });

		// The non-OK handler logs `[dashboard-mutation] decision failed: HTTP …`.
		// Wait for that console error so we know the decision response has been
		// fully processed by the client (any optimistic-clear would have fired by
		// now) — event-driven, no hardcoded sleep.
		const decisionFailedLog = page.waitForEvent("console", {
			predicate: (msg) => msg.text().includes("[dashboard-mutation] decision failed"),
			timeout: 10_000,
		});

		await page.locator('[data-testid="dashboard-mutation-pending-approve"]').first().click();

		// The POST happened…
		await expect.poll(() => decisionPosts, { timeout: 10_000 }).toBeGreaterThan(0);
		// …and the client finished handling the non-OK response.
		await decisionFailedLog;
		// …but the card MUST remain because the response was non-OK.
		await expect(card).toBeVisible();
	});
});
