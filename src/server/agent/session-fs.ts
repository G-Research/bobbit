/**
 * Session-aware filesystem operations.
 *
 * Routes file operations to the correct filesystem based on whether the
 * session is sandboxed (Docker) or local. Paths are always in the agent's
 * coordinate system — container paths for sandbox, host paths for non-sandbox.
 *
 * For sandboxed sessions, operations go through `docker exec` when the
 * container is available, with a bind-mount fallback for archived sessions
 * whose containers may be stopped.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import type { SandboxManager } from "./sandbox-manager.js";
import {
	containerTranscriptRelativePath,
	ensurePrivateSessionRoot,
	sessionTranscriptRoot,
} from "./agent-session-path.js";
import { sidecarPathFor } from "./session-sidecar.js";

type SessionDeleteFs = Pick<typeof fs.promises, "unlink">;

/**
 * Thrown by `sessionFileCopy` when the (src, dst) sandbox/project realms
 * differ in a way the helper does not currently support. Callers should
 * map this to HTTP 422 (`{error: "cross-realm continue not supported"}`).
 */
export class CrossRealmCopyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CrossRealmCopyError";
	}
}

/**
 * Context describing the session's sandbox state and project affiliation.
 */
export interface SessionFsContext {
	sandboxed?: boolean;
	projectId?: string;
	/** Trusted Bobbit owner identity; mandatory for sandbox transcript paths. */
	sessionId?: string;
}

function isWindowsAbsolutePath(filePath: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(filePath);
}

function isContainerAgentSessionPath(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	return normalized === "/home/node/.bobbit/agent/sessions"
		|| normalized.startsWith("/home/node/.bobbit/agent/sessions/");
}

export function canonicalContainerAgentSessionPath(filePath: string): string | null {
	if (!filePath || filePath.includes("\0") || filePath.includes("\\")) return null;
	const normalized = path.posix.normalize(filePath);
	if (normalized !== filePath || !isContainerAgentSessionPath(normalized)) return null;
	return normalized;
}

function isHostAbsoluteAgentSessionPath(filePath: string | undefined): boolean {
	if (!filePath || isContainerAgentSessionPath(filePath)) return false;
	return path.isAbsolute(filePath) || isWindowsAbsolutePath(filePath);
}

export function sessionFsContextForAgentFile(
	ps: Pick<SessionFsContext, "sandboxed" | "projectId" | "sessionId"> & { id?: string },
	filePath: string | undefined,
): SessionFsContext {
	return {
		sandboxed: !!ps.sandboxed && !isHostAbsoluteAgentSessionPath(filePath),
		projectId: ps.projectId,
		sessionId: ps.sessionId ?? ps.id,
	};
}

function ownedHostPath(ctx: SessionFsContext, filePath: string, createParents = false): string {
	if (!ctx.sandboxed || !ctx.sessionId) throw new CrossRealmCopyError("sandbox transcript owner is unavailable");
	const relative = containerTranscriptRelativePath(filePath);
	if (!relative) throw new CrossRealmCopyError("sandbox transcript path is invalid");
	const sharedRoot = path.dirname(path.dirname(sessionTranscriptRoot(ctx.sessionId)));
	const root = ensurePrivateSessionRoot(sessionTranscriptRoot(ctx.sessionId), sharedRoot);
	const parts = relative.split("/");
	let cursor = root;
	for (const part of parts.slice(0, -1)) {
		cursor = path.join(cursor, part);
		try {
			const stat = fs.lstatSync(cursor);
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CrossRealmCopyError("sandbox transcript parent is unsafe");
		} catch (error: any) {
			if (error?.code !== "ENOENT" || !createParents) throw error;
			fs.mkdirSync(cursor, { mode: 0o700 });
			const created = fs.lstatSync(cursor);
			if (!created.isDirectory() || created.isSymbolicLink()) throw new CrossRealmCopyError("sandbox transcript parent creation was replaced");
		}
	}
	return path.join(root, ...parts);
}

function safeOwnedRegularFile(filePath: string): boolean {
	try {
		const stat = fs.lstatSync(filePath);
		return stat.isFile() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Check whether a file exists at the given path.
 *
 * For sandboxed sessions, tries `docker exec test -f` first. If the container
 * is unavailable (stopped/archived), falls back to translating the container
 * path to a host path via the known bind-mount table.
 *
 * For non-sandboxed sessions, checks the host filesystem directly.
 *
 * @param ctx - Session context (sandboxed flag and project ID)
 * @param filePath - Path in the agent's coordinate system
 * @param sandboxManager - Sandbox manager instance (may be null)
 * @returns true if the file exists
 */
export async function sessionFileExists(
	ctx: SessionFsContext,
	filePath: string,
	_sandboxManager: SandboxManager | null,
): Promise<boolean> {
	if (!ctx.sandboxed) return fs.existsSync(filePath);
	try { return safeOwnedRegularFile(ownedHostPath(ctx, filePath)); }
	catch { return false; }
}

/**
 * Read a file's contents as a UTF-8 string.
 *
 * For sandboxed sessions, tries `docker exec cat` first. If the container
 * is unavailable, falls back to reading from the host via bind-mount
 * path translation.
 *
 * For non-sandboxed sessions, reads from the host filesystem directly.
 *
 * @param ctx - Session context (sandboxed flag and project ID)
 * @param filePath - Path in the agent's coordinate system
 * @param sandboxManager - Sandbox manager instance (may be null)
 * @returns File contents, or null if the file doesn't exist or can't be read
 */
export async function sessionFileRead(
	ctx: SessionFsContext,
	filePath: string,
	_sandboxManager: SandboxManager | null,
): Promise<string | null> {
	if (!ctx.sandboxed) {
		try { return fs.readFileSync(filePath, "utf-8"); }
		catch { return null; }
	}
	try {
		const hostPath = ownedHostPath(ctx, filePath);
		return safeOwnedRegularFile(hostPath) ? fs.readFileSync(hostPath, "utf-8") : null;
	} catch { return null; }
}

/**
 * Atomically publish generated session-file content in the destination's own
 * filesystem realm. Sandbox targets are published entirely inside the live
 * container: the host owns only an exclusive flat staging file under the
 * trusted sessions root, while fixed Node code copies and renames in-container.
 */
export async function sessionFileWriteAtomic(
	ctx: SessionFsContext,
	filePath: string,
	content: string,
	_sandboxManager: SandboxManager | null,
): Promise<void> {
	if (ctx.sandboxed) {
		filePath = ownedHostPath(ctx, filePath, true);
	}

	const directory = path.dirname(filePath);
	await fs.promises.mkdir(directory, { recursive: true });
	const temporaryPath = path.join(
		directory,
		`.${path.basename(filePath)}.bobbit-stage-${process.pid}-${randomUUID()}.tmp`,
	);
	let handle: FileHandle | undefined;
	let temporaryCreated = false;
	try {
		handle = await fs.promises.open(temporaryPath, "wx", 0o600);
		temporaryCreated = true;
		const stat = await handle.stat();
		if (!stat.isFile()) throw new Error("Session transcript staging entry is not a regular file");
		await handle.writeFile(content, { encoding: "utf-8" });
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fs.promises.rename(temporaryPath, filePath);
		temporaryCreated = false;
	} finally {
		if (handle) {
			try { await handle.close(); } catch { /* retain the primary staging failure */ }
		}
		if (temporaryCreated) {
			try { await fs.promises.unlink(temporaryPath); } catch { /* remove only this invocation's exclusive temp */ }
		}
	}
}

/** Atomically move a transcript within one owner root. */
export async function sessionFileRenameAtomic(
	ctx: SessionFsContext,
	sourcePath: string,
	targetPath: string,
	_sandboxManager: SandboxManager | null,
): Promise<void> {
	if (!ctx.sandboxed) throw new CrossRealmCopyError("cross-realm session rename not supported");
	const source = ownedHostPath(ctx, sourcePath);
	const target = ownedHostPath(ctx, targetPath, true);
	if (!safeOwnedRegularFile(source)) throw new Error("Session transcript source is unavailable");
	await fs.promises.rename(source, target);
}

/**
 * Delete only through a live container. This intentionally has no host-path
 * translation fallback: an unavailable sandbox leaves an orphan for trusted
 * maintenance rather than turning an attacker-influenced path into host I/O.
 */
export async function sessionFileDeleteContainerOnly(
	ctx: SessionFsContext,
	filePath: string,
	_sandboxManager: SandboxManager | null,
): Promise<boolean> {
	if (!ctx.sandboxed) return false;
	try {
		const target = ownedHostPath(ctx, filePath);
		if (fs.existsSync(target) && !safeOwnedRegularFile(target)) return false;
		await fs.promises.unlink(target).catch((error: any) => { if (error?.code !== "ENOENT") throw error; });
		return true;
	} catch {
		return false;
	}
}

/**
 * Copy a file from `srcPath` to `dstPath`, dispatched on whether the source
 * and destination sessions are sandboxed.
 *
 *   src \ dst | non-sandboxed                 | sandboxed (same project)
 *   ──────────┼───────────────────────────────┼──────────────────────────
 *   non-sb    | host fs.copyFileSync          | CrossRealmCopyError
 *   sandboxed | CrossRealmCopyError           | docker exec cp
 *
 * Cross-realm and cross-project copies throw `CrossRealmCopyError`. Same-
 * realm copies create the destination directory (host-side or via
 * `docker exec mkdir -p`) before copying.
 */
export async function sessionFileCopy(
	srcCtx: SessionFsContext,
	srcPath: string,
	dstCtx: SessionFsContext,
	dstPath: string,
	_sandboxManager: SandboxManager | null,
	fsImpl: Pick<typeof fs, "mkdirSync" | "copyFileSync"> = fs,
): Promise<void> {
	const srcSandboxed = !!srcCtx.sandboxed;
	const dstSandboxed = !!dstCtx.sandboxed;

	if (!srcSandboxed && !dstSandboxed) {
		// Host → host
		const dir = path.dirname(dstPath);
		fsImpl.mkdirSync(dir, { recursive: true });
		fsImpl.copyFileSync(srcPath, dstPath);
		return;
	}

	if (srcSandboxed && dstSandboxed) {
		if (!srcCtx.projectId || !dstCtx.projectId || srcCtx.projectId !== dstCtx.projectId) {
			throw new CrossRealmCopyError("cross-realm continue not supported");
		}
		const source = ownedHostPath(srcCtx, srcPath);
		const destination = ownedHostPath(dstCtx, dstPath, true);
		if (!safeOwnedRegularFile(source)) throw new Error("Session transcript source is unavailable");
		fsImpl.copyFileSync(source, destination);
		return;
	}

	// Cross-realm (host↔sandbox) — not supported today.
	throw new CrossRealmCopyError("cross-realm continue not supported");
}

/**
 * Delete a file at the given path.
 *
 * For sandboxed sessions, tries `docker exec rm` first. If the container
 * is unavailable, falls back to deleting from the host via bind-mount
 * path translation.
 *
 * For non-sandboxed sessions, deletes from the host filesystem directly.
 *
 * @param ctx - Session context (sandboxed flag and project ID)
 * @param filePath - Path in the agent's coordinate system
 * @param sandboxManager - Sandbox manager instance (may be null)
 * @returns true if the file was deleted (or didn't exist), false on error
 */
export async function sessionFileDelete(
	ctx: SessionFsContext,
	filePath: string,
	_sandboxManager: SandboxManager | null,
	fsImpl: SessionDeleteFs = fs.promises,
): Promise<boolean> {
	if (!ctx.sandboxed) {
		try {
			await fsImpl.unlink(filePath);
			return true;
		} catch (err: any) {
			return err?.code === "ENOENT";
		}
	}
	try {
		const target = ownedHostPath(ctx, filePath);
		if (fs.existsSync(target) && !safeOwnedRegularFile(target)) return false;
		await fsImpl.unlink(target);
		return true;
	} catch (error: any) {
		return error?.code === "ENOENT";
	}
}

/**
 * Delete the Bobbit-owned metadata sidecar for a trusted transcript path.
 *
 * The caller remains responsible for applying the transcript trust boundary
 * before passing `jsonlPath`; deriving the target here guarantees cleanup can
 * only reach the sidecar adjacent to that already-approved transcript. Missing
 * sidecars are an idempotent success.
 */
export async function sessionSidecarDelete(
	jsonlPath: string,
	fsImpl: SessionDeleteFs = fs.promises,
): Promise<void> {
	try {
		await fsImpl.unlink(sidecarPathFor(jsonlPath));
	} catch (err: any) {
		if (err?.code !== "ENOENT") throw err;
	}
}
