/**
 * Persistent Playwright transform-cache seed/publish helpers (v2 browser runs).
 *
 * Playwright's transform cache (PWTEST_CACHE_DIR) is content-hashed per source
 * file, so reusing entries across runs is always safe. Per-run cache dirs exist
 * only to avoid cross-run WRITE races on shared machines. These helpers keep the
 * per-run write isolation but let runs warm-start:
 *
 *   - seedTransformCache(latestDir, runDir): copy the published `latest`
 *     snapshot into a fresh run dir before the run starts.
 *   - publishTransformCache(runDir, latestDir): after the run, copy the run dir
 *     to a pid-tagged temp sibling, then atomically rename it over `latest`.
 *     A concurrent publisher losing the rename race just discards its temp dir.
 *
 * Every step is fail-open: the cache is an optimization, never a correctness
 * dependency, so any FS error degrades to a cold cache rather than a failure.
 */
import { cpSync, existsSync, lstatSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Injectable fs seam for publishTransformCache — lets the unit test simulate a
 * concurrent publisher winning the rename race deterministically. Production
 * callers never pass this.
 */
export interface PublishFsOps {
	cpSync: typeof cpSync;
	rmSync: typeof rmSync;
	renameSync: typeof renameSync;
	existsSync: typeof existsSync;
	readdirSync: (dir: string) => unknown[];
}

const REAL_FS_OPS: PublishFsOps = { cpSync, rmSync, renameSync, existsSync, readdirSync };

/** Directory name of the shared v2 transform-cache namespace. */
export const V2_TRANSFORM_CACHE_SEGMENT = "pwtest-transform-cache-v2";

/** Published warm-start snapshot sibling of the per-run dirs. */
export const LATEST_SEGMENT = "latest";

/** `latest` snapshot path for a given per-run cache dir (its sibling). */
export function latestTransformCacheDir(runDir: string): string {
	return join(dirname(runDir), LATEST_SEGMENT);
}

/**
 * Seed a fresh per-run cache dir from the published `latest` snapshot.
 * Fail-open: partial copies are fine (entries are content-hashed), and any
 * error just means a cold start. Returns true when a seed copy was attempted
 * and completed without error.
 */
export function seedTransformCache(latestDir: string, runDir: string): boolean {
	try {
		if (!latestDir || !runDir || latestDir === runDir) return false;
		if (!existsSync(latestDir)) return false;
		// force:false + errorOnExist:false — never clobber files already written
		// into the run dir; silently skip collisions.
		cpSync(latestDir, runDir, { recursive: true, force: false, errorOnExist: false });
		return true;
	} catch (err) {
		// Partial copy is still a valid (smaller) warm start.
		console.log(`[pwtest-cache] transform-cache seed skipped (cold start): ${(err as Error)?.message ?? err}`);
		return false;
	}
}

function isWithin(root: string, candidate: string, allowRoot = false): boolean {
	const rel = relative(root, candidate);
	return (allowRoot && rel === "")
		|| (rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("../") && !rel.startsWith("..\\"));
}

/**
 * Resolve an existing cache directory only when both its declared and real
 * locations stay below the coordinator-owned root. Rejecting symlink entries
 * prevents a seemingly contained snapshot from retaining links back outside
 * the run root when copied to a follower.
 */
function containedCacheDirectory(containmentRoot: string, candidate: string): string | null {
	try {
		const declaredRoot = resolve(containmentRoot);
		const declaredCandidate = resolve(candidate);
		if (!isWithin(declaredRoot, declaredCandidate)) return null;
		const realRoot = realpathSync(declaredRoot);
		const realCandidate = realpathSync(declaredCandidate);
		if (!isWithin(realRoot, realCandidate) || !lstatSync(realCandidate).isDirectory()) return null;
		const pending = [realCandidate];
		while (pending.length > 0) {
			const directory = pending.pop()!;
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const entryPath = join(directory, entry.name);
				if (entry.isSymbolicLink()) return null;
				if (entry.isDirectory()) pending.push(entryPath);
			}
		}
		return realCandidate;
	} catch {
		return null;
	}
}

/** Validate a possibly absent publication path without following an escape. */
function containedCacheTarget(containmentRoot: string, candidate: string): string | null {
	try {
		const declaredRoot = resolve(containmentRoot);
		const declaredCandidate = resolve(candidate);
		if (!isWithin(declaredRoot, declaredCandidate)) return null;
		const realRoot = realpathSync(declaredRoot);
		const realParent = realpathSync(dirname(declaredCandidate));
		if (!isWithin(realRoot, realParent, true)) return null;
		if (existsSync(declaredCandidate)) {
			if (lstatSync(declaredCandidate).isSymbolicLink()) return null;
			const realCandidate = realpathSync(declaredCandidate);
			if (!isWithin(realRoot, realCandidate)) return null;
		}
		return declaredCandidate;
	} catch {
		return null;
	}
}

/**
 * Atomically publish an immutable transform-cache snapshot below one owned run
 * root. The source remains writable only by its process; followers never use
 * the published directory as PWTEST_CACHE_DIR. All validation/copy failures
 * are cache misses so test execution remains fail-open.
 */
export function publishContainedTransformCacheSnapshot(
	runDir: string,
	snapshotDir: string,
	containmentRoot: string,
	tag: string = String(process.pid),
): boolean {
	if (!runDir || !snapshotDir || !containmentRoot) return false;
	const containedRun = containedCacheDirectory(containmentRoot, runDir);
	const containedSnapshot = containedCacheTarget(containmentRoot, snapshotDir);
	if (!containedRun || !containedSnapshot || containedRun === containedSnapshot) return false;
	if (!/^[a-zA-Z0-9._-]+$/.test(tag)) return false;
	const temporarySnapshot = `${containedSnapshot}-${tag}-tmp`;
	if (!containedCacheTarget(containmentRoot, temporarySnapshot)) return false;
	try {
		// A killed publisher may leave its unique staging directory behind. It is
		// never a valid source and must not be merged into the next publication.
		rmSync(temporarySnapshot, { recursive: true, force: true });
	} catch {
		return false;
	}
	return publishTransformCache(containedRun, containedSnapshot, tag);
}

/**
 * Non-clobber seed an immutable contained snapshot into a follower's distinct,
 * process-owned writable cache directory. Symlink escapes and missing/partial
 * publications degrade to an independent cold cache.
 */
export function seedContainedTransformCacheSnapshot(
	snapshotDir: string,
	runDir: string,
	containmentRoot: string,
): boolean {
	if (!snapshotDir || !runDir || !containmentRoot) return false;
	const containedSnapshot = containedCacheDirectory(containmentRoot, snapshotDir);
	const containedRun = containedCacheDirectory(containmentRoot, runDir);
	if (!containedSnapshot || !containedRun || containedSnapshot === containedRun) return false;
	return seedTransformCache(containedSnapshot, containedRun);
}

/**
 * Publish a per-run cache dir as the new `latest` snapshot.
 *
 * Algorithm (each step fail-open):
 *   1. Skip when the run dir is missing or empty.
 *   2. cpSync(runDir -> `<latest>-<tag>-tmp`).
 *   3. rmSync(latest) then renameSync(tmp -> latest). rename is atomic on the
 *      same volume; a concurrent publisher that wins the race makes our rename
 *      fail, in which case we discard our tmp dir.
 *
 * Returns true only when `latest` was replaced by this call.
 */
export function publishTransformCache(
	runDir: string,
	latestDir: string,
	tag: string = String(process.pid),
	ops: Partial<PublishFsOps> = {},
): boolean {
	const fs = { ...REAL_FS_OPS, ...ops };
	if (!runDir || !latestDir || runDir === latestDir) return false;
	try {
		if (!fs.existsSync(runDir) || fs.readdirSync(runDir).length === 0) return false;
	} catch {
		return false;
	}
	const tmpDir = `${latestDir}-${tag}-tmp`;
	try {
		fs.cpSync(runDir, tmpDir, { recursive: true, force: true });
	} catch (err) {
		console.log(`[pwtest-cache] transform-cache publish skipped (copy failed): ${(err as Error)?.message ?? err}`);
		try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
		return false;
	}
	try { fs.rmSync(latestDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
	try {
		fs.renameSync(tmpDir, latestDir);
		return true;
	} catch {
		// A concurrent publisher won the rename race (or latest could not be
		// replaced). Their snapshot is equally warm — drop ours.
		try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
		return false;
	}
}

/**
 * Env-gated publish used by the v2 browser global teardown.
 *
 * Publishes only when this run OWNS its per-run cache dir
 * (BOBBIT_E2E_PWTEST_CACHE_OWNED === "1") and the dir lives inside the v2
 * transform-cache namespace. BOBBIT_KEEP_PWTEST_CACHE=1 keeps its existing
 * meaning (the per-run dir is not deleted by the legacy teardown) and does NOT
 * suppress publishing — a kept run dir is still a valid snapshot source.
 */
export function publishTransformCacheFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.BOBBIT_E2E_PWTEST_CACHE_OWNED !== "1") return false;
	const runDir = env.BOBBIT_V2_PWTEST_RUN_CACHE_ROOT?.trim() || env.BOBBIT_E2E_PWTEST_CACHE_DIR?.trim();
	if (!runDir) return false;
	// Only the v2 namespace participates; legacy per-run dirs are untouched.
	if (basename(dirname(runDir)) !== V2_TRANSFORM_CACHE_SEGMENT) return false;
	if (basename(runDir) === LATEST_SEGMENT) return false;
	return publishTransformCache(runDir, latestTransformCacheDir(runDir));
}

/**
 * Env-gated seed used by playwright-v2.config.ts after creating the run dir.
 * Seeds only dirs inside the v2 transform-cache namespace (never `latest`
 * itself, never externally-supplied cache dirs elsewhere on disk).
 */
export function seedTransformCacheForRunDir(runDir: string): boolean {
	if (!runDir) return false;
	if (basename(dirname(runDir)) !== V2_TRANSFORM_CACHE_SEGMENT) return false;
	if (basename(runDir) === LATEST_SEGMENT) return false;
	return seedTransformCache(latestTransformCacheDir(runDir), runDir);
}
