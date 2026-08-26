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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
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

const SESSION_ROOT_NAMESPACE = ".bobbit-session-roots-v1";
const SESSION_ROOT_DOMAIN = "bobbit-session-transcript-root-v1\0";

function trustedSessionId(sessionId: string): string {
	if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 256 || sessionId.includes("\0")) {
		throw new Error("Invalid server session identity");
	}
	return sessionId;
}

/** Filename-inert, domain-separated storage identity for one Bobbit session. */
export function sessionTranscriptStorageKey(sessionId: string): string {
	return createHash("sha256").update(SESSION_ROOT_DOMAIN).update(trustedSessionId(sessionId)).digest("hex");
}

/** Durable host transcript root visible only to one session execution runtime. */
export function sessionTranscriptRoot(sessionId: string, sessionsRoot = activeAgentSessionsDir()): string {
	return path.join(sessionsRoot, SESSION_ROOT_NAMESPACE, sessionTranscriptStorageKey(sessionId));
}

/** Private analogue of the legacy shared `/bobbit-state/sessions` bind. */
export function sessionStateSessionsRoot(stateDir: string, sessionId: string): string {
	if (!path.isAbsolute(stateDir) || stateDir.includes("\0")) throw new Error("Invalid state directory");
	return path.join(stateDir, "sessions", SESSION_ROOT_NAMESPACE, sessionTranscriptStorageKey(sessionId));
}

/** Create a private root without following a pre-existing namespace/root link. */
export function ensurePrivateSessionRoot(root: string, trustedParent: string): string {
	const parent = path.resolve(trustedParent);
	const target = path.resolve(root);
	const relative = path.relative(parent, target);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Private session root escapes its trusted parent");
	fs.mkdirSync(parent, { recursive: true });
	let cursor = parent;
	for (const component of relative.split(path.sep)) {
		cursor = path.join(cursor, component);
		try {
			const stat = fs.lstatSync(cursor);
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Private session root contains an unsafe filesystem entry");
		} catch (error: any) {
			if (error?.code !== "ENOENT") throw error;
			fs.mkdirSync(cursor, { mode: 0o700 });
			const created = fs.lstatSync(cursor);
			if (!created.isDirectory() || created.isSymbolicLink()) throw new Error("Private session root creation was replaced");
		}
	}
	return target;
}

const CONTAINER_AGENT_SESSIONS_DIR = "/home/node/.bobbit/agent/sessions";

/** Canonical path relative to Pi's primary sessions coordinate. */
export function containerTranscriptRelativePath(filePath: string): string | null {
	if (!filePath || filePath.includes("\0") || filePath.includes("\\")) return null;
	const normalized = path.posix.normalize(filePath);
	if (normalized !== filePath || normalized === CONTAINER_AGENT_SESSIONS_DIR) return null;
	if (!normalized.startsWith(`${CONTAINER_AGENT_SESSIONS_DIR}/`)) return null;
	const relative = normalized.slice(CONTAINER_AGENT_SESSIONS_DIR.length + 1);
	return relative && !relative.startsWith("../") ? relative : null;
}

/** Translate one canonical Pi coordinate using its trusted Bobbit owner. */
export function sessionTranscriptHostPath(sessionId: string, filePath: string, sessionsRoot = activeAgentSessionsDir()): string | null {
	const relative = containerTranscriptRelativePath(filePath);
	if (!relative) return null;
	return path.join(sessionTranscriptRoot(sessionId, sessionsRoot), ...relative.split("/"));
}

export function sessionTranscriptContainerPath(relativePath: string): string | null {
	if (!relativePath || relativePath.includes("\0") || relativePath.includes("\\") || path.posix.isAbsolute(relativePath)) return null;
	const normalized = path.posix.normalize(relativePath);
	if (normalized !== relativePath || normalized.startsWith("../")) return null;
	return `${CONTAINER_AGENT_SESSIONS_DIR}/${normalized}`;
}

/** Owner roots corresponding to every trusted active/historical sessions root. */
export function trustedSessionTranscriptRoots(sessionId: string): string[] {
	return trustedAgentSessionsRoots().map(root => sessionTranscriptRoot(sessionId, root));
}

function currentHomeDir(): string {
	// Node may cache os.homedir() for the process lifetime. Read the platform's
	// home override directly so a gateway launched with an explicit home (and
	// shared-fork tests that scope one) resolves the matching legacy roots.
	const envHome = process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
	return envHome?.trim() ? path.resolve(envHome) : os.homedir();
}

/** Known legacy agent dirs that may still contain recoverable transcripts. */
export function legacyAgentDirs(): string[] {
	const homeDir = currentHomeDir();
	return [
		path.join(homeDir, ".bobbit", "agent"),
		path.join(homeDir, ".pi", "agent"),
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

function relativePathInside(root: string, candidate: string): string | null {
	const relative = path.relative(normalizeHostPath(root), normalizeHostPath(candidate));
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
	return relative;
}

/**
 * If `hostSessionFile` points at an old/historical agent sessions root and the
 * same relative transcript exists under the active sessions root, return that
 * active host path. Sandboxed agents can only see the active sessions mount, but
 * Bobbit keeps the persisted historical path authoritative for host-side reads.
 */
export function migratedActiveAgentSessionFileForHostPath(hostSessionFile: string): string | null {
	const activeRoot = activeAgentSessionsDir();
	for (const historicalRoot of trustedAgentSessionsRoots()) {
		if (normalizeHostPath(historicalRoot) === normalizeHostPath(activeRoot)) continue;
		const relative = relativePathInside(historicalRoot, hostSessionFile);
		if (!relative) continue;
		const activeCandidate = path.join(activeRoot, relative);
		try {
			if (fs.lstatSync(activeCandidate).isFile()) return activeCandidate.replace(/\\/g, "/");
		} catch {
			return null;
		}
	}
	return null;
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

/** Canonical Pi coordinate for a generation owned by one sandbox session. */
export function formatOwnedAgentSessionFilePath(cwd: string, createdAtMs: number, transcriptId: string): string {
	const relative = `--${slugifyCwd(cwd)}--/${formatAgentTimestamp(createdAtMs)}_${transcriptId}.jsonl`;
	const result = sessionTranscriptContainerPath(relative);
	if (!result) throw new Error("Could not format owner-scoped agent session path");
	return result;
}
