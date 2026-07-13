import { readFileSync, writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import {
	apiFetch,
	createSession,
	deleteSession,
	expect,
	navigateToHash,
	openApp,
	test,
	waitForSessionStatus,
} from "../_helpers/journey-fixture.js";

const ORPHAN_IDS = [
	"toolu_011XxjFHDfiTyzt8UgF2eVe2",
	"toolu_01A5tBKqT9crbozrVf5CujD8",
] as const;
const POISONED_HISTORY_ERROR =
	`messages.88.content.0: unexpected tool_use_id found in tool_result blocks: ${ORPHAN_IDS[0]}. ` +
	"Each tool_result block must have a corresponding tool_use block in the previous message.";
const RETRY_INTENT = "ORPHAN_BROWSER_RETRY_INTENT";
const FOLLOW_UP_INTENT = "ORPHAN_BROWSER_FOLLOW_UP_INTENT";
const PRESERVED_HISTORY = "Inspect the current test performance.";
const MODEL = { provider: "anthropic", id: "claude-sonnet-4-20250514" } as const;

function affectedPiSequence(parentId: string | null = null, suffix = "initial"): Array<Record<string, unknown>> {
	const userId = `msg-user-before-affected-turn-${suffix}`;
	const assistantId = `msg-text-only-assistant-${suffix}`;
	const orphanOneId = `msg-orphan-tool-result-one-${suffix}`;
	return [
		{
			type: "message",
			id: userId,
			parentId,
			timestamp: "2026-07-12T19:41:17.101Z",
			message: {
				role: "user",
				content: [{ type: "text", text: PRESERVED_HISTORY }],
				timestamp: 1783885277101,
			},
		},
		{
			type: "message",
			id: assistantId,
			parentId: userId,
			timestamp: "2026-07-12T19:41:18.202Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "I will inspect the relevant test data." }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "toolUse",
				timestamp: 1783885278202,
			},
		},
		{
			type: "message",
			id: orphanOneId,
			parentId: assistantId,
			timestamp: "2026-07-12T19:41:18.303Z",
			message: {
				role: "toolResult",
				toolCallId: ORPHAN_IDS[0],
				toolName: "read",
				content: [{ type: "text", text: "fixture result one" }],
				isError: false,
				timestamp: 1783885278303,
			},
		},
		{
			type: "message",
			id: `msg-orphan-tool-result-two-${suffix}`,
			parentId: orphanOneId,
			timestamp: "2026-07-12T19:41:18.404Z",
			message: {
				role: "toolResult",
				toolCallId: ORPHAN_IDS[1],
				toolName: "grep",
				content: [{ type: "text", text: "fixture result two" }],
				isError: false,
				timestamp: 1783885278404,
			},
		},
	];
}

function writeJsonl(file: string, entries: Array<Record<string, unknown>>): void {
	writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf-8");
}

function writePoisonedConversation(file: string, messages: unknown[], suffix: string): void {
	let parentId: string | null = null;
	const entries = messages.map((message, index) => {
		const id = `msg-${suffix}-history-${index}`;
		const entry = { type: "message", id, parentId, timestamp: new Date(1783885300000 + index).toISOString(), message };
		parentId = id;
		return entry;
	});
	writeJsonl(file, [...entries, ...affectedPiSequence(parentId, suffix).slice(1)]);
}

function orphanIdsIn(file: string): string[] {
	return readFileSync(file, "utf-8")
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line))
		.filter((entry) => entry?.type === "message" && entry.message?.role === "toolResult" && ORPHAN_IDS.includes(entry.message.toolCallId))
		.map((entry) => entry.message.toolCallId);
}

function emitAgentEvent(rpcClient: any, event: Record<string, unknown>): void {
	for (const listener of [...rpcClient.eventListeners]) listener(event);
}

function surfacePoisonedHistoryError(session: any, consecutiveErrorTurns: number): void {
	// This fixture represents an established conversation. Without this marker,
	// the mock's first artificial agent_end runs deferred setup and get_state,
	// which rewrites the canonical JSONL before the recovery boundary reads it.
	session.setupComplete = true;
	emitAgentEvent(session.rpcClient, {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			stopReason: "error",
			errorMessage: POISONED_HISTORY_ERROR,
		},
	});
	// Exhaust automatic retry before agent_end schedules it. This journey drives
	// the explicit Retry and follow-up recovery surfaces deterministically.
	session.transientRetryAttempts = 3;
	session.consecutiveErrorTurns = consecutiveErrorTurns;
	emitAgentEvent(session.rpcClient, { type: "agent_end", willRetry: false });
}

async function modelOf(session: any): Promise<{ provider?: string; id?: string }> {
	const state = await session.rpcClient.getState();
	return state.data?.model ?? {};
}

async function messageTextCount(session: any, marker: string): Promise<number> {
	const response = await session.rpcClient.getMessages();
	return (response.data ?? []).filter((message: any) =>
		Array.isArray(message?.content) && message.content.some((block: any) => block?.type === "text" && block.text.includes(marker)),
	).length;
}

async function assertSingleSessionIdentity(page: Page, sessionId: string, initialSidebarRows: number): Promise<void> {
	await expect(page).toHaveURL(new RegExp(`#\\/session\\/${sessionId}$`));
	await expect(page.locator(`[data-session-id="${sessionId}"]`).first()).toBeVisible();
	await expect(page.locator(`[data-session-id="${sessionId}"]`)).toHaveCount(initialSidebarRows);
	const response = await apiFetch("/api/sessions");
	expect(response.ok).toBe(true);
	const body = await response.json();
	const sessions = Array.isArray(body) ? body : Array.isArray(body.sessions) ? body.sessions : [];
	expect(sessions.filter((session: any) => session.id === sessionId)).toHaveLength(1);
}

function requireSession(sessionManager: any, sessionId: string): any {
	const session = sessionManager.getSession(sessionId);
	if (!session) throw new Error(`ORPHAN_TOOL_RESULT_BROWSER_RECOVERY: live session ${sessionId} missing`);
	return session;
}

test.describe("Journey: orphan tool-result recovery", () => {
	test.describe.configure({ retries: 0 });

	test("Retry and a capped follow-up repair history and respawn the same session", async ({ page, gateway }) => {
		test.setTimeout(120_000);
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			const sessionManager = gateway.sessionManager;
			if (!sessionManager) throw new Error("ORPHAN_TOOL_RESULT_BROWSER_RECOVERY: gateway session manager missing");
			let session = requireSession(sessionManager, sessionId);

			await session.rpcClient.setModel(MODEL.provider, MODEL.id);
			sessionManager.persistSessionModel(sessionId, MODEL.provider, MODEL.id);
			let persisted: any;
			await expect.poll(
				() => {
					persisted = sessionManager.getPersistedSession(sessionId);
					return persisted?.agentSessionFile;
				},
				{ timeout: 15_000, message: "ORPHAN_TOOL_RESULT_BROWSER_RECOVERY: persisted transcript path missing" },
			).toEqual(expect.any(String));
			// Use the canonical SessionStore path: every real repair boundary reads
			// this path, while a test-only switch_session alone does not update it.
			const transcriptFile = persisted.agentSessionFile as string;
			writeJsonl(transcriptFile, affectedPiSequence());
			await session.rpcClient.sendCommand({ type: "switch_session", sessionPath: transcriptFile });
			expect(sessionManager.getPersistedSession(sessionId)?.agentSessionFile).toBe(transcriptFile);
			session.lastPromptText = RETRY_INTENT;

			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			const editor = page.locator("message-editor textarea").first();
			await expect(editor).toBeVisible({ timeout: 20_000 });
			await expect(page.getByText(PRESERVED_HISTORY, { exact: true }).first()).toBeVisible();
			const initialSidebarRows = await page.locator(`[data-session-id="${sessionId}"]`).count();
			expect(initialSidebarRows).toBeGreaterThan(0);

			// The browser harness mock rewrites its current transcript on get_state.
			// Re-seed after app hydration so Retry exercises Bobbit's real persisted-
			// transcript repair boundary rather than a clobbered, id-less mock file.
			writeJsonl(transcriptFile, affectedPiSequence());
			expect(orphanIdsIn(transcriptFile)).toEqual([...ORPHAN_IDS]);
			const retryRpc = session.rpcClient;
			surfacePoisonedHistoryError(session, 3);
			await expect(page.getByText(/unexpected tool_use_id/i).last()).toBeVisible({ timeout: 10_000 });
			const retryButton = page.getByRole("button", { name: "Retry", exact: true }).last();
			await expect(retryButton).toBeVisible();
			await retryButton.click();

			await expect.poll(
				() => sessionManager.getSession(sessionId)?.rpcClient !== retryRpc,
				{ timeout: 20_000, message: "ORPHAN_TOOL_RESULT_BROWSER_RECOVERY: Retry must respawn poisoned history in place" },
			).toBe(true);
			await expect.poll(() => orphanIdsIn(transcriptFile), { timeout: 20_000 }).toEqual([]);
			session = requireSession(sessionManager, sessionId);
			await expect.poll(() => messageTextCount(session, RETRY_INTENT), { timeout: 20_000 }).toBe(1);
			await expect.poll(() => modelOf(session), { timeout: 20_000 }).toEqual(expect.objectContaining(MODEL));
			await page.reload();
			await expect(editor).toBeVisible({ timeout: 20_000 });
			await expect(page.getByText("OK", { exact: true }).last()).toBeVisible({ timeout: 20_000 });
			await expect(page.getByText(PRESERVED_HISTORY, { exact: true }).first()).toBeVisible();
			await assertSingleSessionIdentity(page, sessionId, initialSidebarRows);

			const cleanMessages = (await session.rpcClient.getMessages()).data ?? [];
			await session.rpcClient.getState();
			writePoisonedConversation(transcriptFile, cleanMessages, "follow-up");
			expect(orphanIdsIn(transcriptFile)).toEqual([...ORPHAN_IDS]);
			const followUpRpc = session.rpcClient;
			surfacePoisonedHistoryError(session, 3);
			await expect(page.getByText(/unexpected tool_use_id/i).last()).toBeVisible({ timeout: 10_000 });

			await editor.fill(FOLLOW_UP_INTENT);
			await editor.press("Enter");
			await expect.poll(
				() => sessionManager.getSession(sessionId)?.rpcClient !== followUpRpc,
				{ timeout: 20_000, message: "ORPHAN_TOOL_RESULT_BROWSER_RECOVERY: capped follow-up must sanitize and respawn before dispatch" },
			).toBe(true);
			await expect.poll(() => orphanIdsIn(transcriptFile), { timeout: 20_000 }).toEqual([]);
			session = requireSession(sessionManager, sessionId);
			await expect.poll(() => messageTextCount(session, FOLLOW_UP_INTENT), { timeout: 20_000 }).toBe(1);
			await expect.poll(() => session.promptQueue.toArray().filter((row: any) => row.text.includes(FOLLOW_UP_INTENT)).length, { timeout: 20_000 }).toBe(0);
			await expect.poll(() => modelOf(session), { timeout: 20_000 }).toEqual(expect.objectContaining(MODEL));
			await page.reload();
			await expect(editor).toBeVisible({ timeout: 20_000 });
			await expect(page.getByText(FOLLOW_UP_INTENT, { exact: true }).last()).toBeVisible({ timeout: 20_000 });
			await expect(page.getByText("OK", { exact: true }).last()).toBeVisible({ timeout: 20_000 });
			await expect(page.getByText(PRESERVED_HISTORY, { exact: true }).first()).toBeVisible();
			await assertSingleSessionIdentity(page, sessionId, initialSidebarRows);
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});
