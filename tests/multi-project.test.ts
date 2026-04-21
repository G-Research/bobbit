/**
 * Unit tests for multi-project foundation classes:
 * - ProjectRegistry — CRUD, persistence, ensureDefaultProject
 * - ConfigResolver — resolveEntities, resolveScalarConfig, resolveConfig
 *
 * Search project_id filtering moved to tests/search/hybrid-query.spec.ts
 * (the new LanceDB-backed stack).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Set BOBBIT_DIR before any dynamic imports
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "multi-proj-test-"));
process.env.BOBBIT_DIR = tmpRoot;
fs.mkdirSync(path.join(tmpRoot, "state"), { recursive: true });
fs.mkdirSync(path.join(tmpRoot, "config"), { recursive: true });

const { ProjectRegistry } = await import("../src/server/agent/project-registry.ts");
const { resolveEntities, resolveScalarConfig, resolveConfig } = await import("../src/server/agent/config-resolver.ts");

after(() => {
	try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ok */ }
});

// ── ProjectRegistry ─────────────────────────────────────────────────

describe("ProjectRegistry", () => {
	let stateDir: string;

	/** Create a fresh state dir + project root for each test */
	function freshStateDir(): string {
		const dir = fs.mkdtempSync(path.join(tmpRoot, "state-"));
		return dir;
	}

	function freshProjectRoot(): string {
		const dir = fs.mkdtempSync(path.join(tmpRoot, "proj-"));
		return dir;
	}

	beforeEach(() => {
		stateDir = freshStateDir();
	});

	it("starts empty when no projects.json exists", () => {
		const reg = new ProjectRegistry(stateDir);
		assert.deepStrictEqual(reg.list(), []);
	});

	it("register creates a project and persists to disk", () => {
		const reg = new ProjectRegistry(stateDir);
		const root = freshProjectRoot();
		const proj = reg.register("my-project", root, { color: "#ff0000" });

		assert.ok(proj.id, "should have an id");
		assert.strictEqual(proj.name, "my-project");
		assert.strictEqual(proj.rootPath, root);
		assert.strictEqual(proj.color, "#ff0000");
		assert.strictEqual(proj.colorLight, "#ff0000");
		assert.strictEqual(proj.colorDark, "#ff0000");
		assert.ok(proj.createdAt > 0, "should have a timestamp");

		// Verify persisted
		const file = path.join(stateDir, "projects.json");
		assert.ok(fs.existsSync(file), "projects.json should exist");
		const data = JSON.parse(fs.readFileSync(file, "utf-8"));
		assert.strictEqual(data.length, 1);
		assert.strictEqual(data[0].name, "my-project");
	});

	it("register scaffolds .bobbit/config and .bobbit/state", () => {
		const reg = new ProjectRegistry(stateDir);
		const root = freshProjectRoot();
		reg.register("scaffolded", root);

		assert.ok(fs.existsSync(path.join(root, ".bobbit", "config")));
		assert.ok(fs.existsSync(path.join(root, ".bobbit", "state")));
	});

	it("register throws on relative rootPath", () => {
		const reg = new ProjectRegistry(stateDir);
		assert.throws(() => reg.register("bad", "relative/path"), /absolute/i);
	});

	it("register throws on non-existent rootPath", () => {
		const reg = new ProjectRegistry(stateDir);
		const bogus = path.join(tmpRoot, "does-not-exist-" + Date.now());
		assert.throws(() => reg.register("bad", bogus), /does not exist/i);
	});

	it("register throws on duplicate rootPath", () => {
		const reg = new ProjectRegistry(stateDir);
		const root = freshProjectRoot();
		reg.register("first", root);
		assert.throws(() => reg.register("second", root), /already registered/i);
	});

	it("get returns the registered project", () => {
		const reg = new ProjectRegistry(stateDir);
		const root = freshProjectRoot();
		const proj = reg.register("test", root);
		const found = reg.get(proj.id);
		assert.strictEqual(found?.id, proj.id);
		assert.strictEqual(found?.name, "test");
	});

	it("get returns undefined for unknown id", () => {
		const reg = new ProjectRegistry(stateDir);
		assert.strictEqual(reg.get("nonexistent"), undefined);
	});

	it("getByPath finds project by root path", () => {
		const reg = new ProjectRegistry(stateDir);
		const root = freshProjectRoot();
		const proj = reg.register("by-path", root);
		const found = reg.getByPath(root);
		assert.strictEqual(found?.id, proj.id);
	});

	it("getByPath returns undefined for unregistered path", () => {
		const reg = new ProjectRegistry(stateDir);
		assert.strictEqual(reg.getByPath("/nonexistent/path"), undefined);
	});

	it("list returns projects sorted by createdAt", async () => {
		const reg = new ProjectRegistry(stateDir);
		const root1 = freshProjectRoot();
		const proj1 = reg.register("alpha", root1);
		// Small delay to ensure different timestamps
		await new Promise(r => setTimeout(r, 10));
		const root2 = freshProjectRoot();
		const proj2 = reg.register("beta", root2);

		const list = reg.list();
		assert.strictEqual(list.length, 2);
		assert.strictEqual(list[0].id, proj1.id);
		assert.strictEqual(list[1].id, proj2.id);
	});

	it("update modifies name and color", () => {
		const reg = new ProjectRegistry(stateDir);
		const root = freshProjectRoot();
		const proj = reg.register("old-name", root);

		const updated = reg.update(proj.id, { name: "new-name", color: "#00ff00" });
		assert.strictEqual(updated.name, "new-name");
		assert.strictEqual(updated.color, "#00ff00");

		// Verify persisted
		const reg2 = new ProjectRegistry(stateDir);
		const reloaded = reg2.get(proj.id);
		assert.strictEqual(reloaded?.name, "new-name");
		assert.strictEqual(reloaded?.color, "#00ff00");
	});

	it("update throws for unknown id", () => {
		const reg = new ProjectRegistry(stateDir);
		assert.throws(() => reg.update("nonexistent", { name: "x" }), /not found/i);
	});

	it("remove deletes a project from registry", () => {
		const reg = new ProjectRegistry(stateDir);
		const root = freshProjectRoot();
		const proj = reg.register("to-remove", root);
		assert.strictEqual(reg.list().length, 1);

		reg.remove(proj.id);
		assert.strictEqual(reg.list().length, 0);
		assert.strictEqual(reg.get(proj.id), undefined);
	});

	it("remove throws for unknown id", () => {
		const reg = new ProjectRegistry(stateDir);
		assert.throws(() => reg.remove("nonexistent"), /not found/i);
	});

	it("save/load roundtrip preserves all fields", () => {
		const reg = new ProjectRegistry(stateDir);
		const root = freshProjectRoot();
		const proj = reg.register("roundtrip", root, { color: "#abcdef" });

		// Create a new instance to force reload
		const reg2 = new ProjectRegistry(stateDir);
		const loaded = reg2.get(proj.id);
		assert.ok(loaded);
		assert.strictEqual(loaded.name, "roundtrip");
		assert.strictEqual(loaded.rootPath, root);
		assert.strictEqual(loaded.color, "#abcdef");
		assert.strictEqual(loaded.colorLight, "#abcdef");
		assert.strictEqual(loaded.colorDark, "#abcdef");
		assert.strictEqual(loaded.createdAt, proj.createdAt);
	});

	// ensureDefaultProject() was removed as part of the "eliminate default project"
	// refactor — fresh installs now start with zero projects and the UI forces the
	// user through explicit Add Project. Tests previously here are superseded by
	// GR-09 (first-run zero-project UX) in tests/e2e/ui/stories-goal-routing.spec.ts.
});

// ── ConfigResolver ──────────────────────────────────────────────────

describe("ConfigResolver", () => {
	describe("resolveEntities", () => {
		it("merges entities from all tiers", () => {
			const global = [{ name: "a", value: 1 }, { name: "b", value: 2 }];
			const server = [{ name: "b", value: 20 }];
			const project = [{ name: "c", value: 30 }];

			const result = resolveEntities(global, server, project);
			assert.strictEqual(result.length, 3);

			const byName = new Map(result.map(r => [r.name, r]));
			assert.strictEqual(byName.get("a")?.scope, "global");
			assert.strictEqual((byName.get("a") as any).value, 1);
			assert.strictEqual(byName.get("b")?.scope, "server");
			assert.strictEqual((byName.get("b") as any).value, 20);
			assert.strictEqual(byName.get("c")?.scope, "project");
			assert.strictEqual((byName.get("c") as any).value, 30);
		});

		it("project overrides server overrides global", () => {
			const global = [{ name: "x", data: "g" }];
			const server = [{ name: "x", data: "s" }];
			const project = [{ name: "x", data: "p" }];

			const result = resolveEntities(global, server, project);
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].scope, "project");
			assert.strictEqual((result[0] as any).data, "p");
		});

		it("returns empty array for empty inputs", () => {
			assert.deepStrictEqual(resolveEntities([], [], []), []);
		});

		it("global-only entities are available", () => {
			const result = resolveEntities(
				[{ name: "only-global", v: true }],
				[],
				[],
			);
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].scope, "global");
		});
	});

	describe("resolveScalarConfig", () => {
		const makeStore = (data: Record<string, string>) => ({
			get: (key: string) => data[key],
		});

		it("project value wins", () => {
			const result = resolveScalarConfig(
				"build_command",
				makeStore({ build_command: "proj-build" }),
				makeStore({ build_command: "server-build" }),
				makeStore({ build_command: "global-build" }),
				{ build_command: "default-build" },
			);
			assert.strictEqual(result.value, "proj-build");
			assert.strictEqual(result.source, "project");
		});

		it("falls through to server when project is undefined", () => {
			const result = resolveScalarConfig(
				"test_command",
				makeStore({}),
				makeStore({ test_command: "server-test" }),
				makeStore({}),
				{},
			);
			assert.strictEqual(result.value, "server-test");
			assert.strictEqual(result.source, "server");
		});

		it("falls through to global when project and server are undefined", () => {
			const result = resolveScalarConfig(
				"key",
				makeStore({}),
				makeStore({}),
				makeStore({ key: "global-val" }),
				{},
			);
			assert.strictEqual(result.value, "global-val");
			assert.strictEqual(result.source, "global");
		});

		it("falls through to default when all tiers are undefined", () => {
			const result = resolveScalarConfig(
				"key",
				makeStore({}),
				makeStore({}),
				null,
				{ key: "default-val" },
			);
			assert.strictEqual(result.value, "default-val");
			assert.strictEqual(result.source, "default");
		});

		it("returns empty string when no tier has value and no default", () => {
			const result = resolveScalarConfig(
				"missing",
				makeStore({}),
				makeStore({}),
				null,
				{},
			);
			assert.strictEqual(result.value, "");
			assert.strictEqual(result.source, "default");
		});

		it("handles null globalConfig", () => {
			const result = resolveScalarConfig(
				"key",
				makeStore({}),
				makeStore({ key: "server" }),
				null,
				{},
			);
			assert.strictEqual(result.value, "server");
			assert.strictEqual(result.source, "server");
		});
	});

	describe("resolveConfig", () => {
		const makeCtx = (data: Record<string, string>) => ({
			projectConfigStore: { get: (key: string) => data[key] },
		});

		it("resolves through projectContext and serverContext", () => {
			const result = resolveConfig(
				"key",
				makeCtx({}),
				makeCtx({ key: "from-server" }),
				null,
				{ key: "fallback" },
			);
			assert.strictEqual(result.value, "from-server");
			assert.strictEqual(result.source, "server");
		});

		it("works with only projectContext", () => {
			const result = resolveConfig("key", makeCtx({ key: "proj" }));
			assert.strictEqual(result.value, "proj");
			assert.strictEqual(result.source, "project");
		});

		it("uses defaults when no context has the key", () => {
			const result = resolveConfig("key", makeCtx({}), undefined, null, { key: "def" });
			assert.strictEqual(result.value, "def");
			assert.strictEqual(result.source, "default");
		});
	});
});

