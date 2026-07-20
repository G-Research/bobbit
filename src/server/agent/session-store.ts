import type { Dirent } from "node:fs";
import type { Clock, FsLike } from "../gateway-deps.js";
import { realClock, realFs } from "../gateway-deps.js";
import path from "node:path";
import { recordDeletionTombstone, recordDeletionTombstoneAsync } from "./deletion-tombstones.js";
import type { QueuedMessage } from "../ws/protocol.js";
import type { SidePanelWorkspace } from "../../shared/side-panel-workspace.js";

/** 24h in ms — recency threshold for `shouldKeepDespiteOrphan`. */
const RECENT_TRANSCRIPT_WINDOW_MS = 24 * 60 * 60 * 1000;
const VERIFIER_SESSION_ID_RE = /^(?:llm-review|agent-qa)-/;

function isVerifierSessionId(id: string): boolean {
	return VERIFIER_SESSION_ID_RE.test(id);
}

function defaultVerifierAccessory(id: string): string {
	return id.startsWith("agent-qa-") ? "stamp" : "magnifier";
}

/**
 * Tightened orphan-cleanup gate. Returns true when an apparently-orphaned
 * session must NOT be archived because its worktree directory still exists
 * AND its agent JSONL has been written within the last 24h. Caller is
 * `SessionManager`'s boot orphan sweep — leave the session live; the user
 * can archive manually from the UI if it really is dead.
 *
 * `now` is injectable for testability.
 */
export function shouldKeepDespiteOrphan(
	ps: { worktreePath?: string; agentSessionFile?: string },
	now: number = Date.now(),
	fsImpl: FsLike = realFs,
): boolean {
	const wtAlive = !!ps.worktreePath && (() => {
		try { return fsImpl.existsSync(ps.worktreePath!); } catch { return false; }
	})();
	if (!wtAlive) return false;
	const recentTranscript = !!ps.agentSessionFile && (() => {
		try { return now - fsImpl.statSync(ps.agentSessionFile!).mtimeMs < RECENT_TRANSCRIPT_WINDOW_MS; }
		catch { return false; }
	})();
	return recentTranscript;
}

/** Legacy persisted value. Retained only so older session records remain readable. */
export type WorktreePushPolicy = "local-only" | "publish";

/** Persisted metadata for a single gateway session */
export interface PersistedSession {
	id: string;
	title: string;
	cwd: string;
	/** The agent's .jsonl session file path — needed to resume */
	agentSessionFile: string;
	createdAt: number;
	lastActivity: number;
	/** Epoch ms when the user last viewed this session. 0 / undefined = never read. */
	lastReadAt?: number;
	/** Optional goal this session belongs to */
	goalId?: string;
	/** Whether the agent was actively streaming when the server last knew about it */
	wasStreaming?: boolean;
	/** Epoch ms when the current streaming turn started (survives server restarts) */
	streamingStartedAt?: number;
	/** If this session is a delegate, the parent session ID */
	delegateOf?: string;
	/**
	 * Delegate task instructions — the durable equivalent of a worker's goal
	 * spec. Written once at spawn and rebuilt into the system prompt on restore
	 * so a delegate survives a gateway restart with its task intact.
	 */
	instructions?: string;
	/** Delegate task context key/value pairs, layered into the prompt on restore. */
	context?: Record<string, string>;
	/** First-class parent session ID for visible child sessions (not delegate lifecycle). */
	parentSessionId?: string;
	/** Kind discriminator for first-class child sessions, e.g. "pr-walkthrough". */
	childKind?: string;
	/** Whether the session should be treated as read-only by clients/tools. */
	readOnly?: boolean;
	/**
	 * Generic persisted terminal marker for a child session (orchestration-core
	 * Decision E / Findings 3–4). Set server-side when a child's work is done
	 * (e.g. a host-agents reviewer submitted, or was dismissed) so the generic
	 * boot-reap (`shouldReapChildOnBoot` reading this field) removes it after a
	 * restart even if a dismiss never ran. Carries NO pack/kind knowledge.
	 */
	childTerminal?: boolean;
	/** Epoch ms when `childTerminal` was stamped. */
	terminalAt?: number;
	/** Explicit session-scoped tool allowlist captured at creation. Undefined means derive from role/default policy. */
	allowedTools?: string[];
	/** Which project this session belongs to */
	projectId?: string;
	/** Role in a team goal (e.g., 'coder', 'reviewer', 'tester') */
	role?: string;
	/** The team goal this agent belongs to */
	teamGoalId?: string;
	/** Session ID of the team lead that spawned this agent */
	teamLeadSessionId?: string;
	/** Path to the git worktree for this session */
	worktreePath?: string;
	/** Assistant type: "goal" | "role" | "tool" */
	assistantType?: string;
	// Legacy boolean fields — kept for backward compat during migration
	/** @deprecated Use assistantType instead */
	goalAssistant?: boolean;
	/** @deprecated Use assistantType instead */
	roleAssistant?: boolean;
	/** @deprecated Use assistantType instead */
	toolAssistant?: boolean;
	/** Task ID this session is working on */
	taskId?: string;
	/** Staff agent ID this session belongs to */
	staffId?: string;
	/** Pixel-art accessory ID for the Bobbit sprite overlay */
	accessory?: string;
	/** Whether this session has a live HTML preview panel */
	preview?: boolean;
	/** Persisted prompt queue */
	messageQueue?: QueuedMessage[];
	/** Steer texts accepted for dispatch but not yet echoed as user messages. */
	inFlightSteerTexts?: string[];
	/** Server-side draft storage, keyed by draft type (e.g. "prompt", "goal", "role") */
	drafts?: Record<string, unknown>;
	/** Goal ID this session is re-attempting (for goal assistant sessions) */
	reattemptGoalId?: string;
	/** Whether this session is archived (soft-deleted) */
	archived?: boolean;
	/** Epoch ms when this session was archived */
	archivedAt?: number;
	/** Whether this is an automated non-interactive session (e.g. verification reviewer) */
	nonInteractive?: boolean;
	/** Repository path (preserved from goal for worktree cleanup) */
	repoPath?: string;
	/** Branch name (preserved for worktree cleanup) */
	branch?: string;
	/** @deprecated Legacy inert metadata retained for backward-compatible reads. */
	worktreePushPolicy?: WorktreePushPolicy;
	/** @deprecated Legacy inert metadata retained for backward-compatible reads. */
	remotePublicationPolicy?: WorktreePushPolicy;
	/** Model provider (e.g. "anthropic") — persisted so archived sessions can display model info */
	modelProvider?: string;
	/** Model ID (e.g. "claude-sonnet-4-20250514") — persisted so archived sessions can display model info */
	modelId?: string;
	/** Image generation model provider for this session, if overridden from the default. */
	imageModelProvider?: string;
	/** Image generation model ID for this session, if overridden from the default. */
	imageModelId?: string;
	/** Whether this session runs inside a Docker sandbox container */
	sandboxed?: boolean;
	/** Per-repo worktree paths (multi-repo only). Single-repo uses flat worktreePath. */
	repoWorktrees?: Record<string, string>;
	/** Server-authoritative right-hand side-panel workspace. */
	sidePanelWorkspace?: SidePanelWorkspace;
}

/**
 * Subset of `PersistedSession` fields that `SessionStore.update()` is
 * permitted to mutate after creation. `id`, `createdAt`, `drafts`, and
 * other identity-shaped fields are intentionally excluded.
 */
export type UpdatableSessionFields = Pick<
	PersistedSession,
	| "title"
	| "lastActivity"
	| "lastReadAt"
	| "agentSessionFile"
	| "goalId"
	| "wasStreaming"
	| "streamingStartedAt"
	| "delegateOf"
	| "parentSessionId"
	| "childKind"
	| "readOnly"
	| "childTerminal"
	| "terminalAt"
	| "role"
	| "teamGoalId"
	| "teamLeadSessionId"
	| "worktreePath"
	| "assistantType"
	| "goalAssistant"
	| "roleAssistant"
	| "toolAssistant"
	| "taskId"
	| "staffId"
	| "accessory"
	| "preview"
	| "messageQueue"
	| "inFlightSteerTexts"
	| "archived"
	| "archivedAt"
	| "repoPath"
	| "branch"
	| "nonInteractive"
	| "cwd"
	| "reattemptGoalId"
	| "modelProvider"
	| "modelId"
	| "imageModelProvider"
	| "imageModelId"
	| "sandboxed"
	| "projectId"
	| "repoWorktrees"
	| "sidePanelWorkspace"
>;

/**
 * Simple JSON file store for gateway session metadata.
 * Allows sessions to survive server restarts.
 */
type SessionStoreAsyncFs = FsLike["promises"] & {
	open: typeof import("node:fs").promises.open;
};

type SessionStoreFs = FsLike & {
	openSync: typeof import("node:fs").openSync;
	fsyncSync: typeof import("node:fs").fsyncSync;
	closeSync: typeof import("node:fs").closeSync;
	promises: SessionStoreAsyncFs;
};

type DiskFingerprint = {
	size: number;
	mtimeMs: number;
	ctimeMs?: number;
};

export class SessionStore {
	private readonly storeDir: string;
	private readonly storeFile: string;
	private readonly fs: SessionStoreFs;
	private readonly clock: Clock;
	private sessions: Map<string, PersistedSession> = new Map();
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private static SAVE_DEBOUNCE_MS = 1000;
	private static BACKUP_COUNT = 5;
	/** Monotonically increasing counter — bumped on every mutation. Resets to 0 on server restart. */
	private generation = 0;
	/** Epoch read from disk on construction (or 0 for legacy/missing). */
	private loadedEpoch = 0;
	/** Epoch we have successfully written to disk this process. */
	private writtenEpoch = 0;
	/** Last observed metadata for the primary; never authoritative before our first write. */
	private diskFingerprint: DiskFingerprint | null = null;
	/** One-shot latch: once tripped, no further saveNow() writes to disk. */
	private staleGuardTripped = false;
	/** Active promise-based purge writer; synchronous mutations fold into it. */
	private asyncSaveInFlight: Promise<void> | null = null;
	private asyncSaveRequested = false;

	constructor(stateDir: string, fsImpl: FsLike = realFs, clock: Clock = realClock) {
		this.fs = fsImpl as SessionStoreFs;
		this.clock = clock;
		this.storeDir = stateDir;
		this.storeFile = path.join(stateDir, "sessions.json");
		this.load();
		this.diskFingerprint = this.currentDiskFingerprint();
	}

	/** Normalise PersistedSession-shaped rows read from disk (legacy field migration). */
	private seedFromArray(rows: unknown[]): void {
		for (const row of rows) {
			if (!row || typeof row !== "object") continue;
			const s = row as PersistedSession & {
				swarmGoalId?: string;
				personalities?: unknown;
			};
			if (!s.id) continue;
			// Migrate legacy 'swarmGoalId' field to 'teamGoalId'
			if (s.swarmGoalId !== undefined && s.teamGoalId === undefined) {
				s.teamGoalId = s.swarmGoalId;
				delete s.swarmGoalId;
			}
			// Lenient parse: silently drop legacy `personalities` field (feature removed)
			if ("personalities" in s) {
				delete s.personalities;
			}
			// Normalize legacy boolean flags to assistantType
			if (!s.assistantType) {
				if (s.goalAssistant) s.assistantType = "goal";
				else if (s.roleAssistant) s.assistantType = "role";
				else if (s.toolAssistant) s.assistantType = "tool";
			}
			this.sessions.set(s.id, s);
		}
		this.normalizeLegacyVerifierSessions();
	}

	/**
	 * Backfill archived verifier rows created before setup metadata was stamped.
	 * Keep the rows (and any transcripts) intact; only fill ownership/display
	 * fields so clients stop treating goal-owned verifier placeholders as
	 * standalone user sessions.
	 */
	private normalizeLegacyVerifierSessions(): void {
		const uniqueTeamLeadByGoal = new Map<string, string | null>();
		const addTeamLeadCandidate = (goalId: string | undefined, sessionId: string) => {
			if (!goalId) return;
			const existing = uniqueTeamLeadByGoal.get(goalId);
			if (existing === undefined) {
				uniqueTeamLeadByGoal.set(goalId, sessionId);
			} else if (existing !== sessionId) {
				uniqueTeamLeadByGoal.set(goalId, null);
			}
		};
		for (const session of this.sessions.values()) {
			if (session.role !== "team-lead") continue;
			addTeamLeadCandidate(session.teamGoalId, session.id);
			addTeamLeadCandidate(session.goalId, session.id);
		}

		for (const session of this.sessions.values()) {
			if (!isVerifierSessionId(session.id) || !session.goalId) continue;
			if (!session.teamGoalId) session.teamGoalId = session.goalId;
			if (!session.teamLeadSessionId) {
				const inferredLead = uniqueTeamLeadByGoal.get(session.teamGoalId ?? session.goalId);
				if (inferredLead) session.teamLeadSessionId = inferredLead;
			}
			if (session.nonInteractive !== true) session.nonInteractive = true;
			if (!session.accessory || session.accessory === "none") {
				session.accessory = defaultVerifierAccessory(session.id);
			}
		}
	}

	/** Backup-file path for index 1..N. */
	private bakPath(n: number): string {
		return `${this.storeFile}.bak.${n}`;
	}

	private load(): void {
		this.loadedEpoch = 0;
		this.writtenEpoch = 0;

		const candidates = [this.storeFile];
		for (let i = 1; i <= SessionStore.BACKUP_COUNT; i++) candidates.push(this.bakPath(i));

		for (const file of candidates) {
			try {
				if (!this.fs.existsSync(file)) continue;
				const raw = this.fs.readFileSync(file, "utf-8");
				const parsed = JSON.parse(raw);

				if (Array.isArray(parsed)) {
					// Legacy v1 shape
					this.seedFromArray(parsed);
					this.loadedEpoch = 0;
					if (file !== this.storeFile) {
						console.warn(`[session-store] Loaded from backup ${path.basename(file)} — primary missing/corrupt`);
					}
					return;
				}
				if (parsed && typeof parsed === "object" && (parsed as { version?: number }).version === 2 && Array.isArray((parsed as { sessions?: unknown[] }).sessions)) {
					const obj = parsed as { version: number; epoch?: number; sessions: unknown[] };
					this.seedFromArray(obj.sessions);
					this.loadedEpoch = typeof obj.epoch === "number" ? obj.epoch : 0;
					if (file !== this.storeFile) {
						console.warn(`[session-store] Loaded from backup ${path.basename(file)} (epoch ${this.loadedEpoch}) — primary missing/corrupt`);
					}
					return;
				}
				console.warn(`[session-store] ${file}: unrecognised shape, skipping`);
			} catch (err) {
				console.warn(`[session-store] Failed to parse ${file}:`, err);
			}
		}
		// No file readable — start empty.
	}

	/**
	 * Synchronously read just `sessions.json` and return its `epoch`.
	 * Returns 0 for legacy v1 array shape; -1 if the file is missing or
	 * unparseable. Used by saveNow() to detect external rewrites.
	 */
	private peekDiskEpoch(): number {
		try {
			if (!this.fs.existsSync(this.storeFile)) return -1;
			const raw = this.fs.readFileSync(this.storeFile, "utf-8");
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) return 0;
			if (parsed && typeof parsed === "object" && typeof (parsed as { epoch?: unknown }).epoch === "number") {
				return (parsed as { epoch: number }).epoch;
			}
			return -1;
		} catch {
			return -1;
		}
	}

	/** Best-effort metadata used only to prove our own last write is unchanged. */
	private currentDiskFingerprint(): DiskFingerprint | null {
		try {
			const stat = this.fs.statSync(this.storeFile);
			const size = Number(stat.size);
			const mtimeMs = Number(stat.mtimeMs);
			if (!Number.isFinite(size) || !Number.isFinite(mtimeMs)) return null;
			const ctimeMs = Number(stat.ctimeMs);
			return {
				size,
				mtimeMs,
				...(Number.isFinite(ctimeMs) ? { ctimeMs } : {}),
			};
		} catch {
			return null;
		}
	}

	private static fingerprintsEqual(a: DiskFingerprint | null, b: DiskFingerprint | null): boolean {
		return a !== null && b !== null
			&& a.size === b.size
			&& a.mtimeMs === b.mtimeMs
			&& a.ctimeMs === b.ctimeMs;
	}

	/** Rotate sessions.json → .bak.1 → .bak.2 → … → .bak.N. Best-effort. */
	private rotateBackups(): void {
		try {
			if (!this.fs.existsSync(this.storeFile)) return;
			const N = SessionStore.BACKUP_COUNT;
			// Drop the oldest if it exists.
			try { if (this.fs.existsSync(this.bakPath(N))) this.fs.unlinkSync(this.bakPath(N)); } catch { /* non-fatal */ }
			// Shift .bak.{i} -> .bak.{i+1} for i = N-1 down to 1.
			for (let i = N - 1; i >= 1; i--) {
				try {
					if (this.fs.existsSync(this.bakPath(i))) {
						this.fs.renameSync(this.bakPath(i), this.bakPath(i + 1));
					}
				} catch { /* non-fatal */ }
			}
			// Copy current sessions.json → .bak.1 (copy, not rename — saveNow will
			// overwrite via tmp+rename and we want to keep the current file present
			// in case the new write fails).
			try { this.fs.copyFileSync(this.storeFile, this.bakPath(1)); } catch { /* non-fatal */ }
		} catch {
			// Backup failure must never block a save.
		}
	}

	private async peekDiskEpochAsync(): Promise<number> {
		try {
			const raw = await this.fs.promises.readFile(this.storeFile, "utf-8");
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) return 0;
			if (parsed && typeof parsed === "object" && typeof (parsed as { epoch?: unknown }).epoch === "number") {
				return (parsed as { epoch: number }).epoch;
			}
			return -1;
		} catch {
			return -1;
		}
	}

	private async currentDiskFingerprintAsync(): Promise<DiskFingerprint | null> {
		try {
			const stat = await this.fs.promises.stat(this.storeFile);
			const size = Number(stat.size);
			const mtimeMs = Number(stat.mtimeMs);
			if (!Number.isFinite(size) || !Number.isFinite(mtimeMs)) return null;
			const ctimeMs = Number(stat.ctimeMs);
			return {
				size,
				mtimeMs,
				...(Number.isFinite(ctimeMs) ? { ctimeMs } : {}),
			};
		} catch {
			return null;
		}
	}

	/** Promise-based backup rotation with the same oldest-first policy as saveNow(). */
	private async rotateBackupsAsync(): Promise<void> {
		try {
			// Whether a primary exists is a policy decision: without it there is no
			// new backup snapshot, so do not shift the existing recovery chain.
			await this.fs.promises.access(this.storeFile);
		} catch {
			return;
		}
		const N = SessionStore.BACKUP_COUNT;
		try { await this.fs.promises.unlink(this.bakPath(N)); } catch { /* non-fatal */ }
		for (let i = N - 1; i >= 1; i--) {
			try { await this.fs.promises.rename(this.bakPath(i), this.bakPath(i + 1)); } catch { /* non-fatal */ }
		}
		try { await this.fs.promises.copyFile(this.storeFile, this.bakPath(1)); } catch { /* non-fatal */ }
	}

	/** True if the most recent saveNow() refused to write due to the stale-snapshot guard. */
	isStaleGuardTripped(): boolean {
		return this.staleGuardTripped;
	}

	/** Epoch read from disk at construction. Test-visible. */
	getLoadedEpoch(): number {
		return this.loadedEpoch;
	}

	/** Epoch most recently written to disk this process. Test-visible. */
	getWrittenEpoch(): number {
		return this.writtenEpoch;
	}

	/** Write sessions to disk immediately (synchronous). */
	private saveNow(): void {
		if (this.staleGuardTripped) return;
		// Preserve the synchronous API while preventing a newer in-memory mutation
		// from racing an older promise-based purge snapshot to sessions.json.
		if (this.asyncSaveInFlight) {
			this.asyncSaveRequested = true;
			return;
		}
		try {
			if (!this.fs.existsSync(this.storeDir)) {
				this.fs.mkdirSync(this.storeDir, { recursive: true });
			}

			// Stale-snapshot guard: if the on-disk epoch is HIGHER than what we
			// last loaded AND we have not yet written anything this process, refuse
			// — we'd be clobbering newer state (e.g. cloud-sync / antivirus / manual
			// restore from .pre-migration backup under a running gateway).
			// The first write always performs the full read/parse. Only after our own
			// successful rename may an unchanged fingerprint reuse the known epoch.
			const currentFingerprint = this.currentDiskFingerprint();
			const onDiskEpoch = this.writtenEpoch > 0
				&& SessionStore.fingerprintsEqual(currentFingerprint, this.diskFingerprint)
				? Math.max(this.loadedEpoch, this.writtenEpoch)
				: this.peekDiskEpoch();
			if (onDiskEpoch > this.loadedEpoch && this.writtenEpoch === 0) {
				console.error(
					`[session-store] REFUSING to save: on-disk epoch ${onDiskEpoch} is ` +
					`newer than loaded epoch ${this.loadedEpoch}. Possible stale-snapshot ` +
					`recovery (cloud sync / antivirus / .pre-migration). ` +
					`In-memory state has ${this.sessions.size} sessions; on-disk has more recent. ` +
					`Manual intervention required: inspect ${this.storeFile} and ${this.storeFile}.bak.*`,
				);
				this.staleGuardTripped = true;
				return;
			}

			const nextEpoch = Math.max(this.loadedEpoch, this.writtenEpoch, onDiskEpoch < 0 ? 0 : onDiskEpoch) + 1;
			const payload = {
				version: 2 as const,
				epoch: nextEpoch,
				sessions: Array.from(this.sessions.values()),
			};
			const json = JSON.stringify(payload);

			// Rotate .bak (keep N=5) before writing — best-effort.
			this.rotateBackups();

			// Atomic: write to .tmp, fsync, rename.
			const tmp = `${this.storeFile}.tmp`;
			const fd = this.fs.openSync(tmp, "w");
			try {
				this.fs.writeFileSync(fd, json, "utf-8");
				try { this.fs.fsyncSync(fd); } catch { /* fsync may fail on Windows network shares — non-fatal */ }
			} finally {
				this.fs.closeSync(fd);
			}
			this.fs.renameSync(tmp, this.storeFile);
			this.writtenEpoch = nextEpoch;
			// Refresh only after the atomic replacement succeeds. A stat failure
			// leaves the fast path disabled so the next save performs full validation.
			this.diskFingerprint = this.currentDiskFingerprint();
		} catch (err) {
			console.error("[session-store] Failed to save sessions:", err);
			// Best-effort cleanup of stray .tmp from a failed write.
			try {
				const tmp = `${this.storeFile}.tmp`;
				if (this.fs.existsSync(tmp)) this.fs.unlinkSync(tmp);
			} catch { /* ignore */ }
		}
	}

	/** Promise-based save preserving epoch checks, backups, fsync, and atomic rename. */
	private async saveNowAsync(): Promise<void> {
		if (this.staleGuardTripped) return;
		try {
			await this.fs.promises.mkdir(this.storeDir, { recursive: true });

			const currentFingerprint = await this.currentDiskFingerprintAsync();
			const onDiskEpoch = this.writtenEpoch > 0
				&& SessionStore.fingerprintsEqual(currentFingerprint, this.diskFingerprint)
				? Math.max(this.loadedEpoch, this.writtenEpoch)
				: await this.peekDiskEpochAsync();
			if (onDiskEpoch > this.loadedEpoch && this.writtenEpoch === 0) {
				console.error(
					`[session-store] REFUSING to save: on-disk epoch ${onDiskEpoch} is ` +
					`newer than loaded epoch ${this.loadedEpoch}. Possible stale-snapshot ` +
					`recovery (cloud sync / antivirus / .pre-migration). ` +
					`In-memory state has ${this.sessions.size} sessions; on-disk has more recent. ` +
					`Manual intervention required: inspect ${this.storeFile} and ${this.storeFile}.bak.*`,
				);
				this.staleGuardTripped = true;
				return;
			}

			const nextEpoch = Math.max(this.loadedEpoch, this.writtenEpoch, onDiskEpoch < 0 ? 0 : onDiskEpoch) + 1;
			const payload = {
				version: 2 as const,
				epoch: nextEpoch,
				sessions: Array.from(this.sessions.values()),
			};
			const json = JSON.stringify(payload);

			await this.rotateBackupsAsync();

			const tmp = `${this.storeFile}.tmp`;
			const handle = await this.fs.promises.open(tmp, "w");
			try {
				await handle.writeFile(json, "utf-8");
				try { await handle.sync(); } catch { /* non-fatal on network shares */ }
			} finally {
				await handle.close();
			}
			await this.fs.promises.rename(tmp, this.storeFile);
			this.writtenEpoch = nextEpoch;
			this.diskFingerprint = await this.currentDiskFingerprintAsync();
		} catch (err) {
			console.error("[session-store] Failed to save sessions:", err);
			try { await this.fs.promises.unlink(`${this.storeFile}.tmp`); } catch { /* ignore */ }
		}
	}

	private async drainAsyncSaves(): Promise<void> {
		do {
			this.asyncSaveRequested = false;
			await this.saveNowAsync();
		} while (this.asyncSaveRequested);
	}

	private requestAsyncSave(): Promise<void> {
		this.asyncSaveRequested = true;
		if (!this.asyncSaveInFlight) {
			const task = this.drainAsyncSaves();
			this.asyncSaveInFlight = task;
			void task.then(() => {
				if (this.asyncSaveInFlight === task) this.asyncSaveInFlight = null;
			});
		}
		return this.asyncSaveInFlight;
	}

	/**
	 * Walk `agentSessionsRoot` for `*.jsonl` transcripts that are not referenced
	 * by any persisted session (`agentSessionFile`) and whose mtime is newer
	 * than the most recent `lastActivity` in the store. Useful as a divergence
	 * signal after crash recovery — the agent CLI may have written transcripts
	 * that never made it into the session-metadata index.
	 *
	 * Does NOT auto-import. Caps the returned `paths` at `maxPaths` (default 50)
	 * and emits at most 20 `[session-store] WARN: orphaned transcript: …` log
	 * lines.
	 */
	scanOrphanedTranscripts(
		agentSessionsRoot: string,
		options: { mostRecentLastActivity?: number; maxPaths?: number; maxLogLines?: number } = {},
	): { count: number; paths: string[] } {
		const maxPaths = options.maxPaths ?? 50;
		const maxLogLines = options.maxLogLines ?? 20;
		const threshold = options.mostRecentLastActivity ?? this.computeMostRecentLastActivity();

		const tracked = new Set<string>();
		for (const s of this.sessions.values()) {
			if (s.agentSessionFile) {
				tracked.add(path.resolve(s.agentSessionFile));
			}
		}

		const paths: string[] = [];
		let count = 0;
		let logged = 0;

		const walk = (dir: string) => {
			let entries: Dirent[];
			try {
				entries = this.fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const ent of entries) {
				const full = path.join(dir, ent.name);
				if (ent.isDirectory()) {
					walk(full);
					continue;
				}
				if (!ent.isFile()) continue;
				if (!ent.name.endsWith(".jsonl")) continue;
				const resolved = path.resolve(full);
				if (tracked.has(resolved)) continue;
				try {
					const st = this.fs.statSync(full);
					if (st.mtimeMs < threshold) continue;
				} catch {
					continue;
				}
				count++;
				if (paths.length < maxPaths) paths.push(resolved);
				if (logged < maxLogLines) {
					console.warn(`[session-store] WARN: orphaned transcript: ${resolved}`);
					logged++;
				}
			}
		};

		try {
			if (this.fs.existsSync(agentSessionsRoot)) walk(agentSessionsRoot);
		} catch {
			// non-fatal — return whatever we collected
		}

		return { count, paths };
	}

	private computeMostRecentLastActivity(): number {
		let max = 0;
		for (const s of this.sessions.values()) {
			if (typeof s.lastActivity === "number" && s.lastActivity > max) max = s.lastActivity;
		}
		return max;
	}

	/** Schedule a debounced save — coalesces rapid writes into one disk flush. */
	private save(): void {
		if (this.saveTimer) return; // already scheduled
		this.saveTimer = this.clock.setTimeout(() => {
			this.saveTimer = null;
			this.saveNow();
		}, SessionStore.SAVE_DEBOUNCE_MS);
	}

	/** Current generation counter — bumped on every mutation. */
	getGeneration(): number {
		return this.generation;
	}

	/** Optional callback invoked after any session mutation (put/update/archive). */
	onIndexUpdate?: (session: PersistedSession) => void;

	put(session: PersistedSession): void {
		this.generation++;
		this.sessions.set(session.id, session);
		this.saveNow(); // immediate — structural change
		this.onIndexUpdate?.(session);
	}

	get(id: string): PersistedSession | undefined {
		return this.sessions.get(id);
	}

	remove(id: string): void {
		this.generation++;
		this.sessions.delete(id);
		this.saveNow(); // immediate — structural change
		// Durably tombstone this hard-delete so the boot-time headquarters
		// migration does not resurrect the record from a stale
		// `.pre-headquarters-id-migration` backup on the next restart.
		recordDeletionTombstone(this.storeDir, "sessions.json", id);
	}

	getAll(): PersistedSession[] {
		return Array.from(this.sessions.values());
	}

	/**
	 * Fields whose persistence is required for the session to survive a hard
	 * restart (kill -9, OS crash, container OOM). When any of these change we
	 * flush synchronously instead of going through the 1s save debounce —
	 * otherwise the gateway can advertise the session as `idle` to the API
	 * before the recovery-critical disk write has landed, and a kill in that
	 * window archives the session on next boot.
	 *
	 * Lower-frequency by nature, so synchronous writes are not a perf concern.
	 * `lastActivity` / `lastReadAt` are intentionally excluded — they fire on
	 * every event and benefit from coalescing.
	 */
	private static RECOVERY_CRITICAL_FIELDS: ReadonlyArray<keyof UpdatableSessionFields> = [
		"agentSessionFile", "branch", "worktreePath", "cwd", "repoPath",
		"repoWorktrees", "archived", "archivedAt",
		"sandboxed", "projectId", "goalId", "delegateOf",
		"parentSessionId", "childKind", "readOnly", "childTerminal", "terminalAt",
		"role", "assistantType", "taskId", "staffId",
		"teamGoalId", "teamLeadSessionId",
		"modelProvider", "modelId",
		"inFlightSteerTexts",
		"sidePanelWorkspace",
	];

	/** Update a subset of fields for an existing session */
	update(id: string, updates: Partial<UpdatableSessionFields>): void {
		const existing = this.sessions.get(id);
		if (!existing) return;
		this.generation++;
		Object.assign(existing, updates);

		// Recovery-critical fields must survive a hard kill — flush synchronously.
		const critical = SessionStore.RECOVERY_CRITICAL_FIELDS.some(f => f in updates);
		if (critical) {
			// If a debounced save is pending, cancel it — saveNow supersedes it.
			if (this.saveTimer) { this.clock.clearTimeout(this.saveTimer); this.saveTimer = null; }
			this.saveNow();
		} else {
			this.save(); // debounced — high-frequency, non-critical (lastActivity, lastReadAt, drafts, queue)
		}

		// Only notify on meaningful field changes (skip high-frequency activity updates)
		if (updates.title !== undefined || updates.archived !== undefined || updates.role !== undefined || updates.goalId !== undefined) {
			this.onIndexUpdate?.(existing);
		}
	}


	/** Get a draft for a session by type. */
	getDraft(sessionId: string, type: string): unknown | undefined {
		const session = this.sessions.get(sessionId);
		if (!session?.drafts) return undefined;
		return session.drafts[type];
	}

	/** Set a draft for a session by type. Triggers debounced save. */
	setDraft(sessionId: string, type: string, data: unknown): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) return false;
		// Reject stale writes: if both the incoming and existing drafts carry a
		// `gen` field, only accept the write when the incoming gen is >= existing.
		// This prevents out-of-order HTTP requests from resurrecting a draft that
		// was already cleared by a newer tombstone (e.g. send clears with gen=2,
		// but a delayed save from gen=1 arrives after).
		if (data && typeof data === "object" && "gen" in (data as Record<string, unknown>)) {
			const incomingGen = (data as Record<string, unknown>).gen;
			const existing = session.drafts?.[type];
			if (existing && typeof existing === "object" && "gen" in (existing as Record<string, unknown>)) {
				const existingGen = (existing as Record<string, unknown>).gen;
				if (typeof incomingGen === "number" && typeof existingGen === "number" && incomingGen < existingGen) {
					return true; // Silently discard stale write — not an error
				}
			}
		}
		this.generation++;
		if (!session.drafts) session.drafts = {};
		session.drafts[type] = data;
		this.save();
		return true;
	}

	/** Delete a draft for a session by type. Triggers debounced save. */
	deleteDraft(sessionId: string, type: string): boolean {
		const session = this.sessions.get(sessionId);
		if (!session?.drafts) return false;
		this.generation++;
		delete session.drafts[type];
		// Clean up empty drafts object
		if (Object.keys(session.drafts).length === 0) {
			delete session.drafts;
		}
		this.save();
		return true;
	}

	/** Mark a session as archived. */
	archive(id: string): boolean {
		const existing = this.sessions.get(id);
		if (!existing) return false;
		this.generation++;
		existing.archived = true;
		existing.archivedAt = this.clock.now();
		this.saveNow(); // immediate — structural change
		this.onIndexUpdate?.(existing);
		return true;
	}

	/** Get all archived sessions. */
	getArchived(): PersistedSession[] {
		return Array.from(this.sessions.values()).filter(s => s.archived === true);
	}

	/**
	 * Paginated listing of archived sessions, sorted by archivedAt DESC.
	 * @param limit Max items per page
	 * @param afterCursor archivedAt timestamp — return items with archivedAt < cursor
	 */
	listArchivedSessionsPaginated(limit: number, afterCursor?: number): { sessions: PersistedSession[]; total: number; hasMore: boolean; nextCursor?: number } {
		let archived = this.getArchived().sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
		const total = archived.length;
		if (afterCursor !== undefined) {
			archived = archived.filter(s => (s.archivedAt ?? 0) < afterCursor);
		}
		const page = archived.slice(0, limit);
		const hasMore = archived.length > limit;
		const nextCursor = page.length > 0 ? page[page.length - 1].archivedAt : undefined;
		return { sessions: page, total, hasMore, nextCursor };
	}

	/** Get all live (non-archived) sessions. */
	getLive(): PersistedSession[] {
		return Array.from(this.sessions.values()).filter(s => !s.archived);
	}

	/** Permanently remove an archived session from the store. */
	purge(id: string): boolean {
		const existing = this.sessions.get(id);
		if (!existing) return false;
		this.generation++;
		this.sessions.delete(id);
		this.saveNow();
		// purge() is a permanent hard-delete, exactly like remove() — durably
		// tombstone it so the boot-time headquarters migration does not resurrect
		// the record from a stale `.pre-headquarters-id-migration` backup.
		recordDeletionTombstone(this.storeDir, "sessions.json", id);
		return true;
	}

	/**
	 * Promise-based archive purge. The store row is durably saved before its
	 * tombstone, and synchronous mutations that arrive while either save is
	 * pending are folded into the serialized writer rather than overwritten.
	 */
	async purgeAsync(id: string): Promise<boolean> {
		const existing = this.sessions.get(id);
		if (!existing) {
			if (this.asyncSaveInFlight) await this.asyncSaveInFlight;
			return false;
		}
		this.generation++;
		this.sessions.delete(id);
		if (this.saveTimer) {
			this.clock.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		await this.requestAsyncSave();
		await recordDeletionTombstoneAsync(this.storeDir, "sessions.json", id, this.fs.promises);
		return true;
	}

	/** Flush any pending debounced save immediately (e.g. before shutdown). */
	flush(): void {
		if (this.saveTimer) {
			this.clock.clearTimeout(this.saveTimer);
			this.saveTimer = null;
			this.saveNow();
		}
	}
}
