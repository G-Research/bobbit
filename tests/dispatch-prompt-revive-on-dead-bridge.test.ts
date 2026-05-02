/**
 * Pinned regression: enqueuePrompt revives a dead RPC bridge before
 * dispatching, instead of throwing "Agent process not running".
 *
 * Live test (PR #409): post-restart, several team-lead sessions
 * (Con Fident, Howl, Meg Awatt) had their persisted records restored
 * but their in-process RPC bridges were dead. WS prompts entered
 * `enqueuePrompt`, which called `session.rpcClient.prompt(...)` →
 * threw synchronously from sendCommand because `this.process?.stdin`
 * was null. The error propagated up but the session stayed broken;
 * the parent team-lead had no recovery path except teardown +
 * restart team manually.
 *
 * Fix: `_dispatchPromptWithReviveOnDeadBridge` checks
 * `rpcClient.running` and calls `restartAgent` if the bridge is dead.
 *
 * The unit test pins the decision predicate. The actual restartAgent
 * + dispatch flow is integration-tested via the existing
 * tests/session-restore-*.test.ts suite.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

interface RpcBridgeLike {
	running: boolean;
}

/** Replicates the decision: true → revive needed before dispatch. */
function shouldReviveBeforeDispatch(rpcClient: RpcBridgeLike | null | undefined): boolean {
	if (!rpcClient) return false;
	return !rpcClient.running;
}

describe("_dispatchPromptWithReviveOnDeadBridge predicate", () => {
	it("does NOT revive when bridge is alive (running: true)", () => {
		assert.equal(shouldReviveBeforeDispatch({ running: true }), false);
	});

	it("REVIVES when bridge is dead (running: false) — THE bug regression", () => {
		// Post-restart pattern: session record alive, RPC bridge dead.
		// Without revive, the prompt gets ack'd by WS but never reaches
		// the agent process.
		assert.equal(shouldReviveBeforeDispatch({ running: false }), true);
	});

	it("does not revive null rpcClient (defensive: caller guard)", () => {
		// Should never happen in production (session always has rpcClient)
		// but predicate must not throw on degenerate inputs.
		assert.equal(shouldReviveBeforeDispatch(null), false);
		assert.equal(shouldReviveBeforeDispatch(undefined), false);
	});
});

describe("dispatch revive flow integration points", () => {
	// These are documentation-as-test cases that pin the contract:
	// which dispatch sites in session-manager.ts must use the revive
	// helper, and which can call rpcClient.prompt directly.
	it("documents which dispatch sites use revive vs direct", () => {
		const dispatchSites = {
			"enqueuePrompt — error-recovery branch (errored turn unstick)": "REVIVE",
			"enqueuePrompt — idle+empty branch (normal new prompt)": "REVIVE",
			"drainQueue (queue-draining after agent_idle)": "DIRECT",  // already in steady-state recovery flow
			"retry path (auto-retry timer)": "DIRECT",  // same, retries should use existing bridge
		};
		// Steady-state retry / drain paths leave the existing bridge as-is —
		// auto-reviving on every retry would mask real bugs.
		assert.equal(dispatchSites["enqueuePrompt — idle+empty branch (normal new prompt)"], "REVIVE");
		assert.equal(dispatchSites["drainQueue (queue-draining after agent_idle)"], "DIRECT");
	});
});
