/**
 * Browser E2E — transcript fidelity: live DOM must match server snapshot.
 *
 * The post-refresh DOM is hydrated from the server's persisted message
 * snapshot — it is the ground truth of "what really happened in this
 * session". The live DOM is the result of streaming reducer state.
 *
 * Invariant: after a multi-cycle mock-agent burst, those two views must
 * agree exactly — same number of messages, same fingerprints, same order,
 * no live-only duplicates.
 *
 * This is the assertion pattern the prototype used to find the bugs PRs
 * #436 and #437 fixed (in-flight assistant `message_end` without a string
 * id duplicating into MessageList + StreamingMessageContainer; un-id'd
 * `message_end` toolResult rows surviving snapshot reconciliation). It
 * doesn't currently exist on master as a generic invariant test.
 *
 * The mock trigger `STREAM_BURST:3` (see tests/e2e/mock-agent-core.mjs)
 * runs three cycles of [propose_goal + chunked-text + bash_bg.wait +
 * chunked-text]. This stresses the unified message-ordering reducer in
 * `src/app/message-reducer.ts` — different message kinds (assistant
 * text, toolCall, toolResult) interleaved with chunked deltas and
 * deferred-then-completed tool flows.
 *
 * Failure modes this catches:
 *   - Live duplicate of a streaming-message card (#436).
 *   - Snapshot replay over a live un-id'd row (#437).
 *   - Reducer ordering regressions where live DOM order ≠ snapshot order.
 *   - Stale messages trailing after newer ones on session navigate.
 *
 * Production-bug policy: if this test fails on master and the failure
 * traces to a real bug, fix the production code in the same PR — no mock
 * workaround.
 */
import { test, expect } from "./fixtures.js";
import {
	createSession,
	waitForHealth,
	waitForSessionStatus,
} from "../e2e-setup.js";
import { openApp, sendMessage } from "./ui-helpers.js";

interface MessageFingerprint {
	role: string;
	fp: string;
}

/**
 * Walk the rendered transcript in DOM order and produce a stable
 * fingerprint for every message card. Strips dynamic time-elapsed text
 * (the `\d+s` counters that bg-process renderers emit while a wait is
 * parked) so snapshots taken at different wall-clock moments compare
 * equal.
 */
async function snapshotMessages(page: import("@playwright/test").Page): Promise<MessageFingerprint[]> {
	return await page.evaluate(() => {
		const sel = "user-message, assistant-message, tool-message";
		const nodes = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
		const stripDynamic = (text: string): string => text
			// "12s elapsed" / "3s" — bg-process timer
			.replace(/\b\d+s\b/g, "Xs")
			// trim runs of whitespace
			.replace(/\s+/g, " ")
			.trim();
		return nodes.map((el) => {
			const role = el.tagName.toLowerCase();
			const raw = (el.textContent || "");
			const norm = stripDynamic(raw);
			return { role, fp: `${role}|${norm}|${norm.length}` };
		});
	});
}

/**
 * Wait until the agent has finished the current turn AND the page has
 * rendered the burst's terminal sentinel (`STREAM_BURST_DONE:<n>` /
 * `MIXED_BURST_DONE:<n>`). Idle alone isn't enough — the final
 * `message_end` may still be in-flight to the client when the server
 * marks the session idle.
 */
async function waitForBurstComplete(
	page: import("@playwright/test").Page,
	sessionId: string,
	doneToken: string,
	timeoutMs = 60_000,
): Promise<void> {
	await waitForSessionStatus(sessionId, "idle");
	await expect(page.getByText(doneToken).first()).toBeVisible({ timeout: timeoutMs });
}

test.describe("Transcript fidelity: live DOM must match server snapshot after multi-cycle bursts", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test("STREAM_BURST:3 — live DOM equals post-refresh DOM", async ({ page, rec }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await rec.capture("App loaded, empty session");

		// Drive 3 cycles of [propose_goal + pre-wait chunked text +
		// bash_bg.wait(~1.5s) + post-wait chunked text].
		await sendMessage(page, "STREAM_BURST:3");
		await rec.capture("STREAM_BURST:3 dispatched");

		await waitForBurstComplete(page, sessionId, "STREAM_BURST_DONE:3");
		await rec.capture("Burst complete, session idle");

		// Snapshot the live DOM transcript — what the user is currently
		// looking at, built up by the streaming reducer.
		const liveSnap = await snapshotMessages(page);
		await rec.capture(`Live snapshot: ${liveSnap.length} messages`);
		expect(liveSnap.length, "live snapshot must have ≥1 message").toBeGreaterThan(0);

		// Hard reload — post-refresh DOM is the server snapshot, ground
		// truth. The agent-interface mounts fresh, hydrates from the
		// server's persisted message list, and renders without ever
		// processing a live event.
		await page.reload();
		await expect(page.locator("agent-interface").first()).toBeVisible({ timeout: 15_000 });
		// The textarea reappears once the chat area is fully hydrated.
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		// Wait for the same terminal sentinel to be present in the
		// reloaded DOM — otherwise we'd race a partial hydration.
		await expect(page.getByText("STREAM_BURST_DONE:3").first()).toBeVisible({ timeout: 15_000 });
		await rec.capture("Page reloaded, snapshot hydrated");

		const refreshSnap = await snapshotMessages(page);
		await rec.capture(`Refresh snapshot: ${refreshSnap.length} messages`);

		// Assertion 1: counts match. A live-only duplicate (the bug shape
		// from PR #436 / #437) lights this up immediately.
		if (liveSnap.length !== refreshSnap.length) {
			const dump = (label: string, snap: MessageFingerprint[]): string =>
				`${label} (${snap.length}):\n` + snap.map((m, i) => `  [${i}] ${m.fp.slice(0, 120)}`).join("\n");
			throw new Error(
				`Transcript fidelity broken: live count ≠ post-refresh count.\n`
				+ `${dump("LIVE", liveSnap)}\n${dump("REFRESH", refreshSnap)}`,
			);
		}
		expect(liveSnap.length, "live count must equal post-refresh count").toBe(refreshSnap.length);

		// Assertion 2: no fingerprint duplicated in the live DOM. This is
		// the actual bug shape — two cards with the same content sharing
		// nothing structural except their text. The post-refresh DOM also
		// must not duplicate (it's the server snapshot, so duplicates
		// would mean the server itself persisted a dup).
		const countOccurrences = (snap: MessageFingerprint[]): Map<string, number> => {
			const counts = new Map<string, number>();
			for (const m of snap) counts.set(m.fp, (counts.get(m.fp) || 0) + 1);
			return counts;
		};
		const liveCounts = countOccurrences(liveSnap);
		const refreshCounts = countOccurrences(refreshSnap);
		// Note: this fingerprint is intentionally coarse (role|text|len) so
		// two genuinely identical assistant text turns would also collide.
		// In a STREAM_BURST run, every cycle's text/proposal is uniquely
		// numbered, so any collision is a duplicate-render bug, not a
		// content collision.
		for (const [fp, n] of liveCounts) {
			if (n > 1) {
				throw new Error(`Live duplicate (×${n}): ${fp.slice(0, 200)}`);
			}
		}
		for (const [fp, n] of refreshCounts) {
			if (n > 1) {
				throw new Error(`Refresh duplicate (×${n}): ${fp.slice(0, 200)}`);
			}
		}

		// Assertion 3: order matches. Zip and compare per-index. The
		// reducer's `(_order, _insertionTick)` sort key must produce the
		// same DOM order from live events as from snapshot replay.
		for (let i = 0; i < liveSnap.length; i++) {
			if (liveSnap[i].fp !== refreshSnap[i].fp) {
				throw new Error(
					`Transcript order mismatch at index ${i}.\n`
					+ `  live:    ${liveSnap[i].fp.slice(0, 200)}\n`
					+ `  refresh: ${refreshSnap[i].fp.slice(0, 200)}`,
				);
			}
		}
		await rec.capture("All fidelity invariants passed");
	});
});
