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
