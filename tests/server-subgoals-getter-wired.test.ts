/**
 * Source-pin test for the Subgoals feature-gate boot wiring.
 *
 * `ToolGroupPolicyStore.setSubgoalsEnabledGetter` injects the preferences
 * accessor that `resolveGrantPolicy` reads at policy-resolution time to
 * decide whether tools in the `Children` group (goal_spawn_child et al)
 * are available to a team-lead.
 *
 * If `setSubgoalsEnabledGetter` is never called during server boot, the
 * store's getter stays undefined, `getSubgoalsEnabled()` returns false
 * unconditionally, and every Children-group tool is silently dropped
 * from every team-lead's tool surface. The agent then sees:
 *     `Tool goal_spawn_child not found`
 *
 * This regression has hit the codebase twice now via merge conflict
 * resolution — once before the original `158fc3e3` fix, and once again
 * during a later master merge into the subgoals branch. Each silent
 * regression cost ~30 minutes of debugging across multiple agents.
 *
 * This is a SOURCE-PIN: we read server.ts as text and assert the wiring
 * call exists. It's deliberately blunt because the bug-class is "the
 * call disappeared". A behavioural unit test wouldn't catch it because
 * the resolver code is intact — only the wiring is missing.
 *
 * The runtime contract is independently pinned by:
 *   - tests/tool-activation-subgoals-flag.test.ts (resolver behaviour)
 *   - tests/e2e/api-subgoals-disabled.spec.ts (server REST gate)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_TS = path.join(__dirname, "..", "src", "server", "server.ts");

describe("Server boot — Subgoals feature gate wiring", () => {
	it("server.ts calls groupPolicyStore.setSubgoalsEnabledGetter at boot", () => {
		const text = fs.readFileSync(SERVER_TS, "utf-8");
		assert.ok(
			text.includes("groupPolicyStore.setSubgoalsEnabledGetter("),
			"server.ts must call groupPolicyStore.setSubgoalsEnabledGetter(...) at boot.\n" +
			"Without it, every Children-group tool (goal_spawn_child etc.) resolves to 'never'\n" +
			"and is silently dropped from team-lead tool surfaces.\n" +
			"Expected snippet: groupPolicyStore.setSubgoalsEnabledGetter(() => preferencesStore.get(\"subgoalsEnabled\") === true);",
		);
	});

	it("the getter is wired to preferencesStore.get(\"subgoalsEnabled\")", () => {
		const text = fs.readFileSync(SERVER_TS, "utf-8");
		// Allow either === true or Boolean(...) style, but require the
		// preferences key to be the source of truth.
		const re = /setSubgoalsEnabledGetter\(\s*\(\)\s*=>[\s\S]{0,200}?preferencesStore\.get\(\s*["']subgoalsEnabled["']\s*\)/;
		assert.ok(
			re.test(text),
			"setSubgoalsEnabledGetter must read from preferencesStore.get(\"subgoalsEnabled\") — the single source of truth for the system-scope flag.",
		);
	});
});
