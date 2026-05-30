import type { PrWalkthroughDiffBlock, PrWalkthroughDiffLine, PrWalkthroughHunk, WalkthroughWarning } from "../../shared/pr-walkthrough/types.js";
import { diffBlockIdForFile, hunkIdForBlock, lineIdForHunk } from "../../shared/pr-walkthrough/ids.js";

export type WalkthroughFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "binary";

export interface ParsedWalkthroughDiffFile extends PrWalkthroughDiffBlock {
	status: WalkthroughFileStatus;
	isBinary: boolean;
	isGenerated: boolean;
	truncated: boolean;
	isTruncated?: boolean;
	warnings: WalkthroughWarning[];
	additions: number;
	deletions: number;
}

export interface ParseUnifiedDiffOptions {
	maxFiles?: number;
	maxLinesPerFile?: number;
	generatedPathMatcher?: (filePath: string) => boolean;
}

export interface ParseUnifiedDiffResult {
	files: ParsedWalkthroughDiffFile[];
	warnings: WalkthroughWarning[];
}

interface MutableDiffFile extends ParsedWalkthroughDiffFile {
	currentHunk?: PrWalkthroughHunk;
	oldLineCursor: number;
	newLineCursor: number;
	lineCount: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parseUnifiedDiff(diff: string, options: ParseUnifiedDiffOptions = {}): ParseUnifiedDiffResult {
	const warnings: WalkthroughWarning[] = [];
	const files: MutableDiffFile[] = [];
	let current: MutableDiffFile | undefined;
	let omittedForFileLimit = false;

	const lines = diff.replace(/\r\n/g, "\n").split("\n");
	for (const rawLine of lines) {
		if (rawLine.startsWith("diff --git ")) {
			if (options.maxFiles !== undefined && files.length >= options.maxFiles) {
				if (!omittedForFileLimit) {
					warnings.push({ code: "max-files-exceeded", severity: "warning", message: `Diff contains more than ${options.maxFiles} files; remaining files were omitted.` });
					omittedForFileLimit = true;
				}
				current = undefined;
				continue;
			}
			current = createFileFromDiffGit(rawLine, files.length, options.generatedPathMatcher);
			files.push(current);
			continue;
		}

		if (!current) continue;

		if (rawLine.startsWith("new file mode ")) {
			current.status = "added";
			continue;
		}
		if (rawLine.startsWith("deleted file mode ")) {
			current.status = "deleted";
			continue;
		}
		if (rawLine.startsWith("rename from ")) {
			current.status = "renamed";
			current.oldPath = rawLine.slice("rename from ".length);
			continue;
		}
		if (rawLine.startsWith("rename to ")) {
			current.status = "renamed";
			current.filePath = rawLine.slice("rename to ".length);
			continue;
		}
		if (rawLine.startsWith("copy from ")) {
			current.status = "copied";
			current.oldPath = rawLine.slice("copy from ".length);
			continue;
		}
		if (rawLine.startsWith("copy to ")) {
			current.status = "copied";
			current.filePath = rawLine.slice("copy to ".length);
			continue;
		}
		if (rawLine.startsWith("Binary files ") || rawLine === "GIT binary patch") {
			markBinary(current);
			continue;
		}
		if (rawLine.startsWith("@@ ")) {
			const hunk = parseHunkHeader(rawLine, current);
			current.hunks.push(hunk);
			current.currentHunk = hunk;
			continue;
		}
		if (!current.currentHunk || rawLine.startsWith("\\ No newline at end of file")) continue;

		if (rawLine.startsWith("+") || rawLine.startsWith("-") || rawLine.startsWith(" ")) {
			appendDiffLine(current, rawLine, options.maxLinesPerFile);
		}
	}

	for (const file of files) {
		delete file.currentHunk;
		if (file.isGenerated) {
			file.warnings.push({ code: "generated-file", severity: "info", message: `${file.filePath} looks generated and may be low-signal for review.`, filePath: file.filePath });
		}
	}

	return { files, warnings: [...warnings, ...files.flatMap(file => file.warnings)] };
}

function createFileFromDiffGit(line: string, index: number, generatedPathMatcher?: (filePath: string) => boolean): MutableDiffFile {
	const [oldPath, newPath] = parseDiffGitPaths(line);
	const filePath = newPath === "/dev/null" ? oldPath : newPath;
	const blockId = diffBlockIdForFile(filePath, index);
	return {
		id: blockId,
		filePath,
		oldPath: oldPath !== filePath && oldPath !== "/dev/null" ? oldPath : undefined,
		status: "modified",
		hunks: [],
		isBinary: false,
		isGenerated: generatedPathMatcher?.(filePath) ?? false,
		truncated: false,
		isTruncated: false,
		warnings: [],
		additions: 0,
		deletions: 0,
		oldLineCursor: 0,
		newLineCursor: 0,
		lineCount: 0,
	};
}

function parseDiffGitPaths(line: string): [string, string] {
	const rest = line.slice("diff --git ".length);
	const tokens = tokenizeGitPathPair(rest);
	const oldPath = stripGitPrefix(tokens[0] ?? "unknown");
	const newPath = stripGitPrefix(tokens[1] ?? oldPath);
	return [oldPath, newPath];
}

function tokenizeGitPathPair(input: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	while (i < input.length && tokens.length < 2) {
		while (input[i] === " ") i += 1;
		if (input[i] === '"') {
			let token = "";
			i += 1;
			while (i < input.length) {
				const char = input[i++];
				if (char === '"') break;
				if (char === "\\" && i < input.length) token += input[i++];
				else token += char;
			}
			tokens.push(token);
		} else {
			let token = "";
			while (i < input.length && input[i] !== " ") token += input[i++];
			tokens.push(token);
		}
	}
	return tokens;
}

function stripGitPrefix(path: string): string {
	if (path === "/dev/null") return path;
	return path.replace(/^[ab]\//, "");
}

function parseHunkHeader(header: string, file: MutableDiffFile): PrWalkthroughHunk {
	const match = HUNK_RE.exec(header);
	if (match) {
		file.oldLineCursor = Number(match[1]);
		file.newLineCursor = Number(match[3]);
	}
	return {
		id: hunkIdForBlock(file.id, file.hunks.length),
		header,
		lines: [],
	};
}

function appendDiffLine(file: MutableDiffFile, rawLine: string, maxLinesPerFile: number | undefined): void {
	if (maxLinesPerFile !== undefined && file.lineCount >= maxLinesPerFile) {
		if (!file.truncated) {
			file.truncated = true;
			file.isTruncated = true;
			file.warnings.push({ code: "file-lines-truncated", severity: "warning", message: `${file.filePath} was truncated after ${maxLinesPerFile} diff lines.`, filePath: file.filePath });
		}
		advanceCounters(file, rawLine);
		return;
	}

	const hunk = file.currentHunk;
	if (!hunk) return;
	const kind: PrWalkthroughDiffLine["kind"] = rawLine[0] === "+" ? "add" : rawLine[0] === "-" ? "del" : "context";
	const line: PrWalkthroughDiffLine = {
		id: lineIdForHunk(file.id, file.hunks.length - 1, hunk.lines.length),
		side: kind === "add" ? "new" : kind === "del" ? "old" : "context",
		text: rawLine.slice(1),
		kind,
	};
	if (kind === "add") {
		line.newLine = file.newLineCursor;
		file.newLineCursor += 1;
		file.additions += 1;
	} else if (kind === "del") {
		line.oldLine = file.oldLineCursor;
		file.oldLineCursor += 1;
		file.deletions += 1;
	} else {
		line.oldLine = file.oldLineCursor;
		line.newLine = file.newLineCursor;
		file.oldLineCursor += 1;
		file.newLineCursor += 1;
	}
	file.lineCount += 1;
	hunk.lines.push(line);
}

function advanceCounters(file: MutableDiffFile, rawLine: string): void {
	if (rawLine.startsWith("+")) file.newLineCursor += 1;
	else if (rawLine.startsWith("-")) file.oldLineCursor += 1;
	else if (rawLine.startsWith(" ")) {
		file.oldLineCursor += 1;
		file.newLineCursor += 1;
	}
}

function markBinary(file: MutableDiffFile): void {
	file.status = "binary";
	file.isBinary = true;
	if (!file.warnings.some(warning => warning.code === "binary-file")) {
		file.warnings.push({ code: "binary-file", severity: "warning", message: `${file.filePath} is binary and has no reviewable text hunks.`, filePath: file.filePath });
	}
}
