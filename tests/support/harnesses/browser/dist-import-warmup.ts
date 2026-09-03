import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	publishContainedTransformCacheSnapshot,
	seedContainedTransformCacheSnapshot,
} from "../../../../scripts/testing-v2/pwtest-cache.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..", "..", "..");
const READY_CONTENT = "dist-server-imports-ready-v1\n";
const LOCK_STALE_MS = 45_000;
const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 60_000;

export interface DistServerImportWarmupOptions {
	/** Test-only override; production uses a coordinator-owned directory. */
	stateDir?: string;
	/** Test-only overrides for modeling distinct Playwright process cache slots. */
	cacheDir?: string;
	containmentRoot?: string;
	staleMs?: number;
	waitMs?: number;
	timeoutMs?: number;
}

function e2eTempRoot(): string {
	// An explicit coordinator root is always owned. Do not replace it with
	// Docker's shared `/tmp`, or concurrent coordinators can remove this state.
	if (process.env.BOBBIT_E2E_TMP_ROOT) return process.env.BOBBIT_E2E_TMP_ROOT;
	if (existsSync("/.dockerenv")) return "/tmp";
	return process.platform === "win32" ? "C:\\bobbit-e2e" : join(tmpdir(), "bobbit-e2e");
}

function defaultStateDir(): string {
	const rootKey = PROJECT_ROOT.replace(/[^a-zA-Z0-9._-]/g, "-").slice(-80);
	return join(e2eTempRoot(), `.bobbit-dist-import-${rootKey}`);
}

function delay(ms: number): Promise<void> {
	return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

function removePath(path: string): void {
	try {
		rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	} catch {
		// Cleanup is best-effort. A ready marker lets waiters bypass a lock that
		// Windows still has open; failed warmups are recovered by stale-lock logic.
	}
}

function releaseLock(lockPath: string): void {
	const releasedPath = `${lockPath}.released-${process.pid}-${Date.now()}`;
	try {
		// Renaming first frees the well-known lock path atomically. This matters
		// after a failed warmup, where there is no ready marker for waiters to use
		// if Windows briefly retains a handle while recursive removal retries.
		renameSync(lockPath, releasedPath);
		removePath(releasedPath);
	} catch (error: any) {
		if (error?.code !== "ENOENT") removePath(lockPath);
	}
}

function isReady(path: string): boolean {
	try {
		return readFileSync(path, "utf8") === READY_CONTENT;
	} catch {
		return false;
	}
}

function publishReady(readyPath: string): void {
	const temporaryPath = `${readyPath}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(temporaryPath, READY_CONTENT, { flag: "wx" });
	try {
		// Only the lock owner publishes. Remove an invalid marker first because
		// rename-over-existing is not portable to Windows.
		removePath(readyPath);
		renameSync(temporaryPath, readyPath);
	} finally {
		removePath(temporaryPath);
	}
}

function recoverStaleLock(lockPath: string, staleMs: number): boolean {
	try {
		if (Date.now() - statSync(lockPath).mtimeMs <= staleMs) return false;
	} catch {
		return true;
	}

	// Rename before removal so two recoverers cannot delete a newly acquired
	// lock at the original path. The unique tombstone also avoids Windows rename
	// collisions between workers.
	const abandonedPath = `${lockPath}.stale-${process.pid}-${Date.now()}`;
	try {
		renameSync(lockPath, abandonedPath);
	} catch (error: any) {
		if (error?.code === "ENOENT") return true;
		return false;
	}
	removePath(abandonedPath);
	return true;
}

function cachePaths(stateDir: string, options: DistServerImportWarmupOptions): {
	cacheDir: string;
	containmentRoot: string;
	snapshotDir: string;
} | null {
	const cacheDir = options.cacheDir ?? process.env.PWTEST_CACHE_DIR?.trim();
	const containmentRoot = options.containmentRoot ?? process.env.BOBBIT_V2_RUN_ROOT?.trim();
	if (!cacheDir || !containmentRoot) return null;
	return { cacheDir, containmentRoot, snapshotDir: `${stateDir}.pwtest-cache-snapshot` };
}

function seedFollowerCache(stateDir: string, options: DistServerImportWarmupOptions): boolean {
	const paths = cachePaths(stateDir, options);
	if (!paths) return false;
	return seedContainedTransformCacheSnapshot(paths.snapshotDir, paths.cacheDir, paths.containmentRoot);
}

function publishOwnerCache(stateDir: string, options: DistServerImportWarmupOptions): boolean {
	const paths = cachePaths(stateDir, options);
	if (!paths) return false;
	return publishContainedTransformCacheSnapshot(paths.cacheDir, paths.snapshotDir, paths.containmentRoot);
}

/**
 * Let exactly one worker populate its PID-isolated Playwright transform cache
 * before any siblings import dist/server. The owner publishes an immutable,
 * contained snapshot before readiness. Each released follower non-clobber
 * seeds that snapshot into its own writable PID slot, then imports concurrently.
 */
export async function withDistServerImportWarmup<T>(
	importDistServer: () => Promise<T>,
	options: DistServerImportWarmupOptions = {},
): Promise<T> {
	const stateDir = options.stateDir ?? defaultStateDir();
	const lockPath = `${stateDir}.lock`;
	const readyPath = `${stateDir}.ready`;
	const staleMs = options.staleMs ?? LOCK_STALE_MS;
	const waitMs = options.waitMs ?? LOCK_WAIT_MS;
	const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
	mkdirSync(dirname(stateDir), { recursive: true });

	if (isReady(readyPath)) {
		seedFollowerCache(stateDir, options);
		return importDistServer();
	}

	const startedAt = Date.now();
	for (;;) {
		let acquired = false;
		try {
			mkdirSync(lockPath, { recursive: false });
			acquired = true;
		} catch (error: any) {
			if (error?.code !== "EEXIST") throw error;
		}

		if (acquired) {
			try {
				writeFileSync(join(lockPath, "owner.txt"), `${process.pid}\n${new Date().toISOString()}\n`);
				// Recheck after acquisition: a prior owner may have published readiness
				// while this worker was contending for the lock.
				if (isReady(readyPath)) {
					seedFollowerCache(stateDir, options);
					return await importDistServer();
				}
				const result = await importDistServer();
				// Cache publication is optional and fail-open. Readiness is published
				// only afterwards, so no follower can observe a partial snapshot.
				publishOwnerCache(stateDir, options);
				publishReady(readyPath);
				return result;
			} finally {
				releaseLock(lockPath);
			}
		}

		if (isReady(readyPath)) {
			seedFollowerCache(stateDir, options);
			return importDistServer();
		}
		if (recoverStaleLock(lockPath, staleMs)) continue;
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error(`Timed out waiting for dist/server import warmup at ${lockPath}`);
		}
		await delay(waitMs);
	}
}
