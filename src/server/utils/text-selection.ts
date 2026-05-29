export type TextSelectionMode = "full" | "grep" | "head" | "tail" | "slice";

export const DEFAULT_TAIL_LINES = 80;
export const DEFAULT_HEAD_LINES = 50;
export const DEFAULT_GREP_MAX_RESULTS = 50;
export const MAX_SELECTED_LINES = 2000;
export const MAX_SELECTED_BYTES = 50 * 1024;

export interface TextSelectionOptions {
	mode?: TextSelectionMode;
	implicitDefault?: boolean;
	pattern?: string;
	context?: number;
	maxResults?: number;
	/** Compatibility alias matching gate_inspect/bash_bg-style parameter names. */
	max_results?: number;
	lines?: number;
	from?: number;
	to?: number;
}

export interface TextSelectionMetadata {
	mode: TextSelectionMode;
	totalLines: number;
	range?: { from: number; to: number };
	matchCount?: number;
	shownMatches?: number;
	truncated: boolean;
	truncationReason?: string;
	omittedHint?: string;
}

export interface TextSelectionResult extends TextSelectionMetadata {
	text: string;
	selection: TextSelectionMetadata;
	/** 1-indexed source line numbers included in text; omitted hints are not included. */
	selectedLineNumbers: number[];
}

export class TextSelectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TextSelectionError";
	}
}

interface SelectedLine {
	number: number;
	text: string;
}

export function splitLines(text: string): string[] {
	return text.length ? text.split(/\r?\n/) : [];
}

export function countTextLines(text: string): number {
	return splitLines(text).length;
}

function assertPositiveInteger(name: string, value: number | undefined): void {
	if (value === undefined) return;
	if (!Number.isInteger(value) || value < 1) {
		throw new TextSelectionError(`${name} must be an integer >= 1`);
	}
}

function assertNonNegativeInteger(name: string, value: number | undefined): void {
	if (value === undefined) return;
	if (!Number.isInteger(value) || value < 0) {
		throw new TextSelectionError(`${name} must be a non-negative integer`);
	}
}

function joinSelectedLines(lines: SelectedLine[], numbered: boolean): string {
	return lines.map(line => numbered ? `${line.number}: ${line.text}` : line.text).join("\n");
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

function truncateStringToBytes(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (byteLength(text) <= maxBytes) return text;
	let out = "";
	let used = 0;
	for (const ch of text) {
		const b = byteLength(ch);
		if (used + b > maxBytes) break;
		out += ch;
		used += b;
	}
	return out;
}

export interface TextBudgetResult {
	text: string;
	truncated: boolean;
	truncationReason?: string;
	lines: number;
	bytes: number;
}

export function truncateTextToBudget(
	text: string,
	maxLines: number = MAX_SELECTED_LINES,
	maxBytes: number = MAX_SELECTED_BYTES,
): TextBudgetResult {
	const sourceLines = splitLines(text);
	const kept: string[] = [];
	let bytes = 0;
	let truncated = false;
	let truncationReason: string | undefined;

	for (let i = 0; i < sourceLines.length; i++) {
		if (kept.length >= maxLines) {
			truncated = true;
			truncationReason = `selected output exceeded ${maxLines} line budget`;
			break;
		}
		const prefixBytes = kept.length > 0 ? 1 : 0;
		const line = sourceLines[i];
		const lineBytes = byteLength(line);
		if (bytes + prefixBytes + lineBytes > maxBytes) {
			const remaining = maxBytes - bytes - prefixBytes;
			if (remaining > 0) kept.push(truncateStringToBytes(line, remaining));
			truncated = true;
			truncationReason = `selected output exceeded ${maxBytes} byte budget`;
			break;
		}
		kept.push(line);
		bytes += prefixBytes + lineBytes;
	}

	const out = kept.join("\n");
	return {
		text: out,
		truncated,
		truncationReason,
		lines: kept.length,
		bytes: byteLength(out),
	};
}

function capSelectedLines(lines: SelectedLine[], numbered: boolean): { lines: SelectedLine[]; truncated: boolean; truncationReason?: string } {
	const kept: SelectedLine[] = [];
	let bytes = 0;
	for (const line of lines) {
		if (kept.length >= MAX_SELECTED_LINES) {
			return { lines: kept, truncated: true, truncationReason: `selected output exceeded ${MAX_SELECTED_LINES} line budget` };
		}
		const rendered = numbered ? `${line.number}: ${line.text}` : line.text;
		const prefixBytes = kept.length > 0 ? 1 : 0;
		const renderedBytes = byteLength(rendered);
		if (bytes + prefixBytes + renderedBytes > MAX_SELECTED_BYTES) {
			const remaining = MAX_SELECTED_BYTES - bytes - prefixBytes;
			if (remaining > 0 && kept.length < MAX_SELECTED_LINES) {
				if (numbered) {
					const linePrefix = `${line.number}: `;
					const lineBudget = remaining - byteLength(linePrefix);
					if (lineBudget > 0) kept.push({ ...line, text: truncateStringToBytes(line.text, lineBudget) });
				} else {
					kept.push({ ...line, text: truncateStringToBytes(line.text, remaining) });
				}
			}
			return { lines: kept, truncated: true, truncationReason: `selected output exceeded ${MAX_SELECTED_BYTES} byte budget` };
		}
		kept.push(line);
		bytes += prefixBytes + renderedBytes;
	}
	return { lines: kept, truncated: false };
}

function mergeRanges(ranges: Array<{ from: number; to: number }>): Array<{ from: number; to: number }> {
	if (ranges.length === 0) return [];
	const sorted = ranges.slice().sort((a, b) => a.from - b.from || a.to - b.to);
	const merged: Array<{ from: number; to: number }> = [];
	for (const range of sorted) {
		const last = merged[merged.length - 1];
		if (last && range.from <= last.to + 1) {
			last.to = Math.max(last.to, range.to);
		} else {
			merged.push({ ...range });
		}
	}
	return merged;
}

export function selectText(text: string, options: TextSelectionOptions = {}): TextSelectionResult {
	const mode = options.mode ?? "tail";
	const implicitDefault = options.implicitDefault ?? options.mode === undefined;
	const maxResultsOption = options.maxResults ?? options.max_results;
	if (!["full", "grep", "head", "tail", "slice"].includes(mode)) {
		throw new TextSelectionError(`mode must be one of: full, grep, head, tail, slice`);
	}

	assertPositiveInteger("lines", options.lines);
	assertNonNegativeInteger("context", options.context);
	assertPositiveInteger("max_results", maxResultsOption);
	assertPositiveInteger("from", options.from);
	assertPositiveInteger("to", options.to);

	const rawLines = splitLines(text);
	const totalLines = rawLines.length;
	let selected: SelectedLine[] = [];
	let numbered = false;
	let truncated = false;
	let truncationReason: string | undefined;
	let matchCount: number | undefined;
	let shownMatches: number | undefined;

	if (mode === "full") {
		selected = rawLines.map((line, i) => ({ number: i + 1, text: line }));
	} else if (mode === "head") {
		const requested = options.lines ?? DEFAULT_HEAD_LINES;
		const take = Math.min(requested, totalLines);
		selected = rawLines.slice(0, take).map((line, i) => ({ number: i + 1, text: line }));
	} else if (mode === "tail") {
		const requested = options.lines ?? DEFAULT_TAIL_LINES;
		const take = Math.min(requested, totalLines);
		const start = Math.max(totalLines - take, 0);
		selected = rawLines.slice(start).map((line, i) => ({ number: start + i + 1, text: line }));
	} else if (mode === "slice") {
		numbered = true;
		if (options.from === undefined || options.to === undefined) {
			throw new TextSelectionError(`slice mode requires from and to line numbers`);
		}
		if (options.from > options.to) {
			throw new TextSelectionError(`from must be less than or equal to to`);
		}
		const start = Math.max(options.from, 1);
		const end = Math.min(options.to, totalLines);
		selected = start <= end
			? rawLines.slice(start - 1, end).map((line, i) => ({ number: start + i, text: line }))
			: [];
	} else if (mode === "grep") {
		numbered = true;
		if (options.pattern === undefined || options.pattern === "") {
			throw new TextSelectionError(`grep mode requires a non-empty pattern`);
		}
		let regex: RegExp;
		try {
			regex = new RegExp(options.pattern);
		} catch (err: any) {
			throw new TextSelectionError(`Invalid regex pattern: ${err?.message || err}`);
		}
		const context = options.context ?? 0;
		const maxResults = maxResultsOption ?? DEFAULT_GREP_MAX_RESULTS;
		const matches: number[] = [];
		for (let i = 0; i < rawLines.length; i++) {
			regex.lastIndex = 0;
			if (regex.test(rawLines[i])) matches.push(i + 1);
		}
		matchCount = matches.length;
		shownMatches = Math.min(matchCount, maxResults);
		if (matchCount > maxResults) {
			truncated = true;
			truncationReason = `grep results exceeded max_results=${maxResults}`;
		}
		const ranges = matches.slice(0, maxResults).map(lineNo => ({
			from: Math.max(1, lineNo - context),
			to: Math.min(totalLines, lineNo + context),
		}));
		for (const range of mergeRanges(ranges)) {
			for (let lineNo = range.from; lineNo <= range.to; lineNo++) {
				selected.push({ number: lineNo, text: rawLines[lineNo - 1] });
			}
		}
	}

	const capped = capSelectedLines(selected, numbered);
	selected = capped.lines;
	if (capped.truncated) {
		truncated = true;
		truncationReason = truncationReason ? `${truncationReason}; ${capped.truncationReason}` : capped.truncationReason;
	}

	let out = joinSelectedLines(selected, numbered);
	const selectedLineNumbers = selected.map(line => line.number);
	const range = selectedLineNumbers.length > 0
		? { from: selectedLineNumbers[0], to: selectedLineNumbers[selectedLineNumbers.length - 1] }
		: undefined;

	let omittedHint: string | undefined;
	if (mode === "tail" && implicitDefault && selectedLineNumbers.length > 0 && totalLines > selectedLineNumbers.length) {
		const omitted = selectedLineNumbers[0] - 1;
		omittedHint = `[${omitted} lines omitted — use mode="grep" with pattern="error|failed", or mode="slice" from=1 to=${omitted}, to inspect more]`;
	}

	const selection: TextSelectionMetadata = {
		mode,
		totalLines,
		range,
		matchCount,
		shownMatches,
		truncated,
		truncationReason,
		omittedHint,
	};

	return {
		text: out,
		selection,
		selectedLineNumbers,
		...selection,
	};
}
