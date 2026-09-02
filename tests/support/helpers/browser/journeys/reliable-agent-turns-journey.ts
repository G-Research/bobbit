import type { Page } from "@playwright/test";
import {
	createSession,
	deleteSession,
	expect,
	waitForSessionStatus,
} from "./journey-fixture.js";
import {
	ReliableTurnRuntime,
	intentRow,
	openSessionPage,
	transcriptIntent,
} from "./reliable-agent-turns.fixture.js";

export const RELIABLE_TURN_BUSY = "STAY_BUSY:60000 RELIABLE_TURN_BARRIER";

export async function createReliableTurnScenario(page: Page, gateway: any): Promise<{
	sessionId: string;
	runtime: ReliableTurnRuntime;
	cleanup(): Promise<void>;
}> {
	const sessionId = await createSession();
	await waitForSessionStatus(sessionId, "idle");
	await openSessionPage(page, sessionId);
	const runtime = new ReliableTurnRuntime(gateway, sessionId);
	return {
		sessionId,
		runtime,
		cleanup: async () => {
			runtime.restore();
			await deleteSession(sessionId).catch(() => {});
		},
	};
}

export async function expectReliableTurnTranscriptText(
	page: Page,
	intentId: string,
	text: string,
): Promise<void> {
	const row = transcriptIntent(page, intentId);
	await expect(row).toBeVisible({ timeout: 20_000 });
	await expect(row).toContainText(text);
}

export async function expectReliableTurnTarget(
	page: Page,
	intentId: string,
	kind: "prompt" | "steer",
	target: "continuation" | "next-turn",
): Promise<void> {
	const row = intentRow(page, intentId);
	await expect(row).toHaveAttribute("data-intent-kind", kind);
	await expect(row).toHaveAttribute("data-target-turn", target);
}

export async function expectCanonicalHumanReplyTail(page: Page, prompt: string): Promise<void> {
	await expect.poll(() => page.locator("user-message, assistant-message").evaluateAll((nodes) =>
		nodes.slice(-2).map((node) => ({ tag: node.tagName, text: node.textContent?.trim() ?? "" })),
	), { timeout: 20_000, message: "the settled human prompt and Pi reply must remain the canonical transcript tail" })
		.toEqual([
			{ tag: "USER-MESSAGE", text: expect.stringContaining(prompt) },
			{ tag: "ASSISTANT-MESSAGE", text: expect.stringContaining("OK") },
		]);
}
