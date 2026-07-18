/**
 * Pins the content-addressed dist build cache (scripts/testing-v2/ensure-dist.mjs)
 * used by test:e2e:v2 and tests2/browser-global-setup.ts: changed build inputs
 * must change the key, and validation must fail closed on a missing/stale
 * manifest or missing build artifacts so a stale dist can never be silently
 * tested. Modeled on tests2/core/server-prebundle-cache.test.ts; uses a temp-dir
 * fixture and the pure functions only — never runs a real build.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { computeDistBuildKey, validateDistBuild } from "../../scripts/testing-v2/ensure-dist.mjs";

const BASE_FILES: Record<string, string> = {
	"src/server/cli.ts": "export const cli = 1;\n",
	"src/shared/value.ts": "export const value = 1;\n",
	"src/ui/app.ts": "export const app = 1;\n",
	"defaults/roles/basic.yaml": "name: basic\n",
	"market-packs/demo/pack.yaml": "name: demo\n",
	"market-packs/demo/src/panel.ts": "export const panel = 1;\n",
	"public/sw.js": "// sw\n",
	"index.html": "<html></html>\n",
	"package.json": '{"scripts":{"build":"noop"}}\n',
	"package-lock.json": "{}\n",
	"vite.config.ts": "export default {};\n",
	"tsconfig.json": "{}\n",
	"tsconfig.server.json": "{}\n",
	"scripts/copy-defaults.mjs": "// copy defaults\n",
	"scripts/copy-builtin-packs.mjs": "// copy builtin packs\n",
	"scripts/build-market-packs.mjs": "// build packs\n",
};

function writeRepoFile(root: string, relativeFile: string, content: string): void {
	const file = join(root, ...relativeFile.split("/"));
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

function writeFakeRepo(root: string): void {
	for (const [relativeFile, content] of Object.entries(BASE_FILES)) {
		writeRepoFile(root, relativeFile, content);
	}
}

function resetFakeRepo(root: string): void {
	writeFakeRepo(root);
}

/** Well-formed dist fixture: artifacts + manifest matching `key`. */
function writeDistFixture(root: string, key: string): void {
	writeRepoFile(root, "dist/server/cli.js", "#!/usr/bin/env node\n// cli\n");
	writeRepoFile(root, "dist/ui/index.html", "<html></html>\n");
	writeRepoFile(root, "dist/.build-manifest.json", `${JSON.stringify({ schema: 1, key, createdAt: new Date().toISOString() }, null, 2)}\n`);
}

let workspace: string;
let repoRoot: string;
let key: string;

beforeAll(() => {
	workspace = mkdtempSync(join(tmpdir(), "bobbit-ensure-dist-"));
	repoRoot = join(workspace, "repo");
	writeFakeRepo(repoRoot);
	key = computeDistBuildKey(repoRoot);
});

afterAll(() => {
	rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
});

describe.sequential("dist build cache key", () => {
	it("is deterministic for identical inputs", () => {
		assert.equal(computeDistBuildKey(repoRoot), key);
	});

	it("changes when any build input changes and ignores non-inputs", () => {
		try {
			const changedInputs: Array<[string, string]> = [
				["src/server/cli.ts", "export const cli = 2;\n"],
				["src/shared/value.ts", "export const value = 2;\n"],
				["defaults/roles/basic.yaml", "name: changed\n"],
				["market-packs/demo/src/panel.ts", "export const panel = 2;\n"],
				["public/sw.js", "// sw v2\n"],
				["index.html", "<html><body></body></html>\n"],
				["vite.config.ts", "export default { build: {} };\n"],
				["tsconfig.server.json", '{"compilerOptions":{}}\n'],
				["package-lock.json", '{"lockfileVersion":3}\n'],
				["scripts/copy-defaults.mjs", "// copy defaults v2\n"],
			];
			for (const [relativeFile, content] of changedInputs) {
				writeRepoFile(repoRoot, relativeFile, content);
				assert.notEqual(computeDistBuildKey(repoRoot), key, `${relativeFile} changes must change the key`);
				writeRepoFile(repoRoot, relativeFile, BASE_FILES[relativeFile]);
				assert.equal(computeDistBuildKey(repoRoot), key, `${relativeFile} restore must restore the key`);
			}

			// New files under input dirs are part of the key.
			writeRepoFile(repoRoot, "src/server/new-module.ts", "export const added = 1;\n");
			assert.notEqual(computeDistBuildKey(repoRoot), key, "added source files must change the key");
			rmSync(join(repoRoot, "src", "server", "new-module.ts"));
			assert.equal(computeDistBuildKey(repoRoot), key);

			// Files outside the build input set must not affect the key.
			writeRepoFile(repoRoot, "tests2/core/some.test.ts", "// not a build input\n");
			writeRepoFile(repoRoot, "README.md", "# not a build input\n");
			writeRepoFile(repoRoot, "src/node_modules/dep/index.js", "// skipped dir\n");
			assert.equal(computeDistBuildKey(repoRoot), key, "non-inputs must not balloon the content key");
		} finally {
			resetFakeRepo(repoRoot);
		}
	});
});

describe.sequential("dist build validation (fail-closed)", () => {
	it("fails on a missing manifest", () => {
		assert.equal(validateDistBuild(repoRoot, key), false, "no dist/ at all must not validate");
		writeRepoFile(repoRoot, "dist/server/cli.js", "// cli\n");
		writeRepoFile(repoRoot, "dist/ui/index.html", "<html></html>\n");
		assert.equal(validateDistBuild(repoRoot, key), false, "artifacts without a manifest must not validate");
		rmSync(join(repoRoot, "dist"), { recursive: true, force: true });
	});

	it("passes on a well-formed fixture and pins schema + key matching", () => {
		writeDistFixture(repoRoot, key);
		assert.equal(validateDistBuild(repoRoot, key), true, "well-formed manifest + artifacts must validate");

		assert.equal(validateDistBuild(repoRoot, "stale-key"), false, "wrong key must not validate");

		writeRepoFile(repoRoot, "dist/.build-manifest.json", `${JSON.stringify({ schema: 999, key }, null, 2)}\n`);
		assert.equal(validateDistBuild(repoRoot, key), false, "unknown schema must not validate");

		writeRepoFile(repoRoot, "dist/.build-manifest.json", "not json{");
		assert.equal(validateDistBuild(repoRoot, key), false, "corrupt manifest must fail closed");

		rmSync(join(repoRoot, "dist"), { recursive: true, force: true });
	});

	it("fails when a build artifact is missing despite a matching manifest", () => {
		writeDistFixture(repoRoot, key);
		rmSync(join(repoRoot, "dist", "server", "cli.js"));
		assert.equal(validateDistBuild(repoRoot, key), false, "missing dist/server/cli.js must not validate");

		writeDistFixture(repoRoot, key);
		rmSync(join(repoRoot, "dist", "ui", "index.html"));
		assert.equal(validateDistBuild(repoRoot, key), false, "missing dist/ui/index.html must not validate");

		rmSync(join(repoRoot, "dist"), { recursive: true, force: true });
	});
});
