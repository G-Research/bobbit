import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FsLike } from "../gateway-deps.js";
import { realFs } from "../gateway-deps.js";
import { PROMPT_EXTENSION_IDENTIFIER } from "./prompt-extension-overrides.js";

export type PromptExtensionAuthoringStatus = "requested" | "proposed" | "accepted" | "rejected" | "failed" | "cancelled" | "superseded";

/** One terminal provider usage delta, never a session-cumulative CostTracker total. */
export interface PromptExtensionAuthoringUsage {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	cost?: number;
}

/** Durable, authorized-detail record. ContextTraceStore only receives safe status/id rows. */
export interface PromptExtensionAuthoringAuditEntry {
	id: string;
	at: string;
	status: PromptExtensionAuthoringStatus;
	packId: string;
	hookId: string;
	event: string;
	sectionId: string;
	actor: string;
	sessionId: string;
	goalId?: string;
	trigger: string;
	baselineDigest: string;
	baselineBytes: number;
	startedAt: string;
	endedAt?: string;
	durationMs?: number;
	proposalId?: string;
	diff?: string;
	model?: string;
	provider?: string;
	thinkingLevel?: string;
	usage?: PromptExtensionAuthoringUsage;
	sectionBytes?: number;
	totalPromptBytes?: number;
	sectionShare?: number;
	reason?: "Grant required" | "Over budget" | "Stale revision" | "Validation failed" | "Cancelled" | "Provider error";
}

export interface CreatePromptExtensionAuthoringAudit {
	id?: string;
	packId: string;
	hookId: string;
	event: string;
	sectionId: string;
	actor: string;
	sessionId: string;
	goalId?: string;
	trigger: string;
	baselineDigest: string;
	baselineBytes: number;
	/** Immutable proposal detail captured before the authoring turn reaches its terminal event. */
	proposalId?: string;
	diff?: string;
	model?: string;
	provider?: string;
	thinkingLevel?: string;
	sectionBytes?: number;
	totalPromptBytes?: number;
	startedAt?: string;
}

export interface CompletePromptExtensionAuthoringAudit {
	status: Exclude<PromptExtensionAuthoringStatus, "requested">;
	endedAt?: string;
	durationMs?: number;
	proposalId?: string;
	diff?: string;
	model?: string;
	provider?: string;
	thinkingLevel?: string;
	usage?: PromptExtensionAuthoringUsage;
	sectionBytes?: number;
	totalPromptBytes?: number;
	reason?: PromptExtensionAuthoringAuditEntry["reason"];
}

export class PromptExtensionAuthoringAuditStoreError extends Error {
	readonly code = "PROMPT_EXTENSION_AUDIT_UNAVAILABLE";
	constructor() {
		super("Prompt extension authoring audit is unavailable.");
		this.name = "PromptExtensionAuthoringAuditStoreError";
	}
}

/**
 * Append-only JSONL stores immutable snapshots. `list()` folds snapshots by id,
 * so a terminal event cannot destroy its request provenance after a restart.
 */
export class PromptExtensionAuthoringAuditStore {
	private readonly auditFile: string;

	constructor(private readonly stateDir: string, private readonly fs: FsLike = realFs, private readonly now: () => Date = () => new Date()) {
		this.auditFile = path.join(stateDir, "prompt-extension-authoring-audit.jsonl");
	}

	create(request: CreatePromptExtensionAuthoringAudit): PromptExtensionAuthoringAuditEntry {
		const at = (request.startedAt ? new Date(request.startedAt) : this.now()).toISOString();
		const entry: PromptExtensionAuthoringAuditEntry = {
			id: request.id ?? randomUUID(), at, status: "requested", packId: request.packId, hookId: request.hookId,
			event: request.event, sectionId: request.sectionId, actor: request.actor, sessionId: request.sessionId,
			...(request.goalId ? { goalId: request.goalId } : {}), trigger: request.trigger,
			baselineDigest: request.baselineDigest, baselineBytes: request.baselineBytes, startedAt: at,
			...(request.proposalId ? { proposalId: request.proposalId } : {}),
			...(request.diff ? { diff: request.diff } : {}),
			...(request.model ? { model: request.model } : {}),
			...(request.provider ? { provider: request.provider } : {}),
			...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
			...(typeof request.sectionBytes === "number" ? { sectionBytes: request.sectionBytes } : {}),
			...(typeof request.totalPromptBytes === "number" ? { totalPromptBytes: request.totalPromptBytes } : {}),
		};
		this.append(entry);
		return entry;
	}

	complete(id: string, update: CompletePromptExtensionAuthoringAudit): PromptExtensionAuthoringAuditEntry {
		if (!isId(id)) throw new PromptExtensionAuthoringAuditStoreError();
		const prior = this.get(id);
		if (!prior || !canTransition(prior.status, update.status)) throw new PromptExtensionAuthoringAuditStoreError();
		const endedAt = update.endedAt
			? new Date(update.endedAt).toISOString()
			: prior.endedAt ?? this.now().toISOString();
		const durationMs = update.durationMs ?? prior.durationMs ?? Math.max(0, new Date(endedAt).valueOf() - new Date(prior.startedAt).valueOf());
		const next: PromptExtensionAuthoringAuditEntry = {
			...prior, ...update, at: this.now().toISOString(), endedAt, durationMs,
			...(update.usage ? { usage: { ...update.usage } } : {}),
			...(typeof update.sectionBytes === "number" && typeof update.totalPromptBytes === "number" && update.totalPromptBytes > 0
				? { sectionShare: update.sectionBytes / update.totalPromptBytes }
				: {}),
		};
		this.append(next);
		return next;
	}

	get(id: string): PromptExtensionAuthoringAuditEntry | undefined {
		let found: PromptExtensionAuthoringAuditEntry | undefined;
		for (const entry of this.readRows()) if (entry.id === id) found = entry;
		return found;
	}

	/** Newest valid effective records, chronological. Diffs remain in this durable authorized store only. */
	list(limit = 100): PromptExtensionAuthoringAuditEntry[] {
		const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(200, limit)) : 100;
		const effective = new Map<string, PromptExtensionAuthoringAuditEntry>();
		for (const entry of this.readRows()) effective.set(entry.id, entry);
		return [...effective.values()].slice(-bounded);
	}

	private append(entry: PromptExtensionAuthoringAuditEntry): void {
		const normalized = normalize(entry);
		if (!normalized) throw new PromptExtensionAuthoringAuditStoreError();
		try {
			if (!this.fs.existsSync(this.stateDir)) this.fs.mkdirSync(this.stateDir, { recursive: true });
			this.fs.appendFileSync(this.auditFile, `${JSON.stringify(normalized)}\n`, "utf-8");
		} catch {
			throw new PromptExtensionAuthoringAuditStoreError();
		}
	}

	private readRows(): PromptExtensionAuthoringAuditEntry[] {
		try {
			if (!this.fs.existsSync(this.auditFile)) return [];
			const rows: PromptExtensionAuthoringAuditEntry[] = [];
			for (const line of this.fs.readFileSync(this.auditFile, "utf-8").split(/\r?\n/)) {
				if (!line) continue;
				try {
					const entry = normalize(JSON.parse(line));
					if (entry) rows.push(entry);
				} catch { /* Ignore corrupt/truncated append rows. */ }
			}
			return rows;
		} catch {
			throw new PromptExtensionAuthoringAuditStoreError();
		}
	}
}

const STATUSES = new Set<PromptExtensionAuthoringStatus>(["requested", "proposed", "accepted", "rejected", "failed", "cancelled", "superseded"]);
const REASONS = new Set<NonNullable<PromptExtensionAuthoringAuditEntry["reason"]>>(["Grant required", "Over budget", "Stale revision", "Validation failed", "Cancelled", "Provider error"]);
function canTransition(from: PromptExtensionAuthoringStatus, to: PromptExtensionAuthoringStatus): boolean {
	if (from === "requested") return to === "proposed" || to === "failed" || to === "cancelled" || to === "rejected";
	return from === "proposed" && (to === "accepted" || to === "rejected" || to === "superseded");
}

const SECRET_PATTERNS = [
	/\b(?:sk|rk|pk)_[A-Za-z0-9_-]{16,}\b/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\b(?:api[_-]?key|password|secret)\s*[:=]\s*[^\s]+/gi,
];

function normalize(value: unknown): PromptExtensionAuthoringAuditEntry | undefined {
	if (!isRecord(value) || !isId(value.id) || !isTimestamp(value.at) || !STATUSES.has(value.status as PromptExtensionAuthoringStatus)) return undefined;
	const requiredIds = ["packId", "hookId", "event", "sectionId", "actor", "sessionId", "trigger"] as const;
	if (requiredIds.some(key => !isSafeLabel(value[key]))) return undefined;
	if (typeof value.baselineDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.baselineDigest) || !nonNegative(value.baselineBytes) || !isTimestamp(value.startedAt)) return undefined;
	if (value.goalId !== undefined && !isSafeLabel(value.goalId)) return undefined;
	if (value.endedAt !== undefined && !isTimestamp(value.endedAt)) return undefined;
	if (value.durationMs !== undefined && !nonNegative(value.durationMs)) return undefined;
	if (value.sectionBytes !== undefined && !nonNegative(value.sectionBytes)) return undefined;
	if (value.totalPromptBytes !== undefined && !nonNegative(value.totalPromptBytes)) return undefined;
	if (value.reason !== undefined && !REASONS.has(value.reason as NonNullable<PromptExtensionAuthoringAuditEntry["reason"]>)) return undefined;
	const usage = normalizeUsage(value.usage);
	if (value.usage !== undefined && !usage) return undefined;
	const sectionShare = typeof value.sectionBytes === "number" && typeof value.totalPromptBytes === "number" && value.totalPromptBytes > 0
		? value.sectionBytes / value.totalPromptBytes : undefined;
	return {
		id: value.id, at: value.at, status: value.status as PromptExtensionAuthoringStatus,
		packId: value.packId, hookId: value.hookId, event: value.event, sectionId: value.sectionId,
		actor: value.actor, sessionId: value.sessionId, ...(typeof value.goalId === "string" ? { goalId: value.goalId } : {}),
		trigger: value.trigger, baselineDigest: value.baselineDigest, baselineBytes: value.baselineBytes, startedAt: value.startedAt,
		...(typeof value.endedAt === "string" ? { endedAt: value.endedAt } : {}),
		...(typeof value.durationMs === "number" ? { durationMs: value.durationMs } : {}),
		...(isId(value.proposalId) ? { proposalId: value.proposalId } : {}),
		...(typeof value.diff === "string" ? { diff: redact(value.diff).slice(0, 256 * 1024) } : {}),
		...(isSafeMetadata(value.model) ? { model: value.model } : {}),
		...(isSafeMetadata(value.provider) ? { provider: value.provider } : {}),
		...(isSafeMetadata(value.thinkingLevel) ? { thinkingLevel: value.thinkingLevel } : {}),
		...(usage ? { usage } : {}),
		...(typeof value.sectionBytes === "number" ? { sectionBytes: value.sectionBytes } : {}),
		...(typeof value.totalPromptBytes === "number" ? { totalPromptBytes: value.totalPromptBytes } : {}),
		...(sectionShare === undefined ? {} : { sectionShare }),
		...(typeof value.reason === "string" ? { reason: value.reason as PromptExtensionAuthoringAuditEntry["reason"] } : {}),
	};
}

function normalizeUsage(value: unknown): PromptExtensionAuthoringUsage | undefined {
	if (!isRecord(value)) return undefined;
	const keys = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "cost"] as const;
	const output: PromptExtensionAuthoringUsage = {};
	for (const key of keys) {
		if (value[key] === undefined) continue;
		if (!nonNegative(value[key])) return undefined;
		output[key] = value[key] as number;
	}
	return Object.keys(output).length > 0 ? output : undefined;
}

function redact(value: string): string {
	return SECRET_PATTERNS.reduce((output, pattern) => output.replace(pattern, "[REDACTED]"), value);
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function isSafeLabel(value: unknown): value is string { return typeof value === "string" && PROMPT_EXTENSION_IDENTIFIER.test(value); }
/** Model ids can include provider separators but never control characters or bulk output. */
function isSafeMetadata(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value); }
function isId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value); }
function isTimestamp(value: unknown): value is string { if (typeof value !== "string") return false; const date = new Date(value); return !Number.isNaN(date.valueOf()) && date.toISOString() === value; }
function nonNegative(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
