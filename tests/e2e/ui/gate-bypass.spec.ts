/**
 * Browser E2E for the human-only "bypass gate" capability in the chat-header
 * `<goal-status-widget>`.
 *
 * Covers (design §10 / E2E plan):
 *   - Bypass button visible on a pending/failed gate, absent on a passed gate.
 *   - Inline bypass form collects whyBypassed + whoAmI and POSTs the bypass
 *     endpoint with isInitiatedByHuman:true.
 *   - The bypassed gate row shows the bypassed icon/state + why/who text.
 *   - The header pill + sidebar badge turn red and gain a trailing `!`, and the
 *     numerator counts the bypassed gate (visual differentiation).
 *   - The Confirm-completion button appears only once a gate is bypassed.
 *   - Bypassed state + red badge persist across reload.
 *
 * The bypass + gates + summary endpoints are mocked via page.route so the test
 * is self-contained and deterministic; the cross-slice JSON contract it asserts
 * against is pinned by the API E2E suite (criteria 1–8).
 */
import { test, expect, type Page, type Route } from "../gateway-harness.js";
import { apiFetch, createGoal, createSession, deleteGoal, deleteSession } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

const FAILED_GATE_ID = "implementation";
const FAILED_GATE_NAME = "Implementation";
const WHY = "Verification step requires hardware we do not have in CI; manually verified on staging.";
const WHO = "Jamie (overseer)";
const RED_RGB = "rgb(220, 38, 38)"; // #dc2626

interface GateRecord {
	gateId: string;
	name: string;
	status: "pending" | "passed" | "failed" | "bypassed";
	whyBypassed?: string;
	whoAmI?: string;
	bypassedAt?: string;
}

interface MockState {
	gates: GateRecord[];
}

/** Mock /gates (non-summary + summary view), /verifications/active, and the
 *  /bypass endpoint for a goal. The closure-held `state` survives reloads so
 *  the bypassed gate persists. Returns captured bypass POST bodies. */
async function installBypassMocks(page: Page, goalId: string): Promise<{ bypassCalls: Array<Record<string, unknown>> }> {
	const state: MockState = {
		gates: [
			{ gateId: "design-doc", name: "Design Doc", status: "passed" },
			{ gateId: FAILED_GATE_ID, name: FAILED_GATE_NAME, status: "failed" },
			{ gateId: "ready-to-merge", name: "Ready to Merge", status: "pending" },
		],
	};
	const bypassCalls: Array<Record<string, unknown>> = [];

	const summaryBody = () => {
		const passed = state.gates.filter(g => g.status === "passed").length;
		const bypassed = state.gates.filter(g => g.status === "bypassed").length;
		return {
			summary: {
				passed,
				bypassed,
				bypassedCount: bypassed,
				total: state.gates.length,
				verifying: false,
				verifyingCount: 0,
				awaitingSignoffCount: 0,
				awaitingHumanSignoff: false,
				runningGateIds: [],
				gates: state.gates.map(g => ({
					gateId: g.gateId,
					name: g.name,
					status: g.status,
					effectiveStatus: g.status === "bypassed" ? "passed" : g.status,
					running: false,
					awaitingSignoffCount: 0,
					dependsOn: [],
					signalCount: 0,
				})),
			},
		};
	};

	const gatesBody = () => ({
		gates: state.gates.map(g => ({
			gateId: g.gateId,
			name: g.name,
			status: g.status,
			signals: [],
			...(g.status === "bypassed" ? { whyBypassed: g.whyBypassed, whoAmI: g.whoAmI, bypassedAt: g.bypassedAt } : {}),
		})),
	});

	const gatesRe = new RegExp(`/api/goals/${goalId}/gates(?:\\?.*)?$`);
	const activeRe = new RegExp(`/api/goals/${goalId}/verifications/active(?:\\?.*)?$`);
	const bypassRe = new RegExp(`/api/goals/${goalId}/gates/[^/]+/bypass$`);

	await page.route(gatesRe, async (route: Route) => {
		if (route.request().method() !== "GET") return route.fallback();
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(route.request().url().includes("view=summary") ? summaryBody() : gatesBody()),
		});
	});

	await page.route(activeRe, async (route: Route) => {
		if (route.request().method() !== "GET") return route.fallback();
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ verifications: [] }) });
	});

	await page.route(bypassRe, async (route: Route) => {
		if (route.request().method() !== "POST") return route.fallback();
		let body: Record<string, unknown> = {};
		try { body = JSON.parse(route.request().postData() || "{}"); } catch { /* ignore */ }
		bypassCalls.push(body);
		const gateId = decodeURIComponent(route.request().url().replace(/\?.*$/, "").split("/").slice(-2, -1)[0]);
		const whyBypassed = typeof body.whyBypassed === "string" ? body.whyBypassed.trim() : "";
		const whoAmI = typeof body.whoAmI === "string" ? body.whoAmI.trim() : "";
		if (body.isInitiatedByHuman !== true) {
			await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "This method is currently intended for human use only." }) });
			return;
		}
		if (!whyBypassed || !whoAmI) {
			await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "whyBypassed and whoAmI are required" }) });
			return;
		}
		const gate = state.gates.find(g => g.gateId === gateId);
		if (!gate) {
			await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: `Unknown gate: ${gateId}` }) });
			return;
		}
		const bypassedAt = String(Date.now());
		gate.status = "bypassed";
		gate.whyBypassed = whyBypassed;
		gate.whoAmI = whoAmI;
		gate.bypassedAt = bypassedAt;
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ ok: true, gateId, status: "bypassed", whyBypassed, whoAmI, bypassedAt }),
		});
	});

	return { bypassCalls };
}

async function openSession(page: Page, sessionId: string): Promise<void> {
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
}

/** Read the red bypassed badge text from a scope (pill or sidebar row). The
 *  bypassed badge is a red span whose text ends with `!`. */
async function bypassedBadge(scope: ReturnType<Page["locator"]>): Promise<{ text: string; color: string } | null> {
	return scope.evaluate((root) => {
		const norm = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim();
		for (const el of Array.from(root.querySelectorAll("span"))) {
			const text = norm(el.textContent);
			if (/^\(\d+\/\d+\)!$/.test(text)) {
				return { text, color: getComputedStyle(el).color };
			}
		}
		return null;
	});
}

test.describe("gate bypass (human-only override)", () => {
	test("bypass a failed gate: button gating, inline form, bypassed row, red badge, confirm-completion, persistence", async ({ page }) => {
		const goal = await createGoal({ title: `Gate-Bypass ${Date.now()}`, workflowId: "test-fast", worktree: false, team: false });
		const goalId = goal.id;
		let sessionId: string | undefined;
		try {
			const { bypassCalls } = await installBypassMocks(page, goalId);
			sessionId = await createSession({ goalId });

			await openApp(page);
			await openSession(page, sessionId);

			const pill = page.locator("[data-testid='goal-status-widget-pill']").first();
			await expect(pill).toBeVisible({ timeout: 15_000 });
			await pill.click();
			await expect(page.locator("[data-testid='goal-widget-gates']")).toBeVisible({ timeout: 5_000 });

			// Bypass button absent on a passed gate; present on the failed gate.
			const passedRow = page.locator('[data-testid="goal-widget-gate"][data-gate-id="design-doc"]');
			await expect(passedRow).toHaveAttribute("data-gate-status", "passed", { timeout: 10_000 });
			await expect(passedRow.locator('[data-testid="goal-widget-gate-bypass"]')).toHaveCount(0);

			const failedRow = page.locator(`[data-testid="goal-widget-gate"][data-gate-id="${FAILED_GATE_ID}"]`);
			await expect(failedRow).toHaveAttribute("data-gate-status", "failed", { timeout: 10_000 });
			const bypassBtn = failedRow.locator('[data-testid="goal-widget-gate-bypass"]');
			await expect(bypassBtn).toBeVisible();

			// Confirm-completion button absent before any gate is bypassed.
			await expect(page.locator("[data-testid='goal-widget-confirm-completion']")).toHaveCount(0);

			// Open the inline bypass form.
			await bypassBtn.click();
			const form = page.locator("[data-testid='goal-widget-bypass-form']");
			await expect(form).toBeVisible({ timeout: 5_000 });

			const confirm = page.locator("[data-testid='goal-widget-bypass-confirm']");
			await expect(confirm).toBeDisabled();

			await page.locator("[data-testid='goal-widget-bypass-why']").fill(WHY);
			await expect(confirm).toBeDisabled(); // still need whoAmI
			await page.locator("[data-testid='goal-widget-bypass-who']").fill(WHO);
			await expect(confirm).toBeEnabled();

			const bypassResp = page.waitForResponse((r) =>
				r.request().method() === "POST"
				&& r.url().includes(`/api/goals/${goalId}/gates/${FAILED_GATE_ID}/bypass`),
				{ timeout: 10_000 },
			);
			await confirm.click();
			const resp = await bypassResp;
			expect(resp.status()).toBe(200);

			// POST body carried the human-only guard + audit fields.
			expect(bypassCalls.length).toBeGreaterThan(0);
			expect(bypassCalls[0]).toMatchObject({ whyBypassed: WHY, whoAmI: WHO, isInitiatedByHuman: true });

			// Gate row now reads bypassed, with the bypassed icon + why/who caption.
			await expect(failedRow).toHaveAttribute("data-gate-status", "bypassed", { timeout: 10_000 });
			await expect(failedRow.locator('svg[aria-label="bypassed"]')).toBeVisible();
			const caption = page.locator("[data-testid='goal-widget-gate-bypass-info']").first();
			await expect(caption).toBeVisible();
			await expect(caption).toContainText(WHO);
			await expect(caption).toContainText(WHY);

			// Bypass button no longer shown on the bypassed row.
			await expect(failedRow.locator('[data-testid="goal-widget-gate-bypass"]')).toHaveCount(0);

			// Confirm-completion button now appears (gating).
			await expect(page.locator("[data-testid='goal-widget-confirm-completion']")).toBeVisible({ timeout: 5_000 });

			// Header pill badge: red, trailing `!`, numerator counts the bypassed gate.
			// design-doc passed (1) + implementation bypassed (1) = 2 of 3.
			await expect.poll(async () => bypassedBadge(pill), { timeout: 10_000, message: "header pill should show a red (2/3)! badge" })
				.toMatchObject({ text: "(2/3)!", color: RED_RGB });

			// Sidebar goal-row badge: same red + `!` treatment.
			const sidebarRow = page.locator(`[data-nav-id="goal:${goalId}"]`).first();
			await expect(sidebarRow).toBeVisible({ timeout: 10_000 });
			await expect.poll(async () => bypassedBadge(sidebarRow), { timeout: 10_000, message: "sidebar goal row should show a red (2/3)! badge" })
				.toMatchObject({ text: "(2/3)!", color: RED_RGB });

			// Persist across reload: bypassed state + red badge survive.
			await page.reload();
			await openSession(page, sessionId);
			const pillAfter = page.locator("[data-testid='goal-status-widget-pill']").first();
			await expect(pillAfter).toBeVisible({ timeout: 15_000 });
			await expect.poll(async () => bypassedBadge(pillAfter), { timeout: 10_000, message: "red bypassed badge should persist after reload" })
				.toMatchObject({ text: "(2/3)!", color: RED_RGB });

			await pillAfter.click();
			await expect(page.locator("[data-testid='goal-widget-gates']")).toBeVisible({ timeout: 5_000 });
			await expect(page.locator(`[data-testid="goal-widget-gate"][data-gate-id="${FAILED_GATE_ID}"]`))
				.toHaveAttribute("data-gate-status", "bypassed", { timeout: 10_000 });
			await expect(page.locator("[data-testid='goal-widget-confirm-completion']")).toBeVisible({ timeout: 5_000 });
		} finally {
			if (sessionId) await deleteSession(sessionId).catch(() => { /* ignore */ });
			await deleteGoal(goalId).catch(() => { /* ignore */ });
			await apiFetch("/api/health").catch(() => { /* keep harness happy */ });
		}
	});
});
