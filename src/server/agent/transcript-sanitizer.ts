/**
 * Transcript sanitizer — un-poison persisted agent `.jsonl` transcripts whose
 * active branch contains orphaned tool results or whose `user` messages carry
 * a blank text body.
 *
 * Orphan repair follows Pi's parent-linked active branch and latest compaction
 * projection. A message-level `toolResult`/`tool_result`/`tool` is removed only
 * when the current assistant result run does not contain its id; unrelated inactive records and
 * lines remain byte-identical, while every surviving branch minimally bypasses
 * a removed shared-ancestor link.
 *
 * Blank-content background: the model API rejects a user message whose ContentBlock has a
 * blank `text` field (next to an image block, or as a standalone empty text
 * block). Before the source-prevention fix (synthesizeAttachmentText in
 * session-manager.enqueuePrompt), an image/attachment-only prompt committed
 * exactly such a blank-text user message to the agent's `.jsonl`. Once
 * committed, every later turn re-sends that block → permanently rejected. pi
 * exposes no history-edit RPC, so the only cure for an already-poisoned
 * transcript is to repair the `.jsonl` Bobbit owns at the rehydration boundary
 * (before `switch_session`).
 *
 * This module is a pure, idempotent, one-pass sanitizer: it rewrites a
 * persisted `user` message whose effective text is blank/whitespace-only to the
 * synthetic `ATTACHMENT_ONLY_TEXT` ("Attachments:"), covering BOTH the
 * image-adjacent case (`[{text:""},{image}]`) AND the standalone empty/blank
 * user message produced by a non-image attachment-only send (`[{text:""}]`, or
 * a user message with only non-text content / no text block at all).
 *
 * IMPORTANT: tool results are also represented as `role:"user"` messages whose
 * content is a `tool_result`/`toolResult` block with no text. Those are normal,
 * valid history — rewriting them to "Attachments:" would corrupt tool-call
 * history and break tool-result ordering. So a user message that carries ANY
 * tool_result/toolResult block is left byte-identical. It leaves every other
 * line byte-identical too, so re-running it is a no-op.
 */

import { ATTACHMENT_ONLY_TEXT } from "./rpc-bridge.js";
import { sessionFileRead, type SessionFsContext } from "./session-fs.js";
import { containerPathToHost } from "./rpc-bridge.js";
import { trustedAgentSessionsRoots } from "./agent-session-path.js";
import type { SandboxManager } from "./sandbox-manager.js";
import fs from "node:fs";
import path from "node:path";

/**
 * Compute the effective text of a pi-coding-agent message `content`.
 * - string content → the string itself
 * - array content  → concatenation of all `text` block texts
 * - anything else  → "" (no text)
 */
function effectiveText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as any).type === "text" && typeof (block as any).text === "string") {
			parts.push((block as any).text);
		}
	}
	return parts.join("");
}

/**
 * Detect whether a message `content` carries a tool-result block. Tool results
 * are persisted as `role:"user"` messages with a `tool_result` (or `toolResult`)
 * content block and no text — they are valid history and MUST NOT be rewritten.
 */
function hasToolResultBlock(content: unknown): boolean {
	if (!Array.isArray(content)) return false;
	return content.some(
		(b) => b && typeof b === "object" &&
			((b as any).type === "tool_result" || (b as any).type === "toolResult"),
	);
}

/**
 * Rewrite a `user` message's `content` so it carries the synthetic
 * `ATTACHMENT_ONLY_TEXT`. Returns the new content value.
 *
 * - string content → replaced with the synthetic phrase
 * - array content with a text block → first text block's text set to the phrase
 * - array content without a text block → a leading text block is inserted
 *   (preserving the image/other blocks)
 * - non-string non-array content → wrapped as `[{type:"text", text: phrase}]`
 */
function rewriteBlankUserContent(content: unknown): unknown {
	if (typeof content === "string") return ATTACHMENT_ONLY_TEXT;
	if (!Array.isArray(content)) {
		return [{ type: "text", text: ATTACHMENT_ONLY_TEXT }];
	}
	const firstTextIdx = content.findIndex(
		(b) => b && typeof b === "object" && (b as any).type === "text",
	);
	if (firstTextIdx >= 0) {
		const next = content.slice();
		next[firstTextIdx] = { ...(next[firstTextIdx] as any), text: ATTACHMENT_ONLY_TEXT };
		return next;
	}
	return [{ type: "text", text: ATTACHMENT_ONLY_TEXT }, ...content];
}

/** Result of a content-string sanitize/rebase pass. */
export interface SanitizeResult {
	/** The (possibly unchanged) JSONL content. */
	content: string;
	/** Whether any line was repaired, removed, or rewritten. */
	changed: boolean;
	/** Number of poisoned transcript records repaired. */
	rewritten: number;
}

interface ParsedTranscriptLine {
	lineIndex: number;
	entry: any;
	id: string | null;
	parentId: string | null;
}

interface ProjectedTranscriptRecord {
	/** Null for messages materialized inside a Pi 0.81 `retainedTail`. */
	lineIndex: number | null;
	entry: any;
}

function parseTranscriptLines(lines: string[]): ParsedTranscriptLine[] {
	const parsed: ParsedTranscriptLine[] = [];
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const trimmed = lines[lineIndex].trim();
		if (!trimmed) continue;
		try {
			const entry = JSON.parse(trimmed);
			if (!entry || typeof entry !== "object") continue;
			parsed.push({
				lineIndex,
				entry,
				id: typeof entry.id === "string" && entry.id.length > 0 ? entry.id : null,
				parentId: typeof entry.parentId === "string" && entry.parentId.length > 0 ? entry.parentId : null,
			});
		} catch {
			// Malformed and non-JSON lines are opaque transcript data.
		}
	}
	return parsed;
}

/**
 * Return the parent-linked branch ending at Pi's current leaf. Session headers
 * are not tree entries. Ordinarily the last parsed, id-bearing non-header
 * record is the leaf. Pi 0.81 harness JSONL can instead end in a `leaf` control
 * record whose `targetId` selects an earlier entry (or null for an empty
 * branch); the control record itself is not part of the active branch.
 * Missing targets/parents and cycles terminate the walk conservatively.
 */
function activeTranscriptBranch(parsed: ParsedTranscriptLine[]): ParsedTranscriptLine[] {
	let leafId: string | null = null;
	const byId = new Map<string, ParsedTranscriptLine>();
	for (const record of parsed) {
		if (!record.id || record.entry.type === "session") continue;
		byId.set(record.id, record);
		if (record.entry.type === "leaf") {
			leafId = typeof record.entry.targetId === "string" && record.entry.targetId.length > 0
				? record.entry.targetId
				: null;
		} else {
			leafId = record.id;
		}
	}
	if (!leafId) return [];

	const reverseBranch: ParsedTranscriptLine[] = [];
	const visited = new Set<string>();
	let current: ParsedTranscriptLine | undefined = byId.get(leafId);
	while (current?.id && !visited.has(current.id)) {
		reverseBranch.push(current);
		visited.add(current.id);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return reverseBranch.reverse();
}

function projectedContextBranch(branch: ParsedTranscriptLine[]): ProjectedTranscriptRecord[] {
	let compactionIndex = -1;
	for (let i = 0; i < branch.length; i++) {
		if (branch[i].entry.type === "compaction") compactionIndex = i;
	}
	if (compactionIndex < 0) return branch;

	const compaction = branch[compactionIndex].entry;
	if (Array.isArray(compaction.retainedTail)) {
		// Pi 0.81 harness compactions treat retainedTail as a self-contained
		// checkpoint, even when a compatibility firstKeptEntryId is also present.
		// Model those messages for tool-call ordering without rewriting the
		// compaction line: it may carry additive usage/details fields which the
		// sanitizer must preserve byte-for-byte.
		const retainedTail = compaction.retainedTail.map((message: unknown) => ({
			lineIndex: null,
			entry: { type: "message", message },
		}));
		return [...retainedTail, ...branch.slice(compactionIndex + 1)];
	}

	const firstKeptId = typeof compaction.firstKeptEntryId === "string"
		? compaction.firstKeptEntryId
		: "";
	const firstKeptIndex = firstKeptId
		? branch.findIndex((record, index) => index < compactionIndex && record.id === firstKeptId)
		: -1;

	// Legacy Pi projections place the latest summary ahead of the preserved
	// top-level tail. The compaction record is metadata, not a conversation
	// message. When its boundary cannot be resolved, only descendants written
	// after compaction are known-active.
	const keptTail = firstKeptIndex >= 0
		? branch.slice(firstKeptIndex, compactionIndex)
		: [];
	return [...keptTail, ...branch.slice(compactionIndex + 1)];
}

const TOOL_USE_ID_KEYS = ["toolCallId", "toolUseId", "tool_use_id", "tool_call_id", "id"] as const;

function persistedToolUseId(value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	for (const key of TOOL_USE_ID_KEYS) {
		const id = (value as Record<string, unknown>)[key];
		if (typeof id === "string" && id.trim().length > 0) return id;
	}
	return null;
}

function isMessageLevelToolResultRole(role: unknown): boolean {
	return role === "toolResult" || role === "tool_result" || role === "tool";
}

function assistantToolCallIds(content: unknown): Set<string> {
	const ids = new Set<string>();
	if (!Array.isArray(content)) return ids;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const type = (block as any).type;
		const id = persistedToolUseId(block);
		if ((type === "toolCall" || type === "tool_use") && id) ids.add(id);
	}
	return ids;
}

function orphanToolResultLineIndexes(branch: ParsedTranscriptLine[]): Set<number> {
	const orphanLines = new Set<number>();
	let pendingToolCallIds: Set<string> | null = null;

	for (const record of projectedContextBranch(branch)) {
		const entry = record.entry;
		if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") {
			// Pi projects these top-level entries into actual LLM messages. They
			// therefore end the immediately-preceding assistant result run just as
			// a user/custom message stored inside a `message` entry would. Other
			// session-tree entries are state/display metadata and stay transparent.
			// The latest compaction is deliberately absent from
			// projectedContextBranch: Pi places its summary before the preserved
			// tail, rather than at its physical JSONL position.
			if (
				entry.type === "custom_message" ||
				(entry.type === "branch_summary" && entry.summary)
			) {
				pendingToolCallIds = null;
			}
			continue;
		}

		const message = entry.message;
		if (message.role === "assistant") {
			pendingToolCallIds = assistantToolCallIds(message.content);
			continue;
		}
		if (isMessageLevelToolResultRole(message.role)) {
			const toolCallId = persistedToolUseId(message);
			if (!toolCallId || !pendingToolCallIds?.has(toolCallId)) {
				// retainedTail messages are embedded in the compaction record. They
				// participate in Pi's context ordering, but are not independently
				// removable JSONL records.
				if (record.lineIndex !== null) orphanLines.add(record.lineIndex);
			} else {
				// One result settles one call. Repeated results for the same id are
				// structurally invalid even when the assistant originally called it.
				pendingToolCallIds.delete(toolCallId);
			}
			continue;
		}

		// Any other conversation-bearing message ends the result run.
		pendingToolCallIds = null;
	}

	return orphanLines;
}

/**
 * Remove structurally orphaned message-level Pi tool-result records from the
 * active context branch. Untouched JSONL lines remain byte-identical. Every
 * surviving child whose parent chain crosses a removed record is minimally
 * reparented to the nearest retained ancestor, including children on inactive
 * branches that shared the removed active-branch ancestor.
 */
function repairOrphanToolResults(content: string): SanitizeResult {
	if (!content) return { content, changed: false, rewritten: 0 };
	const lines = content.split("\n");
	const parsed = parseTranscriptLines(lines);
	const activeBranch = activeTranscriptBranch(parsed);
	const removedLineIndexes = orphanToolResultLineIndexes(activeBranch);
	if (removedLineIndexes.size === 0) return { content, changed: false, rewritten: 0 };

	const removedParents = new Map<string, string | null>();
	for (const record of activeBranch) {
		if (removedLineIndexes.has(record.lineIndex) && record.id) {
			removedParents.set(record.id, record.parentId);
		}
	}

	// A record removed from the active branch may also be an ancestor of one or
	// more inactive branches. Repair every surviving direct child of the removed
	// chain; limiting this pass to activeBranch would leave those branches with a
	// dangling parentId and make them impossible for Pi to resume later.
	for (const record of parsed) {
		if (removedLineIndexes.has(record.lineIndex)) continue;
		let changed = false;
		let parentId = record.parentId;
		const visitedParents = new Set<string>();
		while (parentId && removedParents.has(parentId) && !visitedParents.has(parentId)) {
			visitedParents.add(parentId);
			parentId = removedParents.get(parentId) ?? null;
		}
		if (parentId !== record.parentId) {
			record.entry.parentId = parentId;
			changed = true;
		}

		// Pi 0.81 harness persists branch selection as a leaf control record.
		// If it targets a removed active orphan, advance the control pointer to
		// the same nearest retained ancestor or the reloaded session would keep a
		// dangling active-leaf id.
		if (record.entry.type === "leaf" && typeof record.entry.targetId === "string") {
			let targetId: string | null = record.entry.targetId;
			const visitedTargets = new Set<string>();
			while (targetId && removedParents.has(targetId) && !visitedTargets.has(targetId)) {
				visitedTargets.add(targetId);
				targetId = removedParents.get(targetId) ?? null;
			}
			if (targetId !== record.entry.targetId) {
				record.entry.targetId = targetId;
				changed = true;
			}
		}

		if (!changed) continue;
		const carriageReturn = lines[record.lineIndex].endsWith("\r") ? "\r" : "";
		lines[record.lineIndex] = JSON.stringify(record.entry) + carriageReturn;
	}

	const repairedLines = lines.filter((_line, index) => !removedLineIndexes.has(index));
	return {
		content: repairedLines.join("\n"),
		changed: true,
		rewritten: removedLineIndexes.size,
	};
}

export interface RebaseTranscriptCwdMetadataOptions {
	/** Archived/provenance cwd values that may appear in runtime-only metadata. */
	oldCwds: string[];
	/** Fresh runtime cwd for the newly-created session. */
	newCwd: string;
}

/**
 * Sanitize raw `.jsonl` content. Pure — no I/O. Removes active-branch orphan
 * tool results and rewrites blank-text `user` messages. All unrelated lines and
 * the original trailing-newline shape are preserved. Idempotent: re-running on
 * sanitized output yields `changed:false`.
 */
export function sanitizeTranscriptContent(content: string): SanitizeResult {
	const orphanRepair = repairOrphanToolResults(content);
	const blankRepair = transformTranscriptJsonl(orphanRepair.content, (entry) => {
		if (!entry || entry.type !== "message" || !entry.message) return false;
		if (entry.message.role !== "user") return false;

		// Tool-result user messages are valid history (no text by design) —
		// never touch them, or tool-call history/ordering is corrupted.
		if (hasToolResultBlock(entry.message.content)) return false;

		const text = effectiveText(entry.message.content);
		if (text.trim() !== "") return false; // already valid — leave byte-identical

		entry.message.content = rewriteBlankUserContent(entry.message.content);
		return true;
	});
	return {
		content: blankRepair.content,
		changed: orphanRepair.changed || blankRepair.changed,
		rewritten: orphanRepair.rewritten + blankRepair.rewritten,
	};
}

/**
 * Rebase runtime-only Pi cwd metadata in raw transcript JSONL. Only top-level
 * `cwd` on Pi session records and system init records (or legacy system records
 * with no subtype) is rewritten. Message content and user-visible text are
 * never inspected.
 */
export function rebaseTranscriptCwdMetadataContent(
	content: string,
	options: RebaseTranscriptCwdMetadataOptions,
): SanitizeResult {
	const oldCwds = new Set(options.oldCwds.filter((cwd): cwd is string => typeof cwd === "string" && cwd.length > 0));
	if (!content || !options.newCwd || oldCwds.size === 0) {
		return { content, changed: false, rewritten: 0 };
	}

	return transformTranscriptJsonl(content, (entry) => {
		if (!isRebasableRuntimeCwdMetadataRecord(entry)) return false;
		if (!oldCwds.has(entry.cwd) || entry.cwd === options.newCwd) return false;
		entry.cwd = options.newCwd;
		return true;
	});
}

function isRebasableRuntimeCwdMetadataRecord(entry: any): entry is { type: "session" | "system"; cwd: string } {
	if (!entry || typeof entry.cwd !== "string") return false;
	if (entry.type === "session") return true;
	if (entry.type !== "system") return false;
	const hasSubtype = Object.prototype.hasOwnProperty.call(entry, "subtype");
	return entry.subtype === "init" || !hasSubtype;
}

function transformTranscriptJsonl(
	content: string,
	mutateEntry: (entry: any) => boolean,
): SanitizeResult {
	if (!content) return { content, changed: false, rewritten: 0 };

	// Preserve the exact line structure: split on \n, keep empty segments, and
	// rejoin with \n so the only bytes that change are the rewritten JSON lines.
	const lines = content.split("\n");
	let changed = false;
	let rewritten = 0;

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const trimmed = raw.trim();
		if (!trimmed) continue;

		let entry: any;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			continue; // non-JSON line — leave untouched
		}

		if (!mutateEntry(entry)) continue;
		lines[i] = JSON.stringify(entry);
		changed = true;
		rewritten++;
	}

	if (!changed) return { content, changed: false, rewritten: 0 };
	return { content: lines.join("\n"), changed: true, rewritten };
}

/** True iff `target` is `root` itself or strictly nested inside it. */
function isInsideOrEqual(root: string, target: string): boolean {
	const rel = path.relative(root, target);
	if (rel === "") return true; // target === root
	return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** True iff `target` is strictly nested inside `root` (not root itself). */
function isStrictlyInside(root: string, target: string): boolean {
	const rel = path.relative(root, target);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function hasTraversalSegment(hostPath: string): boolean {
	return hostPath.replace(/\\/g, "/").split("/").includes("..");
}

function normalizeComparablePath(hostPath: string): string {
	return path.resolve(hostPath).replace(/[\\/]+$/, "");
}

export interface TranscriptRootPolicy {
	/** Trusted active, historical, and legacy agent sessions roots. */
	readonly sessionsRoots: () => readonly string[];
}

/**
 * Create an isolated transcript path policy. The policy owns its exact-file
 * trust declarations, so callers can scope validation to a gateway or test
 * fixture without mutating startup agent-directory state.
 */
export function createTranscriptRootPolicy(
	sessionsRoots: readonly string[] | (() => readonly string[]),
): TranscriptRootPolicy {
	const fixedRoots = typeof sessionsRoots === "function" ? null : Object.freeze([...sessionsRoots]);
	const resolveRoots = typeof sessionsRoots === "function" ? sessionsRoots : () => fixedRoots!;
	const policy = Object.freeze({ sessionsRoots: resolveRoots });
	trustedExactSessionFilesByPolicy.set(policy, new Set());
	return policy;
}

const trustedExactSessionFilesByPolicy = new WeakMap<TranscriptRootPolicy, Set<string>>();
const defaultTranscriptRootPolicy = createTranscriptRootPolicy(trustedAgentSessionsRoots);

function trustedExactSessionFiles(rootPolicy: TranscriptRootPolicy): Set<string> {
	let files = trustedExactSessionFilesByPolicy.get(rootPolicy);
	if (!files) {
		files = new Set();
		trustedExactSessionFilesByPolicy.set(rootPolicy, files);
	}
	return files;
}

function isWithinTrustedSessionsRoot(hostPath: string, rootPolicy: TranscriptRootPolicy): boolean {
	if (!hostPath || hasTraversalSegment(hostPath)) return false;
	const resolved = path.resolve(hostPath);
	return rootPolicy.sessionsRoots().some(root => isStrictlyInside(path.resolve(root), resolved));
}

/**
 * Trust an exact persisted absolute `agentSessionFile` path for read-only
 * compatibility after agent-dir migrations. Paths outside trusted sessions roots
 * are accepted only when they already point at a regular, non-symlink `.jsonl`
 * with recognizable transcript content; they never become sanitizer write or
 * purge-delete targets.
 */
export function trustPersistedAgentSessionFile(
	filePath: string | null | undefined,
	rootPolicy: TranscriptRootPolicy = defaultTranscriptRootPolicy,
): void {
	const rootSafe = resolveSafeSessionsPath(filePath ?? "", rootPolicy);
	if (rootSafe) {
		trustedExactSessionFiles(rootPolicy).add(normalizeComparablePath(rootSafe));
		return;
	}
	const readable = validateReadableOutsideTranscriptFile(filePath);
	if (!readable) return;
	trustedExactSessionFiles(rootPolicy).add(normalizeComparablePath(readable));
}

function isTrustedExactSessionFile(filePath: string, rootPolicy: TranscriptRootPolicy): boolean {
	return trustedExactSessionFiles(rootPolicy).has(normalizeComparablePath(filePath));
}

export function resolveReadablePersistedAgentSessionFile(
	filePath: string | null | undefined,
	rootPolicy: TranscriptRootPolicy = defaultTranscriptRootPolicy,
): string | null {
	if (!filePath || hasTraversalSegment(filePath)) return null;
	if (!path.isAbsolute(filePath) && !/^[A-Za-z]:[\\/]/.test(filePath)) return null;
	const rootSafe = resolveSafeSessionsPath(filePath, rootPolicy);
	if (rootSafe) return rootSafe;
	const realPath = realpathRegularJsonlFile(path.resolve(filePath));
	if (!realPath || !isTrustedExactSessionFile(realPath, rootPolicy)) return null;
	return realPath;
}

function validateReadableOutsideTranscriptFile(filePath: string | null | undefined): string | null {
	if (!filePath || hasTraversalSegment(filePath)) return null;
	if (!path.isAbsolute(filePath) && !/^[A-Za-z]:[\\/]/.test(filePath)) return null;
	const resolved = path.resolve(filePath);
	return isReadableTranscriptFile(resolved) ? realpathRegularJsonlFile(resolved) : null;
}

function isReadableTranscriptFile(filePath: string): boolean {
	const realPath = realpathRegularJsonlFile(filePath);
	if (!realPath) return false;
	try {
		const fd = fs.openSync(realPath, "r");
		try {
			const buffer = Buffer.alloc(64 * 1024);
			const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
			const lines = buffer.toString("utf-8", 0, bytes).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
			for (const line of lines) {
				try {
					const entry = JSON.parse(line);
					if (isTranscriptShape(entry)) return true;
				} catch {
					return false;
				}
			}
			return false;
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return false;
	}
}

function realpathRegularJsonlFile(filePath: string): string | null {
	if (path.extname(filePath).toLowerCase() !== ".jsonl") return null;
	try {
		const lstat = fs.lstatSync(filePath);
		if (lstat.isSymbolicLink() || !lstat.isFile()) return null;
		const realPath = fs.realpathSync(filePath);
		const stat = fs.statSync(realPath);
		if (!stat.isFile()) return null;
		return realPath;
	} catch {
		return null;
	}
}

function isTranscriptShape(entry: unknown): boolean {
	if (!entry || typeof entry !== "object") return false;
	const obj = entry as Record<string, unknown>;
	if (obj.type === "session") return typeof obj.cwd === "string" || typeof obj.id === "string";
	if (obj.type === "message") return !!obj.message && typeof obj.message === "object";
	if (obj.type === "system") return true;
	return false;
}

/**
 * Lexical-only guard kept for callers/tests that want a cheap prefix check:
 * a transcript path is acceptable iff it has no `..` segment and resolves
 * (lexically) strictly inside an active/historical/legacy agent sessions root,
 * or exactly matches a persisted `agentSessionFile` registered by the session
 * manager. Does NOT touch the filesystem — see `resolveSafeSessionsPath` for
 * the symlink/TOCTOU-resistant variant used on the real I/O path.
 */
export function isWithinAgentSessionsDir(
	hostPath: string,
	rootPolicy: TranscriptRootPolicy = defaultTranscriptRootPolicy,
): boolean {
	if (!hostPath || hasTraversalSegment(hostPath)) return false;
	const resolved = path.resolve(hostPath);
	if (isTrustedExactSessionFile(resolved, rootPolicy)) return true;
	return isWithinTrustedSessionsRoot(resolved, rootPolicy);
}

/**
 * Symlink/TOCTOU-resistant resolver for a transcript path that the sanitizer
 * is about to read from / write to on the HOST filesystem.
 *
 * Rejects (returns `null`) when the path:
 *  - is empty or contains a `..` traversal segment;
 *  - has a parent directory that doesn't exist or, after `realpathSync`
 *    (which follows directory symlinks), is NOT inside a real trusted sessions
 *    root (active, historical, or legacy) and is not an exact trusted persisted
 *    `agentSessionFile` path;
 *  - resolves to an existing entry that is a symlink or not a regular file.
 *
 * On success returns the concrete real path (real parent + basename), which the
 * caller opens with `O_NOFOLLOW` (where available) so a symlink swapped in after
 * this check is still not followed.
 */
export function resolveSafeSessionsPath(
	hostPath: string,
	rootPolicy: TranscriptRootPolicy = defaultTranscriptRootPolicy,
): string | null {
	if (!hostPath) return null;
	const segments = hostPath.replace(/\\/g, "/").split("/");
	if (segments.includes("..")) return null;

	const resolved = path.resolve(hostPath);
	const parent = path.dirname(resolved);
	let parentReal: string;
	try {
		parentReal = fs.realpathSync(parent); // follows directory symlinks
	} catch {
		return null; // parent missing/unreadable
	}

	let insideTrustedRoot = false;
	for (const root of rootPolicy.sessionsRoots()) {
		try {
			const rootReal = fs.realpathSync(path.resolve(root));
			if (isInsideOrEqual(rootReal, parentReal)) {
				insideTrustedRoot = true;
				break;
			}
		} catch {
			// Historical roots may no longer exist; ignore them.
		}
	}
	if (!insideTrustedRoot) return null;

	const realPath = path.join(parentReal, path.basename(resolved));

	// Reject if the target exists and is a symlink or not a regular file.
	try {
		const st = fs.lstatSync(realPath);
		if (st.isSymbolicLink() || !st.isFile()) return null;
	} catch (err: any) {
		// ENOENT is tolerable in principle, but for sanitization the file must
		// already exist (we only write back after a successful read). Treat any
		// stat failure as a rejection to stay conservative.
		return null;
	}

	return realPath;
}

/**
 * Write `data` to `realPath` without following a final-component symlink. Uses
 * `O_NOFOLLOW` where the platform provides it (POSIX); on Windows the constant
 * is absent (0) and the prior `lstat` check is the symlink guard.
 */
function writeFileNoFollow(realPath: string, data: string): void {
	const NOFOLLOW = (fs.constants as any).O_NOFOLLOW ?? 0;
	const flags = fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_CREAT | NOFOLLOW;
	const fd = fs.openSync(realPath, flags, 0o600);
	try {
		fs.writeFileSync(fd, data, "utf-8");
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Read, sanitize, and (if changed) write back an agent `.jsonl` transcript file
 * at the rehydration boundary, just before `switch_session`. Best-effort and
 * non-fatal: any read/write failure is swallowed so restore/respawn proceeds.
 *
 * For non-sandboxed sessions the host filesystem is written directly. For
 * sandboxed sessions the agent sessions dir is bind-mounted to the host, so the
 * container-path is translated to its host path and written there (visible
 * inside the container via the mount).
 *
 * @returns the number of poisoned transcript records repaired (0 when unchanged).
 */
export async function sanitizeAgentTranscriptFile(
	ctx: SessionFsContext,
	filePath: string,
	sandboxManager: SandboxManager | null,
	rootPolicy: TranscriptRootPolicy = defaultTranscriptRootPolicy,
): Promise<number> {
	return transformAgentTranscriptFile(
		ctx,
		filePath,
		sandboxManager,
		sanitizeTranscriptContent,
		"sanitize",
		(file, rewritten) => `Repaired ${rewritten} poisoned transcript record(s) in ${file}`,
		rootPolicy,
	);
}

/**
 * Read, rebase runtime-only cwd metadata, and (if changed) write back an agent
 * `.jsonl` transcript file using the same safe read/write boundary as the blank
 * user-message sanitizer. Best-effort and non-fatal.
 *
 * @returns the number of runtime cwd metadata records rewritten.
 */
export async function rebaseAgentTranscriptCwdMetadataFile(
	ctx: SessionFsContext,
	filePath: string,
	sandboxManager: SandboxManager | null,
	options: RebaseTranscriptCwdMetadataOptions,
	rootPolicy: TranscriptRootPolicy = defaultTranscriptRootPolicy,
): Promise<number> {
	return transformAgentTranscriptFile(
		ctx,
		filePath,
		sandboxManager,
		(content) => rebaseTranscriptCwdMetadataContent(content, options),
		"cwd metadata rebase",
		(file, rewritten) => `Rebased ${rewritten} runtime cwd metadata record(s) in ${file}`,
		rootPolicy,
	);
}

async function transformAgentTranscriptFile(
	ctx: SessionFsContext,
	filePath: string,
	sandboxManager: SandboxManager | null,
	transform: (content: string) => SanitizeResult,
	operation: string,
	logMessage: (filePath: string, rewritten: number) => string,
	rootPolicy: TranscriptRootPolicy,
): Promise<number> {
	try {
		// Resolve the host-side path. Non-sandboxed: filePath is already a host
		// path and is what the read+write both touch. Sandboxed: the read runs
		// in-container (docker exec); only the write is host-side, via the
		// bind-mounted sessions dir (container path → host path).
		const hostPath = ctx.sandboxed ? containerPathToHost(filePath) : filePath;

		// For non-sandboxed sessions, validate the real host path BEFORE reading.
		// Exact persisted paths outside trusted roots are read-compatible only; they
		// must never become sanitizer write/truncate targets.
		let writableRealPath: string | null = null;
		let readAllowed = true;
		if (!ctx.sandboxed) {
			writableRealPath = resolveSafeSessionsPath(hostPath, rootPolicy);
			readAllowed = writableRealPath !== null || resolveReadablePersistedAgentSessionFile(hostPath, rootPolicy) !== null;
			if (!readAllowed) {
				console.warn(`[transcript-sanitizer] Refusing to access path outside agent sessions dir: ${hostPath} (from ${filePath})`);
				return 0;
			}
		}

		const content = await sessionFileRead(ctx, filePath, sandboxManager);
		if (content === null || content === undefined || content === "") return 0;

		const result = transform(content);
		if (!result.changed) return 0;

		// Re-resolve + re-validate the real path immediately before writing
		// (TOCTOU) and write with O_NOFOLLOW so a symlink swapped in after the
		// check is not followed. A malformed/hostile agentSessionFile must never
		// let us clobber an arbitrary file.
		const realPath = resolveSafeSessionsPath(hostPath, rootPolicy);
		if (realPath === null) {
			console.warn(`[transcript-sanitizer] Refusing to write outside agent sessions dir: ${hostPath} (from ${filePath})`);
			return 0;
		}

		writeFileNoFollow(realPath, result.content);
		console.log(`[transcript-sanitizer] ${logMessage(filePath, result.rewritten)}`);
		return result.rewritten;
	} catch (err) {
		console.warn(`[transcript-sanitizer] Failed to ${operation} ${filePath} (non-fatal):`, err);
		return 0;
	}
}
