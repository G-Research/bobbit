import {
	createSession,
	deleteSession,
	expect,
	navigateToHash,
	openApp,
	sendMessage,
	test,
	waitForSessionStatus,
} from "../_helpers/journey-fixture.js";

interface CapturedAuthors {
	user: { kind: string; id: string; label: string };
	assistant: { kind: string; id: string; label: string };
}

async function waitForAuthoredExchange(
	page: import("@playwright/test").Page,
	prompt: string,
): Promise<CapturedAuthors> {
	const handle = await page.waitForFunction((promptText) => {
		const appState = (window as any).bobbitState ?? (window as any).__bobbitState;
		const remoteState = appState?.remoteAgent?.state;
		const messages = remoteState?.messages ?? [];
		const textOf = (message: any): string => {
			if (typeof message?.content === "string") return message.content;
			if (!Array.isArray(message?.content)) return "";
			return message.content
				.filter((block: any) => block?.type === "text")
				.map((block: any) => block.text ?? "")
				.join("\n");
		};
		const userIndex = messages.findIndex((message: any) =>
			(message.role === "user" || message.role === "user-with-attachments")
			&& textOf(message) === promptText,
		);
		if (userIndex < 0) return null;
		const user = messages[userIndex];
		const assistant = messages.slice(userIndex + 1).find((message: any) => message.role === "assistant");
		if (remoteState.status !== "idle" || !user?.author || !assistant?.author) return null;
		return { user: user.author, assistant: assistant.author };
	}, prompt);
	return handle.jsonValue() as Promise<CapturedAuthors>;
}

test.describe("Journey: Author metadata", () => {
	test("normal prompt authors survive reload without adding visible labels", async ({ page }) => {
		const sessionId = await createSession();
		const prompt = "AUTHOR_METADATA_RELOAD_SMOKE";
		await waitForSessionStatus(sessionId, "idle");

		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await sendMessage(page, prompt);

			const liveAuthors = await waitForAuthoredExchange(page, prompt);
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
			const reloadedAuthors = await waitForAuthoredExchange(page, prompt);
			expect(reloadedAuthors).toEqual(liveAuthors);

			await expect(page.locator("user-message").filter({ hasText: prompt }).last()).toBeVisible();
			expect(await page.locator("user-message").filter({ hasText: prompt }).last().innerText())
				.not.toMatch(/(^|\n)User($|\n)/);
		} finally {
			await deleteSession(sessionId);
		}
	});
});
