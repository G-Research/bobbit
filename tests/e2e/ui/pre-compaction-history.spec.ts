/** Full-stack UI journey for live and persisted pre-compaction history. */
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import {
	createSession,
	deleteSession,
	waitForSessionStatus,
} from "../e2e-setup.js";
import { navigateToHash, openApp, sendMessage } from "./ui-helpers.js";

const HISTORY_TEXTS = ["pre-msg-0", "pre-msg-1", "pre-msg-2"];
const RETAINED_TAIL = "Resuming work after the summary.";

const cardSelector = "[data-testid='compaction-summary-card']";
const historySelector = "[data-testid='pre-compaction-history']";
const rowsSelector = "[data-testid='pre-compaction-rows']";
const toggleSelector = "[data-testid='pre-compaction-toggle']";

async function refreshHistoryCount(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const history = document.querySelector(
			"bobbit-pre-compaction-history",
		) as any;
		if (!history || typeof history.refreshCount !== "function") {
			throw new Error("pre-compaction history refresh hook is unavailable");
		}
		await history.refreshCount();
	});
}

async function expectCollapsedSummaryBeforeTail(page: Page): Promise<void> {
	const cards = page.locator(cardSelector);
	const history = page.locator(historySelector);
	const tail = page
		.locator("assistant-message")
		.filter({ hasText: RETAINED_TAIL });

	await expect(cards).toHaveCount(1, { timeout: 20_000 });
	await expect(cards.first()).toHaveAttribute("data-state", "complete", {
		timeout: 20_000,
	});
	await expect(cards.first().locator("[data-test='verdict']")).toHaveAttribute(
		"data-verdict",
		"ok",
		{ timeout: 15_000 },
	);
	await expect(history).toHaveCount(1, { timeout: 20_000 });
	await refreshHistoryCount(page);
	await expect(history).toHaveAttribute("data-state", "collapsed", {
		timeout: 20_000,
	});
	await expect(page.locator(toggleSelector)).toHaveText(
		/Show 3 messages before compaction/,
		{ timeout: 15_000 },
	);
	await expect(tail).toHaveCount(1, { timeout: 15_000 });

	const order = await page.evaluate(
		({ cardSelector, historySelector, retainedTail }) => {
			const card = document.querySelector(cardSelector);
			const history = document.querySelector(historySelector);
			const tail =
				Array.from(document.querySelectorAll("assistant-message")).find(
					(element) => element.textContent?.includes(retainedTail),
				) ?? null;
			const comesBefore = (first: Element | null, second: Element | null) =>
				!!first &&
				!!second &&
				(first.compareDocumentPosition(second) &
					Node.DOCUMENT_POSITION_FOLLOWING) !==
					0;
			return {
				historyBeforeCard: comesBefore(history, card),
				cardBeforeTail: comesBefore(card, tail),
			};
		},
		{ cardSelector, historySelector, retainedTail: RETAINED_TAIL },
	);

	expect(
		order,
		"collapsed history, summary, and retained tail must stay in transcript order",
	).toEqual({
		historyBeforeCard: true,
		cardBeforeTail: true,
	});
}

async function expandAndExpectHistoricalRows(page: Page): Promise<void> {
	const history = page.locator(historySelector);
	await page.locator(toggleSelector).click();
	await expect(history).toHaveAttribute("data-state", "expanded", {
		timeout: 15_000,
	});

	const container = page.locator(rowsSelector);
	const rows = container.locator(":scope :is(user-message, assistant-message)");
	await expect(rows).toHaveCount(HISTORY_TEXTS.length, { timeout: 15_000 });
	await expect
		.poll(
			async () => (await rows.allTextContents()).map((text) => text.trim()),
			{
				message:
					"historical rows should retain their original content and order",
			},
		)
		.toEqual(HISTORY_TEXTS);

	const presentation = await container.evaluate((element) => {
		const list = element.querySelector("message-list") as any;
		const rowElements = Array.from(
			element.querySelectorAll("user-message, assistant-message"),
		) as any[];
		return {
			opacity: Number.parseFloat(getComputedStyle(element).opacity),
			isStreaming: list?.isStreaming,
			hasStreamMessage: list?.hasStreamMessage,
			rowIds: rowElements.map((row) => row.message?.id),
		};
	});
	expect(
		presentation.opacity,
		"historical rows should be visually dimmed",
	).toBeLessThan(1);
	expect(presentation.isStreaming).toBe(false);
	expect(presentation.hasStreamMessage).toBe(false);
	expect(presentation.rowIds).toHaveLength(HISTORY_TEXTS.length);
	expect(
		presentation.rowIds.every(
			(id: unknown) => typeof id === "string" && id.startsWith("orphan:"),
		),
	).toBe(true);

	await expect(container.locator("streaming-message-container")).toHaveCount(0);
	await expect(page.locator("message-editor .queue-pill")).toHaveCount(0);
	const liveTranscriptTexts = await page.evaluate(() => {
		const messages =
			(window as any).__bobbitState?.remoteAgent?.state?.messages ?? [];
		return messages.flatMap((message: any) =>
			Array.isArray(message?.content)
				? message.content
						.filter((part: any) => part?.type === "text")
						.map((part: any) => part.text)
				: [],
		);
	});
	for (const text of HISTORY_TEXTS)
		expect(liveTranscriptTexts).not.toContain(text);
}

test.describe("Pre-compaction history UI", () => {
	test("live auto-compaction history persists across reload", async ({
		page,
	}) => {
		test.setTimeout(60_000);
		const sessionId = await createSession();
		try {
			await waitForSessionStatus(sessionId, "idle");
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea")).toBeVisible({
				timeout: 15_000,
			});

			await sendMessage(page, "AUTO_COMPACT:3");
			await waitForSessionStatus(sessionId, "idle", 20_000);
			await expectCollapsedSummaryBeforeTail(page);
			await expandAndExpectHistoricalRows(page);

			await page.reload();
			await expect(page.locator("message-editor textarea")).toBeVisible({
				timeout: 20_000,
			});
			await expectCollapsedSummaryBeforeTail(page);
			await expandAndExpectHistoricalRows(page);
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});
