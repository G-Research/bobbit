/**
 * repo-scan.ts — multi-repo / monorepo / data-only detection.
 *
 * See docs/design/multi-repo-components.md §2.2.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { scanRepos } from "../src/server/agent/repo-scan.ts";

let root: string;

function w(p: string, body = ""): void {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, body);
}
function dir(p: string): void { fs.mkdirSync(p, { recursive: true }); }

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "repo-scan-test-"));
});

after(() => {
	try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("scanRepos", () => {
	it("single-repo: rootPath itself has .git", async () => {
		const dirPath = path.join(root, "single");
		dir(path.join(dirPath, ".git"));
		w(path.join(dirPath, "package.json"), JSON.stringify({ scripts: { build: "tsc", test: "vitest" } }));

		const out = await scanRepos(dirPath);
		assert.equal(out.length, 1);
		assert.equal(out[0].folder, ".");
		assert.equal(out[0].hasGit, true);
		assert.equal(out[0].detectedCommands.build, "npm run build");
		assert.equal(out[0].detectedCommands.test, "npm run test");
	});

	it("multi-repo: rootPath has no .git, two children do", async () => {
		const dirPath = path.join(root, "multi");
		dir(path.join(dirPath, "api", ".git"));
		dir(path.join(dirPath, "web", ".git"));
		w(path.join(dirPath, "api", "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
		w(path.join(dirPath, "web", "package.json"), JSON.stringify({ scripts: { build: "vite build" } }));

		const out = await scanRepos(dirPath);
		const folders = out.map(r => r.folder).sort();
		assert.deepEqual(folders, ["api", "web"]);
		assert.ok(out.every(r => r.hasGit));
	});

	it("monorepo: root has .git, children carry manifests but no .git", async () => {
		const dirPath = path.join(root, "mono");
		dir(path.join(dirPath, ".git"));
		w(path.join(dirPath, "package.json"), JSON.stringify({ scripts: { build: "lerna build" } }));
		w(path.join(dirPath, "packages", "a", "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
		// Subdir without .git but with manifest is NOT auto-emitted when root already has .git.
		const out = await scanRepos(dirPath);
		assert.ok(out.some(r => r.folder === "."));
		// `packages` is one level deep so it's scanned, but it's a container with no manifest.
		// We expect only `.`.
		assert.equal(out.length, 1);
	});

	it("pyproject.toml [tool.poetry.scripts]", async () => {
		const dirPath = path.join(root, "py");
		dir(path.join(dirPath, ".git"));
		w(path.join(dirPath, "pyproject.toml"), `
[tool.poetry.scripts]
serve = "myapp.cli:main"
test = "pytest"
`);
		const out = await scanRepos(dirPath);
		assert.equal(out[0].detectedCommands.serve, "myapp.cli:main");
		assert.equal(out[0].detectedCommands.test, "pytest");
	});

	it("Cargo.toml [[bin]] entries", async () => {
		const dirPath = path.join(root, "rs");
		dir(path.join(dirPath, ".git"));
		w(path.join(dirPath, "Cargo.toml"), `
[package]
name = "myapp"

[[bin]]
name = "myapp"
path = "src/main.rs"

[[bin]]
name = "helper"
path = "src/bin/helper.rs"
`);
		const out = await scanRepos(dirPath);
		assert.equal(out[0].detectedCommands.myapp, "cargo run --bin myapp");
		assert.equal(out[0].detectedCommands.helper, "cargo run --bin helper");
	});

	it("data-only: subdir with .git but no manifest", async () => {
		const dirPath = path.join(root, "data");
		dir(path.join(dirPath, "shared", ".git"));
		// no package.json
		const out = await scanRepos(dirPath);
		assert.deepEqual(out.map(r => r.folder), ["shared"]);
		assert.equal(Object.keys(out[0].detectedCommands).length, 0);
	});

	it("skips node_modules and dotfiles", async () => {
		const dirPath = path.join(root, "skip");
		dir(path.join(dirPath, ".git"));
		dir(path.join(dirPath, "node_modules", "x", ".git"));
		dir(path.join(dirPath, ".vscode"));
		const out = await scanRepos(dirPath);
		assert.deepEqual(out.map(r => r.folder), ["."]);
	});
});
