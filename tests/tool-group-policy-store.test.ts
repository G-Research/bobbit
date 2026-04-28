/**
 * Round-trip tests for ToolGroupPolicyStore. Locks two invariants:
 *   1. A user-set group policy (e.g. `mcp__nano-banana: never`) survives
 *      re-instantiation of the store (i.e. a server restart) — it round-trips
 *      via the on-disk YAML file.
 *   2. Builtin defaults are immutable: `setBuiltins` only writes the in-memory
 *      defaults map; subsequent `setGroupPolicy` writes only mutate the
 *      on-disk override file, leaving builtins reachable via a fresh instance.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { ToolGroupPolicyStore } = await import("../dist/server/agent/tool-group-policy-store.js");

let tmpDir: string;

before(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-tgps-"));
});

after(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("ToolGroupPolicyStore — round-trip", () => {
	it("user-set mcp__nano-banana=never persists across re-instantiation", () => {
		const store1 = new ToolGroupPolicyStore(tmpDir);
		store1.setGroupPolicy("mcp__nano-banana", "never");
		assert.equal(store1.getGroupPolicy("mcp__nano-banana"), "never");

		// Simulate restart — fresh instance reads the same on-disk YAML.
		const store2 = new ToolGroupPolicyStore(tmpDir);
		assert.equal(store2.getGroupPolicy("mcp__nano-banana"), "never");
	});

	it("setBuiltins does not overwrite user overrides on disk", () => {
		const store = new ToolGroupPolicyStore(tmpDir);
		store.setGroupPolicy("mcp__nano-banana", "never");
		// Builtin defaults register a different policy at boot — the user's
		// 'never' must still win on read because getAll() merges
		// `{ ...builtin, ...local }` (local last).
		store.setBuiltins({ "mcp__nano-banana": "ask" });
		assert.equal(store.getGroupPolicy("mcp__nano-banana"), "never");
	});

	it("clearing a user policy (null) reveals builtin default for that group", () => {
		const store = new ToolGroupPolicyStore(tmpDir);
		store.setBuiltins({ "Ask": "allow" });
		store.setGroupPolicy("Ask", "never");
		assert.equal(store.getGroupPolicy("Ask"), "never");
		store.setGroupPolicy("Ask", null);
		assert.equal(store.getGroupPolicy("Ask"), "allow");
	});

	it("returns null for a group with no builtin and no override", () => {
		const store = new ToolGroupPolicyStore(tmpDir);
		assert.equal(store.getGroupPolicy("group-that-does-not-exist"), null);
	});

	it("getAll merges builtins under user overrides", () => {
		const store = new ToolGroupPolicyStore(tmpDir);
		store.setBuiltins({ Ask: "allow", Filesystem: "allow" });
		store.setGroupPolicy("Ask", "ask");
		const all = store.getAll();
		assert.equal(all["Ask"], "ask");
		assert.equal(all["Filesystem"], "allow");
	});
});
