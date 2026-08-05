/**
 * Real-browser journey for the active-session Context trace inspector.
 *
 * The fixture pack deliberately returns one context block and one raw provider
 * error. The server records both; this journey proves the UI shows only safe
 * trace metadata, maintains provider order, refreshes from the post-append WS
 * invalidation, and keeps workspace state scoped to the selected session.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createSession, deleteSession, nonGitCwd } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";
import {
	CONTEXT_TRACE_FIXTURE_PACK,
	RAW_CONTEXT_PAYLOAD,
	RAW_PROVIDER_DIAGNOSTIC,
	installContextTraceFixturePack,
	removeContextTraceFixturePack,
} from "../fixtures/context-trace-inspector.js";

const CONTEXT_TAB_ID = "context";
const CONTEXT_ACTION_ID = "view-context-trace";
const INSPECTOR = '[data-testid="context-trace-inspector"]';
const EVENT_CARD = '[data-testid="context-trace-event"]';
const PROVIDER_ROW = '[data-testid="context-trace-provider"]';

async function navigateToSession(page: Page, sessionId: string): Promise<void> {
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
	await expect.poll(
		() => page.evaluate(() => (window as any).bobbitState?.selectedSessionId ?? (window as any).__bobbitState?.selectedSessionId ?? ""),
		{ timeout: 10_000 },
	).toBe(sessionId);
}

async function appendBeforePromptTrace(sessionId: string, prompt: string): Promise<void> {
	const response = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/provider-hooks/before-prompt`, {
		method: "POST",
		body: JSON.stringify({ prompt }),
	});
	expect(response.status, await response.text()).toBe(200);
}

function contextTab(page: Page): Locator {
	return page.locator(`.goal-tab-pill[data-panel-tab-kind="context"][data-panel-tab-id="${CONTEXT_TAB_ID}"]`);
}

async function openContextTrace(page: Page): Promise<Locator> {
	const action = page.locator(`sidebar-actions-popover [role="menuitem"][data-session-action-id="${CONTEXT_ACTION_ID}"]`).first();
	const trigger = page.locator('[data-testid="session-actions-trigger"]').first();
	await expect(trigger).toBeVisible({ timeout: 10_000 });
	await trigger.click();
	await expect(action).toBeVisible({ timeout: 10_000 });
	await expect(action).toHaveAccessibleName("View context trace");
	await action.click();
	const inspector = page.locator(INSPECTOR);
	await expect(inspector).toBeVisible({ timeout: 15_000 });
	await expect(inspector.getByRole("heading", { name: "Context trace" })).toBeFocused({ timeout: 10_000 });
	return inspector;
}

async function closeContextTrace(page: Page): Promise<void> {
	const tab = contextTab(page);
	await expect(tab).toBeVisible({ timeout: 10_000 });
	await tab.locator('[data-testid="context-trace-close"]').click();
	await expect(page.locator(INSPECTOR)).toHaveCount(0, { timeout: 10_000 });
}

async function eventHooks(inspector: Locator): Promise<string[]> {
	return inspector.locator(EVENT_CARD).evaluateAll((cards) => cards.map((card) => card.getAttribute("data-context-trace-hook") || ""));
}

test.describe.configure({ mode: "serial" });

test.describe("Context trace inspector", () => {
	const sessions: string[] = [];
	let packDir: string | undefined;

	test.beforeAll(async ({ gateway }) => {
		packDir = installContextTraceFixturePack(gateway);
		const activation = await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT",
			body: JSON.stringify({ scope: "server", packName: CONTEXT_TRACE_FIXTURE_PACK, disabled: { providers: [] } }),
		});
		expect(activation.status, await activation.text()).toBe(200);
	});

	test.afterEach(async () => {
		for (const sessionId of sessions.splice(0)) await deleteSession(sessionId).catch(() => {});
	});

	test.afterAll(async () => {
		await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT",
			body: JSON.stringify({ scope: "server", packName: CONTEXT_TRACE_FIXTURE_PACK, disabled: { providers: [] } }),
		}).catch(() => {});
		removeContextTraceFixturePack(packDir);
	});

	test("shows sanitized ordered trace metadata, scopes it to the active session, refreshes, persists, and restores focus", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await openApp(page);

		const sessionA = await createSession({ cwd: nonGitCwd() });
		sessions.push(sessionA);
		await appendBeforePromptTrace(sessionA, "first inspector trace");
		const sessionB = await createSession({ cwd: nonGitCwd() });
		sessions.push(sessionB);

		await navigateToSession(page, sessionA);
		let inspector = await openContextTrace(page);
		await expect(contextTab(page)).toBeVisible();
		await expect(inspector.locator("time").first(), "trace cards expose a semantic event time").toBeVisible();
		await expect.poll(() => eventHooks(inspector), { timeout: 10_000 }).toEqual(["beforePrompt", "sessionSetup"]);

		const firstRows = inspector.locator(EVENT_CARD).first().locator(PROVIDER_ROW);
		await expect.poll(() => firstRows.allTextContents(), { timeout: 10_000 }).toEqual([
			expect.stringContaining("alpha-provider"),
			expect.stringContaining("beta-provider"),
		]);
		await expect(firstRows.nth(0)).toContainText(/kept/i);
		await expect(firstRows.nth(0)).toContainText(/omitted/i);
		await expect(firstRows.nth(1)).toContainText("Provider error");
		await expect(inspector).not.toContainText(RAW_CONTEXT_PAYLOAD);
		await expect(inspector).not.toContainText(RAW_PROVIDER_DIAGNOSTIC);

		// Closing a non-modal workspace tab returns keyboard focus to the menu
		// trigger that opened it, then a reopening exercises persisted tab state.
		await closeContextTrace(page);
		await expect(page.locator('[data-testid="session-actions-trigger"]').first()).toBeFocused();
		inspector = await openContextTrace(page);

		// B has only its sessionSetup trace. A's beforePrompt trace must not leak
		// through the per-session workspace/cache on an away/back navigation.
		await navigateToSession(page, sessionB);
		const inspectorB = await openContextTrace(page);
		await expect.poll(() => eventHooks(inspectorB), { timeout: 10_000 }).toEqual(["sessionSetup"]);
		await expect(inspectorB).not.toContainText("first inspector trace");

		await navigateToSession(page, sessionA);
		inspector = page.locator(INSPECTOR);
		await expect(inspector).toBeVisible({ timeout: 15_000 });
		await expect.poll(() => eventHooks(inspector), { timeout: 10_000 }).toEqual(["beforePrompt", "sessionSetup"]);

		// The second append occurs while Context is open. No manual refresh is
		// clicked: the exact post-append context_trace_updated frame must refetch.
		await appendBeforePromptTrace(sessionA, "second inspector trace");
		await expect.poll(() => eventHooks(inspector), { timeout: 15_000 }).toEqual(["beforePrompt", "beforePrompt", "sessionSetup"]);

		// A cold browser reload rehydrates the historical session's persisted
		// Context workspace and fetches its stored trace again.
		await page.reload({ waitUntil: "domcontentloaded" });
		await navigateToSession(page, sessionA);
		inspector = page.locator(INSPECTOR);
		await expect(inspector).toBeVisible({ timeout: 15_000 });
		await expect.poll(() => eventHooks(inspector), { timeout: 15_000 }).toEqual(["beforePrompt", "beforePrompt", "sessionSetup"]);
	});
});
