/**
 * Reproducing browser E2E for Dynamic Chat Tabs.
 *
 * A goal assistant proposal and an HTML preview must coexist as separate
 * selectable side-panel tabs. This fails on the legacy assistant-only panel
 * model because the assistant "Preview" tab is actually the proposal pane and
 * the HTML iframe is never exposed.
 */
import { test, expect } from "../gateway-harness.js";
import type { Page } from "@playwright/test";
import { openApp, sendMessage } from "./ui-helpers.js";

async function openGoalAssistantProposal(page: Page): Promise<string> {
	await openApp(page);
	const newGoalBtn = page.locator("button[title='New goal (Alt+G)']").first();
	await expect(newGoalBtn).toBeVisible({ timeout: 10_000 });
	await expect(newGoalBtn).toBeEnabled({ timeout: 10_000 });

	const sessionCreated = page.waitForResponse(
		(resp) => resp.url().includes("/api/sessions") && resp.request().method() === "POST" && resp.ok(),
		{ timeout: 60_000 },
	);
	await newGoalBtn.click();
	await sessionCreated;
	await page.waitForURL(/#\/session\//, { timeout: 10_000 });

	const sessionId = await page.evaluate(() => {
		const m = location.hash.match(/#\/session\/([\w-]+)/);
		return m?.[1] ?? "";
	});
	expect(sessionId, "goal assistant session id should be present in the URL").toMatch(/^[a-f0-9-]{36}$/);

	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });
	await sendMessage(page, "Please create a GOAL_PROPOSAL for dynamic chat tabs testing");

	const titleInput = page.locator(".goal-preview-panel input[placeholder='Goal title']").first();
	await expect(titleInput, "goal proposal panel should be visible before opening an HTML preview").toBeVisible({ timeout: 15_000 });
	await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });
	return sessionId;
}

async function openHtmlPreviewViaPreviewOpenFlow(page: Page, sessionId: string): Promise<void> {
	const baseUrl = new URL(page.url()).origin;

	// Mirrors defaults/tools/html/extension.ts: PATCH preview=true, then mount
	// HTML into the per-session preview route. This drives the same client
	// preview_changed/SSE path as preview_open without needing a real agent tool.
	const patchResp = await page.evaluate(async ({ baseUrl, sessionId }) => {
		const r = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
			method: "PATCH",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ preview: true }),
		});
		return { status: r.status, text: await r.text() };
	}, { baseUrl, sessionId });
	expect(patchResp.status, `PATCH preview should succeed: ${patchResp.text}`).toBe(200);

	await expect.poll(
		async () => page.evaluate(() => {
			const s: any = (window as any).bobbitState ?? (window as any).__bobbitState ?? {};
			return s.isPreviewSession === true;
		}),
		{ timeout: 10_000, message: "preview_open flow should mark the assistant session as a preview session" },
	).toBe(true);

	const mountResp = await page.evaluate(async ({ baseUrl, sessionId }) => {
		const r = await fetch(`${baseUrl}/api/preview/mount?sessionId=${sessionId}`, {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				entry: "dynamic-tabs.html",
				html: "<!DOCTYPE html><html><body><h1>Dynamic Tabs Preview Content</h1></body></html>",
			}),
		});
		return { status: r.status, text: await r.text() };
	}, { baseUrl, sessionId });
	expect(mountResp.status, `preview mount should succeed: ${mountResp.text}`).toBe(200);

	await expect.poll(
		async () => page.evaluate(() => {
			const s: any = (window as any).bobbitState ?? (window as any).__bobbitState ?? {};
			return s.previewPanelEntry || "";
		}),
		{ timeout: 10_000, message: "preview_open flow should populate the preview panel entry" },
	).toBe("dynamic-tabs.html");
}

async function visiblePanelTabLabels(page: Page): Promise<string[]> {
	return page.locator("button.goal-tab-pill").evaluateAll((buttons) => buttons
		.filter((button) => {
			const el = button as HTMLElement;
			const style = window.getComputedStyle(el);
			const rect = el.getBoundingClientRect();
			return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
		})
		.map((button) => (button.getAttribute("title") || button.textContent || "").replace(/\s+/g, " ").trim())
		.filter(Boolean));
}

async function waitForGoalAndPreviewTabs(page: Page): Promise<void> {
	try {
		await page.waitForFunction(() => {
			const labels = [...document.querySelectorAll("button.goal-tab-pill")]
				.filter((button) => {
					const el = button as HTMLElement;
					const style = window.getComputedStyle(el);
					const rect = el.getBoundingClientRect();
					return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
				})
				.map((button) => (button.getAttribute("title") || button.textContent || "").replace(/\s+/g, " ").trim());
			const hasGoalProposal = labels.some((label) => /^Goal( Proposal)?$/i.test(label));
			const hasHtmlPreview = labels.some((label) => /^(HTML )?Preview(:|$)/i.test(label));
			return hasGoalProposal && hasHtmlPreview;
		}, null, { timeout: 5_000 });
	} catch {
		const labels = await visiblePanelTabLabels(page);
		throw new Error(
			`DYNAMIC_CHAT_TABS_BUG: expected side panel tabs to include a Goal proposal tab and a distinct HTML Preview tab; visible tabs were: ${labels.join(", ") || "<none>"}`,
		);
	}
}

function tabByLabel(page: Page, label: RegExp) {
	return page.locator("button.goal-tab-pill").filter({ hasText: label }).first();
}

test.describe("Dynamic chat tabs", () => {
	test("goal assistant proposal and HTML preview coexist as selectable side-panel tabs", async ({ page }) => {
		test.setTimeout(90_000);
		await page.setViewportSize({ width: 1280, height: 800 });

		const sessionId = await openGoalAssistantProposal(page);
		await openHtmlPreviewViaPreviewOpenFlow(page, sessionId);

		await waitForGoalAndPreviewTabs(page);

		const previewTab = tabByLabel(page, /Preview/i);
		await previewTab.click();
		const iframe = page.locator(".goal-preview-panel iframe").first();
		await expect(
			iframe,
			"DYNAMIC_CHAT_TABS_BUG: selecting the HTML Preview tab should show the preview iframe",
		).toBeVisible({ timeout: 5_000 });
		await expect(
			page.frameLocator(".goal-preview-panel iframe").locator("body"),
			"DYNAMIC_CHAT_TABS_BUG: selected HTML Preview tab should load mounted preview content",
		).toContainText("Dynamic Tabs Preview Content", { timeout: 5_000 });

		const goalTab = tabByLabel(page, /Goal/i);
		await goalTab.click();
		const titleInput = page.locator(".goal-preview-panel input[placeholder='Goal title']").first();
		await expect(
			titleInput,
			"DYNAMIC_CHAT_TABS_BUG: Goal proposal tab should remain accessible after viewing the HTML preview",
		).toBeVisible({ timeout: 5_000 });
		await expect(titleInput).toHaveValue("E2E Test Goal");
	});
});
