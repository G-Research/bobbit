import {
	createSession,
	deleteSession,
	expect,
	navigateToHash,
	openApp,
	sendMessage,
	test,
	waitForAgentResponse,
	waitForSessionStatus,
} from "../_helpers/journey-fixture.js";

interface CapturedAuthors {
	user: { kind: string; id: string; label: string };
	assistant: { kind: string; id: string; label: string };
}

async function captureAuthors(page: import("@playwright/test").Page, prompt: string): Promise<CapturedAuthors> {
	return page.evaluate((promptText) => {
		const appState = (window as any).bobbitState ?? (window as any).__bobbitState;
		const messages = appState?.remoteAgent?.state?.messages ?? [];
		const textOf = (message: any): string => {
			if (typeof message?.content === "string") return message.content;
			if (!Array.isArray(message?.content)) return "";
			return message.content
				.filter((block: any) => block?.type === "text")
				.map((block: any) => block.text ?? "")
				.join("\n");
		};
		const user = messages.find((message: any) =>
			(message.role === "user" || message.role === "user-with-attachments")
			&& textOf(message) === promptText,
		);
		const assistant = [...messages].reverse().find((message: any) => message.role === "assistant");
		if (!user?.author || !assistant?.author) {
			throw new Error("authored user and assistant messages are not available");
		}
		return { user: user.author, assistant: assistant.author };
	}, prompt);
}

test.describe("Journey: Author metadata", () => {
	test("normal prompt authors survive reload without adding visible labels", async ({ page }) => {
		const sessionId = await createSession();
		const prompt = `author-metadata-${Date.now()}`;
		await waitForSessionStatus(sessionId, "idle");

		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await sendMessage(page, prompt);
			await waitForAgentResponse(page, { timeout: 20_000 });
			await waitForSessionStatus(sessionId, "idle");

			await expect.poll(
				() => captureAuthors(page, prompt).catch(() => null),
				{ timeout: 15_000 },
			).not.toBeNull();
			const liveAuthors = await captureAuthors(page, prompt);
			expect(liveAuthors.user.kind).toBe("user");
			expect(liveAuthors.user.id).toBe("user:local");
			expect(liveAuthors.assistant.kind).toBe("agent");
			expect(liveAuthors.assistant.id).toBeTruthy();

			const userBubble = page.locator("user-message").filter({ hasText: prompt }).last();
			const assistantBubble = page.locator("assistant-message").last();
			await expect(userBubble).toBeVisible();
			await expect(assistantBubble).toBeVisible();
			expect(await userBubble.innerText()).not.toMatch(/(^|\n)User($|\n)/);
			expect(await assistantBubble.innerText()).not.toMatch(/(^|\n)(Agent|Bobbit)($|\n)/);

			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			await expect.poll(
				() => captureAuthors(page, prompt).catch(() => null),
				{ timeout: 20_000 },
			).not.toBeNull();
			const reloadedAuthors = await captureAuthors(page, prompt);
			expect(reloadedAuthors).toEqual(liveAuthors);

			await expect(page.locator("user-message").filter({ hasText: prompt }).last()).toBeVisible();
			expect(await page.locator("user-message").filter({ hasText: prompt }).last().innerText())
				.not.toMatch(/(^|\n)User($|\n)/);
		} finally {
			await deleteSession(sessionId);
		}
	});
});
