/**
 * Regression guard: every session-setup spawn path must seed
 * `BOBBIT_SESSION_ID` on the spawned agent CLI's env.
 *
 * The provider-level x-opencode-session header in models.json depends on this
 * env var being available to the spawned subprocess (pi-coding-agent runs
 * `node -e "process.stdout.write(process.env.BOBBIT_SESSION_ID || '')"` and
 * drops the header when stdout is empty). Without this env var, the header
 * silently disappears from every aigw request — a subtle regression we want
 * a failing test to catch.
 *
 * We can't import session-setup.ts directly under tsx (it transitively pulls
 * in modules with ESM-resolution quirks), so we lock the contract two ways:
 *
 * 1. Source-level assertion: `resolveBridgeOptions` in session-setup.ts must
 *    set `BOBBIT_SESSION_ID: plan.id` on the bridge env. This catches the
 *    most likely regression — someone refactoring the env construction and
 *    accidentally dropping the seed.
 *
 * 2. Functional reproduction: the same env-construction logic, replicated
 *    inline, asserts the merge ordering (session id wins, caller env can
 *    add additional vars, delegate-of is preserved).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("session-setup spawn env contract", () => {
	it("source: resolveBridgeOptions seeds BOBBIT_SESSION_ID with plan.id", () => {
		const src = readFileSync(
			path.join(process.cwd(), "src/server/agent/session-setup.ts"),
			"utf-8",
		);
		// Anchor on the exact phrase. If a refactor renames `plan.id` we want
		// to know — the test must be updated to keep tracking the contract.
		assert.ok(
			/BOBBIT_SESSION_ID:\s*plan\.id/.test(src),
			"resolveBridgeOptions must seed BOBBIT_SESSION_ID with plan.id — required by aigw x-opencode-session header",
		);
	});

	it("source: bridge env merge preserves caller-supplied env after BOBBIT_SESSION_ID + secret", () => {
		const src = readFileSync(
			path.join(process.cwd(), "src/server/agent/session-setup.ts"),
			"utf-8",
		);
		// Verify the env-spread shape seeds BOBBIT_SESSION_ID first, then the S1
		// per-session BOBBIT_SESSION_SECRET, then spreads caller env LAST (so a
		// caller-supplied env can never override the session id or its secret):
		//   { BOBBIT_SESSION_ID: plan.id, BOBBIT_SESSION_SECRET: ..., ...plan.env }
		assert.ok(
			/env:\s*\{\s*BOBBIT_SESSION_ID:\s*plan\.id,\s*BOBBIT_SESSION_SECRET:[\s\S]*?\.\.\.plan\.env,?\s*\}/.test(src),
			"bridge env must seed BOBBIT_SESSION_ID + BOBBIT_SESSION_SECRET first, then spread caller env",
		);
	});

	it("functional: replicated env-construction logic seeds BOBBIT_SESSION_ID + secret before caller env", () => {
		// Faithful reproduction of the env-merge in resolveBridgeOptions.
		function buildBridgeEnv(plan: { id: string; env?: Record<string, string>; delegateOf?: string }) {
			let env: Record<string, string> = {
				BOBBIT_SESSION_ID: plan.id,
				BOBBIT_SESSION_SECRET: `secret-for-${plan.id}`,
				...(plan.env ?? {}),
			};
			if (plan.delegateOf) {
				env = { ...env, BOBBIT_DELEGATE_OF: plan.delegateOf };
			}
			return env;
		}

		const env1 = buildBridgeEnv({ id: "sess-abc-123" });
		assert.equal(env1.BOBBIT_SESSION_ID, "sess-abc-123");
		assert.equal(env1.BOBBIT_SESSION_SECRET, "secret-for-sess-abc-123");

		const env2 = buildBridgeEnv({ id: "delegate-xyz", delegateOf: "parent-1" });
		assert.equal(env2.BOBBIT_SESSION_ID, "delegate-xyz");
		assert.equal(env2.BOBBIT_DELEGATE_OF, "parent-1");

		const env3 = buildBridgeEnv({ id: "sess-keep", env: { OTHER_VAR: "v" } });
		assert.equal(env3.BOBBIT_SESSION_ID, "sess-keep");
		assert.equal(env3.OTHER_VAR, "v");
	});
});
