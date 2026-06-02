/**
 * Sandbox clone-source resolution.
 *
 * Picks the source `git clone` uses *inside* the Linux sandbox container.
 *
 * The historical bug: when a project had no `origin` remote, the bootstrap
 * fell back to the raw HOST directory path as the clone URL. On Windows the
 * drive-letter path (`C:/Users/...`) is misparsed by git as scp/SSH syntax
 * (`host:path`) → `cannot run ssh` / `unable to fork`; on any OS the host path
 * is unreachable from inside the container.
 *
 * The fix: this resolver NEVER emits a raw host path as the clone URL.
 * - With an `origin` remote → clone the remote URL directly.
 * - Without one → declare a read-only bind-mount of the host repo at a fixed
 *   container path (`/workspace-src`) and clone from `file:///workspace-src`.
 */

import { stripTokenFromGitUrl } from "../skills/git.js";

/** Fixed container-internal mount point for the remote-less bind-mount source. */
export const MOUNTED_SRC_PATH = "/workspace-src";
/** Clone URL git uses inside the container for the bind-mounted source. */
export const MOUNTED_SRC_CLONE_URL = "file:///workspace-src";

export type SandboxCloneSource =
	| { kind: "remote"; cloneUrl: string }
	| { kind: "mounted"; hostPath: string; mountPath: string; cloneUrl: string };

/**
 * Resolve the clone source for a sandbox container.
 *
 * @param opts.originUrl  The project's `origin` remote URL (or null/empty/undefined when absent).
 * @param opts.repoPath   The host repo root — used only as the bind-mount host path when origin is absent.
 *
 * Invariant: the returned `cloneUrl` is NEVER a raw host path or a Windows
 * drive-letter string. A remote-less project always becomes a `mounted` source
 * cloned via `file:///workspace-src`.
 */
export function resolveSandboxCloneSource(opts: { originUrl?: string | null; repoPath: string }): SandboxCloneSource {
	const origin = (opts.originUrl ?? "").trim();
	if (origin) {
		return { kind: "remote", cloneUrl: stripTokenFromGitUrl(origin) };
	}
	return {
		kind: "mounted",
		hostPath: opts.repoPath,
		mountPath: MOUNTED_SRC_PATH,
		cloneUrl: MOUNTED_SRC_CLONE_URL,
	};
}
