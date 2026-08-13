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
import { activeAgentSessionsDir } from "./agent-session-path.js";
import { sidecarPathFor } from "./session-sidecar.js";

type SessionDeleteFs = Pick<typeof fs.promises, "unlink">;

async function containerPathToHostLazy(filePath: string): Promise<string> {
	const { containerPathToHost } = await import("./rpc-bridge.js");
	return containerPathToHost(filePath);
}

async function hostPathToContainerLazy(filePath: string): Promise<string | null> {
	const { tryHostPathToContainer } = await import("./rpc-bridge.js");
	return tryHostPathToContainer(filePath);
}

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
}

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

export function canonicalContainerAgentSessionPath(filePath: string): string | null {
	if (!filePath || filePath.includes("\0") || filePath.includes("\\")) return null;
	const normalized = path.posix.normalize(filePath);
	if (normalized !== filePath || !isContainerAgentSessionPath(normalized)) return null;
	return normalized;
}

const SANDBOX_PUBLISH_SCRIPT = [
	'const fs=require("node:fs"),path=require("node:path");',
	'const [stage,temp,target]=process.argv.slice(1);',
	'let fd;',
	'try {',
	'  fs.mkdirSync(path.dirname(target),{recursive:true});',
	'  fs.copyFileSync(stage,temp,fs.constants.COPYFILE_EXCL);',
	'  fs.chmodSync(temp,0o600);',
	'  fd=fs.openSync(temp,"r+"); fs.fsyncSync(fd); fs.closeSync(fd); fd=undefined;',
	'  fs.renameSync(temp,target);',
	'} finally {',
	'  if (fd!==undefined) { try { fs.closeSync(fd); } catch {} }',
	'  try { fs.unlinkSync(temp); } catch {}',
	'}',
].join("\n");

const SANDBOX_RENAME_SCRIPT = [
	'const fs=require("node:fs"),path=require("node:path");',
	'const [source,target]=process.argv.slice(1);',
	'fs.mkdirSync(path.dirname(target),{recursive:true});',
	'fs.renameSync(source,target);',
].join("\n");

const SANDBOX_DELETE_SCRIPT = [
	'const fs=require("node:fs");',
	'const target=process.argv[1];',
	'try { fs.unlinkSync(target); } catch (error) { if (error?.code!=="ENOENT") throw error; }',
].join("\n");

function isHostAbsoluteAgentSessionPath(filePath: string | undefined): boolean {
	if (!filePath || isContainerAgentSessionPath(filePath)) return false;
	return path.isAbsolute(filePath) || isWindowsAbsolutePath(filePath);
}

export function sessionFsContextForAgentFile(ps: Pick<SessionFsContext, "sandboxed" | "projectId">, filePath: string | undefined): SessionFsContext {
	return {
		sandboxed: !!ps.sandboxed && !isHostAbsoluteAgentSessionPath(filePath),
		projectId: ps.projectId,
	};
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
	sandboxManager: SandboxManager | null,
): Promise<boolean> {
	if (!ctx.sandboxed) {
		return fs.existsSync(filePath);
	}

	// Sandboxed: try docker exec first
	const sandbox = ctx.projectId ? sandboxManager?.get(ctx.projectId) : undefined;
	if (sandbox) {
		try {
			await sandbox.exec(["test", "-f", filePath]);
			return true;
		} catch {
			// test -f returns non-zero if file doesn't exist OR container is gone.
			// Try to distinguish: attempt a simple echo to check container health.
			try {
				await sandbox.exec(["echo", "ok"]);
				// Container is healthy — file genuinely doesn't exist
				return false;
			} catch {
				// Container unreachable — fall through to host fallback
			}
		}
	}

	// Fallback: translate container path → host path
	const hostPath = await containerPathToHostLazy(filePath);
	if (hostPath === filePath) {
		// No mount mapping found — can't translate, give up
		return false;
	}
	console.warn(`[session-fs] Container unavailable for exists check, falling back to host path: ${hostPath}`);
	return fs.existsSync(hostPath);
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
	sandboxManager: SandboxManager | null,
): Promise<string | null> {
	if (!ctx.sandboxed) {
		try {
			return fs.readFileSync(filePath, "utf-8");
		} catch {
			return null;
		}
	}

	// Sandboxed: try docker exec cat
	const sandbox = ctx.projectId ? sandboxManager?.get(ctx.projectId) : undefined;
	if (sandbox) {
		try {
			return await sandbox.exec(["cat", filePath]);
		} catch {
			// cat failed — could be missing file or dead container.
			// Check container health before falling back.
			try {
				await sandbox.exec(["echo", "ok"]);
				// Container healthy — file doesn't exist
				return null;
			} catch {
				// Container unreachable — fall through to host fallback
			}
		}
	}

	// Fallback: translate container path → host path
	const hostPath = await containerPathToHostLazy(filePath);
	if (hostPath === filePath) {
		// No mount mapping found — can't translate
		return null;
	}
	console.warn(`[session-fs] Container unavailable for read, falling back to host path: ${hostPath}`);
	try {
		return fs.readFileSync(hostPath, "utf-8");
	} catch {
		return null;
	}
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
	sandboxManager: SandboxManager | null,
): Promise<void> {
	if (ctx.sandboxed) {
		const targetPath = canonicalContainerAgentSessionPath(filePath);
		if (!ctx.projectId || !targetPath) {
			throw new CrossRealmCopyError("cross-realm session write not supported");
		}
		const sandbox = sandboxManager?.get(ctx.projectId);
		if (!sandbox) throw new Error(`sandbox unavailable for project ${ctx.projectId}`);

		const stagePath = path.join(
			activeAgentSessionsDir(),
			`.bobbit-stage-${process.pid}-${randomUUID()}.tmp`,
		);
		const siblingTemp = path.posix.join(
			path.posix.dirname(targetPath),
			`.${path.posix.basename(targetPath)}.bobbit-stage-${randomUUID()}.tmp`,
		);
		let handle: FileHandle | undefined;
		let stageCreated = false;
		try {
			await fs.promises.mkdir(activeAgentSessionsDir(), { recursive: true });
			handle = await fs.promises.open(stagePath, "wx", 0o600);
			stageCreated = true;
			const stat = await handle.stat();
			if (!stat.isFile()) throw new Error("Session transcript staging entry is not a regular file");
			await handle.writeFile(content, { encoding: "utf-8" });
			await handle.sync();
			await handle.close();
			handle = undefined;
			const containerStage = await hostPathToContainerLazy(stagePath);
			if (!containerStage || !canonicalContainerAgentSessionPath(containerStage)) {
				throw new CrossRealmCopyError("sandbox session stage is not in the sessions bind mount");
			}
			await sandbox.exec([
				"node", "-e", SANDBOX_PUBLISH_SCRIPT, "--",
				containerStage, siblingTemp, targetPath,
			]);
		} finally {
			if (handle) {
				try { await handle.close(); } catch { /* retain the primary staging failure */ }
			}
			if (stageCreated) {
				try { await fs.promises.unlink(stagePath); } catch { /* remove only this invocation's flat stage */ }
			}
		}
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

/** Atomically move a transcript between two paths in one live sandbox realm. */
export async function sessionFileRenameAtomic(
	ctx: SessionFsContext,
	sourcePath: string,
	targetPath: string,
	sandboxManager: SandboxManager | null,
): Promise<void> {
	const source = canonicalContainerAgentSessionPath(sourcePath);
	const target = canonicalContainerAgentSessionPath(targetPath);
	if (!ctx.sandboxed || !ctx.projectId || !source || !target) {
		throw new CrossRealmCopyError("cross-realm session rename not supported");
	}
	const sandbox = sandboxManager?.get(ctx.projectId);
	if (!sandbox) throw new Error(`sandbox unavailable for project ${ctx.projectId}`);
	await sandbox.exec(["node", "-e", SANDBOX_RENAME_SCRIPT, "--", source, target]);
}

/**
 * Delete only through a live container. This intentionally has no host-path
 * translation fallback: an unavailable sandbox leaves an orphan for trusted
 * maintenance rather than turning an attacker-influenced path into host I/O.
 */
export async function sessionFileDeleteContainerOnly(
	ctx: SessionFsContext,
	filePath: string,
	sandboxManager: SandboxManager | null,
): Promise<boolean> {
	const target = canonicalContainerAgentSessionPath(filePath);
	if (!ctx.sandboxed || !ctx.projectId || !target) return false;
	const sandbox = sandboxManager?.get(ctx.projectId);
	if (!sandbox) return false;
	try {
		await sandbox.exec(["node", "-e", SANDBOX_DELETE_SCRIPT, "--", target]);
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
		const sandbox = sandboxManager?.get(srcCtx.projectId);
		if (!sandbox) {
			throw new Error(`sandbox unavailable for project ${srcCtx.projectId}`);
		}
		const dir = path.posix.dirname(dstPath.replace(/\\/g, "/"));
		await sandbox.exec(["mkdir", "-p", dir]);
		await sandbox.exec(["cp", srcPath, dstPath]);
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
	sandboxManager: SandboxManager | null,
	fsImpl: SessionDeleteFs = fs.promises,
): Promise<boolean> {
	if (!ctx.sandboxed) {
		try {
			await fsImpl.unlink(filePath);
			return true;
		} catch (err: any) {
			// ENOENT is fine — file already gone
			return err?.code === "ENOENT";
		}
	}

	// Sandboxed: try docker exec rm
	const sandbox = ctx.projectId ? sandboxManager?.get(ctx.projectId) : undefined;
	if (sandbox) {
		try {
			await sandbox.exec(["rm", "-f", filePath]);
			return true;
		} catch {
			// rm failed — check if container is alive
			try {
				await sandbox.exec(["echo", "ok"]);
				// Container healthy — rm genuinely failed
				return false;
			} catch {
				// Container unreachable — fall through to host fallback
			}
		}
	}

	// Fallback: translate container path → host path
	const hostPath = await containerPathToHostLazy(filePath);
	if (hostPath === filePath) {
		// No mount mapping found — can't translate
		return false;
	}
	console.warn(`[session-fs] Container unavailable for delete, falling back to host path: ${hostPath}`);
	try {
		await fsImpl.unlink(hostPath);
		return true;
	} catch (err: any) {
		return err?.code === "ENOENT";
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
