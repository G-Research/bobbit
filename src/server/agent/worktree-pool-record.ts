/**
 * Durable record of the worktrees a `WorktreePool` owns.
 *
 * Pool entries were previously in-memory only, and that is the whole reason a
 * restart had to be expensive. Boot is forbidden from adopting a leftover worktree
 * from its branch name, path shape, or Git metadata — see
 * `docs/design/preserve-user-worktrees.md`, restated in `docs/internals.md` and
 * `docs/maintenance.md` — because none of those can distinguish Bobbit's own
 * pre-built worktree from one a user made and still wants. With nothing else to go
 * on, the only safe choice at shutdown was to delete every unclaimed entry and
 * rebuild the pool from scratch next time.
 *
 * This store supplies the missing evidence. It is the *exact durable record* the
 * ownership rules already accept elsewhere: a `(repoPath, worktreePath, branchName)`
 * triple that Bobbit wrote down when it created the worktree. Adoption then rests on
 * "I recorded making this", not on "this looks like mine", so the invariant is
 * satisfied rather than weakened. Anything on disk without a matching record stays
 * exactly as it is today — a diagnostic that Bobbit never touches.
 *
 * Records are hints, never authority. A record that no longer matches Git, or whose
 * path a live session references, is discarded and the worktree is left alone.
 */
import path from "node:path";

import type { Clock, FsLike } from "../gateway-deps.js";
import { realClock } from "../gateway-deps.js";
import { CoalescedJsonWriter } from "./coalesced-json-writer.js";

/** One recorded pool worktree. Multi-repo entries carry the whole set. */
export interface PoolEntryRecord {
	branchName: string;
	worktreePath: string;
	worktrees?: Array<{ repo: string; repoPath: string; worktreePath: string }>;
	createdAt: number;
}

/** What the pool needs from a record store. Narrow, so tests can substitute memory. */
export interface PoolRecordSink {
	/** Replace the recorded entries for one project. */
	replace(projectId: string, repoPath: string, entries: readonly PoolEntryRecord[]): void;
	/** Recorded entries for one project, or `[]` when nothing was recorded. */
	read(projectId: string): { repoPath?: string; entries: PoolEntryRecord[] };
	/** Forget a project entirely (project removal). */
	forget(projectId: string): void;
	/** Await the pending atomic write, so shutdown cannot lose the last mutation. */
	flush(): Promise<void>;
}

interface PoolRecordFile {
	version: 1;
	projects: Record<string, { repoPath: string; entries: PoolEntryRecord[] }>;
}

const RECORD_FILE = "worktree-pools.json";

function cloneEntry(entry: PoolEntryRecord): PoolEntryRecord {
	return {
		branchName: entry.branchName,
		worktreePath: entry.worktreePath,
		...(entry.worktrees ? { worktrees: entry.worktrees.map(worktree => ({ ...worktree })) } : {}),
		createdAt: entry.createdAt,
	};
}

function parseEntry(value: unknown): PoolEntryRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const entry = value as Partial<PoolEntryRecord>;
	if (typeof entry.branchName !== "string" || !entry.branchName) return undefined;
	if (typeof entry.worktreePath !== "string" || !entry.worktreePath) return undefined;
	if (typeof entry.createdAt !== "number" || !Number.isFinite(entry.createdAt) || entry.createdAt < 0) return undefined;
	if (entry.worktrees !== undefined) {
		if (!Array.isArray(entry.worktrees) || entry.worktrees.length === 0) return undefined;
		if (entry.worktrees.some(worktree =>
			!worktree || typeof worktree !== "object"
			|| typeof worktree.repo !== "string" || !worktree.repo
			|| typeof worktree.repoPath !== "string" || !worktree.repoPath
			|| typeof worktree.worktreePath !== "string" || !worktree.worktreePath
		)) return undefined;
	}
	return cloneEntry(entry as PoolEntryRecord);
}

/** In-memory sink for tests and for managers without an explicit state directory. */
export class MemoryPoolRecordStore implements PoolRecordSink {
	private readonly projects = new Map<string, { repoPath?: string; entries: PoolEntryRecord[] }>();

	replace(projectId: string, repoPath: string, entries: readonly PoolEntryRecord[]): void {
		if (entries.length === 0) this.projects.delete(projectId);
		else this.projects.set(projectId, { repoPath, entries: entries.map(cloneEntry) });
	}

	read(projectId: string): { repoPath?: string; entries: PoolEntryRecord[] } {
		const found = this.projects.get(projectId);
		return found ? { repoPath: found.repoPath, entries: found.entries.map(cloneEntry) } : { entries: [] };
	}

	forget(projectId: string): void { this.projects.delete(projectId); }
	async flush(): Promise<void> { /* nothing to write */ }
}

/**
 * Disk-backed record store, with every project's pool in one gateway-owned file.
 *
 * Writes go through {@link CoalescedJsonWriter} for the same reason every other
 * Bobbit store does: fills and claims arrive in bursts, and an older async rename
 * must never overtake a newer one.
 */
export class WorktreePoolRecordStore implements PoolRecordSink {
	private readonly writer: CoalescedJsonWriter;
	private readonly projects = new Map<string, { repoPath?: string; entries: PoolEntryRecord[] }>();

	constructor(
		private readonly fs: FsLike,
		private readonly stateDir: string,
		clock: Clock = realClock,
		debounceMs = 250,
	) {
		this.load();
		this.writer = new CoalescedJsonWriter(
			fs,
			stateDir,
			this.filePath,
			() => JSON.stringify(this.serialize(), null, 2),
			"worktree-pool-record",
			debounceMs,
			clock,
		);
	}

	private get filePath(): string { return path.resolve(this.stateDir, RECORD_FILE); }

	/**
	 * Read the record file, tolerating absence and corruption.
	 *
	 * A record is only ever a hint that saves work, so an unreadable file must
	 * degrade to "adopt nothing" — never to a boot failure.
	 */
	private load(): void {
		let raw: string;
		try { raw = this.fs.readFileSync(this.filePath, "utf-8") as string; }
		catch { return; }
		try {
			const parsed = JSON.parse(raw) as Partial<PoolRecordFile>;
			if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || !parsed.projects
				|| typeof parsed.projects !== "object" || Array.isArray(parsed.projects)) return;
			for (const [projectId, value] of Object.entries(parsed.projects)) {
				if (!projectId || !value || typeof value !== "object" || !Array.isArray(value.entries)) continue;
				if (typeof value.repoPath !== "string" || !value.repoPath) continue;
				const parsedEntries = value.entries.map(parseEntry);
				// A partially valid ownership set is not authority. Reject the complete
				// project record rather than silently adopting only convenient rows.
				if (parsedEntries.some(entry => !entry)) continue;
				const entries = parsedEntries as PoolEntryRecord[];
				if (entries.length > 0) this.projects.set(projectId, { repoPath: value.repoPath, entries });
			}
		} catch (error) {
			console.warn(`[worktree-pool-record] Ignoring unreadable ${RECORD_FILE}:`, error);
		}
	}

	private serialize(): PoolRecordFile {
		const projects: PoolRecordFile["projects"] = {};
		for (const [projectId, value] of this.projects) {
			if (value.repoPath) projects[projectId] = { repoPath: value.repoPath, entries: value.entries.map(cloneEntry) };
		}
		return { version: 1, projects };
	}

	replace(projectId: string, repoPath: string, entries: readonly PoolEntryRecord[]): void {
		if (entries.length === 0) this.projects.delete(projectId);
		else this.projects.set(projectId, { repoPath, entries: entries.map(cloneEntry) });
		this.writer.schedule();
	}

	read(projectId: string): { repoPath?: string; entries: PoolEntryRecord[] } {
		const found = this.projects.get(projectId);
		return found ? { repoPath: found.repoPath, entries: found.entries.map(cloneEntry) } : { entries: [] };
	}

	forget(projectId: string): void {
		if (this.projects.delete(projectId)) this.writer.schedule();
	}

	flush(): Promise<void> { return this.writer.flush(); }
}
