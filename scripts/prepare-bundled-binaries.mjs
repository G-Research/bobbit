#!/usr/bin/env node
/**
 * Prepare every platform binary package for `npm pack`.
 *
 * Optional dependencies with restrictive os/cpu fields are pruned by npm on
 * the release host. Root Bobbit bundles those packages, so prepack must stage
 * all five local packages explicitly instead of accidentally publishing only
 * the release host's binary. The release build has already populated bin/;
 * fail closed if it did not, rather than publishing a broken host tool.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packages = [
	"binaries-darwin-arm64",
	"binaries-darwin-x64",
	"binaries-linux-arm64",
	"binaries-linux-x64",
	"binaries-win32-x64",
];

for (const name of packages) {
	const source = path.join(root, "binaries", name);
	const windows = name.startsWith("binaries-win32-");
	const extension = windows ? ".exe" : "";
	for (const binary of ["fd", "rg", "ast-grep"]) {
		const candidate = path.join(source, "bin", `${binary}${extension}`);
		if (!fs.existsSync(candidate)) {
			throw new Error(`Missing ${path.relative(root, candidate)}. Run npm run build:binaries before npm pack.`);
		}
	}

	const destination = path.join(root, "node_modules", "@bobbit", name);
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	fs.rmSync(destination, { recursive: true, force: true });
	// Directory junctions are the portable Windows equivalent of a directory symlink.
	fs.symlinkSync(source, destination, process.platform === "win32" ? "junction" : "dir");
}
