import type { Clock, FsLike } from "../gateway-deps.js";
import { realClock, realFs } from "../gateway-deps.js";
import path from "node:path";
import { recordDeletionTombstone, recordDeletionTombstoneAsync } from "./deletion-tombstones.js";
import { isMessageAuthor, LOCAL_USER_AUTHOR, type MessageAuthor } from "../../shared/message-author.js";
import { isPromptSource, type PromptSource } from "../../shared/prompt-source.js";
import type {
	DeliveryIntentKind,
	DeliveryState,
	DeliveryTargetTurn,
	QueuedMessage,
} from "../ws/protocol.js";
import type { SidePanelWorkspace } from "../../shared/side-panel-workspace.js";
import type { ThinkingLevel } from "../../shared/thinking-levels.js";
import type { SessionRuntime } from "./session-runtime.js";

const VERIFIER_SESSION_ID_RE = /^(?:llm-review|agent-qa)-/;

function isVerifierSessionId(id: string): boolean {
	return VERIFIER_SESSION_ID_RE.test(id);
}

function defaultVerifierAccessory(id: string): string {
	return id.startsWith("agent-qa-") ? "stamp" : "magnifier";
}

/** Legacy persisted value. Retained only so older session records remain readable. */
export type WorktreePushPolicy = "local-only" | "publish";

export type InFlightAttemptState = Extract<DeliveryState, "dispatching" | "received" | "uncertain">;

/** A user intent handed to Pi and retained until its exact user-message end is durably settled. */
export interface InFlightSteerRecord {
	/** Unprefixed durable base model text. The author sidecar proves any per-RPC decoration. */
	text: string;
	/** Legacy-compatible sidecar correlation id. Modern dispatches keep it attempt-unique. */
	promptId: string;
	/** Stable accepted occurrence identity, shared with QueuedMessage.id and WS projections. */
	intentId?: string;
	/** One Pi delivery attempt. It must not be replaced while its outcome is ambiguous. */
	attemptId?: string;
	/** Monotonic dispatch evidence used to reject stale attempt events after restore. */
	dispatchEpoch?: number;
	state?: InFlightAttemptState;
	targetTurn?: DeliveryTargetTurn;
	sequence?: number;
	/** Original accepted occurrence metadata; required for identity-preserving restore. */
	kind?: DeliveryIntentKind;
	createdAt?: number;
	/** Ambiguous attempts are not retryable until a terminal no-start proof retires them. */
	retryable?: boolean;
	source?: PromptSource;
	author?: MessageAuthor;
	images?: Array<{ type: "image"; data: string; mimeType: string }>;
	attachments?: unknown[];
	suppressTitleGen?: boolean;
}

/** The persisted boundary accepts legacy string-only steer ledgers. */
export type PersistedInFlightSteer = string | InFlightSteerRecord;

function validLedgerKey(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function validLedgerInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Normalize persisted dispatch evidence and migrate legacy string/structured
 * rows. Modern active attempts are unique by intent id; when corrupt state
 * contains two, the first durable occurrence wins and later rows are ignored.
 * Legacy rows retain their historical shape so the existing restore reconciler
 * can migrate them without pretending they carry modern attempt evidence.
 */
export function normalizePersistedInFlightSteers(
	entries: readonly PersistedInFlightSteer[] | undefined,
): InFlightSteerRecord[] | undefined {
	if (!entries || entries.length === 0) return undefined;
	const records: InFlightSteerRecord[] = [];
	const activeIntentIds = new Set<string>();
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (typeof entry === "string") {
			if (entry.length === 0) continue;
			records.push({
				text: entry,
				promptId: `legacy-inflight-steer:${index}`,
				source: "user",
				author: { ...LOCAL_USER_AUTHOR },
			});
			continue;
		}
		if (!entry || typeof entry !== "object" || typeof entry.text !== "string" || entry.text.length === 0) {
			continue;
		}

		const promptId = validLedgerKey(entry.promptId)
			? entry.promptId
			: `legacy-inflight-steer:${index}`;
		const modernAttempt = validLedgerKey(entry.intentId)
			&& validLedgerKey(entry.attemptId)
			&& validLedgerInteger(entry.dispatchEpoch);
		if (modernAttempt && activeIntentIds.has(entry.intentId!)) continue;
		if (modernAttempt) activeIntentIds.add(entry.intentId!);
		const record: InFlightSteerRecord = modernAttempt
			? {
				text: entry.text,
				promptId,
				intentId: entry.intentId,
				attemptId: entry.attemptId,
				dispatchEpoch: entry.dispatchEpoch,
				state: entry.state === "dispatching" || entry.state === "received" || entry.state === "uncertain"
					? entry.state
					: "uncertain",
				targetTurn: entry.targetTurn === "next-turn" || entry.targetTurn === "continuation"
					? entry.targetTurn
					: "continuation",
				sequence: validLedgerInteger(entry.sequence) ? entry.sequence : index + 1,
				kind: entry.kind === "prompt" || entry.kind === "steer" ? entry.kind : "steer",
				createdAt: validLedgerInteger(entry.createdAt) ? entry.createdAt : entry.dispatchEpoch,
				retryable: typeof entry.retryable === "boolean" ? entry.retryable : false,
			}
			: { text: entry.text, promptId };
		if (isPromptSource(entry.source)) record.source = entry.source;
		if (isMessageAuthor(entry.author)) {
			record.author = entry.author;
			if (record.source === undefined) record.source = entry.author.kind;
		}
		if (Array.isArray(entry.images)) record.images = entry.images;
		if (Array.isArray(entry.attachments)) record.attachments = entry.attachments;
		if (entry.suppressTitleGen === true) record.suppressTitleGen = true;
		records.push(record);
	}
	return records.length > 0 ? records : undefined;
}

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
	/** Durable user-owned session metadata. Missing legacy values normalize to an empty array. */
	user_tags?: string[];
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
	/** This writable session uses another session's worktree but never owns its teardown. */
	borrowsWorktree?: boolean;
	/** Flattened session id of the sandbox worktree lifecycle owner. Provenance only. */
	borrowedWorktreeOwnerSessionId?: string;
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
	/** Durable manual-retry recovery state for queued work parked after a terminal failure. */
	manualRetryRequired?: boolean;
	/** Steers accepted for dispatch but not yet echoed; strings are legacy rows. */
	inFlightSteerTexts?: PersistedInFlightSteer[];
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
	/** Explicit bridge runtime. Absent legacy records remain Pi-backed. */
	runtime?: SessionRuntime;
	/** Opaque Agent SDK session UUID used only for SDK resume. */
	claudeAgentSdkSessionId?: string;
	/** Model provider (e.g. "anthropic") — persisted so archived sessions can display model info */
	modelProvider?: string;
	/** Model ID (e.g. "claude-sonnet-4-20250514") — persisted so archived sessions can display model info */
	modelId?: string;
	/** Effective thinking level verified with the exact persisted provider/model pair. */
	effectiveThinkingLevel?: ThinkingLevel;
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
	| "user_tags"
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
	| "borrowsWorktree"
	| "borrowedWorktreeOwnerSessionId"
	| "assistantType"
	| "goalAssistant"
	| "roleAssistant"
	| "toolAssistant"
	| "taskId"
	| "staffId"
	| "accessory"
	| "preview"
	| "messageQueue"
	| "manualRetryRequired"
	| "inFlightSteerTexts"
	| "archived"
	| "archivedAt"
	| "repoPath"
	| "branch"
	| "nonInteractive"
	| "cwd"
	| "reattemptGoalId"
	| "runtime"
	| "claudeAgentSdkSessionId"
	| "modelProvider"
	| "modelId"
	| "effectiveThinkingLevel"
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
	/** Optional because FsLike deliberately supports lightweight injected filesystems. */
	open?: typeof import("node:fs").promises.open;
};

type SessionStoreFs = FsLike & {
	promises: SessionStoreAsyncFs;
};

type DiskFingerprint = {
	size: number;
	mtimeMs: number;
	/** Required: without a change-time value metadata is not a safe fast-path. */
	ctimeMs: number;
};

export interface PersistenceMetrics {
	bytes: number;
	durationMs: number;
}

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
	/** Highest mutation generation included in a successful atomic rename. */
	private publishedGeneration = 0;
	/** Failure sequence lets explicit barriers reject while hot-path callers log. */
	private persistenceFailureSequence = 0;
	private lastPersistenceError: unknown = null;
	private lastPersistenceMetrics: PersistenceMetrics | null = null;

	/**
	 * Serialize whole-file publication across store instances in this process.
	 * A per-instance drain is insufficient: two independently constructed
	 * stores otherwise both rotate backups and write the shared `.tmp` path.
	 */
	private static fileWriteTails = new Map<string, Promise<void>>();

	constructor(stateDir: string, fsImpl: FsLike = realFs, clock: Clock = realClock) {
		this.fs = fsImpl as SessionStoreFs;
		this.clock = clock;
		this.storeDir = stateDir;
		this.storeFile = path.join(stateDir, "sessions.json");
		this.load();
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
			if (Array.isArray(s.inFlightSteerTexts)) {
				s.inFlightSteerTexts = normalizePersistedInFlightSteers(s.inFlightSteerTexts);
			} else if (s.inFlightSteerTexts !== undefined) {
				s.inFlightSteerTexts = undefined;
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


	private static fingerprintsEqual(a: DiskFingerprint | null, b: DiskFingerprint | null): boolean {
		return a !== null && b !== null
			&& a.size === b.size
			&& a.mtimeMs === b.mtimeMs
			&& a.ctimeMs === b.ctimeMs;
	}

	/**
	 * Atomically reserve this file's write slot before awaiting the prior writer.
	 * The reservation, rather than a best-effort `.tmp` convention, prevents two
	 * SessionStore instances from interleaving backup rotation and tmp+rename.
	 */
	private async withFileWriteFence<T>(write: () => Promise<T>): Promise<T> {
		const key = path.resolve(this.storeFile);
		const previous = SessionStore.fileWriteTails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const completion = new Promise<void>((resolve) => { release = resolve; });
		const tail = previous.catch(() => undefined).then(() => completion);
		SessionStore.fileWriteTails.set(key, tail);
		await previous.catch(() => undefined);
		try {
			return await write();
		} finally {
			release();
			if (SessionStore.fileWriteTails.get(key) === tail) {
				SessionStore.fileWriteTails.delete(key);
			}
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
			// Size + mtime is not a sufficient identity on filesystems that expose
			// coarse timestamp resolution. Re-read the epoch when ctime is absent
			// instead of treating an external same-size rewrite as our own write.
			if (!Number.isFinite(size) || !Number.isFinite(mtimeMs) || !Number.isFinite(ctimeMs)) return null;
			return { size, mtimeMs, ctimeMs };
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


	/**
	 * Immediately join the serialized async writer for structural mutations.
	 * Entering the writer performs no filesystem operation on this call stack;
	 * the first write yields to `fs.promises` and subsequent mutations coalesce
	 * into its trailing drain iteration.
	 */
	private saveNow(): void {
		if (this.saveTimer) {
			this.clock.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		void this.requestAsyncSave();
	}

	/** Promise-based save preserving epoch checks, backups, fsync, and atomic rename. */
	private async saveNowAsync(): Promise<number> {
		return this.withFileWriteFence(() => this.saveNowUnlockedAsync());
	}

	/** Runs inside the per-file fence so check, backup rotation, and rename agree. */
	private async saveNowUnlockedAsync(): Promise<number> {
		if (this.staleGuardTripped) {
			throw new Error("Session persistence refused: stale-snapshot guard is active");
		}
		const startedAt = performance.now();
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
				throw new Error(`Session persistence refused: on-disk epoch ${onDiskEpoch} is newer than loaded epoch ${this.loadedEpoch}`);
			}

			const nextEpoch = Math.max(this.loadedEpoch, this.writtenEpoch, onDiskEpoch < 0 ? 0 : onDiskEpoch) + 1;
			const payload = {
				version: 2 as const,
				epoch: nextEpoch,
				sessions: Array.from(this.sessions.values()),
			};
			const json = JSON.stringify(payload);
			// Snapshot after serialization. A mutation which was already folded
			// into this payload must not force an identical trailing rewrite.
			const serializedGeneration = this.generation;

			await this.rotateBackupsAsync();

			const tmp = `${this.storeFile}.tmp`;
			// FsLike intentionally has a small async surface so memfs and other
			// injected filesystems need not implement FileHandle.open/sync/close.
			// Use fsync when the richer real-fs API is available, otherwise retain
			// the same atomic tmp+rename publish contract with writeFile.
			if (this.fs.promises.open) {
				const handle = await this.fs.promises.open(tmp, "w");
				try {
					await handle.writeFile(json, "utf-8");
					try { await handle.sync(); } catch { /* non-fatal on network shares */ }
				} finally {
					await handle.close();
				}
			} else {
				await this.fs.promises.writeFile(tmp, json, "utf-8");
			}
			await this.fs.promises.rename(tmp, this.storeFile);
			this.writtenEpoch = nextEpoch;
			this.lastPersistenceMetrics = { bytes: Buffer.byteLength(json), durationMs: performance.now() - startedAt };
			this.diskFingerprint = await this.currentDiskFingerprintAsync();
			return serializedGeneration;
		} catch (err) {
			try { await this.fs.promises.unlink(`${this.storeFile}.tmp`); } catch { /* ignore */ }
			throw err;
		}
	}

	private async drainAsyncSaves(): Promise<void> {
		try {
			do {
				this.asyncSaveRequested = false;
				try {
					const serializedGeneration = await this.saveNowAsync();
					this.publishedGeneration = Math.max(this.publishedGeneration, serializedGeneration);
					this.lastPersistenceError = null;
					// `saveNow()` marks an active writer requested. If that mutation
					// arrived before this write captured its JSON payload, it is already
					// durable and should remain coalesced rather than duplicating an epoch.
					if (this.asyncSaveRequested && this.generation <= serializedGeneration) {
						this.asyncSaveRequested = false;
					}
				} catch (err) {
					this.persistenceFailureSequence++;
					this.lastPersistenceError = err;
					// The stale guard already emitted its actionable REFUSING diagnostic.
					// Keep hot-path retries quiet while explicit barriers still reject.
					if (!this.staleGuardTripped) console.error("[session-store] Failed to save sessions:", err);
					// Do not spin on a broken disk. A later mutation or explicit barrier
					// may retry; barriers observe this failure instead of false success.
					this.asyncSaveRequested = false;
					return;
				}
			} while (this.asyncSaveRequested);
		} finally {
			// Publish the idle state in the drain's own final continuation, before
			// its promise can settle. A mutation in the following microtask must
			// either see this writer as active and request another loop iteration,
			// or see it as idle and persist/start a new writer itself. Clearing the
			// state from a later `.then()` leaves a window where that mutation can
			// mark an already-completed writer and lose its save request.
			this.asyncSaveInFlight = null;
			if (this.asyncSaveRequested) void this.requestAsyncSave();
		}
	}

	private requestAsyncSave(): Promise<void> {
		this.asyncSaveRequested = true;
		let task = this.asyncSaveInFlight;
		if (!task) {
			task = this.drainAsyncSaves();
			this.asyncSaveInFlight = task;
		}
		return task;
	}

	/** Schedule a debounced save — coalesces rapid writes into one disk flush. */
	private save(): void {
		if (this.saveTimer) return; // already scheduled
		this.saveTimer = this.clock.setTimeout(() => {
			this.saveTimer = null;
			void this.requestAsyncSave();
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
	 * restart (kill -9, OS crash, container OOM). They bypass the high-frequency
	 * activity debounce and enter the serialized async writer immediately; the
	 * public `flush()`/`flushAsync()` paths retain shutdown durability.
	 *
	 * `lastActivity` is intentionally excluded because genuine activity can be
	 * high-frequency and benefits from coalescing. `lastReadAt` normally shares
	 * that path, while the mark-read API explicitly awaits `flushAsync()` before
	 * acknowledging so a successful read survives graceful restart.
	 */
	private static RECOVERY_CRITICAL_FIELDS: ReadonlyArray<keyof UpdatableSessionFields> = [
		"agentSessionFile", "branch", "worktreePath", "cwd", "repoPath",
		"repoWorktrees", "archived", "archivedAt",
		"sandboxed", "projectId", "goalId", "delegateOf",
		"parentSessionId", "childKind", "readOnly", "childTerminal", "terminalAt",
		"role", "assistantType", "taskId", "staffId",
		"teamGoalId", "teamLeadSessionId",
		"modelProvider", "modelId", "effectiveThinkingLevel",
		"messageQueue", "manualRetryRequired", "inFlightSteerTexts", "user_tags",
		"sidePanelWorkspace",
	];

	/** Update a subset of fields for an existing session */
	update(id: string, updates: Partial<UpdatableSessionFields>): void {
		const existing = this.sessions.get(id);
		if (!existing) return;
		this.generation++;
		Object.assign(existing, updates);

		// Recovery-critical fields bypass the high-frequency debounce.
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

	/**
	 * Restore the exact optional-field shape captured before a failed pin write.
	 * Legacy records may omit `user_tags` or contain a malformed raw value, so a
	 * normal typed update cannot faithfully compensate the mutation.
	 */
	restoreUserTagsShape(id: string, present: boolean, value: unknown): boolean {
		const existing = this.sessions.get(id);
		if (!existing) return false;
		this.generation++;
		if (present) {
			(existing as unknown as { user_tags: unknown }).user_tags = value;
		} else {
			delete existing.user_tags;
		}
		if (this.saveTimer) { this.clock.clearTimeout(this.saveTimer); this.saveTimer = null; }
		this.saveNow();
		return true;
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

	/**
	 * Promise-based archive. Preserves archive()'s record mutation and immediate
	 * durability without writing a deletion tombstone. Concurrent synchronous
	 * mutations fold into the same serialized writer rather than racing its
	 * snapshot.
	 */
	async archiveAsync(id: string): Promise<boolean> {
		const existing = this.sessions.get(id);
		if (!existing) {
			if (this.asyncSaveInFlight) await this.asyncSaveInFlight;
			return false;
		}
		const failureSequence = this.persistenceFailureSequence;
		this.generation++;
		const targetGeneration = this.generation;
		existing.archived = true;
		existing.archivedAt = this.clock.now();
		if (this.saveTimer) {
			this.clock.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		await this.persistThroughGeneration(targetGeneration, failureSequence);
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
		const failureSequence = this.persistenceFailureSequence;
		this.generation++;
		const targetGeneration = this.generation;
		this.sessions.delete(id);
		if (this.saveTimer) {
			this.clock.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		// A promise-returning purge is a durability barrier. Never record the
		// migration tombstone as if its matching row deletion had been published
		// when the fenced sessions write was rejected.
		await this.persistThroughGeneration(targetGeneration, failureSequence);
		await recordDeletionTombstoneAsync(this.storeDir, "sessions.json", id, this.fs.promises);
		return true;
	}

	/**
	 * Compatibility barrier for shutdown callers. It is intentionally promise
	 * based: a synchronous wrapper cannot honestly acknowledge an async rename.
	 */
	flush(): Promise<void> {
		return this.flushAsync();
	}

	/** Latest atomic persistence duration and serialized byte count. */
	getPersistenceMetrics(): PersistenceMetrics | null {
		return this.lastPersistenceMetrics;
	}

	/**
	 * Await all pending persistence for async shutdown paths and focused tests.
	 * Repeat through a settlement-boundary handoff so a synchronous mutation
	 * queued by a completion reaction cannot be left behind.
	 */
	async flushAsync(): Promise<void> {
		if (this.saveTimer) {
			this.clock.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		await this.persistThroughGeneration(this.generation, this.persistenceFailureSequence);
	}

	/**
	 * Wait until one fixed mutation generation is atomically published.
	 * Do not start a speculative zero-generation writer: it can outlive a flush
	 * caller and leaves a settlement-boundary mutation attached to a stale drain.
	 */
	private async persistThroughGeneration(targetGeneration: number, failureSequence: number): Promise<void> {
		// Stop as soon as this call's generation is durable; unrelated traffic
		// must not make creation/shutdown barriers wait indefinitely.
		while (this.publishedGeneration < targetGeneration) {
			const pending = this.asyncSaveInFlight ?? this.requestAsyncSave();
			await pending;
			if (this.persistenceFailureSequence !== failureSequence) {
				throw this.lastPersistenceError ?? new Error("Session persistence failed");
			}
		}
		if (this.persistenceFailureSequence !== failureSequence) {
			throw this.lastPersistenceError ?? new Error("Session persistence failed");
		}
	}
}
