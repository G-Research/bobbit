import { randomUUID } from "node:crypto";
import path from "node:path";
import type { FsLike } from "../gateway-deps.js";
import { realFs } from "../gateway-deps.js";

/** Terminal deferrable records remain available for semantic deduplication. */
export const DECISION_REQUEST_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const DECISION_REQUEST_STORE_VERSION = 2 as const;

export type DecisionLifecycleEvent = "sessionSetup" | "beforePrompt" | "afterTurn" | "beforeCompact" | "sessionShutdown";
/** Durable event labels accepted by the decision store. */
export type StoredDecisionEvent = DecisionLifecycleEvent | "projectImported";
export type DecisionScope = "session" | "goal" | "project";
export type DecisionStatus = "pending" | "resolved" | "rejected" | "expired" | "superseded" | "defaulted" | "denied" | "paused-awaiting-consent";
/** A consent pause is durable waiting work, not a terminal decision. */
export type DecisionTerminalStatus = Exclude<DecisionStatus, "pending" | "paused-awaiting-consent">;
export type DecisionActor = "user" | "deadline" | "headless";
export type DecisionReason = "answered" | "deadline_elapsed" | "headless_default" | "consent_denied";
export type DecisionClass = "deferrable" | "consent-required";
/** Only the trusted core classifier may assign a platform reason. */
export type DecisionClassificationReason = "requested" | "core-hard-cap" | "core-unsafe-tool" | "core-capability-change" | "core-grant-change" | "core-configuration-change";
export type ConsentTimeoutAction = "deny-operation" | "pause-goal";
export type ConsentInboxSurfaceStatus = "pending" | "surfaced" | "projection-only" | "completed" | "cancelled";
export type ConsentResumeStatus = "claimed" | "resumed" | "already-resumed" | "not-matching" | "denied";
export type ProposalType = "goal" | "project" | "workflow" | "role" | "tool" | "staff";

export type DecisionValue =
	| { kind: "option"; value: string }
	| { kind: "other"; text: string };

/**
 * The contract validator owns the precise extension-facing request schema.
 * This persisted form deliberately accepts its validated JSON payload without
 * importing the dispatcher, so this project-owned store stays independent of
 * extension loading and can fail closed in isolation.
 */
export interface ValidatedExtensionDecisionRequest {
	version: 1;
	key: string;
	title: string;
	question: string;
	options: readonly { value: string; label: string }[];
	other: { minLength?: number; maxLength: number; pattern?: string };
	/** Absent only for consent-required requests after core classification. */
	default?: DecisionValue;
	scope: DecisionScope;
	deadlineAt: string;
	/** Extension-declared routing label; it is never an authorization input. */
	intent?: string;
	/** Absent in historical v1 records and therefore interpreted as deferrable. */
	requestedClass?: DecisionClass;
	effect?: { kind: "none" } | { kind: "proposal"; proposals: Record<string, { proposalType: ProposalType; args: Record<string, unknown> }> };
}

/** Opaque core operation identity; the store never receives operation arguments. */
export interface DecisionProtectedOperation {
	id: string;
	kind: string;
}

export interface ConsentPauseIdentity {
	goalId: string;
	reason: { kind: "awaiting-extension-consent"; requestId: string; createdAt: string };
}

export interface DecisionConsentPause extends ConsentPauseIdentity {
	pausedAt: string;
	/** Set only after the canonical lifecycle accepted this exact pause. */
	pauseAppliedAt?: string;
	/** A claimed answer is durable so a restart can safely finish the exact action. */
	resume?: { status: ConsentResumeStatus; claimedAt: string; completedAt?: string; value?: DecisionValue };
}

/** The source key makes recovery retry an existing inbox entry rather than duplicate it. */
export interface DecisionConsentInboxSurface {
	sourceKey: string;
	status: ConsentInboxSurfaceStatus;
	entryId?: string;
	updatedAt: string;
}

export interface ValidatedDecisionResolution {
	value: DecisionValue;
	actor: DecisionActor;
	reason: DecisionReason;
}

export interface DecisionMemory {
	scope: DecisionScope;
	scopeId: string;
	packId: string;
	hookId: string;
	key: string;
	value: DecisionValue;
	validatedAt: string;
	sourceRequestId: string;
}

export interface DecisionMemoryIdentity {
	scope: DecisionScope;
	scopeId: string;
	packId: string;
	hookId: string;
	key: string;
}

/** A delivery is never represented by a fabricated agent-session id. */
export type DecisionDelivery =
	| { kind: "session"; sessionId: string }
	| { kind: "project-import"; importId: string };

export type ImportDecisionOutcomeCode = "applied" | "superseded" | "denied" | "dropped" | "error";

/** Persisted, bounded import context. The context builder owns construction. */
export interface StoredProjectImportContext {
	event: "projectImported";
	projectId: string;
	importId: string;
	projectRoot: string;
	ownedRoots: readonly string[];
	components: readonly {
		id: string;
		root: string;
		languages: readonly string[];
	}[];
}

export interface StoredProjectImportRun {
	id: string;
	projectId: string;
	context: StoredProjectImportContext;
	createdAt: string;
	completedAt?: string;
	hooks: Record<string, {
		state: "pending" | "completed";
		completedAt?: string;
		outcome?: ImportDecisionOutcomeCode;
	}>;
}

export interface StoredDecisionRequest {
	id: string;
	projectId: string;
	/** Compatibility field retained for existing session routes and state files. */
	sessionId?: string;
	/** Explicit durable target. v1 records normalize to a session delivery. */
	delivery: DecisionDelivery;
	goalId?: string;
	asker: { packId: string; hookId: string; event: StoredDecisionEvent };
	dedupeId: string;
	questionId: string;
	request: ValidatedExtensionDecisionRequest;
	/** Absent for records written before consent hardening (deferrable compatibility). */
	decisionClass?: DecisionClass;
	classificationReason?: DecisionClassificationReason;
	/** Trusted core metadata only; extensions cannot provide or change these fields. */
	protectedOperation?: DecisionProtectedOperation;
	timeoutAction?: ConsentTimeoutAction;
	/** Present only after a pause-goal consent timeout wins the first-write race. */
	consentPause?: DecisionConsentPause;
	/** Durable, non-waking inbox projection bookkeeping for a consent pause. */
	consentInbox?: DecisionConsentInboxSurface;
	status: DecisionStatus;
	createdAt: string;
	deadlineAt: string;
	resolvedAt?: string;
	resolution?: ValidatedDecisionResolution;
	proposal?: { status: "created" | "failed"; type: ProposalType; rev?: number; code?: "PROPOSAL_SEED_FAILED" };
	continuationState: "pending" | "delivered" | "skipped";
	continuationAttempts: number;
}

export interface DecisionRequestStoreState {
	version: typeof DECISION_REQUEST_STORE_VERSION;
	requests: Record<string, StoredDecisionRequest>;
	memories: Record<string, DecisionMemory>;
	importRuns: Record<string, StoredProjectImportRun>;
}

export interface DecisionTerminalUpdate {
	status: DecisionTerminalStatus;
	resolvedAt: string;
	resolution?: ValidatedDecisionResolution;
}

export interface FirstTerminalWrite {
	/** True only when this call durably changed a pending record to terminal. */
	written: boolean;
	request?: StoredDecisionRequest;
}

export interface ConsentPauseWrite {
	pausedAt: string;
	pause: ConsentPauseIdentity;
	inbox: DecisionConsentInboxSurface;
}

export interface FirstConsentPauseWrite {
	/** True only when this call durably changed a pending consent record to paused. */
	written: boolean;
	request?: StoredDecisionRequest;
}

export interface ConsentResumeClaim {
	pause: ConsentPauseIdentity;
	claimedAt: string;
	/** Already schema-validated by the manager before this durable claim. */
	value: DecisionValue;
}

export interface ConsentResumeClaimResult {
	claimed: boolean;
	request?: StoredDecisionRequest;
}

export interface ConsentResumeCompletion {
	pause: ConsentPauseIdentity;
	completedAt: string;
	outcome: Exclude<ConsentResumeStatus, "claimed">;
	/** Required when the matching resume settled the request. */
	terminal?: DecisionTerminalUpdate;
}

export interface ConsentResumeCompletionResult {
	completed: boolean;
	request?: StoredDecisionRequest;
}

/**
 * One atomic JSON snapshot for all decision mediation belonging to a project.
 *
 * The manager is its only caller that chooses policy. This class provides the
 * narrow serial mutation primitives needed to make terminal resolution and
 * scope-memory publication indivisible. A failed write never changes the
 * in-memory snapshot, so callers can safely retry without fabricating a
 * resolution. Corrupt input disables this store rather than affecting any
 * other project state.
 */
export class DecisionRequestStore {
	private readonly file: string;
	private state: DecisionRequestStoreState = emptyState();
	private healthy = true;

	constructor(stateDir: string, private readonly fs: FsLike = realFs) {
		this.file = path.join(stateDir, "extension-decision-requests.json");
		this.load();
	}

	/** False means persisted state was corrupt; callers must not offer decisions. */
	isHealthy(): boolean {
		return this.healthy;
	}

	get(id: string): StoredDecisionRequest | undefined {
		const request = this.state.requests[id];
		return request ? clone(request) : undefined;
	}

	list(): StoredDecisionRequest[] {
		return Object.values(this.state.requests).map(clone);
	}

	listPending(sessionId?: string): StoredDecisionRequest[] {
		return this.list().filter(request => request.status === "pending" && (sessionId === undefined || request.delivery.kind === "session" && request.delivery.sessionId === sessionId));
	}

	/** Pending records addressed to one durable project-import run. */
	listPendingImportRequests(importId: string): StoredDecisionRequest[] {
		return this.list().filter(request => request.status === "pending" && request.delivery.kind === "project-import" && request.delivery.importId === importId);
	}

	getImportRun(id: string): StoredProjectImportRun | undefined {
		const run = this.state.importRuns[id];
		return run ? clone(run) : undefined;
	}

	/**
	 * Publish an immutable import run once. A retry may observe the same snapshot,
	 * but can never replace its context or silently start a second run.
	 */
	ensureImportRun(run: StoredProjectImportRun): { created: boolean; run: StoredProjectImportRun } | undefined {
		if (!isImportRun(run)) return undefined;
		const result = this.commit(next => {
			const existing = next.importRuns[run.id];
			if (existing) {
				if (canonical(existing.context) !== canonical(run.context) || existing.projectId !== run.projectId) return undefined;
				return { created: false, run: clone(existing) };
			}
			next.importRuns[run.id] = clone(run);
			return { created: true, run: clone(run) };
		});
		return result;
	}

	/**
	 * Add newly discovered active hooks without disturbing an immutable context or
	 * a completed hook. This is the crash boundary between hook enumeration and
	 * invocation: a replay sees the durable pending entry before calling code.
	 */
	ensureImportHooks(runId: string, hookKeys: readonly string[]): StoredProjectImportRun | undefined {
		if (!hookKeys.every(key => isBoundedString(key, 256))) return undefined;
		return this.commit(next => {
			const run = next.importRuns[runId];
			if (!run || run.completedAt) return run ? clone(run) : undefined;
			for (const key of new Set(hookKeys)) run.hooks[key] ??= { state: "pending" };
			// An import with no active hooks is still a completed one-shot run; it
			// must not acquire hooks installed only after registration.
			if (Object.values(run.hooks).every(entry => entry.state === "completed")) run.completedAt = run.createdAt;
			return clone(run);
		});
	}

	/** First durable completion for one hook wins; completed hooks never replay. */
	completeImportHook(runId: string, hookKey: string, outcome: ImportDecisionOutcomeCode, at: string): boolean {
		return this.commit(next => {
			const run = next.importRuns[runId];
			const hook = run?.hooks[hookKey];
			if (!run || !hook || hook.state !== "pending" || !isBoundedString(hookKey, 256) || !isImportOutcome(outcome) || !isIsoInstant(at)) return false;
			hook.state = "completed";
			hook.completedAt = at;
			hook.outcome = outcome;
			if (Object.values(run.hooks).every(entry => entry.state === "completed")) run.completedAt ??= at;
			return true;
		}) ?? false;
	}

	findByDedupeId(dedupeId: string): StoredDecisionRequest | undefined {
		for (const request of Object.values(this.state.requests)) {
			if (request.dedupeId === dedupeId) return clone(request);
		}
		return undefined;
	}

	/** Consent is only deduplicated while it can still protect the operation. */
	findActiveByDedupeId(dedupeId: string): StoredDecisionRequest | undefined {
		for (const request of Object.values(this.state.requests)) {
			if (request.dedupeId === dedupeId && (request.status === "pending" || request.status === "paused-awaiting-consent")) return clone(request);
		}
		return undefined;
	}

	getMemory(identity: DecisionMemoryIdentity): DecisionMemory | undefined {
		const memory = this.state.memories[memoryKey(identity)];
		return memory ? clone(memory) : undefined;
	}

	listMemories(): DecisionMemory[] {
		return Object.values(this.state.memories).map(clone);
	}

	/** Add a new request; existing ids are deliberately immutable. */
	put(request: StoredDecisionRequest): boolean {
		if (!isStoredRequest(request) || this.state.requests[request.id]) return false;
		return this.commit(next => {
			next.requests[request.id] = clone(request);
			return true;
		}) ?? false;
	}

	/** Persist an exact scope memory without broad/wildcard matching. */
	putMemory(memory: DecisionMemory): boolean {
		return this.commit(next => {
			next.memories[memoryKey(memory)] = clone(memory);
			return true;
		}) ?? false;
	}

	/**
	 * The first terminal writer wins. If supplied, its already-validated memory
	 * is published in the same atomic snapshot as the terminal record.
	 */
	writeTerminalFirst(id: string, update: DecisionTerminalUpdate, memory?: DecisionMemory): FirstTerminalWrite {
		const result = this.commit(next => {
			const current = next.requests[id];
			if (!current) return { written: false } as FirstTerminalWrite;
			if (current.status !== "pending") return { written: false, request: clone(current) } as FirstTerminalWrite;
			current.status = update.status;
			current.resolvedAt = update.resolvedAt;
			if (update.resolution) current.resolution = clone(update.resolution);
			if (memory) next.memories[memoryKey(memory)] = clone(memory);
			return { written: true, request: clone(current) } as FirstTerminalWrite;
		});
		return result ?? { written: false, request: this.get(id) };
	}

	/**
	 * First writer for a pause-goal consent timeout. The pause reason and inbox
	 * source key are published before any external pause or inbox work begins.
	 */
	writeConsentPauseFirst(id: string, update: ConsentPauseWrite): FirstConsentPauseWrite {
		const result = this.commit(next => {
			const current = next.requests[id];
			if (!current) return { written: false } as FirstConsentPauseWrite;
			if (current.status !== "pending" || current.decisionClass !== "consent-required" || current.timeoutAction !== "pause-goal"
				|| !isIsoInstant(update.pausedAt) || !matchesPause(current, update.pause) || !isConsentInboxSurface(update.inbox) || update.inbox.status !== "pending") {
				return { written: false, request: clone(current) } as FirstConsentPauseWrite;
			}
			current.status = "paused-awaiting-consent";
			current.consentPause = { ...clone(update.pause), pausedAt: update.pausedAt };
			current.consentInbox = clone(update.inbox);
			return { written: true, request: clone(current) } as FirstConsentPauseWrite;
		});
		return result ?? { written: false, request: this.get(id) };
	}

	/** Claim one exact consent pause before invoking the canonical resume owner. */
	claimConsentResume(id: string, claim: ConsentResumeClaim): ConsentResumeClaimResult {
		const result = this.commit(next => {
			const current = next.requests[id];
			if (!current) return { claimed: false } as ConsentResumeClaimResult;
			if (current.status !== "paused-awaiting-consent" || !current.consentPause || !isIsoInstant(claim.claimedAt) || !samePauseIdentity(current.consentPause, claim.pause)
				|| current.consentPause.resume !== undefined || !isValidDecisionValueForRequest(claim.value, current.request)) return { claimed: false, request: clone(current) } as ConsentResumeClaimResult;
			current.consentPause.resume = { status: "claimed", claimedAt: claim.claimedAt, value: clone(claim.value) };
			return { claimed: true, request: clone(current) } as ConsentResumeClaimResult;
		});
		return result ?? { claimed: false, request: this.get(id) };
	}

	/** Record successful canonical pause side effects; later replay must never re-pause an operator-resumed goal. */
	markConsentPauseApplied(id: string, pause: ConsentPauseIdentity, appliedAt: string): boolean {
		return this.commit(next => {
			const current = next.requests[id];
			if (!current || current.status !== "paused-awaiting-consent" || !current.consentPause || !samePauseIdentity(current.consentPause, pause) || !isIsoInstant(appliedAt)) return false;
			if (current.consentPause.pauseAppliedAt) return true;
			current.consentPause.pauseAppliedAt = appliedAt;
			return true;
		}) ?? false;
	}

	/** Persist the outcome of an exact resume attempt. A mismatch fails closed. */
	completeConsentResume(id: string, completion: ConsentResumeCompletion): ConsentResumeCompletionResult {
		const result = this.commit(next => {
			const current = next.requests[id];
			if (!current) return { completed: false } as ConsentResumeCompletionResult;
			const pause = current.consentPause;
			const claimedResume = pause?.resume;
			if (current.status !== "paused-awaiting-consent" || !pause || !isIsoInstant(completion.completedAt) || !samePauseIdentity(pause, completion.pause) || claimedResume?.status !== "claimed") {
				return { completed: false, request: clone(current) } as ConsentResumeCompletionResult;
			}
			if (!completion.terminal || !isDecisionStatus(completion.terminal.status) || !isTerminalStatus(completion.terminal.status) || !isIsoInstant(completion.terminal.resolvedAt)
				|| ((completion.outcome === "resumed" || completion.outcome === "already-resumed") !== (completion.terminal.status === "resolved" && completion.terminal.resolution !== undefined))
				|| ((completion.outcome === "denied" || completion.outcome === "not-matching") !== (completion.terminal.status === "denied" && completion.terminal.resolution === undefined))) {
				return { completed: false, request: clone(current) } as ConsentResumeCompletionResult;
			}
			pause.resume = { status: completion.outcome, claimedAt: claimedResume.claimedAt, completedAt: completion.completedAt };
			if (completion.terminal) {
				current.status = completion.terminal.status;
				current.resolvedAt = completion.terminal.resolvedAt;
				if (completion.terminal.resolution) current.resolution = clone(completion.terminal.resolution);
			}
			return { completed: true, request: clone(current) } as ConsentResumeCompletionResult;
		});
		return result ?? { completed: false, request: this.get(id) };
	}

	/** Atomically mark the one durable consent inbox projection by its exact source key. */
	updateConsentInboxSurface(id: string, sourceKey: string, update: Pick<DecisionConsentInboxSurface, "status" | "entryId" | "updatedAt">): boolean {
		return this.commit(next => {
			const current = next.requests[id];
			const inbox = current?.consentInbox;
			if (!current || !inbox || inbox.sourceKey !== sourceKey || !isConsentInboxTransition(inbox.status, update.status)) return false;
			if (update.status === "surfaced" && !update.entryId) return false;
			const nextInbox = { sourceKey, status: update.status, ...(update.entryId ? { entryId: update.entryId } : inbox.entryId ? { entryId: inbox.entryId } : {}), updatedAt: update.updatedAt };
			if (!isConsentInboxSurface(nextInbox)) return false;
			current.consentInbox = nextInbox;
			return true;
		}) ?? false;
	}

	/** Update only post-resolution delivery bookkeeping. */
	updateContinuation(
		id: string,
		update: Pick<StoredDecisionRequest, "continuationState" | "continuationAttempts">,
	): boolean {
		return this.commit(next => {
			const current = next.requests[id];
			if (!current || !isTerminalStatus(current.status)) return false;
			current.continuationState = update.continuationState;
			current.continuationAttempts = update.continuationAttempts;
			return true;
		}) ?? false;
	}

	/** Record an optional proposal outcome after its independently isolated work. */
	updateProposal(id: string, proposal: StoredDecisionRequest["proposal"]): boolean {
		return this.commit(next => {
			const current = next.requests[id];
			if (!current || !isTerminalStatus(current.status)) return false;
			current.proposal = proposal ? clone(proposal) : undefined;
			return true;
		}) ?? false;
	}

	/**
	 * Remove only old terminal records. Pending records are never pruned: boot
	 * reconciliation must get a chance to apply their overdue default first.
	 * Memories intentionally outlive their source records.
	 */
	pruneTerminalRequests(now: number): number {
		const cutoff = now - DECISION_REQUEST_RETENTION_MS;
		return this.commit(next => {
			let removed = 0;
			for (const [id, request] of Object.entries(next.requests)) {
				if (!isTerminalStatus(request.status)) continue;
				const resolvedAt = Date.parse(request.resolvedAt ?? "");
				if (Number.isFinite(resolvedAt) && resolvedAt < cutoff) {
					delete next.requests[id];
					removed++;
				}
			}
			return removed;
		}) ?? 0;
	}

	private load(): void {
		if (!this.fs.existsSync(this.file)) return;
		try {
			const parsed = JSON.parse(this.fs.readFileSync(this.file, "utf-8")) as unknown;
			const migrated = migrateState(parsed);
			if (!migrated) throw new Error("invalid decision request state");
			this.state = clone(migrated);
		} catch (error) {
			this.healthy = false;
			this.state = emptyState();
			console.error("[decision-request-store] Failed to load decision state; decisions are disabled:", error);
		}
	}

	/** Clone → mutate → temp write + rename → publish memory, in that order. */
	private commit<T>(operation: (next: DecisionRequestStoreState) => T): T | undefined {
		if (!this.healthy) return undefined;
		const next = clone(this.state);
		const result = operation(next);
		if (!this.persist(next)) return undefined;
		this.state = next;
		return clone(result);
	}

	private persist(next: DecisionRequestStoreState): boolean {
		const directory = path.dirname(this.file);
		const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
		try {
			this.fs.mkdirSync(directory, { recursive: true });
			this.fs.writeFileSync(temp, JSON.stringify(next, null, 2), "utf-8");
			this.fs.renameSync(temp, this.file);
			return true;
		} catch (error) {
			try {
				if (this.fs.existsSync(temp)) this.fs.unlinkSync(temp);
			} catch { /* best-effort temp cleanup */ }
			console.error("[decision-request-store] Failed to persist decision state:", error);
			return false;
		}
	}
}

function emptyState(): DecisionRequestStoreState {
	return { version: DECISION_REQUEST_STORE_VERSION, requests: {}, memories: {}, importRuns: {} };
}

/** JSON cloning provides both defensive copies and a JSON-only persistence fence. */
function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

/** Stable snapshot identity keeps import-run retries from replacing context. */
function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function memoryKey(memory: DecisionMemoryIdentity): string {
	// JSON avoids delimiter collisions while preserving the exact five-part key.
	return JSON.stringify([memory.scope, memory.scopeId, memory.packId, memory.hookId, memory.key]);
}

function migrateState(value: unknown): DecisionRequestStoreState | undefined {
	if (isState(value)) return value;
	// Schema-1 had an implicit session delivery. Normalizing while loading keeps
	// existing session routes working and makes the next atomic write upgrade it.
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.requests) || !isRecord(value.memories)) return undefined;
	const requests: Record<string, StoredDecisionRequest> = {};
	for (const [id, request] of Object.entries(value.requests)) {
		if (!isLegacyStoredRequest(request) || request.id !== id) return undefined;
		requests[id] = { ...clone(request), delivery: { kind: "session", sessionId: request.sessionId } };
	}
	if (!Object.values(value.memories).every(isMemory)) return undefined;
	return { version: DECISION_REQUEST_STORE_VERSION, requests, memories: clone(value.memories) as Record<string, DecisionMemory>, importRuns: {} };
}

function isState(value: unknown): value is DecisionRequestStoreState {
	if (!isRecord(value) || value.version !== DECISION_REQUEST_STORE_VERSION || !isRecord(value.requests) || !isRecord(value.memories) || !isRecord(value.importRuns)) return false;
	return Object.entries(value.requests).every(([id, request]) => isStoredRequest(request) && request.id === id)
		&& Object.values(value.memories).every(isMemory)
		&& Object.entries(value.importRuns).every(([id, run]) => isImportRun(run) && run.id === id);
}

function isStoredRequest(value: unknown): value is StoredDecisionRequest {
	if (!isRecord(value)
		|| !isString(value.id) || !isString(value.projectId)
		|| !isDelivery(value.delivery)
		|| (value.sessionId !== undefined && !isString(value.sessionId))
		|| (value.goalId !== undefined && !isString(value.goalId))
		|| !isRecord(value.asker) || !isString(value.asker.packId) || !isString(value.asker.hookId) || !isStoredEvent(value.asker.event)
		|| !isString(value.dedupeId) || !isString(value.questionId) || !isValidatedRequest(value.request)
		|| (value.decisionClass !== undefined && !isDecisionClass(value.decisionClass))
		|| (value.classificationReason !== undefined && !isClassificationReason(value.classificationReason))
		|| (value.protectedOperation !== undefined && !isProtectedOperation(value.protectedOperation))
		|| (value.timeoutAction !== undefined && !isConsentTimeoutAction(value.timeoutAction))
		|| (value.consentPause !== undefined && !isConsentPause(value.consentPause))
		|| (value.consentInbox !== undefined && !isConsentInboxSurface(value.consentInbox))
		|| !isDecisionStatus(value.status) || !isIsoInstant(value.createdAt) || !isIsoInstant(value.deadlineAt)
		|| (value.resolvedAt !== undefined && !isIsoInstant(value.resolvedAt))
		|| (value.resolution !== undefined && !isResolution(value.resolution))
		|| !isContinuationState(value.continuationState) || !isNonNegativeInteger(value.continuationAttempts)) return false;
	if (value.delivery.kind === "session" && (value.sessionId !== value.delivery.sessionId || !isLifecycleEvent(value.asker.event))) return false;
	if (value.delivery.kind === "project-import" && (value.sessionId !== undefined || value.goalId !== undefined || value.request.scope !== "project" || value.asker.event !== "projectImported")) return false;
	if (value.decisionClass === "consent-required" && value.request.default !== undefined) return false;
	if ((value.decisionClass ?? "deferrable") === "deferrable" && value.request.default === undefined) return false;
	if (value.status === "paused-awaiting-consent" && (!value.consentPause || !value.consentInbox)) return false;
	return value.proposal === undefined || isProposal(value.proposal);
}

/** The schema-1 request validator before delivery became explicit. */
function isLegacyStoredRequest(value: unknown): value is Omit<StoredDecisionRequest, "delivery"> & { sessionId: string } {
	if (!isRecord(value) || !isString(value.sessionId)) return false;
	return isStoredRequest({ ...value, delivery: { kind: "session", sessionId: value.sessionId } });
}

const IMPORT_LANGUAGES = new Set([
	"c", "cpp", "csharp", "dart", "elixir", "go", "haskell", "java", "javascript", "kotlin", "lua", "php", "python", "ruby", "rust", "scala", "shell", "sql", "swift", "typescript",
]);

function isDelivery(value: unknown): value is DecisionDelivery {
	return isRecord(value) && (value.kind === "session" && isSafeIdentifier(value.sessionId)
		|| value.kind === "project-import" && isSafeIdentifier(value.importId));
}

function isImportRun(value: unknown): value is StoredProjectImportRun {
	if (!isRecord(value) || !isSafeIdentifier(value.id) || !isSafeIdentifier(value.projectId) || !isImportContext(value.context)
		|| value.context.projectId !== value.projectId || value.context.importId !== value.id || !isIsoInstant(value.createdAt)
		|| (value.completedAt !== undefined && !isIsoInstant(value.completedAt)) || !isRecord(value.hooks)) return false;
	return Object.entries(value.hooks).every(([key, hook]) => isBoundedString(key, 256) && isImportHook(hook));
}

function isImportContext(value: unknown): value is StoredProjectImportContext {
	if (!isRecord(value) || value.event !== "projectImported" || !isSafeIdentifier(value.projectId) || !isSafeIdentifier(value.importId)
		|| !isCanonicalPath(value.projectRoot) || !Array.isArray(value.ownedRoots) || value.ownedRoots.length === 0 || value.ownedRoots.length > 31
		|| !value.ownedRoots.every(isCanonicalPath) || !Array.isArray(value.components) || value.components.length > 30) return false;
	if (new Set(value.ownedRoots).size !== value.ownedRoots.length || !value.ownedRoots.includes(value.projectRoot)) return false;
	return value.components.every(component => isRecord(component) && isSafeIdentifier(component.id) && isCanonicalPath(component.root)
		&& Array.isArray(component.languages) && component.languages.length <= 12 && component.languages.every(language => typeof language === "string" && IMPORT_LANGUAGES.has(language))
		&& new Set(component.languages).size === component.languages.length);
}

function isImportHook(value: unknown): boolean {
	return isRecord(value) && (value.state === "pending" || value.state === "completed")
		&& (value.completedAt === undefined || isIsoInstant(value.completedAt))
		&& (value.outcome === undefined || isImportOutcome(value.outcome))
		&& (value.state === "pending" ? value.completedAt === undefined && value.outcome === undefined : value.completedAt !== undefined && value.outcome !== undefined);
}

function isImportOutcome(value: unknown): value is ImportDecisionOutcomeCode {
	return value === "applied" || value === "superseded" || value === "denied" || value === "dropped" || value === "error";
}

function isCanonicalPath(value: unknown): value is string {
	return isString(value) && value.length > 0 && value.length <= 4096 && path.isAbsolute(value) && path.normalize(value) === value;
}

function isSafeIdentifier(value: unknown): value is string {
	return isString(value) && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function isValidatedRequest(value: unknown): value is ValidatedExtensionDecisionRequest {
	if (!isRecord(value) || value.version !== 1 || !isString(value.key) || !isString(value.title) || !isString(value.question)
		|| !Array.isArray(value.options) || !value.options.every(option => isRecord(option) && isString(option.value) && isString(option.label))
		|| !isRecord(value.other) || !isNonNegativeInteger(value.other.maxLength)
		|| (value.other.minLength !== undefined && !isNonNegativeInteger(value.other.minLength))
		|| (value.other.pattern !== undefined && !isString(value.other.pattern))
		|| (value.default !== undefined && !isDecisionValue(value.default))
		|| (value.intent !== undefined && !isString(value.intent))
		|| (value.requestedClass !== undefined && !isDecisionClass(value.requestedClass))
		|| !isDecisionScope(value.scope) || !isIsoInstant(value.deadlineAt)) return false;
	// A forced platform elevation may strip an originally deferrable default
	// before storage, so only a directly requested consent class is decided here.
	if (value.requestedClass === "consent-required" && value.default !== undefined) return false;
	return value.effect === undefined || isEffect(value.effect);
}

function isEffect(value: unknown): boolean {
	if (!isRecord(value) || !isString(value.kind)) return false;
	if (value.kind === "none") return Object.keys(value).length === 1;
	if (value.kind !== "proposal" || !isRecord(value.proposals)) return false;
	return Object.values(value.proposals).every(seed => isRecord(seed) && isProposalType(seed.proposalType) && isJsonRecord(seed.args));
}

function isMemory(value: unknown): value is DecisionMemory {
	return isRecord(value) && isDecisionScope(value.scope) && isString(value.scopeId) && isString(value.packId)
		&& isString(value.hookId) && isString(value.key) && isDecisionValue(value.value)
		&& isIsoInstant(value.validatedAt) && isString(value.sourceRequestId);
}

function isResolution(value: unknown): value is ValidatedDecisionResolution {
	return isRecord(value) && isDecisionValue(value.value) && (value.actor === "user" || value.actor === "deadline" || value.actor === "headless")
		&& (value.reason === "answered" || value.reason === "deadline_elapsed" || value.reason === "headless_default" || value.reason === "consent_denied");
}

function isProtectedOperation(value: unknown): value is DecisionProtectedOperation {
	return isRecord(value) && isString(value.id) && isString(value.kind);
}

function isConsentPause(value: unknown): value is DecisionConsentPause {
	return isRecord(value) && isString(value.goalId) && isRecord(value.reason)
		&& value.reason.kind === "awaiting-extension-consent" && isString(value.reason.requestId) && isIsoInstant(value.reason.createdAt)
		&& isIsoInstant(value.pausedAt) && (value.pauseAppliedAt === undefined || isIsoInstant(value.pauseAppliedAt))
		&& (value.resume === undefined || isConsentResume(value.resume));
}

function isConsentResume(value: unknown): boolean {
	return isRecord(value) && isConsentResumeStatus(value.status) && isIsoInstant(value.claimedAt)
		&& (value.completedAt === undefined || isIsoInstant(value.completedAt))
		&& (value.value === undefined || isDecisionValue(value.value));
}

function isValidDecisionValueForRequest(value: unknown, request: ValidatedExtensionDecisionRequest): value is DecisionValue {
	if (!isDecisionValue(value)) return false;
	if (value.kind === "option") return request.options.some(option => option.value === value.value);
	if (value.text.length < (request.other.minLength ?? 0) || value.text.length > request.other.maxLength) return false;
	try { return request.other.pattern === undefined || new RegExp(request.other.pattern, "u").test(value.text); } catch { return false; }
}

function isConsentInboxSurface(value: unknown): value is DecisionConsentInboxSurface {
	return isRecord(value) && isBoundedString(value.sourceKey, 256) && isConsentInboxSurfaceStatus(value.status)
		&& (value.entryId === undefined || isBoundedString(value.entryId, 256)) && isIsoInstant(value.updatedAt);
}

function matchesPause(request: StoredDecisionRequest, pause: ConsentPauseIdentity): boolean {
	return request.goalId === pause.goalId && pause.reason.requestId === request.id && pause.reason.kind === "awaiting-extension-consent" && isIsoInstant(pause.reason.createdAt);
}

function samePauseIdentity(stored: ConsentPauseIdentity, expected: ConsentPauseIdentity): boolean {
	return stored.goalId === expected.goalId && stored.reason.kind === expected.reason.kind
		&& stored.reason.requestId === expected.reason.requestId && stored.reason.createdAt === expected.reason.createdAt;
}

function isConsentInboxTransition(from: ConsentInboxSurfaceStatus, to: ConsentInboxSurfaceStatus): boolean {
	if (from === to) return true;
	if (from === "pending") return to === "surfaced" || to === "projection-only" || to === "completed" || to === "cancelled";
	return from === "surfaced" && (to === "completed" || to === "cancelled");
}

function isProposal(value: unknown): boolean {
	return isRecord(value) && (value.status === "created" || value.status === "failed") && isProposalType(value.type)
		&& (value.rev === undefined || isNonNegativeInteger(value.rev))
		&& (value.code === undefined || value.code === "PROPOSAL_SEED_FAILED");
}

function isDecisionValue(value: unknown): value is DecisionValue {
	return isRecord(value) && ((value.kind === "option" && isString(value.value)) || (value.kind === "other" && isString(value.text)));
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && isJson(value);
}

function isJson(value: unknown): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJson);
	return isRecord(value) && Object.values(value).every(isJson);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string { return typeof value === "string"; }
function isBoundedString(value: unknown, maxLength: number): value is string { return isString(value) && value.length > 0 && value.length <= maxLength; }
function isIsoInstant(value: unknown): value is string {
	if (!isString(value)) return false;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
function isNonNegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 0; }
function isDecisionStatus(value: unknown): value is DecisionStatus { return value === "pending" || value === "resolved" || value === "rejected" || value === "expired" || value === "superseded" || value === "defaulted" || value === "denied" || value === "paused-awaiting-consent"; }
function isTerminalStatus(value: DecisionStatus): value is DecisionTerminalStatus { return value !== "pending" && value !== "paused-awaiting-consent"; }
function isDecisionClass(value: unknown): value is DecisionClass { return value === "deferrable" || value === "consent-required"; }
function isClassificationReason(value: unknown): value is DecisionClassificationReason { return value === "requested" || value === "core-hard-cap" || value === "core-unsafe-tool" || value === "core-capability-change" || value === "core-grant-change" || value === "core-configuration-change"; }
function isConsentTimeoutAction(value: unknown): value is ConsentTimeoutAction { return value === "deny-operation" || value === "pause-goal"; }
function isConsentInboxSurfaceStatus(value: unknown): value is ConsentInboxSurfaceStatus { return value === "pending" || value === "surfaced" || value === "projection-only" || value === "completed" || value === "cancelled"; }
function isConsentResumeStatus(value: unknown): value is ConsentResumeStatus { return value === "claimed" || value === "resumed" || value === "already-resumed" || value === "not-matching" || value === "denied"; }
function isDecisionScope(value: unknown): value is DecisionScope { return value === "session" || value === "goal" || value === "project"; }
function isLifecycleEvent(value: unknown): value is DecisionLifecycleEvent { return value === "sessionSetup" || value === "beforePrompt" || value === "afterTurn" || value === "beforeCompact" || value === "sessionShutdown"; }
function isStoredEvent(value: unknown): value is StoredDecisionEvent { return value === "projectImported" || isLifecycleEvent(value); }
function isContinuationState(value: unknown): value is StoredDecisionRequest["continuationState"] { return value === "pending" || value === "delivered" || value === "skipped"; }
function isProposalType(value: unknown): value is ProposalType { return value === "goal" || value === "project" || value === "workflow" || value === "role" || value === "tool" || value === "staff"; }
