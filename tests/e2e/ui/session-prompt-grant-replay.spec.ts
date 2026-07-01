/**
 * Regression coverage for ask-gated session_prompt grants.
 *
 * This drives the browser permission-card path so AgentInterface passes
 * `lastPromptText` into RemoteAgent.grantToolPermission(). A broad client-side
 * replay of that text re-runs the side-effecting session_prompt request and can
 * deliver the same target prompt twice.
 */
import { test, expect } from "../gateway-harness.js";
import {
	apiFetch,
	connectWs,
	createSession,
	deleteSession,
	nonGitCwd,
	waitForSessionStatus,
	type WsConnection,
} from "../e2e-setup.js";
import { openApp, navigateToHash, sendMessage } from "./ui-helpers.js";
import { pollUntil } from "../test-utils/cleanup.js";

const ASK_SESSION_PROMPT_TOOL = "session_prompt";

test.setTimeout(60_000);

function messageText(message: any): string {
	return (message?.content || [])
		.map((block: any) => typeof block?.text === "string" ? block.text : "")
		.join("\n");
}

function matchingUserTurns(conn: WsConnection, fromIndex: number, marker: string): any[] {
	return conn.messages.slice(fromIndex).filter((m) => m.type === "event"
		&& m.data?.type === "message_end"
		&& m.data?.message?.role === "user"
		&& messageText(m.data.message).includes(marker));
}

async function waitForGrantReplayObservationWindow(): Promise<void> {
	const doneAt = Date.now() + 1_500;
	await pollUntil(
		() => Date.now() >= doneAt,
		{ timeoutMs: 2_000, intervalMs: 100, label: "grant replay observation window" },
	);
}

async function createAskSessionPromptRole(roleName: string): Promise<void> {
	const resp = await apiFetch("/api/roles", {
		method: "POST",
		body: JSON.stringify({
			name: roleName,
			label: `Ask session_prompt ${roleName}`,
			promptTemplate: "E2E ask-gated session_prompt role.",
			toolPolicies: { [ASK_SESSION_PROMPT_TOOL]: "ask" },
		}),
	});
	const text = await resp.text();
	expect(resp.status, text).toBe(201);
}

async function createRoleSession(roleName: string): Promise<string> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd: nonGitCwd(), roleId: roleName }),
	});
	const data = await resp.json();
	expect(resp.status, JSON.stringify(data)).toBe(201);
	return data.id;
}

async function prepareCallerAndTarget(page: any, roleName: string): Promise<{
	callerId: string;
	targetId: string;
	callerConn: WsConnection;
	targetConn: WsConnection;
	callerCursor: number;
	targetCursor: number;
}> {
	const targetId = await createSession({ cwd: nonGitCwd() });
	const callerId = await createRoleSession(roleName);
	await waitForSessionStatus(targetId, "idle");
	await waitForSessionStatus(callerId, "idle");

	await openApp(page);
	await navigateToHash(page, `#/session/${callerId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });

	const callerConn = await connectWs(callerId);
	const targetConn = await connectWs(targetId);
	return {
		callerId,
		targetId,
		callerConn,
		targetConn,
		callerCursor: callerConn.messageCount(),
		targetCursor: targetConn.messageCount(),
	};
}

async function assertGrantDeliversExactlyOnce(opts: {
	page: any;
	roleName: string;
}): Promise<void> {
	const { page, roleName } = opts;
	const sessions: string[] = [];
	let callerConn: WsConnection | undefined;
	let targetConn: WsConnection | undefined;

	try {
		const prepared = await prepareCallerAndTarget(page, roleName);
		const { callerId, targetId, callerCursor, targetCursor } = prepared;
		callerConn = prepared.callerConn;
		targetConn = prepared.targetConn;
		sessions.push(callerId, targetId);

		const marker = `SESSION_PROMPT_GRANT_DEDUP_persistent_${Date.now()}`;
		const promptText = `SESSION_PROMPT_TOOL:${targetId}::${marker}`;

		await sendMessage(page, promptText);

		const card = page.locator("tool-permission-card").first();
		await expect(card).toBeVisible({ timeout: 20_000 });
		await expect(card.locator("code").first()).toContainText(ASK_SESSION_PROMPT_TOOL);

		await card.getByRole("button", { name: /Allow just/i }).click();
		await expect(card.getByText(/Permission granted/i)).toBeVisible({ timeout: 10_000 });

		await pollUntil(
			() => matchingUserTurns(targetConn!, targetCursor, marker).length >= 1,
			{ timeoutMs: 20_000, intervalMs: 100, label: "session_prompt target delivery after grant" },
		);

		// RemoteAgent's historical grant replay fired 200ms after the caller returned
		// idle. Wait a bounded window so a second caller prompt/target delivery is
		// observable; if the replay opens another permission card, the caller user
		// turn count below catches it without waiting for idle forever.
		await waitForGrantReplayObservationWindow();

		const callerMatches = matchingUserTurns(callerConn, callerCursor, marker);
		const targetMatches = matchingUserTurns(targetConn, targetCursor, marker);
		expect(callerMatches, "granting permission must not replay lastPromptText as a second caller user turn").toHaveLength(1);
		expect(targetMatches, "ask-gated session_prompt grant must deliver the target prompt exactly once").toHaveLength(1);
	} finally {
		callerConn?.close();
		targetConn?.close();
		for (const sessionId of sessions) await deleteSession(sessionId).catch(() => {});
	}
}

test.describe("session_prompt ask grant replay regression (UI)", () => {
	let roleName: string;

	test.beforeEach(async () => {
		roleName = `ask-session-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		await createAskSessionPromptRole(roleName);
	});

	test.afterEach(async () => {
		if (roleName) await apiFetch(`/api/roles/${roleName}`, { method: "DELETE" }).catch(() => {});
	});

	test("persistent grant delivers one target prompt and does not replay the caller prompt", async ({ page }) => {
		await assertGrantDeliversExactlyOnce({ page, roleName });
	});

	test("deny resolves the ask gate without delivering to the target", async ({ page }) => {
		const sessions: string[] = [];
		let callerConn: WsConnection | undefined;
		let targetConn: WsConnection | undefined;

		try {
			const prepared = await prepareCallerAndTarget(page, roleName);
			const { callerId, targetId, targetCursor } = prepared;
			callerConn = prepared.callerConn;
			targetConn = prepared.targetConn;
			sessions.push(callerId, targetId);

			const marker = `SESSION_PROMPT_GRANT_DENY_${Date.now()}`;
			await sendMessage(page, `SESSION_PROMPT_TOOL:${targetId}::${marker}`);

			const card = page.locator("tool-permission-card").first();
			await expect(card).toBeVisible({ timeout: 20_000 });
			await expect(card.locator("code").first()).toContainText(ASK_SESSION_PROMPT_TOOL);
			await card.getByRole("button", { name: /Deny/i }).click();

			await waitForSessionStatus(callerId, "idle", 20_000);
			await waitForGrantReplayObservationWindow();

			expect(matchingUserTurns(targetConn, targetCursor, marker), "denying the ask-gated session_prompt request must not deliver to target").toHaveLength(0);
		} finally {
			callerConn?.close();
			targetConn?.close();
			for (const sessionId of sessions) await deleteSession(sessionId).catch(() => {});
		}
	});
});
