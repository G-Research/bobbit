/**
 * Unit — EXT-02: lifecycle hook contract has a SINGLE source of truth.
 *
 * Before src/server/agent/lifecycle-hooks.ts existed, the accepted/dispatched/
 * bridged lifecycle-hook set was hand-copied as FOUR independent literals:
 *
 *   1. lifecycle-hub.ts        `LifecycleHook` union
 *   2. pack-contributions.ts   `PROVIDER_HOOKS` Set (manifest acceptance list)
 *   3. provider-bridge-extension.ts `TURN_BRIDGE_HOOKS`
 *   4. server.ts                inline `["goalCompleted"]` array passed to
 *                               `hasProvidersForHooks()` for the
 *                               `hasGoalCompletedProviders` presence gate
 *
 * Any hook add/remove that missed one of the four silently dropped pack
 * loading, dispatch, or the goalCompleted presence gate — exactly how the
 * EXT-01 goalCompleted outage happened (added to the union, forgotten in
 * PROVIDER_HOOKS). All four now DERIVE from lifecycle-hooks.ts.
 *
 * These tests pin today's literal contents against independent, hand-written
 * snapshots (NOT against each other, which would be tautological) so any
 * future edit to the shared source is a conscious, single-place decision —
 * not silent drift. Zero-behavior-change invariant: the accepted/dispatched/
 * bridged/gated hook sets must be byte-identical before and after the EXT-02
 * refactor.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	LIFECYCLE_HOOKS,
	GOAL_ONLY_HOOKS,
	ALL_PROVIDER_HOOKS,
	GOAL_COMPLETED_PRESENCE_HOOKS,
	type LifecycleHook,
} from "../src/server/agent/lifecycle-hooks.ts";
import { TURN_BRIDGE_HOOKS } from "../src/server/agent/provider-bridge-extension.ts";
import { loadProviders } from "../src/server/agent/pack-contributions.ts";
import type { PackManifest } from "../src/server/agent/pack-types.ts";

// ── Independent snapshots of today's four hand-written literals ────────────
// (deliberately NOT imported from lifecycle-hooks.ts — that would make the
// test tautological against the very thing it's meant to pin).
const TODAYS_LIFECYCLE_HOOK_UNION = ["sessionSetup", "beforePrompt", "afterTurn", "beforeCompact", "sessionShutdown", "goalCompleted"];
const TODAYS_GOAL_ONLY_HOOKS = ["goalProvisioned"];
const TODAYS_PROVIDER_HOOKS_ACCEPTANCE = new Set([...TODAYS_LIFECYCLE_HOOK_UNION, ...TODAYS_GOAL_ONLY_HOOKS]);
const TODAYS_TURN_BRIDGE_HOOKS = ["beforePrompt", "beforeCompact"];
const TODAYS_GOAL_COMPLETED_PRESENCE_HOOKS = ["goalCompleted"];

function manifest(providers: string[]): PackManifest {
	return {
		name: "hook-pin-pack",
		description: "d",
		version: "1",
		schema: 2,
		contents: {
			roles: [], tools: [], skills: [], entrypoints: [], providers,
			hooks: [], mcp: [], piExtensions: [], runtimes: [], workflows: [],
		},
	};
}

describe("EXT-02: LIFECYCLE_HOOKS (consumer #1 — lifecycle-hub.ts LifecycleHook union)", () => {
	it("matches today's literal contents exactly (order included — it's a type source)", () => {
		assert.deepEqual([...LIFECYCLE_HOOKS], TODAYS_LIFECYCLE_HOOK_UNION);
	});
});

describe("EXT-02: GOAL_ONLY_HOOKS", () => {
	it("matches today's literal contents (hooks accepted by manifests but never LifecycleHook-typed)", () => {
		assert.deepEqual([...GOAL_ONLY_HOOKS], TODAYS_GOAL_ONLY_HOOKS);
	});
});

describe("EXT-02: ALL_PROVIDER_HOOKS (consumer #2 — pack-contributions.ts PROVIDER_HOOKS acceptance set)", () => {
	it("matches today's literal Set contents exactly", () => {
		assert.deepEqual(new Set(ALL_PROVIDER_HOOKS), TODAYS_PROVIDER_HOOKS_ACCEPTANCE);
	});

	it("is a superset of every hook actually dispatched (LIFECYCLE_HOOKS ∪ GOAL_ONLY_HOOKS)", () => {
		const dispatchedUnion = new Set<string>([...LIFECYCLE_HOOKS, ...GOAL_ONLY_HOOKS]);
		const accepted = new Set<string>(ALL_PROVIDER_HOOKS);
		for (const hook of dispatchedUnion) {
			assert.ok(accepted.has(hook), `dispatched hook "${hook}" is missing from PROVIDER_HOOKS acceptance — a provider declaring it would be silently dropped at load time (the EXT-01 outage class)`);
		}
	});

	it("the providers/<id>.yaml loader ACCEPTS every ALL_PROVIDER_HOOKS name and REJECTS an unknown one", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-hooks-pin-"));
		try {
			const root = path.join(tmp, "market-packs", "hook-pin-pack");
			fs.mkdirSync(path.join(root, "providers"), { recursive: true });
			fs.mkdirSync(path.join(root, "lib"), { recursive: true });
			fs.writeFileSync(path.join(root, "lib", "provider.js"), "export default {};\n", "utf-8");

			// One provider per real hook name — all must load.
			const ids: string[] = [];
			for (const hook of ALL_PROVIDER_HOOKS) {
				const id = `p-${hook}`;
				ids.push(id);
				fs.writeFileSync(
					path.join(root, "providers", `${id}.yaml`),
					`id: ${id}\nmodule: ../lib/provider.js\nhooks: [${hook}]\n`,
					"utf-8",
				);
			}
			// Plus one provider with an unknown hook name — must be dropped.
			ids.push("p-unknown");
			fs.writeFileSync(
				path.join(root, "providers", "p-unknown.yaml"),
				"id: p-unknown\nmodule: ../lib/provider.js\nhooks: [totallyNotARealHook]\n",
				"utf-8",
			);

			const loaded = loadProviders(root, manifest(ids));
			assert.deepEqual(
				loaded.map((p) => p.id).sort(),
				ALL_PROVIDER_HOOKS.map((h) => `p-${h}`).sort(),
				"every real hook name should load a provider; the unknown-hook provider should be dropped",
			);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("EXT-02: TURN_BRIDGE_HOOKS (consumer #3 — provider-bridge-extension.ts)", () => {
	it("matches today's literal contents exactly (derived by filtering LIFECYCLE_HOOKS)", () => {
		assert.deepEqual([...TURN_BRIDGE_HOOKS], TODAYS_TURN_BRIDGE_HOOKS);
	});

	it("is a subset of LIFECYCLE_HOOKS", () => {
		const all = new Set<LifecycleHook>(LIFECYCLE_HOOKS);
		for (const hook of TURN_BRIDGE_HOOKS) assert.ok(all.has(hook));
	});
});

describe("EXT-02: GOAL_COMPLETED_PRESENCE_HOOKS (consumer #4 — server.ts hasGoalCompletedProviders gate)", () => {
	it("matches today's literal contents exactly (the inline [\"goalCompleted\"] array server.ts used to pass to hasProvidersForHooks)", () => {
		assert.deepEqual([...GOAL_COMPLETED_PRESENCE_HOOKS], TODAYS_GOAL_COMPLETED_PRESENCE_HOOKS);
	});
});
