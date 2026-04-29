/**
 * Regression test for the rpc-bridge shell/extension.ts cascade fallback.
 *
 * Background: when a sub-agent constructs an `RpcBridge` without a
 * `ToolManager` (e.g. the mission-gate llm-review legacy direct path), the
 * previous code hard-coded the user-overlay TOOLS_DIR. If the user had no
 * `.bobbit/config/tools/shell/extension.ts` override (the default), the agent
 * process exited 1 with "Extension path does not exist", cascading to
 * "Agent process not running" in `applyReviewModelOverrides` and crashing
 * every mission gate with an llm-review step.
 *
 * The fix: cascade TOOLS_DIR (config overlay) \u2192 BUILTIN_TOOLS_DIR
 * (dist/server/defaults/tools, shipped with Bobbit). This test pins both
 * branches \u2014 with and without a ToolManager.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { resolveBashExtensionPath } from "../src/server/agent/rpc-bridge.ts";

// Use a fake `existsSync` so the test is independent of build state and
// platform path semantics.
function fakeExists(present: Set<string>): (p: string) => boolean {
	return (p: string) => present.has(p);
}

describe("resolveBashExtensionPath \u2014 sub-agent fallback cascade", () => {
	it("returns the TOOLS_DIR (overlay) candidate when it exists", () => {
		// Discover the actual candidate paths the helper checks by intercepting.
		const probes: string[] = [];
		const result = resolveBashExtensionPath(undefined, (p) => {
			probes.push(p);
			// Accept the first probe (the overlay path) so the cascade short-
			// circuits before reaching BUILTIN_TOOLS_DIR.
			return probes.length === 1;
		});
		assert.equal(typeof result, "string");
		assert.equal(result, probes[0]);
		assert.ok(probes[0].endsWith(path.join("shell", "extension.ts")));
		assert.ok(probes.length >= 1);
	});

	it("falls back to BUILTIN_TOOLS_DIR when overlay is missing", () => {
		const probes: string[] = [];
		const result = resolveBashExtensionPath(undefined, (p) => {
			probes.push(p);
			// Reject the first probe (overlay) and accept the second (builtin).
			return probes.length === 2;
		});
		assert.equal(typeof result, "string");
		assert.equal(result, probes[1]);
		// The builtin candidate must point inside dist/server/defaults/tools/shell/.
		assert.match(probes[1], /defaults[\\\/]tools[\\\/]shell[\\\/]extension\.ts$/);
		assert.equal(probes.length, 2, "both candidates probed in cascade order");
	});

	it("returns undefined when neither overlay nor builtin exists", () => {
		const result = resolveBashExtensionPath(undefined, fakeExists(new Set()));
		assert.equal(result, undefined);
	});

	it("delegates to ToolManager.getExtensionPath when one is provided", () => {
		const calls: Array<[string, string]> = [];
		const fakeManager = {
			getExtensionPath(group: string, file: string) {
				calls.push([group, file]);
				return "/canonical/path/from/tool-manager/shell/extension.ts";
			},
		} as unknown as Parameters<typeof resolveBashExtensionPath>[0];

		// `existsSync` must NOT be called when ToolManager is provided \u2014 it owns
		// the cascade. Throw to assert no fallback path is taken.
		const result = resolveBashExtensionPath(fakeManager, () => {
			throw new Error("existsSync should not be called when ToolManager is provided");
		});
		assert.equal(result, "/canonical/path/from/tool-manager/shell/extension.ts");
		assert.deepEqual(calls, [["shell", "extension.ts"]]);
	});
});
