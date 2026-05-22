/**
 * Full-stack chat streaming smoke: one real STREAM_BURST covers the live
 * streaming scroll path and the live-DOM-vs-refresh transcript invariant.
 * Pure DOM reflow and jump-button contracts live in tests/ui-fixtures/chat-scroll.spec.ts.
 */
import { test, expect } from "./fixtures.js";
import { waitForHealth, waitForSessionStatus, createSession } from "../e2e-setup.js";
import { sendMessage } from "./ui-helpers.js";
import {
	TAIL_PX,
	disableScrollAnchoring,
	expectLatestMessagePinned,
	installPreStreamSpacer,
	openTailSession,
	settleFrames,
	snapshotMessages,
	assertTranscriptSnapshotsEqual,
	startTailSampler,
	stopTailSampler,
	waitForBurstDone,
} from "./tail-chat-helpers.js";

test.describe("tail-chat: full-stack streaming and transcript fidelity", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test.setTimeout(75_000);

	test("STREAM_BURST:3 stays pinned and live DOM equals post-refresh DOM", async ({ page, rec }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openTailSession(page, sessionId);
		await disableScrollAnchoring(page);

		const pre = await installPreStreamSpacer(page);
		await rec.capture(`Pre-stream spacer installed (overflow=${pre.overflow})`);

		await startTailSampler(page, "__tailRealSamples");
		await sendMessage(page, "STREAM_BURST:3 please tail this chat");
		await rec.capture("STREAM_BURST:3 dispatched");

		await waitForBurstDone(page, 3, 55_000);
		await waitForSessionStatus(sessionId, "idle");
		const samples = await stopTailSampler(page, "__tailRealSamples");
		await settleFrames(page);
		await rec.capture(`STREAM_BURST_DONE:3; samples=${samples.length}`);

		await expectLatestMessagePinned(page, { tailPx: TAIL_PX, label: "end-of-stream" });

		const badSamples = samples.filter((s) => s.distance > s.clientHeight * 0.25);
		const summary = badSamples
			.slice(0, 8)
			.map((s) => `t=${s.t}ms dist=${Math.round(s.distance)}/${s.clientHeight}`)
			.join("\n  ");
		expect(
			badSamples.length,
			`tail-chat-real-stream: ${badSamples.length}/${samples.length} samples drifted > clientHeight*0.25:\n  ${summary}`,
		).toBe(0);
		expect(samples.length, "sampler must run across the whole burst").toBeGreaterThan(10);
		expect(samples.at(-1)?.scrollHeight ?? 0, "stream must grow the transcript").toBeGreaterThan(pre.scrollHeight + 200);

		const liveSnap = await snapshotMessages(page);
		expect(liveSnap.length, "live snapshot must have ≥1 message").toBeGreaterThan(0);
		await rec.capture(`Live snapshot: ${liveSnap.length} messages`);

		await openTailSession(page, sessionId);
		await expect(page.locator("agent-interface").first()).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText("STREAM_BURST_DONE:3").first()).toBeVisible({ timeout: 15_000 });
		const refreshSnap = await snapshotMessages(page);
		assertTranscriptSnapshotsEqual(liveSnap, refreshSnap);
		await rec.capture(`Refresh snapshot matched (${refreshSnap.length} messages)`);
	});
});
