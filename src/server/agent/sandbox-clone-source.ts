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
 * - With a network `origin` remote → clone the remote URL directly.
 * - With no origin → bind-mount the declared project repo (the sandbox's own
 *   source — always safe) at a fixed container path and clone from `file://`.
 * - With a LOCAL origin (file://, absolute/relative/UNC/drive-letter path):
 *   only mount it when it resolves to a path inside the project root. Any
 *   local origin pointing OUTSIDE the project root throws — bind-mounting an
 *   arbitrary host path into the sandbox is a data-exposure risk (security).
 */

import path from "node:path";
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
 * URL-scheme network remote git can reach from inside the container.
 * Case-insensitive. Anything matching this is treated as a network remote.
 */
const URL_SCHEME_RE = /^(https?|git|ssh|git\+ssh|ftp|ftps):\/\//i;

/**
 * Decide whether `origin` is a network remote, mirroring git's own heuristic.
 *
 * A remote is either:
 * - a URL with a recognised network scheme (`https://`, `ssh://`, …), OR
 * - scp-style `[user@]host:path`: a colon appears BEFORE the first `/`, and the
 *   host part (text before that colon, with any leading `user@` stripped) is
 *   NOT a single drive letter.
 *
 * The single-letter-host exclusion is what keeps a Windows drive path
 * (`C:/Users/...`) from being misparsed as an scp remote — git itself treats a
 * single-letter "host" before a colon as a local drive path, not a remote.
 */
function isNetworkRemote(origin: string): boolean {
	if (URL_SCHEME_RE.test(origin)) return true;
	// Any other explicit URL scheme (`file://`, …) is a URL form, not scp-style —
	// and not a network scheme we clone directly. Treat it as local.
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(origin)) return false;

	const slashIdx = origin.indexOf("/");
	const colonIdx = origin.indexOf(":");
	// scp-style requires a colon before the first slash (`host:path`).
	if (colonIdx < 0) return false;
	if (slashIdx >= 0 && slashIdx < colonIdx) return false;

	// Host part is everything before the colon, minus an optional `user@`.
	let host = origin.slice(0, colonIdx);
	const at = host.lastIndexOf("@");
	if (at >= 0) host = host.slice(at + 1);
	// A single-character host (e.g. `C` in `C:/...`) is a Windows drive letter,
	// not an scp host → local path, not a remote.
	if (host.length <= 1) return false;
	return host.length > 0;
}

/**
 * True if `p` is an absolute path on any OS: POSIX-absolute (`/foo`), a Windows
 * drive path (`C:\` / `C:/`), or a UNC path (`\\host` / `//host`). We detect
 * Windows-style forms explicitly so a drive-letter origin is never (mis)treated
 * as relative-to-repoPath when this code runs on a POSIX host.
 */
function isAbsoluteLike(p: string): boolean {
	return path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
}

/** True if `candidate` is `root` or a descendant of `root` (cross-platform). */
function isWithinRoot(root: string, candidate: string): boolean {
	const rel = path.relative(path.resolve(root), path.resolve(candidate));
	// Empty rel → same path. Otherwise it must not escape (`..`) and must not be
	// absolute (which path.relative returns when the two are on different roots,
	// e.g. different Windows drives).
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve the clone source for a sandbox container.
 *
 * @param opts.originUrl   The project's `origin` remote URL (or null/empty/undefined when absent).
 * @param opts.repoPath    The host repo root. Bind-mounted when origin is absent;
 *                         also the security root for local-origin validation.
 * @param opts.mountPath   Container-internal mount point (default `/workspace-src`). Multi-repo
 *                         callers pass a per-repo path like `/workspace-src/web`.
 *
 * Classification:
 * - A network remote (URL scheme or scp-style `[user@]host:path`) →
 *   `{ kind: "remote", cloneUrl: stripTokenFromGitUrl(origin) }`, cloned directly.
 * - Absent/empty origin → bind-mount the declared `repoPath` (always safe — it's
 *   the sandbox's own source) and clone via `file://<mountPath>`.
 * - A LOCAL origin (file://, absolute/relative/UNC/drive-letter) is resolved to a
 *   canonical filesystem path. If it is inside `repoPath` it is bind-mounted;
 *   otherwise this THROWS — bind-mounting an arbitrary host path is a data-exposure
 *   risk.
 *
 * Invariant: the returned `cloneUrl` is NEVER a raw host path or a Windows
 * drive-letter string. It is always a network remote URL or `file://<mountPath>`.
 */
export function resolveSandboxCloneSource(opts: {
	originUrl?: string | null;
	repoPath: string;
	mountPath?: string;
}): SandboxCloneSource {
	const origin = (opts.originUrl ?? "").trim();
	const mountPath = opts.mountPath ?? MOUNTED_SRC_PATH;
	const cloneUrl = `file://${mountPath}`;

	// Network remote → clone directly.
	if (origin && isNetworkRemote(origin)) {
		return { kind: "remote", cloneUrl: stripTokenFromGitUrl(origin) };
	}

	// Absent origin → mount the declared repo (the sandbox's own source).
	if (!origin) {
		return { kind: "mounted", hostPath: opts.repoPath, mountPath, cloneUrl };
	}

	// Local origin → resolve to a canonical absolute filesystem path.
	let hostPath: string;
	if (/^file:\/\//i.test(origin)) {
		hostPath = fileURLToPath(origin);
	} else if (isAbsoluteLike(origin)) {
		// Already absolute (POSIX / drive-letter / UNC) — keep it; never join with repoPath.
		hostPath = path.resolve(origin);
	} else {
		// Relative origin resolves against the repo root.
		hostPath = path.resolve(opts.repoPath, origin);
	}

	// Security: only mount local origins that live inside the project root.
	// Bind-mounting an arbitrary host path (e.g. `file:///some/other/private/repo`)
	// would expose it inside the sandbox.
	if (!isWithinRoot(opts.repoPath, hostPath)) {
		throw new Error(
			`[sandbox] origin "${origin}" is a local path outside the project root ` +
				`(${opts.repoPath}) and cannot be safely cloned into the sandbox. ` +
				`Configure a clonable network remote (https/ssh) or remove the local origin.`,
		);
	}

	return { kind: "mounted", hostPath, mountPath, cloneUrl };
}
