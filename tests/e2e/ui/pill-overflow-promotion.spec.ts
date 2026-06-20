/**
 * Browser smoke — pill overflow renders in the real app. The narrow/wide wrap,
 * nowrap label, cache, and promotion matrix lives in the deterministic
 * `tests/ui-fixtures/chat-scroll.spec.ts` fixture.
 */
import { test, expect } from "./fixtures.js";
import {
	createSession,
	waitForHealth,
	waitForSessionStatus,
	apiFetch,
} from "../e2e-setup.js";
import type { Page } from "@playwright/test";
import { navigateToHash, openApp } from "./ui-helpers.js";

const padName = (i: number): string => `qa-pill-xxxxxx-${i.toString().padStart(2, "0")}`;

async function settleTwoRafs(page: Page): Promise<void> {
	await page.evaluate(
		() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
	);
}

async function waitForActiveSession(page: Page, sessionId: string): Promise<void> {
	await page.waitForFunction((id) => {
		const state = (window as any).bobbitState;
		const ai = document.querySelector("agent-interface") as any;
		return window.location.hash.includes(`/session/${id}`)
			&& state?.selectedSessionId === id
			&& ai?.session?.sessionId === id
			&& ai.getBoundingClientRect().width > 0;
	}, sessionId, { timeout: 15_000 });
}

async function forcePillOverflowMeasure(page: Page): Promise<boolean> {
	return await page.evaluate(async () => {
		const ai = document.querySelector("agent-interface") as
			| (HTMLElement & { updateComplete?: Promise<unknown>; _measurePillOverflow?: () => void })
			| null;
		if (!ai) return false;
		ai._measurePillOverflow?.();
		await ai.updateComplete;
		await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
		ai._measurePillOverflow?.();
		await ai.updateComplete;
		return document.querySelector("[data-more-btn]") !== null;
	});
}

async function seedPillsInUI(page: Page, count: number): Promise<string[]> {
	const startTime = Date.now();
	const processes = Array.from({ length: count }, (_, i) => ({
		id: `mock-bg-${i + 1}`,
		name: padName(i + 1),
		command: "mock long-running command",
		pid: 10_000 + i,
		status: "running" as const,
		exitCode: null,
		terminalReason: null,
		startTime: startTime + i,
		endTime: null,
	}));
	await page.evaluate(async (mockProcesses) => {
		await customElements.whenDefined("bg-process-pill");
		const ai = document.querySelector("agent-interface") as
			| (HTMLElement & { bgProcesses?: unknown[]; requestUpdate?: () => void; updateComplete?: Promise<unknown>; _measurePillOverflow?: () => void })
			| null;
		if (!ai) throw new Error("agent-interface not mounted");
		ai.bgProcesses = mockProcesses;
		ai.requestUpdate?.();
		await ai.updateComplete;
		await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
		ai._measurePillOverflow?.();
		await ai.updateComplete;
	}, processes);
	await settleTwoRafs(page);
	return processes.map((p) => p.id);
}

async function dismissPillsFromUI(page: Page, idsToRemove: string[]): Promise<void> {
	await page.evaluate(async (ids) => {
		const ai = document.querySelector("agent-interface") as
			| (HTMLElement & { bgProcesses?: Array<{ id: string }>; requestUpdate?: () => void; updateComplete?: Promise<unknown>; _measurePillOverflow?: () => void })
			| null;
		if (!ai || !Array.isArray(ai.bgProcesses)) return;
		ai.bgProcesses = ai.bgProcesses.filter((p) => !ids.includes(p.id));
		ai.requestUpdate?.();
		await ai.updateComplete;
		ai._measurePillOverflow?.();
		await ai.updateComplete;
	}, idsToRemove);
	await settleTwoRafs(page);
}

test.describe("pill strip overflow — real app smoke", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test("narrow mode renders overflow and promotes hidden pills after visible dismiss", async ({ page, rec }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await navigateToHash(page, `#/session/${sessionId}`);
		await waitForActiveSession(page, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await page.setViewportSize({ width: 540, height: 800 });

		const ids = await seedPillsInUI(page, 15);
		await expect.poll(() => forcePillOverflowMeasure(page), {
			timeout: 10_000,
			message: "mocked background pills should collapse behind the More button",
		}).toBe(true);
		await expect(page.locator("[data-more-btn]")).toBeVisible({ timeout: 5_000 });
		await rec.capture("Narrow pill overflow smoke");

		const visibleBefore = await page.locator("[data-pill-content] > div > bg-process-pill[data-id]").count();
		expect(visibleBefore).toBeGreaterThanOrEqual(2);
		expect(visibleBefore).toBeLessThan(ids.length);

		const moreButton = page.locator("[data-more-btn] button").first();
		await moreButton.click();
		await expect(page.locator(".pill-more-popover")).toBeVisible({ timeout: 5_000 });
		await expect(page.locator(".pill-more-popover")).toHaveCSS("align-items", "flex-start");
		await moreButton.click();
		await expect(page.locator(".pill-more-popover")).toHaveCount(0, { timeout: 5_000 });

		const visiblePillIds = await page
			.locator("[data-pill-content] > div > bg-process-pill[data-id]")
			.evaluateAll((els) => els.map((el) => el.getAttribute("data-id") ?? ""));
		await dismissPillsFromUI(page, visiblePillIds);
		await expect.poll(() => page.locator("[data-pill-content] > div > bg-process-pill[data-id]").count(), {
			timeout: 10_000,
			message: "hidden pills should promote back into visible strip",
		}).toBeGreaterThanOrEqual(visibleBefore);

		await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
	});
});
