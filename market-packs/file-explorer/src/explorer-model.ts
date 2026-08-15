export const LIST_ENTRY_LIMIT = 1_000;
export const READ_BYTE_LIMIT = 1024 * 1024;
export const DIFF_BYTE_LIMIT = 500 * 1024;
export const STATUS_BYTE_LIMIT = 2 * 1024 * 1024;
export const STATUS_RECORD_LIMIT = 20_000;
export const SEARCH_RESULT_LIMIT = 200;
export const SEARCH_ENTRY_LIMIT = 20_000;
export const SEARCH_DIRECTORY_LIMIT = 5_000;
export const SEARCH_CONCURRENCY_LIMIT = 4;
export const SEARCH_DEPTH_LIMIT = 100;
export const SEARCH_TIMEOUT_MS = 3_000;
export const SEARCH_QUERY_LIMIT = 256;
export const FS_TIMEOUT_MS = 3_000;
export const GIT_TIMEOUT_MS = 5_000;

export type ExplorerEntryKind = "directory" | "file" | "symlink" | "other";
export type ExplorerStatusSummary = "conflict" | "untracked" | "renamed" | "copied" | "deleted" | "added" | "modified";

export interface ExplorerEntry {
	path: string;
	name: string;
	kind: ExplorerEntryKind;
	virtual?: boolean;
}

export interface ExplorerFileStatus {
	path: string;
	oldPath?: string;
	index: string;
	worktree: string;
	staged: boolean;
	unstaged: boolean;
	conflict: boolean;
	untracked: boolean;
	modified: boolean;
	added: boolean;
	deleted: boolean;
	renamed: boolean;
	copied: boolean;
	summary: ExplorerStatusSummary;
}

export interface StagedNameStatus {
	code: string;
	score?: number;
	path: string;
	oldPath?: string;
}

export interface StatusTreeModel {
	files: ExplorerFileStatus[];
	ancestors: string[];
	virtualEntries: Array<ExplorerEntry & { status?: ExplorerFileStatus }>;
}

export type FileContent =
	| { kind: "text"; text: string; bytes: number }
	| { kind: "empty"; text: ""; bytes: 0 }
	| { kind: "binary"; bytes: number }
	| { kind: "too-large"; bytes: number; limit: number };

export class ExplorerPathError extends Error {
	readonly code = "INVALID_PATH";
	constructor(message = "The requested path must be a canonical relative path.") {
		super(message);
		this.name = "ExplorerPathError";
	}
}

export class ExplorerParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExplorerParseError";
	}
}

/** Validate the pack protocol path. This is product-level canonicalisation for a
 * trusted first-party worker, not a filesystem confinement boundary. */
export function normalizeRelativePath(value: unknown, options: { allowRoot?: boolean } = {}): string {
	if (typeof value !== "string") throw new ExplorerPathError();
	if (value === "") {
		if (options.allowRoot) return "";
		throw new ExplorerPathError("A non-empty relative path is required.");
	}
	if (value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
		throw new ExplorerPathError();
	}
	const segments = value.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) throw new ExplorerPathError();
	return segments.join("/");
}

export function joinRelativePath(parent: string, name: string): string {
	return normalizeRelativePath(parent ? `${parent}/${name}` : name);
}

export function stableLowercase(value: string): string {
	return value.toLowerCase();
}

export function compareExplorerEntries(a: ExplorerEntry, b: ExplorerEntry): number {
	const aDirectory = a.kind === "directory";
	const bDirectory = b.kind === "directory";
	if (aDirectory !== bDirectory) return aDirectory ? -1 : 1;
	const aFolded = stableLowercase(a.name);
	const bFolded = stableLowercase(b.name);
	if (aFolded < bFolded) return -1;
	if (aFolded > bFolded) return 1;
	if (a.name < b.name) return -1;
	if (a.name > b.name) return 1;
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export function sortExplorerEntries<T extends ExplorerEntry>(entries: readonly T[]): T[] {
	return [...entries].sort(compareExplorerEntries);
}

/** Search results sort by their complete canonical path rather than tree kind so
 * duplicate basenames remain deterministic and adjacent to their path context. */
export function compareExplorerPaths(a: ExplorerEntry, b: ExplorerEntry): number {
	const aFolded = stableLowercase(a.path);
	const bFolded = stableLowercase(b.path);
	if (aFolded < bFolded) return -1;
	if (aFolded > bFolded) return 1;
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export function sortExplorerPaths<T extends ExplorerEntry>(entries: readonly T[]): T[] {
	return [...entries].sort(compareExplorerPaths);
}

function pathFromRepo(rawPath: string, repoPrefix: string): string | undefined {
	const prefix = normalizeRepoPrefix(repoPrefix);
	let relative = rawPath;
	if (prefix) {
		if (!rawPath.startsWith(prefix)) return undefined;
		relative = rawPath.slice(prefix.length);
	}
	if (!relative) return undefined;
	try {
		return normalizeRelativePath(relative);
	} catch {
		throw new ExplorerParseError("Git returned a path outside the relative explorer protocol.");
	}
}

export function normalizeRepoPrefix(value: string): string {
	if (value === "") return "";
	const clean = value.replace(/\r?\n$/, "");
	if (!clean || clean.includes("\0") || clean.includes("\\") || clean.startsWith("/") || /^[A-Za-z]:/.test(clean)) {
		throw new ExplorerParseError("Git returned an invalid repository prefix.");
	}
	const withoutSlash = clean.endsWith("/") ? clean.slice(0, -1) : clean;
	const normalized = normalizeRelativePath(withoutSlash);
	return `${normalized}/`;
}

function summaryFor(status: Omit<ExplorerFileStatus, "summary">): ExplorerStatusSummary {
	if (status.conflict) return "conflict";
	if (status.untracked) return "untracked";
	if (status.renamed) return "renamed";
	if (status.copied) return "copied";
	if (status.deleted) return "deleted";
	if (status.added) return "added";
	return "modified";
}

function isConflict(index: string, worktree: string): boolean {
	return index === "U" || worktree === "U" || new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]).has(`${index}${worktree}`);
}

function makeStatus(path: string, oldPath: string | undefined, index: string, worktree: string): ExplorerFileStatus {
	const untracked = index === "?" && worktree === "?";
	const conflict = isConflict(index, worktree);
	const renamed = index === "R" || worktree === "R";
	const copied = index === "C" || worktree === "C";
	const statusWithoutSummary: Omit<ExplorerFileStatus, "summary"> = {
		path,
		...(oldPath ? { oldPath } : {}),
		index,
		worktree,
		staged: !untracked && index !== " " && index !== "!",
		unstaged: !untracked && worktree !== " " && worktree !== "!",
		conflict,
		untracked,
		modified: index === "M" || worktree === "M" || index === "T" || worktree === "T",
		added: untracked || index === "A" || worktree === "A",
		deleted: index === "D" || worktree === "D",
		renamed,
		copied,
	};
	return { ...statusWithoutSummary, summary: summaryFor(statusWithoutSummary) };
}

/** Parse `git status --porcelain=v1 -z`. In the `-z` form a rename/copy's
 * destination is in the status record and its source is the following token. */
export function parsePorcelainStatus(raw: string | Buffer, repoPrefix = "", maxRecords = STATUS_RECORD_LIMIT): ExplorerFileStatus[] {
	const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;
	const tokens = text.split("\0");
	if (tokens.at(-1) === "") tokens.pop();
	const statuses: ExplorerFileStatus[] = [];
	let records = 0;
	for (let i = 0; i < tokens.length; i++) {
		if (++records > maxRecords) throw new ExplorerParseError("Git status returned too many records.");
		const token = tokens[i];
		if (token.length < 4 || token[2] !== " ") throw new ExplorerParseError("Git returned malformed porcelain status.");
		const index = token[0];
		const worktree = token[1];
		const rawPath = token.slice(3);
		const twoPath = index === "R" || index === "C" || worktree === "R" || worktree === "C";
		let rawOldPath: string | undefined;
		if (twoPath) {
			rawOldPath = tokens[++i];
			if (!rawOldPath) throw new ExplorerParseError("Git returned an incomplete rename or copy record.");
		}
		const relativePath = pathFromRepo(rawPath, repoPrefix);
		const oldPath = rawOldPath === undefined ? undefined : pathFromRepo(rawOldPath, repoPrefix);
		if (!relativePath || (rawOldPath !== undefined && !oldPath)) continue;
		statuses.push(makeStatus(relativePath, oldPath, index, worktree));
	}
	return statuses.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** Parse `git diff --cached --name-status -z`. All records are validated even
 * though only canonical copy records are used for provenance augmentation. */
export function parseStagedNameStatus(raw: string | Buffer, repoPrefix = "", maxRecords = STATUS_RECORD_LIMIT): StagedNameStatus[] {
	const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;
	const tokens = text.split("\0");
	if (tokens.at(-1) === "") tokens.pop();
	const result: StagedNameStatus[] = [];
	let records = 0;
	for (let i = 0; i < tokens.length;) {
		if (++records > maxRecords) throw new ExplorerParseError("Git name-status returned too many records.");
		const header = tokens[i++];
		const match = /^([A-Z])(\d{1,3})?$/.exec(header);
		if (!match) throw new ExplorerParseError("Git returned malformed staged name-status data.");
		const code = match[1];
		const score = match[2] === undefined ? undefined : Number(match[2]);
		const twoPath = code === "R" || code === "C";
		if ((twoPath && (score === undefined || score > 100)) || (!twoPath && score !== undefined)) {
			throw new ExplorerParseError("Git returned a non-canonical staged name-status record.");
		}
		const first = tokens[i++];
		const second = twoPath ? tokens[i++] : undefined;
		if (!first || (twoPath && !second)) throw new ExplorerParseError("Git returned an incomplete staged name-status record.");
		const oldPath = twoPath ? pathFromRepo(first, repoPrefix) : undefined;
		const path = pathFromRepo(twoPath ? second! : first, repoPrefix);
		if (!path || (twoPath && !oldPath)) continue;
		result.push({ code, ...(score === undefined ? {} : { score }), path, ...(oldPath ? { oldPath } : {}) });
	}
	return result;
}

/** Add retained-source copy provenance without changing porcelain's authoritative
 * X/Y facts. Only an index-added, otherwise compatible destination may be
 * augmented. */
export function mergeCopyProvenance(statuses: readonly ExplorerFileStatus[], staged: readonly StagedNameStatus[]): ExplorerFileStatus[] {
	const copies = new Map(staged.filter((entry) => entry.code === "C" && entry.oldPath).map((entry) => [entry.path, entry]));
	return statuses.map((status) => {
		const copy = copies.get(status.path);
		if (!copy || status.index !== "A" || status.conflict || status.untracked || status.deleted || status.renamed || status.copied) return { ...status };
		const augmented = { ...status, oldPath: copy.oldPath, copied: true };
		return { ...augmented, summary: summaryFor(augmented) };
	});
}

export function parentPaths(relativePath: string): string[] {
	const segments = normalizeRelativePath(relativePath).split("/");
	const parents: string[] = [];
	for (let i = 1; i < segments.length; i++) parents.push(segments.slice(0, i).join("/"));
	return parents;
}

/** Build serializable ancestor decorations and deleted virtual nodes. The panel
 * merges these nodes into lazy filesystem listings by path, so existing nodes win. */
export function buildStatusTreeModel(statuses: readonly ExplorerFileStatus[]): StatusTreeModel {
	const ancestors = new Set<string>();
	const virtual = new Map<string, ExplorerEntry & { status?: ExplorerFileStatus }>();
	for (const status of statuses) {
		for (const parent of parentPaths(status.path)) ancestors.add(parent);
		if (!status.deleted || status.renamed) continue;
		for (const parent of parentPaths(status.path)) {
			if (!virtual.has(parent)) virtual.set(parent, { path: parent, name: parent.split("/").at(-1)!, kind: "directory", virtual: true });
		}
		virtual.set(status.path, { path: status.path, name: status.path.split("/").at(-1)!, kind: "file", virtual: true, status });
	}
	return {
		files: statuses.map((status) => ({ ...status })),
		ancestors: [...ancestors].sort(),
		virtualEntries: sortExplorerEntries([...virtual.values()]),
	};
}

export function classifyFileBytes(bytes: Uint8Array, totalBytes = bytes.byteLength, limit = READ_BYTE_LIMIT): FileContent {
	if (totalBytes > limit || bytes.byteLength > limit) return { kind: "too-large", bytes: totalBytes, limit };
	if (bytes.byteLength === 0) return { kind: "empty", text: "", bytes: 0 };
	if (bytes.includes(0)) return { kind: "binary", bytes: totalBytes };
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return text.length === 0 ? { kind: "empty", text: "", bytes: 0 } : { kind: "text", text, bytes: totalBytes };
	} catch {
		return { kind: "binary", bytes: totalBytes };
	}
}

function quoteDiffPath(path: string): string {
	if (!/[\t\n\r "\\]/.test(path)) return path;
	return `"${path.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\t/g, "\\t").replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
}

/** Synthesize the complete new-file unified diff used for untracked/unborn text. */
export function synthesizeAddedDiff(path: string, text: string): string {
	const relativePath = normalizeRelativePath(path);
	const aPath = quoteDiffPath(`a/${relativePath}`);
	const bPath = quoteDiffPath(`b/${relativePath}`);
	const hasFinalNewline = text.endsWith("\n");
	const lines = text === "" ? [] : text.split("\n");
	if (hasFinalNewline) lines.pop();
	const header = [`diff --git ${aPath} ${bPath}`, "new file mode 100644", "--- /dev/null", `+++ ${bPath}`];
	if (lines.length === 0) return `${header.join("\n")}\n`;
	const body = lines.map((line) => `+${line}`);
	if (!hasFinalNewline) body.push("\\ No newline at end of file");
	return `${header.join("\n")}\n@@ -0,0 +1,${lines.length} @@\n${body.join("\n")}\n`;
}
