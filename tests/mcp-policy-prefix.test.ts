/**
 * Unit test for the `mcpPolicyPrefix` regex exported from
 * src/server/agent/tool-activation.ts.
 *
 * Phase 1: scaffold only — Agent B is exporting `mcpPolicyPrefix` (B14).
 * Once that lands, flesh out the assertions below.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// TODO Phase 2 (Agent B B14): import once exported.
// const { mcpPolicyPrefix } = await import("../dist/server/agent/tool-activation.js");

describe("mcpPolicyPrefix", () => {
	it.skip("matches mcp__<server>__<tool> tool names", () => {
		// TODO Phase 2:
		// assert.match("mcp__nano-banana__generate_image", mcpPolicyPrefix);
		// assert.match("mcp__playwright__browser_snapshot", mcpPolicyPrefix);
		assert.ok(true);
	});

	it.skip("rejects non-mcp tool names", () => {
		// TODO Phase 2:
		// assert.doesNotMatch("generate_image", mcpPolicyPrefix);
		// assert.doesNotMatch("mcp__only_one_segment", mcpPolicyPrefix);
		assert.ok(true);
	});

	it.skip("captures the server-name segment for policy lookup", () => {
		// TODO Phase 2: confirm the regex (or helper) produces "mcp__<server>"
		// as the policy key for "mcp__<server>__<tool>".
		assert.ok(true);
	});
});
