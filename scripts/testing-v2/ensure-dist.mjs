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
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const MANIFEST_SCHEMA = 1;
// Dist is mutated destructively by the build pipeline. The lock is deliberately
// worktree-local (rather than tmpdir/global) so distinct worktrees may build in
// parallel while concurrent browser/E2E coordinators in one worktree serialize.
const LOCK_DIR = [".profiles", "testing-v2"];
const LOCK_FILENAME = "ensure-dist-build.lock";
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10 * 60_000;
const LOCK_POLL_MS = 40;

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

/** The worktree-local mutex path. Exported to pin its isolation contract. */
export function distBuildLockPath(repoRoot = REPO_ROOT) {
	return join(resolve(repoRoot), ...LOCK_DIR, LOCK_FILENAME);
}

function sleepSync(ms) {
	if (ms <= 0) return;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** `EPERM` means the process exists but cannot be inspected. Works on Windows and POSIX. */
function pidAlive(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

function readLockOwner(lockPath) {
	try {
		const owner = JSON.parse(readFileSync(lockPath, "utf8"));
		return {
			pid: Number(owner?.pid),
			token: typeof owner?.token === "string" ? owner.token : "",
		};
	} catch {
		return { pid: 0, token: "" };
	}
}

/**
 * Recover only an old lock whose owner is demonstrably gone (or malformed).
 * The stale threshold protects a creator between O_EXCL creation and its owner
 * record write; PID liveness prevents a slow but live build being stolen.
 */
function recoverStaleLock(lockPath, staleMs) {
	try {
		const ageMs = Date.now() - statSync(lockPath).mtimeMs;
		const owner = readLockOwner(lockPath);
		if (ageMs < staleMs || pidAlive(owner.pid)) return false;
		// A competing reclaimer may have removed the stale file and published a
		// fresh owner while we inspected it. Recheck the nonce before deleting.
		const current = readLockOwner(lockPath);
		if (current.pid !== owner.pid || current.token !== owner.token) return false;
		unlinkSync(lockPath);
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return true;
		throw error;
	}
}

function acquireDistBuildLock(repoRoot, { staleMs = LOCK_STALE_MS, waitMs = LOCK_WAIT_MS, pollMs = LOCK_POLL_MS } = {}) {
	if (!Number.isFinite(staleMs) || staleMs < 0) throw new Error("[ensure-dist] lock staleMs must be a non-negative number");
	if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error("[ensure-dist] lock waitMs must be a non-negative number");
	if (!Number.isFinite(pollMs) || pollMs < 1) throw new Error("[ensure-dist] lock pollMs must be a positive number");
	const lockPath = distBuildLockPath(repoRoot);
	mkdirSync(dirname(lockPath), { recursive: true });
	const deadline = Date.now() + waitMs;
	const token = randomUUID();
	for (;;) {
		let fd;
		try {
			fd = openSync(lockPath, "wx");
			writeSync(fd, `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`);
			closeSync(fd);
			fd = undefined;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				// Never unlink a successor lock after our own lock has been recovered.
				if (readLockOwner(lockPath).token === token) {
					try { unlinkSync(lockPath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
				}
			};
		} catch (error) {
			if (fd !== undefined) closeSync(fd);
			// Windows can report delete-pending lock contention as EPERM/EACCES.
			const contended = error?.code === "EEXIST" || error?.code === "EPERM" || error?.code === "EACCES";
			if (!contended) throw error;
			recoverStaleLock(lockPath, staleMs);
			if (Date.now() >= deadline) {
				throw new Error(`[ensure-dist] timed out waiting for worktree build lock: ${lockPath}`);
			}
			sleepSync(pollMs);
		}
	}
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
 * otherwise serialize the destructive build per worktree and publish a fresh
 * manifest atomically. Revalidation after acquiring the mutex is essential:
 * waiters must consume the first builder's manifest, never rebuild it.
 *
 * `runBuild`, lock timings, and `beforeAcquireLock` are injectable solely for
 * deterministic fixtures; production uses the normal build command and
 * conservative dead-owner bounds.
 */
export function ensureDistBuild({
	repoRoot = REPO_ROOT,
	runBuild = () => execSync("npm run build", { cwd: repoRoot, stdio: "inherit" }),
	lockStaleMs,
	lockWaitMs,
	lockPollMs,
	beforeAcquireLock,
} = {}) {
	let key = computeDistBuildKey(repoRoot);
	if (validateDistBuild(repoRoot, key)) {
		console.log(`[ensure-dist] dist build cache hit: ${key}`);
		return { key, cacheHit: true };
	}

	beforeAcquireLock?.();
	const releaseLock = acquireDistBuildLock(repoRoot, {
		...(lockStaleMs === undefined ? {} : { staleMs: lockStaleMs }),
		...(lockWaitMs === undefined ? {} : { waitMs: lockWaitMs }),
		...(lockPollMs === undefined ? {} : { pollMs: lockPollMs }),
	});
	try {
		// Another coordinator may have completed the build while we waited.
		key = computeDistBuildKey(repoRoot);
		if (validateDistBuild(repoRoot, key)) {
			console.log(`[ensure-dist] dist build cache hit after lock: ${key}`);
			return { key, cacheHit: true };
		}
		console.log(`[ensure-dist] dist build cache miss (key ${key}); running npm run build...`);
		runBuild();
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
	} finally {
		releaseLock();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	ensureDistBuild();
}
