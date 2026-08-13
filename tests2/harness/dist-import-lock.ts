import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 30_000;

function e2eTempRoot(): string {
	// An explicit coordinator root is always owned. Do not replace it with
	// Docker's shared `/tmp`, or concurrent coordinators can remove this lock.
	if (process.env.BOBBIT_E2E_TMP_ROOT) return process.env.BOBBIT_E2E_TMP_ROOT;
	if (existsSync("/.dockerenv")) return "/tmp";
	return process.platform === "win32" ? "C:\\bobbit-e2e" : join(tmpdir(), "bobbit-e2e");
}

export function distServerImportLockPath(root = e2eTempRoot()): string {
	const rootKey = PROJECT_ROOT.replace(/[^a-zA-Z0-9._-]/g, "-").slice(-80);
	return join(root, `.bobbit-dist-import-${rootKey}.lock`);
}

/**
 * The coordinator owns the explicit root, but workers may load before its
 * compatibility parent exists. Create that parent without ever treating the
 * lock itself as recursive: `mkdir(lock, { recursive: false })` remains the
 * cross-process mutex.
 */
function ensureLockRoot(root: string): void {
	try {
		mkdirSync(root, { recursive: true });
	} catch (error: any) {
		// A file at the root is diagnosed below with a stable error. Other
		// filesystem failures (permissions, read-only roots) must remain loud.
		if (error?.code !== "EEXIST") throw error;
	}
	const info = statSync(root);
	if (!info.isDirectory())
		throw new Error(`dist/server import lock root must be a directory: ${root}`);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function acquireDistImportLock(): Promise<() => void> {
	const root = e2eTempRoot();
	const dir = distServerImportLockPath(root);
	const start = Date.now();
	for (;;) {
		try {
			ensureLockRoot(root);
			mkdirSync(dir, { recursive: false });
			writeFileSync(join(dir, "owner.txt"), `${process.pid}\n${new Date().toISOString()}\n`);
			return () => {
				try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
			};
		} catch (error: any) {
			// The root may be concurrently recreated by its coordinator. Retry the
			// full root validation/acquisition sequence instead of leaking ENOENT.
			if (error?.code === "ENOENT") {
				if (Date.now() - start > LOCK_TIMEOUT_MS)
					throw new Error(`Timed out creating dist/server import lock at ${dir}`);
				await delay(LOCK_WAIT_MS);
				continue;
			}
			if (error?.code !== "EEXIST") throw error;
			try {
				const ageMs = Date.now() - statSync(dir).mtimeMs;
				if (ageMs > LOCK_STALE_MS) {
					rmSync(dir, { recursive: true, force: true });
					continue;
				}
			} catch {
				rmSync(dir, { recursive: true, force: true });
				continue;
			}
			if (Date.now() - start > LOCK_TIMEOUT_MS)
				throw new Error(`Timed out waiting for dist/server import lock at ${dir}`);
			await delay(LOCK_WAIT_MS);
		}
	}
}

export async function withDistServerImportLock<T>(fn: () => Promise<T>): Promise<T> {
	const release = await acquireDistImportLock();
	try {
		return await fn();
	} finally {
		release();
	}
}
