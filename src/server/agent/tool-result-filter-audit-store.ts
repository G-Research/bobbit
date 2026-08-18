import { randomUUID } from "node:crypto";
import path from "node:path";
import type { FsLike } from "../gateway-deps.js";
import { realFs } from "../gateway-deps.js";
import { isToolResultFilterReasonCode } from "./tool-result-filter-reason-codes.js";

export const TOOL_RESULT_FILTER_AUDIT_ACTIONS = ["pass", "replace", "redact", "reject"] as const;
export type ToolResultFilterAuditAction = typeof TOOL_RESULT_FILTER_AUDIT_ACTIONS[number];

/** Core-owned terminal state; never extension exception text. */
export const TOOL_RESULT_FILTER_AUDIT_OUTCOMES = ["applied", "denied", "dropped", "error", "superseded"] as const;
export type ToolResultFilterAuditOutcome = typeof TOOL_RESULT_FILTER_AUDIT_OUTCOMES[number];

/**
 * Metadata-only filter evidence. This intentionally has no result, content,
 * details, usage, MIME, URL, digest, or error-text field.
 */
export interface ToolResultFilterAuditEntry {
	id: string;
	at: string;
	sessionId: string;
	toolCallId: string;
	toolName: string;
	packId?: string;
	hookId?: string;
	action: ToolResultFilterAuditAction;
	outcome: ToolResultFilterAuditOutcome;
	reasonCode: string;
	ruleId?: string;
	inputBytes: number;
	outputBytes: number;
	latencyMs: number;
}

export type ToolResultFilterAuditInput = Omit<ToolResultFilterAuditEntry, "id" | "at"> & { id?: string; at?: string };

const MAX_AUDIT_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 200;
const MAX_NUMBER = 256 * 1024;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ACTIONS = new Set<string>(TOOL_RESULT_FILTER_AUDIT_ACTIONS);
const OUTCOMES = new Set<string>(TOOL_RESULT_FILTER_AUDIT_OUTCOMES);
// Dispatcher-owned action/error vocabulary. Never persist a worker's proposal
// reason even when it happens to be a syntactically safe identifier.
const ENTRY_KEYS = new Set(["id", "at", "sessionId", "toolCallId", "toolName", "packId", "hookId", "action", "outcome", "reasonCode", "ruleId", "inputBytes", "outputBytes", "latencyMs"]);

/**
 * Bounded append-only project audit. It is deliberately fail-silent: diagnostic
 * persistence must never cause a caller to serialize a result while reporting a
 * filesystem error. The only log labels are fixed literals.
 */
export class ToolResultFilterAuditStore {
	private readonly auditFile: string;

	constructor(private readonly stateDir: string, private readonly fs: FsLike = realFs, private readonly now: () => Date = () => new Date()) {
		this.auditFile = path.join(stateDir, "tool-result-filter-audit.jsonl");
	}

	append(input: ToolResultFilterAuditInput): ToolResultFilterAuditEntry | undefined {
		const entry = normalize({ ...input, id: input.id ?? randomUUID(), at: input.at ?? this.now().toISOString() });
		if (!entry) return undefined;
		try {
			if (!this.fs.existsSync(this.stateDir)) this.fs.mkdirSync(this.stateDir, { recursive: true });
			this.fs.appendFileSync(this.auditFile, `${JSON.stringify(entry)}\n`, "utf-8");
			this.enforceCap();
			return entry;
		} catch {
			this.logFailure("write failed");
			return undefined;
		}
	}

	/** Newest valid rows, returned in chronological order and normalized anew. */
	list(limit = 100): ToolResultFilterAuditEntry[] {
		const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(MAX_ROWS, limit)) : 100;
		try {
			if (!this.fs.existsSync(this.auditFile)) return [];
			const entries: ToolResultFilterAuditEntry[] = [];
			for (const line of this.fs.readFileSync(this.auditFile, "utf-8").split(/\r?\n/)) {
				if (!line) continue;
				try {
					const entry = normalize(JSON.parse(line));
					if (entry) entries.push(entry);
				} catch { /* Corrupt and partial rows are never returned. */ }
			}
			return entries.slice(-bounded);
		} catch {
			this.logFailure("read failed");
			return [];
		}
	}

	listForSession(sessionId: string, limit = 100): ToolResultFilterAuditEntry[] {
		if (!isIdentifier(sessionId)) return [];
		const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(MAX_ROWS, limit)) : 100;
		return this.list(MAX_ROWS).filter(entry => entry.sessionId === sessionId).slice(-bounded);
	}

	private enforceCap(): void {
		const stat = this.fs.statSync(this.auditFile);
		if (stat.size <= MAX_AUDIT_BYTES) return;
		const kept: string[] = [];
		let bytes = 0;
		for (const sourceLine of this.fs.readFileSync(this.auditFile, "utf-8").split(/\r?\n/).reverse()) {
			if (!sourceLine) continue;
			let entry: ToolResultFilterAuditEntry | undefined;
			try { entry = normalize(JSON.parse(sourceLine)); } catch { continue; }
			if (!entry) continue;
			const line = `${JSON.stringify(entry)}\n`;
			const lineBytes = Buffer.byteLength(line, "utf8");
			if (bytes + lineBytes > MAX_AUDIT_BYTES) break;
			kept.push(line);
			bytes += lineBytes;
		}
		kept.reverse();
		const temp = `${this.auditFile}.tmp-${process.pid}-${Date.now()}`;
		this.fs.writeFileSync(temp, kept.join(""), "utf-8");
		this.fs.renameSync(temp, this.auditFile);
	}

	private logFailure(operation: "write failed" | "read failed"): void {
		// Never interpolate paths, errors, inputs, or a serialized row here.
		console.warn(`[tool-result-filter-audit] ${operation}`);
	}
}

function normalize(value: unknown): ToolResultFilterAuditEntry | undefined {
	if (!isRecord(value) || Object.keys(value).some(key => !ENTRY_KEYS.has(key))
		|| !isIdentifier(value.id)
		|| !isTimestamp(value.at)
		|| !isIdentifier(value.sessionId)
		|| !isIdentifier(value.toolCallId)
		|| !isIdentifier(value.toolName)
		|| typeof value.action !== "string" || !ACTIONS.has(value.action)
		|| typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome)
		|| !isIdentifier(value.reasonCode) || !isToolResultFilterReasonCode(value.reasonCode)
		|| !boundedNumber(value.inputBytes)
		|| !boundedNumber(value.outputBytes)
		|| !boundedNumber(value.latencyMs)) return undefined;
	if (value.packId !== undefined && !isIdentifier(value.packId)) return undefined;
	if (value.hookId !== undefined && !isIdentifier(value.hookId)) return undefined;
	// Rule identity is declaration-owned: if present it is exactly the selected
	// hook id, never a worker-selected label.
	if (value.ruleId !== undefined && (!isIdentifier(value.ruleId) || value.ruleId !== value.hookId)) return undefined;
	return {
		id: value.id, at: value.at, sessionId: value.sessionId, toolCallId: value.toolCallId, toolName: value.toolName,
		...(typeof value.packId === "string" ? { packId: value.packId } : {}),
		...(typeof value.hookId === "string" ? { hookId: value.hookId } : {}),
		action: value.action as ToolResultFilterAuditAction, outcome: value.outcome as ToolResultFilterAuditOutcome,
		reasonCode: value.reasonCode,
		...(typeof value.ruleId === "string" ? { ruleId: value.ruleId } : {}),
		inputBytes: value.inputBytes, outputBytes: value.outputBytes, latencyMs: value.latencyMs,
	};
}

function boundedNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_NUMBER;
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function isIdentifier(value: unknown): value is string { return typeof value === "string" && SAFE_IDENTIFIER.test(value); }
function isTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const date = new Date(value);
	return Number.isFinite(date.valueOf()) && date.toISOString() === value;
}
