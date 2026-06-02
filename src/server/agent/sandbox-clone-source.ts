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

import { fileURLToPath } from "node:url";
import { stripTokenFromGitUrl } from "../skills/git.js";

/** Fixed container-internal mount point for the remote-less bind-mount source. */
export const MOUNTED_SRC_PATH = "/workspace-src";
/** Clone URL git uses inside the container for the bind-mounted source. */
export const MOUNTED_SRC_CLONE_URL = "file:///workspace-src";

export type SandboxCloneSource =
	| { kind: "remote"; cloneUrl: string }
	| { kind: "mounted"; hostPath: string; mountPath: string; cloneUrl: string };

/**
 * True network/transport remote schemes git can reach from inside the container.
 * Anything else (file://, absolute/relative paths, drive-letter paths) is a
 * LOCAL source that must be bind-mounted — never handed to git as-is.
 */
const REMOTE_SCHEME_RE = /^(https?|git|ssh|git\+ssh):\/\//i;
/** scp-style remote: `user@host:path` (no scheme). */
const SCP_REMOTE_RE = /^[^/@\s]+@[^/:\s]+:/;
/** Windows drive-letter path: `C:\...` or `C:/...`. Checked BEFORE scp so it is never misparsed. */
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;

/**
 * Resolve the clone source for a sandbox container.
 *
 * @param opts.originUrl   The project's `origin` remote URL (or null/empty/undefined when absent).
 * @param opts.repoPath    The host repo root — used as the bind-mount host path when origin is absent.
 * @param opts.mountPath   Container-internal mount point (default `/workspace-src`). Multi-repo
 *                         callers pass a per-repo path like `/workspace-src/web`.
 *
 * Classification:
 * - A TRUE remote (http(s)/git/ssh/git+ssh scheme, or scp-style `user@host:path`)
 *   → `{ kind: "remote", cloneUrl }` cloned directly.
 * - Everything else — empty origin, `file://` URL, absolute POSIX path, Windows
 *   drive-letter path, UNC path, or relative path — is a LOCAL source. The host
 *   directory is bind-mounted read-only and cloned via `file://<mountPath>`.
 *
 * Invariant: the returned `cloneUrl` is NEVER a raw host path or a Windows
 * drive-letter string (git misparses `C:/...` as scp/SSH syntax → `cannot run
 * ssh` / `unable to fork`). It is always either a true remote URL or
 * `file://<mountPath>`.
 */
export function resolveSandboxCloneSource(opts: {
	originUrl?: string | null;
	repoPath: string;
	mountPath?: string;
}): SandboxCloneSource {
	const origin = (opts.originUrl ?? "").trim();
	const mountPath = opts.mountPath ?? MOUNTED_SRC_PATH;
	const cloneUrl = `file://${mountPath}`;

	// True remote → clone directly (Windows-drive check first so `C:/...` is never
	// classified as an scp `host:path` remote — that misparse was the original bug).
	if (origin && !WINDOWS_DRIVE_RE.test(origin) && (REMOTE_SCHEME_RE.test(origin) || SCP_REMOTE_RE.test(origin))) {
		return { kind: "remote", cloneUrl: stripTokenFromGitUrl(origin) };
	}

	// Local source → bind-mount. Decode `file://` origins to a filesystem path;
	// use the origin path string directly when it's a local path; fall back to
	// the repo root when origin is absent.
	let hostPath: string;
	if (!origin) {
		hostPath = opts.repoPath;
	} else if (/^file:\/\//i.test(origin)) {
		hostPath = fileURLToPath(origin);
	} else {
		hostPath = origin;
	}

	return { kind: "mounted", hostPath, mountPath, cloneUrl };
}
