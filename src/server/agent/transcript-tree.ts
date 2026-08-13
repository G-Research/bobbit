/**
 * Pure parsing and parent-linked active-branch selection for Pi JSONL
 * transcripts. Parsing is deliberately lossless: every parsed record retains
 * its original decoded bytes, including its line terminator.
 */

export interface ParsedTranscriptLine {
	lineIndex: number;
	/** Exact decoded line, including `\n` (and any preceding `\r`) when present. */
	raw: string;
	entry: Record<string, unknown>;
	id: string | null;
	parentId: string | null;
}

export type TranscriptTreeAnomaly =
	| { kind: "malformed-json"; lineIndex: number; raw: string; terminated: boolean }
	| { kind: "non-object-json"; lineIndex: number; raw: string; terminated: boolean }
	| { kind: "duplicate-id"; lineIndex: number; id: string; firstLineIndex: number }
	| { kind: "invalid-entry-id"; lineIndex: number }
	| { kind: "invalid-parent-id"; lineIndex: number; id: string }
	| { kind: "missing-parent"; lineIndex: number; id: string; parentId: string }
	| { kind: "parent-after-child"; lineIndex: number; id: string; parentId: string; parentLineIndex: number }
	| { kind: "cycle"; lineIndex: number; id: string }
	| { kind: "invalid-leaf-target"; lineIndex: number; id: string }
	| { kind: "missing-leaf-target"; lineIndex: number; id: string; targetId: string }
	| { kind: "leaf-target-after-control"; lineIndex: number; id: string; targetId: string; targetLineIndex: number };

export interface ParsedTranscript {
	records: ParsedTranscriptLine[];
	headers: ParsedTranscriptLine[];
	byId: Map<string, ParsedTranscriptLine>;
	activeBranch: ParsedTranscriptLine[];
	anomalies: TranscriptTreeAnomaly[];
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function requiresTreeId(entry: Record<string, unknown>): boolean {
	return entry.type !== "session" && (
		Object.prototype.hasOwnProperty.call(entry, "parentId")
		|| entry.type === "message"
		|| entry.type === "compaction"
		|| entry.type === "branch_summary"
		|| entry.type === "custom_message"
		|| entry.type === "leaf"
	);
}

function rawTranscriptLines(content: string): Array<{ lineIndex: number; raw: string; terminated: boolean }> {
	const lines: Array<{ lineIndex: number; raw: string; terminated: boolean }> = [];
	let start = 0;
	let lineIndex = 0;
	while (start < content.length) {
		const newline = content.indexOf("\n", start);
		if (newline < 0) {
			lines.push({ lineIndex, raw: content.slice(start), terminated: false });
			break;
		}
		lines.push({ lineIndex, raw: content.slice(start, newline + 1), terminated: true });
		start = newline + 1;
		lineIndex++;
	}
	return lines;
}

function selectActiveBranch(records: ParsedTranscriptLine[], byId: Map<string, ParsedTranscriptLine>): ParsedTranscriptLine[] {
	let leafId: string | null = null;
	for (const record of records) {
		if (!record.id || record.entry.type === "session") continue;
		if (record.entry.type === "leaf") {
			leafId = nonEmptyString(record.entry.targetId);
		} else {
			leafId = record.id;
		}
	}
	if (!leafId) return [];

	const reverseBranch: ParsedTranscriptLine[] = [];
	const visited = new Set<string>();
	let current = byId.get(leafId);
	while (current?.id && !visited.has(current.id)) {
		reverseBranch.push(current);
		visited.add(current.id);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return reverseBranch.reverse();
}

function detectCycles(byId: Map<string, ParsedTranscriptLine>, anomalies: TranscriptTreeAnomaly[]): void {
	const complete = new Set<string>();
	const reported = new Set<string>();
	for (const start of byId.values()) {
		if (!start.id || complete.has(start.id)) continue;
		const pathIds: string[] = [];
		const positions = new Map<string, number>();
		let current: ParsedTranscriptLine | undefined = start;
		while (current?.id && !complete.has(current.id)) {
			const cycleAt = positions.get(current.id);
			if (cycleAt !== undefined) {
				for (const id of pathIds.slice(cycleAt)) {
					if (reported.has(id)) continue;
					const record = byId.get(id);
					if (record) anomalies.push({ kind: "cycle", lineIndex: record.lineIndex, id });
					reported.add(id);
				}
				break;
			}
			positions.set(current.id, pathIds.length);
			pathIds.push(current.id);
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}
		for (const id of pathIds) complete.add(id);
	}
}

/** Parse one immutable JSONL snapshot and report structural anomalies. */
export function parseTranscript(content: string): ParsedTranscript {
	const records: ParsedTranscriptLine[] = [];
	const headers: ParsedTranscriptLine[] = [];
	const byId = new Map<string, ParsedTranscriptLine>();
	const anomalies: TranscriptTreeAnomaly[] = [];
	const firstById = new Map<string, ParsedTranscriptLine>();

	for (const line of rawTranscriptLines(content)) {
		const trimmed = line.raw.trim();
		if (!trimmed) continue;
		let value: unknown;
		try {
			value = JSON.parse(trimmed);
		} catch {
			anomalies.push({ kind: "malformed-json", ...line });
			continue;
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			anomalies.push({ kind: "non-object-json", ...line });
			continue;
		}

		const entry = value as Record<string, unknown>;
		const id = nonEmptyString(entry.id);
		const parentId = nonEmptyString(entry.parentId);
		const record: ParsedTranscriptLine = { lineIndex: line.lineIndex, raw: line.raw, entry, id, parentId };
		records.push(record);
		if (entry.type === "session") {
			headers.push(record);
			continue;
		}

		if (!id) {
			if (requiresTreeId(entry)) anomalies.push({ kind: "invalid-entry-id", lineIndex: line.lineIndex });
			continue;
		}
		if (requiresTreeId(entry) && (id.trim() !== id || id.length > 256)) {
			anomalies.push({ kind: "invalid-entry-id", lineIndex: line.lineIndex });
		}
		const hasParentId = Object.prototype.hasOwnProperty.call(entry, "parentId");
		if (
			requiresTreeId(entry)
			&& (!hasParentId || (entry.parentId !== null && parentId === null))
		) {
			anomalies.push({ kind: "invalid-parent-id", lineIndex: line.lineIndex, id });
		}
		const first = firstById.get(id);
		if (first) {
			anomalies.push({ kind: "duplicate-id", lineIndex: line.lineIndex, id, firstLineIndex: first.lineIndex });
		} else {
			firstById.set(id, record);
		}
		// Preserve the sanitizer's established lenient semantics: the last record
		// with a duplicate id is the one followed by active-branch selection.
		byId.set(id, record);
	}

	for (const record of records) {
		if (!record.id || record.entry.type === "session") continue;
		if (record.parentId) {
			const parent = byId.get(record.parentId);
			if (!parent) {
				anomalies.push({ kind: "missing-parent", lineIndex: record.lineIndex, id: record.id, parentId: record.parentId });
			} else if (parent.lineIndex >= record.lineIndex) {
				anomalies.push({
					kind: "parent-after-child",
					lineIndex: record.lineIndex,
					id: record.id,
					parentId: record.parentId,
					parentLineIndex: parent.lineIndex,
				});
			}
		}
	}

	const idBearing = records.filter((record) => record.id && record.entry.type !== "session");
	const lastIdBearing = idBearing.at(-1);
	for (const record of idBearing) {
		if (record.entry.type !== "leaf" || !record.id) continue;
		// Only a terminal control selects the active leaf. Earlier controls are
		// durable branch-history markers and do not affect a later appended leaf.
		if (record !== lastIdBearing) continue;
		const target = record.entry.targetId;
		if (target !== null && nonEmptyString(target) === null) {
			anomalies.push({ kind: "invalid-leaf-target", lineIndex: record.lineIndex, id: record.id });
			continue;
		}
		const targetId = nonEmptyString(target);
		if (!targetId) continue;
		const targetRecord = byId.get(targetId);
		if (!targetRecord) {
			anomalies.push({ kind: "missing-leaf-target", lineIndex: record.lineIndex, id: record.id, targetId });
		} else if (targetRecord.lineIndex >= record.lineIndex) {
			anomalies.push({
					kind: "leaf-target-after-control",
					lineIndex: record.lineIndex,
					id: record.id,
					targetId,
					targetLineIndex: targetRecord.lineIndex,
				});
			}
	}

	detectCycles(byId, anomalies);
	const parsed: ParsedTranscript = { records, headers, byId, activeBranch: [], anomalies };
	parsed.activeBranch = selectActiveBranch(records, byId);
	return parsed;
}

/** Return the parent-linked branch selected by Pi's current leaf semantics. */
export function activeTranscriptBranch(parsed: ParsedTranscript): ParsedTranscriptLine[] {
	return parsed.activeBranch;
}
