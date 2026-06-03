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
 * This module is a pure, idempotent, one-pass sanitizer: it rewrites ANY
 * persisted `user` message whose effective text is blank/whitespace-only to the
 * synthetic `ATTACHMENT_ONLY_TEXT` ("Attachments:"), covering BOTH the
 * image-adjacent case (`[{text:""},{image}]`) AND the standalone empty/blank
 * user message produced by a non-image attachment-only send (`[{text:""}]`, or
 * a user message with only non-text content / no text block at all). It leaves
 * every other line byte-identical, so re-running it is a no-op.
 */

import { ATTACHMENT_ONLY_TEXT } from "./rpc-bridge.js";
import { sessionFileRead, type SessionFsContext } from "./session-fs.js";
import { containerPathToHost } from "./rpc-bridge.js";
import type { SandboxManager } from "./sandbox-manager.js";
import fs from "node:fs";

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
		const content = await sessionFileRead(ctx, filePath, sandboxManager);
		if (content === null || content === undefined || content === "") return 0;

		const result = sanitizeTranscriptContent(content);
		if (!result.changed) return 0;

		// Resolve the host-side path to write. Non-sandboxed: filePath is already
		// a host path. Sandboxed: translate container path → host path (the agent
		// sessions dir is bind-mounted, so the container sees the write).
		const hostPath = ctx.sandboxed ? containerPathToHost(filePath) : filePath;
		fs.writeFileSync(hostPath, result.content, "utf-8");
		console.log(
			`[transcript-sanitizer] Un-poisoned ${result.rewritten} blank-text user message(s) in ${filePath}`,
		);
		return result.rewritten;
	} catch (err) {
		console.warn(`[transcript-sanitizer] Failed to sanitize ${filePath} (non-fatal):`, err);
		return 0;
	}
}
