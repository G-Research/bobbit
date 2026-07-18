/**
 * Bobbit-owned author persistence for Pi user-role prompt echoes.
 *
 * Storage is host-side at `<stateDir>/author-sidecar/<sessionId>.jsonl` so
 * sandbox transcript paths remain untouched. All I/O is best-effort.
 */
import fs from "node:fs";
import path from "node:path";
import { isMessageAuthor, type MessageAuthor } from "../../shared/message-author.js";
import { isPromptSource, type PromptSource } from "../../shared/prompt-source.js";
import {
	isToolResultOnlyMessage,
	normalizeVisibleMessages,
	type NormalizeVisibleMessageContext,
} from "./message-author.js";

export interface PromptAuthorDispatchRecord {
	schemaVersion: 1;
	type: "prompt-author";
	promptId: string;
	dispatchedAt: number;
	modelText: string;
	source: PromptSource;
	author: MessageAuthor;
}

export interface PromptAuthorSettlementRecord {
	schemaVersion: 1;
	type: "prompt-author-settlement";
	promptId: string;
	settledAt: number;
	outcome: "echoed" | "cancelled";
	messageId?: string;
	messageTimestamp?: number;
}

export type AuthorSidecarRecord = PromptAuthorDispatchRecord | PromptAuthorSettlementRecord;
export type PromptAuthorDispatchInput = Omit<PromptAuthorDispatchRecord, "schemaVersion" | "type">;
export type PromptAuthorSettlementInput = Omit<PromptAuthorSettlementRecord, "schemaVersion" | "type">;

export interface PromptAuthorBinding extends PromptAuthorDispatchRecord {
	settlement?: PromptAuthorSettlementRecord;
}

const CORRELATION_TOLERANCE_MS = 2_000;
const MAX_KEY_LENGTH = 256;
let sidecarDir: string | undefined;

export function initAuthorSidecarDir(stateDir: string): void {
	sidecarDir = path.join(stateDir, "author-sidecar");
	try {
		if (!fs.existsSync(sidecarDir)) fs.mkdirSync(sidecarDir, { recursive: true });
	} catch (error) {
		console.warn(`[author-sidecar] Failed to create sidecar dir at ${sidecarDir}:`, error);
	}
}

function getSidecarDir(): string | undefined {
	if (!sidecarDir) return undefined;
	try {
		if (!fs.existsSync(sidecarDir)) fs.mkdirSync(sidecarDir, { recursive: true });
	} catch { /* append/read will degrade safely */ }
	return sidecarDir;
}

function filePath(sessionId: string): string | undefined {
	const dir = getSidecarDir();
	if (!dir) return undefined;
	const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 160) || "unknown";
	return path.join(dir, `${safe}.jsonl`);
}

function validKey(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_KEY_LENGTH;
}

function validTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isDispatchRecord(value: unknown): value is PromptAuthorDispatchRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return record.schemaVersion === 1
		&& record.type === "prompt-author"
		&& validKey(record.promptId)
		&& validTimestamp(record.dispatchedAt)
		&& typeof record.modelText === "string"
		&& isPromptSource(record.source)
		&& isMessageAuthor(record.author);
}

function isSettlementRecord(value: unknown): value is PromptAuthorSettlementRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return record.schemaVersion === 1
		&& record.type === "prompt-author-settlement"
		&& validKey(record.promptId)
		&& validTimestamp(record.settledAt)
		&& (record.outcome === "echoed" || record.outcome === "cancelled")
		&& (record.messageId === undefined || validKey(record.messageId))
		&& (record.messageTimestamp === undefined || validTimestamp(record.messageTimestamp));
}

function appendRecord(sessionId: string, record: AuthorSidecarRecord): boolean {
	const target = filePath(sessionId);
	if (!target) return false;
	try {
		fs.appendFileSync(target, `${JSON.stringify(record)}\n`, "utf8");
		return true;
	} catch (error) {
		console.warn(`[author-sidecar] Append failed for session ${sessionId}:`, error);
		return false;
	}
}

export function appendPromptAuthorDispatch(
	sessionId: string,
	input: PromptAuthorDispatchInput | PromptAuthorDispatchRecord,
): boolean {
	const record: PromptAuthorDispatchRecord = {
		schemaVersion: 1,
		type: "prompt-author",
		promptId: input.promptId,
		dispatchedAt: input.dispatchedAt,
		modelText: input.modelText,
		source: input.source,
		author: input.author,
	};
	if (!isDispatchRecord(record)) return false;
	return appendRecord(sessionId, record);
}

export function appendPromptAuthorSettlement(
	sessionId: string,
	input: PromptAuthorSettlementInput | PromptAuthorSettlementRecord,
): boolean {
	const record: PromptAuthorSettlementRecord = {
		schemaVersion: 1,
		type: "prompt-author-settlement",
		promptId: input.promptId,
		settledAt: input.settledAt,
		outcome: input.outcome,
		...(input.messageId === undefined ? {} : { messageId: input.messageId }),
		...(input.messageTimestamp === undefined ? {} : { messageTimestamp: input.messageTimestamp }),
	};
	if (!isSettlementRecord(record)) return false;
	return appendRecord(sessionId, record);
}

/** Fold redispatches by prompt id. The latest dispatch resets any prior settlement. */
export function foldAuthorSidecarRecords(records: AuthorSidecarRecord[]): PromptAuthorBinding[] {
	const bindings = new Map<string, PromptAuthorBinding>();
	for (const record of records) {
		if (isDispatchRecord(record)) {
			bindings.set(record.promptId, { ...record });
			continue;
		}
		if (!isSettlementRecord(record)) continue;
		const binding = bindings.get(record.promptId);
		if (!binding) continue;
		binding.settlement = record;
	}
	return [...bindings.values()].sort((left, right) => left.dispatchedAt - right.dispatchedAt);
}

/** Missing, corrupt, partial, and future-version sidecars safely read as absent rows. */
export function readAuthorSidecar(sessionId: string): PromptAuthorBinding[] {
	const target = filePath(sessionId);
	if (!target) return [];
	try {
		if (!fs.existsSync(target)) return [];
		const records: AuthorSidecarRecord[] = [];
		for (const line of fs.readFileSync(target, "utf8").split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed: unknown = JSON.parse(trimmed);
				if (isDispatchRecord(parsed) || isSettlementRecord(parsed)) records.push(parsed);
			} catch { /* a partial final line is expected after some crashes */ }
		}
		return foldAuthorSidecarRecords(records);
	} catch (error) {
		console.warn(`[author-sidecar] Read failed for session ${sessionId}:`, error);
		return [];
	}
}

export function extractPromptModelText(message: Record<string, unknown>): string | undefined {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return undefined;
	const parts: string[] = [];
	for (const block of message.content) {
		if (!block || typeof block !== "object" || Array.isArray(block)) continue;
		const candidate = block as Record<string, unknown>;
		if (candidate.type === "text" && typeof candidate.text === "string") parts.push(candidate.text);
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

function messageId(message: Record<string, unknown>): string | undefined {
	for (const key of ["id", "entryId", "_entryId", "_bobbitEntryId"]) {
		const value = message[key];
		if (typeof value === "string" && value) return value;
	}
	return undefined;
}

function epochMilliseconds(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || !value) return undefined;
	const numeric = Number(value);
	if (Number.isFinite(numeric)) return numeric;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function messageTimestamp(message: Record<string, unknown>): number | undefined {
	return epochMilliseconds(message.timestamp) ?? epochMilliseconds(message.ts);
}

function eligiblePromptMessage(message: Record<string, unknown>): boolean {
	return (message.role === "user" || message.role === "user-with-attachments")
		&& !isToolResultOnlyMessage(message);
}

function sameAuthor(left: unknown, right: MessageAuthor): boolean {
	return isMessageAuthor(left)
		&& left.kind === right.kind
		&& left.id === right.id
		&& left.label === right.label;
}

/**
 * Correlate sidecar bindings before inference. Matching is global by phase so
 * an early legacy duplicate cannot consume a later row's exact id binding.
 */
export function mergeAuthorSidecarIntoMessages<T extends object>(
	entries: PromptAuthorBinding[],
	messages: T[],
	context: NormalizeVisibleMessageContext = {},
): Array<T & { author?: MessageAuthor }> {
	if (!Array.isArray(messages)) return messages;
	const available = entries
		.filter((entry) => isDispatchRecord(entry) && entry.settlement?.outcome !== "cancelled")
		.sort((left, right) => left.dispatchedAt - right.dispatchedAt);
	const consumed = new Set<PromptAuthorBinding>();
	const assignments = new Map<number, MessageAuthor>();
	const rows = messages as Array<T & Record<string, unknown>>;

	// Phase 1: exact settled Pi/session entry id.
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index];
		if (!eligiblePromptMessage(row)) continue;
		const id = messageId(row);
		if (!id) continue;
		const binding = available.find((candidate) =>
			!consumed.has(candidate) && candidate.settlement?.messageId === id,
		);
		if (!binding) continue;
		assignments.set(index, binding.author);
		consumed.add(binding);
	}

	// Phase 2: exact model text and a settled message timestamp within two seconds.
	for (let index = 0; index < rows.length; index++) {
		if (assignments.has(index)) continue;
		const row = rows[index];
		if (!eligiblePromptMessage(row)) continue;
		const text = extractPromptModelText(row);
		const timestamp = messageTimestamp(row);
		if (text === undefined || timestamp === undefined) continue;
		const binding = available.find((candidate) => {
			if (consumed.has(candidate) || candidate.modelText !== text) return false;
			const settledTimestamp = candidate.settlement?.messageTimestamp
				?? candidate.settlement?.settledAt;
			return settledTimestamp !== undefined
				&& Math.abs(timestamp - settledTimestamp) <= CORRELATION_TOLERANCE_MS;
		});
		if (!binding) continue;
		assignments.set(index, binding.author);
		consumed.add(binding);
	}

	// Phase 3: FIFO exact text, consuming duplicate dispatches individually.
	for (let index = 0; index < rows.length; index++) {
		if (assignments.has(index)) continue;
		const row = rows[index];
		if (!eligiblePromptMessage(row)) continue;
		const text = extractPromptModelText(row);
		if (text === undefined) continue;
		const binding = available.find((candidate) =>
			!consumed.has(candidate) && candidate.modelText === text,
		);
		if (!binding) continue;
		assignments.set(index, binding.author);
		consumed.add(binding);
	}

	let authored: T[] = messages;
	if (assignments.size > 0) {
		let changed = false;
		authored = messages.map((row, index) => {
			const author = assignments.get(index);
			if (!author || sameAuthor((row as T & { author?: unknown }).author, author)) return row;
			changed = true;
			return { ...row, author };
		});
		if (!changed) authored = messages;
	}
	// Authors attached above came from Bobbit's validated sidecar; callers also
	// splice only Bobbit-owned live/steer metadata before reaching this helper.
	return normalizeVisibleMessages(authored, { ...context, existingAuthorIsTrusted: true });
}

/** Copy author metadata only after the destination Bobbit session id exists. */
export function copyAuthorSidecar(fromSessionId: string, toSessionId: string): boolean {
	const source = filePath(fromSessionId);
	const destination = filePath(toSessionId);
	if (!source || !destination) return false;
	try {
		if (!fs.existsSync(source)) return true;
		fs.copyFileSync(source, destination);
		return true;
	} catch (error) {
		console.warn(`[author-sidecar] Copy failed from ${fromSessionId} to ${toSessionId}:`, error);
		return false;
	}
}

export function purgeAuthorSidecar(sessionId: string): void {
	const target = filePath(sessionId);
	if (!target) return;
	try {
		if (fs.existsSync(target)) fs.unlinkSync(target);
	} catch { /* purge is best-effort */ }
}
