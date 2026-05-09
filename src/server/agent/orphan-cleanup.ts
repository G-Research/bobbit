/**
 * Orphan-cleanup gate + agent-CLI orphan-transcript scanner.
 *
 * Extracted out of session-manager.ts so unit tests can exercise the helpers
 * without paying the transitive cost (and runtime hazards) of importing the
 * full SessionManager. Pinned by tests/session-manager-orphan-keep.test.ts.
 *
 * See goal `goal-goal-sessions-p-14dc3ec7` and the design doc
 * `docs/design/session-store-crash-safety.md` for context.
 */
import fs from "node:fs";
import path from "node:path";
import type { PersistedSession } from "./session-store.js";

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
 * so `fs.existsSync` will return false and the gate naturally falls
 * through. That's correct — sandbox health is checked elsewhere.
 */
export function shouldKeepDespiteOrphan(ps: PersistedSession): boolean {
	const wtAlive = !!ps.worktreePath && (() => {
		try { return fs.existsSync(ps.worktreePath!); }
		catch { return false; }
	})();
	if (!wtAlive) return false;
	const recentTranscript = !!ps.agentSessionFile && (() => {
		try { return Date.now() - fs.statSync(ps.agentSessionFile!).mtimeMs < 24 * 60 * 60 * 1000; }
		catch { return false; }
	})();
	return recentTranscript;
}

/**
 * Walk `<agentSessionsRoot>` for `*.jsonl` transcripts that are NOT tracked
 * by any `PersistedSession.agentSessionFile`. Used to surface a splash
 * banner when the session-metadata index has diverged from the agent CLI's
 * on-disk transcripts. No auto-import — banner only.
 *
 * @param agentSessionsRoot Root directory of the agent CLI's session files.
 * @param trackedFiles Set of `agentSessionFile` paths from all known sessions
 *                    (live + archived).
 * @param mostRecentLastActivity Skip transcripts whose mtime is older than
 *                               this — they're noise from prior installs.
 * @returns `{ count, paths }` where `paths` is capped at 50.
 */
export function scanOrphanedTranscripts(
	agentSessionsRoot: string,
	trackedFiles: Set<string>,
	mostRecentLastActivity: number,
): { count: number; paths: string[] } {
	const PATH_CAP = 50;
	const LOG_CAP = 20;
	const paths: string[] = [];
	let count = 0;
	let logged = 0;

	let rootExists = false;
	try { rootExists = fs.existsSync(agentSessionsRoot) && fs.statSync(agentSessionsRoot).isDirectory(); }
	catch { rootExists = false; }
	if (!rootExists) return { count: 0, paths: [] };

	const walk = (dir: string): void => {
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
		catch { return; }
		for (const ent of entries) {
			const full = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				walk(full);
				continue;
			}
			if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;
			if (trackedFiles.has(full)) continue;
			let mtime = 0;
			try { mtime = fs.statSync(full).mtimeMs; }
			catch { continue; }
			if (mtime < mostRecentLastActivity) continue;
			count++;
			if (paths.length < PATH_CAP) paths.push(full);
			if (logged < LOG_CAP) {
				console.warn(`[session-store] WARN: orphaned transcript: ${full}`);
				logged++;
			}
		}
	};
	walk(agentSessionsRoot);
	return { count, paths };
}
