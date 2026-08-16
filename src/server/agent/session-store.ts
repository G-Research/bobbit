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
 * rows. Modern active attempts are unique by intent id. Every historical
 * row is upgraded to a distinct deterministic uncertain carrier so recovery
 * never correlates or replays work by its text body.
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
			const intentId = `legacy-inflight-steer:${index}`;
			if (activeIntentIds.has(intentId)) continue;
			activeIntentIds.add(intentId);
			records.push({
				text: entry,
				promptId: intentId,
				intentId,
				attemptId: `attempt:legacy-inflight:${intentId}`,
				dispatchEpoch: index,
				state: "uncertain",
				targetTurn: "continuation",
				sequence: index + 1,
				kind: "steer",
				createdAt: index,
				retryable: false,
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
		const completeModernAttempt = validLedgerKey(entry.intentId)
			&& validLedgerKey(entry.attemptId)
			&& validLedgerInteger(entry.dispatchEpoch);
		// Pre-reliable records were accepted by Pi without an occurrence tuple.
		// Migrate each persisted position into a stable, fail-closed carrier rather
		// than trying to correlate it by body text. A completed modern tuple keeps
		// its identity; malformed/old tuples get a deterministic legacy identity.
		// An existing reliable occurrence identity is authoritative. A second
		// persisted active record claiming it cannot be safely replayed, settled, or
		// reminted as distinct work, so retain the first occurrence and drop it.
		if (validLedgerKey(entry.intentId) && activeIntentIds.has(entry.intentId)) continue;
		const baseIntentId = completeModernAttempt
			? entry.intentId!
			: validLedgerKey(entry.intentId)
				? entry.intentId
				: `legacy-inflight-steer:${promptId}`;
		let intentId = baseIntentId;
		let duplicate = 1;
		while (activeIntentIds.has(intentId)) intentId = `${baseIntentId}:${duplicate++}`;
		activeIntentIds.add(intentId);
		const modernAttempt = completeModernAttempt && intentId === entry.intentId;
		const dispatchEpoch = modernAttempt
			? entry.dispatchEpoch!
			: validLedgerInteger(entry.dispatchEpoch)
				? entry.dispatchEpoch
				: validLedgerInteger(entry.createdAt)
					? entry.createdAt
					: index;
		const record: InFlightSteerRecord = {
			text: entry.text,
			promptId,
			intentId,
			attemptId: modernAttempt ? entry.attemptId : `attempt:legacy-inflight:${intentId}`,
			dispatchEpoch,
			// Historical handoffs cannot be safely retried or treated as echoed.
			state: modernAttempt && (entry.state === "dispatching" || entry.state === "received" || entry.state === "uncertain")
				? entry.state
				: "uncertain",
			targetTurn: entry.targetTurn === "next-turn" || entry.targetTurn === "continuation"
				? entry.targetTurn
				: "continuation",
			sequence: validLedgerInteger(entry.sequence) ? entry.sequence : index + 1,
			kind: entry.kind === "prompt" || entry.kind === "steer" ? entry.kind : "steer",
			createdAt: validLedgerInteger(entry.createdAt) ? entry.createdAt : dispatchEpoch,
			retryable: modernAttempt && typeof entry.retryable === "boolean" ? entry.retryable : false,
		};
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
	/** Bytes actually serialized for each independently persisted tier. */
	liveBytes?: number;
	archivedBytes?: number;
}

export type SessionTier = "live" | "archived";
type TierPersistenceState = {
	file: string;
	loadedEpoch: number;
	/** True only when this process recovered a parseable envelope for the tier. */
	loadedSnapshot: boolean;
	writtenEpoch: number;
	diskFingerprint: DiskFingerprint | null;
	staleGuardTripped: boolean;
	dirtyGeneration: number;
	publishedGeneration: number;
};
type TransitionEntry = { id: string; tier: SessionTier; session?: PersistedSession };
type TransitionEpoch = { base: number; target: number };
type TransitionIntent = {
	version: 2;
	entries: TransitionEntry[];
	epochs: Record<SessionTier, TransitionEpoch>;
};
type ActiveTransitionRecovery = {
	intent: TransitionIntent;
	/** Exact post-intent rows, frozen before any later in-memory mutation. */
	rowsJson: Record<SessionTier, string>;
	/** The only generation this interrupted pair is allowed to publish. */
	generation: number;
};
type TransitionIntentBinding = "exact" | "absent" | "mismatch";
type TransitionIntentCleanup = "removed" | "absent" | "mismatch";
type PreparedTierWrite = {
	tier: SessionTier;
	baseEpoch: number;
	targetEpoch: number;
	payload: string;
	payloadBytes: number;
};
type LegacySnapshot = { raw: string; rows: unknown[]; epoch: number; source: string };

export class SessionStore {
	private readonly storeDir: string;
	private readonly storeFile: string;
	private readonly transitionFile: string;
	private readonly fs: SessionStoreFs;
	private readonly clock: Clock;
	private sessions: Map<string, PersistedSession> = new Map();
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private static SAVE_DEBOUNCE_MS = 1000;
	private static BACKUP_COUNT = 5;
	/** Monotonically increasing counter — bumped on every mutation. Resets to 0 on server restart. */
	private generation = 0;
	private readonly tiers: Record<SessionTier, TierPersistenceState>;
	private migrationNeeded = false;
	private tierLayoutNeedsRepair = false;
	/** Ids whose disk tier membership must be normalized on the next save. */
	private readonly tierLayoutRepairIds = new Set<string>();
	/** Malformed rows without an intent-addressable id still need normalization. */
	private tierLayoutHasUnidentifiedRepair = false;
	private legacySnapshot: LegacySnapshot | null = null;
	/** Membership moves waiting for their first, epoch-bound transition intent. */
	private pendingTransitions = new Map<string, TransitionEntry>();
	/** A durable v2 intent with its exact interrupted-pair snapshot. */
	private activeTransitionIntent: ActiveTransitionRecovery | null = null;
	/** A fully published v2 intent left behind by a failed unlink. */
	private transitionIntentCleanup: TransitionIntent | null = null;
	/** Active promise-based purge writer; synchronous mutations fold into it. */
	private asyncSaveInFlight: Promise<void> | null = null;
	private asyncSaveRequested = false;
	/** Highest mutation generation included in a successful atomic rename. */
	private publishedGeneration = 0;
	/** Failure sequence lets explicit barriers reject while hot-path callers log. */
	private persistenceFailureSequence = 0;
	private lastPersistenceError: unknown = null;
	private lastPersistenceMetrics: PersistenceMetrics | null = null;
	/** Legacy delivery ledger rows were upgraded in-memory during load. */
	private loadedDeliveryLedgerMigration = false;

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
		this.transitionFile = `${this.storeFile}.split-transition`;
		this.tiers = {
			live: this.newTier(this.storeFile),
			archived: this.newTier(path.join(stateDir, "sessions.archived.json")),
		};
		this.load();
		// Publish legacy/v2 and delivery-ledger normalization without waiting for a
		// later queue mutation. A v2 source is retained before it is partitioned.
		// Give these boot repairs a real barrier generation so flushAsync() waits.
		if (this.migrationNeeded) this.generation++;
		if (this.tierLayoutNeedsRepair) {
			this.generation++;
			this.tiers.live.dirtyGeneration = this.generation;
			this.tiers.archived.dirtyGeneration = this.generation;
		}
		if (this.loadedDeliveryLedgerMigration && !this.migrationNeeded && !this.tierLayoutNeedsRepair) {
			this.generation++;
			for (const session of this.sessions.values()) this.markMutation(session, session);
		}
		if (this.migrationNeeded || this.tierLayoutNeedsRepair || this.loadedDeliveryLedgerMigration || this.pendingTransitions.size || this.activeTransitionIntent || this.transitionIntentCleanup) this.saveNow();
	}

	private newTier(file: string): TierPersistenceState {
		return { file, loadedEpoch: 0, loadedSnapshot: false, writtenEpoch: 0, diskFingerprint: null, staleGuardTripped: false, dirtyGeneration: 0, publishedGeneration: 0 };
	}

	private tierForSession(session: PersistedSession | undefined): SessionTier {
		return session?.archived === true ? "archived" : "live";
	}

	private tierFile(tier: SessionTier): string { return this.tiers[tier].file; }
	private tierBakPath(tier: SessionTier, n: number): string { return `${this.tierFile(tier)}.bak.${n}`; }
	private tierTmpPath(tier: SessionTier): string { return `${this.tierFile(tier)}.tmp`; }

	private refreshTierLayoutRepairNeeded(): void {
		this.tierLayoutNeedsRepair = this.tierLayoutRepairIds.size > 0 || this.tierLayoutHasUnidentifiedRepair;
	}

	private trackTierLayoutRepair(row: unknown): void {
		if (!row || typeof row !== "object") return;
		const id = (row as PersistedSession).id;
		if (typeof id === "string" && id) this.tierLayoutRepairIds.add(id);
		else this.tierLayoutHasUnidentifiedRepair = true;
		this.refreshTierLayoutRepairNeeded();
	}

	/** An authoritative intent supersedes only the layout conflicts it names. */
	private resolveTierLayoutRepairs(entries: readonly TransitionEntry[]): void {
		for (const entry of entries) this.tierLayoutRepairIds.delete(entry.id);
		this.refreshTierLayoutRepairNeeded();
	}

	/** Mark precisely the tier whose serialized membership changed. */
	private markMutation(previous: PersistedSession | undefined, next: PersistedSession | undefined): void {
		const before = previous ? this.tierForSession(previous) : undefined;
		const after = next ? this.tierForSession(next) : undefined;
		if (before) this.tiers[before].dirtyGeneration = this.generation;
		if (after) this.tiers[after].dirtyGeneration = this.generation;
		if (previous && next && before !== after) {
			this.pendingTransitions.set(next.id, { id: next.id, tier: after!, session: { ...next } });
		} else if (next && this.pendingTransitions.has(next.id)) {
			// Keep an already-published intent's final row current while a batch
			// coalesces additional updates before the tier pair is durable.
			this.pendingTransitions.set(next.id, { id: next.id, tier: after!, session: { ...next } });
		} else if (previous && !next && this.pendingTransitions.has(previous.id)) {
			this.pendingTransitions.set(previous.id, { id: previous.id, tier: before!, session: undefined });
		}
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
				const originalLedger = s.inFlightSteerTexts;
				const normalizedLedger = normalizePersistedInFlightSteers(originalLedger);
				// JSON comparison is intentional at this disk boundary: the normalized
				// shape is JSON-only and a structural difference must be durably saved.
				if (JSON.stringify(originalLedger) !== JSON.stringify(normalizedLedger)) {
					this.loadedDeliveryLedgerMigration = true;
				}
				s.inFlightSteerTexts = normalizedLedger;
			} else if (s.inFlightSteerTexts !== undefined) {
				s.inFlightSteerTexts = undefined;
				this.loadedDeliveryLedgerMigration = true;
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

	private readTierCandidates(tier: SessionTier): { rows: unknown[]; legacy?: LegacySnapshot } {
		const state = this.tiers[tier];
		const candidates = [state.file];
		for (let i = 1; i <= SessionStore.BACKUP_COUNT; i++) candidates.push(this.tierBakPath(tier, i));
		for (const file of candidates) {
			try {
				if (!this.fs.existsSync(file)) continue;
				const raw = this.fs.readFileSync(file, "utf-8");
				const parsed = JSON.parse(raw);
				if (parsed && typeof parsed === "object" && (parsed as { version?: unknown }).version === 3 && Array.isArray((parsed as { sessions?: unknown[] }).sessions)) {
					const obj = parsed as { epoch?: unknown; sessions: unknown[] };
					state.loadedEpoch = typeof obj.epoch === "number" ? obj.epoch : 0;
					state.loadedSnapshot = true;
					if (file !== state.file) console.warn(`[session-store] Loaded from backup ${path.basename(file)} (${tier} tier, epoch ${state.loadedEpoch}) — primary missing/corrupt`);
					return { rows: obj.sessions };
				}
				if (tier === "live" && (Array.isArray(parsed) || (parsed && typeof parsed === "object" && (parsed as { version?: unknown }).version === 2 && Array.isArray((parsed as { sessions?: unknown[] }).sessions)))) {
					const rows = Array.isArray(parsed) ? parsed : (parsed as { sessions: unknown[] }).sessions;
					const epoch = Array.isArray(parsed) ? 0 : typeof (parsed as { epoch?: unknown }).epoch === "number" ? (parsed as { epoch: number }).epoch : 0;
					return { rows, legacy: { raw, rows, epoch, source: file } };
				}
				console.warn(`[session-store] ${file}: unrecognised shape, skipping`);
			} catch (err) { console.warn(`[session-store] Failed to parse ${file}:`, err); }
		}
		return { rows: [] };
	}

	private load(): void {
		const live = this.readTierCandidates("live");
		if (live.legacy) {
			this.legacySnapshot = live.legacy;
			this.tiers.live.loadedEpoch = live.legacy.epoch;
			// A prior migration can have published archive before a failed live
			// rename. Load its epoch for the tier-local guard, but keep the v2
			// snapshot authoritative for the rows being repartitioned.
			this.readTierCandidates("archived");
			this.migrationNeeded = true;
			this.seedFromArray(live.rows);
			this.tiers.live.dirtyGeneration = 0;
			this.tiers.archived.dirtyGeneration = 0;
		} else {
			for (const row of live.rows) {
				if (!!row && typeof row === "object" && (row as PersistedSession).archived === true) this.trackTierLayoutRepair(row);
			}
			this.seedFromArray(live.rows);
			const archived = this.readTierCandidates("archived");
			for (const row of archived.rows) {
				if (!!row && typeof row === "object" && (row as PersistedSession).archived !== true) this.trackTierLayoutRepair(row);
				if (!row || typeof row !== "object" || !(row as PersistedSession).id) continue;
				const id = (row as PersistedSession).id;
				if (this.sessions.has(id)) {
					console.warn(`[session-store] Duplicate session ${id} in live and archived tiers; keeping live row`);
					this.trackTierLayoutRepair(row);
					continue;
				}
				this.seedFromArray([row]);
			}
		}
		this.loadTransitionIntent();
	}

	private isValidTransitionIntent(value: unknown): value is TransitionIntent {
		if (!value || typeof value !== "object") return false;
		const intent = value as Partial<TransitionIntent>;
		if (intent.version !== 2 || !Array.isArray(intent.entries) || !intent.epochs) return false;
		for (const tier of ["live", "archived"] as const) {
			const epoch = intent.epochs[tier];
			if (!epoch || !Number.isInteger(epoch.base) || epoch.base < 0 || epoch.target !== epoch.base + 1) return false;
		}
		return intent.entries.every(entry => !!entry && typeof entry.id === "string"
			&& (entry.tier === "live" || entry.tier === "archived")
			&& (!entry.session || (entry.session.id === entry.id && this.tierForSession(entry.session) === entry.tier)));
	}

	private applyTransitionEntries(entries: readonly TransitionEntry[]): void {
		for (const entry of entries) {
			if (entry.session) {
				// The retained intent is immutable recovery evidence. Its row can contain
				// nested persisted state, so a shallow copy would still let later session
				// mutations corrupt the intent needed to repair a second interrupted write.
				this.sessions.set(entry.id, structuredClone(entry.session));
			} else this.sessions.delete(entry.id);
		}
	}

	/** Serialize both post-intent tiers before later mutations can alter recovery. */
	private snapshotTierRowsJson(): Record<SessionTier, string> {
		return {
			live: JSON.stringify(Array.from(this.sessions.values()).filter(session => this.tierForSession(session) === "live")),
			archived: JSON.stringify(Array.from(this.sessions.values()).filter(session => this.tierForSession(session) === "archived")),
		};
	}

	/**
	 * A v2 intent is evidence only when the two tier epochs bind it to a single
	 * interrupted pair publication. In particular, a base/base intent never
	 * reached either rename and must not overwrite the independently loaded rows.
	 */
	private loadTransitionIntent(): void {
		try {
			if (!this.fs.existsSync(this.transitionFile)) return;
			const raw = JSON.parse(this.fs.readFileSync(this.transitionFile, "utf-8")) as unknown;
			if (!this.isValidTransitionIntent(raw)) {
				// v1 has no epoch binding. It may be stale or belong to a different
				// pair, so it is deliberately never recovery authority.
				console.warn(`[session-store] Ignoring unbound or malformed transition intent ${path.basename(this.transitionFile)}`);
				return;
			}
			const intent = raw;
			const state = (tier: SessionTier): "base" | "target" | null => {
				const tierState = this.tiers[tier];
				// A missing first-use archive is virtual epoch zero; a corrupt tier
				// without a parseable primary or backup is not transition evidence.
				if (!tierState.loadedSnapshot && this.fs.existsSync(tierState.file)) return null;
				const observed = tierState.loadedEpoch;
				const epochs = intent.epochs[tier];
				return observed === epochs.base ? "base" : observed === epochs.target ? "target" : null;
			};
			const live = state("live");
			const archived = state("archived");
			if (!live || !archived) {
				console.warn(`[session-store] Ignoring superseded transition intent ${path.basename(this.transitionFile)}`);
				return;
			}
			if (live === "base" && archived === "base") {
				// The intent was durable but neither tier was published. Clean it up
				// later under both fences, but never replay its stale entries.
				this.transitionIntentCleanup = intent;
				return;
			}
			this.applyTransitionEntries(intent.entries);
			this.resolveTierLayoutRepairs(intent.entries);
			if (live === "target" && archived === "target") {
				this.transitionIntentCleanup = intent;
				return;
			}
			// Exactly one target proves a crash between renames. Freeze the complete
			// post-intent pair now: a mutation arriving before the repair drain must
			// never be credited by, or leak into, this old transition publication.
			const recoveryGeneration = ++this.generation;
			this.activeTransitionIntent = {
				intent,
				rowsJson: this.snapshotTierRowsJson(),
				generation: recoveryGeneration,
			};
			if (live === "base") this.tiers.live.dirtyGeneration = recoveryGeneration;
			if (archived === "base") this.tiers.archived.dirtyGeneration = recoveryGeneration;
		} catch (err) { console.warn(`[session-store] Failed to parse ${this.transitionFile}:`, err); }
	}


	private static fingerprintsEqual(a: DiskFingerprint | null, b: DiskFingerprint | null): boolean {
		return a !== null && b !== null
			&& a.size === b.size
			&& a.mtimeMs === b.mtimeMs
			&& a.ctimeMs === b.ctimeMs;
	}

	/** Acquire all file fences in a stable order; pair writes cannot deadlock. */
	private async withTierWriteFences<T>(tiers: readonly SessionTier[], write: () => Promise<T>): Promise<T> {
		const keys = [...new Set(tiers.map(t => path.resolve(this.tierFile(t))))].sort();
		const releases: Array<() => void> = [];
		const tails: Array<{ key: string; tail: Promise<void> }> = [];
		try {
			for (const key of keys) {
				const previous = SessionStore.fileWriteTails.get(key) ?? Promise.resolve();
				let release!: () => void;
				const completion = new Promise<void>(resolve => { release = resolve; });
				const tail = previous.catch(() => undefined).then(() => completion);
				SessionStore.fileWriteTails.set(key, tail);
				await previous.catch(() => undefined);
				releases.push(release); tails.push({ key, tail });
			}
			return await write();
		} finally {
			for (let i = releases.length - 1; i >= 0; i--) releases[i]();
			for (const { key, tail } of tails) if (SessionStore.fileWriteTails.get(key) === tail) SessionStore.fileWriteTails.delete(key);
		}
	}

	private async peekDiskEpochAsync(tier: SessionTier): Promise<number> {
		try {
			const parsed = JSON.parse(await this.fs.promises.readFile(this.tierFile(tier), "utf-8"));
			if (tier === "live" && Array.isArray(parsed)) return 0;
			return parsed && typeof parsed === "object" && typeof parsed.epoch === "number" ? parsed.epoch : -1;
		} catch { return -1; }
	}

	private async currentDiskFingerprintAsync(tier: SessionTier): Promise<DiskFingerprint | null> {
		try {
			const stat = await this.fs.promises.stat(this.tierFile(tier));
			const size = Number(stat.size), mtimeMs = Number(stat.mtimeMs), ctimeMs = Number(stat.ctimeMs);
			// ctime is load-bearing: size + mtime is unsafe on coarse filesystems.
			return Number.isFinite(size) && Number.isFinite(mtimeMs) && Number.isFinite(ctimeMs) ? { size, mtimeMs, ctimeMs } : null;
		} catch { return null; }
	}

	private async rotateBackupsAsync(tier: SessionTier): Promise<void> {
		const file = this.tierFile(tier);
		try { await this.fs.promises.access(file); } catch { return; }
		try { await this.fs.promises.unlink(this.tierBakPath(tier, SessionStore.BACKUP_COUNT)); } catch { /* non-fatal */ }
		for (let i = SessionStore.BACKUP_COUNT - 1; i >= 1; i--) {
			try { await this.fs.promises.rename(this.tierBakPath(tier, i), this.tierBakPath(tier, i + 1)); } catch { /* non-fatal */ }
		}
		try { await this.fs.promises.copyFile(file, this.tierBakPath(tier, 1)); } catch { /* non-fatal */ }
	}

	/** Live-tier compatibility accessors retained for existing callers. */
	isStaleGuardTripped(): boolean { return this.tiers.live.staleGuardTripped; }
	getLoadedEpoch(): number { return this.tiers.live.loadedEpoch; }
	getWrittenEpoch(): number { return this.tiers.live.writtenEpoch; }
	getTierLoadedEpoch(tier: SessionTier): number { return this.tiers[tier].loadedEpoch; }
	getTierWrittenEpoch(tier: SessionTier): number { return this.tiers[tier].writtenEpoch; }
	isTierStaleGuardTripped(tier: SessionTier): boolean { return this.tiers[tier].staleGuardTripped; }

	private saveNow(): void {
		if (this.saveTimer) { this.clock.clearTimeout(this.saveTimer); this.saveTimer = null; }
		void this.requestAsyncSave();
	}

	/** Retain the exact legacy source without blocking an async persistence barrier. */
	private async retainLegacySnapshotAsync(): Promise<void> {
		const snapshot = this.legacySnapshot;
		if (!snapshot) return;
		await this.fs.promises.mkdir(this.storeDir, { recursive: true });
		const base = `${this.storeFile}.pre-archived-split`;
		for (let n = 0; ; n++) {
			const retained = n === 0 ? base : `${base}.${n}`;
			try {
				// An identical retained source is already durable migration evidence.
				// This makes retry/restart and racing stores idempotent without ever
				// overwriting a distinct forensic snapshot.
				if (await this.fs.promises.readFile(retained, "utf-8") === snapshot.raw) return;
				continue;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			}
			try {
				// Exclusive creation closes the read/write race with another store.
				await this.fs.promises.writeFile(retained, snapshot.raw, { encoding: "utf-8", flag: "wx" });
				return;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
				throw err;
			}
		}
	}

	private async writeTransitionIntent(intent: TransitionIntent): Promise<void> {
		const tmp = `${this.transitionFile}.tmp`;
		const payload = JSON.stringify(intent);
		try {
			if (this.fs.promises.open) {
				const handle = await this.fs.promises.open(tmp, "w");
				try {
					await handle.writeFile(payload, "utf-8");
					try { await handle.sync(); } catch { /* non-fatal */ }
				} finally { await handle.close(); }
			} else {
				await this.fs.promises.writeFile(tmp, payload, "utf-8");
			}
			await this.fs.promises.rename(tmp, this.transitionFile);
		} catch (err) {
			try { await this.fs.promises.unlink(tmp); } catch { /* ignore cleanup failure */ }
			throw err;
		}
	}

	/** Validate one tier and build, but do not publish, its next compact snapshot. */
	private async prepareTierWriteUnlockedAsync(tier: SessionTier, rowsJson: string): Promise<PreparedTierWrite> {
		const state = this.tiers[tier];
		if (state.staleGuardTripped) throw new Error(`Session persistence refused: stale-snapshot guard is active for ${tier} tier`);
		const fingerprint = await this.currentDiskFingerprintAsync(tier);
		const onDiskEpoch = state.writtenEpoch > 0 && SessionStore.fingerprintsEqual(fingerprint, state.diskFingerprint)
			? Math.max(state.loadedEpoch, state.writtenEpoch) : await this.peekDiskEpochAsync(tier);
		if (onDiskEpoch > state.loadedEpoch && state.writtenEpoch === 0) {
			state.staleGuardTripped = true;
			console.error(`[session-store] REFUSING to save ${tier} tier: on-disk epoch ${onDiskEpoch} is newer than loaded epoch ${state.loadedEpoch}. Manual intervention required: inspect ${state.file} and ${state.file}.bak.*`);
			throw new Error(`Session persistence refused: on-disk epoch ${onDiskEpoch} is newer than loaded epoch ${state.loadedEpoch}`);
		}
		const baseEpoch = Math.max(state.loadedEpoch, state.writtenEpoch, onDiskEpoch < 0 ? 0 : onDiskEpoch);
		const targetEpoch = baseEpoch + 1;
		// rowsJson is the sole JSON.stringify traversal of this tier's rows.
		const payload = `{"version":3,"epoch":${targetEpoch},"sessions":${rowsJson}}`;
		return { tier, baseEpoch, targetEpoch, payload, payloadBytes: Buffer.byteLength(payload) };
	}

	/** Publish a snapshot already validated while all of its relevant fences are held. */
	private async publishPreparedTierUnlockedAsync(prepared: PreparedTierWrite): Promise<number> {
		const { tier, targetEpoch, payload, payloadBytes } = prepared;
		const state = this.tiers[tier];
		const tmp = this.tierTmpPath(tier);
		try {
			await this.rotateBackupsAsync(tier);
			if (this.fs.promises.open) {
				const handle = await this.fs.promises.open(tmp, "w");
				try { await handle.writeFile(payload, "utf-8"); try { await handle.sync(); } catch { /* non-fatal */ } } finally { await handle.close(); }
			} else await this.fs.promises.writeFile(tmp, payload, "utf-8");
			await this.fs.promises.rename(tmp, state.file);
			state.writtenEpoch = targetEpoch;
			state.diskFingerprint = await this.currentDiskFingerprintAsync(tier);
			return payloadBytes;
		} catch (err) { try { await this.fs.promises.unlink(tmp); } catch { /* ignore */ } throw err; }
	}

	private async transitionEpochStatesUnlocked(intent: TransitionIntent): Promise<Record<SessionTier, "base" | "target" | null>> {
		const result = {} as Record<SessionTier, "base" | "target" | null>;
		for (const tier of ["live", "archived"] as const) {
			if (this.tiers[tier].staleGuardTripped) throw new Error(`Session persistence refused: stale-snapshot guard is active for ${tier} tier`);
			const diskEpoch = await this.peekDiskEpochAsync(tier);
			// A never-created tier has the same virtual epoch zero used by the
			// writer. A corrupt existing file remains outside the binding instead.
			const observed = diskEpoch < 0 && !this.fs.existsSync(this.tierFile(tier)) ? 0 : diskEpoch;
			const epochs = intent.epochs[tier];
			result[tier] = observed === epochs.base ? "base" : observed === epochs.target ? "target" : null;
		}
		return result;
	}

	/** Check whether a peer retained, removed, or replaced this exact durable intent. */
	private async transitionIntentBindingUnlocked(intent: TransitionIntent): Promise<TransitionIntentBinding> {
		try {
			const raw = JSON.parse(await this.fs.promises.readFile(this.transitionFile, "utf-8"));
			return JSON.stringify(raw) === JSON.stringify(intent) ? "exact" : "mismatch";
		} catch (err) {
			return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "mismatch";
		}
	}

	/**
	 * Remove an exact v2 intent only after its binding is conclusively spent.
	 * The discriminated outcome lets independently fenced stores converge when
	 * a peer already removed the same binding, without accepting replacement
	 * content or an out-of-band epoch transition.
	 */
	private async clearTransitionIntentIfSpentUnlocked(intent: TransitionIntent): Promise<TransitionIntentCleanup> {
		const binding = await this.transitionIntentBindingUnlocked(intent);
		if (binding === "mismatch") return "mismatch";
		const states = await this.transitionEpochStatesUnlocked(intent);
		const bothBase = states.live === "base" && states.archived === "base";
		const bothTarget = states.live === "target" && states.archived === "target";
		if (!bothBase && !bothTarget) return "mismatch";
		if (binding === "absent") return "absent";
		try {
			await this.fs.promises.unlink(this.transitionFile);
			return "removed";
		} catch (err) {
			// A peer can unlink after our exact read only outside this process's
			// fence. It is still safe only because the epochs above prove it spent.
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return "absent";
			throw err;
		}
	}

	/** Serialize only dirty tiers; the archive tier is never touched by live activity. */
	private async saveNowAsync(): Promise<number> {
		const startedAt = performance.now();
		await this.fs.promises.mkdir(this.storeDir, { recursive: true });
		const mustMigrate = this.migrationNeeded;
		const selected = (Object.keys(this.tiers) as SessionTier[]).filter(t => mustMigrate || this.tiers[t].dirtyGeneration > this.tiers[t].publishedGeneration);
		const freshEntries = [...this.pendingTransitions.values()];
		const activeRecovery = this.activeTransitionIntent;
		const activeIntent = activeRecovery?.intent ?? null;
		const freshTransition = freshEntries.length > 0 && !activeIntent;
		const cleanupIntent = this.transitionIntentCleanup;
		// A legacy source is kept authoritative until archive publication succeeds;
		// pair transitions remain archive-first after both tiers have been prepared.
		if (mustMigrate || freshTransition || activeIntent) selected.sort((a, b) => a === "archived" ? -1 : b === "archived" ? 1 : 0);
		if (!selected.length && !cleanupIntent) return this.generation;

		const json: Partial<Record<SessionTier, string>> = {};
		// Recovery must repair the frozen post-intent pair, never a later mutable
		// map snapshot. Later dirty generations are deliberately drained afterward.
		if (!activeRecovery) {
			for (const tier of selected) {
				json[tier] = JSON.stringify(Array.from(this.sessions.values()).filter(s => this.tierForSession(s) === tier));
			}
		}
		const serializedGeneration = this.generation;
		const fenced = freshTransition || activeIntent || cleanupIntent ? ["live", "archived"] as SessionTier[] : selected;
		return this.withTierWriteFences(fenced, async () => {
			if (cleanupIntent && !activeIntent) {
				const cleanup = await this.clearTransitionIntentIfSpentUnlocked(cleanupIntent);
				if (cleanup === "mismatch") throw new Error("Session persistence refused: transition intent changed before cleanup");
				this.transitionIntentCleanup = null;
				if (!selected.length) return serializedGeneration;
			}

			const persistedBytes: Partial<Record<SessionTier, number>> = {};
			let publishedTiers = selected;
			const completedGeneration = activeRecovery?.generation ?? serializedGeneration;
			if (activeRecovery && activeIntent) {
				// Never replace a durable pair binding on retry. Its exact base/target
				// epochs decide whether it can be repaired, discarded, or only cleaned.
				const states = await this.transitionEpochStatesUnlocked(activeIntent);
				if (!states.live || !states.archived) {
					throw new Error("Session persistence refused: active transition intent no longer matches tier epochs");
				}
				const binding = await this.transitionIntentBindingUnlocked(activeIntent);
				if (binding === "mismatch") {
					throw new Error("Session persistence refused: active transition intent changed before recovery");
				}
				const bothBase = states.live === "base" && states.archived === "base";
				const bothTarget = states.live === "target" && states.archived === "target";
				if (bothBase) {
					if (binding === "exact") {
						const cleanup = await this.clearTransitionIntentIfSpentUnlocked(activeIntent);
						if (cleanup === "mismatch") throw new Error("Session persistence refused: transition intent changed before cleanup");
					}
					// Neither rename occurred. Whether this store or a peer removed the
					// binding, pending entries stay eligible for a fresh epoch-bound try.
					this.activeTransitionIntent = null;
					this.asyncSaveRequested = true;
					return this.publishedGeneration;
				}
				if (!bothTarget) {
					// A peer may have cleaned the intent while we were down. Restore the
					// identical v2 bytes before repairing the missing tier so a second
					// crash remains unambiguous.
					if (binding === "absent") await this.writeTransitionIntent(activeIntent);
					const missing = (["archived", "live"] as SessionTier[]).filter(tier => states[tier] === "base");
					for (const tier of missing) {
						const epoch = activeIntent.epochs[tier];
						const rowsJson = activeRecovery.rowsJson[tier];
						const payload = `{"version":3,"epoch":${epoch.target},"sessions":${rowsJson}}`;
						persistedBytes[tier] = await this.publishPreparedTierUnlockedAsync({
							tier, baseEpoch: epoch.base, targetEpoch: epoch.target, payload, payloadBytes: Buffer.byteLength(payload),
						});
					}
				}
				const cleanup = await this.clearTransitionIntentIfSpentUnlocked(activeIntent);
				if (cleanup === "mismatch") throw new Error("Session persistence refused: transition intent changed before cleanup");
				this.activeTransitionIntent = null;
				publishedTiers = ["live", "archived"];
				for (const entry of activeIntent.entries) if (this.pendingTransitions.get(entry.id) === entry) this.pendingTransitions.delete(entry.id);
				// The pair only establishes its own frozen generation. Any mutation
				// folded in after that snapshot retains its tier dirtiness and must get
				// a trailing drain with a new transition intent if membership changed.
				if (this.generation > activeRecovery.generation || this.pendingTransitions.size) this.asyncSaveRequested = true;
			} else {
				// Preparation has no side effects. For a fresh membership transition all
				// tier guards run under both fences before its intent or either rename.
				const prepared: Partial<Record<SessionTier, PreparedTierWrite>> = {};
				for (const tier of selected) prepared[tier] = await this.prepareTierWriteUnlockedAsync(tier, json[tier]!);
				if (mustMigrate) await this.retainLegacySnapshotAsync();
				let intent: TransitionIntent | null = null;
				if (freshTransition) {
					const live = prepared.live;
					const archived = prepared.archived;
					if (!live || !archived) throw new Error("Session persistence refused: membership transition did not prepare both tiers");
					intent = {
						version: 2,
						entries: freshEntries,
						epochs: {
							live: { base: live.baseEpoch, target: live.targetEpoch },
							archived: { base: archived.baseEpoch, target: archived.targetEpoch },
						},
					};
					await this.writeTransitionIntent(intent);
					this.activeTransitionIntent = {
						intent,
						rowsJson: { live: json.live!, archived: json.archived! },
						generation: serializedGeneration,
					};
				}
				for (const tier of selected) persistedBytes[tier] = await this.publishPreparedTierUnlockedAsync(prepared[tier]!);
				if (intent) {
					const cleanup = await this.clearTransitionIntentIfSpentUnlocked(intent);
					if (cleanup === "mismatch") {
						throw new Error("Session persistence refused: transition intent changed before cleanup");
					}
					this.activeTransitionIntent = null;
					for (const entry of freshEntries) if (this.pendingTransitions.get(entry.id) === entry) this.pendingTransitions.delete(entry.id);
				}
			}
			for (const tier of publishedTiers) this.tiers[tier].publishedGeneration = Math.max(this.tiers[tier].publishedGeneration, completedGeneration);
			this.migrationNeeded = false;
			const liveBytes = persistedBytes.live ?? 0;
			const archivedBytes = persistedBytes.archived ?? 0;
			this.lastPersistenceMetrics = { bytes: liveBytes + archivedBytes, liveBytes, archivedBytes, durationMs: performance.now() - startedAt };
			return completedGeneration;
		});
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
					if (!(Object.values(this.tiers) as TierPersistenceState[]).some(tier => tier.staleGuardTripped)) console.error("[session-store] Failed to save sessions:", err);
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
		const previous = this.sessions.get(session.id);
		this.generation++;
		this.sessions.set(session.id, session);
		this.markMutation(previous, session);
		this.saveNow(); // immediate — structural change
		this.onIndexUpdate?.(session);
	}

	get(id: string): PersistedSession | undefined {
		return this.sessions.get(id);
	}

	remove(id: string): void {
		const existing = this.sessions.get(id);
		// Preserve the legacy hard-delete contract: an unknown id still records a
		// tombstone, preventing stale migration sources from resurrecting it.
		this.generation++;
		this.sessions.delete(id);
		this.markMutation(existing, undefined);
		this.saveNow(); // immediate — structural change
		// Durably tombstone this hard-delete so the boot-time headquarters
		// migration does not resurrect the record from a stale backup on restart.
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
		const previous = { ...existing };
		this.generation++;
		Object.assign(existing, updates);
		this.markMutation(previous, existing);

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
		const previous = { ...existing };
		this.generation++;
		if (present) {
			(existing as unknown as { user_tags: unknown }).user_tags = value;
		} else {
			delete existing.user_tags;
		}
		this.markMutation(previous, existing);
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
		const previous = { ...session };
		this.generation++;
		if (!session.drafts) session.drafts = {};
		session.drafts[type] = data;
		this.markMutation(previous, session);
		this.save();
		return true;
	}

	/** Delete a draft for a session by type. Triggers debounced save. */
	deleteDraft(sessionId: string, type: string): boolean {
		const session = this.sessions.get(sessionId);
		if (!session?.drafts) return false;
		const previous = { ...session };
		this.generation++;
		delete session.drafts[type];
		// Clean up empty drafts object
		if (Object.keys(session.drafts).length === 0) {
			delete session.drafts;
		}
		this.markMutation(previous, session);
		this.save();
		return true;
	}

	/** Mark a session as archived. */
	archive(id: string): boolean {
		const existing = this.sessions.get(id);
		if (!existing) return false;
		const previous = { ...existing };
		this.generation++;
		existing.archived = true;
		existing.archivedAt = this.clock.now();
		this.markMutation(previous, existing);
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
		const previous = { ...existing };
		this.generation++;
		const targetGeneration = this.generation;
		existing.archived = true;
		existing.archivedAt = this.clock.now();
		this.markMutation(previous, existing);
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
		this.markMutation(existing, undefined);
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
		this.markMutation(existing, undefined);
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
