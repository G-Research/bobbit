#!/usr/bin/env node
/**
 * Surgically re-lock the five per-platform binary sub-packages to a new version.
 *
 * The repo's `.npmrc` sets `package-lock=false` (via the legacy `shrinkwrap`
 * key) so a stray `npm install` cannot regenerate `package-lock.json` from
 * dependency-owned shrinkwraps. That freeze is deliberate — see `.npmrc` and
 * `docs/releasing.md`. This script is the sanctioned way to update the lock for
 * the binary sub-packages only: it rewrites the root `optionalDependencies`
 * pins and the matching `package-lock.json` entries (version + resolved URL +
 * integrity), pulling `resolved`/`integrity` straight from the published
 * package on the registry. Nothing else in the tree is touched.
 *
 * The packages MUST already be published at the target version — the registry
 * is the source of truth for the integrity hash, which cannot be known before
 * publish.
 *
 * Usage:
 *   node scripts/release/relock-binaries.mjs --version 0.9.1
 *   node scripts/release/relock-binaries.mjs --version 0.9.1 --dry-run
 *   node scripts/release/relock-binaries.mjs --version 0.9.1 --registry https://registry.npmjs.org
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isExactVersion } from "./dist-tag-guard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** Platform tuples we ship a binary sub-package for. Pinned by a unit test. */
export const BINARY_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"];

/** Published npm names for those tuples. */
export const BINARY_PACKAGES = BINARY_PLATFORMS.map((p) => `@gresearch/bobbit-binaries-${p}`);

/**
 * Build a registry metadata fetcher returning { tarball, integrity } for a
 * published name@version. Throws a clear error on 404 (not yet published).
 * @param {{ registry?: string, fetchImpl?: typeof fetch }} [options]
 * @returns {(name: string, version: string) => Promise<{ tarball?: string, integrity?: string }>}
 */
export function registryFetchMeta({ registry = "https://registry.npmjs.org", fetchImpl = fetch } = {}) {
	const base = registry.replace(/\/$/, "");
	return async (name, version) => {
		const url = `${base}/${name.replace("/", "%2f")}/${version}`;
		const res = await fetchImpl(url, { headers: { accept: "application/json" } });
		if (res.status === 404) {
			throw new Error(`${name}@${version} is not published (404) — publish it before re-locking`);
		}
		if (!res.ok) {
			throw new Error(`registry lookup for ${name}@${version} returned ${res.status}`);
		}
		const body = /** @type {any} */ (await res.json());
		return { tarball: body?.dist?.tarball, integrity: body?.dist?.integrity };
	};
}

/**
 * Pure core: mutate `packageJson` and `lockfile` in place so the binary
 * sub-packages point at `version`, using metadata from `fetchMeta`. Returns the
 * same objects plus the per-package results. No file or network I/O.
 *
 * @param {{
 *   packageJson: any,
 *   lockfile: any,
 *   version: string,
 *   fetchMeta: (name: string, version: string) => Promise<{ tarball?: string, integrity?: string }>,
 *   packages?: string[],
 * }} args
 */
export async function relockBinaries({ packageJson, lockfile, version, fetchMeta, packages = BINARY_PACKAGES }) {
	if (!isExactVersion(version)) throw new Error(`invalid version: ${version}`);

	const rootOpt = packageJson?.optionalDependencies;
	const lockRootOpt = lockfile?.packages?.[""]?.optionalDependencies;
	if (!rootOpt) throw new Error("package.json has no optionalDependencies");
	if (!lockRootOpt) throw new Error('package-lock.json has no packages[""].optionalDependencies');

	const results = [];
	for (const name of packages) {
		if (!(name in rootOpt)) throw new Error(`${name} is not in package.json optionalDependencies`);
		if (!(name in lockRootOpt)) throw new Error(`${name} is not in the lockfile root optionalDependencies`);
		const key = `node_modules/${name}`;
		const entry = lockfile.packages?.[key];
		if (!entry) throw new Error(`${key} is missing from package-lock.json packages`);

		const meta = await fetchMeta(name, version);
		if (typeof meta?.tarball !== "string" || typeof meta?.integrity !== "string") {
			throw new Error(`registry metadata for ${name}@${version} is missing tarball or integrity`);
		}

		rootOpt[name] = version;
		lockRootOpt[name] = version;
		entry.version = version;
		entry.resolved = meta.tarball;
		entry.integrity = meta.integrity;
		results.push({ name, version, resolved: meta.tarball, integrity: meta.integrity });
	}
	return { packageJson, lockfile, results };
}

/** @param {string[]} argv */
function parseArgs(argv) {
	/** @type {{ version: string | null, registry: string | undefined, dryRun: boolean }} */
	const out = { version: null, registry: undefined, dryRun: false };
	for (let i = 0; i < argv.length; i++) {
		switch (argv[i]) {
			case "--version":
				out.version = argv[++i];
				break;
			case "--registry":
				out.registry = argv[++i];
				break;
			case "--dry-run":
				out.dryRun = true;
				break;
			default:
				throw new Error(`Unknown arg: ${argv[i]}`);
		}
	}
	if (!out.version) throw new Error("Missing required --version <x.y.z>");
	return { version: out.version, registry: out.registry, dryRun: out.dryRun };
}

/** @param {string[]} argv */
async function main(argv) {
	const args = parseArgs(argv);
	const pkgPath = path.join(REPO_ROOT, "package.json");
	const lockPath = path.join(REPO_ROOT, "package-lock.json");
	const packageJson = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
	const lockfile = JSON.parse(fs.readFileSync(lockPath, "utf-8"));

	const { results } = await relockBinaries({
		packageJson,
		lockfile,
		version: args.version,
		fetchMeta: registryFetchMeta({ registry: args.registry }),
	});

	for (const r of results) {
		console.log(`  ${r.name}@${r.version}\n    resolved  ${r.resolved}\n    integrity ${r.integrity.slice(0, 24)}…`);
	}

	if (args.dryRun) {
		console.log("\n--dry-run: no files written.");
		return;
	}

	fs.writeFileSync(pkgPath, `${JSON.stringify(packageJson, null, 2)}\n`);
	fs.writeFileSync(lockPath, `${JSON.stringify(lockfile, null, 2)}\n`);
	console.log(`\nRe-locked ${results.length} binary sub-packages to ${args.version}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main(process.argv.slice(2)).catch((err) => {
		console.error("Fatal:", err.message);
		process.exit(1);
	});
}
