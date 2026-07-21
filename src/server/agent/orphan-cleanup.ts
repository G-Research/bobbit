/**
 * Orphan-cleanup gate + agent-CLI orphan-transcript scanner.
 *
 * Extracted out of session-manager.ts so unit tests can exercise the helpers
 * without paying the transitive cost (and runtime hazards) of importing the
 * full SessionManager. Pinned by tests2/core/session-manager-orphan-keep.test.ts.
 *
 * See goal `goal-goal-sessions-p-14dc3ec7` and the design doc
 * `docs/design/session-store-crash-safety.md` for context.
 */
import fs, { type Dirent } from "node:fs";
import path from "node:path";
import type { Clock, FsLike } from "../gateway-deps.js";
import { realClock, realFs } from "../gateway-deps.js";
import { BACKGROUND_IO_CONCURRENCY } from "./bounded-async-work.js";
import type { PersistedSession } from "./session-store.js";

const RECENT_TRANSCRIPT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface OrphanPreservationOptions {
	/** Promise-only filesystem boundary for deterministic policy tests. */
	fsImpl?: { promises: Pick<FsLike["promises"], "access" | "stat"> };
	clock?: Pick<Clock, "now">;
}

/**
 * Should we keep an otherwise-orphaned session live?
 *
 * Returns true when both:
 *   - the session's worktree directory still exists on disk, AND
 *   - the agent JSONL was written within the last 24 h.
 *
 * The boot/restore archive sweeps consult this gate before calling
 * `SessionStore.archive()`. The historical bug (goal sessions-p-14dc3ec7,
 * 2026-05-09) bulk-archived 9 actively-running sessions whose worktrees
 * and transcripts were healthy because `sessions.json` had silently rolled
 * back. Applying this gate makes the archive sweep refuse to garbage-
 * collect anything that still has a live worktree + recent transcript —
 * the user can still archive manually from the UI if they really are dead.
 *
 * Sandboxed sessions: their `worktreePath` is a container-internal path,
 * so the host filesystem access check fails and the gate naturally falls
 * through. That's correct — sandbox health is checked elsewhere.
 */
export async function shouldKeepDespiteOrphan(
	ps: PersistedSession,
	opts: OrphanPreservationOptions = {},
): Promise<boolean> {
	if (!ps.worktreePath || !ps.agentSessionFile) return false;

	const asyncFs = opts.fsImpl ?? realFs;
	try {
		await asyncFs.promises.access(ps.worktreePath);
	} catch {
		return false;
	}

	try {
		const transcript = await asyncFs.promises.stat(ps.agentSessionFile);
		return (opts.clock ?? realClock).now() - transcript.mtimeMs < RECENT_TRANSCRIPT_WINDOW_MS;
	} catch {
		return false;
	}
}

interface AsyncOrphanStats {
	mtimeMs: number;
	isDirectory(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
}

export interface AsyncOrphanDirectory {
	read(): Promise<Dirent | null>;
	close(): Promise<void>;
}

/** Promise-only filesystem seam for the streaming orphan scanner. */
export interface AsyncOrphanScanFs {
	lstat(filePath: string): Promise<AsyncOrphanStats>;
	opendir(dirPath: string): Promise<AsyncOrphanDirectory>;
}

const realAsyncOrphanScanFs: AsyncOrphanScanFs = {
	lstat: filePath => fs.promises.lstat(filePath),
	opendir: dirPath => fs.promises.opendir(dirPath),
};

export interface AsyncOrphanScanOptions {
	maxPaths?: number;
	maxLogLines?: number;
	concurrency?: number;
	/** Filesystem boundary for deterministic semantic tests. Defaults to node:fs. */
	fsImpl?: AsyncOrphanScanFs;
}

interface AsyncScanFrame {
	fullPath: string;
	directory: AsyncOrphanDirectory;
}

const SCAN_YIELD_INTERVAL = 256;

function normalizedSampleCap(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function insertSortedBounded(sample: string[], candidate: string, cap: number): void {
	if (cap === 0) return;
	let low = 0;
	let high = sample.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (sample[middle]! < candidate) low = middle + 1;
		else high = middle;
	}
	if (low >= cap) return;
	sample.splice(low, 0, candidate);
	if (sample.length > cap) sample.pop();
}

function yieldScanTurn(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve));
}

/**
 * Walk `<agentSessionsRoot>` for untracked `*.jsonl` transcripts.
 *
 * `opendir().read()` streams one entry at a time. Candidate stats provide the
 * parallelism, while their fixed-size pending set backpressures further reads;
 * no directory-sized entry array or discovered-work queue is retained. Open
 * directory frames grow only with traversal depth. Every filesystem operation,
 * including reads and closes, shares the same operation-level ceiling.
 */
export async function scanOrphanedTranscriptsAsync(
	agentSessionsRoot: string,
	trackedFiles: Set<string>,
	mostRecentLastActivity: number,
	opts: AsyncOrphanScanOptions = {},
): Promise<{ count: number; paths: string[] }> {
	const pathCap = normalizedSampleCap(opts.maxPaths, 50);
	const logCap = normalizedSampleCap(opts.maxLogLines, 20);
	const sampleCap = Math.max(pathCap, logCap);
	const asyncFs = opts.fsImpl ?? realAsyncOrphanScanFs;
	const requestedConcurrency = opts.concurrency ?? BACKGROUND_IO_CONCURRENCY;
	const concurrency = Number.isFinite(requestedConcurrency)
		? Math.max(1, Math.floor(requestedConcurrency))
		: BACKGROUND_IO_CONCURRENCY;
	const sample: string[] = [];
	const pendingCandidates = new Set<Promise<void>>();
	const frames: AsyncScanFrame[] = [];
	let count = 0;
	let stepsSinceYield = 0;

	const waitForTraversalSlot = async (): Promise<void> => {
		if (pendingCandidates.size >= concurrency) {
			await Promise.race(pendingCandidates);
		}
	};

	const traversalIo = async <T>(operation: () => Promise<T>): Promise<T> => {
		await waitForTraversalSlot();
		return operation();
	};

	const closeDirectory = async (directory: AsyncOrphanDirectory): Promise<void> => {
		try { await traversalIo(() => directory.close()); } catch { /* best-effort scan */ }
	};

	const openDirectory = async (fullPath: string): Promise<AsyncOrphanDirectory | null> => {
		let stats: AsyncOrphanStats;
		try { stats = await traversalIo(() => asyncFs.lstat(fullPath)); }
		catch { return null; }
		if (!stats.isDirectory() || stats.isSymbolicLink()) return null;

		let directory: AsyncOrphanDirectory;
		try { directory = await traversalIo(() => asyncFs.opendir(fullPath)); }
		catch { return null; }

		// An entry can be replaced between lstat and opendir. Never consume an
		// opened handle when the path now resolves to a symlink/non-directory.
		try { stats = await traversalIo(() => asyncFs.lstat(fullPath)); }
		catch {
			await closeDirectory(directory);
			return null;
		}
		if (!stats.isDirectory() || stats.isSymbolicLink()) {
			await closeDirectory(directory);
			return null;
		}
		return directory;
	};

	const scheduleCandidate = (fullPath: string): void => {
		let pending: Promise<void>;
		pending = (async () => {
			try {
				const stats = await asyncFs.lstat(fullPath);
				if (!stats.isFile() || stats.isSymbolicLink() || stats.mtimeMs < mostRecentLastActivity) return;
				count++;
				insertSortedBounded(sample, fullPath, sampleCap);
			} catch {
				// One missing/unreadable transcript must not hide its siblings.
			}
		})().finally(() => pendingCandidates.delete(pending));
		pendingCandidates.add(pending);
	};

	const rootDirectory = await openDirectory(agentSessionsRoot);
	if (!rootDirectory) return { count: 0, paths: [] };
	frames.push({ fullPath: agentSessionsRoot, directory: rootDirectory });

	try {
		while (frames.length > 0) {
			const frame = frames[frames.length - 1]!;
			let entry: Dirent | null;
			try { entry = await traversalIo(() => frame.directory.read()); }
			catch {
				frames.pop();
				await closeDirectory(frame.directory);
				continue;
			}

			if (!entry) {
				frames.pop();
				await closeDirectory(frame.directory);
				continue;
			}

			// Revalidate after reading from the handle and before joining its entry
			// name. A path replaced by a directory symlink is closed, not traversed.
			let frameStats: AsyncOrphanStats;
			try { frameStats = await traversalIo(() => asyncFs.lstat(frame.fullPath)); }
			catch {
				frames.pop();
				await closeDirectory(frame.directory);
				continue;
			}
			if (!frameStats.isDirectory() || frameStats.isSymbolicLink()) {
				frames.pop();
				await closeDirectory(frame.directory);
				continue;
			}

			const fullPath = path.join(frame.fullPath, entry.name);
			if (!entry.isSymbolicLink() && entry.isDirectory()) {
				const childDirectory = await openDirectory(fullPath);
				if (childDirectory) frames.push({ fullPath, directory: childDirectory });
			} else if (
				!entry.isSymbolicLink()
				&& entry.isFile()
				&& entry.name.endsWith(".jsonl")
				&& !trackedFiles.has(fullPath)
			) {
				scheduleCandidate(fullPath);
			}

			stepsSinceYield++;
			if (stepsSinceYield >= SCAN_YIELD_INTERVAL) {
				stepsSinceYield = 0;
				await yieldScanTurn();
			}
		}
		await Promise.all(pendingCandidates);
	} finally {
		await Promise.all(pendingCandidates);
		for (let index = frames.length - 1; index >= 0; index--) {
			await closeDirectory(frames[index]!.directory);
		}
	}

	for (const orphanPath of sample.slice(0, logCap)) {
		console.warn(`[session-store] WARN: orphaned transcript: ${orphanPath}`);
	}
	return { count, paths: sample.slice(0, pathCap) };
}
