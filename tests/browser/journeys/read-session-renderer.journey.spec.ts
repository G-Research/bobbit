import { test, expect, openApp, navigateToHash, createSession, deleteSession, waitForSessionStatus } from "../../../tests2/browser/_helpers/journey-fixture.js";
const SECRETS = ["RAW_LIST_MUST_NOT_RENDER", "RAW_MESSAGE_MUST_NOT_RENDER", "RAW_RESULT_MUST_NOT_RENDER", "SIBLING_MUST_NOT_RENDER"];
function seed(gateway: any, sessionId: string): void { const agent = gateway.sessionManager?.getSession(sessionId)?.rpcClient?._agent;
	if (!Array.isArray(agent?.conversationMessages)) throw new Error("journey requires the mock agent transcript"); const cards = [
		{ params: { operation: "list", session_id: sessionId }, raw: SECRETS[0], details: { operation: "list", session_id: sessionId, total: 1, returned: 1, messages: [{ index: 4, role: "assistant", text: "", toolUses: [{ name: "bash", argumentSummary: '{"command":"npm test"}' }], toolResults: [{ resultIndex: 0, name: "bash", status: "ok", size: { chars: 10, lines: 2, bytes: 11 }, preview: SECRETS[0] }] }] } },
		{ params: { operation: "inspect", session_id: sessionId, message_index: 7 }, raw: SECRETS[1], details: { operation: "inspect", session_id: sessionId, message: { index: 7, role: "assistant", text: "Selected semantic message", toolUses: [{ name: "grep", arguments: { pattern: "needle" } }], toolResults: [{ resultIndex: 0, status: "unknown", size: { chars: 31, lines: 1, bytes: 31 } }] }, messages: [{ text: SECRETS[3] }] } },
		{ params: { operation: "inspect", session_id: sessionId, message_index: 9, result_index: 1, offset: 6, limit: 5 }, raw: SECRETS[2], details: { operation: "inspect", session_id: sessionId, result: { messageIndex: 9, resultIndex: 1, name: "bash", status: "error", size: { chars: 20, lines: 2, bytes: 21 }, excerpt: "EXACT", offset: 6, returned: 5, totalChars: 20, nextOffset: 11, truncated: true }, message: { text: SECRETS[3] } } },
	];
	agent.conversationMessages = cards.flatMap((card, i) => [
		{ id: `call-${i}`, role: "assistant", content: [{ type: "toolCall", id: `read-${i}`, name: "read_session", arguments: card.params }], timestamp: i * 2 },
		{ id: `result-${i}`, role: "toolResult", toolCallId: `read-${i}`, toolName: "read_session", isError: false, content: [{ type: "text", text: card.raw }], details: card.details, timestamp: i * 2 + 1 },
	]); }
async function verify(page: any): Promise<void> { const cards = page.locator('[data-tool-name="read_session"]'); await expect(cards).toHaveCount(3, { timeout: 20_000 });
	for (let i = 0; i < 3; i++) await cards.nth(i).locator("button").first().click();
	const expected = [['bash({"command":"npm test"})', "body redacted; status=ok; 10 chars; 2 lines; 11 bytes"], ["message #7", "Selected semantic message", 'grep({"pattern":"needle"})'], ["result #1 from message #9", "EXACT", "Characters 6–11 of 20", "Continue at offset 11"]];
	for (let i = 0; i < expected.length; i++) for (const text of expected[i]) await expect(cards.nth(i)).toContainText(text);
	for (const secret of SECRETS) await expect(page.locator("body")).not.toContainText(secret);
}
test("read_session list and exact inspections survive navigation and reload without leaks", async ({ page, gateway }) => {
	const sessionId = await createSession();
	try {
		await waitForSessionStatus(sessionId, "idle", 30_000); seed(gateway, sessionId); await openApp(page); await navigateToHash(page, `#/session/${sessionId}`);
		for (let pass = 0; pass < 2; pass++) { await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 }); await verify(page); if (!pass) await page.reload({ waitUntil: "domcontentloaded" }); }
	} finally { await deleteSession(sessionId).catch(() => {}); }
});
