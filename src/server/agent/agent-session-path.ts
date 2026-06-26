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

import os from "node:os";
import path from "node:path";
import * as BobbitDir from "../bobbit-dir.js";

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

function normalizeHostPath(p: string): string {
	return path.resolve(p).replace(/[\\/]+$/, "");
}

function pushUniquePath(paths: string[], candidate: unknown): void {
	if (typeof candidate !== "string" || candidate.trim() === "") return;
	const normalized = normalizeHostPath(candidate);
	if (!paths.some(existing => existing === normalized)) paths.push(normalized);
}

function configuredAgentDirHistory(): string[] {
	try {
		const state = (BobbitDir as any).getAgentDirState?.();
		const dirs: string[] = [];
		pushUniquePath(dirs, state?.startup?.dir);
		pushUniquePath(dirs, (BobbitDir as any).defaultAgentDir?.());
		if (Array.isArray(state?.history)) {
			for (const dir of state.history) pushUniquePath(dirs, dir);
		}
		return dirs;
	} catch {
		return [];
	}
}

/** Active startup-resolved host sessions directory for new agent session files. */
export function activeAgentSessionsDir(): string {
	return path.join(BobbitDir.globalAgentDir(), "sessions");
}

/** Known legacy agent dirs that may still contain recoverable transcripts. */
export function legacyAgentDirs(): string[] {
	return [
		path.join(os.homedir(), ".bobbit", "agent"),
		path.join(os.homedir(), ".pi", "agent"),
	];
}

/** Ordered trusted host sessions roots: active first, then recorded history, then legacy defaults. */
export function trustedAgentSessionsRoots(): string[] {
	const roots: string[] = [];
	pushUniquePath(roots, activeAgentSessionsDir());
	for (const dir of configuredAgentDirHistory()) pushUniquePath(roots, path.join(dir, "sessions"));
	for (const dir of legacyAgentDirs()) pushUniquePath(roots, path.join(dir, "sessions"));
	return roots;
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
	const cwdDir = path.join(activeAgentSessionsDir(), `--${slugifyCwd(cwd)}--`);
	const ts = formatAgentTimestamp(createdAtMs);
	return path.join(cwdDir, `${ts}_${sessionId}.jsonl`).replace(/\\/g, "/");
}
