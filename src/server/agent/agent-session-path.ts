/**
 * Helpers for the agent CLI's `.jsonl` session file naming convention.
 *
 * The agent CLI writes sessions to:
 *   <globalAgentDir()>/sessions/--<cwd-slug>--/<isoTs>_<uuid>.jsonl
 *
 * where:
 *   - cwd-slug = cwd.replace(/[^a-zA-Z0-9]/g, "-")
 *   - isoTs    = new Date().toISOString().replace(/[:.]/g, "-")
 *               (e.g. 2026-04-03T15-15-12-009Z)
 *
 * Both this formatter and the parser in `session-manager.ts::recoverSessionFile`
 * must agree on the exact format. See the parser regex
 * `^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)` for round-trip verification.
 */

import path from "node:path";
import { globalAgentDir } from "../bobbit-dir.js";

/** Slugify a cwd for use as the agent CLI sessions-dir component. */
export function slugifyCwd(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Format an iso-timestamp the way the agent CLI does: replace `:` and `.`
 * with `-` so the timestamp is filesystem-safe (Windows rejects `:`).
 */
export function formatAgentTimestamp(createdAtMs: number): string {
	return new Date(createdAtMs).toISOString().replace(/[:.]/g, "-");
}

/**
 * Build the absolute `.jsonl` path the agent CLI would produce for a session
 * with the given `cwd`, creation time, and uuid. Returns a forward-slash-only
 * path so it round-trips through container paths.
 */
export function formatAgentSessionFilePath(
	cwd: string,
	createdAtMs: number,
	sessionId: string,
): string {
	const sessionsDir = path.join(globalAgentDir(), "sessions");
	const cwdDir = path.join(sessionsDir, `--${slugifyCwd(cwd)}--`);
	const ts = formatAgentTimestamp(createdAtMs);
	return path.join(cwdDir, `${ts}_${sessionId}.jsonl`).replace(/\\/g, "/");
}
