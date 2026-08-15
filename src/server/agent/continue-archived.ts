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
import { purgeAuthorSidecar } from "./author-sidecar.js";
import { purgeCompactionSidecar } from "./compaction-sidecar.js";
import { sidecarPathFor } from "./session-sidecar.js";
import { purgeSkillSidecar } from "../skills/skill-sidecar.js";

type ContinueArchivedFs = Pick<typeof fs, "existsSync" | "mkdirSync" | "cpSync" | "unlinkSync" | "rmSync">;

/**
 * Recursively copy `<stateDir>/tool-content/<srcId>/` to
 * `<stateDir>/tool-content/<dstId>/` if the source directory exists.
 * Silent no-op when absent.
 */
export function copyToolContentDirIfPresent(
	srcId: string,
	dstId: string,
	stateDir: string,
	fsImpl: ContinueArchivedFs = fs,
): void {
	const src = path.join(stateDir, "tool-content", srcId);
	if (!fsImpl.existsSync(src)) return;
	const dst = path.join(stateDir, "tool-content", dstId);
	fsImpl.mkdirSync(dst, { recursive: true });
	fsImpl.cpSync(src, dst, { recursive: true });
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
export function copyProposalDirIfPresent(
	srcId: string,
	dstId: string,
	stateDir: string,
	fsImpl: ContinueArchivedFs = fs,
): void {
	const src = path.join(stateDir, "proposal-drafts", srcId);
	if (!fsImpl.existsSync(src)) return;
	const dst = path.join(stateDir, "proposal-drafts", dstId);
	fsImpl.mkdirSync(dst, { recursive: true });
	fsImpl.cpSync(src, dst, { recursive: true });
}

/**
 * Best-effort cleanup after a failed continue or fork flow. Only destination
 * artifacts are removed; source transcript/worktree state is never touched.
 */
export function cleanupFailedContinue(
	destPath: string | undefined,
	newSessionId: string,
	stateDir: string,
	fsImpl: ContinueArchivedFs = fs,
): void {
	if (destPath) {
		try { fsImpl.unlinkSync(destPath); } catch { /* may be absent */ }
		try { fsImpl.unlinkSync(sidecarPathFor(destPath)); } catch { /* may be absent */ }
	}
	for (const artifactDir of ["tool-content", "proposal-drafts"]) {
		try {
			const dir = path.join(stateDir, artifactDir, newSessionId);
			if (fsImpl.existsSync(dir)) fsImpl.rmSync(dir, { recursive: true, force: true });
		} catch { /* best-effort */ }
	}

	// Skill and compaction sidecars live in stateDir. Remove them directly so
	// injected cleanup filesystems and partially initialized servers are covered,
	// then invoke their canonical purge helpers for configured-directory parity.
	const safeId = newSessionId.replace(/[^A-Za-z0-9_-]/g, "_");
	for (const artifactFile of [
		path.join(stateDir, "skill-sidecar", `${safeId}.jsonl`),
		path.join(stateDir, "compaction-sidecar", `${safeId}.jsonl`),
	]) {
		try { fsImpl.unlinkSync(artifactFile); } catch { /* may be absent */ }
	}
	purgeAuthorSidecar(newSessionId);
	purgeSkillSidecar(newSessionId);
	purgeCompactionSidecar(newSessionId);
}
