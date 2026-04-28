/**
 * Round-trip test for ToolGroupPolicyStore: setting `mcp__nano-banana: never`
 * survives mcpManager.connectAll() (the connection cycle must not blow away
 * user-set policies for MCP server groups).
 *
 * Phase 1: scaffold only. Phase 2 will:
 *   1. Construct a temp stateDir + ToolGroupPolicyStore.
 *   2. Set mcp__nano-banana → "never".
 *   3. Run mcpManager.connectAll() (or a stub of the connect flow that
 *      registers default policies for newly-discovered server groups).
 *   4. Assert the user-set "never" policy is still present.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// TODO Phase 2: pull live exports.
// const { ToolGroupPolicyStore } = await import("../dist/server/agent/tool-group-policy-store.js");

describe("ToolGroupPolicyStore — mcp__nano-banana never round-trip", () => {
	it.skip("user-set mcp__nano-banana=never survives mcpManager.connectAll()", () => {
		// TODO Phase 2: set up a temp store, set policy, simulate connect, assert.
		assert.ok(true);
	});

	it.skip("builtin defaults remain immutable through restart", () => {
		// TODO Phase 2: builtin policies are immutable per Agent B B16; assert
		// that re-instantiating the store returns the same builtin map.
		assert.ok(true);
	});
});
