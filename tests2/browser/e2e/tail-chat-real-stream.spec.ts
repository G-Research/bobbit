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
	snapshotMessages,
	assertTranscriptSnapshotsEqual,
	awaitTailGrowthPhase,
	startTailPhaseTracker,
	stopTailPhaseTracker,
	startTailSampler,
	stopTailSampler,
	waitForBurstDone,
} from "./tail-chat-helpers.js";

test.describe("tail-chat: full-stack streaming and transcript fidelity", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test.setTimeout(75_000);

	test("STREAM_BURST:2 stays pinned and live DOM equals post-refresh DOM", async ({ page, rec }) => {
		test.slow(); // streaming + scroll assertions need 3× timeout under concurrent v2-browser load
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openTailSession(page, sessionId);
		await disableScrollAnchoring(page);

		const pre = await installPreStreamSpacer(page);
		await rec.capture(`Pre-stream spacer installed (overflow=${pre.overflow})`);

		// Each marker is emitted only after its 30th real stream chunk. Register
		// their observer before dispatch: markers are transient and a sequential
		// locator wait can begin after an early marker has already been replaced.
		const phaseMarkers = [
			"PRE-WAIT-CHUNK-1#30",
			"POST-WAIT-CHUNK-1#30",
			"PRE-WAIT-CHUNK-2#30",
			"POST-WAIT-CHUNK-2#30",
		];
		const phaseTracker = "__tailRealPhases";
		await startTailPhaseTracker(page, phaseTracker, phaseMarkers);
		await startTailSampler(page, "__tailRealSamples");
		await sendMessage(page, "STREAM_BURST:2 please tail this chat");
		await rec.capture("STREAM_BURST:2 dispatched");

		let maxPhaseHeight = pre.scrollHeight;
		for (const marker of phaseMarkers) {
			const phase = await awaitTailGrowthPhase(page, phaseTracker, marker);
			expect(
				phase.distance,
				`${marker} settled phase must remain pinned after the re-pin frames`,
			).toBeLessThanOrEqual(TAIL_PX);
			expect(
				phase.growth,
				`${marker} must observe a distinct settled transcript-growth phase`,
			).toBeGreaterThan(0);
			// `phase` is captured after the event-driven re-pin boundary. Reading
			// live geometry again here could land in the next chunk's intentional
			// mutation-to-repin transient; the full sampler asserts every settled
			// growth state below.
			maxPhaseHeight = Math.max(maxPhaseHeight, phase.scrollHeight);
			await rec.capture(`${marker}: growth=${phase.growth} scrollHeight=${phase.scrollHeight} distance=${phase.distance}`);
		}
		await stopTailPhaseTracker(page, phaseTracker);

		await waitForBurstDone(page, 2, 45_000);
		await waitForSessionStatus(sessionId, "idle");
		// stopTailSampler disconnects observers and flushes two render frames, so
		// every opportunistically observed delta is post-ResizeObserver re-pin.
		const samples = await stopTailSampler(page, "__tailRealSamples");
		await rec.capture(`STREAM_BURST_DONE:2; settled-growth-samples=${samples.length}`);

		await expectLatestMessagePinned(page, { tailPx: TAIL_PX, label: "end-of-stream" });

		const badSamples = samples.filter((s) => s.distance > TAIL_PX);
		const summary = badSamples
			.slice(0, 8)
			.map((s) => `t=${s.t}ms growth=${s.growth}px dist=${Math.round(s.distance)}/${s.clientHeight}`)
			.join("\n  ");
		expect(
			badSamples.length,
			`tail-chat-real-stream: ${badSamples.length}/${samples.length} settled growth samples were not pinned within ${TAIL_PX}px:\n  ${summary}`,
		).toBe(0);
		expect(maxPhaseHeight, "all named stream phases must grow the transcript").toBeGreaterThan(pre.scrollHeight + 200);
		expect(samples.every((s) => s.growth > 0), "each sampler record must be a positive settled growth event").toBe(true);

		const liveSnap = await snapshotMessages(page);
		expect(liveSnap.length, "live snapshot must have ≥1 message").toBeGreaterThan(0);
		await rec.capture(`Live snapshot: ${liveSnap.length} messages`);

		await openTailSession(page, sessionId);
		await expect(page.locator("agent-interface").first()).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText("STREAM_BURST_DONE:2").first()).toBeVisible({ timeout: 15_000 });
		const refreshSnap = await snapshotMessages(page);
		assertTranscriptSnapshotsEqual(liveSnap, refreshSnap);
		await rec.capture(`Refresh snapshot matched (${refreshSnap.length} messages)`);
	});
});
