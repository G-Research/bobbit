import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { PersistedSession } from "./session-store.js";

const nativeRealpath = promisify(fs.realpath.native) as (value: string) => Promise<string>;

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

export interface AsyncWorktreeReferenceOptions extends WorktreeReferenceOptions {
	/** Narrow test seam; production uses the asynchronous native realpath API. */
	realpathNative?: (value: string) => Promise<string>;
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

function hasExplicitAliasEvidence(value: string): boolean {
	const segments = value.split(/[\\/]+/);
	return segments.includes(".")
		|| segments.includes("..")
		|| (process.platform === "win32" && segments.some(segment => /~\d/i.test(segment)));
}

async function cleanupIdentity(
	value: string,
	realpathNative: (value: string) => Promise<string>,
): Promise<string | undefined> {
	const resolved = path.resolve(value);
	if (!hasExplicitAliasEvidence(value)) return normalizeWorktreeHostPath(resolved);
	try {
		return normalizeWorktreeHostPath(await realpathNative(resolved));
	} catch {
		return undefined;
	}
}

/**
 * Alias-aware reference check for destructive cleanup boundaries only.
 *
 * Ordinary coordinates retain the synchronous guard's zero-I/O behavior. When
 * an explicit dot-segment or Windows 8.3 alias needs native proof, an unreadable
 * identity is treated as referenced so cleanup fails closed.
 */
export async function isWorktreePathReferencedByLiveSessionForCleanup(
	candidatePath: string | undefined,
	sessions: Iterable<WorktreeReferenceRecord | PersistedSession>,
	options?: AsyncWorktreeReferenceOptions,
): Promise<boolean> {
	const records = liveRecords(sessions, options);
	if (!candidatePath || records.length === 0) return false;
	if (isWorktreePathReferencedByLiveSession(candidatePath, records)) return true;

	const references: Array<{ path: string; descendant: boolean }> = [];
	for (const session of records) {
		if (session.worktreePath) references.push({ path: session.worktreePath, descendant: false });
		if (session.cwd) references.push({ path: session.cwd, descendant: true });
		for (const worktreePath of Object.values(session.repoWorktrees ?? {})) {
			if (worktreePath) references.push({ path: worktreePath, descendant: false });
		}
	}

	const candidateHasAlias = hasExplicitAliasEvidence(candidatePath);
	const resolveNative = options?.realpathNative ?? nativeRealpath;
	let candidateIdentity: string | undefined;
	for (const reference of references) {
		if (!candidateHasAlias && !hasExplicitAliasEvidence(reference.path)) continue;
		candidateIdentity ??= await cleanupIdentity(candidatePath, resolveNative);
		if (!candidateIdentity) return true;
		const referenceIdentity = await cleanupIdentity(reference.path, resolveNative);
		if (!referenceIdentity) return true;
		if (reference.descendant
			? isSameOrChildPath(candidateIdentity, referenceIdentity)
			: candidateIdentity === referenceIdentity) {
			return true;
		}
	}
	return false;
}
