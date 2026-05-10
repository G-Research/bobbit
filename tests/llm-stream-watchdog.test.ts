/**
 * Unit test for the LLM stream-inactivity watchdog.
 *
 * Verifies the contract described in the design doc (goal-llm-stream-305c45a1):
 *   1. Aborts and silently re-prompts on stall while attempts <= maxRetries.
 *   2. Surfaces a stalled-stream error after `maxRetries + 1` attempts and
 *      bumps `consecutiveErrorTurns` by exactly 1 (silent retries do NOT).
 *   3. Does NOT fire while a tool is executing (awaitingLlmFrame=false).
 *   4. Does NOT fire on long-but-progressing streams (frames keep arriving).
 *   5. Is fully disabled when timeoutMs <= 0.
 *
 * Imports the standalone `stream-watchdog.ts` module so we don't drag in
 * the full SessionManager (flexsearch, mcp, sandbox, …) at test load.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
	onAgentEvent,
	disposeStreamWatchdog,
	shouldSuppressDrainForStallRetry,
	shouldSkipErrorMessageEnd,
	resolveWatchdogConfigFromEnv,
} = await import("../src/server/agent/stream-watchdog.ts");
type WatchdogConfig = import("../src/server/agent/stream-watchdog.ts").WatchdogConfig;
type WatchdogSession = import("../src/server/agent/stream-watchdog.ts").WatchdogSession;

interface FakeRpc {
	abort: () => Promise<any>;
	prompt: (text: string, images?: any) => Promise<any>;
	abortCalls: number;
	promptCalls: Array<{ text: string; images?: any }>;
	process: { pid: number };
	/** True while an abort handshake is mid-flight (set on abort() entry,
	 *  cleared shortly after on a later macrotask). Models the real agent's
	 *  "Agent is already processing" window where prompt() rejects if called
	 *  before the abort fully unwinds. */
	abortInFlight?: boolean;
	/** When true (default false), prompt() will reject with
	 *  `new Error("Agent is already processing.")` if called while
	 *  `abortInFlight === true`. Off by default so existing tests are
	 *  unaffected; the dispatch-failure test opts in. */
	modelAbortBusy?: boolean;
	/** How long abortInFlight stays set after abort() resolves. Short enough
	 *  to be invisible to follow-up calls in fast tests, long enough to
	 *  reliably overlap a `setTimeout(0)`-scheduled prompt. */
	abortBusyWindowMs?: number;
}

function makeRpc(): FakeRpc {
	const c: FakeRpc = {
		abortCalls: 0,
		promptCalls: [],
		process: { pid: 12345 },
		abortInFlight: false,
		async abort() {
			c.abortCalls++;
			c.abortInFlight = true;
			// Clear the in-flight window on a later macrotask. A `setTimeout(0)`
			// scheduled by the caller AFTER `await abort()` resolves will
			// generally race with this; we use a short positive delay so the
			// watchdog's race is deterministic in test (prompt sees the flag).
			const windowMs = c.abortBusyWindowMs ?? 30;
			setTimeout(() => { c.abortInFlight = false; }, windowMs);
			return { success: true };
		},
		async prompt(text: string, images?: any) {
			c.promptCalls.push({ text, images });
			if (c.modelAbortBusy && c.abortInFlight) {
				throw new Error("Agent is already processing.");
			}
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

describe("stream-watchdog: silent-retry then surface", () => {
	/**
	 * Wait for the next stall + re-prompt cycle. The watchdog's tick is
	 * `timeoutMs / 2`; a stall fires when `age >= timeoutMs`, which on a tight
	 * timer can take up to `timeoutMs + tickMs`. Then the re-prompt is
	 * scheduled via setTimeout(0). We sleep just enough for the abort to land
	 * and the re-prompt to be issued, but NOT long enough for a second tick
	 * after the re-prompt (which would re-stall).
	 */
	async function waitForStall(rpc: FakeRpc, beforeAborts: number) {
		const deadline = Date.now() + 1000;
		while (Date.now() < deadline) {
			if (rpc.abortCalls > beforeAborts) {
				// Abort fired — wait one microtask + setTimeout(0) for the re-prompt.
				await sleep(15);
				return;
			}
			await sleep(10);
		}
		throw new Error(`abort never fired (was ${beforeAborts}, still ${rpc.abortCalls})`);
	}

	it("aborts and re-prompts on stall up to maxRetries, then surfaces", async () => {
		const rpc = makeRpc();
		const session = makeSession("w1", rpc);

		// agent_start arms the watchdog.
		onAgentEvent(session, { type: "agent_start" }, FAST_CFG, isAlive);
		assert.equal(session.awaitingLlmFrame, true);
		assert.ok(session.streamWatchdogTimer, "timer must be created on agent_start");

		// First stall (attempt 1) → silent retry.
		await waitForStall(rpc, 0);
		assert.equal(rpc.abortCalls, 1, "abort fired on first stall");
		assert.equal(rpc.promptCalls.length, 1, "first re-prompt issued");
		assert.equal(rpc.promptCalls[0].text, "hello world");
		assert.equal(session.streamStallRetries, 1);
		assert.equal(session.lastTurnErrored, undefined, "silent retry must not set lastTurnErrored");
		assert.equal(session.consecutiveErrorTurns ?? 0, 0, "silent retry must NOT bump consecutiveErrorTurns");
		assert.equal(session.suppressNextDrainForStallRetry, true);

		// Simulate the agent_end the abort emits. The watchdog must preserve
		// streamStallRetries while the suppression flag is set. The manager
		// then consumes the flag exactly once — mirror that here. The fresh
		// agent_start arrives once the re-prompt's agent run begins; mirror
		// that too so the watchdog re-arms (production flow: abort → agent_end
		// → the setTimeout(0) re-prompt → fresh agent_start).
		onAgentEvent(session, { type: "agent_end" }, FAST_CFG, isAlive);
		assert.equal(session.streamStallRetries, 1,
			"retry counter preserved across agent_end during silent-retry");
		session.suppressNextDrainForStallRetry = false;
		onAgentEvent(session, { type: "agent_start" }, FAST_CFG, isAlive);

		// Second stall (attempt 2) — silent retry.
		await waitForStall(rpc, 1);
		assert.equal(rpc.abortCalls, 2, "abort fired on second stall");
		assert.equal(rpc.promptCalls.length, 2);
		assert.equal(session.streamStallRetries, 2);
		assert.equal(session.consecutiveErrorTurns ?? 0, 0, "silent retry #2 must NOT bump consecutiveErrorTurns");
		onAgentEvent(session, { type: "agent_end" }, FAST_CFG, isAlive);
		session.suppressNextDrainForStallRetry = false;
		onAgentEvent(session, { type: "agent_start" }, FAST_CFG, isAlive);

		// Third stall (attempt 3, > maxRetries) — surface to user.
		await waitForStall(rpc, 2);
		assert.equal(rpc.abortCalls, 3, "abort fired on third stall");
		assert.equal(session.lastTurnErrored, true);
		assert.match(session.lastTurnErrorMessage ?? "", /stream stalled/i);
		assert.equal(session.consecutiveErrorTurns, 1,
			"surfaced stall bumps consecutiveErrorTurns by exactly 1 (not 3)");
		assert.equal(session.streamStallRetries, 0, "retry counter reset after surfacing");
		// No new prompt was scheduled by the surfaced path.
		assert.equal(rpc.promptCalls.length, 2, "surfaced stall does NOT re-prompt");

		disposeStreamWatchdog(session);
	});
});

describe("stream-watchdog: tool execution gate", () => {
	it("does not fire while a tool is executing", async () => {
		const rpc = makeRpc();
		const session = makeSession("w2", rpc);

		onAgentEvent(session, { type: "agent_start" }, FAST_CFG, isAlive);
		// Tool starts — disarm.
		onAgentEvent(session, { type: "tool_execution_start", toolName: "bash" }, FAST_CFG, isAlive);
		assert.equal(session.awaitingLlmFrame, false);

		// Wait > 2 * timeout — watchdog must NOT fire.
		await sleep(260);
		assert.equal(rpc.abortCalls, 0, "no abort during tool execution");
		assert.equal(session.streamStallRetries ?? 0, 0);

		// Tool ends — rearm. Frames come in normally → no stall.
		onAgentEvent(session, { type: "tool_execution_end" }, FAST_CFG, isAlive);
		assert.equal(session.awaitingLlmFrame, true);

		disposeStreamWatchdog(session);
	});
});

describe("stream-watchdog: long-but-progressing stream", () => {
	it("does not fire when message_update keeps arriving inside the timeout", async () => {
		const rpc = makeRpc();
		const session = makeSession("w3", rpc);

		onAgentEvent(session, { type: "agent_start" }, FAST_CFG, isAlive);

		const start = Date.now();
		while (Date.now() - start < 500) {
			await sleep(50);
			onAgentEvent(
				session,
				{ type: "message_update", message: { id: "m1", content: [{ type: "text", text: "x" }] } },
				FAST_CFG,
				isAlive,
			);
		}
		assert.equal(rpc.abortCalls, 0, "no abort on progressing stream");
		assert.equal(session.streamStallRetries ?? 0, 0);

		disposeStreamWatchdog(session);
	});
});

describe("stream-watchdog: disabled mode (timeoutMs <= 0)", () => {
	it("creates no timer and does not touch session state when disabled", async () => {
		const rpc = makeRpc();
		const session = makeSession("w4", rpc);
		const DISABLED: WatchdogConfig = { timeoutMs: 0, maxRetries: 2 };

		onAgentEvent(session, { type: "agent_start" }, DISABLED, isAlive);
		assert.equal(session.streamWatchdogTimer, undefined, "no timer when disabled");
		assert.equal(session.awaitingLlmFrame, undefined, "watchdog must not touch state when disabled");
		assert.equal(session.lastLlmFrameAt, undefined);

		await sleep(120);
		assert.equal(rpc.abortCalls, 0, "no abort when disabled");
	});
});

describe("stream-watchdog: env NaN guard", () => {
	it("falls back to defaults when env vars are non-numeric", () => {
		const origMs = process.env.BOBBIT_LLM_STREAM_TIMEOUT_MS;
		const origMax = process.env.BOBBIT_LLM_STREAM_MAX_RETRIES;
		try {
			process.env.BOBBIT_LLM_STREAM_TIMEOUT_MS = "not-a-number";
			process.env.BOBBIT_LLM_STREAM_MAX_RETRIES = "garbage";
			const cfg = resolveWatchdogConfigFromEnv();
			assert.equal(cfg.timeoutMs, 30_000, "NaN env falls back to 30s default");
			assert.equal(cfg.maxRetries, 2, "NaN env falls back to maxRetries=2 default");
		} finally {
			if (origMs === undefined) delete process.env.BOBBIT_LLM_STREAM_TIMEOUT_MS;
			else process.env.BOBBIT_LLM_STREAM_TIMEOUT_MS = origMs;
			if (origMax === undefined) delete process.env.BOBBIT_LLM_STREAM_MAX_RETRIES;
			else process.env.BOBBIT_LLM_STREAM_MAX_RETRIES = origMax;
		}
	});
});

describe("stream-watchdog: race vs user Stop", () => {
	it("shouldSuppressDrainForStallRetry yields to a concurrent user abort", () => {
		const rpc = makeRpc();
		const session = makeSession("race1", rpc);
		session.suppressNextDrainForStallRetry = true;

		// User pressed Stop after watchdog set the flag but before agent_end.
		// The helper must clear the flag AND return false so the standard
		// `wasAborting` path proceeds to broadcastStatus(idle).
		const suppress = shouldSuppressDrainForStallRetry(session, /*isAborting*/ true);
		assert.equal(suppress, false, "user abort wins; do not short-circuit drain");
		assert.equal(session.suppressNextDrainForStallRetry, false,
			"flag cleared so a stale flag can't strand the next agent_end");
	});

	it("shouldSuppressDrainForStallRetry short-circuits when not aborting", () => {
		const rpc = makeRpc();
		const session = makeSession("race2", rpc);
		session.suppressNextDrainForStallRetry = true;

		const suppress = shouldSuppressDrainForStallRetry(session, /*isAborting*/ false);
		assert.equal(suppress, true, "watchdog-driven retry: caller should short-circuit");
		assert.equal(session.suppressNextDrainForStallRetry, false, "flag is consumed");
	});

	it("shouldSuppressDrainForStallRetry is a no-op when flag unset", () => {
		const rpc = makeRpc();
		const session = makeSession("race3", rpc);
		assert.equal(shouldSuppressDrainForStallRetry(session, false), false);
		assert.equal(shouldSuppressDrainForStallRetry(session, true), false);
	});
});

describe("stream-watchdog: production-shape abort frames", () => {
	// In production the real agent emits `message_end{stopReason:"error",
	// errorMessage:"Request aborted"}` on every abort, INCLUDING the silent-
	// retry aborts. The standard SessionManager handler would bump
	// consecutiveErrorTurns on each, violating the design invariant that only
	// the surfaced (3rd-attempt) failure advances the counter. The watchdog
	// sets `suppressNextErrorMessageEnd` before each abort to prevent that.
	it("suppressNextErrorMessageEnd is set on every silent retry", async () => {
		const rpc = makeRpc();
		const session = makeSession("prod1", rpc);

		onAgentEvent(session, { type: "agent_start" }, FAST_CFG, isAlive);

		// Wait for first stall.
		const deadline = Date.now() + 1000;
		while (Date.now() < deadline && rpc.abortCalls === 0) await sleep(10);
		assert.equal(rpc.abortCalls, 1);
		assert.equal(session.suppressNextErrorMessageEnd, true,
			"silent-retry abort sets the suppress flag");

		// Simulate the production-shape abort response: the helper consumes
		// the flag and tells the caller to skip bookkeeping.
		const skip = shouldSkipErrorMessageEnd(session);
		assert.equal(skip, true, "helper returns true on first error message_end");
		assert.equal(session.suppressNextErrorMessageEnd, false, "flag is consumed");

		// A second error message_end (e.g. spurious double frame) is NOT
		// suppressed — each abort gets exactly one suppression slot.
		assert.equal(shouldSkipErrorMessageEnd(session), false);

		disposeStreamWatchdog(session);
	});

	it("surfaced stall sets the flag AND emits a synthetic message_end", async () => {
		const rpc = makeRpc();
		const session = makeSession("prod2", rpc);
		const syntheticEvents: any[] = [];
		session.emitSyntheticEvent = (ev) => syntheticEvents.push(ev);

		// Drive 3 stalls.
		onAgentEvent(session, { type: "agent_start" }, FAST_CFG, isAlive);
		const deadline = Date.now() + 2000;
		while (Date.now() < deadline && rpc.abortCalls < 1) await sleep(10);
		onAgentEvent(session, { type: "agent_end" }, FAST_CFG, isAlive);
		session.suppressNextDrainForStallRetry = false;
		session.suppressNextErrorMessageEnd = false;
		onAgentEvent(session, { type: "agent_start" }, FAST_CFG, isAlive);
		while (Date.now() < deadline && rpc.abortCalls < 2) await sleep(10);
		onAgentEvent(session, { type: "agent_end" }, FAST_CFG, isAlive);
		session.suppressNextDrainForStallRetry = false;
		session.suppressNextErrorMessageEnd = false;
		onAgentEvent(session, { type: "agent_start" }, FAST_CFG, isAlive);
		while (Date.now() < deadline && rpc.abortCalls < 3) await sleep(10);

		assert.equal(rpc.abortCalls, 3);
		assert.equal(session.suppressNextErrorMessageEnd, true,
			"surfaced stall also sets the suppress flag (the abort emits another error frame)");
		assert.equal(syntheticEvents.length, 1, "exactly one synthetic message_end");
		const ev = syntheticEvents[0];
		assert.equal(ev.type, "message_end");
		assert.equal(ev.message.role, "assistant");
		assert.equal(ev.message.stopReason, "error");
		assert.match(ev.message.errorMessage, /stream stalled/i,
			"synthetic message_end carries the stalled-stream user-visible text");

		disposeStreamWatchdog(session);
	});
});

describe("stream-watchdog: user-Stop race during silent retry", () => {
	// Reproduces the [HIGH] race fixed by `shouldSuppressDrainForStallRetry`:
	// watchdog initiates a silent-retry abort; user clicks Stop before
	// `agent_end` arrives. Without the fix the suppression branch returned
	// early and the session stuck in `aborting` forever (no broadcastStatus).
	it("user Stop wins over silent-retry suppression — session reaches idle", async () => {
		const rpc = makeRpc();
		const session = makeSession("race-stop", rpc);

		onAgentEvent(session, { type: "agent_start" }, FAST_CFG, isAlive);

		// Wait for first stall — watchdog set the suppression flag and called abort().
		const deadline = Date.now() + 1000;
		while (Date.now() < deadline && rpc.abortCalls === 0) await sleep(10);
		assert.equal(rpc.abortCalls, 1);
		assert.equal(session.suppressNextDrainForStallRetry, true);

		// Simulate the SessionManager `agent_end` handler that runs inline
		// in production. Two cases interleaved here:
		//   case A: user did NOT press Stop → helper short-circuits, drain
		//           is suppressed, watchdog re-prompts.
		//   case B: user DID press Stop → helper clears the flag and returns
		//           false; standard wasAborting path proceeds.
		const userPressedStop = true;
		const suppress = shouldSuppressDrainForStallRetry(session, userPressedStop);
		assert.equal(suppress, false,
			"user Stop must win — helper returns false so caller proceeds to broadcastStatus(idle)");
		assert.equal(session.suppressNextDrainForStallRetry, false,
			"flag cleared so a stale flag can't strand the next agent_end");

		disposeStreamWatchdog(session);
	});
});

describe("stream-watchdog: silent-retry dispatch failure", () => {
	// Bug 1 (issue-analysis): the silent-retry branch issues
	//   `setTimeout(0) → rpcClient.prompt(...).catch(()=>{})`
	// and silently swallows dispatch failures. When `prompt()` rejects (the
	// real-agent shape: "Agent is already processing" because the abort hasn't
	// fully torn down yet), the watchdog presets `lastLlmFrameAt = Date.now()`
	// and idles waiting for frames that will never arrive. The next stall
	// fires only after another full `timeoutMs` cycle.
	//
	// Post-fix expectation: a rejected re-prompt surfaces the stall
	// IMMEDIATELY (within one tick), not after another full `timeoutMs`.
	it("stream-watchdog: silent retry surfaces immediately when re-prompt dispatch rejects", async () => {
		const rpc = makeRpc();
		// Model the real-agent race: prompt() rejects with "Agent is already
		// processing." when called while an abort handshake is mid-flight.
		// The watchdog's silent-retry branch does:
		//   await rpcClient.abort();
		//   setTimeout(() => { void rpcClient.prompt(...).catch(()=>{}); }, 0);
		// The setTimeout(0) callback fires while abortInFlight is still true
		// (cleared ~30ms later), so prompt() rejects — matching production.
		// No one-shot opt-in: the rejection is triggered by the watchdog's
		// natural sequencing.
		rpc.modelAbortBusy = true;
		rpc.abortBusyWindowMs = 30;
		const session = makeSession("silent-retry-reject", rpc);
		const syntheticEvents: any[] = [];
		session.emitSyntheticEvent = (ev) => syntheticEvents.push(ev);

		// Arm.
		onAgentEvent(session, { type: "agent_start" }, FAST_CFG, isAlive);

		// Wait for the first stall + silent-retry re-prompt to fire (and reject).
		// Bounded budget: timeoutMs (100) + 100ms = 200ms. Post-fix the watchdog
		// must surface within this window. Pre-fix the watchdog would still be
		// idling here (next stall only at ~timeoutMs * 2 = 200ms+ from the
		// re-prompt's setTimeout(0) reset of lastLlmFrameAt).
		const budgetMs = FAST_CFG.timeoutMs + 100;
		const deadline = Date.now() + budgetMs;
		while (Date.now() < deadline) {
			if (session.lastTurnErrored === true) break;
			await sleep(10);
		}

		// At least one re-prompt was attempted (the rejecting one).
		assert.ok(
			rpc.promptCalls.length >= 1,
			`re-prompt was issued (got promptCalls=${rpc.promptCalls.length})`,
		);

		// CORE ASSERTION: the watchdog surfaced the stall to the user within
		// the bounded budget — it did NOT swallow the rejection and idle
		// waiting for another `timeoutMs` cycle.
		assert.equal(
			session.lastTurnErrored,
			true,
			"expected lastTurnErrored=true within timeoutMs+100ms after dispatch rejection " +
			`(got ${session.lastTurnErrored}); the watchdog must surface immediately on rejected re-prompt`,
		);
		assert.match(
			session.lastTurnErrorMessage ?? "",
			/stream stalled/i,
			"surfaced error message must mention 'stream stalled'",
		);
		assert.equal(
			session.consecutiveErrorTurns,
			1,
			"surfaced stall bumps consecutiveErrorTurns by exactly 1",
		);
		assert.equal(
			syntheticEvents.length,
			1,
			"exactly one synthetic message_end emitted on surfaced stall",
		);
		assert.equal(syntheticEvents[0].type, "message_end");
		assert.equal(syntheticEvents[0].message.stopReason, "error");

		// Two aborts: one for the silent retry, one for the surfacing path.
		assert.equal(
			rpc.abortCalls,
			2,
			"expected 2 aborts (one for the silent-retry attempt, one for the immediate surfacing after dispatch rejection)",
		);

		disposeStreamWatchdog(session);
	});
});

describe("stream-watchdog: end-to-end production-shape flow", () => {
	// Mimics the full SessionManager bookkeeping under production-shape
	// abort frames. Asserts the design invariant: silent retries do NOT
	// advance `consecutiveErrorTurns`; only the surfaced stall does (+1).
	function simulateMessageEnd(session: WatchdogSession, errored: boolean, errorMessage?: string) {
		// Mirror the SessionManager handler logic in src/server/agent/session-manager.ts
		// (the message_end branch).
		if (errored && shouldSkipErrorMessageEnd(session)) {
			return; // Watchdog owns the bookkeeping.
		}
		if (errored) {
			session.lastTurnErrored = true;
			session.lastTurnErrorMessage = errorMessage || "";
			session.consecutiveErrorTurns = (session.consecutiveErrorTurns ?? 0) + 1;
		} else {
			session.lastTurnErrored = false;
			session.lastTurnErrorMessage = undefined;
			session.consecutiveErrorTurns = 0;
		}
	}

	it("silent retries do not bump consecutiveErrorTurns under prod-shape aborts", async () => {
		const rpc = makeRpc();
		const session = makeSession("prod3", rpc);

		onAgentEvent(session, { type: "agent_start" }, FAST_CFG, isAlive);

		// Stall #1.
		const deadline1 = Date.now() + 1000;
		while (Date.now() < deadline1 && rpc.abortCalls === 0) await sleep(10);
		assert.equal(rpc.abortCalls, 1);

		// Production agent emits the abort error frame BEFORE agent_end.
		simulateMessageEnd(session, true, "Request aborted");
		assert.equal(session.consecutiveErrorTurns ?? 0, 0,
			"silent retry must NOT bump (suppression flag consumed)");
		assert.equal(session.lastTurnErrored ?? false, false,
			"silent retry must NOT mark turn as errored");

		onAgentEvent(session, { type: "agent_end" }, FAST_CFG, isAlive);
		session.suppressNextDrainForStallRetry = false;
		onAgentEvent(session, { type: "agent_start" }, FAST_CFG, isAlive);

		// Stall #2.
		const deadline2 = Date.now() + 1000;
		while (Date.now() < deadline2 && rpc.abortCalls < 2) await sleep(10);
		simulateMessageEnd(session, true, "Request aborted");
		assert.equal(session.consecutiveErrorTurns ?? 0, 0,
			"silent retry #2 must NOT bump");

		onAgentEvent(session, { type: "agent_end" }, FAST_CFG, isAlive);
		session.suppressNextDrainForStallRetry = false;
		onAgentEvent(session, { type: "agent_start" }, FAST_CFG, isAlive);

		// Stall #3 (surfaced). Watchdog bumps the counter manually,
		// then emits the synthetic message_end (which IS suppressed by
		// the same flag), then aborts — the abort's error frame is
		// suppressed by the same flag. Wait, it's only one slot... let's
		// confirm exactly one bump in total.
		const evs: any[] = [];
		session.emitSyntheticEvent = (ev) => {
			evs.push(ev);
			// The synthetic event flows directly to clients (bypassing
			// handleAgentLifecycle) per session-manager.ts wiring — do not
			// run simulateMessageEnd here.
		};

		const deadline3 = Date.now() + 1000;
		while (Date.now() < deadline3 && rpc.abortCalls < 3) await sleep(10);
		assert.equal(rpc.abortCalls, 3);
		assert.equal(session.consecutiveErrorTurns, 1,
			"surfaced stall bumps by exactly 1 (manual watchdog bump)");
		assert.equal(session.lastTurnErrored, true);
		assert.match(session.lastTurnErrorMessage ?? "", /stream stalled/i);

		// Now the production abort emits its own error frame. The
		// suppression flag is set, so this MUST be skipped.
		simulateMessageEnd(session, true, "Request aborted");
		assert.equal(session.consecutiveErrorTurns, 1,
			"abort's 'Request aborted' frame must NOT bump again (still 1)");
		assert.equal(session.lastTurnErrored, true,
			"watchdog's lastTurnErrored preserved");
		assert.match(session.lastTurnErrorMessage ?? "", /stream stalled/i,
			"watchdog's lastTurnErrorMessage NOT clobbered by 'Request aborted'");

		disposeStreamWatchdog(session);
	});
});
