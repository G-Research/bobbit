/**
 * Reproducing test for: "Stream-watchdog silent retry produces visible
 * duplicate user-message rows AND visible 'Request aborted' rows in the
 * chat transcript when the LLM stream stalls."
 *
 * See goal `goal-watchdog-s-0fc3772a` and the issue-analysis gate.
 *
 * What this test models
 * ---------------------
 * The bug lives at the broadcast boundary, not inside the watchdog itself.
 * Today, `SessionManager.handleAgentLifecycle` consults
 * `shouldSkipErrorMessageEnd(session)` for assistant error frames, but the
 * subsequent `emitSessionEvent(session, truncated)` call (session-manager.ts
 * ~line 2937) ALWAYS runs — so the suppression flag only affects internal
 * bookkeeping (`lastTurnErrored` / `consecutiveErrorTurns`) and does not
 * prevent the WS broadcast. Likewise the user-echo for the watchdog's
 * silently re-issued prompt has no suppression at all and reaches the
 * broadcast unconditionally.
 *
 * We simulate that broadcast layer with `simulateBroadcast(event)` which
 * mirrors today's behaviour (consume the bookkeeping flag for assistant
 * error frames, but always push onto `broadcasts`). After the implementer
 * fixes the watchdog (e.g. introduces `suppressNextUserEcho` and
 * `suppressNextAbortMessageEnd` consumed BEFORE `emitSessionEvent`), this
 * test will pass — but it asserts the OUTCOME (broadcast counts), not the
 * exact suppression-flag names.
 *
 * Expected behaviour (Definition of Done #1):
 *   With timeoutMs=100ms, maxRetries=2, three stalls drive three aborts.
 *   The user sent ONE prompt. Therefore:
 *     - Exactly ONE user-message frame reaches `broadcasts`.
 *     - Exactly ONE assistant `message_end` reaches `broadcasts` (the
 *       surfaced synthetic stalled-stream frame). The 2 silent-retry
 *       abort error frames are dropped pre-broadcast.
 *
 * Today (master) the test FAILS: 3 user broadcasts and 3 assistant
 * message_end broadcasts (2 abort errors + 1 synthetic).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
	onAgentEvent,
	disposeStreamWatchdog,
	shouldSkipErrorMessageEnd,
} = await import("../src/server/agent/stream-watchdog.ts");
type WatchdogConfig = import("../src/server/agent/stream-watchdog.ts").WatchdogConfig;
type WatchdogSession = import("../src/server/agent/stream-watchdog.ts").WatchdogSession;

interface FakeRpc {
	abort: () => Promise<any>;
	prompt: (text: string, images?: any) => Promise<any>;
	abortCalls: number;
	promptCalls: Array<{ text: string; images?: any }>;
	process: { pid: number };
}

function makeRpc(): FakeRpc {
	const c: FakeRpc = {
		abortCalls: 0,
		promptCalls: [],
		process: { pid: 12345 },
		async abort() { c.abortCalls++; return { success: true }; },
		async prompt(text: string, images?: any) {
			c.promptCalls.push({ text, images });
			return { success: true };
		},
	};
	return c;
}

function makeSession(id: string, rpc: FakeRpc): WatchdogSession {
	return {
		id,
		rpcClient: rpc,
		lastPromptText: "hello world",
		lastPromptImages: undefined,
	};
}

const FAST_CFG: WatchdogConfig = { timeoutMs: 100, maxRetries: 2 };
const isAlive = () => true;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitForAbort(rpc: FakeRpc, target: number, timeoutMs = 1500) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (rpc.abortCalls >= target) {
			await sleep(15); // let the setTimeout(0) re-prompt land
			return;
		}
		await sleep(10);
	}
	throw new Error(`abort #${target} never fired (still ${rpc.abortCalls})`);
}

describe("stream-watchdog: duplicate broadcasts on silent retry (reproducer)", () => {
	it("does not broadcast silent-retry user echoes or abort error frames", async () => {
		const rpc = makeRpc();
		const session = makeSession("dupbcast-1", rpc);

		// Model the SessionManager broadcast layer. `simulateBroadcast` mirrors
		// today's `handleAgentLifecycle` + `emitSessionEvent` behaviour: for
		// assistant error message_end frames we consume the suppression flag
		// (so bookkeeping is skipped) but we ALWAYS push onto `broadcasts`,
		// because today's code calls `emitSessionEvent` unconditionally.
		const broadcasts: any[] = [];
		const simulateBroadcast = (event: any) => {
			if (
				event?.type === "message_end" &&
				event?.message?.role === "assistant" &&
				(event.message.stopReason === "error" || event.message.stopReason === "aborted")
			) {
				// Today's session-manager.ts:1862-1873 consumes the flag for
				// bookkeeping only. The frame still flows to clients.
				shouldSkipErrorMessageEnd(session);
			}
			// Today: emitSessionEvent runs unconditionally for every event.
			// After the fix, the implementer will gate this push on a
			// `shouldBroadcast` decision derived from new suppression flags.
			broadcasts.push(event);
		};

		// The watchdog will emit the surfaced-stall synthetic message_end
		// directly through this hook (bypasses handleAgentLifecycle in prod;
		// in our model we still route it through simulateBroadcast so it
		// counts as a broadcast).
		session.emitSyntheticEvent = (ev: any) => simulateBroadcast(ev);

		// Original user prompt: the agent's first echo of the user's message.
		simulateBroadcast({
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: "hello world" }] },
		});

		// agent_start arms the watchdog.
		onAgentEvent(session, { type: "agent_start" }, FAST_CFG, isAlive);

		// ------- Stall #1 (silent retry) -------
		await waitForAbort(rpc, 1);
		// Production-shape frames after the abort:
		//   (a) abort emits assistant error message_end ("Request aborted")
		simulateBroadcast({
			type: "message_end",
			message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Request aborted" },
		});
		//   (b) re-prompt emits user echo for the re-issued prompt
		simulateBroadcast({
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: "hello world" }] },
		});
		// Drive the agent_end → next agent_start cycle as the production
		// flow does (mirrors the existing watchdog test harness).
		onAgentEvent(session, { type: "agent_end" }, FAST_CFG, isAlive);
		session.suppressNextDrainForStallRetry = false;
		session.suppressNextErrorMessageEnd = false;
		onAgentEvent(session, { type: "agent_start" }, FAST_CFG, isAlive);

		// ------- Stall #2 (silent retry) -------
		await waitForAbort(rpc, 2);
		simulateBroadcast({
			type: "message_end",
			message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Request aborted" },
		});
		simulateBroadcast({
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: "hello world" }] },
		});
		onAgentEvent(session, { type: "agent_end" }, FAST_CFG, isAlive);
		session.suppressNextDrainForStallRetry = false;
		session.suppressNextErrorMessageEnd = false;
		onAgentEvent(session, { type: "agent_start" }, FAST_CFG, isAlive);

		// ------- Stall #3 (surfaced) -------
		await waitForAbort(rpc, 3);
		// The surfaced-stall path emits the synthetic stalled-stream
		// message_end via emitSyntheticEvent (already wired into
		// simulateBroadcast above). The abort that follows still emits the
		// production "Request aborted" frame:
		simulateBroadcast({
			type: "message_end",
			message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Request aborted" },
		});
		// (No re-prompt on the surfaced path — no user echo.)

		disposeStreamWatchdog(session);

		// ----- Assertions: broadcast counts -----
		const userBroadcasts = broadcasts.filter(
			(e: any) => e?.type === "message_end" && e?.message?.role === "user",
		);
		const assistantMessageEnds = broadcasts.filter(
			(e: any) => e?.type === "message_end" && e?.message?.role === "assistant",
		);

		assert.equal(
			userBroadcasts.length,
			1,
			`User-message broadcasts: expected 1 (the original prompt), ` +
			`got ${userBroadcasts.length}. Each silent retry is leaking the ` +
			`re-issued prompt's user echo onto the wire — this is the visible ` +
			`"duplicate user message rows" half of the bug.`,
		);

		// Exactly one assistant message_end should reach broadcasts: the
		// surfaced synthetic stalled-stream frame. The 2 silent-retry abort
		// "Request aborted" frames must be suppressed pre-broadcast.
		assert.equal(
			assistantMessageEnds.length,
			1,
			`Assistant message_end broadcasts: expected 1 (the surfaced ` +
			`stalled-stream synthetic frame), got ${assistantMessageEnds.length}. ` +
			`The silent-retry abort "Request aborted" frames are leaking onto ` +
			`the wire — this is the visible "Request aborted" half of the bug.`,
		);

		// Sanity: the one assistant frame that DOES reach clients should be
		// the surfaced synthetic, not a "Request aborted".
		const surfaced = assistantMessageEnds[0];
		assert.match(
			surfaced?.message?.errorMessage ?? "",
			/stream stalled/i,
			"the single assistant message_end broadcast must be the surfaced " +
			"stalled-stream synthetic, not a 'Request aborted' frame",
		);
	});
});
