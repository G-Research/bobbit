/**
 * Parent integration journey: one user installs, authorizes, observes, and
 * removes an extension through the production Market and Context surfaces.
 *
 * The fixture is intentionally an ordinary local Market source. Its scheduled
 * advisor produces a bounded trace marker only after the project operator has
 * granted its exact EP-6 `decide` capability; it cannot mutate application
 * state or rely on a test-only lifecycle endpoint.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createSession, deleteSession, registerProject, waitForSessionStatus } from "../e2e-setup.js";
import { navigateToHash, openApp, sendMessage } from "./ui-helpers.js";

// Retrying would hide stale Market projection, a non-durable grant, or a
// detached advisor that survives uninstall.
test.describe.configure({ mode: "serial", retries: 0 });

const PACK_ID = "extension-platform-lifecycle-pack";
const HOOK_ID = "lifecycle-advisor";
const CAPABILITY = "decide";
const ADVISORY_VALUE = "lifecycle-advised";
const FIXTURE_SOURCE = path.resolve("tests2/_fixtures/extension-platform-lifecycle");

type Project = { id: string; name: string; rootPath: string };

function installedPack(page: Page): Locator {
	return page.locator(`[data-testid="market-installed-pack"][data-pack-name="${PACK_ID}"][data-scope="server"]`);
}

function sourceRow(page: Page): Locator {
	return page.getByTestId("market-source-row").filter({ hasText: FIXTURE_SOURCE });
}

async function openMarket(page: Page, project: Project): Promise<void> {
	await navigateToHash(page, "#/market");
	await expect(page.getByTestId("market-installed-panel")).toBeVisible({ timeout: 20_000 });
	const projectScope = page.locator(`[data-testid="market-project-scope"][data-project-id="${project.id}"]`);
	await expect(projectScope).toBeVisible({ timeout: 15_000 });
	await projectScope.click();
	await expect(projectScope).toHaveAttribute("aria-current", "page");
}

async function openContextTrace(page: Page): Promise<Locator> {
	const trigger = page.locator('[data-testid="session-actions-trigger"]').first();
	await expect(trigger).toBeVisible({ timeout: 10_000 });
	await trigger.click();
	const action = page.locator('sidebar-actions-popover [role="menuitem"][data-session-action-id="view-context-trace"]').first();
	await expect(action).toBeVisible({ timeout: 10_000 });
	await action.click();
	const inspector = page.getByTestId("context-trace-inspector");
	await expect(inspector).toBeVisible({ timeout: 15_000 });
	return inspector;
}

async function navigateToSession(page: Page, sessionId: string): Promise<void> {
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
	await expect.poll(
		() => page.evaluate(() => (window as any).bobbitState?.selectedSessionId ?? (window as any).__bobbitState?.selectedSessionId ?? ""),
		{ timeout: 10_000 },
	).toBe(sessionId);
}

async function removeFixtureFallback(projectId: string): Promise<void> {
	// This only runs after a failed UI path so one failure cannot leak a source,
	// installed code, or project into a later browser worker. It is not used to
	// prove installation/removal behavior.
	await apiFetch("/api/marketplace/installed", {
		method: "DELETE",
		body: JSON.stringify({ scope: "server", packName: PACK_ID }),
	}).catch(() => {});
	const sources = await apiFetch("/api/marketplace/sources").catch(() => undefined);
	if (sources?.ok) {
		const body = await sources.json() as { sources?: Array<{ id: string; url: string }> };
		const source = body.sources?.find(candidate => candidate.url === FIXTURE_SOURCE);
		if (source) await apiFetch(`/api/marketplace/sources/${encodeURIComponent(source.id)}`, { method: "DELETE" }).catch(() => {});
	}
	await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
}

test.describe("extension platform lifecycle", () => {
	let project: Project;
	let projectRoot = "";
	let sessionId = "";
	let completed = false;

	test.beforeAll(async () => {
		projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "extension-platform-lifecycle-browser-"));
		project = await registerProject({
			name: `Extension lifecycle ${Date.now()}`,
			rootPath: projectRoot,
			seedWorkflows: false,
		}) as Project;
	});

	test.afterAll(async () => {
		if (sessionId) await deleteSession(sessionId).catch(() => {});
		if (!completed && project) await removeFixtureFallback(project.id);
		if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
	});

	test("installs, grants, observes, uninstalls, and reloads a project extension", async ({ page }) => {
		test.setTimeout(90_000);
		await openApp(page);
		await openMarket(page, project);

		// Register a deterministic local fixture through the production Sources
		// form, then install it through Browse. No server-side installation or
		// activation shortcut is used.
		await page.getByTestId("market-tab-sources").click();
		await expect(page.getByTestId("market-sources-panel")).toBeVisible();
		await page.getByTestId("market-source-url").fill(FIXTURE_SOURCE);
		await page.getByTestId("market-add-source").click();
		await expect(sourceRow(page)).toBeVisible({ timeout: 20_000 });

		await page.getByTestId("market-tab-browse").click();
		const browsePack = page.locator(`[data-testid="market-browse-pack"][data-pack-name="${PACK_ID}"]`);
		await expect(browsePack).toBeVisible({ timeout: 20_000 });
		await expect(browsePack).toContainText("Deterministic scheduled advisory");
		await browsePack.getByTestId("market-install-pack").click();
		await expect(browsePack.getByTestId("market-browse-installed")).toBeVisible({ timeout: 20_000 });

		await page.getByTestId("market-tab-installed").click();
		const pack = installedPack(page);
		await expect(pack).toBeVisible({ timeout: 20_000 });
		const runtime = pack.locator(`[data-testid="market-project-runtime"][data-project-id="${project.id}"][data-pack-id="${PACK_ID}"]`);
		await expect(runtime).toBeVisible({ timeout: 20_000 });
		const hook = runtime.locator(`[data-testid="market-project-hook-row"][data-contribution-id="${HOOK_ID}"]`);
		await expect(hook).toContainText(HOOK_ID);
		await expect(hook.getByTestId("market-runtime-status")).toHaveText("Grant required");

		// The EP-6 grant is a user action: inspect the precise tuple, accept the
		// named confirmation, and wait for the Market projection to become active.
		const grants = hook.getByTestId("market-hook-grants");
		await grants.locator("summary").click();
		const grantRow = grants.getByTestId("market-capability-grant").filter({ has: page.locator(`[data-capability="${CAPABILITY}"]`) });
		await expect(grantRow).toContainText(`${CAPABILITY}: Not granted`);
		const grantAction = grantRow.getByTestId("market-capability-action");
		await expect(grantAction).toHaveAccessibleName(`Grant ${CAPABILITY}`);
		await grantAction.click();
		await expect(page.getByText("Grant extension capability")).toBeVisible();
		await expect(page.getByText(new RegExp(`Grant ${CAPABILITY} to hook ${HOOK_ID}.*pack ${PACK_ID}`, "i"))).toBeVisible();
		await page.getByRole("button", { name: "Grant capability", exact: true }).click();
		await expect(grantRow).toContainText(`${CAPABILITY}: Granted`, { timeout: 15_000 });
		await expect(hook.getByTestId("market-runtime-status")).toHaveText("Active");

		// Use a normal chat turn to trigger the installed advisor. Context Trace is
		// the user-visible audit surface, not a direct lifecycle dispatch endpoint.
		const cwd = path.join(projectRoot, "workspace");
		fs.mkdirSync(cwd, { recursive: true });
		sessionId = await createSession({ cwd, projectId: project.id });
		await waitForSessionStatus(sessionId, "idle");
		await navigateToSession(page, sessionId);
		await sendMessage(page, "Run the extension lifecycle fixture.");
		await waitForSessionStatus(sessionId, "idle");
		let trace = await openContextTrace(page);
		const activity = trace.getByTestId("context-trace-outcome").filter({ hasText: HOOK_ID });
		await expect.poll(() => activity.count(), { timeout: 15_000 }).toBe(1);
		await expect(activity).toContainText(PACK_ID);
		await expect(activity).toContainText("Advised");
		await expect(activity).toContainText(ADVISORY_VALUE);

		// Remove through the same Market card and then reload. A subsequent real
		// turn may not revive a removed pack's advisor; its old audit row remains
		// historical evidence, while no second row is created.
		await openMarket(page, project);
		await expect(pack).toBeVisible({ timeout: 15_000 });
		await pack.getByTestId("market-uninstall-pack").click();
		// Wait until the shared confirmation dialog has mounted before confirming
		// by keyboard; otherwise the click's dynamic import can race the keypress.
		const confirmationBackdrop = page.locator("div.fixed.inset-0").last();
		await expect(confirmationBackdrop).toBeVisible();
		await page.keyboard.press("Enter");
		await expect(confirmationBackdrop).toBeHidden();
		await expect(pack).toHaveCount(0, { timeout: 20_000 });
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.locator("body[data-shortcuts-ready='1']")).toBeVisible({ timeout: 20_000 });
		await openMarket(page, project);
		await expect(installedPack(page)).toHaveCount(0);

		await navigateToSession(page, sessionId);
		await sendMessage(page, "Verify removed extension stays inactive.");
		await waitForSessionStatus(sessionId, "idle");
		trace = await openContextTrace(page);
		await expect(trace.getByTestId("context-trace-outcome").filter({ hasText: HOOK_ID })).toHaveCount(1);

		// Source cleanup is also driven from Market. The finally-style fallback in
		// afterAll is reserved for an interrupted/failing user journey.
		await openMarket(page, project);
		await page.getByTestId("market-tab-sources").click();
		await expect(sourceRow(page)).toBeVisible({ timeout: 15_000 });
		await sourceRow(page).getByTestId("market-remove-source").click();
		await expect(confirmationBackdrop).toBeVisible();
		await page.keyboard.press("Enter");
		await expect(confirmationBackdrop).toBeHidden();
		await expect(sourceRow(page)).toHaveCount(0, { timeout: 15_000 });
		completed = true;
	});
});
