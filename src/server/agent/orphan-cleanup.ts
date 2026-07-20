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
import type { Dirent } from "node:fs";
import path from "node:path";
import type { Clock, FsLike } from "../gateway-deps.js";
import { realClock, realFs } from "../gateway-deps.js";
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

export interface AsyncOrphanScanOptions {
	maxPaths?: number;
	maxLogLines?: number;
	concurrency?: number;
	/** Filesystem boundary for deterministic semantic tests. Defaults to node:fs. */
	fsImpl?: Pick<FsLike, "promises">;
}

type AsyncScanWork =
	| { kind: "directory"; fullPath: string }
	| { kind: "file"; fullPath: string };

/**
 * Walk `<agentSessionsRoot>` for untracked `*.jsonl` transcripts using one
 * concurrency-limited worker pool.
 *
 * Directory reads and candidate-file stats share one bounded worker pool, so
 * even a single wide directory cannot create an unbounded burst of filesystem
 * requests. The capped path/log sample may be ordered differently from the
 * synchronous scanner; filesystem enumeration order is not an API contract.
 */
export async function scanOrphanedTranscriptsAsync(
	agentSessionsRoot: string,
	trackedFiles: Set<string>,
	mostRecentLastActivity: number,
	opts: AsyncOrphanScanOptions = {},
): Promise<{ count: number; paths: string[] }> {
	const pathCap = opts.maxPaths ?? 50;
	const logCap = opts.maxLogLines ?? 20;
	const asyncFs = opts.fsImpl ?? realFs;
	const requestedConcurrency = opts.concurrency ?? 8;
	const concurrency = Number.isFinite(requestedConcurrency)
		? Math.max(1, Math.floor(requestedConcurrency))
		: 8;
	const paths: string[] = [];
	let count = 0;
	let logged = 0;

	try {
		if (!(await asyncFs.promises.stat(agentSessionsRoot)).isDirectory()) {
			return { count: 0, paths: [] };
		}
	} catch {
		return { count: 0, paths: [] };
	}

	const queue: AsyncScanWork[] = [{ kind: "directory", fullPath: agentSessionsRoot }];
	let cursor = 0;

	const processWork = async (work: AsyncScanWork): Promise<void> => {
		if (work.kind === "directory") {
			let entries: Dirent[];
			try {
				entries = await asyncFs.promises.readdir(work.fullPath, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const fullPath = path.join(work.fullPath, entry.name);
				if (entry.isDirectory()) {
					queue.push({ kind: "directory", fullPath });
				} else if (entry.isFile() && entry.name.endsWith(".jsonl") && !trackedFiles.has(fullPath)) {
					queue.push({ kind: "file", fullPath });
				}
			}
			return;
		}

		let mtimeMs: number;
		try {
			mtimeMs = (await asyncFs.promises.stat(work.fullPath)).mtimeMs;
		} catch {
			return;
		}
		if (mtimeMs < mostRecentLastActivity) return;

		count++;
		if (paths.length < pathCap) paths.push(work.fullPath);
		if (logged < logCap) {
			console.warn(`[session-store] WARN: orphaned transcript: ${work.fullPath}`);
			logged++;
		}
	};

	await new Promise<void>((resolve, reject) => {
		let active = 0;
		let settled = false;

		const schedule = (): void => {
			if (settled) return;
			while (active < concurrency && cursor < queue.length) {
				const work = queue[cursor++];
				active++;
				void processWork(work).then(
					() => {
						active--;
						schedule();
					},
					(error: unknown) => {
						active--;
						settled = true;
						reject(error);
					},
				);
			}
			if (active === 0 && cursor >= queue.length) {
				settled = true;
				resolve();
			}
		};

		schedule();
	});

	return { count, paths };
}
