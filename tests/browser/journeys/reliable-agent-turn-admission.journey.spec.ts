import fs from "node:fs";
import path from "node:path";
import {
	expect,
	test,
	waitForSessionStatus,
} from "../../support/helpers/browser/journeys/journey-fixture.js";
import {
	captureIntentIds,
	expectIntentState,
	expectOneCarrier,
	submit,
	submitManualCompact,
	transcriptIntent,
	transcriptIntentOrder,
} from "../../support/helpers/browser/journeys/reliable-agent-turns.fixture.js";
import {
	RELIABLE_TURN_BUSY,
	createReliableTurnScenario,
	expectReliableTurnTarget,
	expectReliableTurnTranscriptText,
} from "../../support/helpers/browser/journeys/reliable-agent-turns-journey.js";

test.describe("Journey: Reliable Agent Turns", () => {
	test.setTimeout(120_000);

	test("assistant Markdown renders session-local images through the authenticated asset route after reload", async ({ page, gateway }) => {
		const scenario = await createReliableTurnScenario(page, gateway);
		const session = gateway.sessionManager.getSession(scenario.sessionId);
		const relativePath = `.bobbit-qa/screenshots/markdown-local-${scenario.sessionId}.png`;
		const imagePath = path.join(session.cwd, ...relativePath.split("/"));
		// Minimal valid 1×1 transparent PNG.
		const png = Buffer.from(
			"89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D4944415478DA63F8CF000000030001000100A7E8B13C0000000049454E44AE426082",
			"hex",
		);
		fs.mkdirSync(path.dirname(imagePath), { recursive: true });
		fs.writeFileSync(imagePath, png);
		try {
			const assetResponse = page.waitForResponse((response) =>
				response.url().includes(`/api/sessions/${scenario.sessionId}/markdown-image`),
			);
			await submit(page, `MARKDOWN_LOCAL_IMAGE:${relativePath}`);
			const response = await assetResponse;
			expect(response.status()).toBe(200);
			expect(response.headers()["content-type"]).toBe("image/png");

			const image = page.getByTestId("session-markdown-image");
			await expect(image).toHaveAttribute("alt", "Session local screenshot", { timeout: 20_000 });
			await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);

			await page.reload();
			await expect(image).toHaveAttribute("alt", "Session local screenshot", { timeout: 20_000 });
			await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);
		} finally {
			fs.rmSync(imagePath, { force: true });
			await scenario.cleanup();
		}
	});

	test("idle and busy prompts keep one visible carrier from acceptance through transcript surfacing", async ({ page, gateway }) => {
		const scenario = await createReliableTurnScenario(page, gateway);
		try {
			const idleText = "RAT_IDLE_PROMPT";
			const idleEcho = scenario.runtime.holdEcho(idleText);
			await submit(page, idleText);
			await idleEcho.entered;
			const [idleId] = await captureIntentIds(page, idleText);
			await expectReliableTurnTarget(page, idleId, "prompt", "next-turn");
			await expectIntentState(page, idleId, "dispatching", /Sending|Adding to chat/);
			await expectOneCarrier(page, idleId, "outbox");

			idleEcho.release();
			await expectReliableTurnTranscriptText(page, idleId, idleText);
			await expectOneCarrier(page, idleId, "transcript");
			await waitForSessionStatus(scenario.sessionId, "idle");

			const tool = scenario.runtime.holdNextTool();
			await submit(page, RELIABLE_TURN_BUSY);
			await tool.entered;

			const queuedText = "RAT_BUSY_FOLLOW_UP";
			const queuedEcho = scenario.runtime.holdEcho(queuedText);
			await submit(page, queuedText);
			const [queuedId] = await captureIntentIds(page, queuedText);
			await expectReliableTurnTarget(page, queuedId, "prompt", "next-turn");
			await expectIntentState(page, queuedId, "queued", /Queued for next turn/);
			await expectOneCarrier(page, queuedId, "outbox");

			tool.release();
			await queuedEcho.entered;
			await expectOneCarrier(page, queuedId, "outbox");
			queuedEcho.release();
			await expectReliableTurnTranscriptText(page, queuedId, queuedText);
			await expectOneCarrier(page, queuedId, "transcript");
		} finally {
			await scenario.cleanup();
		}
	});

	test("direct and identical fast steers stay ordered in the outbox through delayed RPC acknowledgement and Pi echo", async ({ page, gateway }) => {
		const scenario = await createReliableTurnScenario(page, gateway);
		try {
			const tool = scenario.runtime.holdNextTool();
			await submit(page, RELIABLE_TURN_BUSY);
			await tool.entered;

			const delayedText = "STAY_BUSY:60000 RAT_DELAYED_STEER";
			const delayedEcho = scenario.runtime.holdEcho(delayedText);
			const delayedAck = scenario.runtime.holdSteerAcknowledgement(delayedText);
			await submit(page, delayedText, "steer");
			const [delayedId] = await captureIntentIds(page, delayedText);
			await expectReliableTurnTarget(page, delayedId, "steer", "continuation");
			await delayedAck.entered;
			await expectIntentState(page, delayedId, "dispatching", /Sending/);
			await expectOneCarrier(page, delayedId, "outbox");

			delayedAck.release();
			await delayedEcho.entered;
			await expectIntentState(page, delayedId, "dispatching", /Adding to chat|Sending/);
			await expectOneCarrier(page, delayedId, "outbox");
			delayedEcho.release();
			await expectReliableTurnTranscriptText(page, delayedId, delayedText);
			await expectOneCarrier(page, delayedId, "transcript");
			await expect(page.getByRole("button", { name: "Stop current turn" })).toBeVisible({ timeout: 15_000 });

			const identicalText = "RAT_IDENTICAL_STEER";
			const firstEcho = scenario.runtime.holdEcho(identicalText, "identical-echo-1");
			const secondEcho = scenario.runtime.holdEcho(identicalText, "identical-echo-2");
			await submit(page, identicalText, "steer");
			await submit(page, identicalText, "steer");
			const [firstId, secondId] = await captureIntentIds(page, identicalText, 2);
			expect(firstId).not.toBe(secondId);
			await expectOneCarrier(page, firstId, "outbox");
			await expectOneCarrier(page, secondId, "outbox");

			await firstEcho.entered;
			firstEcho.release();
			await expectOneCarrier(page, firstId, "transcript");
			await expectOneCarrier(page, secondId, "outbox");
			await secondEcho.entered;
			secondEcho.release();
			await expectOneCarrier(page, secondId, "transcript");
			expect(await transcriptIntentOrder(page, [firstId, secondId])).toEqual([firstId, secondId]);
			await expect(transcriptIntent(page, firstId)).toContainText(identicalText);
			await expect(transcriptIntent(page, secondId)).toContainText(identicalText);
		} finally {
			await scenario.cleanup();
		}
	});

	for (const mode of ["manual", "threshold"] as const) {
		test(`${mode} compaction accepts prompt and steer visibly, fences delivery, then releases the correct lanes once`, async ({ page, gateway }) => {
			const scenario = await createReliableTurnScenario(page, gateway);
			try {
				const compaction = scenario.runtime.holdNextCompaction({ reason: mode });
				if (mode === "manual") await submitManualCompact(page);
				else await submit(page, "RELIABLE_COMPACTION:threshold RAT_THRESHOLD");
				await compaction.compaction.entered;
				await expect(page.getByTestId("compaction-summary-card").first()).toBeVisible({ timeout: 15_000 });

				const promptText = `RAT_${mode.toUpperCase()}_PROMPT`;
				const steerText = `RAT_${mode.toUpperCase()}_STEER`;
				const promptEcho = scenario.runtime.holdEcho(promptText);
				const steerEcho = scenario.runtime.holdEcho(steerText);
				await submit(page, promptText);
				const [promptId] = await captureIntentIds(page, promptText);
				await submit(page, steerText, "steer");
				const [steerId] = await captureIntentIds(page, steerText);

				const steerTarget = mode === "manual" ? "next-turn" : "continuation";
				await expectReliableTurnTarget(page, promptId, "prompt", "next-turn");
				await expectReliableTurnTarget(page, steerId, "steer", steerTarget);
				await expectOneCarrier(page, promptId, "outbox");
				await expectOneCarrier(page, steerId, "outbox");
				await expectIntentState(page, promptId, "queued", /Compacting|Queued for next turn/);
				await expectIntentState(page, steerId, "queued", /Compacting|Steer queued/);

				compaction.compaction.release();
				if (mode === "manual") {
					await promptEcho.entered;
					promptEcho.release();
					await steerEcho.entered;
					steerEcho.release();
				} else {
					await steerEcho.entered;
					steerEcho.release();
					await promptEcho.entered;
					promptEcho.release();
				}
				await expectOneCarrier(page, promptId, "transcript");
				await expectOneCarrier(page, steerId, "transcript");
				const expectedOrder = mode === "manual" ? [promptId, steerId] : [steerId, promptId];
				expect(await transcriptIntentOrder(page, [promptId, steerId])).toEqual(expectedOrder);
			} finally {
				await scenario.cleanup();
			}
		});
	}

	test("overflow compaction hides the superseded provider error and releases each delivery lane once", async ({ page, gateway }) => {
		const scenario = await createReliableTurnScenario(page, gateway);
		try {
			const providerError = "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.";
			const overflow = scenario.runtime.holdNextCompaction({
				reason: "overflow",
				willRetry: true,
				preCompactionError: providerError,
			});
			await submit(page, "RELIABLE_COMPACTION:overflow RAT_OVERFLOW");
			await overflow.compaction.entered;
			await expect(page.getByTestId("compaction-summary-card").first()).toBeVisible({ timeout: 15_000 });
			await expect(page.getByText(providerError, { exact: true })).toHaveCount(0);

			const promptText = "RAT_OVERFLOW_NEXT_TURN";
			const steerText = "RAT_OVERFLOW_CONTINUATION";
			const promptEcho = scenario.runtime.holdEcho(promptText);
			await submit(page, promptText);
			const [promptId] = await captureIntentIds(page, promptText);
			await submit(page, steerText, "steer");
			const [steerId] = await captureIntentIds(page, steerText);
			await expectReliableTurnTarget(page, promptId, "prompt", "next-turn");
			await expectReliableTurnTarget(page, steerId, "steer", "continuation");

			overflow.compaction.release();
			await overflow.retry!.entered;
			await expect(page.getByTestId("compaction-summary-card").first())
				.toHaveAttribute("data-state", "complete", { timeout: 15_000 });
			await expect(page.getByText(providerError, { exact: true })).toHaveCount(0);
			await expectOneCarrier(page, steerId, "transcript");
			await expectOneCarrier(page, promptId, "outbox");
			await expectIntentState(page, promptId, "queued", /Queued for next turn/);

			overflow.retry!.release();
			await promptEcho.entered;
			promptEcho.release();
			await expectOneCarrier(page, promptId, "transcript");
			expect(await transcriptIntentOrder(page, [promptId, steerId])).toEqual([steerId, promptId]);
		} finally {
			await scenario.cleanup();
		}
	});

});
