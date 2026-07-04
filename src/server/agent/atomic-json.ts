/**
 * Shared crash-safe JSON persistence primitives.
 *
 * Extracted from the write discipline already used by `session-store.ts` /
 * `bg-process-store.ts` (tmp-write → fsync → rename, plus best-effort .bak
 * rotation). Those two stores keep their own copies because they also carry
 * an epoch/stale-snapshot-guard envelope that is specific to their multi-writer
 * concerns; the smaller durable stores (gate/team/task/inbox) don't need that
 * envelope, just the atomicity + backup-fallback discipline, so they share
 * these primitives instead of re-implementing (or worse, not implementing) it.
 *
 * See docs/debugging.md / CON-01 finding: a `fs.writeFileSync` straight to the
 * target path truncates the file before the new content is fully written: a
 * crash/kill mid-write leaves an empty or partial file, and the *next*
 * save() on a fresh in-memory (now-empty) load overwrites it, making the loss
 * permanent. Rename is atomic on the same filesystem, so readers only ever
 * see the fully-old or fully-new file — never a torn one.
 */
import fs from "node:fs";
import path from "node:path";

/** Backup-file path for generation `n` (1 = most recent). */
export function bakPath(file: string, n: number): string {
	return `${file}.bak.${n}`;
}

/**
 * Rotate `file` → `.bak.1` → `.bak.2` → … → `.bak.N`, dropping the oldest.
 * Best-effort: a failure here must never block the caller's save, so every
 * step is individually swallowed.
 */
export function rotateBackups(file: string, backups: number): void {
	if (backups <= 0) return;
	try {
		if (!fs.existsSync(file)) return;
		try {
			if (fs.existsSync(bakPath(file, backups))) fs.unlinkSync(bakPath(file, backups));
		} catch {
			/* non-fatal */
		}
		for (let i = backups - 1; i >= 1; i--) {
			try {
				if (fs.existsSync(bakPath(file, i))) {
					fs.renameSync(bakPath(file, i), bakPath(file, i + 1));
				}
			} catch {
				/* non-fatal */
			}
		}
		try {
			fs.copyFileSync(file, bakPath(file, 1));
		} catch {
			/* non-fatal */
		}
	} catch {
		// Backup failure must never block a save.
	}
}

/**
 * Write `data` as JSON to `file` using the crash-safe tmp-write + fsync +
 * rename pattern. Rotates up to `backups` `.bak.N` generations first
 * (best-effort, skipped when `backups` is 0). Throws on failure to write —
 * callers should catch and log (mirroring existing store `save()` methods),
 * and should clean up a stray `.tmp` on error.
 */
export function atomicWriteJsonSync(file: string, data: unknown, opts: { backups?: number } = {}): void {
	const dir = path.dirname(file);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	rotateBackups(file, opts.backups ?? 0);

	const json = JSON.stringify(data, null, 2);
	const tmp = `${file}.tmp`;
	try {
		const fd = fs.openSync(tmp, "w");
		try {
			fs.writeFileSync(fd, json, "utf-8");
			try {
				fs.fsyncSync(fd);
			} catch {
				/* fsync may fail on Windows network shares — non-fatal */
			}
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(tmp, file);
	} catch (err) {
		try {
			if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
		} catch {
			/* ignore */
		}
		throw err;
	}
}

/**
 * Read + parse JSON from `file`, falling back to the newest parseable
 * `.bak.N` (N = 1..backups) if the primary is missing, unreadable, or fails
 * to parse. Returns `undefined` if nothing parseable is found anywhere.
 *
 * Does not validate the parsed shape — callers own their own shape checks
 * (e.g. `Array.isArray`), matching existing store load() methods.
 */
export function loadJsonWithBackupFallback<T = unknown>(
	file: string,
	opts: { backups?: number; onBackupUsed?: (usedFile: string) => void } = {},
): T | undefined {
	const backups = opts.backups ?? 0;
	const candidates = [file];
	for (let i = 1; i <= backups; i++) candidates.push(bakPath(file, i));

	for (const candidate of candidates) {
		try {
			if (!fs.existsSync(candidate)) continue;
			const raw = fs.readFileSync(candidate, "utf-8");
			const parsed = JSON.parse(raw) as T;
			if (candidate !== file) opts.onBackupUsed?.(candidate);
			return parsed;
		} catch {
			continue;
		}
	}
	return undefined;
}
