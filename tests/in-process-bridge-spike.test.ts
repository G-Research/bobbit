import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

// SPIKE (Wave-5 in-process bridge): pins the two invariants the design doc
// (docs/design/in-process-bridge-spike.md) depends on:
//   1. `BOBBIT_INPROC_BRIDGE` unset (the default) -> `createSessionBridge`
//      is byte-identical to before the spike: always returns the
//      child-process `RpcBridge`, regardless of `readOnly`/`sandboxed`.
//   2. The env flag alone is not enough: sandboxed/containerId/non-readOnly
//      sessions stay on the child-process bridge even when the flag is on
//      (code-executing agents must never route in-process — see the design
//      doc's "Downside / risk" section for why).
// Deliberately does NOT call `.start()` on any bridge: constructing the
// eligible branch already proves routing without loading the pi SDK,
// touching the filesystem, or requiring API keys.

const originalFlag = process.env.BOBBIT_INPROC_BRIDGE;

afterEach(() => {
	if (originalFlag === undefined) delete process.env.BOBBIT_INPROC_BRIDGE;
	else process.env.BOBBIT_INPROC_BRIDGE = originalFlag;
});

const eligibility = await import("../src/server/agent/in-process-bridge-eligibility.ts");
const runtime = await import("../src/server/agent/session-runtime.ts");
const { RpcBridge } = await import("../src/server/agent/rpc-bridge.ts");

describe("in-process bridge eligibility (spike, pure logic)", () => {
	it("is never eligible when the flag is unset, no matter the options", () => {
		delete process.env.BOBBIT_INPROC_BRIDGE;
		assert.equal(eligibility.isInProcessBridgeEligible({ readOnly: true }), false);
		assert.equal(eligibility.isInProcessBridgeEligible({ readOnly: true, sandboxed: false }), false);
	});

	it("requires readOnly, and excludes sandboxed/containerId sessions, when the flag is on", () => {
		process.env.BOBBIT_INPROC_BRIDGE = "1";
		assert.equal(eligibility.isInProcessBridgeEligible({ readOnly: true }), true);
		assert.equal(eligibility.isInProcessBridgeEligible({ readOnly: false }), false);
		assert.equal(eligibility.isInProcessBridgeEligible({}), false);
		assert.equal(eligibility.isInProcessBridgeEligible({ readOnly: true, sandboxed: true }), false);
		assert.equal(eligibility.isInProcessBridgeEligible({ readOnly: true, containerId: "abc123" }), false);
	});

	it("rejects any other value of the flag (only the literal \"1\" opts in)", () => {
		process.env.BOBBIT_INPROC_BRIDGE = "true";
		assert.equal(eligibility.isInProcessBridgeEligible({ readOnly: true }), false);
	});

	// ELIGIBILITY-SIGNAL (eligibility-signal lane, TRACKER item / sizing
	// results): `readOnly` is now ORed with `isReadOnlyToolPolicy(allowedTools)`
	// so a session can qualify from its RESOLVED tool allowlist alone, without
	// a caller ever setting the explicit flag. New pins only — every assertion
	// above (pre-existing, flag-only options with no `allowedTools`) is
	// unaffected: `isReadOnlyToolPolicy(undefined)` is `false`, so the OR is a
	// no-op wherever `allowedTools` isn't threaded through.
	it("derives eligibility from a read-only resolved allowlist even when the flag is never set on the session", () => {
		process.env.BOBBIT_INPROC_BRIDGE = "1";
		assert.equal(eligibility.isInProcessBridgeEligible({ allowedTools: ["read", "grep", "find", "ls"] }), true);
		assert.equal(eligibility.isInProcessBridgeEligible({ allowedTools: ["read", "grep", "bash"] }), false);
	});

	it("derived and explicit flag are safe in both directions (OR, never AND)", () => {
		process.env.BOBBIT_INPROC_BRIDGE = "1";
		// derived=false (bash present) + flag=true -> still eligible (flag wins).
		assert.equal(eligibility.isInProcessBridgeEligible({ readOnly: true, allowedTools: ["read", "bash"] }), true);
		// derived=true (no mutating tool) + flag=false/unset -> still eligible.
		assert.equal(eligibility.isInProcessBridgeEligible({ readOnly: false, allowedTools: ["read", "grep"] }), true);
	});

	it("a resolved allowlist containing an MCP tool never derives eligible (fail closed)", () => {
		process.env.BOBBIT_INPROC_BRIDGE = "1";
		assert.equal(eligibility.isInProcessBridgeEligible({ allowedTools: ["read", "mcp__github__create_pr"] }), false);
	});
});

describe("createSessionBridge routing (spike, pinned)", () => {
	it("PINNED: unset flag -> always the child-process RpcBridge (byte-identical to pre-spike)", () => {
		delete process.env.BOBBIT_INPROC_BRIDGE;
		const bridge = runtime.createSessionBridge({ cwd: "/tmp/x", readOnly: true });
		assert.ok(bridge instanceof RpcBridge, "expected child-process RpcBridge when BOBBIT_INPROC_BRIDGE is unset");
	});

	it("flag on + readOnly + not sandboxed -> routes away from RpcBridge", () => {
		process.env.BOBBIT_INPROC_BRIDGE = "1";
		const bridge = runtime.createSessionBridge({ cwd: "/tmp/x", readOnly: true });
		assert.ok(!(bridge instanceof RpcBridge), "expected the in-process bridge wrapper, not RpcBridge");
	});

	it("flag on but sandboxed -> stays on the child-process RpcBridge", () => {
		process.env.BOBBIT_INPROC_BRIDGE = "1";
		const bridge = runtime.createSessionBridge({ cwd: "/tmp/x", readOnly: true, sandboxed: true });
		assert.ok(bridge instanceof RpcBridge, "sandboxed sessions must never route in-process");
	});

	it("flag on but not readOnly -> stays on the child-process RpcBridge", () => {
		process.env.BOBBIT_INPROC_BRIDGE = "1";
		const bridge = runtime.createSessionBridge({ cwd: "/tmp/x" });
		assert.ok(bridge instanceof RpcBridge, "non-readOnly (code-executing) sessions must never route in-process");
	});

	it("flag on but bound to a Docker containerId -> stays on the child-process RpcBridge", () => {
		process.env.BOBBIT_INPROC_BRIDGE = "1";
		const bridge = runtime.createSessionBridge({ cwd: "/tmp/x", readOnly: true, containerId: "abc123" });
		assert.ok(bridge instanceof RpcBridge, "sessions bound to a sandbox container must never route in-process");
	});
});
