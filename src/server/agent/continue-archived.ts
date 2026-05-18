/**
 * Continue-Archived helpers.
 *
 * The new lossless flow clones the source session's `.jsonl` into the new
 * session's slot and lets the agent CLI rehydrate from it. No transcript
 * stringification, no system-prompt seeding, no byte budget. The only piece
 * of supporting infrastructure that lives in this module is the defensive
 * tool-content directory copy below.
 *
 * Block IDs in the JSONL are message-index/block-index pairs (parsed by
 * `GET /api/sessions/:id/tool-content/:mi/:bi`), so a straight directory
 * copy is sufficient — no ID rewriting needed.
 *
 * Today there is no on-disk `<stateDir>/tool-content/<sessionId>/` cache
 * (truncation is wire-only and the GET endpoint resolves blocks from the
 * live JSONL), so this helper is a no-op in practice. It is kept as a
 * forward-compat hook so any future on-disk cache lands lossless without
 * code changes.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Recursively copy `<stateDir>/tool-content/<srcId>/` to
 * `<stateDir>/tool-content/<dstId>/` if the source directory exists.
 * Silent no-op when absent.
 */
export function copyToolContentDirIfPresent(srcId: string, dstId: string, stateDir: string): void {
	const src = path.join(stateDir, "tool-content", srcId);
	if (!fs.existsSync(src)) return;
	const dst = path.join(stateDir, "tool-content", dstId);
	fs.mkdirSync(dst, { recursive: true });
	fs.cpSync(src, dst, { recursive: true });
}

/**
 * Recursively copy `<stateDir>/proposal-drafts/<srcId>/` to
 * `<stateDir>/proposal-drafts/<dstId>/` if the source directory exists.
 * Silent no-op when absent.
 *
 * Mirrors {@link copyToolContentDirIfPresent} but for the proposal-draft
 * directory layout owned by `proposal-files.ts` (live `<type>.{md,yaml}`
 * plus `<type>.history/<rev>.<ext>` snapshots). Schema-agnostic recursive
 * copy — the new session inherits the entire draft + history verbatim.
 */
export function copyProposalDirIfPresent(srcId: string, dstId: string, stateDir: string): void {
	const src = path.join(stateDir, "proposal-drafts", srcId);
	if (!fs.existsSync(src)) return;
	const dst = path.join(stateDir, "proposal-drafts", dstId);
	fs.mkdirSync(dst, { recursive: true });
	fs.cpSync(src, dst, { recursive: true });
}

/** Best-effort cleanup after a failed continue-archived flow. */
export function cleanupFailedContinue(destPath: string | undefined, newSessionId: string, stateDir: string): void {
	if (destPath) {
		try { fs.unlinkSync(destPath); } catch { /* may be absent */ }
	}
	try {
		const dir = path.join(stateDir, "tool-content", newSessionId);
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
	} catch { /* best-effort */ }
	try {
		const dir = path.join(stateDir, "proposal-drafts", newSessionId);
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
	} catch { /* best-effort */ }
}
