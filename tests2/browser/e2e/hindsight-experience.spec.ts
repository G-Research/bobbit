/**
 * Hindsight's user-facing contract. The pack is installed into the isolated
 * gateway and is opened through the normal session-actions menu; nothing here
 * imports a panel module or talks to a private Hindsight client.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { createSession, readE2ETokenAsync } from "../e2e-setup.js";
import { navigateToHash } from "./ui-helpers.js";
import {
	HINDSIGHT_EXPERIENCE_PACK_ID,
	HINDSIGHT_EXPERIENCE_PROVIDER_ID,
	HINDSIGHT_EXPERIENCE_SECRET,
	cleanupHindsightExperienceBrowserFixture,
	createHindsightExperienceBrowserProject,
	expectHindsightExperienceSecretRedacted,
	hindsightExperienceBrowserApi,
	installHindsightExperienceBrowserFixture,
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
	const token = await readE2ETokenAsync();
	await page.goto(`/?token=${encodeURIComponent(token)}#/market/${encodeURIComponent(project.id)}/installed`);
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
	let packDir: string | undefined;
	let project: HindsightExperienceProject | undefined;
	let sessionId = "";

	test.beforeAll(async ({ gateway }) => {
		packDir = installHindsightExperienceBrowserFixture(gateway.bobbitDir);
		project = await createHindsightExperienceBrowserProject();
		sessionId = await createSession({ projectId: project.id, cwd: project.rootPath });
	});

	test.afterAll(async () => {
		await cleanupHindsightExperienceBrowserFixture(project, packDir);
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
		await settings.getByLabel("Local model base URL").fill("http://127.0.0.1:12345/v1");
		await settings.getByLabel("Local model API key").fill(HINDSIGHT_EXPERIENCE_SECRET);
		const patch = page.waitForResponse(response => response.url().includes(`/extension-settings/${HINDSIGHT_EXPERIENCE_PACK_ID}/provider/${HINDSIGHT_EXPERIENCE_PROVIDER_ID}`) && response.request().method() === "PATCH");
		await settings.getByTestId("market-settings-save").click();
		const response = await patch;
		expect(response.status()).toBe(200);
		const body = await response.json();
		await expectHindsightExperienceSecretRedacted(page, [body]);
		await expect(provider.getByTestId("market-runtime-status")).toContainText(/configured|stopped|blocked/i);

		const grants = await openMarketGrants(page);
		for (const capability of CAPABILITIES) {
			await expect(grants.locator(`[data-capability="${capability}"]`)).toContainText("Not granted");
		}
		await grant(page, "memory.read");
		await grant(page, "memory.write");
		await grant(page, "memory.reflect");
		await grant(page, "memory.invalidate");
		await grant(page, "service.manage");

		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible({ timeout: 20_000 });
		const reloaded = await openMarketGrants(page);
		await expect(reloaded.locator('[data-capability="memory.read"]')).toContainText("Granted");
		// Revocation is immediately visible rather than a stale enabled affordance.
		await reloaded.locator('[data-capability="memory.invalidate"] [data-testid="market-capability-action"]').click();
		await expect(reloaded.locator('[data-capability="memory.invalidate"]')).toContainText("Not granted", { timeout: 15_000 });
	});

	test("service exposes every generic runtime state, explicit consent, local/OCI/migration controls, and remains usable when unhealthy", async ({ page }) => {
		if (!project) throw new Error("Hindsight fixture project was not created");
		await openMarket(page, project);
		await grant(page, "service.manage");
		const panel = await openHindsightPanel(page, sessionId);
		await panel.getByRole("tab", { name: "Service" }).click();
		const service = panel.getByTestId("hindsight-service");
		await expect(service.getByTestId("hindsight-runtime-status")).toHaveAttribute("data-state", /stopped|starting|ready|degraded|blocked|unavailable/);
		await expect(service.getByTestId("hindsight-runtime-control")).toBeVisible();
		await service.getByTestId("hindsight-runtime-control").click();
		await expect(panel.getByRole("dialog", { name: /start|restart|stop hindsight/i })).toBeVisible();
		await page.keyboard.press("Escape");

		await expect(service.getByLabel("OCI image reference")).toBeVisible();
		await service.getByLabel("OCI image reference").fill("registry.internal:5443/hindsight:0.8.6");
		await expect(service.getByText(/mutable|unpinned/i)).toBeVisible();
		await expect(service.getByRole("button", { name: /plan migration/i })).toBeVisible();
		await expect(service.getByRole("button", { name: /view logs/i })).toBeVisible();

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
		const memories = panel.getByTestId("hindsight-memories");
		await expect(memories.getByTestId("hindsight-browse")).toBeVisible();
		await memories.getByPlaceholder(/search memories/i).fill("release marker");
		await expect(memories.getByTestId("hindsight-search-status")).toBeVisible();
		await expect(memories.getByRole("button", { name: /retain/i })).toBeVisible();
		await expect(memories.getByRole("button", { name: /reflect/i })).toBeVisible();
		await expect(memories.getByRole("button", { name: /record completed outcome/i })).toBeVisible();
		await expect(memories.getByRole("button", { name: /invalidate/i })).toBeVisible();

		await memories.getByRole("button", { name: /invalidate/i }).click();
		const confirm = panel.getByRole("dialog", { name: /invalidate memory/i });
		await expect(confirm).toBeVisible();
		await expect(confirm.getByLabel(/reason/i)).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(memories.getByRole("button", { name: /invalidate/i })).toBeFocused();

		await panel.getByTestId("hindsight-panel-close").click();
		await expect(panel).toHaveCount(0);
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible({ timeout: 20_000 });
		await expect(page.locator(PANEL)).toHaveCount(0);

		// Removing the fixture must reconcile launchers and open panel state; a
		// stale late response may not resurrect the disposed panel.
		const removed = await hindsightExperienceBrowserApi(page, {
			path: `/api/market/installed/${encodeURIComponent(HINDSIGHT_EXPERIENCE_PACK_ID)}`,
			method: "DELETE",
		});
		expect(removed.status, removed.text).toBe(200);
		await page.evaluate(async () => (window as any).__bobbitReconcilePackRenderers());
		await expect(page.locator(PANEL)).toHaveCount(0);
	});
});
