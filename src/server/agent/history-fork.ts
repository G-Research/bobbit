import { isAccountablePromptMessage } from "../../shared/message-author.js";
import {
	activeTranscriptBranch,
	parseTranscript,
	type ParsedTranscript,
	type ParsedTranscriptLine,
	type TranscriptTreeAnomaly,
} from "./transcript-tree.js";

export type HistoryForkErrorCode =
	| "HISTORY_FORK_CURSOR_INVALID"
	| "HISTORY_FORK_CURSOR_NOT_FOUND"
	| "HISTORY_FORK_CURSOR_INACTIVE"
	| "HISTORY_FORK_CURSOR_NOT_USER"
	| "HISTORY_FORK_TRANSCRIPT_INVALID"
	| "HISTORY_FORK_IN_PROGRESS";

const HISTORY_FORK_ERRORS: Record<HistoryForkErrorCode, { status: 400 | 409 | 422; message: string }> = {
	HISTORY_FORK_CURSOR_INVALID: { status: 400, message: "Invalid history fork entry id" },
	HISTORY_FORK_CURSOR_NOT_FOUND: { status: 409, message: "This prompt is no longer available" },
	HISTORY_FORK_CURSOR_INACTIVE: { status: 409, message: "This prompt is no longer on the active conversation branch" },
	HISTORY_FORK_CURSOR_NOT_USER: { status: 422, message: "History forks must start before a user prompt" },
	HISTORY_FORK_TRANSCRIPT_INVALID: { status: 409, message: "The session transcript changed or is not valid for history forking" },
	HISTORY_FORK_IN_PROGRESS: { status: 409, message: "A fork from this prompt is already being created" },
};

export class HistoryForkValidationError extends Error {
	readonly code: HistoryForkErrorCode;
	readonly status: 400 | 409 | 422;

	constructor(code: HistoryForkErrorCode) {
		const details = HISTORY_FORK_ERRORS[code];
		super(details.message);
		this.name = "HistoryForkValidationError";
		this.code = code;
		this.status = details.status;
	}
}

export interface HistoryForkMaterialization {
	content: string;
	retainedEntryIds: Set<string>;
	retainedUserEntries: ParsedTranscriptLine[];
	retainedCompactions: ParsedTranscriptLine[];
	selected: ParsedTranscriptLine;
}

function transcriptInvalid(): never {
	throw new HistoryForkValidationError("HISTORY_FORK_TRANSCRIPT_INVALID");
}

function isIgnorableFinalFragment(anomaly: TranscriptTreeAnomaly, parsed: ParsedTranscript): boolean {
	if (anomaly.kind !== "malformed-json" && anomaly.kind !== "non-object-json") return false;
	if (anomaly.terminated) return false;
	const lastRecordLine = parsed.records.at(-1)?.lineIndex ?? -1;
	const lastAnomalyLine = parsed.anomalies.reduce((last, candidate) => Math.max(last, candidate.lineIndex), -1);
	return anomaly.lineIndex > lastRecordLine && anomaly.lineIndex === lastAnomalyLine;
}

function validateTranscript(parsed: ParsedTranscript): ParsedTranscriptLine {
	// A usable Pi transcript has one id-bearing session header before all tree
	// records. History forks fail closed instead of trying to repair ambiguity.
	if (parsed.headers.length !== 1) transcriptInvalid();
	const header = parsed.headers[0];
	if (!header.id || parsed.records[0] !== header) transcriptInvalid();

	const structural = parsed.anomalies.filter((anomaly) => !isIgnorableFinalFragment(anomaly, parsed));
	if (structural.length > 0) transcriptInvalid();
	if (activeTranscriptBranch(parsed).some((record) => record.entry.type === "leaf")) transcriptInvalid();
	return header;
}

function selectedMessage(record: ParsedTranscriptLine): Record<string, unknown> | null {
	if (record.entry.type !== "message") return null;
	const message = record.entry.message;
	if (!message || typeof message !== "object" || Array.isArray(message)) return null;
	return message as Record<string, unknown>;
}

function isOrdinaryUserEntry(record: ParsedTranscriptLine): boolean {
	const message = selectedMessage(record);
	return message !== null && isAccountablePromptMessage(message);
}

/**
 * Materialize an exact, lossless active-branch prefix ending immediately before
 * `entryId`. The source string is only parsed and is never mutated.
 */
export function materializeHistoryForkTranscript(
	sourceContent: string,
	entryId: string,
): HistoryForkMaterialization {
	if (
		typeof entryId !== "string"
		|| entryId.length === 0
		|| entryId.length > 256
		|| entryId.trim() !== entryId
	) {
		throw new HistoryForkValidationError("HISTORY_FORK_CURSOR_INVALID");
	}

	const parsed = parseTranscript(sourceContent);
	const header = validateTranscript(parsed);
	const selected = parsed.byId.get(entryId);
	if (!selected) throw new HistoryForkValidationError("HISTORY_FORK_CURSOR_NOT_FOUND");

	const branch = activeTranscriptBranch(parsed);
	const selectedIndex = branch.findIndex((record) => record === selected);
	if (selectedIndex < 0) throw new HistoryForkValidationError("HISTORY_FORK_CURSOR_INACTIVE");
	if (!isOrdinaryUserEntry(selected)) {
		throw new HistoryForkValidationError("HISTORY_FORK_CURSOR_NOT_USER");
	}

	const retained = branch.slice(0, selectedIndex);
	const retainedEntryIds = new Set<string>();
	const retainedUserEntries: ParsedTranscriptLine[] = [];
	const retainedCompactions: ParsedTranscriptLine[] = [];
	for (const record of retained) {
		if (record.id) retainedEntryIds.add(record.id);
		if (isOrdinaryUserEntry(record)) retainedUserEntries.push(record);
		if (record.entry.type === "compaction") retainedCompactions.push(record);
	}

	return {
		content: header.raw + retained.map((record) => record.raw).join(""),
		retainedEntryIds,
		retainedUserEntries,
		retainedCompactions,
		selected,
	};
}
