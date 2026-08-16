import type { Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import {
	createSession,
	deleteSession,
	expect,
	test,
	waitForSessionStatus,
} from "../_helpers/journey-fixture.js";
import {
	ReliableTurnRuntime,
	captureIntentIds,
	closeActiveSessionSocket,
	editor,
	expectIntentState,
	expectOneCarrier,
	intentRow,
	intentRows,
	openSecondSessionTab,
	openSessionPage,
	submit,
	submitManualCompact,
	transcriptIntent,
	transcriptIntentOrder,
	waitForRemoteStatus,
} from "./reliable-agent-turns.fixture.js";

const BUSY = "STAY_BUSY:60000 RELIABLE_TURN_BARRIER";

async function createScenario(page: Page, gateway: any): Promise<{
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

async function expectTranscriptText(page: Page, intentId: string, text: string): Promise<void> {
	const row = transcriptIntent(page, intentId);
	await expect(row).toBeVisible({ timeout: 20_000 });
	await expect(row).toContainText(text);
}

async function expectTarget(
	page: Page,
	intentId: string,
	kind: "prompt" | "steer",
	target: "continuation" | "next-turn",
): Promise<void> {
	const row = intentRow(page, intentId);
	await expect(row).toHaveAttribute("data-intent-kind", kind);
	await expect(row).toHaveAttribute("data-target-turn", target);
}

async function expectCanonicalHumanReplyTail(page: Page, prompt: string): Promise<void> {
	await expect.poll(() => page.locator("user-message, assistant-message").evaluateAll((nodes) =>
		nodes.slice(-2).map((node) => ({ tag: node.tagName, text: node.textContent?.trim() ?? "" })),
	), { timeout: 20_000, message: "the settled human prompt and Pi reply must remain the canonical transcript tail" })
		.toEqual([
			{ tag: "USER-MESSAGE", text: expect.stringContaining(prompt) },
			{ tag: "ASSISTANT-MESSAGE", text: expect.stringContaining("OK") },
		]);
}

test.describe("Journey: Reliable Agent Turns", () => {
	test.setTimeout(120_000);

	test("assistant Markdown renders session-local images through the authenticated asset route after reload", async ({ page, gateway }) => {
		const scenario = await createScenario(page, gateway);
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
		const scenario = await createScenario(page, gateway);
		try {
			const idleText = "RAT_IDLE_PROMPT";
			const idleEcho = scenario.runtime.holdEcho(idleText);
			await submit(page, idleText);
			await idleEcho.entered;
			const [idleId] = await captureIntentIds(page, idleText);
			await expectTarget(page, idleId, "prompt", "next-turn");
			await expectIntentState(page, idleId, "dispatching", /Sending|Adding to chat/);
			await expectOneCarrier(page, idleId, "outbox");

			idleEcho.release();
			await expectTranscriptText(page, idleId, idleText);
			await expectOneCarrier(page, idleId, "transcript");
			await waitForSessionStatus(scenario.sessionId, "idle");

			const tool = scenario.runtime.holdNextTool();
			await submit(page, BUSY);
			await tool.entered;

			const queuedText = "RAT_BUSY_FOLLOW_UP";
			const queuedEcho = scenario.runtime.holdEcho(queuedText);
			await submit(page, queuedText);
			const [queuedId] = await captureIntentIds(page, queuedText);
			await expectTarget(page, queuedId, "prompt", "next-turn");
			await expectIntentState(page, queuedId, "queued", /Queued for next turn/);
			await expectOneCarrier(page, queuedId, "outbox");

			tool.release();
			await queuedEcho.entered;
			await expectOneCarrier(page, queuedId, "outbox");
			queuedEcho.release();
			await expectTranscriptText(page, queuedId, queuedText);
			await expectOneCarrier(page, queuedId, "transcript");
		} finally {
			await scenario.cleanup();
		}
	});

	test("direct and identical fast steers stay ordered in the outbox through delayed RPC acknowledgement and Pi echo", async ({ page, gateway }) => {
		const scenario = await createScenario(page, gateway);
		try {
			const tool = scenario.runtime.holdNextTool();
			await submit(page, BUSY);
			await tool.entered;

			const delayedText = "STAY_BUSY:60000 RAT_DELAYED_STEER";
			const delayedEcho = scenario.runtime.holdEcho(delayedText);
			const delayedAck = scenario.runtime.holdSteerAcknowledgement(delayedText);
			await submit(page, delayedText, "steer");
			const [delayedId] = await captureIntentIds(page, delayedText);
			await expectTarget(page, delayedId, "steer", "continuation");
			await delayedAck.entered;
			await expectIntentState(page, delayedId, "dispatching", /Sending/);
			await expectOneCarrier(page, delayedId, "outbox");

			delayedAck.release();
			await delayedEcho.entered;
			await expectIntentState(page, delayedId, "dispatching", /Adding to chat|Sending/);
			await expectOneCarrier(page, delayedId, "outbox");
			delayedEcho.release();
			await expectTranscriptText(page, delayedId, delayedText);
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
			const scenario = await createScenario(page, gateway);
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
				await expectTarget(page, promptId, "prompt", "next-turn");
				await expectTarget(page, steerId, "steer", steerTarget);
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
		const scenario = await createScenario(page, gateway);
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
			await expectTarget(page, promptId, "prompt", "next-turn");
			await expectTarget(page, steerId, "steer", "continuation");

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

	test("Stop during a long tool and immediately after a steer resolves ambiguity without loss or replay", async ({ page, gateway }) => {
		const scenario = await createScenario(page, gateway);
		try {
			const tool = scenario.runtime.holdNextTool();
			await submit(page, BUSY);
			await tool.entered;

			const queuedText = "RAT_STOP_QUEUED_PROMPT";
			const queuedEcho = scenario.runtime.holdEcho(queuedText);
			await submit(page, queuedText);
			const [queuedId] = await captureIntentIds(page, queuedText);

			const steerText = "RAT_STOP_AFTER_ACK_BEFORE_ECHO";
			const steerStart = scenario.runtime.holdNextSteerUserStart();
			await submit(page, steerText, "steer");
			const [steerId] = await captureIntentIds(page, steerText);
			steerStart.bindIntent(steerId);
			await steerStart.entered;

			const abort = scenario.runtime.holdNextAbort();
			const stop = page.getByRole("button", { name: "Stop current turn" });
			await expect(stop).toBeVisible({ timeout: 15_000 });
			await stop.click();
			await abort.received;
			await abort.beforeAgentEnd.entered;
			await expect(page.getByRole("button", { name: "Stopping current turn" })).toBeVisible({ timeout: 15_000 });
			await expectOneCarrier(page, queuedId, "outbox");
			await expectOneCarrier(page, steerId, "outbox");
			await expectIntentState(page, steerId, "uncertain", /Awaiting delivery confirmation/);

			expect(scenario.runtime.barrierJournal.map((entry) => entry.name)).toEqual(expect.arrayContaining([
				steerStart.boundary,
				abort.receivedBoundary,
				abort.beforeAgentEnd.boundary,
			]));
			expect(scenario.runtime.commandJournal.filter((entry) =>
				entry.kind === "steer" && entry.occurrence === steerStart.occurrence,
			)).toEqual([expect.objectContaining({ text: steerText })]);
			expect(scenario.runtime.commandJournal.filter((entry) =>
				entry.kind === "abort" && entry.occurrence === abort.occurrence,
			)).toHaveLength(1);
			steerStart.release();
			await expectOneCarrier(page, steerId, "transcript");
			abort.beforeAgentEnd.release();
			tool.release();
			await queuedEcho.entered;
			queuedEcho.release();
			await expectOneCarrier(page, queuedId, "transcript");
			await expect(transcriptIntent(page, steerId)).toHaveCount(1);
			await expect(transcriptIntent(page, queuedId)).toHaveCount(1);
		} finally {
			await scenario.cleanup();
		}
	});

	test("Stop near compaction completion leaves every accepted occurrence in one deterministic visible channel", async ({ page, gateway }) => {
		const scenario = await createScenario(page, gateway);
		try {
			const compaction = scenario.runtime.holdNextCompaction({ reason: "threshold" });
			await submit(page, "RELIABLE_COMPACTION:threshold RAT_STOP_THRESHOLD");
			await compaction.compaction.entered;

			const text = "RAT_STOP_AT_COMPACTION_END";
			const steerStart = scenario.runtime.holdNextSteerUserStart();
			await submit(page, text, "steer");
			const [id] = await captureIntentIds(page, text);
			steerStart.bindIntent(id);
			await expectOneCarrier(page, id, "outbox");

			compaction.compaction.release();
			await steerStart.entered;
			const firstStreamingVersion = scenario.runtime.surfaceActiveRun();
			await waitForRemoteStatus(page, firstStreamingVersion);
			const activeRunVersion = scenario.runtime.surfaceActiveRun();
			await waitForRemoteStatus(page, activeRunVersion, "streaming");
			const abort = scenario.runtime.holdNextAbort();
			const stop = page.getByRole("button", { name: "Stop current turn" });
			await expect(stop).toBeVisible({ timeout: 15_000 });
			await stop.click();
			await abort.received;
			await abort.beforeAgentEnd.entered;
			await expectOneCarrier(page, id, "outbox");
			await expectIntentState(page, id, "uncertain", /Awaiting delivery confirmation/);
			expect(scenario.runtime.barrierJournal.map((entry) => entry.name)).toEqual(expect.arrayContaining([
				steerStart.boundary,
				abort.receivedBoundary,
				abort.beforeAgentEnd.boundary,
			]));
			expect(scenario.runtime.commandJournal.filter((entry) =>
				entry.kind === "steer" && entry.occurrence === steerStart.occurrence,
			)).toEqual([expect.objectContaining({ text })]);
			expect(scenario.runtime.commandJournal.filter((entry) =>
				entry.kind === "abort" && entry.occurrence === abort.occurrence,
			)).toHaveLength(1);
			steerStart.release();
			await expectOneCarrier(page, id, "transcript");
			abort.beforeAgentEnd.release();
			await expect(transcriptIntent(page, id)).toHaveCount(1);
		} finally {
			await scenario.cleanup();
		}
	});

	test("offline admission, reconnect, reload, and a second tab preserve the same intent id until correlated surfacing", async ({ page, context, gateway }) => {
		const scenario = await createScenario(page, gateway);
		let secondPage: Page | undefined;
		try {
			const text = "RAT_RECONNECT_RELOAD_SECOND_TAB";
			const echo = scenario.runtime.holdEcho(text);
			await context.setOffline(true);
			await closeActiveSessionSocket(page);
			await submit(page, text);
			const [id] = await captureIntentIds(page, text);
			await expectIntentState(page, id, "local", /Waiting for connection/);
			await expectOneCarrier(page, id, "outbox");

			await context.setOffline(false);
			await echo.entered;
			await expectOneCarrier(page, id, "outbox");
			await expect(intentRow(page, id)).not.toHaveAttribute("data-delivery-state", "local");

			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(editor(page)).toBeVisible({ timeout: 20_000 });
			await expectOneCarrier(page, id, "outbox");

			secondPage = await openSecondSessionTab(context, scenario.sessionId);
			await expectOneCarrier(secondPage, id, "outbox");

			echo.release();
			await expectOneCarrier(page, id, "transcript");
			await expectOneCarrier(secondPage, id, "transcript");
			await expect(transcriptIntent(page, id)).toHaveCount(1);
			await expect(transcriptIntent(secondPage, id)).toHaveCount(1);
		} finally {
			await context.setOffline(false).catch(() => {});
			await secondPage?.close().catch(() => {});
			await scenario.cleanup();
		}
	});

	test("large pending task notifications stay in the outbox while the human prompt and reply remain the reload tail", async ({ page, gateway }) => {
		const scenario = await createScenario(page, gateway);
		try {
			const prompt = "RAT_VISIBLE_HUMAN_PROMPT_AFTER_LARGE_TASK_NOTIFICATIONS";
			const notifications = ["alpha", "beta", "gamma"].map((task) =>
				`Task complete: ${task} — RAT_PENDING_TASK_NOTIFICATION_${task.toUpperCase()}\n${"Detailed worker result retained for reliable recovery. ".repeat(90)}`,
			);
			const humanEcho = scenario.runtime.holdEcho(prompt);
			const notificationEchoes = notifications.map((text) => scenario.runtime.holdTaskNotificationEcho(text));

			await submit(page, prompt);
			await humanEcho.entered;
			const [humanIntentId] = await captureIntentIds(page, prompt);
			await expectOneCarrier(page, humanIntentId, "outbox");

			// These are server-generated task-complete steers: the browser does not
			// provide their occurrence IDs. They must still receive durable delivery
			// identity and stay in the delivery surface, not the transcript.
			await scenario.runtime.dispatchTaskNotifications(notifications);
			const notificationIntentIds = (await Promise.all(notifications.map((text) => captureIntentIds(page, text)))).flat();
			for (const id of notificationIntentIds) await expectOneCarrier(page, id, "outbox");
			await expectOneCarrier(page, humanIntentId, "outbox");

			humanEcho.release();
			await notificationEchoes[0].entered;
			await expectTranscriptText(page, humanIntentId, prompt);
			await expectOneCarrier(page, humanIntentId, "transcript");
			await expectCanonicalHumanReplyTail(page, prompt);
			for (const text of notifications) {
				await expect(page.locator("user-message").filter({ hasText: text })).toHaveCount(0);
			}

			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(editor(page)).toBeVisible({ timeout: 20_000 });
			await expectOneCarrier(page, humanIntentId, "transcript");
			for (const id of notificationIntentIds) await expectOneCarrier(page, id, "outbox");
			await expectCanonicalHumanReplyTail(page, prompt);
			for (const text of notifications) {
				await expect(page.locator("user-message").filter({ hasText: text })).toHaveCount(0);
			}
		} finally {
			await scenario.cleanup();
		}
	});

	test("pre-admission rejection survives reload and exposes local Retry and Dismiss", async ({ page, gateway }) => {
		const scenario = await createScenario(page, gateway);
		const session = gateway.sessionManager.getSession(scenario.sessionId) as any;
		try {
			const text = "RAT_PRE_ADMISSION_REJECTION";
			session.condition = {
				code: "MODEL_SELECTION_REQUIRED",
				provider: "retired-provider",
				modelId: "retired-model",
			};
			await submit(page, text);
			const [id] = await captureIntentIds(page, text);
			await expectIntentState(page, id, "failed", /Not delivered/);
			const failed = intentRow(page, id);
			await expect(failed.getByRole("button", { name: "Retry" })).toBeVisible();
			await expect(failed.getByRole("button", { name: "Dismiss" })).toBeVisible();

			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(editor(page)).toBeVisible({ timeout: 20_000 });
			await expectIntentState(page, id, "failed", /Not delivered/);

			delete session.condition;
			const echo = scenario.runtime.holdEcho(text);
			await intentRow(page, id).getByRole("button", { name: "Retry" }).click();
			await echo.entered;
			echo.release();
			await expectOneCarrier(page, id, "transcript");
			await expectTranscriptText(page, id, text);
		} finally {
			delete session?.condition;
			await scenario.cleanup();
		}
	});

	test("definite delivery failure retains an actionable row and Retry reuses the occurrence id", async ({ page, gateway }) => {
		const scenario = await createScenario(page, gateway);
		try {
			const tool = scenario.runtime.holdNextTool();
			await submit(page, BUSY);
			await tool.entered;

			const text = "RAT_ACTIONABLE_FAILURE";
			scenario.runtime.failSteer(text);
			await submit(page, text, "steer");
			const [id] = await captureIntentIds(page, text);
			await expectIntentState(page, id, "failed", /Not delivered/);
			await expectOneCarrier(page, id, "outbox");
			const failed = intentRow(page, id);
			await expect(failed.getByRole("button", { name: "Retry" })).toBeVisible();
			await expect(failed.getByRole("button", { name: "Edit" })).toBeVisible();
			await expect(failed.getByRole("button", { name: "Dismiss" })).toBeVisible();

			const retryEcho = scenario.runtime.holdEcho(text, "retry-echo");
			await failed.getByRole("button", { name: "Retry" }).click();
			await expect(intentRows(page, text)).toHaveCount(1);
			await expect(intentRow(page, id)).toBeVisible();
			await expectOneCarrier(page, id, "outbox");
			await retryEcho.entered;
			retryEcho.release();
			await expectOneCarrier(page, id, "transcript");
			await expectTranscriptText(page, id, text);
			tool.release();
		} finally {
			await scenario.cleanup();
		}
	});
});
