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
import { containerPathToHost } from "./rpc-bridge.js";
import type { SandboxManager } from "./sandbox-manager.js";

/**
 * Context describing the session's sandbox state and project affiliation.
 */
export interface SessionFsContext {
	sandboxed?: boolean;
	projectId?: string;
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
	const hostPath = containerPathToHost(filePath);
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
	const hostPath = containerPathToHost(filePath);
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
): Promise<boolean> {
	if (!ctx.sandboxed) {
		try {
			fs.unlinkSync(filePath);
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
	const hostPath = containerPathToHost(filePath);
	if (hostPath === filePath) {
		// No mount mapping found — can't translate
		return false;
	}
	console.warn(`[session-fs] Container unavailable for delete, falling back to host path: ${hostPath}`);
	try {
		fs.unlinkSync(hostPath);
		return true;
	} catch (err: any) {
		return err?.code === "ENOENT";
	}
}
