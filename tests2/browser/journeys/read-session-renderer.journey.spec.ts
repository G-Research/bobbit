import type { Page } from "@playwright/test";
import {
	test,
	expect,
	openApp,
	navigateToHash,
	createSession,
	deleteSession,
	waitForSessionStatus,
} from "../_helpers/journey-fixture.js";

const RAW_LIST = "RAW_LIST_BODY_MUST_NOT_RENDER";
const RAW_MESSAGE = "RAW_MESSAGE_BODY_MUST_NOT_RENDER";
const RAW_RESULT = "RAW_RESULT_BODY_MUST_NOT_RENDER";
const SIBLING = "SIBLING_RESULT_MUST_NOT_RENDER";

function seedReadCards(gateway: any, sessionId: string): void {
	const session = gateway.sessionManager?.getSession(sessionId);
	const mockAgent = session?.rpcClient?._agent;
	if (!mockAgent || !Array.isArray(mockAgent.conversationMessages)) {
		throw new Error("read-session renderer journey requires the in-process mock agent transcript");
	}

	const now = Date.now();
	const cards = [
		{
			id: "read-list",
			params: { operation: "list", session_id: sessionId },
			details: {
				operation: "list",
				session_id: sessionId,
				total: 1,
				returned: 1,
				messages: [{
					index: 4,
					role: "assistant",
					text: "",
					toolUses: [{ name: "bash", argumentSummary: "{\"command\":\"npm test\"}" }],
					toolResults: [{
						resultIndex: 0,
						name: "bash",
						status: "ok",
						size: { chars: 10, lines: 2, bytes: 11 },
						preview: RAW_LIST,
						rawBody: RAW_LIST,
					}],
				}],
			},
			raw: RAW_LIST,
		},
		{
			id: "read-message",
			params: { operation: "inspect", session_id: sessionId, message_index: 7 },
			details: {
				operation: "inspect",
				session_id: sessionId,
				message: {
					index: 7,
					role: "assistant",
					text: "Selected semantic message",
					toolUses: [{ name: "grep", arguments: { pattern: "needle" } }],
					toolResults: [{ resultIndex: 0, name: "grep", status: "unknown", size: { chars: 31, lines: 1, bytes: 31 } }],
				},
				messages: [{ text: SIBLING }],
			},
			raw: RAW_MESSAGE,
		},
		{
			id: "read-result",
			params: { operation: "inspect", session_id: sessionId, message_index: 9, result_index: 1, offset: 6, limit: 5 },
			details: {
				operation: "inspect",
				session_id: sessionId,
				result: {
					messageIndex: 9,
					resultIndex: 1,
					name: "bash",
					status: "error",
					size: { chars: 20, lines: 2, bytes: 21 },
					excerpt: "EXACT",
					offset: 6,
					returned: 5,
					totalChars: 20,
					nextOffset: 11,
					truncated: true,
					rawBody: RAW_RESULT,
				},
				message: { text: SIBLING },
			},
			raw: RAW_RESULT,
		},
	];

	mockAgent.conversationMessages = cards.flatMap((card, index) => [
		{
			id: `${card.id}-assistant`,
			role: "assistant",
			content: [{ type: "toolCall", id: card.id, name: "read_session", arguments: card.params, input: card.params }],
			timestamp: now + index * 2,
		},
		{
			id: `${card.id}-result`,
			role: "toolResult",
			toolCallId: card.id,
			toolName: "read_session",
			isError: false,
			content: [{ type: "text", text: card.raw }],
			details: card.details,
			timestamp: now + index * 2 + 1,
		},
	]);
}

async function expandCards(page: Page): Promise<ReturnType<Page["locator"]>> {
	const cards = page.locator('[data-tool-name="read_session"]');
	await expect(cards).toHaveCount(3, { timeout: 20_000 });
	for (let index = 0; index < 3; index++) await cards.nth(index).locator("button").first().click();
	return cards;
}

async function assertFocusedStates(page: Page): Promise<void> {
	const cards = await expandCards(page);
	await expect(cards.nth(0)).toContainText('bash({"command":"npm test"})');
	await expect(cards.nth(0)).toContainText("body redacted; status=ok; 10 chars; 2 lines; 11 bytes");
	await expect(cards.nth(1)).toContainText("message #7");
	await expect(cards.nth(1)).toContainText("Selected semantic message");
	await expect(cards.nth(1)).toContainText('grep({"pattern":"needle"})');
	await expect(cards.nth(2)).toContainText("result #1 from message #9");
	await expect(cards.nth(2)).toContainText("EXACT");
	await expect(cards.nth(2)).toContainText("Characters 6–11 of 20");
	await expect(cards.nth(2)).toContainText("Continue at offset 11");
	await expect(page.locator("body")).not.toContainText(RAW_LIST);
	await expect(page.locator("body")).not.toContainText(RAW_MESSAGE);
	await expect(page.locator("body")).not.toContainText(RAW_RESULT);
	await expect(page.locator("body")).not.toContainText(SIBLING);
}

test.describe("Journey: read_session exact inspection renderer", () => {
	test("compact diagnostics and exact inspections survive navigation and reload without leaking raw or sibling results", async ({ page, gateway }) => {
		const sessionId = await createSession();
		try {
			await waitForSessionStatus(sessionId, "idle", 30_000);
			seedReadCards(gateway, sessionId);
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			await assertFocusedStates(page);

			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			await assertFocusedStates(page);
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});
