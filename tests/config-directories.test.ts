/**
 * Unit tests for config-directories.ts: parseCustomDirectories,
 * getAllConfigDirectories, saveCustomDirectories.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

const { parseCustomDirectories, getAllConfigDirectories, saveCustomDirectories } =
	await import("../src/server/agent/config-directories.ts");

type Store = Record<string, string>;

function mockStore(initial: Store = {}) {
	const store: Store = { ...initial };
	return {
		get(key: string) { return store[key]; },
		set(key: string, val: string) { store[key] = val; },
		remove(key: string) { delete store[key]; },
		_raw: store,
	};
}

// ── parseCustomDirectories ──────────────────────────────────────────

describe("parseCustomDirectories", () => {
	it("parses config_directories only", () => {
		const store = mockStore({
			config_directories: JSON.stringify([
				{ path: "/shared/tools", types: ["tools"] },
				{ path: "/team/skills", types: ["skills", "mcp"] },
			]),
		});
		const result = parseCustomDirectories(store);
		assert.equal(result.length, 2);
		assert.deepEqual(result[0].types, ["tools"]);
		assert.deepEqual(result[1].types, ["skills", "mcp"]);
	});

	it("parses skill_directories only (backward compat)", () => {
		const store = mockStore({
			skill_directories: JSON.stringify([
				{ path: "/legacy/skills" },
				{ path: "/other/skills" },
			]),
		});
		const result = parseCustomDirectories(store);
		assert.equal(result.length, 2);
		// skill_directories entries get types: ["skills"]
		assert.deepEqual(result[0].types, ["skills"]);
		assert.deepEqual(result[1].types, ["skills"]);
	});

	it("merges both keys — config_directories wins on path conflict", () => {
		const sharedPath = path.resolve("/shared/dir");
		const store = mockStore({
			skill_directories: JSON.stringify([
				{ path: sharedPath },
				{ path: "/only-in-skills" },
			]),
			config_directories: JSON.stringify([
				{ path: sharedPath, types: ["skills", "mcp", "tools"] },
			]),
		});
		const result = parseCustomDirectories(store);
		// Should have 2 entries: the merged one and the skills-only one
		assert.equal(result.length, 2);

		const merged = result.find(d => d.path === path.resolve(sharedPath));
		assert.ok(merged, "merged entry should exist");
		// config_directories wins — broader types
		assert.deepEqual(merged!.types, ["skills", "mcp", "tools"]);

		const skillsOnly = result.find(d => d.path === path.resolve("/only-in-skills"));
		assert.ok(skillsOnly, "skills-only entry should exist");
		assert.deepEqual(skillsOnly!.types, ["skills"]);
	});

	it("handles malformed JSON in config_directories gracefully", () => {
		const store = mockStore({
			config_directories: "not valid json{{{",
		});
		const result = parseCustomDirectories(store);
		assert.equal(result.length, 0);
	});

	it("handles malformed JSON in skill_directories gracefully", () => {
		const store = mockStore({
			skill_directories: "broken",
		});
		const result = parseCustomDirectories(store);
		assert.equal(result.length, 0);
	});

	it("returns empty when neither key is set", () => {
		const store = mockStore();
		const result = parseCustomDirectories(store);
		assert.equal(result.length, 0);
	});

	it("skips entries with empty path or missing types", () => {
		const store = mockStore({
			config_directories: JSON.stringify([
				{ path: "", types: ["skills"] },          // empty path
				{ path: "/valid", types: [] },            // empty types
				{ path: "  ", types: ["mcp"] },           // whitespace path
				{ path: "/ok", types: ["tools"] },        // valid
			]),
		});
		const result = parseCustomDirectories(store);
		assert.equal(result.length, 1);
		assert.equal(result[0].path, path.resolve("/ok"));
	});

	it("deduplicates by normalized path", () => {
		const store = mockStore({
			config_directories: JSON.stringify([
				{ path: "/some/path", types: ["skills"] },
				{ path: "/some/path", types: ["mcp"] },  // same path, later wins
			]),
		});
		const result = parseCustomDirectories(store);
		assert.equal(result.length, 1);
		// The second entry overwrites the first (Map behavior in iteration order)
		assert.deepEqual(result[0].types, ["mcp"]);
	});
});

// ── getAllConfigDirectories ──────────────────────────────────────────

describe("getAllConfigDirectories", () => {
	it("returns 13 built-in directories", () => {
		const store = mockStore();
		const cwd = "/fake/project";
		const result = getAllConfigDirectories(cwd, store);

		// Filter to only built-in (not custom)
		const builtIn = result.filter(d => d.scope !== "custom");
		assert.equal(builtIn.length, 13, `Expected 13 built-in dirs, got ${builtIn.length}`);

		// All built-ins are not removable
		for (const d of builtIn) {
			assert.equal(d.isRemovable, false, `Built-in ${d.path} should not be removable`);
		}
	});

	it("includes correct skill directories (5)", () => {
		const store = mockStore();
		const cwd = "/fake/project";
		const result = getAllConfigDirectories(cwd, store);
		const skillDirs = result.filter(d => d.types.includes("skills") && d.scope !== "custom");
		assert.equal(skillDirs.length, 5);
	});

	it("includes correct MCP directories (6)", () => {
		const store = mockStore();
		const cwd = "/fake/project";
		const result = getAllConfigDirectories(cwd, store);
		const mcpDirs = result.filter(d => d.types.includes("mcp") && d.scope !== "custom");
		assert.equal(mcpDirs.length, 6);
	});

	it("includes correct agents directory (1)", () => {
		const store = mockStore();
		const cwd = "/fake/project";
		const result = getAllConfigDirectories(cwd, store);
		const agentsDirs = result.filter(d => d.types.includes("agents") && d.scope !== "custom");
		assert.equal(agentsDirs.length, 1);
	});

	it("includes correct tools directory (1)", () => {
		const store = mockStore();
		const cwd = "/fake/project";
		const result = getAllConfigDirectories(cwd, store);
		const toolDirs = result.filter(d => d.types.includes("tools") && d.scope !== "custom");
		assert.equal(toolDirs.length, 1);
	});

	it("appends custom directories with isRemovable=true", () => {
		const store = mockStore({
			config_directories: JSON.stringify([
				{ path: "/custom/stuff", types: ["skills", "mcp"] },
			]),
		});
		const cwd = "/fake/project";
		const result = getAllConfigDirectories(cwd, store);
		const custom = result.filter(d => d.scope === "custom");
		assert.equal(custom.length, 1);
		assert.equal(custom[0].isRemovable, true);
		assert.deepEqual(custom[0].types, ["skills", "mcp"]);
	});

	it("has exists=boolean for each entry", () => {
		const store = mockStore();
		const result = getAllConfigDirectories("/fake/project", store);
		for (const d of result) {
			assert.equal(typeof d.exists, "boolean");
		}
	});

	it("user-scope dirs use home directory", () => {
		const store = mockStore();
		const result = getAllConfigDirectories("/fake/project", store);
		const userDirs = result.filter(d => d.scope === "user");
		const home = os.homedir();
		for (const d of userDirs) {
			assert.ok(
				d.path.startsWith(home) || d.path.startsWith(path.resolve(home)),
				`User dir ${d.path} should be under home ${home}`,
			);
		}
	});
});

// ── saveCustomDirectories ───────────────────────────────────────────

describe("saveCustomDirectories", () => {
	it("writes config_directories and removes skill_directories", () => {
		const store = mockStore({
			skill_directories: JSON.stringify([{ path: "/old" }]),
		});
		saveCustomDirectories(store, [
			{ path: "/new/dir", types: ["skills", "tools"] },
		]);

		// config_directories should be set
		const saved = JSON.parse(store._raw["config_directories"]);
		assert.equal(saved.length, 1);
		assert.equal(saved[0].path, "/new/dir");
		assert.deepEqual(saved[0].types, ["skills", "tools"]);

		// skill_directories should be removed
		assert.equal(store._raw["skill_directories"], undefined);
	});

	it("saves empty array", () => {
		const store = mockStore({
			skill_directories: JSON.stringify([{ path: "/old" }]),
			config_directories: JSON.stringify([{ path: "/existing", types: ["mcp"] }]),
		});
		saveCustomDirectories(store, []);

		const saved = JSON.parse(store._raw["config_directories"]);
		assert.deepEqual(saved, []);
		assert.equal(store._raw["skill_directories"], undefined);
	});
});
