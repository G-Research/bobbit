/**
 * Transcript sanitizer — un-poison persisted agent `.jsonl` transcripts whose
 * `user` messages carry a blank text body.
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
import { globalAgentDir } from "../bobbit-dir.js";
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

/** Result of a content-string sanitize pass. */
export interface SanitizeResult {
	/** The (possibly unchanged) JSONL content. */
	content: string;
	/** Whether any line was rewritten. */
	changed: boolean;
	/** Number of user messages rewritten. */
	rewritten: number;
}

/**
 * Sanitize raw `.jsonl` content. Pure — no I/O. Rewrites blank-text `user`
 * messages in place, preserving every other line byte-for-byte (including the
 * original trailing-newline shape). Idempotent: re-running on sanitized output
 * yields `changed:false`.
 */
export function sanitizeTranscriptContent(content: string): SanitizeResult {
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
		if (!entry || entry.type !== "message" || !entry.message) continue;
		if (entry.message.role !== "user") continue;

		// Tool-result user messages are valid history (no text by design) —
		// never touch them, or tool-call history/ordering is corrupted.
		if (hasToolResultBlock(entry.message.content)) continue;

		const text = effectiveText(entry.message.content);
		if (text.trim() !== "") continue; // already valid — leave byte-identical

		entry.message.content = rewriteBlankUserContent(entry.message.content);
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

/**
 * Lexical-only guard kept for callers/tests that want a cheap prefix check:
 * a transcript path is acceptable iff it has no `..` segment and resolves
 * (lexically) strictly inside `globalAgentDir()/sessions`. Does NOT touch the
 * filesystem — see `resolveSafeSessionsPath` for the symlink/TOCTOU-resistant
 * variant used on the real I/O path.
 */
export function isWithinAgentSessionsDir(hostPath: string): boolean {
	if (!hostPath) return false;
	const segments = hostPath.replace(/\\/g, "/").split("/");
	if (segments.includes("..")) return false;

	const sessionsRoot = path.resolve(globalAgentDir(), "sessions");
	const resolved = path.resolve(hostPath);
	const rel = path.relative(sessionsRoot, resolved);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Symlink/TOCTOU-resistant resolver for a transcript path that the sanitizer
 * is about to read from / write to on the HOST filesystem.
 *
 * Rejects (returns `null`) when the path:
 *  - is empty or contains a `..` traversal segment;
 *  - has a parent directory that doesn't exist or, after `realpathSync`
 *    (which follows directory symlinks), is NOT inside the real sessions root
 *    (`realpath(globalAgentDir()/sessions)`);
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

	let sessionsRootReal: string;
	try {
		sessionsRootReal = fs.realpathSync(path.resolve(globalAgentDir(), "sessions"));
	} catch {
		return null; // no sessions root → nothing legitimate to sanitize
	}

	const resolved = path.resolve(hostPath);
	const parent = path.dirname(resolved);
	let parentReal: string;
	try {
		parentReal = fs.realpathSync(parent); // follows directory symlinks
	} catch {
		return null; // parent missing/unreadable
	}

	// The real parent must be the sessions root or nested inside it.
	if (!isInsideOrEqual(sessionsRootReal, parentReal)) return null;

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
 * @returns the number of user messages rewritten (0 when nothing changed).
 */
export async function sanitizeAgentTranscriptFile(
	ctx: SessionFsContext,
	filePath: string,
	sandboxManager: SandboxManager | null,
): Promise<number> {
	try {
		// Resolve the host-side path. Non-sandboxed: filePath is already a host
		// path and is what the read+write both touch. Sandboxed: the read runs
		// in-container (docker exec); only the write is host-side, via the
		// bind-mounted sessions dir (container path → host path).
		const hostPath = ctx.sandboxed ? containerPathToHost(filePath) : filePath;

		// For non-sandboxed sessions, validate the real host path BEFORE reading
		// — a symlink/traversal/out-of-root path must trigger neither a read nor
		// a write. (For sandboxed, the read is in-container; the write below is
		// still validated.)
		if (!ctx.sandboxed && resolveSafeSessionsPath(hostPath) === null) {
			console.warn(`[transcript-sanitizer] Refusing to access path outside agent sessions dir: ${hostPath} (from ${filePath})`);
			return 0;
		}

		const content = await sessionFileRead(ctx, filePath, sandboxManager);
		if (content === null || content === undefined || content === "") return 0;

		const result = sanitizeTranscriptContent(content);
		if (!result.changed) return 0;

		// Re-resolve + re-validate the real path immediately before writing
		// (TOCTOU) and write with O_NOFOLLOW so a symlink swapped in after the
		// check is not followed. A malformed/hostile agentSessionFile must never
		// let us clobber an arbitrary file.
		const realPath = resolveSafeSessionsPath(hostPath);
		if (realPath === null) {
			console.warn(`[transcript-sanitizer] Refusing to write outside agent sessions dir: ${hostPath} (from ${filePath})`);
			return 0;
		}

		writeFileNoFollow(realPath, result.content);
		console.log(
			`[transcript-sanitizer] Un-poisoned ${result.rewritten} blank-text user message(s) in ${filePath}`,
		);
		return result.rewritten;
	} catch (err) {
		console.warn(`[transcript-sanitizer] Failed to sanitize ${filePath} (non-fatal):`, err);
		return 0;
	}
}
