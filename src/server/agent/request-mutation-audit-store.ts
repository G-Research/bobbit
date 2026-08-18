import { randomUUID } from "node:crypto";
import path from "node:path";
import type { FsLike } from "../gateway-deps.js";
import { realFs } from "../gateway-deps.js";
import { redactAuditDiffSecrets } from "../auth/redact.js";

/** Fixed, core-owned diagnostics. Extension reason ids and error text never persist. */
export const REQUEST_MUTATION_AUDIT_REASONS = [
	"Grant required",
	"Prompt mutation disabled",
	"Malformed result",
	"Over budget",
	"Timed out",
	"Lower-priority proposal",
	"Tool warning",
	"Tool denied",
	"Prompt shaped",
	"Unavailable",
] as const;
export type RequestMutationAuditReason = typeof REQUEST_MUTATION_AUDIT_REASONS[number];

export const REQUEST_MUTATION_AUDIT_OUTCOMES = ["applied", "warned", "denied", "dropped", "error", "superseded"] as const;
export type RequestMutationAuditOutcome = typeof REQUEST_MUTATION_AUDIT_OUTCOMES[number];
export const REQUEST_MUTATION_AUDIT_EVENTS = ["beforePrompt", "beforeToolCall"] as const;
export type RequestMutationAuditEvent = typeof REQUEST_MUTATION_AUDIT_EVENTS[number];

/** Authorized, project-owned diagnostic evidence. Never use this as an authority source. */
export interface RequestMutationAuditEntry {
	id: string;
	at: string;
	sessionId: string;
	event: RequestMutationAuditEvent;
	packId?: string;
	hookId?: string;
	outcome: RequestMutationAuditOutcome;
	reason: RequestMutationAuditReason;
	/** Prompt evidence only; always high-confidence redacted and UTF-8 capped. */
	before?: string;
	after?: string;
	/** Byte sizes of the bounded, pre-redaction request payloads. */
	beforeBytes?: number;
	afterBytes?: number;
	/** Exact inspected tool id, never arguments or results. */
	toolName?: string;
}

/** `id` and `at` default to core-generated values to make append callers simple. */
export type RequestMutationAuditInput = Omit<RequestMutationAuditEntry, "id" | "at" | "beforeBytes" | "afterBytes"> & {
	id?: string;
	at?: string;
};

export class RequestMutationAuditStoreError extends Error {
	readonly code = "REQUEST_MUTATION_AUDIT_UNAVAILABLE";
	constructor() {
		super("Request mutation audit is unavailable.");
		this.name = "RequestMutationAuditStoreError";
	}
}

const MAX_AUDIT_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_BYTES = 32 * 1024;
const MAX_DIFF_BYTES = 16 * 1024;
const CLIPPED_MARKER = "\n[TRUNCATED]";
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EVENTS = new Set<string>(REQUEST_MUTATION_AUDIT_EVENTS);
const OUTCOMES = new Set<string>(REQUEST_MUTATION_AUDIT_OUTCOMES);
const REASONS = new Set<string>(REQUEST_MUTATION_AUDIT_REASONS);

/**
 * Bounded append-only JSONL for one project's request-mutation diagnostics.
 * Prompt text is redacted before this store serializes it, and read rows are
 * normalized again so historical/corrupt content cannot bypass that boundary.
 */
export class RequestMutationAuditStore {
	private readonly auditFile: string;

	constructor(private readonly stateDir: string, private readonly fs: FsLike = realFs, private readonly now: () => Date = () => new Date()) {
		this.auditFile = path.join(stateDir, "request-mutation-audit.jsonl");
	}

	append(input: RequestMutationAuditInput): RequestMutationAuditEntry {
		const entry = normalize({ ...input, id: input.id ?? randomUUID(), at: input.at ?? this.now().toISOString() });
		if (!entry) throw new RequestMutationAuditStoreError();
		try {
			if (!this.fs.existsSync(this.stateDir)) this.fs.mkdirSync(this.stateDir, { recursive: true });
			this.fs.appendFileSync(this.auditFile, `${JSON.stringify(entry)}\n`, "utf-8");
			this.enforceCap();
			return entry;
		} catch {
			// File-system errors can contain paths or mocked payloads. Do not expose them.
			throw new RequestMutationAuditStoreError();
		}
	}

	/** Newest valid rows in chronological order. Corrupt/truncated lines are skipped. */
	list(limit = 100): RequestMutationAuditEntry[] {
		const bounded = boundedLimit(limit);
		return this.readRows().slice(-bounded);
	}

	/** Session-filtered diagnostic view for the operator route. */
	listForSession(sessionId: string, limit = 100): RequestMutationAuditEntry[] {
		if (!isIdentifier(sessionId)) return [];
		const bounded = boundedLimit(limit);
		return this.readRows().filter(row => row.sessionId === sessionId).slice(-bounded);
	}

	private readRows(): RequestMutationAuditEntry[] {
		try {
			if (!this.fs.existsSync(this.auditFile)) return [];
			const rows: RequestMutationAuditEntry[] = [];
			for (const line of this.fs.readFileSync(this.auditFile, "utf-8").split(/\r?\n/)) {
				if (!line) continue;
				try {
					const entry = normalize(JSON.parse(line));
					if (entry) rows.push(entry);
				} catch { /* Ignore corrupt or partial JSONL rows. */ }
			}
			return rows;
		} catch {
			throw new RequestMutationAuditStoreError();
		}
	}

	private enforceCap(): void {
		const stat = this.fs.statSync(this.auditFile);
		if (stat.size <= MAX_AUDIT_BYTES) return;
		const kept: string[] = [];
		let bytes = 0;
		for (const sourceLine of this.fs.readFileSync(this.auditFile, "utf-8").split(/\r?\n/).reverse()) {
			if (!sourceLine) continue;
			// Re-normalize while rotating: a corrupt historical line must never be
			// copied forward as a fresh durable secret-bearing record.
			let entry: RequestMutationAuditEntry | undefined;
			try { entry = normalize(JSON.parse(sourceLine)); } catch { continue; }
			if (!entry) continue;
			const line = `${JSON.stringify(entry)}\n`;
			const lineBytes = Buffer.byteLength(line);
			if (bytes + lineBytes > MAX_AUDIT_BYTES) break;
			kept.push(line);
			bytes += lineBytes;
		}
		kept.reverse();
		const temp = `${this.auditFile}.tmp-${process.pid}-${Date.now()}`;
		this.fs.writeFileSync(temp, kept.join(""), "utf-8");
		this.fs.renameSync(temp, this.auditFile);
	}
}

function normalize(value: unknown): RequestMutationAuditEntry | undefined {
	if (!isRecord(value)
		|| !isIdentifier(value.id)
		|| !isTimestamp(value.at)
		|| !isIdentifier(value.sessionId)
		|| typeof value.event !== "string" || !EVENTS.has(value.event)
		|| typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome)
		|| typeof value.reason !== "string" || !REASONS.has(value.reason)) return undefined;
	if (value.packId !== undefined && !isIdentifier(value.packId)) return undefined;
	if (value.hookId !== undefined && !isIdentifier(value.hookId)) return undefined;
	const event = value.event as RequestMutationAuditEvent;
	if (value.toolName !== undefined && (!isIdentifier(value.toolName) || event !== "beforeToolCall")) return undefined;
	if (event === "beforeToolCall" && (value.before !== undefined || value.after !== undefined || value.beforeBytes !== undefined || value.afterBytes !== undefined)) return undefined;
	if (event === "beforePrompt" && value.toolName !== undefined) return undefined;
	const before = normalizePromptEvidence(value.before, value.beforeBytes);
	const after = normalizePromptEvidence(value.after, value.afterBytes);
	if ((value.before !== undefined && !before) || (value.beforeBytes !== undefined && !before)
		|| (value.after !== undefined && !after) || (value.afterBytes !== undefined && !after)) return undefined;
	return {
		id: value.id,
		at: value.at,
		sessionId: value.sessionId,
		event,
		...(typeof value.packId === "string" ? { packId: value.packId } : {}),
		...(typeof value.hookId === "string" ? { hookId: value.hookId } : {}),
		outcome: value.outcome as RequestMutationAuditOutcome,
		reason: value.reason as RequestMutationAuditReason,
		...(before ? { before: before.text, beforeBytes: before.bytes } : {}),
		...(after ? { after: after.text, afterBytes: after.bytes } : {}),
		...(typeof value.toolName === "string" ? { toolName: value.toolName } : {}),
	};
}

function normalizePromptEvidence(value: unknown, persistedBytes: unknown): { text: string; bytes: number } | undefined {
	if (typeof value !== "string") return undefined;
	const bytes = Buffer.byteLength(value);
	// Request-mutation contract bounds request and replacement inputs to 32 KiB.
	// Reject oversized direct calls rather than retaining a partial secret-shaped input.
	if (bytes > MAX_PROMPT_BYTES) return undefined;
	if (persistedBytes !== undefined && (typeof persistedBytes !== "number"
		|| !Number.isSafeInteger(persistedBytes)
		|| persistedBytes < 0
		|| persistedBytes > MAX_PROMPT_BYTES)) return undefined;
	return { text: clipUtf8(redactAuditDiffSecrets(value)), bytes: typeof persistedBytes === "number" ? persistedBytes : bytes };
}

function clipUtf8(value: string): string {
	if (Buffer.byteLength(value) <= MAX_DIFF_BYTES) return value;
	const budget = MAX_DIFF_BYTES - Buffer.byteLength(CLIPPED_MARKER);
	let bytes = 0;
	let clipped = "";
	for (const char of value) {
		const size = Buffer.byteLength(char);
		if (bytes + size > budget) break;
		clipped += char;
		bytes += size;
	}
	return clipped + CLIPPED_MARKER;
}

function boundedLimit(limit: number): number {
	return Number.isInteger(limit) ? Math.max(1, Math.min(200, limit)) : 100;
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function isIdentifier(value: unknown): value is string { return typeof value === "string" && SAFE_IDENTIFIER.test(value); }
function isTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const date = new Date(value);
	return Number.isFinite(date.valueOf()) && date.toISOString() === value;
}
