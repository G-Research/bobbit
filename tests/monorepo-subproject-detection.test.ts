/**
 * scanMonorepo — workspace-manifest detection for the project assistant.
 *
 * Covers pnpm, npm/yarn workspaces (array + object form), Nx, Turbo, Lerna,
 * Cargo workspaces, Go workspaces, Gradle multi-module, plus the empty / cap
 * cases.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { scanMonorepo, MAX_CANDIDATES } from "../src/server/agent/monorepo-scan.ts";

let root: string;

function w(p: string, body = ""): void {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, body);
}
function dir(p: string): void { fs.mkdirSync(p, { recursive: true }); }

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "monorepo-scan-test-"));
});

after(() => {
	try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("scanMonorepo", () => {
	it("pnpm-workspace.yaml with packages: ['packages/*'] expands to subdirs with package.json", () => {
		const r = path.join(root, "pnpm");
		dir(r);
		w(path.join(r, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
		w(path.join(r, "packages", "api", "package.json"), JSON.stringify({ name: "@acme/api" }));
		w(path.join(r, "packages", "web", "package.json"), JSON.stringify({ name: "@acme/web" }));
		// data-only dir without package.json should NOT appear.
		dir(path.join(r, "packages", "fixtures"));

		const out = scanMonorepo(r);
		assert.ok(out.frameworks.includes("pnpm"));
		const paths = out.candidates.map(c => c.relativePath).sort();
		assert.deepEqual(paths, ["packages/api", "packages/web"]);
		const api = out.candidates.find(c => c.relativePath === "packages/api")!;
		assert.equal(api.packageName, "@acme/api");
		assert.ok(api.frameworks.includes("pnpm"));
	});

	it("package.json workspaces array form", () => {
		const r = path.join(root, "npm-arr");
		dir(r);
		w(path.join(r, "package.json"), JSON.stringify({
			name: "root",
			workspaces: ["packages/*", "apps/*"],
		}));
		w(path.join(r, "packages", "lib", "package.json"), JSON.stringify({ name: "lib" }));
		w(path.join(r, "apps", "cli", "package.json"), JSON.stringify({ name: "cli" }));

		const out = scanMonorepo(r);
		assert.ok(out.frameworks.includes("npm-yarn-workspaces"));
		const paths = out.candidates.map(c => c.relativePath).sort();
		assert.deepEqual(paths, ["apps/cli", "packages/lib"]);
	});

	it("package.json workspaces object form (workspaces.packages)", () => {
		const r = path.join(root, "npm-obj");
		dir(r);
		w(path.join(r, "package.json"), JSON.stringify({
			name: "root",
			workspaces: { packages: ["modules/*"], nohoist: [] },
		}));
		w(path.join(r, "modules", "core", "package.json"), JSON.stringify({ name: "core" }));

		const out = scanMonorepo(r);
		assert.ok(out.frameworks.includes("npm-yarn-workspaces"));
		assert.deepEqual(out.candidates.map(c => c.relativePath), ["modules/core"]);
	});

	it("Cargo workspace with explicit members list", () => {
		const r = path.join(root, "cargo");
		dir(r);
		w(path.join(r, "Cargo.toml"), `[workspace]
members = [
  "crates/api",
  "crates/cli",
]
`);
		w(path.join(r, "crates", "api", "Cargo.toml"), `[package]\nname = "api"\n`);
		w(path.join(r, "crates", "cli", "Cargo.toml"), `[package]\nname = "cli"\n`);

		const out = scanMonorepo(r);
		assert.ok(out.frameworks.includes("cargo"));
		const paths = out.candidates.map(c => c.relativePath).sort();
		assert.deepEqual(paths, ["crates/api", "crates/cli"]);
	});

	it("nx.json present at root flags nx (and conventional layouts)", () => {
		const r = path.join(root, "nx");
		dir(r);
		w(path.join(r, "nx.json"), "{}");
		w(path.join(r, "apps", "web", "package.json"), JSON.stringify({ name: "web" }));
		w(path.join(r, "libs", "ui", "project.json"), JSON.stringify({ name: "ui" }));

		const out = scanMonorepo(r);
		assert.ok(out.frameworks.includes("nx"));
		const paths = out.candidates.map(c => c.relativePath).sort();
		assert.deepEqual(paths, ["apps/web", "libs/ui"]);
	});

	it("turbo.json present at root flags turbo", () => {
		const r = path.join(root, "turbo");
		dir(r);
		w(path.join(r, "turbo.json"), "{}");
		// Turbo on its own, no package.json workspaces -> still flag the framework.
		const out = scanMonorepo(r);
		assert.ok(out.frameworks.includes("turbo"));
	});

	it("lerna.json with packages list", () => {
		const r = path.join(root, "lerna");
		dir(r);
		w(path.join(r, "lerna.json"), JSON.stringify({ packages: ["packages/*"], version: "1.0.0" }));
		w(path.join(r, "packages", "a", "package.json"), JSON.stringify({ name: "a" }));
		const out = scanMonorepo(r);
		assert.ok(out.frameworks.includes("lerna"));
		assert.deepEqual(out.candidates.map(c => c.relativePath), ["packages/a"]);
	});

	it("go.work file with use directives", () => {
		const r = path.join(root, "go");
		dir(r);
		w(path.join(r, "go.work"), `go 1.22

use (
  ./api
  ./web
)
`);
		w(path.join(r, "api", "go.mod"), "module api\n");
		w(path.join(r, "web", "go.mod"), "module web\n");
		const out = scanMonorepo(r);
		assert.ok(out.frameworks.includes("go"));
		assert.deepEqual(out.candidates.map(c => c.relativePath).sort(), ["api", "web"]);
	});

	it("settings.gradle multi-module with include", () => {
		const r = path.join(root, "gradle");
		dir(r);
		w(path.join(r, "settings.gradle"), `rootProject.name = 'root'\ninclude ':app', ':lib'\n`);
		dir(path.join(r, "app"));
		dir(path.join(r, "lib"));
		const out = scanMonorepo(r);
		assert.ok(out.frameworks.includes("gradle"));
		assert.deepEqual(out.candidates.map(c => c.relativePath).sort(), ["app", "lib"]);
	});

	it("no workspace manifest → empty result", () => {
		const r = path.join(root, "plain");
		dir(r);
		w(path.join(r, "package.json"), JSON.stringify({ name: "plain", scripts: { build: "tsc" } }));
		const out = scanMonorepo(r);
		assert.deepEqual(out.frameworks, []);
		assert.deepEqual(out.candidates, []);
		assert.equal(out.truncated, false);
		assert.equal(out.totalCount, 0);
	});

	it("nonexistent path → empty result", () => {
		const out = scanMonorepo(path.join(root, "does-not-exist"));
		assert.deepEqual(out.candidates, []);
	});

	it("caps output at MAX_CANDIDATES with truncation marker", () => {
		const r = path.join(root, "huge");
		dir(r);
		w(path.join(r, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
		const N = MAX_CANDIDATES + 5;
		for (let i = 0; i < N; i++) {
			// Pad with leading zeros so alphabetical sort is stable.
			const name = `pkg-${String(i).padStart(3, "0")}`;
			w(path.join(r, "packages", name, "package.json"), JSON.stringify({ name }));
		}
		const out = scanMonorepo(r);
		assert.equal(out.totalCount, N);
		assert.equal(out.truncated, true);
		assert.equal(out.candidates.length, MAX_CANDIDATES);
		// Alphabetical truncation: keeps first MAX_CANDIDATES sorted entries.
		assert.equal(out.candidates[0].relativePath, "packages/pkg-000");
		assert.equal(out.candidates[MAX_CANDIDATES - 1].relativePath, `packages/pkg-${String(MAX_CANDIDATES - 1).padStart(3, "0")}`);
	});

	it("ignores skip-dirs (node_modules, dist) inside glob expansion", () => {
		const r = path.join(root, "skip");
		dir(r);
		w(path.join(r, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
		w(path.join(r, "packages", "real", "package.json"), JSON.stringify({ name: "real" }));
		// node_modules looks like a workspace package candidate but should be filtered.
		w(path.join(r, "packages", "node_modules", "package.json"), JSON.stringify({ name: "should-be-skipped" }));
		const out = scanMonorepo(r);
		const paths = out.candidates.map(c => c.relativePath);
		assert.deepEqual(paths, ["packages/real"]);
	});
});

describe("project-assistant prompts include monorepo guidance", () => {
	it("PROJECT_ASSISTANT_PROMPT mentions monorepo subprojects", async () => {
		const mod = await import("../src/server/agent/project-assistant.ts");
		assert.match(mod.PROJECT_ASSISTANT_PROMPT, /Monorepo subprojects/);
		assert.match(mod.PROJECT_ASSISTANT_PROMPT, /pnpm-workspace\.yaml/);
		assert.match(mod.PROJECT_ASSISTANT_PROMPT, /pnpm --filter/);
	});

	it("PROJECT_ASSISTANT_SCAFFOLDING_PROMPT mentions monorepo subprojects", async () => {
		const mod = await import("../src/server/agent/project-assistant.ts");
		assert.match(mod.PROJECT_ASSISTANT_SCAFFOLDING_PROMPT, /Monorepo subprojects/);
	});
});
