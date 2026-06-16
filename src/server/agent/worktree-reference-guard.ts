import type { PersistedSession } from "./session-store.js";

export interface WorktreeReferenceRecord {
	id?: string;
	archived?: boolean;
	worktreePath?: string;
	cwd?: string;
	repoWorktrees?: Record<string, string>;
}

export interface WorktreeReferenceOptions {
	ignoreSessionId?: string;
}

/** Normalize host worktree paths for cross-platform ownership checks. */
export function normalizeWorktreeHostPath(p?: string): string | undefined {
	if (!p) return undefined;
	let normalized = p.trim().replace(/\\/g, "/");
	while (normalized.length > 1 && normalized.endsWith("/")) {
		normalized = normalized.slice(0, -1);
	}
	return normalized ? normalized.toLowerCase() : undefined;
}

function isSameOrChildPath(candidate: string, reference: string): boolean {
	return reference === candidate || reference.startsWith(`${candidate}/`);
}

function liveRecords(
	sessions: Iterable<WorktreeReferenceRecord | PersistedSession>,
	options?: WorktreeReferenceOptions,
): WorktreeReferenceRecord[] {
	const records: WorktreeReferenceRecord[] = [];
	for (const session of sessions) {
		if (!session || session.archived) continue;
		if (options?.ignoreSessionId && session.id === options.ignoreSessionId) continue;
		records.push(session);
	}
	return records;
}

/** Collect exact worktree roots referenced by live sessions. */
export function collectLiveSessionWorktreePaths(
	sessions: Iterable<WorktreeReferenceRecord | PersistedSession>,
	options?: WorktreeReferenceOptions,
): Set<string> {
	const paths = new Set<string>();
	for (const session of liveRecords(sessions, options)) {
		const worktreePath = normalizeWorktreeHostPath(session.worktreePath);
		if (worktreePath) paths.add(worktreePath);
		const cwd = normalizeWorktreeHostPath(session.cwd);
		if (cwd) paths.add(cwd);
		if (session.repoWorktrees) {
			for (const wt of Object.values(session.repoWorktrees)) {
				const normalized = normalizeWorktreeHostPath(wt);
				if (normalized) paths.add(normalized);
			}
		}
	}
	return paths;
}

/**
 * Return true when another non-archived persisted session still references the
 * candidate worktree path. `cwd` protects the candidate when it is equal to or
 * inside the candidate worktree; worktreePath/repoWorktrees require exact roots.
 */
export function isWorktreePathReferencedByLiveSession(
	candidatePath: string | undefined,
	sessions: Iterable<WorktreeReferenceRecord | PersistedSession>,
	options?: WorktreeReferenceOptions,
): boolean {
	const candidate = normalizeWorktreeHostPath(candidatePath);
	if (!candidate) return false;
	for (const session of liveRecords(sessions, options)) {
		if (normalizeWorktreeHostPath(session.worktreePath) === candidate) return true;
		const cwd = normalizeWorktreeHostPath(session.cwd);
		if (cwd && isSameOrChildPath(candidate, cwd)) return true;
		if (session.repoWorktrees) {
			for (const wt of Object.values(session.repoWorktrees)) {
				if (normalizeWorktreeHostPath(wt) === candidate) return true;
			}
		}
	}
	return false;
}
