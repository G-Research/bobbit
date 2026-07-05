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
 * The fix: this resolver NEVER emits a raw host path as the clone URL, and
 * NEVER derives a bind-mount source from the `origin` value.
 * - With a network `origin` remote → clone the remote URL directly.
 * - With no origin → bind-mount the CALLER-supplied canonical main-repo root
 *   (`mountSourcePath`) at a fixed container path and clone from `file://`.
 *   The resolver never touches the filesystem and never derives any path from
 *   `origin` — this removes the entire local-origin→mount attack surface (an
 *   in-root symlink pointing outside can no longer escape, because no path is
 *   ever derived from `origin`).
 * - With a LOCAL origin (file://, absolute/relative/UNC/drive-letter path):
 *   THROW a clear, actionable error. A local origin cannot be cloned into the
 *   container (the host path is unreachable / a drive-letter is misparsed as
 *   scp), so the caller must configure a clonable network remote or remove the
 *   origin to fall back to the mounted project repo.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stripTokenFromGitUrl } from "../skills/git.js";
import { realCommandRunner, type CommandRunner } from "../gateway-deps.js";

/** Fixed container-internal mount point for the remote-less bind-mount source. */
export const MOUNTED_SRC_PATH = "/workspace-src";
/** Clone URL git uses inside the container for the bind-mounted source. */
export const MOUNTED_SRC_CLONE_URL = "file:///workspace-src";

export type SandboxCloneSource =
	| { kind: "remote"; cloneUrl: string }
	| { kind: "mounted"; hostPath: string; mountPath: string; cloneUrl: string };

const SANITIZED_CLONE_SOURCE_VERSION = "v1";
const UNSAFE_CLONE_SOURCE_SEGMENTS = new Set([".bobbit"]);

function isUnsafeCloneSourcePath(gitPath: string): boolean {
	const parts = gitPath.split("/").filter(Boolean);
	return parts.some((part) => UNSAFE_CLONE_SOURCE_SEGMENTS.has(part) || part.toLowerCase() === "auth.json");
}

function slugForPathPart(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "repo";
}

function runGit(repoPath: string, args: string[], options: { encoding: "utf8" } | { encoding: "buffer" }, commandRunner: CommandRunner = realCommandRunner): string | Buffer {
	if (!commandRunner.execFileSync) throw new Error("CommandRunner.execFileSync is required for sandbox clone source git operations");
	return commandRunner.execFileSync("git", args, {
		cwd: repoPath,
		encoding: options.encoding,
		maxBuffer: 256 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function tryGit(repoPath: string, args: string[], commandRunner: CommandRunner = realCommandRunner): string | null {
	try {
		return String(runGit(repoPath, args, { encoding: "utf8" }, commandRunner)).trim() || null;
	} catch {
		return null;
	}
}

function validateBranchName(branch: string | null, commandRunner: CommandRunner = realCommandRunner): string {
	const candidate = branch || "master";
	if (!commandRunner.execFileSync) throw new Error("CommandRunner.execFileSync is required for git branch validation");
	try {
		commandRunner.execFileSync("git", ["check-ref-format", "--branch", candidate], { stdio: "ignore" });
		return candidate;
	} catch {
		return "master";
	}
}

function safeWritePath(root: string, gitPath: string): string {
	const target = path.resolve(root, ...gitPath.split("/"));
	const rel = path.relative(root, target);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(`[sandbox] refusing unsafe path in sanitized clone source: ${gitPath}`);
	}
	return target;
}

/**
 * Build a temporary git clone source for remote-less sandbox bootstraps.
 *
 * The sandbox must clone from `file://<mountPath>` for remote-less projects, but
 * bind-mounting the project root exposes project-local private state such as
 * `<projectRoot>/.bobbit/agent/auth.json`. This helper creates a fresh, minimal
 * git repository containing only safe tracked HEAD content. It deliberately
 * excludes every `.bobbit/` subtree and every `auth.json`, then commits the
 * sanitized snapshot into a new local repository whose object database contains
 * only those copied files.
 */
export function prepareSanitizedSandboxCloneSource(opts: {
	repoPath: string;
	stateDir: string;
	key?: string;
	commandRunner?: CommandRunner;
}): string {
	const commandRunner = opts.commandRunner ?? realCommandRunner;
	if (!commandRunner.execFileSync) throw new Error("CommandRunner.execFileSync is required for sandbox clone source preparation");
	const repoPath = path.resolve(opts.repoPath);
	const stateDir = path.resolve(opts.stateDir);
	const head = tryGit(repoPath, ["rev-parse", "--verify", "HEAD"], commandRunner);
	const sourceId = `${SANITIZED_CLONE_SOURCE_VERSION}\0${repoPath}\0${opts.key ?? ""}\0${head ?? "empty"}`;
	const hash = crypto.createHash("sha256").update(sourceId).digest("hex").slice(0, 16);
	const dest = path.join(stateDir, "sandbox-clone-sources", `${slugForPathPart(opts.key ?? path.basename(repoPath))}-${hash}`);

	if (fs.existsSync(path.join(dest, ".git"))) return dest;

	const staging = `${dest}.tmp-${process.pid}-${Date.now()}`;
	fs.rmSync(staging, { recursive: true, force: true });
	fs.mkdirSync(staging, { recursive: true });
	try {
		if (head) {
			const tree = runGit(repoPath, ["ls-tree", "-r", "-z", "--full-tree", head], { encoding: "buffer" }, commandRunner) as Buffer;
			for (const rawEntry of tree.toString("utf8").split("\0")) {
				if (!rawEntry) continue;
				const tab = rawEntry.indexOf("\t");
				if (tab < 0) continue;
				const meta = rawEntry.slice(0, tab).split(" ");
				const gitPath = rawEntry.slice(tab + 1);
				const [mode, type, object] = meta;
				if (type !== "blob" || !object || isUnsafeCloneSourcePath(gitPath)) continue;

				const target = safeWritePath(staging, gitPath);
				fs.mkdirSync(path.dirname(target), { recursive: true });
				const content = runGit(repoPath, ["cat-file", "blob", object], { encoding: "buffer" }, commandRunner) as Buffer;
				if (mode === "120000" && process.platform !== "win32") {
					fs.symlinkSync(content.toString("utf8"), target);
				} else {
					fs.writeFileSync(target, content);
					if (mode === "100755") fs.chmodSync(target, 0o755);
				}
			}
		}

		commandRunner.execFileSync("git", ["init"], { cwd: staging, stdio: "ignore" });
		const branch = validateBranchName(tryGit(repoPath, ["symbolic-ref", "--quiet", "--short", "HEAD"], commandRunner), commandRunner);
		commandRunner.execFileSync("git", ["checkout", "-B", branch], { cwd: staging, stdio: "ignore" });
		commandRunner.execFileSync("git", ["add", "-A"], { cwd: staging, stdio: "ignore" });
		commandRunner.execFileSync("git", [
			"-c", "user.name=Bobbit",
			"-c", "user.email=bobbit@bobbit.ai",
			"commit", "--allow-empty", "-m", "Sanitized sandbox clone source",
		], { cwd: staging, stdio: "ignore" });

		fs.mkdirSync(path.dirname(dest), { recursive: true });
		try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* a previous mounted source may still be in use */ }
		fs.renameSync(staging, dest);
		return dest;
	} catch (err) {
		fs.rmSync(staging, { recursive: true, force: true });
		throw err;
	}
}

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
 * Resolve the clone source for a sandbox container.
 *
 * @param opts.originUrl       The project's `origin` remote URL (or null/empty/undefined when absent).
 * @param opts.mountSourcePath The CANONICAL main-repo working directory to bind-mount when origin
 *                             is absent. Required. The caller resolves this (see
 *                             `resolveSandboxMountRoot`) — the resolver NEVER derives a path from
 *                             `origin` and NEVER touches the filesystem.
 * @param opts.mountPath       Container-internal mount point (default `/workspace-src`). Multi-repo
 *                             callers pass a per-repo path like `/workspace-src/web`.
 *
 * Classification:
 * - A network remote (URL scheme or scp-style `[user@]host:path`) →
 *   `{ kind: "remote", cloneUrl: stripTokenFromGitUrl(origin) }`, cloned directly.
 * - Absent/empty origin → bind-mount `mountSourcePath` (the caller-canonicalized
 *   main repo root — always safe) and clone via `file://<mountPath>`.
 * - A LOCAL origin (file://, absolute/relative/UNC/drive-letter) → THROW. A local
 *   origin can never be cloned into the container.
 *
 * Invariant: the returned `cloneUrl` is NEVER a raw host path or a Windows
 * drive-letter string. It is always a network remote URL or `file://<mountPath>`.
 */
export function resolveSandboxCloneSource(opts: {
	originUrl?: string | null;
	mountSourcePath: string;
	mountPath?: string;
}): SandboxCloneSource {
	const origin = (opts.originUrl ?? "").trim();
	const mountPath = opts.mountPath ?? MOUNTED_SRC_PATH;
	const cloneUrl = `file://${mountPath}`;

	// Network remote → clone directly.
	if (origin && isNetworkRemote(origin)) {
		return { kind: "remote", cloneUrl: stripTokenFromGitUrl(origin) };
	}

	// Absent origin → mount the caller-supplied canonical main repo root (the
	// sandbox's own source). No path is derived from `origin`, so an in-root
	// symlink can never be used to escape and bind-mount an arbitrary host path.
	if (!origin) {
		return { kind: "mounted", hostPath: opts.mountSourcePath, mountPath, cloneUrl };
	}

	// Non-empty LOCAL origin (file://, absolute/relative/UNC/drive-letter). We do
	// NOT mount anything derived from `origin` — bind-mounting an origin-derived
	// path is the attack surface this fix removes. A local origin cannot be
	// cloned into the container (host path unreachable; a drive-letter is
	// misparsed as scp), so fail fast with an actionable message.
	throw new Error(
		`[sandbox] origin "${origin}" is a local path, which cannot be cloned into the sandbox. ` +
			`Configure a clonable network remote (https/ssh), or remove the origin to use the ` +
			`project's own repository as the mounted clone source.`,
	);
}
