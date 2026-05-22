/** Full-stack replay/navigation: persisted transcripts land pinned on session hops. */
import { test, expect } from "./fixtures.js";
import { createSession, waitForSessionStatus, waitForHealth } from "../e2e-setup.js";
import {
	TAIL_PX,
	disableScrollAnchoring,
	expectLatestMessagePinned,
	navigateToTailSession,
	openTailSession,
	seedSessionViaWs,
	settleFrames,
} from "./tail-chat-helpers.js";

test.describe("tail-chat: session navigate lands on latest message", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test.setTimeout(90_000);

	test("A → B → A → B → A: each replayed transcript is bottom-pinned", async ({ page, rec }) => {
		const sessionA = await createSession();
		const sessionB = await createSession();
		await waitForSessionStatus(sessionA, "idle");
		await waitForSessionStatus(sessionB, "idle");

		// Seed via WS so this test spends browser time only on the replay/navigation
		// behavior it owns. Streaming live scroll is covered by tail-chat-real-stream.
		await seedSessionViaWs(sessionA, "STREAM_BURST:1 seed A");
		await seedSessionViaWs(sessionB, "STREAM_BURST:1 seed B");

		await openTailSession(page, sessionA);
		await disableScrollAnchoring(page);

		const hops: Array<{ id: string; label: string }> = [
			{ id: sessionA, label: "A (1st)" },
			{ id: sessionB, label: "B (1st)" },
			{ id: sessionA, label: "A (2nd)" },
			{ id: sessionB, label: "B (2nd)" },
			{ id: sessionA, label: "A (3rd)" },
		];
		for (const { id, label } of hops) {
			await navigateToTailSession(page, id);
			await page.waitForFunction(
				() => document.querySelectorAll("user-message, assistant-message, tool-message").length > 0,
				null,
				{ timeout: 15_000 },
			);
			await settleFrames(page, 4);
			await rec.capture(`Hop "${label}"`);
			await expectLatestMessagePinned(page, { tailPx: TAIL_PX, label });
		}

		const msgCount = await page.evaluate(
			() => document.querySelectorAll("user-message, assistant-message, tool-message").length,
		);
		expect(msgCount, "final session must have message DOM nodes").toBeGreaterThan(0);
	});
});
