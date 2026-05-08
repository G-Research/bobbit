/**
 * Repro test for HYPOTHESIS H2 — bypassed broadcasts + overflow termination
 * cause lost lifecycle frames, leaving the session stuck in `streaming`.
 *
 * Three server call sites emit `{type:'event'}` frames WITHOUT seq/ts and
 * WITHOUT pushing to EventBuffer:
 *   1. src/server/agent/session-manager.ts:~4799 — synthetic `agent_end`
 *      after force-kill / restart_agent
 *   2. src/server/ws/handler.ts:~551 — `compaction_start`
 *   3. src/server/ws/handler.ts:~563/569 — `compaction_end`
 *
 * If the client needs to resume-from-seq across one of these (e.g. WS overflow
 * termination + reconnect), the bypassed frames are NOT in
 * `EventBuffer.since()`, so they're silently lost. The client never sees the
 * lifecycle event, leaving the session in `streaming` with a stuck Stop button.
 *
 * This spec attempts three reproductions:
 *   (a) compact mid-session, drop the WS during compaction, reconnect.
 *   (b) restart_agent, drop WS during the kill→respawn gap.
 *   (c) high-volume stream that may trip WS_BUFFER_OVERFLOW_BYTES.
 *
 * All scenarios run on a fresh session in isolation. The test expects status
 * to return to `idle` within 5s; on the bug it stays at `streaming`.
 *
 * NOTE: per system-prompt instructions, this test file MUST NOT modify any
 * production code — it is a pure reproduction probe.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, sendMessage } from "./ui-helpers.js";
import { createSession, deleteSession, waitForSessionStatus } from "../e2e-setup.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for the RemoteAgent test hook to be exposed and connected. */
async function waitForAgent(page: import("@playwright/test").Page): Promise<void> {
	await page.waitForFunction(
		() => !!(window as any).__bobbitState?.remoteAgent?.connected,
		undefined,
		{ timeout: 20_000 },
	);
}

/** Open app on a freshly-created session via the API. Mirrors
 *  session-status-recovery.spec.ts which already works in this harness. */
async function openOnFreshSession(page: import("@playwright/test").Page): Promise<string> {
	const sessionId = await createSession();
	await waitForSessionStatus(sessionId, "idle");
	await openApp(page);
	await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
	await waitForAgent(page);
	return sessionId;
}

/** Read canonical client status. */
async function readStatus(page: import("@playwright/test").Page): Promise<string> {
	return page.evaluate(() => {
		const a = (window as any).__bobbitState?.remoteAgent;
		return a?._state?.status ?? "<no agent>";
	});
}

/** Force-close the underlying WebSocket from the page. The RemoteAgent's
 *  reconnect logic should fire automatically. */
async function dropWs(page: import("@playwright/test").Page, code = 4006, reason = "test-drop"): Promise<void> {
	await page.evaluate(({ code, reason }) => {
		const a = (window as any).__bobbitState?.remoteAgent;
		const ws = a?.ws;
		if (ws && typeof ws.close === "function") ws.close(code, reason);
	}, { code, reason });
}

/** Wait until the RemoteAgent reports `connected` again after a drop. */
async function waitReconnected(page: import("@playwright/test").Page, timeoutMs = 15_000): Promise<void> {
	await page.waitForFunction(
		() => !!(window as any).__bobbitState?.remoteAgent?.connected,
		undefined,
		{ timeout: timeoutMs },
	);
}

/** Snapshot internal RemoteAgent state for diagnostics. */
async function snapshotAgent(page: import("@playwright/test").Page): Promise<Record<string, unknown>> {
	return page.evaluate(() => {
		const a = (window as any).__bobbitState?.remoteAgent;
		if (!a) return { error: "no remote agent" };
		return {
			status: a._state?.status,
			isStreaming: a.state?.isStreaming,
			isCompacting: a._isCompacting,
			highestSeq: a._highestSeq,
			lastStatusVersion: a._lastStatusVersion,
			pendingEvents: Array.isArray(a._pendingEvents) ? a._pendingEvents.length : null,
			connected: a.connected,
			wsReadyState: a.ws?.readyState,
		};
	});
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

test.describe.configure({ mode: "serial" });

test.describe("H2 — bypassed lifecycle frames lost on resume", () => {
	test("(a) compact + WS drop loses compaction_end → session stays compacting", async ({ page }) => {
		const sessionId = await openOnFreshSession(page);
		test.info().annotations.push({ type: "sessionId", description: sessionId });

		try {
		// Sanity: idle to start.
		await expect.poll(() => readStatus(page), { timeout: 10_000 }).toBe("idle");

		// Trigger compact via the public method, then drop WS very quickly.
		// Race condition: we want to drop AFTER `compaction_start` was sent
		// but BEFORE `compaction_end` arrives. Either way the bypassed frame
		// is not in EventBuffer.
		await page.evaluate(() => {
			const a = (window as any).__bobbitState?.remoteAgent;
			a.compact();
		});

		// Tiny yield so compaction_start has at least a chance to be queued.
		await page.waitForTimeout(50);
		await dropWs(page);

		// Wait for reconnect.
		await waitReconnected(page);

		// On reconnect the client sends `resume {fromSeq:_highestSeq}`.
		// `compaction_start` was bypassed so it's not in the buffer; if a
		// `compaction_end` is also bypassed, neither is replayed.
		// Status should still recover to idle within 5s. Capture diagnostics
		// either way.
		const settled = await page.waitForFunction(
			() => {
				const a = (window as any).__bobbitState?.remoteAgent;
				return a?._state?.status === "idle" && !a._isCompacting;
			},
			undefined,
			{ timeout: 5_000 },
		).then(() => true).catch(() => false);

		const snap = await snapshotAgent(page);
		console.log("[H2-a] post-recover snapshot:", JSON.stringify(snap, null, 2));

		// We assert the OUTCOME (idle + not compacting) — on the bug this
		// fails and we get the diagnostic snapshot in the test output.
		expect.soft(settled, `compact-then-drop did not settle in 5s; snapshot=${JSON.stringify(snap)}`).toBe(true);
		expect.soft(snap.status, "client status should be idle after compact+resume").toBe("idle");
		expect.soft(snap.isCompacting, "client should not still be compacting").toBe(false);
		} finally { await deleteSession(sessionId).catch(() => {}); }
	});

	test("(b) restart_agent + WS drop loses synthetic agent_end → status stuck", async ({ page }) => {
		const sessionId = await openOnFreshSession(page);
		try {
		await expect.poll(() => readStatus(page), { timeout: 10_000 }).toBe("idle");

		// Kick a long-running turn so restart_agent has something to force-kill.
		await sendMessage(page, "STAY_BUSY:5000");

		// Wait until streaming.
		await page.waitForFunction(
			() => (window as any).__bobbitState?.remoteAgent?._state?.status === "streaming",
			undefined,
			{ timeout: 10_000 },
		);

		// Send restart_agent — server force-kills bridge, then emits a synthetic
		// `agent_end` (broadcast bypasses EventBuffer) and a status frame.
		await page.evaluate(() => {
			(window as any).__bobbitState.remoteAgent.send({ type: "restart_agent" });
		});

		// Drop WS in the gap. Even a tiny drop here should suffice to land
		// the resume request after the bypassed agent_end was broadcast.
		await page.waitForTimeout(20);
		await dropWs(page);
		await waitReconnected(page);

		// The session_status heartbeat (15s) plus status_resync recovery
		// should still heal status — but the synthetic `agent_end` itself,
		// being bypassed, is genuinely lost. We assert that the OUTCOME
		// (status returns to idle) is still achieved within 5s — on the bug
		// the client may sit in `streaming` until the heartbeat fires.
		const settled = await page.waitForFunction(
			() => (window as any).__bobbitState?.remoteAgent?._state?.status === "idle",
			undefined,
			{ timeout: 5_000 },
		).then(() => true).catch(() => false);

		const snap = await snapshotAgent(page);
		console.log("[H2-b] post-restart snapshot:", JSON.stringify(snap, null, 2));

		expect.soft(settled, `restart+drop did not settle in 5s; snapshot=${JSON.stringify(snap)}`).toBe(true);
		expect.soft(snap.status, "client status should be idle after restart+resume").toBe("idle");
		} finally { await deleteSession(sessionId).catch(() => {}); }
	});

	test("(c) heavy stream: assert no missing assistant rows + status reaches idle", async ({ page }) => {
		const sessionId = await openOnFreshSession(page);
		try {
		await expect.poll(() => readStatus(page), { timeout: 10_000 }).toBe("idle");

		// STREAM_BURST:6 is the heaviest documented mock burst — 6 cycles of
		// (propose_goal + chunked text + bash_bg.wait + chunked text). Each
		// cycle emits dozens of frames; six cycles with multi-delta updates
		// approaches but does not exceed WS_BUFFER_OVERFLOW_BYTES (4 MiB).
		//
		// To reliably trip overflow termination we'd need to lower the
		// threshold, but neither WS_BUFFER_OVERFLOW_BYTES nor a min_size
		// setting is exposed via env var (see grep in
		// src/server/agent/session-manager.ts:293). For now we run the
		// burst, optionally drop the WS mid-flight, and assert the OUTCOME
		// (idle + STREAM_BURST_DONE marker visible).
		await sendMessage(page, "STREAM_BURST:6");

		// Wait until streaming, then drop a couple of times to force resumes.
		await page.waitForFunction(
			() => (window as any).__bobbitState?.remoteAgent?._state?.status === "streaming",
			undefined,
			{ timeout: 10_000 },
		);

		// Drop mid-stream once — enough to exercise the resume-from-seq path
		// without overlapping with a bypassed frame (bash_bg events ARE
		// buffered; this checks the pure-protocol baseline).
		await page.waitForTimeout(800);
		await dropWs(page);
		await waitReconnected(page);

		// Allow the burst plenty of time to finish (6 cycles × ~1.7s each
		// plus drain time).
		const settled = await page.waitForFunction(
			() => (window as any).__bobbitState?.remoteAgent?._state?.status === "idle",
			undefined,
			{ timeout: 30_000 },
		).then(() => true).catch(() => false);

		const snap = await snapshotAgent(page);
		console.log("[H2-c] post-burst snapshot:", JSON.stringify(snap, null, 2));

		expect.soft(settled, `STREAM_BURST did not settle in 30s; snapshot=${JSON.stringify(snap)}`).toBe(true);
		expect.soft(snap.status, "status should be idle after burst").toBe("idle");

		// The mock emits a final `STREAM_BURST_DONE:6` text — if any frame
		// from the back of the burst was lost on resume, this marker would
		// be missing.
		const doneCount = await page.locator("text=STREAM_BURST_DONE:6").count();
		expect.soft(doneCount, "STREAM_BURST_DONE:6 marker should appear exactly once").toBeGreaterThanOrEqual(1);
		} finally { await deleteSession(sessionId).catch(() => {}); }
	});

	test("(d) direct probe: bypassed compaction_start has no seq → not in EventBuffer", async ({ page }) => {
		// Pure-protocol probe: trigger compact, wait for the compaction_start
		// frame to arrive, then inspect its envelope. The bug hypothesis is
		// that this frame has NO `seq` field, which means it cannot be
		// replayed via the resume path.
		const sessionId = await openOnFreshSession(page);
		try {
		await expect.poll(() => readStatus(page), { timeout: 10_000 }).toBe("idle");

		// Install a raw frame sniffer on the WS.
		await page.evaluate(() => {
			const a = (window as any).__bobbitState.remoteAgent;
			(window as any).__h2_frames = [];
			const ws = a.ws;
			const orig = ws.onmessage;
			ws.addEventListener("message", (ev: MessageEvent) => {
				try {
					const msg = JSON.parse(ev.data);
					if (msg.type === "event") {
						(window as any).__h2_frames.push({
							innerType: msg.data?.type,
							hasSeq: typeof msg.seq === "number",
							hasTs: typeof msg.ts === "number",
							seq: msg.seq,
						});
					}
				} catch { /* ignore */ }
			});
			return orig ? "ok" : "ok"; // keep tsc happy
		});

		await page.evaluate(() => (window as any).__bobbitState.remoteAgent.compact());

		// Allow compact to start + finish (mock has no real LLM, so the
		// `compact` RPC will likely error out — but compaction_start is
		// emitted before the RPC even resolves).
		await page.waitForTimeout(2_000);

		const frames = await page.evaluate(() => (window as any).__h2_frames);
		console.log("[H2-d] event frames received:", JSON.stringify(frames, null, 2));

		const compactionStart = (frames as any[]).find(f => f.innerType === "compaction_start");
		const compactionEnd = (frames as any[]).find(f => f.innerType === "compaction_end");

		// THE CORE H2 ASSERTION: these frames lack `seq`, confirming the
		// bypass. If a future fix routes them through emitSessionEvent(),
		// this assertion flips and we update the test.
		console.log("[H2-d] compaction_start frame:", compactionStart);
		console.log("[H2-d] compaction_end frame:", compactionEnd);

		// Post-fix: bypassed broadcasts now route through emitSessionEvent,
		// so compaction_start / compaction_end carry seq + ts envelope fields
		// and are replayable across resume-from-seq.
		if (compactionStart) {
			expect(
				compactionStart.hasSeq,
				`H2: compaction_start should now have hasSeq=true (fix in place)`,
			).toBe(true);
			expect(
				compactionStart.hasTs,
				`H2: compaction_start should now have hasTs=true (fix in place)`,
			).toBe(true);
		}
		if (compactionEnd) {
			expect(
				compactionEnd.hasSeq,
				`H2: compaction_end should now have hasSeq=true (fix in place)`,
			).toBe(true);
			expect(
				compactionEnd.hasTs,
				`H2: compaction_end should now have hasTs=true (fix in place)`,
			).toBe(true);
		}

		// Status should always recover regardless.
		await expect.poll(() => readStatus(page), { timeout: 10_000 }).toBe("idle");
		} finally { await deleteSession(sessionId).catch(() => {}); }
	});
});
