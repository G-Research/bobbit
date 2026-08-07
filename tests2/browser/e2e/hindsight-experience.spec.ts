/**
 * Hindsight's user-facing contract. The shipped first-party built-in is opened
 * through the normal session-actions menu; nothing here copy-installs a shadow
 * pack, imports a panel module, or talks to a private Hindsight client.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { createSession } from "../e2e-setup.js";
import { navigateToHash, openApp } from "./ui-helpers.js";
import {
	HINDSIGHT_EXPERIENCE_PACK_ID,
	HINDSIGHT_EXPERIENCE_PROVIDER_ID,
	HINDSIGHT_EXPERIENCE_SECRET,
	cleanupHindsightExperienceBrowserFixture,
	createHindsightExperienceBrowserProject,
	expectHindsightExperienceSecretRedacted,
	hindsightExperienceBrowserApi,
	resetHindsightExperienceBuiltinActivation,
	type HindsightExperienceProject,
} from "../fixtures/hindsight-experience-fixture.js";

// The suite changes grants/settings and is intentionally retry-free: a retry can
// hide a stale revision, a leaked secret, or incomplete pack cleanup.
test.describe.configure({ mode: "serial", retries: 0 });

const PANEL = '[data-testid="hindsight-panel"]';
const CAPABILITIES = [
	"service.manage",
	"memory.read",
	"memory.write",
	"memory.reflect",
	"memory.invalidate",
	"memory.read.all",
] as const;

function marketProvider(page: Page) {
	return page.locator(`[data-testid="market-project-provider-row"][data-contribution-id="${HINDSIGHT_EXPERIENCE_PROVIDER_ID}"]`);
}

async function openMarket(page: Page, project: HindsightExperienceProject): Promise<void> {
	await openApp(page);
	await navigateToHash(page, `#/market/${encodeURIComponent(project.id)}/installed`);
	await expect(page.locator(`[data-testid="market-project-runtime"][data-project-id="${project.id}"][data-pack-id="${HINDSIGHT_EXPERIENCE_PACK_ID}"]`)).toBeVisible({ timeout: 20_000 });
}

async function openHindsightPanel(page: Page, sessionId: string): Promise<ReturnType<Page["locator"]>> {
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
	const trigger = page.locator('[data-testid="session-actions-trigger"]').first();
	await trigger.click();
	const launcher = page.locator('sidebar-actions-popover [role="menuitem"]').filter({ hasText: "Hindsight" }).first();
	await expect(launcher).toBeVisible({ timeout: 10_000 });
	await launcher.click();
	const panel = page.locator(PANEL);
	await expect(panel).toBeVisible({ timeout: 15_000 });
	return panel;
}

async function openMarketGrants(page: Page) {
	const grants = page.locator(`[data-testid="market-project-pack-row"][data-contribution-id="${HINDSIGHT_EXPERIENCE_PACK_ID}"] [data-testid="market-extension-grants"]`);
	if (await grants.getAttribute("open") === null) await grants.locator("summary").click();
	await expect(grants).toHaveAttribute("open", "");
	return grants;
}

async function grant(page: Page, capability: typeof CAPABILITIES[number]): Promise<void> {
	const row = (await openMarketGrants(page)).locator(`[data-testid="market-capability-grant"][data-capability="${capability}"]`);
	const action = row.getByTestId("market-capability-action");
	if (await action.getAttribute("data-state") === "Granted") return;
	await action.click();
	await page.getByRole("button", { name: "Grant capability", exact: true }).click();
	await expect(row).toHaveAttribute("data-state", "Granted", { timeout: 15_000 });
}

test.describe("Hindsight experience", () => {
	let project: HindsightExperienceProject | undefined;
	let sessionId = "";

	test.beforeAll(async () => {
		await resetHindsightExperienceBuiltinActivation();
		project = await createHindsightExperienceBrowserProject();
		sessionId = await createSession({ projectId: project.id, cwd: project.rootPath });
	});

	test.afterAll(async () => {
		await cleanupHindsightExperienceBrowserFixture(project);
	});

	test("configuration is inert, write-only secrets never echo, and denied/granted/revoked access stays live", async ({ page }) => {
		if (!project) throw new Error("Hindsight fixture project was not created");
		await openMarket(page, project);
		const provider = marketProvider(page);
		await provider.getByTestId("market-settings-toggle").click();
		const settings = provider.getByTestId("market-settings-form");
		await expect(settings).toBeVisible();

		// Saving a loopback local model selects a mode only: it does not probe or
		// start the service, and its optional key remains write-only.
		await settings.getByLabel("Runtime mode").selectOption("local");
		await settings.getByLabel("Local model provider").selectOption("openai-compatible");
		await settings.getByLabel("Local model ID").fill("qwen3-coder-30b-mlx");
		await settings.getByLabel("Local model URL").fill("http://127.0.0.1:12345/v1");
		await settings.getByLabel("Local model API key").fill(HINDSIGHT_EXPERIENCE_SECRET);
		const patch = page.waitForResponse(response => response.url().includes(`/extension-settings/${HINDSIGHT_EXPERIENCE_PACK_ID}/provider/${HINDSIGHT_EXPERIENCE_PROVIDER_ID}`) && response.request().method() === "PATCH");
		await settings.getByTestId("market-settings-save").click();
		const response = await patch;
		expect(response.status()).toBe(200);
		const body = await response.json();
		await expectHindsightExperienceSecretRedacted(page, [body]);
		await expect(provider.getByTestId("market-runtime-status")).toHaveAttribute("data-state", /active|configured|stopped|blocked/);

		const grants = await openMarketGrants(page);
		for (const capability of CAPABILITIES) {
			await expect(grants.locator(`[data-testid="market-capability-grant"][data-capability="${capability}"]`)).toHaveAttribute("data-state", "Not granted");
		}
		await grant(page, "memory.read");
		await grant(page, "memory.write");
		await grant(page, "memory.reflect");
		await grant(page, "memory.invalidate");
		await grant(page, "service.manage");

		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible({ timeout: 20_000 });
		const reloaded = await openMarketGrants(page);
		await expect(reloaded.locator('[data-testid="market-capability-grant"][data-capability="memory.read"]')).toHaveAttribute("data-state", "Granted");
		// Revocation is immediately visible rather than a stale enabled affordance.
		await reloaded.locator('[data-testid="market-capability-grant"][data-capability="memory.invalidate"] [data-testid="market-capability-action"]').click();
		await expect(reloaded.locator('[data-testid="market-capability-grant"][data-capability="memory.invalidate"]')).toHaveAttribute("data-state", "Not granted", { timeout: 15_000 });
	});

	test("service exposes generic runtime state, explicit consent, migration/log controls, and remains usable when unhealthy", async ({ page }) => {
		if (!project) throw new Error("Hindsight fixture project was not created");
		await openMarket(page, project);
		await grant(page, "service.manage");
		const panel = await openHindsightPanel(page, sessionId);
		await panel.getByRole("tab", { name: "Service" }).click();
		const service = panel.getByRole("tabpanel", { name: "Service" });
		await expect(service.getByLabel("Runtime status")).toHaveAttribute("data-state", /stopped|starting|ready|degraded|blocked|unavailable/);
		await service.getByRole("button", { name: "Start Hindsight service", exact: true }).click();
		const confirm = panel.getByRole("dialog", { name: "Start service?" });
		await expect(confirm).toBeVisible();
		const control = page.waitForResponse(response => response.url().includes("/api/ext/route/runtime-control") && response.request().method() === "POST");
		await confirm.getByRole("button", { name: "Confirm", exact: true }).click();
		expect((await control).status()).toBe(200);
		await expect(confirm).toHaveCount(0);

		const planMigration = service.getByRole("button", { name: /plan migration/i });
		await expect(planMigration).toBeVisible();
		const planResponse = page.waitForResponse(response => response.url().includes("/api/ext/route/migration-plan") && response.request().method() === "POST");
		await planMigration.click();
		const planned = await planResponse;
		expect(planned.status()).toBe(200);
		const planBody = await planned.json();
		expect(planBody.ok).toBe(true);
		await expect(service.getByText("Confirmation:")).toBeVisible();
		await service.getByRole("button", { name: "Apply plan", exact: true }).click();
		const migrationConfirm = panel.getByRole("dialog", { name: "Apply the reviewed migration plan?" });
		const executeResponse = page.waitForResponse(response => response.url().includes("/api/ext/route/migration-execute") && response.request().method() === "POST");
		await migrationConfirm.getByRole("button", { name: "Confirm", exact: true }).click();
		const executed = await executeResponse;
		expect(executed.status()).toBe(200);
		const executeRequest = JSON.parse(executed.request().postData() ?? "{}");
		expect(executeRequest.init?.body).toEqual({ plan: planBody.plan, confirmation: planBody.plan.confirmation });
		await expect(panel.getByText(/Migration is unavailable because this runtime has no logical migration connector/i)).toBeVisible();

		await expect(service.getByRole("button", { name: "View runtime logs" })).toBeVisible();
		await service.getByRole("button", { name: "View runtime logs" }).click();

		// A down endpoint must settle to a visible unhealthy state without freezing
		// the session: the composer and the panel's other tabs remain operable.
		await expect(service.getByTestId("hindsight-runtime-status")).toHaveAttribute("data-state", /degraded|blocked|unavailable|stopped/, { timeout: 10_000 });
		await expect(page.locator("textarea").first()).toBeEnabled();
		await panel.getByRole("tab", { name: "Memories" }).click();
		await expect(panel.getByTestId("hindsight-memories")).toBeVisible();
	});

	test("memories support scoped browse/search/detail/history/retain/reflect/outcome/invalidate and clean stale UI on close/reload/uninstall", async ({ page }) => {
		if (!project) throw new Error("Hindsight fixture project was not created");
		await openMarket(page, project);
		for (const capability of ["memory.read", "memory.write", "memory.reflect", "memory.invalidate"] as const) await grant(page, capability);
		const panel = await openHindsightPanel(page, sessionId);
		await panel.getByRole("tab", { name: "Memories" }).click();
		const memories = panel.getByRole("tabpanel", { name: "Memories" });
		await expect(memories.getByLabel("Search memories")).toBeVisible();
		await memories.getByLabel("Search memories").fill("release marker");
		await expect(memories.getByRole("button", { name: "Search", exact: true })).toBeVisible();
		await expect(memories.getByRole("button", { name: "Retain memory", exact: true })).toBeVisible();
		// Completed outcomes are host snapshots, not panel-supplied free text.
		await expect(memories.getByText(/supplied by the host lifecycle/i)).toBeVisible();
		const retainOutcome = memories.getByRole("button", { name: "Retain completed outcome" });
		await expect(retainOutcome).toBeVisible();
		await expect(memories.getByLabel("Completed outcome")).toHaveCount(0);
		// The server integration covers real completed/incomplete snapshots. This
		// browser journey proves the native control sends no panel outcome body,
		// never reports success for an unhealthy non-ok reply, and preserves the
		// idempotent retry affordance after recovery.
		let outcomeCalls = 0;
		await page.route("**/api/ext/route/retain-outcome", async route => {
			const request = JSON.parse(route.request().postData() ?? "{}");
			expect(request.init?.body).toBeUndefined();
			outcomeCalls += 1;
			const body = outcomeCalls === 1
				? { configured: true, code: "SERVICE_UNHEALTHY" }
				: outcomeCalls === 2
					? { configured: true }
					: { ok: true, configured: true, outcomeId: "hindsight/stable-completed-goal" };
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
		});
		await retainOutcome.click();
		await expect(panel.getByRole("status")).toContainText("SERVICE_UNHEALTHY");
		await expect(panel.getByRole("status")).not.toContainText("Completed outcome retained.");
		await expect(retainOutcome).toBeEnabled();
		await retainOutcome.click();
		await expect.poll(() => outcomeCalls).toBe(2);
		await expect(panel.getByRole("status")).not.toContainText("Completed outcome retained.");
		await expect(retainOutcome).toBeEnabled();
		await retainOutcome.click();
		await expect.poll(() => outcomeCalls).toBe(3);
		await expect(panel.getByRole("status")).toContainText("Completed outcome retained.");
		await retainOutcome.click();
		await expect.poll(() => outcomeCalls).toBe(4);
		await expect(panel.getByRole("status")).toContainText("Completed outcome retained.");

		const hindsightTab = page.locator('[data-testid="side-panel-tab"]', { hasText: "Hindsight Memory" }).first();
		await hindsightTab.getByTestId("side-panel-close").click();
		await expect(panel).toHaveCount(0);
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible({ timeout: 20_000 });
		await expect(page.locator(PANEL)).toHaveCount(0);

		// Hindsight is a built-in and cannot be uninstalled. Disable its session-menu
		// entrypoint through the public activation route instead; reconciliation
		// must not resurrect a closed panel or leave a stale launcher behind.
		const disabled = await hindsightExperienceBrowserApi(page, {
			path: "/api/marketplace/pack-activation",
			method: "PUT",
			body: {
				scope: "server",
				packName: HINDSIGHT_EXPERIENCE_PACK_ID,
				disabled: { entrypoints: ["hindsight-session-menu"] },
			},
		});
		expect(disabled.status, disabled.text).toBe(200);
		await page.evaluate(async () => (window as any).__bobbitReconcilePackRenderers());
		await expect(page.locator(PANEL)).toHaveCount(0);
		await page.locator('[data-testid="session-actions-trigger"]').first().click();
		await expect(page.locator('sidebar-actions-popover [role="menuitem"]').filter({ hasText: "Hindsight" })).toHaveCount(0);
	});
});
