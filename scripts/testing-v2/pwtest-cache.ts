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
import { cpSync, existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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
