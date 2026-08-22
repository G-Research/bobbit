import { randomBytes } from "node:crypto";

/** Durable metadata for one model-context generation replacement. */
export interface ContextClearBoundary {
	schemaVersion: 1;
	id: string;
	clearedAt: string;
	previousAgentSessionFile: string;
	activatedAgentSessionFile: string;
	activatedTranscriptMaterialized: boolean;
	previousTranscriptMaterialized: boolean;
	compactionIds: string[];
}

export interface CreateContextClearBoundaryInput {
	id?: string;
	clearedAt?: string;
	previousAgentSessionFile: string;
	activatedAgentSessionFile: string;
	activatedTranscriptMaterialized?: boolean;
	previousTranscriptMaterialized: boolean;
	compactionIds?: readonly string[];
}

const CLEAR_ID_RE = /^clr_[A-Za-z0-9_-]+$/;

function validNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function validClearedAt(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function normalizeCompactionIds(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const id of value) {
		if (!validNonEmptyString(id)) return undefined;
		if (seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
	}
	return ids;
}

/**
 * Validate one persisted boundary before any consumer uses its transcript paths.
 * Unknown schemas and malformed records are deliberately ignored.
 */
export function normalizeContextClearBoundary(value: unknown): ContextClearBoundary | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (raw.schemaVersion !== 1
		|| typeof raw.id !== "string"
		|| !CLEAR_ID_RE.test(raw.id)
		|| !validClearedAt(raw.clearedAt)
		|| !validNonEmptyString(raw.previousAgentSessionFile)
		|| !validNonEmptyString(raw.activatedAgentSessionFile)
		|| raw.previousAgentSessionFile === raw.activatedAgentSessionFile
		|| typeof raw.activatedTranscriptMaterialized !== "boolean"
		|| typeof raw.previousTranscriptMaterialized !== "boolean") return undefined;
	const compactionIds = normalizeCompactionIds(raw.compactionIds);
	if (!compactionIds) return undefined;
	return {
		schemaVersion: 1,
		id: raw.id,
		clearedAt: raw.clearedAt,
		previousAgentSessionFile: raw.previousAgentSessionFile,
		activatedAgentSessionFile: raw.activatedAgentSessionFile,
		activatedTranscriptMaterialized: raw.activatedTranscriptMaterialized,
		previousTranscriptMaterialized: raw.previousTranscriptMaterialized,
		compactionIds,
	};
}

/** Normalize a persisted boundary collection in commit order, first id wins. */
export function normalizeContextClearBoundaries(value: unknown): ContextClearBoundary[] {
	if (!Array.isArray(value)) return [];
	const boundaries: ContextClearBoundary[] = [];
	const seen = new Set<string>();
	for (const candidate of value) {
		const boundary = normalizeContextClearBoundary(candidate);
		if (!boundary || seen.has(boundary.id)) continue;
		seen.add(boundary.id);
		boundaries.push(boundary);
	}
	return boundaries;
}

/** Generate a stable outward/durable id without coupling it to a transcript path. */
export function makeContextClearId(clearedAtMs = Date.now()): string {
	if (!Number.isFinite(clearedAtMs)) throw new TypeError("clearedAtMs must be finite");
	return `clr_${Math.trunc(clearedAtMs)}_${randomBytes(3).toString("hex")}`;
}

/** Construct and validate the schema-v1 record written by the clear transaction. */
export function createContextClearBoundary(input: CreateContextClearBoundaryInput): ContextClearBoundary {
	const clearedAt = input.clearedAt ?? new Date().toISOString();
	const candidate = normalizeContextClearBoundary({
		schemaVersion: 1,
		id: input.id ?? makeContextClearId(Date.parse(clearedAt)),
		clearedAt,
		previousAgentSessionFile: input.previousAgentSessionFile,
		activatedAgentSessionFile: input.activatedAgentSessionFile,
		activatedTranscriptMaterialized: input.activatedTranscriptMaterialized ?? false,
		previousTranscriptMaterialized: input.previousTranscriptMaterialized,
		compactionIds: [...(input.compactionIds ?? [])],
	});
	if (!candidate) throw new TypeError("Invalid context-clear boundary");
	return candidate;
}

export function latestContextClearBoundary(value: unknown): ContextClearBoundary | undefined {
	return normalizeContextClearBoundaries(value).at(-1);
}

export function findContextClearBoundary(value: unknown, clearId: string): ContextClearBoundary | undefined {
	if (!CLEAR_ID_RE.test(clearId)) return undefined;
	return normalizeContextClearBoundaries(value).find((boundary) => boundary.id === clearId);
}

/** Compaction cards owned by prior context generations and hidden from the active snapshot. */
export function contextClearExcludedCompactionIds(value: unknown): Set<string> {
	const excluded = new Set<string>();
	for (const boundary of normalizeContextClearBoundaries(value)) {
		for (const id of boundary.compactionIds) excluded.add(id);
	}
	return excluded;
}

/** Select sidecar ids belonging to the generation which is active immediately before a clear. */
export function currentGenerationCompactionIds(
	allCompactionIds: Iterable<string>,
	boundaries: unknown,
): string[] {
	const excluded = contextClearExcludedCompactionIds(boundaries);
	const current: string[] = [];
	const seen = new Set<string>();
	for (const id of allCompactionIds) {
		if (!validNonEmptyString(id) || excluded.has(id) || seen.has(id)) continue;
		seen.add(id);
		current.push(id);
	}
	return current;
}

/** Build the outward-only assistant/tool-result pair for a durable clear boundary. */
export function syntheticContextClearRows(boundary: ContextClearBoundary): [any, any] {
	const payload = {
		schemaVersion: 1 as const,
		clearId: boundary.id,
		clearedAt: boundary.clearedAt,
	};
	const toolCallId = `context-cleared:${boundary.id}`;
	const timestamp = Date.parse(boundary.clearedAt);
	return [{
		id: boundary.id,
		role: "assistant" as const,
		timestamp,
		content: [{
			type: "toolCall" as const,
			id: toolCallId,
			name: "__context_cleared",
			arguments: payload,
		}],
	}, {
		role: "toolResult" as const,
		toolCallId,
		toolName: "__context_cleared",
		isError: false,
		content: [{ type: "text" as const, text: "ok" }],
		details: payload,
		timestamp,
	}];
}

/** Prepend stable boundary rows without mutating or duplicating an existing snapshot. */
export function mergeContextClearBoundariesIntoMessages(boundaries: unknown, messages: any[]): any[] {
	if (!Array.isArray(messages)) return messages;
	const normalized = normalizeContextClearBoundaries(boundaries);
	if (normalized.length === 0) return messages;
	const represented = new Set<string>();
	for (const message of messages) {
		if (message && typeof message === "object") {
			if (typeof message.id === "string") represented.add(message.id);
			if (typeof message.toolCallId === "string") represented.add(message.toolCallId);
			if (Array.isArray(message.content)) {
				for (const part of message.content) {
					if (part && typeof part.id === "string") represented.add(part.id);
				}
			}
		}
	}
	const rows: any[] = [];
	for (const boundary of normalized) {
		const toolCallId = `context-cleared:${boundary.id}`;
		if (represented.has(boundary.id) || represented.has(toolCallId)) continue;
		rows.push(...syntheticContextClearRows(boundary));
	}
	return rows.length > 0 ? [...rows, ...messages] : messages;
}
