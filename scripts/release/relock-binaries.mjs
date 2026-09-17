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
 * published name@version.
 *
 * `npm publish` returns before the registry read endpoint reflects the new
 * version, so a fetch immediately after publish can 404. This fetcher waits out
 * that propagation lag: it retries on 404, transient 5xx, and network errors
 * with exponential backoff, and only throws once the shared retry budget is
 * exhausted. The budget is shared across every package checked by one fetcher:
 * later packages have already been propagating while earlier checks wait.
 * Non-transient responses (other 4xx, e.g. 401/403) fail fast.
 *
 * @param {{ registry?: string, fetchImpl?: typeof fetch, retries?: number, delayMs?: number, maxDelayMs?: number, maxWaitMs?: number, sleep?: (ms: number) => Promise<void>, log?: (msg: string) => void }} [options]
 * @returns {(name: string, version: string) => Promise<{ tarball?: string, integrity?: string }>}
 */
export function registryFetchMeta({
	registry = "https://registry.npmjs.org",
	fetchImpl = fetch,
	retries = 21,
	delayMs = 1000,
	maxDelayMs = 120000,
	maxWaitMs = 30 * 60 * 1000,
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	log = (msg) => process.stderr.write(`${msg}\n`),
} = {}) {
	const base = registry.replace(/\/$/, "");
	let totalWaitMs = 0;
	return async (name, version) => {
		const url = `${base}/${name.replaceAll("/", "%2F")}/${version}`;
		let lastReason = "unknown";
		let attempts = 0;
		for (let attempt = 0; attempt <= retries; attempt += 1) {
			if (attempt > 0) {
				const remainingWaitMs = maxWaitMs - totalWaitMs;
				if (remainingWaitMs <= 0) break;
				const retryDelayMs = Math.min(delayMs * 2 ** (attempt - 1), maxDelayMs, remainingWaitMs);
				log(
					`  waiting for ${name}@${version} to become readable (${lastReason}); ` +
						`retry ${attempt}/${retries} in ${retryDelayMs / 1000}s…`,
				);
				totalWaitMs += retryDelayMs;
				await sleep(retryDelayMs);
			}
			attempts += 1;
			/** @type {Response} */
			let res;
			try {
				res = await fetchImpl(url, { headers: { accept: "application/json" } });
			} catch (err) {
				lastReason = `network error (${err instanceof Error ? err.message : String(err)})`;
				continue;
			}
			if (res.ok) {
				const body = /** @type {any} */ (await res.json());
				return { tarball: body?.dist?.tarball, integrity: body?.dist?.integrity };
			}
			if (res.status === 404) {
				lastReason = "not yet published (404)";
				continue;
			}
			if (res.status >= 500) {
				lastReason = `registry returned ${res.status}`;
				continue;
			}
			// Non-transient client error — no amount of waiting fixes it.
			throw new Error(`registry lookup for ${name}@${version} returned ${res.status}`);
		}
		const waited = Math.round(totalWaitMs / 1000);
		throw new Error(
			`${name}@${version} did not become readable on the registry after ~${waited}s of shared retry waits ` +
				`(${attempts} attempts for this package): ${lastReason}. If it was just published, propagation is ` +
				`unusually slow; otherwise confirm it published.`,
		);
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
