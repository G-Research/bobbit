export type UnifiedDiffLineKind = "context" | "add" | "remove" | "meta";

export interface UnifiedDiffLine {
	kind: UnifiedDiffLineKind;
	text: string;
	oldLine: number | null;
	newLine: number | null;
	raw: string;
	noNewline?: boolean;
}

export interface UnifiedDiffHunk {
	header: string;
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	section?: string;
	lines: UnifiedDiffLine[];
}

export interface UnifiedDiffFile {
	id: string;
	header: string;
	oldPath?: string;
	path: string;
	displayPath: string;
	status: "added" | "deleted" | "modified" | "renamed" | "copied" | "unknown";
	additions: number;
	deletions: number;
	isBinary: boolean;
	isTruncated: boolean;
	meta: string[];
	hunks: UnifiedDiffHunk[];
}

export interface UnifiedDiffParseResult {
	files: UnifiedDiffFile[];
	warnings: string[];
	isTruncated: boolean;
	trailingText?: string;
}

export interface SplitDiffPair {
	left: UnifiedDiffLine | null;
	right: UnifiedDiffLine | null;
}

interface MutableUnifiedDiffFile extends UnifiedDiffFile {
	currentHunk?: UnifiedDiffHunk;
	oldLineCursor: number;
	newLineCursor: number;
	index: number;
}

const DIFF_GIT_PREFIX = "diff --git ";
export const DIFF_TRUNCATED_MARKER = "--- Diff truncated (exceeded 500KB) ---";
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:\s?(.*))?$/;

export function parseUnifiedDiff(raw: string): UnifiedDiffParseResult {
	const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const lines = text.split("\n");
	const files: MutableUnifiedDiffFile[] = [];
	const warnings: string[] = [];
	const trailingLines: string[] = [];
	let current: MutableUnifiedDiffFile | undefined;
	let isTruncated = false;
	let pendingOldPath: string | undefined;
	let pendingNewPath: string | undefined;
	let sawHunkLikeText = false;

	for (const rawLine of lines) {
		if (rawLine === DIFF_TRUNCATED_MARKER) {
			isTruncated = true;
			if (current) current.isTruncated = true;
			warnings.push("Diff was truncated because it exceeded the server size limit.");
			continue;
		}

		if (rawLine.startsWith(DIFF_GIT_PREFIX)) {
			current = createFileFromDiffGit(rawLine, files.length);
			files.push(current);
			pendingOldPath = undefined;
			pendingNewPath = undefined;
			continue;
		}

		const hunkMatch = HUNK_RE.exec(rawLine);
		if (hunkMatch) {
			if (!current) {
				current = createSyntheticFile(files.length, pendingOldPath, pendingNewPath);
				files.push(current);
			}
			appendHunk(current, rawLine, hunkMatch);
			sawHunkLikeText = true;
			continue;
		}

		if (!current) {
			if (rawLine.startsWith("--- ")) {
				pendingOldPath = parseFileHeaderPath(rawLine.slice(4));
				continue;
			}
			if (rawLine.startsWith("+++ ")) {
				pendingNewPath = parseFileHeaderPath(rawLine.slice(4));
				continue;
			}
			if (rawLine.trim() !== "") trailingLines.push(rawLine);
			continue;
		}

		if (current.currentHunk) {
			if (rawLine.startsWith("\\ No newline at end of file")) {
				const hunkLines = current.currentHunk.lines;
				const previous = hunkLines[hunkLines.length - 1];
				if (previous) previous.noNewline = true;
				else appendMetaLine(current.currentHunk, rawLine);
				continue;
			}
			if (rawLine.startsWith("+") || rawLine.startsWith("-") || rawLine.startsWith(" ")) {
				appendDiffLine(current, rawLine);
				continue;
			}
			if (rawLine === "") continue;
		}

		if (rawLine.startsWith("--- ")) {
			const oldPath = parseFileHeaderPath(rawLine.slice(4));
			current.meta.push(rawLine);
			applyOldPath(current, oldPath);
			continue;
		}
		if (rawLine.startsWith("+++ ")) {
			const newPath = parseFileHeaderPath(rawLine.slice(4));
			current.meta.push(rawLine);
			applyNewPath(current, newPath);
			continue;
		}

		if (rawLine.startsWith("rename from ")) {
			current.status = "renamed";
			current.oldPath = rawLine.slice("rename from ".length);
			current.meta.push(rawLine);
			continue;
		}
		if (rawLine.startsWith("rename to ")) {
			current.status = "renamed";
			current.path = rawLine.slice("rename to ".length);
			current.meta.push(rawLine);
			continue;
		}
		if (rawLine.startsWith("copy from ")) {
			current.status = "copied";
			current.oldPath = rawLine.slice("copy from ".length);
			current.meta.push(rawLine);
			continue;
		}
		if (rawLine.startsWith("copy to ")) {
			current.status = "copied";
			current.path = rawLine.slice("copy to ".length);
			current.meta.push(rawLine);
			continue;
		}
		if (rawLine.startsWith("new file mode ")) {
			current.status = "added";
			current.meta.push(rawLine);
			continue;
		}
		if (rawLine.startsWith("deleted file mode ")) {
			current.status = "deleted";
			current.meta.push(rawLine);
			continue;
		}
		if (rawLine.startsWith("Binary files ") || rawLine === "GIT binary patch") {
			current.isBinary = true;
			current.meta.push(rawLine);
			warnings.push(`Binary diff detected for ${current.path}.`);
			continue;
		}
		if (isKnownMetadataLine(rawLine)) {
			current.meta.push(rawLine);
			continue;
		}
		if (rawLine.trim() !== "") current.meta.push(rawLine);
	}

	const finalizedFiles = files.map(finalizeFile);
	const trailingText = trailingLines.length > 0 && !sawHunkLikeText ? trailingLines.join("\n") : undefined;
	return {
		files: finalizedFiles,
		warnings,
		isTruncated,
		...(trailingText ? { trailingText } : {}),
	};
}

export function buildSplitPairs(lines: readonly UnifiedDiffLine[]): SplitDiffPair[] {
	const pairs: SplitDiffPair[] = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index];
		if (line.kind === "remove") {
			const removes: UnifiedDiffLine[] = [];
			while (index < lines.length && lines[index].kind === "remove") {
				removes.push(lines[index]);
				index += 1;
			}
			const adds: UnifiedDiffLine[] = [];
			while (index < lines.length && lines[index].kind === "add") {
				adds.push(lines[index]);
				index += 1;
			}
			const count = Math.max(removes.length, adds.length);
			for (let offset = 0; offset < count; offset += 1) {
				pairs.push({ left: removes[offset] ?? null, right: adds[offset] ?? null });
			}
			continue;
		}
		if (line.kind === "add") {
			pairs.push({ left: null, right: line });
			index += 1;
			continue;
		}
		pairs.push({ left: line, right: line });
		index += 1;
	}

	return pairs;
}

function createFileFromDiffGit(line: string, index: number): MutableUnifiedDiffFile {
	const [oldHeaderPath, newHeaderPath] = parseDiffGitPaths(line);
	const oldPath = oldHeaderPath === "/dev/null" ? undefined : oldHeaderPath;
	const path = newHeaderPath === "/dev/null" ? oldPath ?? "Diff" : newHeaderPath;
	return createMutableFile({
		index,
		header: line,
		oldPath: oldPath && oldPath !== path ? oldPath : undefined,
		path,
		status: inferStatus(oldHeaderPath, newHeaderPath, "modified"),
	});
}

function createSyntheticFile(index: number, pendingOldPath: string | undefined, pendingNewPath: string | undefined): MutableUnifiedDiffFile {
	const oldPath = pendingOldPath && pendingOldPath !== "/dev/null" ? pendingOldPath : undefined;
	const path = pendingNewPath && pendingNewPath !== "/dev/null" ? pendingNewPath : oldPath ?? "Diff";
	return createMutableFile({
		index,
		header: path === "Diff" ? "Diff" : `diff ${oldPath ?? "/dev/null"} ${path}`,
		oldPath: oldPath && oldPath !== path ? oldPath : undefined,
		path,
		status: inferStatus(pendingOldPath, pendingNewPath, "unknown"),
	});
}

function createMutableFile(input: { index: number; header: string; oldPath?: string; path: string; status: UnifiedDiffFile["status"] }): MutableUnifiedDiffFile {
	return {
		id: `${input.oldPath ?? ""}->${input.path || input.header}`,
		header: input.header,
		oldPath: input.oldPath,
		path: input.path,
		displayPath: input.oldPath && input.oldPath !== input.path ? `${input.oldPath} → ${input.path}` : input.path,
		status: input.status,
		additions: 0,
		deletions: 0,
		isBinary: false,
		isTruncated: false,
		meta: [],
		hunks: [],
		oldLineCursor: 0,
		newLineCursor: 0,
		index: input.index,
	};
}

function appendHunk(file: MutableUnifiedDiffFile, header: string, match: RegExpExecArray): void {
	file.oldLineCursor = Number(match[1]);
	file.newLineCursor = Number(match[3]);
	const section = match[5]?.trim();
	const hunk: UnifiedDiffHunk = {
		header,
		oldStart: Number(match[1]),
		oldLines: match[2] === undefined ? 1 : Number(match[2]),
		newStart: Number(match[3]),
		newLines: match[4] === undefined ? 1 : Number(match[4]),
		...(section ? { section } : {}),
		lines: [],
	};
	file.hunks.push(hunk);
	file.currentHunk = hunk;
}

function appendDiffLine(file: MutableUnifiedDiffFile, rawLine: string): void {
	if (!file.currentHunk) return;
	const prefix = rawLine[0];
	if (prefix === "+") {
		file.currentHunk.lines.push({
			kind: "add",
			text: rawLine.slice(1),
			oldLine: null,
			newLine: file.newLineCursor,
			raw: rawLine,
		});
		file.newLineCursor += 1;
		file.additions += 1;
		return;
	}
	if (prefix === "-") {
		file.currentHunk.lines.push({
			kind: "remove",
			text: rawLine.slice(1),
			oldLine: file.oldLineCursor,
			newLine: null,
			raw: rawLine,
		});
		file.oldLineCursor += 1;
		file.deletions += 1;
		return;
	}
	file.currentHunk.lines.push({
		kind: "context",
		text: rawLine.slice(1),
		oldLine: file.oldLineCursor,
		newLine: file.newLineCursor,
		raw: rawLine,
	});
	file.oldLineCursor += 1;
	file.newLineCursor += 1;
}

function appendMetaLine(hunk: UnifiedDiffHunk, rawLine: string): void {
	hunk.lines.push({ kind: "meta", text: rawLine, oldLine: null, newLine: null, raw: rawLine });
}

function applyOldPath(file: MutableUnifiedDiffFile, oldPath: string): void {
	if (oldPath === "/dev/null") {
		file.status = "added";
		file.oldPath = undefined;
		return;
	}
	if (file.status !== "renamed" && file.status !== "copied" && oldPath !== file.path) file.oldPath = oldPath;
}

function applyNewPath(file: MutableUnifiedDiffFile, newPath: string): void {
	if (newPath === "/dev/null") {
		file.status = "deleted";
		if (file.oldPath) file.path = file.oldPath;
		return;
	}
	file.path = newPath;
}

function finalizeFile(file: MutableUnifiedDiffFile): UnifiedDiffFile {
	delete file.currentHunk;
	file.id = `${file.oldPath ?? ""}->${file.path || file.header}`;
	file.displayPath = file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path;
	if (file.status === "unknown" && file.hunks.length > 0) file.status = "modified";
	const { oldLineCursor: _oldLineCursor, newLineCursor: _newLineCursor, index: _index, ...finalized } = file;
	void _oldLineCursor;
	void _newLineCursor;
	void _index;
	return finalized;
}

function inferStatus(oldPath: string | undefined, newPath: string | undefined, fallback: UnifiedDiffFile["status"]): UnifiedDiffFile["status"] {
	if (oldPath === "/dev/null") return "added";
	if (newPath === "/dev/null") return "deleted";
	return fallback;
}

function parseDiffGitPaths(line: string): [string, string] {
	const rest = line.slice(DIFF_GIT_PREFIX.length);
	if (!rest.startsWith('"') && rest.startsWith("a/")) {
		const separatorIndex = rest.lastIndexOf(" b/");
		if (separatorIndex > 0) {
			return [stripGitPrefix(rest.slice(0, separatorIndex)), stripGitPrefix(rest.slice(separatorIndex + 1))];
		}
	}
	const tokens = tokenizeGitPathPair(rest);
	const oldPath = stripGitPrefix(tokens[0] ?? "unknown");
	const newPath = stripGitPrefix(tokens[1] ?? oldPath);
	return [oldPath, newPath];
}

function tokenizeGitPathPair(input: string): string[] {
	const tokens: string[] = [];
	let index = 0;
	while (index < input.length && tokens.length < 2) {
		while (input[index] === " ") index += 1;
		if (input[index] === '"') {
			const [token, nextIndex] = readQuotedToken(input, index);
			tokens.push(token);
			index = nextIndex;
			continue;
		}
		let token = "";
		while (index < input.length && input[index] !== " ") {
			token += input[index];
			index += 1;
		}
		if (token) tokens.push(token);
	}
	return tokens;
}

function parseFileHeaderPath(input: string): string {
	const trimmed = input.trimEnd();
	if (trimmed.startsWith('"')) {
		return stripGitPrefix(readQuotedToken(trimmed, 0)[0]);
	}
	const tabIndex = trimmed.indexOf("\t");
	const path = tabIndex >= 0 ? trimmed.slice(0, tabIndex) : trimmed;
	return stripGitPrefix(path);
}

function readQuotedToken(input: string, startIndex: number): [string, number] {
	let token = "";
	let index = startIndex + 1;
	while (index < input.length) {
		const char = input[index];
		index += 1;
		if (char === '"') break;
		if (char === "\\" && index < input.length) {
			token += input[index];
			index += 1;
		} else {
			token += char;
		}
	}
	return [token, index];
}

function stripGitPrefix(path: string): string {
	if (path === "/dev/null") return path;
	return path.replace(/^[ab]\//, "");
}

function isKnownMetadataLine(line: string): boolean {
	return /^(index |old mode |new mode |deleted file mode |new file mode |similarity index |dissimilarity index |copy from |copy to |rename from |rename to )/.test(line);
}
