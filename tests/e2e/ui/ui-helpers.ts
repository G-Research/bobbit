/**
 * Shared page-object helpers for browser-based E2E tests.
 *
 * All helpers use Playwright's built-in waiting (locator assertions,
 * expect().toBeVisible()). No fixed-duration setTimeout sleeps.
 */
import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { readE2ETokenAsync, base, apiFetch, waitForSessionStatus } from "../e2e-setup.js";

function escapeCssAttr(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

async function preferredProjectIdFromState(page: Page, preferredName = "default"): Promise<string | null> {
	return page.evaluate((name) => {
		const projects = (window as any).bobbitState?.projects ?? (window as any).__bobbitState?.projects ?? [];
		if (!Array.isArray(projects) || projects.length === 0) return null;
		return projects.find((p: any) => p?.name === name)?.id
			?? projects.find((p: any) => p?.kind !== "headquarters" && p?.id !== "headquarters")?.id
			?? projects[0]?.id
			?? null;
	}, preferredName);
}

async function pickProjectFromPopover(page: Page, preferredName = "default", timeout = 10_000): Promise<string> {
	const picker = page.locator("project-picker-popover").first();
	await expect(picker, "multi-project New Goal should open the project picker").toBeVisible({ timeout });
	const projectId = await preferredProjectIdFromState(page, preferredName);
	if (!projectId) throw new Error("Project picker opened but no project id was available in app state");
	await picker.locator(`button[data-project-id="${escapeCssAttr(projectId)}"]`).click();
	await expect(picker).not.toBeVisible({ timeout: 10_000 });
	return projectId;
}

async function visibleProjectCountFromState(page: Page): Promise<number> {
	return page.evaluate(() => {
		const projects = (window as any).bobbitState?.projects ?? (window as any).__bobbitState?.projects ?? [];
		return Array.isArray(projects) ? projects.length : 0;
	});
}

async function waitForActiveSessionWithTextarea(page: Page, previousSessionId: string | null, timeout = 20_000): Promise<string> {
	const handle = await page.waitForFunction(
		(previous: string | null) => {
			const selected = (window as any).bobbitState?.selectedSessionId ?? (window as any).__bobbitState?.selectedSessionId;
			if (typeof selected !== "string" || !selected || selected === previous) return null;
			const routeSession = window.location.hash.match(/^#\/session\/([\w-]+)/)?.[1] ?? null;
			if (routeSession !== selected) return null;
			const textarea = Array.from(document.querySelectorAll("textarea"))
				.find((el) => {
					const rect = el.getBoundingClientRect();
					const style = window.getComputedStyle(el);
					return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
				});
			return textarea ? selected : null;
		},
		previousSessionId,
		{ timeout },
	);
	return await handle.jsonValue() as string;
}

/**
 * Open the app authenticated via token query param.
 * Waits for the sidebar "New session" button to confirm the app has loaded.
 */
export async function openApp(page: Page): Promise<void> {
	const token = await readE2ETokenAsync();
	const baseUrl = base();
	await page.goto(`${baseUrl}/?token=${encodeURIComponent(token)}`);
	// Wait for sidebar to be fully loaded — Settings button is always present
	// regardless of single-project or multi-project mode
	await expect(
		page.locator("button").filter({ hasText: "Settings" }).first(),
	).toBeVisible({ timeout: 20_000 });
}

export async function activeSessionId(page: Page): Promise<string | null> {
	return page.evaluate(() => {
		const selected = (window as any).bobbitState?.selectedSessionId;
		if (typeof selected === "string" && selected) return selected;
		const match = window.location.hash.match(/^#\/session\/([\w-]+)/);
		return match?.[1] ?? null;
	});
}

// `Locator.isVisible({ timeout })` does NOT wait — Playwright's own type
// declarations document this: "does not wait for the element to become
// visible and returns immediately." It's an instant DOM snapshot, not a
// poll. Right after `openApp()` (which only waits for the sidebar's
// "Settings" button — present in the very first, pre-fetch render frame,
// before `/api/projects` has resolved), the sidebar's project buttons can
// still be mid-fetch. An immediate `isVisible()` check on the preferred
// project's "New session" button races that fetch and can see nothing at
// all, even though the button paints moments later. `Locator.waitFor({
// state: "visible" })` (unlike `isVisible()`) actually polls up to
// `timeout`, which is the real fix here — confirmed by forcing the race
// with an artificial `/api/projects` response delay: the broken
// `isVisible({timeout})` check reliably fell through to the
// first-in-DOM-order fallback button (Headquarters, since it registers
// before any harness-created project) instead of waiting for "default".
async function isVisibleWithin(locator: Locator, timeout: number): Promise<boolean> {
	try {
		await locator.waitFor({ state: "visible", timeout });
		return true;
	} catch {
		return false;
	}
}

/**
 * Click "New session" button in the sidebar and wait for the newly-created
 * session to become the active route/session, not just for the already-visible
 * chat textarea from the previous session.
 */
export async function createSessionViaUI(page: Page, opts?: { projectName?: string }): Promise<string> {
	const previousSessionId = await activeSessionId(page);
	// In Headquarters-enabled harnesses, prefer the normal "default" project so
	// legacy session/proposal tests keep their seeded workflows. Fall back to the
	// first visible session button for single-project or custom-project tests.
	const preferredName = opts?.projectName ?? "default";
	const preferredButton = page.locator(`button[title="New session in ${preferredName}"]`).first();
	if (await isVisibleWithin(preferredButton, 10_000)) {
		await preferredButton.click();
	} else {
		await page.locator("button[title^='New session in']").first().click();
	}
	return waitForActiveSessionWithTextarea(page, previousSessionId, 20_000);
}

export async function createGoalAssistantViaUI(page: Page, opts?: { projectName?: string; timeout?: number }): Promise<string> {
	const previousSessionId = await activeSessionId(page);
	const newGoalBtn = page.locator("button[title='New goal (Alt+G)']").first();
	await expect(newGoalBtn).toBeVisible({ timeout: 10_000 });
	await expect(newGoalBtn).toBeEnabled({ timeout: 10_000 });
	const sessionCreated = page.waitForResponse(
		(resp) => resp.url().includes("/api/sessions") && resp.request().method() === "POST" && resp.ok(),
		{ timeout: opts?.timeout ?? 60_000 },
	);
	const visibleProjectCount = await visibleProjectCountFromState(page);
	await newGoalBtn.click();
	if (visibleProjectCount > 1) {
		await pickProjectFromPopover(page, opts?.projectName ?? "default");
	}
	await sessionCreated;
	return waitForActiveSessionWithTextarea(page, previousSessionId, opts?.timeout ?? 20_000);
}

/**
 * Type a message in the textarea and press Enter to send it.
 */
export async function sendMessage(page: Page, text: string): Promise<void> {
	const textarea = page.locator("textarea").first();
	await textarea.fill(text);
	await textarea.press("Enter");
}

/**
 * Wait for an assistant response to appear in the chat.
 * If opts.text is provided, waits for that specific text; otherwise waits for "OK".
 */
export async function waitForAgentResponse(
	page: Page,
	opts?: { text?: string; timeout?: number },
): Promise<void> {
	const timeout = opts?.timeout ?? 15_000;
	const text = opts?.text ?? "OK";
	await expect(
		page.getByText(text, { exact: text === "OK" }).first(),
	).toBeVisible({ timeout });
}

/**
 * Navigate to a hash route by setting window.location.hash.
 * Uses Playwright's waitForFunction to confirm the hash change took effect.
 */
export async function navigateToHash(page: Page, hash: string): Promise<void> {
	// Retry hash assignment + check up to 3 times; under heavy parallel load
	// Chromium can drop or delay the assignment, and the subsequent
	// waitForFunction just polls the stale value. Reassigning resets the
	// polling baseline and reliably lands.
	//
	// Accept "contains" rather than strict equality because the app's router
	// may normalize the hash (e.g. append a trailing slash, strip query
	// params). `contains` is enough to prove the navigation happened —
	// tests that care about the exact form use `url_equals` separately.
	// Some routes redirect synchronously in main.ts (e.g. #/workflows → #/settings/<projectId>/workflows).
	// Tests that hard-code #/workflows still need to land on the workflows surface, so accept either
	// the literal hash or its known redirect target as success.
	const redirectMap: Record<string, RegExp> = {
		"#/workflows": /^#\/settings\/[^/]+\/workflows/,
	};
	for (let attempt = 0; attempt < 3; attempt++) {
		await page.evaluate((h) => { window.location.hash = h; }, hash);
		try {
			await page.waitForFunction(
				({ h, redirectSrc }: { h: string; redirectSrc: string | null }) => {
					const current = window.location.hash;
					if (current.startsWith(h)) return true;
					if (redirectSrc) {
						try { return new RegExp(redirectSrc).test(current); } catch { return false; }
					}
					return false;
				},
				{ h: hash, redirectSrc: redirectMap[hash]?.source ?? null },
				{ timeout: attempt === 2 ? 10_000 : 3_000 },
			);
			return;
		} catch (err) {
			if (attempt === 2) throw err;
			// Yield to let any pending hashchange/route handlers settle before
			// reassigning. Two rAFs is roughly one paint frame — enough to drain
			// pending microtasks without pinning a wall-clock budget.
			await page.evaluate(() => new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			}));
		}
	}
}

/**
 * Navigate to the goal dashboard for a specific goal.
 * The route format is #/goal/<goalId>.
 */
export async function navigateToGoalDashboard(page: Page, goalId: string): Promise<void> {
	await navigateToHash(page, `#/goal/${goalId}`);
	// Wait for goal dashboard content to appear (tab bar is always present)
	await expect(page.locator(".tab").first()).toBeVisible({ timeout: 10_000 });
}

/**
 * Click a sidebar entry by its text label.
 */
export async function clickSidebarItem(page: Page, label: string): Promise<void> {
	await page.getByText(label).first().click();
}

/**
 * Return visible session entry texts from the sidebar.
 * Sessions are rendered as clickable rows — we grab their truncated title spans.
 */
export async function getVisibleSessions(page: Page): Promise<string[]> {
	// Session rows contain a .truncate span with the session title
	const items = page.locator(".sidebar-session-active, [class*='cursor-pointer']").locator(".truncate");
	const count = await items.count();
	const texts: string[] = [];
	for (let i = 0; i < count; i++) {
		const t = await items.nth(i).textContent();
		if (t) texts.push(t.trim());
	}
	return texts;
}

/**
 * Wait for a session to reach idle status via the API.
 * Delegates to the polling helper in e2e-setup.
 */
export async function waitForSessionIdle(sessionId: string): Promise<void> {
	await waitForSessionStatus(sessionId, "idle");
}
