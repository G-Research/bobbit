/**
 * Session-aware filesystem operations.
 *
 * Routes file operations to the correct filesystem based on whether the
 * session is sandboxed (Docker) or local. Paths are always in the agent's
 * coordinate system — container paths for sandbox, host paths for non-sandbox.
 *
 * Sandboxed operations run only through the exact server-attested session
 * runtime. Archived/store-only sessions use a short-lived isolated runtime;
 * there is no host-path or project-control-container fallback.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import type { SandboxManager } from "./sandbox-manager.js";
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
	if (!filePath || /[\u0000-\u001f\u007f]/.test(filePath) || filePath.includes("\\")) return null;
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

function sandboxTranscriptAuthority(
	ctx: SessionFsContext,
	filePath: string,
	sandboxManager: SandboxManager | null,
): { projectId: string; sessionId: string; path: string; sandboxManager: SandboxManager } {
	const canonical = canonicalContainerAgentSessionPath(filePath);
	if (!ctx.projectId || !ctx.sessionId || !canonical || !sandboxManager) {
		throw new CrossRealmCopyError("sandbox transcript runtime authority is unavailable");
	}
	return { projectId: ctx.projectId, sessionId: ctx.sessionId, path: canonical, sandboxManager };
}

/**
 * Check whether a file exists at the given path.
 *
 * Sandboxed sessions use the exact attested session runtime and fail closed if
 * no isolated runtime can be established.
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
	sandboxManager: SandboxManager | null,
): Promise<boolean> {
	if (!ctx.sandboxed) {
		try { return (await fs.promises.lstat(filePath)).isFile(); }
		catch { return false; }
	}
	try {
		const authority = sandboxTranscriptAuthority(ctx, filePath, sandboxManager);
		return await authority.sandboxManager.runSessionTranscriptOperation(
			authority.projectId,
			authority.sessionId,
			{ kind: "exists", path: authority.path },
		) === true;
	} catch { return false; }
}

/**
 * Read a file's contents as a UTF-8 string.
 *
 * Sandboxed sessions use a bounded read inside the exact attested session
 * runtime; the gateway never resolves the sandbox-owned entry as a host path.
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
	sandboxManager: SandboxManager | null,
): Promise<string | null> {
	if (!ctx.sandboxed) {
		try { return await fs.promises.readFile(filePath, "utf-8"); }
		catch { return null; }
	}
	try {
		const authority = sandboxTranscriptAuthority(ctx, filePath, sandboxManager);
		const result = await authority.sandboxManager.runSessionTranscriptOperation(
			authority.projectId,
			authority.sessionId,
			{ kind: "read", path: authority.path },
		);
		return typeof result === "string" ? result : null;
	} catch { return null; }
}

/**
 * Atomically publish generated session-file content in the destination's own
 * filesystem realm. Sandbox targets are streamed to fixed, bounded code in the
 * exact attested runtime, which creates and atomically renames its own staging
 * entry without putting transcript content or host paths in argv.
 */
export async function sessionFileWriteAtomic(
	ctx: SessionFsContext,
	filePath: string,
	content: string | Buffer,
	sandboxManager: SandboxManager | null,
): Promise<void> {
	if (ctx.sandboxed) {
		const authority = sandboxTranscriptAuthority(ctx, filePath, sandboxManager);
		await authority.sandboxManager.runSessionTranscriptOperation(
			authority.projectId,
			authority.sessionId,
			{ kind: "writeAtomic", path: authority.path, content },
		);
		return;
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
		if (typeof content === "string") await handle.writeFile(content, { encoding: "utf-8" });
		else await handle.writeFile(content);
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
	sandboxManager: SandboxManager | null,
): Promise<void> {
	if (!ctx.sandboxed) throw new CrossRealmCopyError("cross-realm session rename not supported");
	const source = sandboxTranscriptAuthority(ctx, sourcePath, sandboxManager);
	const target = sandboxTranscriptAuthority(ctx, targetPath, sandboxManager);
	await source.sandboxManager.runSessionTranscriptOperation(
		source.projectId,
		source.sessionId,
		{ kind: "renameAtomic", sourcePath: source.path, targetPath: target.path },
	);
}

/**
 * Delete only through an exact attested session runtime. This intentionally
 * has no host-path or shared-control-container fallback.
 */
export async function sessionFileDeleteContainerOnly(
	ctx: SessionFsContext,
	filePath: string,
	sandboxManager: SandboxManager | null,
): Promise<boolean> {
	if (!ctx.sandboxed) return false;
	try {
		const authority = sandboxTranscriptAuthority(ctx, filePath, sandboxManager);
		await authority.sandboxManager.runSessionTranscriptOperation(
			authority.projectId,
			authority.sessionId,
			{ kind: "delete", path: authority.path },
		);
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
 *   sandboxed | CrossRealmCopyError           | bounded runtime read + atomic write
 *
 * Cross-realm and cross-project copies throw `CrossRealmCopyError`. Each
 * sandbox side is independently bound to its exact owner runtime.
 */
export async function sessionFileCopy(
	srcCtx: SessionFsContext,
	srcPath: string,
	dstCtx: SessionFsContext,
	dstPath: string,
	sandboxManager: SandboxManager | null,
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
		const source = sandboxTranscriptAuthority(srcCtx, srcPath, sandboxManager);
		const destination = sandboxTranscriptAuthority(dstCtx, dstPath, sandboxManager);
		const content = await source.sandboxManager.runSessionTranscriptOperation(
			source.projectId,
			source.sessionId,
			{ kind: "read", path: source.path },
		);
		if (typeof content !== "string") throw new Error("Session transcript source is unavailable");
		await destination.sandboxManager.runSessionTranscriptOperation(
			destination.projectId,
			destination.sessionId,
			{ kind: "writeAtomic", path: destination.path, content },
		);
		return;
	}

	// Cross-realm (host↔sandbox) — not supported today.
	throw new CrossRealmCopyError("cross-realm continue not supported");
}

/**
 * Delete a file at the given path.
 *
 * Sandboxed sessions delete only inside the exact attested session runtime.
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
	sandboxManager: SandboxManager | null,
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
		const authority = sandboxTranscriptAuthority(ctx, filePath, sandboxManager);
		await authority.sandboxManager.runSessionTranscriptOperation(
			authority.projectId,
			authority.sessionId,
			{ kind: "delete", path: authority.path },
		);
		return true;
	} catch {
		return false;
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
