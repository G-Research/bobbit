#!/usr/bin/env node
/**
 * Build per-platform binary sub-packages for Bobbit.
 *
 * Maintainer-run, NOT executed on `npm install`. Downloads fd and ripgrep
 * release archives for every supported platform, verifies SHA-256, extracts
 * the binaries into `binaries/binaries-<plat>-<arch>/bin/`, and bumps each
 * sub-package's version to match the root package.
 *
 * Inputs:
 *   - binaries.versions.json — pinned fd / ripgrep versions
 *   - binaries.checksums.json (optional) — { "<assetName>": "<sha256>" }
 *
 * Asset-naming logic mirrors @mariozechner/pi-coding-agent's tools-manager
 * (proven mapping). See docs/releasing.md.
 *
 * Usage:
 *   node scripts/build-binaries.mjs                  # use pinned versions
 *   node scripts/build-binaries.mjs --fd 10.2.0      # override fd
 *   node scripts/build-binaries.mjs --rg 14.1.1      # override ripgrep
 *   node scripts/build-binaries.mjs --only linux-x64 # single target
 *
 * After running, the script prints the suggested `npm publish` commands
 * for the maintainer to review and run.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const BIN_PKG_ROOT = path.join(REPO_ROOT, "binaries");
const VERSIONS_PATH = path.join(REPO_ROOT, "binaries.versions.json");
const CHECKSUMS_PATH = path.join(REPO_ROOT, "binaries.checksums.json");

const ROOT_PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"));

const TARGETS = [
	{ pkg: "binaries-darwin-arm64", plat: "darwin", arch: "arm64" },
	{ pkg: "binaries-darwin-x64", plat: "darwin", arch: "x64" },
	{ pkg: "binaries-linux-x64", plat: "linux", arch: "x64" },
	{ pkg: "binaries-linux-arm64", plat: "linux", arch: "arm64" },
	{ pkg: "binaries-win32-x64", plat: "win32", arch: "x64" },
];

/** Asset name resolvers — copied verbatim from pi-coding-agent's tools-manager. */
const TOOLS = {
	fd: {
		repo: "sharkdp/fd",
		binary: "fd",
		tagPrefix: "v",
		assetName: (version, plat, arch) => {
			if (plat === "darwin") {
				const a = arch === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${a}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				const a = arch === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${a}-unknown-linux-gnu.tar.gz`;
			} else if (plat === "win32") {
				const a = arch === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${a}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
	rg: {
		repo: "BurntSushi/ripgrep",
		binary: "rg",
		tagPrefix: "",
		assetName: (version, plat, arch) => {
			if (plat === "darwin") {
				const a = arch === "arm64" ? "aarch64" : "x86_64";
				return `ripgrep-${version}-${a}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				if (arch === "arm64") {
					return `ripgrep-${version}-aarch64-unknown-linux-gnu.tar.gz`;
				}
				// Design: ship glibc for linux-x64. ripgrep doesn't publish a gnu x86_64 asset
				// in every release — the musl build is statically linked and works on glibc
				// hosts too, so we use it as the linux-x64 binary. Documented in docs/releasing.md.
				return `ripgrep-${version}-x86_64-unknown-linux-musl.tar.gz`;
			} else if (plat === "win32") {
				const a = arch === "arm64" ? "aarch64" : "x86_64";
				return `ripgrep-${version}-${a}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
};

function parseArgs(argv) {
	const out = { fd: null, rg: null, only: null };
	for (let i = 0; i < argv.length; i++) {
		switch (argv[i]) {
			case "--fd":
				out.fd = argv[++i];
				break;
			case "--rg":
			case "--ripgrep":
				out.rg = argv[++i];
				break;
			case "--only":
				out.only = argv[++i];
				break;
			default:
				console.error(`Unknown arg: ${argv[i]}`);
				process.exit(2);
		}
	}
	return out;
}

function loadJson(p, fallback) {
	if (!fs.existsSync(p)) return fallback;
	return JSON.parse(fs.readFileSync(p, "utf-8"));
}

async function download(url, dest) {
	console.log(`  → ${url}`);
	const res = await fetch(url, { redirect: "follow" });
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

function sha256(file) {
	const hash = crypto.createHash("sha256");
	hash.update(fs.readFileSync(file));
	return hash.digest("hex");
}

function extract(archive, destDir) {
	fs.mkdirSync(destDir, { recursive: true });
	if (archive.endsWith(".tar.gz")) {
		const r = spawnSync("tar", ["xzf", archive, "-C", destDir], { stdio: "inherit" });
		if (r.status !== 0) throw new Error(`tar failed for ${archive}`);
	} else if (archive.endsWith(".zip")) {
		// Use system unzip; on Windows fall back to PowerShell Expand-Archive.
		const r = spawnSync("unzip", ["-q", "-o", archive, "-d", destDir], { stdio: "inherit" });
		if (r.status !== 0) {
			const ps = spawnSync(
				"powershell.exe",
				["-Command", `Expand-Archive -Force -Path '${archive}' -DestinationPath '${destDir}'`],
				{ stdio: "inherit" },
			);
			if (ps.status !== 0) throw new Error(`extract failed for ${archive}`);
		}
	} else {
		throw new Error(`unsupported archive: ${archive}`);
	}
}

function findBinary(rootDir, name) {
	const stack = [rootDir];
	while (stack.length) {
		const cur = stack.pop();
		for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
			const full = path.join(cur, entry.name);
			if (entry.isFile() && entry.name === name) return full;
			if (entry.isDirectory()) stack.push(full);
		}
	}
	return null;
}

async function buildOne(target, versions, checksums) {
	console.log(`\n=== ${target.pkg} (${target.plat}/${target.arch}) ===`);
	const pkgDir = path.join(BIN_PKG_ROOT, target.pkg);
	const binDir = path.join(pkgDir, "bin");
	fs.mkdirSync(binDir, { recursive: true });

	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `bobbit-bin-${target.pkg}-`));
	try {
		for (const [tool, cfg] of Object.entries(TOOLS)) {
			const version = tool === "fd" ? versions.fd : versions.ripgrep;
			const asset = cfg.assetName(version, target.plat, target.arch);
			if (!asset) {
				console.warn(`  (skip ${tool}: no asset for ${target.plat}/${target.arch})`);
				continue;
			}
			const url = `https://github.com/${cfg.repo}/releases/download/${cfg.tagPrefix}${version}/${asset}`;
			const archivePath = path.join(tmpRoot, asset);
			await download(url, archivePath);

			const expectedSha = checksums?.[asset];
			const actualSha = sha256(archivePath);
			if (expectedSha) {
				if (expectedSha !== actualSha) {
					throw new Error(`SHA-256 mismatch for ${asset}: expected ${expectedSha}, got ${actualSha}`);
				}
				console.log(`  ✓ sha256 ${actualSha.slice(0, 12)}…`);
			} else {
				console.log(`  · sha256 ${actualSha} (no pinned checksum — add to binaries.checksums.json)`);
			}

			const extractDir = path.join(tmpRoot, `extract_${tool}`);
			extract(archivePath, extractDir);

			const binaryName = cfg.binary + (target.plat === "win32" ? ".exe" : "");
			const found = findBinary(extractDir, binaryName);
			if (!found) throw new Error(`binary ${binaryName} not found in ${asset}`);
			const destBinary = path.join(binDir, binaryName);
			fs.copyFileSync(found, destBinary);
			if (target.plat !== "win32") fs.chmodSync(destBinary, 0o755);
			console.log(`  → ${path.relative(REPO_ROOT, destBinary)}`);
		}

		// Bump version to match root.
		const subPkgPath = path.join(pkgDir, "package.json");
		const sub = JSON.parse(fs.readFileSync(subPkgPath, "utf-8"));
		sub.version = ROOT_PKG.version;
		fs.writeFileSync(subPkgPath, JSON.stringify(sub, null, 2) + "\n");
		console.log(`  version → ${ROOT_PKG.version}`);
	} finally {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const pinned = loadJson(VERSIONS_PATH, { fd: null, ripgrep: null });
	const versions = {
		fd: args.fd ?? pinned.fd,
		ripgrep: args.rg ?? pinned.ripgrep,
	};
	if (!versions.fd || !versions.ripgrep) {
		console.error("Missing pinned versions. Edit binaries.versions.json or pass --fd / --rg.");
		process.exit(2);
	}
	const checksums = loadJson(CHECKSUMS_PATH, null);
	console.log(`Building fd ${versions.fd}, ripgrep ${versions.ripgrep}`);

	const targets = args.only
		? TARGETS.filter((t) => t.pkg === `binaries-${args.only}`)
		: TARGETS;
	if (targets.length === 0) {
		console.error(`No targets matched --only ${args.only}`);
		process.exit(2);
	}

	for (const t of targets) {
		await buildOne(t, versions, checksums);
	}

	console.log("\nDone. To publish:");
	for (const t of targets) {
		console.log(`  npm publish --access public ./binaries/${t.pkg}`);
	}
	console.log(
		"\nReview each sub-package, then run the commands above. Make sure you're\n" +
			"logged in (`npm whoami`) and the @bobbit scope exists.",
	);
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
