/**
 * Transcript sanitizer — repair persisted agent `.jsonl` transcripts at the
 * restore boundary.
 *
 * Background: the model API rejects a user message whose ContentBlock has a
 * blank `text` field (next to an image block, or as a standalone empty text
 * block). Before the source-prevention fix (synthesizeAttachmentText in
 * session-manager.enqueuePrompt), an image/attachment-only prompt committed
 * exactly such a blank-text user message to the agent's `.jsonl`. Once
 * committed, every later turn re-sends that block → permanently rejected. pi
 * exposes no history-edit RPC, so the only cure for an already-poisoned
 * transcript is to repair the `.jsonl` Bobbit owns at the rehydration boundary
 * (before `switch_session`).
 *
 * This module is a pure, idempotent sanitizer: it rewrites a
 * persisted `user` message whose effective text is blank/whitespace-only to the
 * synthetic `ATTACHMENT_ONLY_TEXT` ("Attachments:"), covering BOTH the
 * image-adjacent case (`[{text:""},{image}]`) AND the standalone empty/blank
 * user message produced by a non-image attachment-only send (`[{text:""}]`, or
 * a user message with only non-text content / no text block at all).
 *
 * IMPORTANT: tool results are also represented as `role:"user"` messages whose
 * content is a `tool_result`/`toolResult` block with no text. Valid tool-result
 * history is left byte-identical. Orphan results (no prior retained,
 * non-aborted/non-errored assistant tool call) are repaired at this restore
 * boundary so providers are not rehydrated with invalid tool-call history.
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

/** Detect whether a content block is a tool-result block. */
function isToolResultBlock(block: unknown): boolean {
	return !!block && typeof block === "object" &&
		((block as any).type === "tool_result" || (block as any).type === "toolResult");
}

/**
 * Detect whether a message `content` carries a tool-result block. Tool results
 * are persisted as `role:"user"` messages with a `tool_result` (or `toolResult`)
 * content block and no text — they are valid history only when matched to a
 * prior retained assistant tool call.
 */
function hasToolResultBlock(content: unknown): boolean {
	if (!Array.isArray(content)) return false;
	return content.some(isToolResultBlock);
}

function stringField(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function toolCallIdFromAssistantBlock(block: unknown): string | null {
	if (!block || typeof block !== "object") return null;
	const b = block as any;
	// Tolerant id resolution matching src/server/extension-host/action-guard.ts:
	// typed `toolCall`/`tool_use` blocks carry `id`, but some variants persist
	// `toolCallId` or `tool_use_id` instead. Accept any of the three so a valid
	// assistant tool call is never misclassified as orphaned.
	if (b.type === "toolCall" || b.type === "tool_use" || typeof b.toolCallId === "string") {
		return stringField(b.id ?? b.toolCallId ?? b.tool_use_id);
	}
	return null;
}

function toolResultIdFromBlock(block: unknown): string | null {
	if (!block || typeof block !== "object") return null;
	const b = block as any;
	return stringField(b.tool_use_id) ?? stringField(b.toolCallId) ?? stringField(b.id);
}

function messageStopReason(entry: any): unknown {
	return entry?.message?.stopReason ?? entry?.stopReason;
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
	/** Whether any line was rewritten or dropped. */
	changed: boolean;
	/** Number of blank user-message transcript records rewritten. */
	rewritten: number;
	/** Number of message-level orphan tool-result rows dropped. */
	droppedToolResultRows: number;
	/** Number of orphan tool-result content blocks filtered from user messages. */
	filteredToolResultBlocks: number;
}

export interface RebaseTranscriptCwdMetadataOptions {
	/** Archived/provenance cwd values that may appear in runtime-only metadata. */
	oldCwds: string[];
	/** Fresh runtime cwd for the newly-created session. */
	newCwd: string;
}

/**
 * Sanitize raw `.jsonl` content. Pure — no I/O. Rewrites blank-text `user`
 * messages in place, preserving every other line byte-for-byte (including the
 * original trailing-newline shape). Idempotent: re-running on sanitized output
 * yields `changed:false`.
 */
export function sanitizeTranscriptContent(content: string): SanitizeResult {
	if (!content) return emptySanitizeResult(content);

	// Preserve the exact line structure when no rows are dropped: split on \n,
	// keep empty segments, and rejoin with \n so unchanged lines stay byte-for-byte
	// identical. Dropped orphan result rows are omitted from the output.
	const lines = content.split("\n");
	const outputLines: string[] = [];
	const lineIndexByEntryId = new Map<string, number>();
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const trimmed = lines[lineIndex].trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed);
			const id = stringField(parsed?.id);
			if (id && !lineIndexByEntryId.has(id)) lineIndexByEntryId.set(id, lineIndex);
		} catch {
			// non-JSON line — no entry id to index
		}
	}
	const seenToolCallIds = new Map<string, number>();
	let changed = false;
	let rewritten = 0;
	let droppedToolResultRows = 0;
	let filteredToolResultBlocks = 0;

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const raw = lines[lineIndex];
		const trimmed = raw.trim();
		if (!trimmed) {
			outputLines.push(raw);
			continue;
		}

		let entry: any;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			outputLines.push(raw); // non-JSON line — leave untouched
			continue;
		}

		if (!entry || entry.type !== "message" || !entry.message) {
			if (entry?.type === "compaction") {
				const firstKeptEntryId = stringField(entry.firstKeptEntryId);
				const firstKeptLineIndex = firstKeptEntryId ? lineIndexByEntryId.get(firstKeptEntryId) : undefined;
				if (firstKeptLineIndex === undefined) {
					// Legacy fallback: without a resolvable exact retained-range boundary,
					// the marker itself is the only safe split point.
					seenToolCallIds.clear();
				} else {
					// Pi's `firstKeptEntryId` can name any retained entry (user,
					// assistant-without-tools, or assistant-with-tools). Drop only tool-call
					// ids whose originating assistant line is before that retained range.
					for (const [id, originLineIndex] of seenToolCallIds) {
						if (originLineIndex < firstKeptLineIndex) seenToolCallIds.delete(id);
					}
				}
			}
			outputLines.push(raw);
			continue;
		}

		const message = entry.message;
		if (message.role === "assistant") {
			const stopReason = messageStopReason(entry);
			if (stopReason !== "aborted" && stopReason !== "error" && Array.isArray(message.content)) {
				for (const block of message.content) {
					const id = toolCallIdFromAssistantBlock(block);
					if (id) seenToolCallIds.set(id, lineIndex);
				}
			}
			outputLines.push(raw);
			continue;
		}

		if (message.role === "toolResult") {
			const id = stringField(message.toolCallId);
			if (!id || !seenToolCallIds.has(id)) {
				changed = true;
				droppedToolResultRows++;
				continue;
			}
			outputLines.push(raw);
			continue;
		}

		if (message.role !== "user") {
			outputLines.push(raw);
			continue;
		}

		if (hasToolResultBlock(message.content)) {
			const filteredContent = (message.content as unknown[]).filter((block) => {
				if (!isToolResultBlock(block)) return true;
				const id = toolResultIdFromBlock(block);
				const keep = !!id && seenToolCallIds.has(id);
				if (!keep) filteredToolResultBlocks++;
				return keep;
			});

			if (filteredContent.length !== (message.content as unknown[]).length) {
				changed = true;
				if (filteredContent.length === 0) continue;
				entry.message.content = filteredContent;
				message.content = filteredContent;
				if (hasToolResultBlock(filteredContent)) {
					outputLines.push(JSON.stringify(entry));
					continue;
				}
			} else {
				// Valid tool-result user messages are valid history (no text by design) —
				// never rewrite them, or tool-call history/ordering is corrupted.
				outputLines.push(raw);
				continue;
			}
		}

		const text = effectiveText(message.content);
		if (text.trim() !== "") {
			outputLines.push(raw); // already valid — leave byte-identical
			continue;
		}

		entry.message.content = rewriteBlankUserContent(message.content);
		outputLines.push(JSON.stringify(entry));
		changed = true;
		rewritten++;
	}

	if (!changed) return emptySanitizeResult(content);
	return {
		content: outputLines.join("\n"),
		changed: true,
		rewritten,
		droppedToolResultRows,
		filteredToolResultBlocks,
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
		return emptySanitizeResult(content);
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

function emptySanitizeResult(content: string): SanitizeResult {
	return { content, changed: false, rewritten: 0, droppedToolResultRows: 0, filteredToolResultBlocks: 0 };
}

function transformTranscriptJsonl(
	content: string,
	mutateEntry: (entry: any) => boolean,
): SanitizeResult {
	if (!content) return emptySanitizeResult(content);

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

	if (!changed) return emptySanitizeResult(content);
	return { content: lines.join("\n"), changed: true, rewritten, droppedToolResultRows: 0, filteredToolResultBlocks: 0 };
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

const trustedExactSessionFiles = new Set<string>();

function isWithinTrustedSessionsRoot(hostPath: string): boolean {
	if (!hostPath || hasTraversalSegment(hostPath)) return false;
	const resolved = path.resolve(hostPath);
	return trustedAgentSessionsRoots().some(root => isStrictlyInside(path.resolve(root), resolved));
}

/**
 * Trust an exact persisted absolute `agentSessionFile` path for read-only
 * compatibility after agent-dir migrations. Paths outside trusted sessions roots
 * are accepted only when they already point at a regular, non-symlink `.jsonl`
 * with recognizable transcript content; they never become sanitizer write or
 * purge-delete targets.
 */
export function trustPersistedAgentSessionFile(filePath: string | null | undefined): void {
	const rootSafe = resolveSafeSessionsPath(filePath ?? "");
	if (rootSafe) {
		trustedExactSessionFiles.add(normalizeComparablePath(rootSafe));
		return;
	}
	const readable = validateReadableOutsideTranscriptFile(filePath);
	if (!readable) return;
	trustedExactSessionFiles.add(normalizeComparablePath(readable));
}

function isTrustedExactSessionFile(filePath: string): boolean {
	return trustedExactSessionFiles.has(normalizeComparablePath(filePath));
}

export function resolveReadablePersistedAgentSessionFile(filePath: string | null | undefined): string | null {
	if (!filePath || hasTraversalSegment(filePath)) return null;
	if (!path.isAbsolute(filePath) && !/^[A-Za-z]:[\\/]/.test(filePath)) return null;
	const rootSafe = resolveSafeSessionsPath(filePath);
	if (rootSafe) return rootSafe;
	const realPath = realpathRegularJsonlFile(path.resolve(filePath));
	if (!realPath || !isTrustedExactSessionFile(realPath)) return null;
	return realPath;
}

// Single source of truth for host-vs-container agentSessionFile path-trust
// classification. session-manager.ts and session-transcripts.ts import these;
// never reintroduce local copies at call sites — two copies of path-trust
// logic will drift.
function isWindowsAbsolutePath(filePath: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(filePath);
}

function isContainerAgentSessionPath(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	return normalized === "/home/node/.bobbit/agent/sessions"
		|| normalized.startsWith("/home/node/.bobbit/agent/sessions/")
		|| normalized === "/bobbit-state/sessions"
		|| normalized.startsWith("/bobbit-state/sessions/");
}

export function isHostAbsoluteAgentSessionPath(filePath: string | undefined): boolean {
	if (!filePath || isContainerAgentSessionPath(filePath)) return false;
	return path.isAbsolute(filePath) || isWindowsAbsolutePath(filePath);
}

export function safePersistedHostAgentSessionFile(filePath: string | undefined): string | null {
	if (!filePath) return null;
	if (!isHostAbsoluteAgentSessionPath(filePath)) return filePath;
	trustPersistedAgentSessionFile(filePath);
	return resolveReadablePersistedAgentSessionFile(filePath);
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
export function isWithinAgentSessionsDir(hostPath: string): boolean {
	if (!hostPath || hasTraversalSegment(hostPath)) return false;
	const resolved = path.resolve(hostPath);
	if (isTrustedExactSessionFile(resolved)) return true;
	return isWithinTrustedSessionsRoot(resolved);
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
export function resolveSafeSessionsPath(hostPath: string): string | null {
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
	for (const root of trustedAgentSessionsRoots()) {
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
 * @returns the number of transcript repairs performed (0 when nothing changed).
 */
export async function sanitizeAgentTranscriptFile(
	ctx: SessionFsContext,
	filePath: string,
	sandboxManager: SandboxManager | null,
): Promise<number> {
	return transformAgentTranscriptFile(
		ctx,
		filePath,
		sandboxManager,
		sanitizeTranscriptContent,
		"sanitize",
		(file, result) => {
			const parts: string[] = [];
			if (result.rewritten) parts.push(`un-poisoned ${result.rewritten} blank-text user message(s)`);
			if (result.droppedToolResultRows) parts.push(`dropped ${result.droppedToolResultRows} orphan tool result row(s)`);
			if (result.filteredToolResultBlocks) parts.push(`filtered ${result.filteredToolResultBlocks} orphan tool result block(s)`);
			return `${parts.join(", ")} in ${file}`;
		},
		(result) => result.rewritten + result.droppedToolResultRows + result.filteredToolResultBlocks,
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
): Promise<number> {
	return transformAgentTranscriptFile(
		ctx,
		filePath,
		sandboxManager,
		(content) => rebaseTranscriptCwdMetadataContent(content, options),
		"cwd metadata rebase",
		(file, result) => `Rebased ${result.rewritten} runtime cwd metadata record(s) in ${file}`,
	);
}

async function transformAgentTranscriptFile(
	ctx: SessionFsContext,
	filePath: string,
	sandboxManager: SandboxManager | null,
	transform: (content: string) => SanitizeResult,
	operation: string,
	logMessage: (filePath: string, result: SanitizeResult) => string,
	returnCount: (result: SanitizeResult) => number = (result) => result.rewritten,
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
			writableRealPath = resolveSafeSessionsPath(hostPath);
			readAllowed = writableRealPath !== null || resolveReadablePersistedAgentSessionFile(hostPath) !== null;
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
		const realPath = writableRealPath ?? resolveSafeSessionsPath(hostPath);
		if (realPath === null) {
			console.warn(`[transcript-sanitizer] Refusing to write outside agent sessions dir: ${hostPath} (from ${filePath})`);
			return 0;
		}

		writeFileNoFollow(realPath, result.content);
		console.log(`[transcript-sanitizer] ${logMessage(filePath, result)}`);
		return returnCount(result);
	} catch (err) {
		console.warn(`[transcript-sanitizer] Failed to ${operation} ${filePath} (non-fatal):`, err);
		return 0;
	}
}
