import type { Page } from "@playwright/test";
import { expect, test } from "../../support/helpers/browser/journeys/journey-fixture.js";
import {
	captureIntentIds,
	closeActiveSessionSocket,
	editor,
	expectIntentState,
	expectOneCarrier,
	intentRow,
	intentRows,
	openSecondSessionTab,
	submit,
	transcriptIntent,
	waitForRemoteStatus,
} from "../../support/helpers/browser/journeys/reliable-agent-turns.fixture.js";
import {
	RELIABLE_TURN_BUSY,
	createReliableTurnScenario,
	expectCanonicalHumanReplyTail,
	expectReliableTurnTranscriptText,
} from "../../support/helpers/browser/journeys/reliable-agent-turns-journey.js";

test.describe("Journey: Reliable Agent Turns — recovery", () => {
	test.setTimeout(120_000);
	test("Stop during a long tool and immediately after a steer resolves ambiguity without loss or replay", async ({ page, gateway }) => {
		const scenario = await createReliableTurnScenario(page, gateway);
		try {
			const tool = scenario.runtime.holdNextTool();
			await submit(page, RELIABLE_TURN_BUSY);
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
			abort.release();
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
		const scenario = await createReliableTurnScenario(page, gateway);
		try {
			const terminalIdle = scenario.runtime.holdNextPromptTerminalIdle();
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
			await terminalIdle.entered;
			const terminalRevision = await scenario.runtime.joinCompactionTerminalProjection();
			terminalIdle.release();
			await steerStart.entered;
			await waitForRemoteStatus(page, terminalRevision);
			const activeRunRevision = scenario.runtime.surfaceActiveRun();
			await waitForRemoteStatus(page, activeRunRevision);
			const abort = scenario.runtime.holdNextAbort();
			const stop = page.getByRole("button", { name: "Stop current turn" });
			await test.step("Stop control reaches its one owned abort occurrence", async () => {
				await expect(stop).toBeVisible({ timeout: 15_000 });
				await stop.click();
				await abort.received;
				await abort.beforeAgentEnd.entered;
			});
			// Capture every terminal authority while the held steer still owns its
			// active-turn tail; later transcript rendering may let that turn settle.
			const terminalProjection = scenario.runtime.joinAbortTerminalProjection(abort);
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

			await test.step("Stop terminal lifecycle and replacement coordinator settle", async () => {
				abort.beforeAgentEnd.release();
				await abort.afterTerminalIdle.entered;
				abort.afterTerminalIdle.release();
				const terminalRevision = await terminalProjection;
				await waitForRemoteStatus(page, terminalRevision);
			});
			expect(scenario.runtime.barrierJournal.map((entry) => entry.name)).toEqual(expect.arrayContaining([
				abort.afterTerminalIdle.boundary,
			]));
			await expect(transcriptIntent(page, id)).toHaveCount(1);
		} finally {
			await scenario.cleanup();
		}
	});

	test("offline admission, reconnect, reload, and a second tab preserve the same intent id until correlated surfacing", async ({ page, context, gateway }) => {
		const scenario = await createReliableTurnScenario(page, gateway);
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
		const scenario = await createReliableTurnScenario(page, gateway);
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
			await expectReliableTurnTranscriptText(page, humanIntentId, prompt);
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
		const scenario = await createReliableTurnScenario(page, gateway);
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
			await expectReliableTurnTranscriptText(page, id, text);
		} finally {
			delete session?.condition;
			await scenario.cleanup();
		}
	});

	test("definite delivery failure retains an actionable row and Retry reuses the occurrence id", async ({ page, gateway }) => {
		const scenario = await createReliableTurnScenario(page, gateway);
		try {
			const tool = scenario.runtime.holdNextTool();
			await submit(page, RELIABLE_TURN_BUSY);
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
			await expectReliableTurnTranscriptText(page, id, text);
			tool.release();
		} finally {
			await scenario.cleanup();
		}
	});
});
