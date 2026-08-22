import type { Locator, Page } from "@playwright/test";
import {
	createSession,
	deleteSession,
	expect,
	test,
	waitForSessionStatus,
} from "../_helpers/journey-fixture.js";
import {
	editor,
	openSessionPage,
	submit,
} from "./reliable-agent-turns.fixture.js";

const SEGMENT_A_PLAIN = "CLEAR_SEGMENT_A_PLAIN";
const SEGMENT_A_TOOL = "CLEAR_SEGMENT_A_TOOL please use bash";
const SEGMENT_A_ASK = "CLEAR_SEGMENT_A_ASK ask_user_choices";
const SEGMENT_B_FOLLOW_UP = "CLEAR_SEGMENT_B_FOLLOW_UP please use bash";
const TOOL_OUTPUT = "BOBBIT_TOOL_TEST_OK_12345";
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const cards = (page: Page) => page.getByTestId("context-clear-card");
const histories = (page: Page) => page.getByTestId("pre-clear-history");
const toggles = (page: Page) => page.getByTestId("pre-clear-toggle");
const rows = (page: Page) => page.getByTestId("pre-clear-rows");

async function refreshHistoryCounts(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const widgets = Array.from(document.querySelectorAll("bobbit-pre-compaction-history")) as Array<{
			refreshCount?: () => Promise<void>;
		}>;
		await Promise.all(widgets.map((widget) => widget.refreshCount?.()));
	});
}

async function expectCollapsedHistory(
	page: Page,
	index: number,
	expectedMessages: number,
): Promise<void> {
	const history = histories(page).nth(index);
	await expect(history).toHaveAttribute("data-state", "collapsed", { timeout: 20_000 });
	await expect(history).toHaveAttribute("data-test-total", String(expectedMessages));
	await expect(toggles(page).nth(index)).toHaveText(
		new RegExp(`Show ${expectedMessages} messages? before this clear`),
	);
}

async function expectExpandedHistory(
	page: Page,
	index: number,
	expectedMessages: number,
): Promise<Locator> {
	const history = histories(page).nth(index);
	const toggle = toggles(page).nth(index);
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	await expect(history).toHaveAttribute("data-state", "expanded", { timeout: 20_000 });
	await expect(history).toHaveAttribute("data-test-total", String(expectedMessages));
	await expect(history).toHaveAttribute("data-test-row-count", String(expectedMessages), { timeout: 20_000 });
	await expect(toggle).toHaveText(new RegExp(`Hide ${expectedMessages} messages? before this clear`));

	const container = rows(page).nth(index);
	await expect(container).toBeVisible();
	const presentation = await container.evaluate((element) => {
		const list = element.querySelector("message-list") as any;
		const style = getComputedStyle(element);
		return {
			opacity: Number.parseFloat(style.opacity),
			pointerEvents: style.pointerEvents,
			isStreaming: list?.isStreaming,
			hasStreamMessage: list?.hasStreamMessage,
		};
	});
	expect(presentation.opacity, "history should use the existing dimmed treatment").toBeLessThan(1);
	expect(presentation.pointerEvents, "history must remain selectable and interactive").not.toBe("none");
	expect(presentation.isStreaming).toBe(false);
	expect(presentation.hasStreamMessage).toBe(false);
	await expect(container.locator("streaming-message-container")).toHaveCount(0);
	return container;
}

async function expectRemoteConversationExcludes(page: Page, forbidden: readonly string[]): Promise<void> {
	const serialized = await page.evaluate(() => {
		const root = (window as any).bobbitState ?? (window as any).__bobbitState;
		const remote = root?.remoteAgent;
		return JSON.stringify(remote?.state?.messages ?? remote?._state?.messages ?? []);
	});
	for (const text of forbidden) expect(serialized).not.toContain(text);
}

async function invokeMixedCaseClearWithAttachment(page: Page): Promise<void> {
	const textarea = editor(page);

	// Discovery is keyboard-operable and inserts the built-in token rather than
	// sending it immediately, leaving the normal second Enter submission path.
	await textarea.fill("/cl");
	const command = page.getByTestId("slash-command-clear");
	await expect(command).toBeVisible({ timeout: 15_000 });
	await expect(command).toContainText("/clear");
	await expect(command).toContainText("Start fresh with no prior conversation context");
	await textarea.press("Enter");
	await expect(textarea).toHaveValue("/clear ");

	await page.locator('message-editor input[type="file"]').setInputFiles({
		name: "draft-before-clear.png",
		mimeType: "image/png",
		buffer: Buffer.from(PNG_BASE64, "base64"),
	});
	await expect(page.locator("message-editor attachment-tile")).toHaveCount(1, { timeout: 10_000 });

	// Exact standalone matching is trimmed and case-insensitive. Escape closes
	// autocomplete so Enter submits through AgentInterface, as with /compact.
	await textarea.fill("  /ClEaR  ");
	await textarea.press("Escape");
	await textarea.press("Enter");
	await expect(textarea).toHaveValue("");
	await expect(page.locator("message-editor attachment-tile")).toHaveCount(0);
}

async function invokeClear(page: Page): Promise<void> {
	const textarea = editor(page);
	await textarea.fill("/CLEAR");
	await textarea.press("Escape");
	await textarea.press("Enter");
	await expect(textarea).toHaveValue("");
}

async function expectBoundaryIdentity(page: Page, index: number): Promise<string> {
	const card = cards(page).nth(index);
	await expect(card).toContainText("Context Cleared", { timeout: 20_000 });
	const clearId = await card.getAttribute("data-boundary-id");
	expect(clearId).toMatch(/^clr_/);
	await expect(histories(page).nth(index)).toHaveAttribute("data-boundary-id", clearId!);
	return clearId!;
}

async function expectRepeatedBoundaryOrder(page: Page): Promise<void> {
	const ordered = await page.evaluate(() => {
		const nodes = [
			document.querySelectorAll('[data-testid="pre-clear-history"]')[0],
			document.querySelectorAll('[data-testid="context-clear-card"]')[0],
			document.querySelectorAll('[data-testid="pre-clear-history"]')[1],
			document.querySelectorAll('[data-testid="context-clear-card"]')[1],
		];
		return nodes.every(Boolean) && nodes.slice(0, -1).every((node, index) =>
			(node!.compareDocumentPosition(nodes[index + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
		);
	});
	expect(ordered, "each history fold must stay immediately before its own clear boundary").toBe(true);
}

test.describe("Journey: Clear Session Context", () => {
	test("autocomplete, durable disjoint history folds, fresh turns, drafts, reload, and mobile", async ({ page }) => {
		test.setTimeout(150_000);
		const sessionId = await createSession();
		try {
			await waitForSessionStatus(sessionId, "idle");
			await openSessionPage(page, sessionId);

			// Segment A deliberately contains user, assistant, tool-call, and
			// tool-result rows so the clear fold exercises the full transcript UI.
			await submit(page, SEGMENT_A_PLAIN);
			await expect(page.locator("user-message").filter({ hasText: SEGMENT_A_PLAIN })).toHaveCount(1, { timeout: 20_000 });
			await expect(page.getByText("OK", { exact: true }).last()).toBeVisible({ timeout: 20_000 });
			await waitForSessionStatus(sessionId, "idle", 20_000);
			await submit(page, SEGMENT_A_TOOL);
			await expect(page.locator("user-message").filter({ hasText: SEGMENT_A_TOOL })).toHaveCount(1, { timeout: 20_000 });
			await expect(page.getByText("Done. Used Bash tool.", { exact: true })).toBeVisible({ timeout: 20_000 });
			await expect(page.locator('[data-tool-name="Bash"]')).toHaveCount(1, { timeout: 20_000 });
			await waitForSessionStatus(sessionId, "idle", 20_000);
			await submit(page, SEGMENT_A_ASK);
			await expect(page.locator("ask-user-choices-widget")).toHaveCount(1, { timeout: 20_000 });
			await waitForSessionStatus(sessionId, "idle", 20_000);

			await invokeMixedCaseClearWithAttachment(page);
			await expect(cards(page)).toHaveCount(1, { timeout: 30_000 });
			await expect(page.locator("user-message").filter({ hasText: /\/clear/i })).toHaveCount(0);
			await expectBoundaryIdentity(page, 0);
			await refreshHistoryCounts(page);
			await expectCollapsedHistory(page, 0, 8);
			await expectRemoteConversationExcludes(page, [SEGMENT_A_PLAIN, SEGMENT_A_TOOL, SEGMENT_A_ASK, TOOL_OUTPUT, "/ClEaR"]);

			const segmentAHistory = await expectExpandedHistory(page, 0, 8);
			await expect(segmentAHistory).toContainText(SEGMENT_A_PLAIN);
			await expect(segmentAHistory).toContainText(SEGMENT_A_TOOL);
			await expect(segmentAHistory).toContainText("Done. Used Bash tool.");
			await expect(segmentAHistory).toContainText("This unanswered question is from read-only history.");
			const historicalAsk = segmentAHistory.locator("ask-user-choices-widget");
			await expect(historicalAsk.locator(".ask-option")).toHaveCount(4);
			await expect(historicalAsk.locator(".ask-submit")).toHaveCount(0);
			const historicalSubmitRequests: string[] = [];
			const observeHistoricalSubmit = (request: { url(): string; method(): string }) => {
				if (request.method() === "POST" && request.url().includes("/api/internal/user-question/submit")) {
					historicalSubmitRequests.push(request.url());
				}
			};
			page.on("request", observeHistoricalSubmit);
			await historicalAsk.locator(".ask-option").first().click({ force: true });
			await historicalAsk.evaluate((widget) => widget.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true })));
			await page.waitForTimeout(150);
			page.off("request", observeHistoricalSubmit);
			expect(historicalSubmitRequests).toEqual([]);

			const historicalTool = segmentAHistory.locator('[data-tool-name="Bash"]');
			await expect(historicalTool).toHaveCount(1);
			const historicalOutput = historicalTool.locator("code").getByText(TOOL_OUTPUT, { exact: true });
			await historicalOutput.waitFor({ state: "attached" });
			await historicalTool.evaluate(() => new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			}));
			await historicalTool.getByRole("button", { name: /Output text payload/ }).click();
			await expect(historicalOutput).toBeVisible();
			await toggles(page).nth(0).click();
			await expectCollapsedHistory(page, 0, 8);

			// Reload before any new send proves both the boundary and attachment/text
			// draft tombstones are durable, not merely cleared from the live element.
			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(editor(page)).toBeVisible({ timeout: 20_000 });
			await expect(editor(page)).toHaveValue("");
			await expect(page.locator("message-editor attachment-tile")).toHaveCount(0);
			await expect(cards(page)).toHaveCount(1, { timeout: 20_000 });
			await refreshHistoryCounts(page);
			await expectCollapsedHistory(page, 0, 8);

			// Segment B runs against the fresh generation and remains the only live
			// conversation. It must render after, never inside, segment A's fold.
			await submit(page, SEGMENT_B_FOLLOW_UP);
			await waitForSessionStatus(sessionId, "idle", 20_000);
			const followUp = page.locator("user-message").filter({ hasText: SEGMENT_B_FOLLOW_UP });
			await expect(followUp).toHaveCount(1, { timeout: 20_000 });
			await expect(page.getByText("Done. Used Bash tool.", { exact: true }).last()).toBeVisible();
			const boundaryBeforeFollowUp = await page.evaluate((marker) => {
				const card = document.querySelector('[data-testid="context-clear-card"]');
				const prompt = Array.from(document.querySelectorAll("user-message"))
					.find((node) => node.textContent?.includes(marker));
				return !!card && !!prompt
					&& (card.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
			}, SEGMENT_B_FOLLOW_UP);
			expect(boundaryBeforeFollowUp).toBe(true);

			// Drive both a retained and active tool card through a probe renderer.
			// Capturing the exact context proves history owns no live capabilities.
			await toggles(page).nth(0).click();
			await expect(histories(page).nth(0)).toHaveAttribute("data-state", "expanded");
			const capabilityProbe = await page.evaluate(() => {
				const w = window as any;
				w.__clearCapabilityContexts = [];
				w.__bobbitRegisterToolRenderer("capability_probe_browser", {
					render(params: unknown, result: unknown, _streaming: boolean, ctx: Record<string, unknown>) {
						w.__clearCapabilityContexts.push({
							mode: ctx.capabilityMode,
							hasSessionId: Object.prototype.hasOwnProperty.call(ctx, "sessionId"),
							hasGoalId: Object.prototype.hasOwnProperty.call(ctx, "goalId"),
							hasAnswerLookup: Object.prototype.hasOwnProperty.call(ctx, "getAskResponseAnswers"),
							hasHost: Object.prototype.hasOwnProperty.call(ctx, "host"),
							hostActionable: typeof (ctx.host as any)?.invokeAction === "function",
						});
						return w.__bobbitRenderTool("read", params, result, false, { capabilityMode: "history" });
					},
				});
				const tools = Array.from(document.querySelectorAll("tool-message")) as any[];
				const historical = tools.find((tool) => tool.closest('[data-testid="pre-clear-rows"]'));
				const active = tools.find((tool) => !tool.closest('[data-testid="pre-clear-rows"]'));
				for (const tool of [historical, active]) {
					tool.tool = { name: "capability_probe_browser" };
					tool.toolCall = { ...tool.toolCall, name: "capability_probe_browser" };
					tool.requestUpdate();
				}
				return Promise.all([historical.updateComplete, active.updateComplete])
					.then(() => w.__clearCapabilityContexts);
			});
			expect(capabilityProbe).toContainEqual({
				mode: "history",
				hasSessionId: false,
				hasGoalId: false,
				hasAnswerLookup: false,
				hasHost: false,
				hostActionable: false,
			});
			expect(capabilityProbe).toContainEqual({
				mode: "active",
				hasSessionId: true,
				hasGoalId: true,
				hasAnswerLookup: true,
				hasHost: true,
				hostActionable: true,
			});
			await toggles(page).nth(0).click();
			await expectCollapsedHistory(page, 0, 8);

			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(followUp).toHaveCount(1, { timeout: 20_000 });
			await expect(cards(page)).toHaveCount(1, { timeout: 20_000 });
			await refreshHistoryCounts(page);
			await expectCollapsedHistory(page, 0, 8);

			// A second clear owns exactly segment B. The old fold remains stable and
			// neither segment is mixed into the now-empty active generation.
			await invokeClear(page);
			await expect(cards(page)).toHaveCount(2, { timeout: 30_000 });
			await expect(histories(page)).toHaveCount(2);
			await expect(page.locator("user-message").filter({ hasText: /\/clear/i })).toHaveCount(0);
			const firstClearId = await expectBoundaryIdentity(page, 0);
			const secondClearId = await expectBoundaryIdentity(page, 1);
			expect(secondClearId).not.toBe(firstClearId);
			await refreshHistoryCounts(page);
			await expectCollapsedHistory(page, 0, 8);
			await expectCollapsedHistory(page, 1, 3);
			await expectRepeatedBoundaryOrder(page);
			await expectRemoteConversationExcludes(page, [
				SEGMENT_A_PLAIN,
				SEGMENT_A_TOOL,
				TOOL_OUTPUT,
				SEGMENT_B_FOLLOW_UP,
				"/CLEAR",
			]);

			// Rehydrate both generations from durable metadata on a narrow mobile
			// viewport, then expand them together to prove disjoint local ownership.
			await page.setViewportSize({ width: 320, height: 720 });
			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(editor(page)).toBeVisible({ timeout: 20_000 });
			await expect(cards(page)).toHaveCount(2, { timeout: 20_000 });
			await refreshHistoryCounts(page);
			await expectCollapsedHistory(page, 0, 8);
			await expectCollapsedHistory(page, 1, 3);
			await expectBoundaryIdentity(page, 0);
			await expectBoundaryIdentity(page, 1);
			await expectRepeatedBoundaryOrder(page);

			const mobileA = await expectExpandedHistory(page, 0, 8);
			const mobileB = await expectExpandedHistory(page, 1, 3);
			await expect(mobileA).toContainText(SEGMENT_A_PLAIN);
			await expect(mobileA).toContainText(SEGMENT_A_TOOL);
			await expect(mobileA).not.toContainText(SEGMENT_B_FOLLOW_UP);
			await expect(mobileB).toContainText(SEGMENT_B_FOLLOW_UP);
			await expect(mobileB).not.toContainText(SEGMENT_A_PLAIN);
			await expect(mobileB).not.toContainText(SEGMENT_A_TOOL);

			const mobileLayout = await page.evaluate(() => ({
				viewportWidth: window.innerWidth,
				documentWidth: document.documentElement.scrollWidth,
				widgets: Array.from(document.querySelectorAll(
					'[data-testid="pre-clear-history"], [data-testid="context-clear-card"]',
				)).map((element) => {
					const rect = element.getBoundingClientRect();
					return { left: rect.left, right: rect.right, width: rect.width };
				}),
			}));
			expect(mobileLayout.documentWidth).toBeLessThanOrEqual(mobileLayout.viewportWidth + 1);
			expect(mobileLayout.widgets).toHaveLength(4);
			for (const widget of mobileLayout.widgets) {
				expect(widget.left).toBeGreaterThanOrEqual(-1);
				expect(widget.right).toBeLessThanOrEqual(mobileLayout.viewportWidth + 1);
				expect(widget.width).toBeGreaterThan(0);
			}

			// Native toggles remain operable after the responsive reflow.
			await toggles(page).nth(1).click();
			await expectCollapsedHistory(page, 1, 3);
			await toggles(page).nth(1).click();
			await expect(histories(page).nth(1)).toHaveAttribute("data-state", "expanded");
			await expectRemoteConversationExcludes(page, [SEGMENT_A_PLAIN, SEGMENT_A_TOOL, SEGMENT_B_FOLLOW_UP]);

			// The cleared generation's new active ask still submits exactly once.
			let activeSubmitRequests = 0;
			const observeActiveSubmit = (request: { url(): string; method(): string }) => {
				if (request.method() === "POST" && request.url().includes("/api/internal/user-question/submit")) {
					activeSubmitRequests++;
				}
			};
			page.on("request", observeActiveSubmit);
			await submit(page, "ACTIVE_AFTER_CLEAR ask_user_choices");
			const activeAsk = page.locator("ask-user-choices-widget").last();
			await expect(activeAsk.locator(".ask-submit")).toHaveCount(1, { timeout: 20_000 });
			await activeAsk.locator(".ask-option").filter({ hasText: "red" }).click();
			await expect(activeAsk.locator('[role="tab"]').nth(1)).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
			await activeAsk.locator(".ask-option").filter({ hasText: "small" }).click();
			await activeAsk.locator(".ask-submit").click();
			await expect(activeAsk.locator(".ask-submit")).toHaveCount(0, { timeout: 10_000 });
			page.off("request", observeActiveSubmit);
			expect(activeSubmitRequests).toBe(1);
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});
