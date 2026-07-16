/**
 * Content-addressed `npm run build` skip for the e2e/browser test tiers.
 *
 * `npm run test:e2e:v2` used to run `npm run build` unconditionally (~26s warm,
 * minutes cold) while tests2/browser-global-setup.ts only built dist when it was
 * MISSING — silently testing a stale build. Both now funnel through
 * ensureDistBuild(): a sha256 key over the full build input set is compared
 * against dist/.build-manifest.json; on match the build is skipped, on any
 * mismatch or manifest/validation error the build runs (fail-closed) and the
 * manifest is rewritten atomically.
 *
 * The input set mirrors package.json's `build` pipeline
 * (`build:packs` → `build:server` → `build:ui`):
 *   - build:packs  — market-packs/** sources + scripts/build-market-packs.mjs
 *   - build:server — src/** (tsconfig.server.json includes src/server + src/shared),
 *                    defaults/** (copy-defaults.mjs), market-packs/** again
 *                    (copy-builtin-packs.mjs), tsconfig.server.json
 *   - build:ui     — vite build: index.html, src/**, public/**, vite.config.ts,
 *                    tsconfig.json
 *   - shared       — package.json (the build scripts themselves),
 *                    package-lock.json (toolchain/deps), and this script.
 *
 * Pattern mirrors scripts/testing-v2/server-prebundle.mjs
 * (computeServerPrebundleKey / validateServerPrebundle).
 * Pinned by tests2/core/ensure-dist-build-key.test.ts.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const MANIFEST_SCHEMA = 1;

/** Directories walked recursively (every file participates in the key). */
const INPUT_DIRS = ["src", "defaults", "market-packs", "public"];
/** Individual input files (missing entries are skipped so fixture repos work). */
const INPUT_FILES = [
	"index.html",
	"package.json",
	"package-lock.json",
	"vite.config.ts",
	"tsconfig.json",
	"tsconfig.server.json",
	"scripts/copy-defaults.mjs",
	"scripts/copy-builtin-packs.mjs",
	"scripts/build-market-packs.mjs",
];
/** Never part of the build input set even when nested under an input dir. */
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".vite", ".git"]);

function toPosixPath(file) {
	return file.replace(/\\/g, "/");
}

function walkFiles(root) {
	const out = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (!SKIP_DIR_NAMES.has(entry.name)) walk(join(dir, entry.name));
			} else if (entry.isFile()) {
				out.push(join(dir, entry.name));
			}
		}
	};
	walk(root);
	return out;
}

/**
 * Content-addressed key over the full `npm run build` input set: sorted
 * repo-relative POSIX path + file bytes for every input, plus this script's own
 * source (so key-derivation changes invalidate cached builds).
 */
export function computeDistBuildKey(repoRoot = REPO_ROOT) {
	const files = [
		...INPUT_DIRS.map((dir) => join(repoRoot, dir)).filter(existsSync).flatMap(walkFiles),
		...INPUT_FILES.map((file) => join(repoRoot, ...file.split("/"))).filter(existsSync),
	]
		.map((file) => ({ file, key: toPosixPath(relative(repoRoot, file)) }))
		.sort((a, b) => a.key.localeCompare(b.key));
	const hash = createHash("sha256");
	for (const { file, key } of files) {
		hash.update(key);
		hash.update("\0");
		hash.update(readFileSync(file));
		hash.update("\0");
	}
	hash.update("__ensure-dist-self__");
	hash.update("\0");
	hash.update(readFileSync(fileURLToPath(import.meta.url)));
	return hash.digest("hex").slice(0, 24);
}

function manifestPathFor(repoRoot) {
	return join(repoRoot, "dist", ".build-manifest.json");
}

/**
 * Fail-closed validation: the manifest must parse, match schema + key, and the
 * critical build artifacts (dist/server/cli.js, dist/ui/index.html) must exist.
 * Any read/parse error means "rebuild".
 */
export function validateDistBuild(repoRoot, key) {
	try {
		const manifest = JSON.parse(readFileSync(manifestPathFor(repoRoot), "utf8"));
		if (manifest.schema !== MANIFEST_SCHEMA) return false;
		if (typeof manifest.key !== "string" || manifest.key.length === 0 || manifest.key !== key) return false;
		if (!existsSync(join(repoRoot, "dist", "server", "cli.js"))) return false;
		if (!existsSync(join(repoRoot, "dist", "ui", "index.html"))) return false;
		return true;
	} catch {
		return false;
	}
}

/**
 * Skip `npm run build` when dist already matches the current input key;
 * otherwise build and publish a fresh manifest atomically (write tmp + rename).
 */
export function ensureDistBuild({ repoRoot = REPO_ROOT } = {}) {
	const key = computeDistBuildKey(repoRoot);
	if (validateDistBuild(repoRoot, key)) {
		console.log(`[ensure-dist] dist build cache hit: ${key}`);
		return { key, cacheHit: true };
	}
	console.log(`[ensure-dist] dist build cache miss (key ${key}); running npm run build...`);
	execSync("npm run build", { cwd: repoRoot, stdio: "inherit" });
	// build:packs rewrites the committed market-packs bundles, which are part of
	// the input set — recompute so the manifest keys the POST-build inputs.
	const finalKey = computeDistBuildKey(repoRoot);
	for (const artifact of [join("dist", "server", "cli.js"), join("dist", "ui", "index.html")]) {
		if (!existsSync(join(repoRoot, artifact))) {
			throw new Error(`[ensure-dist] build completed but expected artifact is missing: ${artifact}`);
		}
	}
	const manifestPath = manifestPathFor(repoRoot);
	const tempPath = `${manifestPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	writeFileSync(tempPath, `${JSON.stringify({ schema: MANIFEST_SCHEMA, key: finalKey, createdAt: new Date().toISOString() }, null, 2)}\n`);
	try {
		rmSync(manifestPath, { force: true });
		renameSync(tempPath, manifestPath);
	} catch (error) {
		rmSync(tempPath, { force: true });
		throw error;
	}
	return { key: finalKey, cacheHit: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	ensureDistBuild();
}
