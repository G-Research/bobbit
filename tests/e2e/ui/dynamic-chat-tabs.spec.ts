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
import { apiFetch, nonGitCwd } from "../e2e-setup.js";
import { openApp, sendMessage, navigateToHash } from "./ui-helpers.js";

const PANEL_TAB_SELECTOR = "button.goal-tab-pill";
const PREVIEW_OPEN_BUTTON_SELECTOR = '[data-testid="preview-open-button"]';
const GOAL_TAB_RE = /^Goal( Proposal)?$/i;
const PREVIEW_TAB_RE = /^(HTML )?Preview(:|$)/i;
const CHAT_TAB_RE = /^Chat$/i;

const REVIEW_DOCS = [
	{ title: "Document A", body: "First document content." },
	{ title: "Document B", body: "Second document content." },
	{ title: "Document C", body: "Third document content." },
] as const;

function reviewTabRe(title: string): RegExp {
	return new RegExp(`^(Review:\\s*)?${escapeRegExp(title)}$`, "i");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

	const sessionId = await sessionIdFromHash(page);
	expect(sessionId, "goal assistant session id should be present in the URL").toMatch(/^[a-f0-9-]{36}$/);

	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });
	await sendMessage(page, "Please create a GOAL_PROPOSAL for dynamic chat tabs testing");
	await expectGoalProposalPanel(page, "goal proposal panel should be visible before opening an HTML preview");
	return sessionId;
}

async function openGoalAssistantProposalViaApi(page: Page): Promise<string> {
	await openApp(page);
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd: nonGitCwd(), assistantType: "goal" }),
	});
	const bodyText = await resp.text();
	expect(resp.status, `create goal assistant via API: ${bodyText}`).toBe(201);
	const sessionId = JSON.parse(bodyText).id as string;
	expect(sessionId, "goal assistant API session id should be valid").toMatch(/^[a-f0-9-]{36}$/);

	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
	await sendMessage(page, "Please create a GOAL_PROPOSAL for dynamic chat tabs mobile testing");
	await expectGoalProposalPanel(page, "mobile goal proposal panel should be visible before opening mixed tabs");
	return sessionId;
}

async function sessionIdFromHash(page: Page): Promise<string> {
	return page.evaluate(() => {
		const m = location.hash.match(/#\/session\/([\w-]+)/);
		return m?.[1] ?? "";
	});
}

async function expectGoalProposalPanel(page: Page, message: string): Promise<void> {
	const titleInput = page.locator(".goal-preview-panel input[placeholder='Goal title']").first();
	await expect(titleInput, message).toBeVisible({ timeout: 15_000 });
	await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });
}

async function openHtmlPreviewViaPreviewOpenFlow(
	page: Page,
	sessionId: string,
	options: { entry?: string; bodyText?: string } = {},
): Promise<string> {
	const baseUrl = new URL(page.url()).origin;
	const entry = options.entry ?? "dynamic-tabs.html";
	const bodyText = options.bodyText ?? "Dynamic Tabs Preview Content";

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

	const mountResp = await page.evaluate(async ({ baseUrl, sessionId, entry, bodyText }) => {
		const r = await fetch(`${baseUrl}/api/preview/mount?sessionId=${sessionId}`, {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				entry,
				html: `<!DOCTYPE html><html><body><h1>${bodyText}</h1></body></html>`,
			}),
		});
		return { status: r.status, text: await r.text() };
	}, { baseUrl, sessionId, entry, bodyText });
	expect(mountResp.status, `preview mount should succeed: ${mountResp.text}`).toBe(200);

	await expect.poll(
		async () => page.evaluate(() => {
			const s: any = (window as any).bobbitState ?? (window as any).__bobbitState ?? {};
			return s.previewPanelEntry || "";
		}),
		{ timeout: 10_000, message: "preview_open flow should populate the preview panel entry" },
	).toBe(entry);

	return bodyText;
}

async function visiblePanelTabLabels(page: Page): Promise<string[]> {
	return (await visiblePanelTabs(page)).map((tab) => tab.label);
}

async function visiblePanelTabs(page: Page): Promise<Array<{ index: number; label: string }>> {
	return page.locator(PANEL_TAB_SELECTOR).evaluateAll((buttons) => buttons
		.map((button, index) => {
			const el = button as HTMLElement;
			const style = window.getComputedStyle(el);
			const rect = el.getBoundingClientRect();
			if (style.visibility === "hidden" || style.display === "none" || rect.width <= 0 || rect.height <= 0) return null;
			const label = (button.getAttribute("title") || button.textContent || "").replace(/\s+/g, " ").trim();
			return label ? { index, label } : null;
		})
		.filter(Boolean) as Array<{ index: number; label: string }>);
}

async function waitForGoalAndPreviewTabs(page: Page): Promise<void> {
	await waitForTopLevelTabCounts(
		page,
		[
			{ name: "Goal proposal", match: GOAL_TAB_RE, min: 1 },
			{ name: "HTML Preview", match: PREVIEW_TAB_RE, min: 1 },
		],
		"DYNAMIC_CHAT_TABS_BUG: expected side panel tabs to include a Goal proposal tab and a distinct HTML Preview tab",
		5_000,
	);
}

async function waitForTopLevelTabCounts(
	page: Page,
	expectations: Array<{ name: string; match: RegExp; min: number }>,
	errorPrefix: string,
	timeout = 10_000,
): Promise<void> {
	try {
		await expect.poll(async () => {
			const labels = await visiblePanelTabLabels(page);
			return expectations.every((expected) => labels.filter((label) => expected.match.test(label)).length >= expected.min);
		}, { timeout, message: errorPrefix }).toBe(true);
	} catch {
		const labels = await visiblePanelTabLabels(page);
		const counts = expectations
			.map((expected) => `${expected.name}=${labels.filter((label) => expected.match.test(label)).length}/${expected.min}`)
			.join(", ");
		throw new Error(`${errorPrefix}; counts: ${counts}; visible tabs were: ${labels.join(", ") || "<none>"}`);
	}
}

async function selectTopLevelTab(page: Page, label: RegExp, errorPrefix: string): Promise<string> {
	const tabs = await visiblePanelTabs(page);
	const match = tabs.find((tab) => label.test(tab.label));
	if (!match) {
		throw new Error(`${errorPrefix}: expected selectable top-level tab ${label}; visible tabs were: ${tabs.map((tab) => tab.label).join(", ") || "<none>"}`);
	}
	const tab = page.locator(PANEL_TAB_SELECTOR).nth(match.index);
	await tab.evaluate((el) => (el as HTMLElement).scrollIntoView({ block: "nearest", inline: "center" }));
	await expect(tab, `${errorPrefix}: matched tab ${match.label} should be visible before click`).toBeVisible({ timeout: 5_000 });
	await tab.click();
	return match.label;
}

async function clickTopLevelTabByIndex(page: Page, index: number, errorPrefix: string): Promise<void> {
	const tab = page.locator(PANEL_TAB_SELECTOR).nth(index);
	await tab.evaluate((el) => (el as HTMLElement).scrollIntoView({ block: "nearest", inline: "center" }));
	await expect(tab, `${errorPrefix}: preview tab at index ${index} should be visible before click`).toBeVisible({ timeout: 5_000 });
	await tab.click();
}

async function matchingTabIndexes(page: Page, label: RegExp): Promise<number[]> {
	return (await visiblePanelTabs(page))
		.filter((tab) => label.test(tab.label))
		.map((tab) => tab.index);
}

async function ensureChatInput(page: Page, errorPrefix: string): Promise<void> {
	const textarea = page.locator("textarea").first();
	if (await textarea.isVisible().catch(() => false)) return;
	await selectTopLevelTab(page, CHAT_TAB_RE, `${errorPrefix}: chat tab should be available so the test can send the next message`);
	await expect(textarea, `${errorPrefix}: chat input should be visible after selecting Chat`).toBeVisible({ timeout: 5_000 });
}

async function sendChatMessage(page: Page, text: string, errorPrefix: string): Promise<void> {
	await ensureChatInput(page, errorPrefix);
	await sendMessage(page, text);
}

async function expectGoalProposalAccessible(page: Page, errorPrefix: string): Promise<void> {
	await selectTopLevelTab(page, GOAL_TAB_RE, `${errorPrefix}: Goal proposal tab should remain selectable`);
	await expectGoalProposalPanel(page, `${errorPrefix}: Goal proposal tab should render the proposal form`);
}

async function expectPreviewContains(page: Page, expectedText: string, errorPrefix: string): Promise<void> {
	const iframe = page.locator(".goal-preview-panel iframe").first();
	await expect(iframe, `${errorPrefix}: selecting the HTML Preview tab should show the preview iframe`).toBeVisible({ timeout: 10_000 });
	await expect(
		page.frameLocator(".goal-preview-panel iframe").locator("body"),
		`${errorPrefix}: selected HTML Preview tab should load the expected preview content`,
	).toContainText(expectedText, { timeout: 10_000 });
}

async function rawPreviewBodyText(page: Page): Promise<string> {
	return (await page.frameLocator(".goal-preview-panel iframe").locator("body").textContent({ timeout: 500 }).catch(() => "") || "").trim();
}

async function collectPreviewTabTexts(page: Page, expectedCount: number, errorPrefix: string): Promise<string[]> {
	const previewTabIndexes = await matchingTabIndexes(page, PREVIEW_TAB_RE);
	if (previewTabIndexes.length < expectedCount) {
		const labels = await visiblePanelTabLabels(page);
		throw new Error(`${errorPrefix}: expected at least ${expectedCount} preview tabs, found ${previewTabIndexes.length}; visible tabs were: ${labels.join(", ") || "<none>"}`);
	}

	const texts: string[] = [];
	for (let i = 0; i < expectedCount; i++) {
		const beforeText = await rawPreviewBodyText(page);
		await clickTopLevelTabByIndex(page, previewTabIndexes[i], errorPrefix);
		if (beforeText && i > 0) {
			await expect.poll(() => rawPreviewBodyText(page), {
				timeout: 5_000,
				message: `${errorPrefix}: selecting preview tab ${i + 1} should switch away from the previous preview content`,
			}).not.toBe(beforeText);
		}
		await expect.poll(() => rawPreviewBodyText(page), {
			timeout: 10_000,
			message: `${errorPrefix}: preview tab ${i + 1} should render non-empty iframe content`,
		}).not.toBe("");
		texts.push(await rawPreviewBodyText(page));
	}
	return texts;
}

async function openPreviewSnapshotToolCard(page: Page, size: number, ordinal: number, errorPrefix: string): Promise<string> {
	const expectedText = "x".repeat(size);
	await ensureChatInput(page, errorPrefix);
	const beforeCount = await page.locator(PREVIEW_OPEN_BUTTON_SELECTOR).count();
	await sendMessage(page, `PREVIEW_OPEN_SNAPSHOT SIZE=${size}`);
	await expect(
		page.locator(PREVIEW_OPEN_BUTTON_SELECTOR),
		`${errorPrefix}: preview_open tool card ${ordinal} should render its own Open button`,
	).toHaveCount(beforeCount + 1, { timeout: 15_000 });

	const button = page.locator(PREVIEW_OPEN_BUTTON_SELECTOR).nth(beforeCount);
	await button.scrollIntoViewIfNeeded();
	await expect(button, `${errorPrefix}: preview_open tool card ${ordinal} Open button should be enabled`).toBeEnabled({ timeout: 5_000 });
	await button.click();
	await expect(button, `${errorPrefix}: clicking preview_open tool card ${ordinal} should acknowledge that it opened`).toHaveText(/Opened/, { timeout: 5_000 });
	await expectPreviewContains(page, expectedText, `${errorPrefix}: opening preview_open tool card ${ordinal} should select that snapshot immediately`);
	return expectedText;
}

async function expectReviewDocumentAccessible(page: Page, title: string, body: string, errorPrefix: string): Promise<void> {
	await selectTopLevelTab(page, reviewTabRe(title), `${errorPrefix}: review document tab ${title} should be selectable`);
	await expect(page.locator("review-document").first(), `${errorPrefix}: selecting ${title} should show a review document`).toBeVisible({ timeout: 5_000 });
	await expect(
		page.locator("review-document").getByText(body).first(),
		`${errorPrefix}: selecting ${title} should show its document body`,
	).toBeVisible({ timeout: 5_000 });
}

async function setupMobileEmulation(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const orig = window.matchMedia;
		window.matchMedia = function (q: string) {
			if (q === "(pointer: coarse)") {
				return {
					matches: true,
					media: q,
					addEventListener: () => {},
					removeEventListener: () => {},
					addListener: () => {},
					removeListener: () => {},
					onchange: null,
					dispatchEvent: () => true,
				} as unknown as MediaQueryList;
			}
			return orig.call(window, q);
		};
	});
}

async function mobileTabBarDiagnostics(page: Page): Promise<{ labels: string[]; scrollWidth: number; clientWidth: number; hasHorizontalAccess: boolean; reason: string }> {
	return page.evaluate(() => {
		const normalize = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim();
		const bars = [...document.querySelectorAll(".goal-tab-bar")].map((bar) => {
			const labels = [...bar.querySelectorAll("button.goal-tab-pill")].map((button) => normalize(button.getAttribute("title") || button.textContent));
			const hasGoal = labels.some((label) => /^Goal( Proposal)?$/i.test(label));
			const hasPreview = labels.some((label) => /^(HTML )?Preview(:|$)/i.test(label));
			const reviewCount = labels.filter((label) => /^(Review:\s*)?Document [ABC]$/i.test(label)).length;
			return {
				labels,
				scrollWidth: (bar as HTMLElement).scrollWidth,
				clientWidth: (bar as HTMLElement).clientWidth,
				matchesMixedTabs: hasGoal && hasPreview && reviewCount >= 3,
			};
		});
		const selected = bars.find((bar) => bar.matchesMixedTabs) ?? bars.sort((a, b) => b.labels.length - a.labels.length)[0];
		if (!selected) return { labels: [], scrollWidth: 0, clientWidth: 0, hasHorizontalAccess: false, reason: "no .goal-tab-bar found" };
		return {
			labels: selected.labels,
			scrollWidth: selected.scrollWidth,
			clientWidth: selected.clientWidth,
			hasHorizontalAccess: selected.matchesMixedTabs && selected.scrollWidth > selected.clientWidth + 1,
			reason: selected.matchesMixedTabs ? "mixed tab bar selected" : "no tab bar contained the full mixed tab set",
		};
	});
}

async function expectMobileHorizontalTabAccess(page: Page, errorPrefix: string): Promise<void> {
	try {
		await expect.poll(async () => (await mobileTabBarDiagnostics(page)).hasHorizontalAccess, {
			timeout: 5_000,
			message: `${errorPrefix}: mobile mixed tabs should be reachable through horizontal tab-bar overflow`,
		}).toBe(true);
	} catch {
		const diagnostics = await mobileTabBarDiagnostics(page);
		throw new Error(`${errorPrefix}: expected mobile mixed tabs to have horizontal tab access; diagnostics=${JSON.stringify(diagnostics)}`);
	}
}

test.describe("Dynamic chat tabs", () => {
	test("goal assistant proposal and HTML preview coexist as selectable side-panel tabs", async ({ page }) => {
		test.setTimeout(90_000);
		await page.setViewportSize({ width: 1280, height: 800 });

		const sessionId = await openGoalAssistantProposal(page);
		const previewText = await openHtmlPreviewViaPreviewOpenFlow(page, sessionId);

		await waitForGoalAndPreviewTabs(page);

		await selectTopLevelTab(page, PREVIEW_TAB_RE, "DYNAMIC_CHAT_TABS_BUG");
		await expectPreviewContains(page, previewText, "DYNAMIC_CHAT_TABS_BUG");

		await expectGoalProposalAccessible(page, "DYNAMIC_CHAT_TABS_BUG: Goal proposal tab should remain accessible after viewing the HTML preview");
	});

	test("multiple preview_open tool cards reopen distinct preview tabs without hiding the proposal", async ({ page }) => {
		test.setTimeout(120_000);
		await page.setViewportSize({ width: 1280, height: 800 });

		await openGoalAssistantProposal(page);
		const firstPreviewText = await openPreviewSnapshotToolCard(page, 11, 1, "DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG");
		const secondPreviewText = await openPreviewSnapshotToolCard(page, 29, 2, "DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG");

		await waitForTopLevelTabCounts(
			page,
			[
				{ name: "Goal proposal", match: GOAL_TAB_RE, min: 1 },
				{ name: "HTML Preview", match: PREVIEW_TAB_RE, min: 2 },
			],
			"DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG: expected two distinct top-level preview tabs plus the Goal proposal tab after opening two preview_open tool cards",
		);

		const previewTabTexts = await collectPreviewTabTexts(page, 2, "DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG");
		expect(
			previewTabTexts.some((text) => text.includes(firstPreviewText)),
			`DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG: no selectable preview tab rendered the first preview_open snapshot; tab texts were ${JSON.stringify(previewTabTexts)}`,
		).toBe(true);
		expect(
			previewTabTexts.some((text) => text.includes(secondPreviewText)),
			`DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG: no selectable preview tab rendered the second preview_open snapshot; tab texts were ${JSON.stringify(previewTabTexts)}`,
		).toBe(true);

		await expectGoalProposalAccessible(page, "DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG");

		const buttons = page.locator(PREVIEW_OPEN_BUTTON_SELECTOR);
		await buttons.nth(0).scrollIntoViewIfNeeded();
		await buttons.nth(0).click();
		await expectPreviewContains(page, firstPreviewText, "DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG: reopening the first preview_open tool card should restore the first snapshot");
		await expectGoalProposalAccessible(page, "DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG: Goal proposal tab should remain accessible after reopening the first preview snapshot");

		await buttons.nth(1).scrollIntoViewIfNeeded();
		await buttons.nth(1).click();
		await expectPreviewContains(page, secondPreviewText, "DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG: reopening the second preview_open tool card should restore the second snapshot");
		await expectGoalProposalAccessible(page, "DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG: Goal proposal tab should remain accessible after reopening the second preview snapshot");
	});

	test("multiple review documents coexist as top-level tabs with a proposal and preview", async ({ page }) => {
		test.setTimeout(120_000);
		await page.setViewportSize({ width: 1280, height: 800 });

		const sessionId = await openGoalAssistantProposal(page);
		const previewText = await openHtmlPreviewViaPreviewOpenFlow(page, sessionId, {
			entry: "mixed-preview.html",
			bodyText: "Mixed Preview Content",
		});

		await sendChatMessage(page, "review_multi", "DYNAMIC_CHAT_TABS_REVIEW_MIX_BUG");
		await expect(page.getByText("Done. Used 3 tools.").first(), "DYNAMIC_CHAT_TABS_REVIEW_MIX_BUG: review_multi should open three review documents").toBeVisible({ timeout: 15_000 });

		await waitForTopLevelTabCounts(
			page,
			[
				{ name: "Goal proposal", match: GOAL_TAB_RE, min: 1 },
				{ name: "HTML Preview", match: PREVIEW_TAB_RE, min: 1 },
				...REVIEW_DOCS.map((doc) => ({ name: `Review ${doc.title}`, match: reviewTabRe(doc.title), min: 1 })),
			],
			"DYNAMIC_CHAT_TABS_REVIEW_MIX_BUG: expected proposal, preview, and each review document to be separate top-level tabs",
		);

		await expectGoalProposalAccessible(page, "DYNAMIC_CHAT_TABS_REVIEW_MIX_BUG");
		await selectTopLevelTab(page, PREVIEW_TAB_RE, "DYNAMIC_CHAT_TABS_REVIEW_MIX_BUG: Preview tab should be selectable alongside review docs");
		await expectPreviewContains(page, previewText, "DYNAMIC_CHAT_TABS_REVIEW_MIX_BUG");
		for (const doc of REVIEW_DOCS) {
			await expectReviewDocumentAccessible(page, doc.title, doc.body, "DYNAMIC_CHAT_TABS_REVIEW_MIX_BUG");
		}
	});

	test("mobile mixed proposal, review, and preview tabs are horizontally accessible", async ({ page }) => {
		test.setTimeout(120_000);
		await setupMobileEmulation(page);
		await page.setViewportSize({ width: 360, height: 740 });

		const sessionId = await openGoalAssistantProposalViaApi(page);
		await sendChatMessage(page, "review_multi", "DYNAMIC_CHAT_TABS_MOBILE_BUG");
		await expect(page.getByText("Done. Used 3 tools.").first(), "DYNAMIC_CHAT_TABS_MOBILE_BUG: review_multi should open three review documents on mobile").toBeVisible({ timeout: 15_000 });
		const previewText = await openHtmlPreviewViaPreviewOpenFlow(page, sessionId, {
			entry: "mobile-mixed-preview.html",
			bodyText: "Mobile Mixed Preview Content",
		});

		await waitForTopLevelTabCounts(
			page,
			[
				{ name: "Goal proposal", match: GOAL_TAB_RE, min: 1 },
				{ name: "HTML Preview", match: PREVIEW_TAB_RE, min: 1 },
				...REVIEW_DOCS.map((doc) => ({ name: `Review ${doc.title}`, match: reviewTabRe(doc.title), min: 1 })),
			],
			"DYNAMIC_CHAT_TABS_MOBILE_BUG: expected mobile tab bar to expose proposal, preview, and each review document as top-level tabs",
		);
		await expectMobileHorizontalTabAccess(page, "DYNAMIC_CHAT_TABS_MOBILE_BUG");

		await expectGoalProposalAccessible(page, "DYNAMIC_CHAT_TABS_MOBILE_BUG");
		await selectTopLevelTab(page, PREVIEW_TAB_RE, "DYNAMIC_CHAT_TABS_MOBILE_BUG: mobile Preview tab should be selectable via horizontal tab access");
		await expectPreviewContains(page, previewText, "DYNAMIC_CHAT_TABS_MOBILE_BUG");
		for (const doc of REVIEW_DOCS) {
			await expectReviewDocumentAccessible(page, doc.title, doc.body, "DYNAMIC_CHAT_TABS_MOBILE_BUG");
		}
	});
});
