import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..", "..");
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 30_000;

function e2eTempRoot(): string {
	if (existsSync("/.dockerenv")) return "/tmp";
	return process.platform === "win32"
		? (process.env.BOBBIT_E2E_TMP_ROOT || "C:\\bobbit-e2e")
		: join(tmpdir(), "bobbit-e2e");
}

function lockDir(): string {
	const rootKey = PROJECT_ROOT.replace(/[^a-zA-Z0-9._-]/g, "-").slice(-80);
	return join(e2eTempRoot(), `.bobbit-dist-import-${rootKey}.lock`);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireDistImportLock(): Promise<() => void> {
	const dir = lockDir();
	const start = Date.now();
	for (;;) {
		try {
			mkdirSync(dir, { recursive: false });
			writeFileSync(join(dir, "owner.txt"), `${process.pid}\n${new Date().toISOString()}\n`);
			return () => {
				try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
			};
		} catch (err: any) {
			if (err?.code !== "EEXIST") throw err;
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
			if (Date.now() - start > LOCK_TIMEOUT_MS) {
				throw new Error(`Timed out waiting for dist/server import lock at ${dir}`);
			}
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
