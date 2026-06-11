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

	it("source: gateway-owned BOBBIT_SESSION_ID + secret are spread AFTER caller env so they always win", () => {
		const src = readFileSync(
			path.join(process.cwd(), "src/server/agent/session-setup.ts"),
			"utf-8",
		);
		// Verify the env-spread shape spreads caller env (`...plan.env`) FIRST, then
		// the gateway-owned BOBBIT_SESSION_ID + per-session BOBBIT_SESSION_SECRET so
		// a caller-supplied toolEnv key can NEVER clobber the session identity or its
		// capability secret (which would let a child impersonate another session for
		// the binding-routed PR-walkthrough tool routes):
		//   { ...plan.env, BOBBIT_SESSION_ID: plan.id, BOBBIT_SESSION_SECRET: ... }
		assert.ok(
			/env:\s*\{\s*\.\.\.plan\.env,\s*BOBBIT_SESSION_ID:\s*plan\.id,\s*BOBBIT_SESSION_SECRET:[\s\S]*?\}/.test(src),
			"bridge env must spread caller env FIRST, then seed gateway-owned BOBBIT_SESSION_ID + BOBBIT_SESSION_SECRET so they win",
		);
	});

	it("source: BOBBIT_DELEGATE_OF env var is NO LONGER written (recursion guard moved to OrchestrationCore)", () => {
		const src = readFileSync(
			path.join(process.cwd(), "src/server/agent/session-setup.ts"),
			"utf-8",
		);
		// The legacy delegate-recursion guard wrote BOBBIT_DELEGATE_OF into the
		// child's env so the agent extension could early-return and skip
		// registering the delegate tool. That mechanism is replaced by
		// OrchestrationCore.assertCanSpawn + allowedTools subtraction (every spawn
		// verb stripped from the child) — see docs/design/orchestration-core.md §7.
		// Assert the env-write is gone so the dead mechanism can't silently return.
		assert.ok(
			!/BOBBIT_DELEGATE_OF:/.test(src),
			"session-setup.ts must NOT write BOBBIT_DELEGATE_OF — recursion is guarded by OrchestrationCore.assertCanSpawn + allowedTools subtraction",
		);
	});

	it("functional: gateway-owned BOBBIT_SESSION_ID + secret win over caller toolEnv", () => {
		// Faithful reproduction of the env-merge in resolveBridgeOptions: caller env
		// (`...plan.env`) is spread FIRST, then the gateway-owned identity keys, so
		// the gateway values always win. The delegate-of env branch is intentionally
		// gone (see the source test above).
		function buildBridgeEnv(plan: { id: string; env?: Record<string, string> }) {
			const env: Record<string, string> = {
				...(plan.env ?? {}),
				BOBBIT_SESSION_ID: plan.id,
				BOBBIT_SESSION_SECRET: `secret-for-${plan.id}`,
			};
			return env;
		}

		const env1 = buildBridgeEnv({ id: "sess-abc-123" });
		assert.equal(env1.BOBBIT_SESSION_ID, "sess-abc-123");
		assert.equal(env1.BOBBIT_SESSION_SECRET, "secret-for-sess-abc-123");

		const env2 = buildBridgeEnv({ id: "delegate-xyz" });
		assert.equal(env2.BOBBIT_SESSION_ID, "delegate-xyz");
		assert.equal(env2.BOBBIT_DELEGATE_OF, undefined);

		const env3 = buildBridgeEnv({ id: "sess-keep", env: { OTHER_VAR: "v" } });
		assert.equal(env3.BOBBIT_SESSION_ID, "sess-keep");
		assert.equal(env3.OTHER_VAR, "v");

		// SECURITY: a malicious/buggy toolEnv that sets BOBBIT_SESSION_SECRET or
		// BOBBIT_SESSION_ID must NOT override the gateway-issued values — otherwise a
		// child could impersonate another session for the binding-routed PR-walkthrough
		// tool routes.
		const hijack = buildBridgeEnv({
			id: "sess-real",
			env: {
				BOBBIT_SESSION_ID: "sess-victim",
				BOBBIT_SESSION_SECRET: "stolen-secret",
				OTHER_VAR: "v",
			},
		});
		assert.equal(hijack.BOBBIT_SESSION_ID, "sess-real", "toolEnv must not override the gateway-issued BOBBIT_SESSION_ID");
		assert.equal(hijack.BOBBIT_SESSION_SECRET, "secret-for-sess-real", "toolEnv must not override the gateway-issued BOBBIT_SESSION_SECRET");
		assert.equal(hijack.OTHER_VAR, "v", "unrelated toolEnv keys are still passed through");
	});
});
