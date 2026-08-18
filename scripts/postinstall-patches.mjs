#!/usr/bin/env node
/**
 * Apply Bobbit's pinned dependency patches from the package that owns them.
 * npm may hoist Bobbit's Pi dependencies beside (rather than beneath) this
 * package in a consumer, so patch-package must run from that node_modules root.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const patchDirectory = join(packageRoot, "patches");
const piPackage = "@earendil-works/pi-agent-core";
const piPackageDir = (require.resolve.paths(piPackage) ?? [])
	.map(root => join(root, "@earendil-works", "pi-agent-core"))
	.find(candidate => existsSync(join(candidate, "package.json")));

if (!piPackageDir) {
	console.error("Bobbit patch prerequisite is unavailable: pi-agent-core is not installed.");
	process.exitCode = 1;
} else {
	const nodeModules = dirname(dirname(piPackageDir));
	const cwd = dirname(nodeModules);
	const result = spawnSync(process.execPath, [require.resolve("patch-package"), "--patch-dir", relative(cwd, patchDirectory)], {
		cwd,
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
}
