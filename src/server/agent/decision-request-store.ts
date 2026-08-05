import { randomUUID } from "node:crypto";
import path from "node:path";
import type { FsLike } from "../gateway-deps.js";
import { realFs } from "../gateway-deps.js";

/** Terminal decision records remain available for semantic deduplication. */
export const DECISION_REQUEST_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const DECISION_REQUEST_STORE_VERSION = 1 as const;

export type DecisionLifecycleEvent = "sessionSetup" | "beforePrompt" | "afterTurn" | "beforeCompact" | "sessionShutdown";
export type DecisionScope = "session" | "goal" | "project";
export type DecisionStatus = "pending" | "resolved" | "rejected" | "expired" | "superseded";
export type DecisionTerminalStatus = Exclude<DecisionStatus, "pending">;
export type DecisionActor = "user" | "deadline" | "headless";
export type DecisionReason = "answered" | "deadline_elapsed" | "headless_default";
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
	default: DecisionValue;
	scope: DecisionScope;
	deadlineAt: string;
	effect?: { kind: "none" } | { kind: "proposal"; proposals: Record<string, { proposalType: ProposalType; args: Record<string, unknown> }> };
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

export interface StoredDecisionRequest {
	id: string;
	projectId: string;
	sessionId: string;
	goalId?: string;
	asker: { packId: string; hookId: string; event: DecisionLifecycleEvent };
	dedupeId: string;
	questionId: string;
	request: ValidatedExtensionDecisionRequest;
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
		return this.list().filter(request => request.status === "pending" && (sessionId === undefined || request.sessionId === sessionId));
	}

	findByDedupeId(dedupeId: string): StoredDecisionRequest | undefined {
		for (const request of Object.values(this.state.requests)) {
			if (request.dedupeId === dedupeId) return clone(request);
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
		if (this.state.requests[request.id]) return false;
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

	/** Update only post-resolution delivery bookkeeping. */
	updateContinuation(
		id: string,
		update: Pick<StoredDecisionRequest, "continuationState" | "continuationAttempts">,
	): boolean {
		return this.commit(next => {
			const current = next.requests[id];
			if (!current || current.status === "pending") return false;
			current.continuationState = update.continuationState;
			current.continuationAttempts = update.continuationAttempts;
			return true;
		}) ?? false;
	}

	/** Record an optional proposal outcome after its independently isolated work. */
	updateProposal(id: string, proposal: StoredDecisionRequest["proposal"]): boolean {
		return this.commit(next => {
			const current = next.requests[id];
			if (!current || current.status === "pending") return false;
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
				if (request.status === "pending") continue;
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
			if (!isState(parsed)) throw new Error("invalid decision request state");
			this.state = clone(parsed);
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
	return { version: DECISION_REQUEST_STORE_VERSION, requests: {}, memories: {} };
}

/** JSON cloning provides both defensive copies and a JSON-only persistence fence. */
function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function memoryKey(memory: DecisionMemoryIdentity): string {
	// JSON avoids delimiter collisions while preserving the exact five-part key.
	return JSON.stringify([memory.scope, memory.scopeId, memory.packId, memory.hookId, memory.key]);
}

function isState(value: unknown): value is DecisionRequestStoreState {
	if (!isRecord(value) || value.version !== DECISION_REQUEST_STORE_VERSION || !isRecord(value.requests) || !isRecord(value.memories)) return false;
	return Object.entries(value.requests).every(([id, request]) => isStoredRequest(request) && request.id === id)
		&& Object.values(value.memories).every(isMemory);
}

function isStoredRequest(value: unknown): value is StoredDecisionRequest {
	if (!isRecord(value)
		|| !isString(value.id) || !isString(value.projectId) || !isString(value.sessionId)
		|| (value.goalId !== undefined && !isString(value.goalId))
		|| !isRecord(value.asker) || !isString(value.asker.packId) || !isString(value.asker.hookId) || !isLifecycleEvent(value.asker.event)
		|| !isString(value.dedupeId) || !isString(value.questionId) || !isValidatedRequest(value.request)
		|| !isDecisionStatus(value.status) || !isIsoInstant(value.createdAt) || !isIsoInstant(value.deadlineAt)
		|| (value.resolvedAt !== undefined && !isIsoInstant(value.resolvedAt))
		|| (value.resolution !== undefined && !isResolution(value.resolution))
		|| !isContinuationState(value.continuationState) || !isNonNegativeInteger(value.continuationAttempts)) return false;
	return value.proposal === undefined || isProposal(value.proposal);
}

function isValidatedRequest(value: unknown): value is ValidatedExtensionDecisionRequest {
	if (!isRecord(value) || value.version !== 1 || !isString(value.key) || !isString(value.title) || !isString(value.question)
		|| !Array.isArray(value.options) || !value.options.every(option => isRecord(option) && isString(option.value) && isString(option.label))
		|| !isRecord(value.other) || !isNonNegativeInteger(value.other.maxLength)
		|| (value.other.minLength !== undefined && !isNonNegativeInteger(value.other.minLength))
		|| (value.other.pattern !== undefined && !isString(value.other.pattern))
		|| !isDecisionValue(value.default) || !isDecisionScope(value.scope) || !isIsoInstant(value.deadlineAt)) return false;
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
		&& (value.reason === "answered" || value.reason === "deadline_elapsed" || value.reason === "headless_default");
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
function isIsoInstant(value: unknown): value is string {
	if (!isString(value)) return false;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
function isNonNegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 0; }
function isDecisionStatus(value: unknown): value is DecisionStatus { return value === "pending" || value === "resolved" || value === "rejected" || value === "expired" || value === "superseded"; }
function isDecisionScope(value: unknown): value is DecisionScope { return value === "session" || value === "goal" || value === "project"; }
function isLifecycleEvent(value: unknown): value is DecisionLifecycleEvent { return value === "sessionSetup" || value === "beforePrompt" || value === "afterTurn" || value === "beforeCompact" || value === "sessionShutdown"; }
function isContinuationState(value: unknown): value is StoredDecisionRequest["continuationState"] { return value === "pending" || value === "delivered" || value === "skipped"; }
function isProposalType(value: unknown): value is ProposalType { return value === "goal" || value === "project" || value === "workflow" || value === "role" || value === "tool" || value === "staff"; }
