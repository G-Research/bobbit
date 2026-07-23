import { performance } from "node:perf_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cpuDiagnosticsEnabled, getCpuDiagnostics } from "../agent/cpu-diagnostics.js";
import {
	RECOVERY_IO_CONCURRENCY,
	removeTree,
	type AsyncTreeFs,
} from "../agent/bounded-async-work.js";
import { realCommandRunner, type CommandRunner } from "../gateway-deps.js";
import type { Component } from "../agent/project-config-store.js";
import { branchToSlug, worktreeRoot as wtRootHelper } from "./worktree-paths.js";

const primaryBranchFallbackWarningCwds = new Set<string>();

export const UNRESOLVED_HEAD_WORKTREE_CODE = "WORKTREE_UNRESOLVED_HEAD";

export function unresolvedHeadWorktreeMessage(repoPath: string): string {
	return `Cannot create worktree for ${repoPath}: repository HEAD is unresolved/unborn. Make an initial commit to enable worktrees.`;
}

export class UnresolvedHeadWorktreeError extends Error {
	readonly code = UNRESOLVED_HEAD_WORKTREE_CODE;
	constructor(readonly repoPath: string) {
		super(unresolvedHeadWorktreeMessage(repoPath));
		this.name = "UnresolvedHeadWorktreeError";
	}
}

export function isUnresolvedHeadWorktreeError(err: unknown): err is UnresolvedHeadWorktreeError {
	return err instanceof UnresolvedHeadWorktreeError
		|| (err instanceof Error && (err as { code?: unknown }).code === UNRESOLVED_HEAD_WORKTREE_CODE);
}

function childErrorCode(err: unknown): string {
	const code = (err as { code?: unknown } | null)?.code;
	return typeof code === "string" || typeof code === "number" ? String(code) : "error";
}

function gitChildLabel(args: readonly string[]): string {
	const [cmd, sub] = args;
	if (cmd === "worktree" && sub) return `git worktree ${sub}`;
	if (cmd === "push") return "git push";
	if (cmd === "fetch") return "git fetch";
	if (cmd === "branch") return "git branch";
	if (cmd === "rev-parse") return "git rev-parse";
	if (cmd === "symbolic-ref") return "git symbolic-ref";
	return cmd ? `git ${cmd}` : "git";
}

async function execGit(
	args: readonly string[],
	options?: any,
	commandRunner: CommandRunner = realCommandRunner,
): Promise<{ stdout: string; stderr: string }> {
	if (!cpuDiagnosticsEnabled()) {
		return await commandRunner.execFile("git", args, options) as unknown as { stdout: string; stderr: string };
	}
	const start = performance.now();
	let success = 0;
	let errorCode = "none";
	try {
		const result = await commandRunner.execFile("git", args, options) as unknown as { stdout: string; stderr: string };
		success = 1;
		return result;
	} catch (err) {
		errorCode = childErrorCode(err);
		throw err;
	} finally {
		getCpuDiagnostics().recordChildProcess(gitChildLabel(args), performance.now() - start, {
			success,
			errorCode,
			timeoutMs: typeof options?.timeout === "number" ? options.timeout : 0,
		});
	}
}

export interface RemoteGitPolicy {
	skipRemotePush?: boolean;
	skipNonLocalRemoteGit?: boolean;
	e2eTmpRoot?: string;
}

const DEFAULT_REMOTE_GIT_POLICY: RemoteGitPolicy = Object.freeze({});

/** Whether remote git push operations should be skipped. */
export function shouldSkipRemotePush(remotePolicy: RemoteGitPolicy = DEFAULT_REMOTE_GIT_POLICY): boolean {
	return !!remotePolicy.skipRemotePush;
}

function isLocalGitRemoteUrl(rawUrl: string): boolean {
	const url = rawUrl.trim();
	if (!url) return false;
	if (path.isAbsolute(url) || path.win32.isAbsolute(url)) return true;
	if (url === "." || url === ".." || url.startsWith("./") || url.startsWith("../") || url.startsWith("~/")) return true;
	if (/^[A-Za-z]:[\\/]/.test(url)) return true;
	try {
		const parsed = new URL(url);
		return parsed.protocol === "file:";
	} catch {
		// Not a URL; fall through to SCP-style checks.
	}
	if (/^[^\s/:]+@[^\s:]+:.+/.test(url)) return false;
	if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) return false;
	return !/^[^\\/]+:.+/.test(url);
}

/**
 * In offline E2E/unit modes, skip git operations that would touch a missing or
 * non-local remote. Local bare/file remotes are allowed so tests can exercise
 * fetch/reset semantics without network access.
 */
export async function shouldSkipRemoteGitForTests(cwd: string, remote = "origin", commandRunner: CommandRunner = realCommandRunner, remotePolicy: RemoteGitPolicy = DEFAULT_REMOTE_GIT_POLICY): Promise<boolean> {
	if (!remotePolicy.skipNonLocalRemoteGit) return false;
	try {
		const { stdout } = await execGit(["remote", "get-url", remote], { cwd, timeout: 5_000 }, commandRunner);
		return !isLocalGitRemoteUrl(stdout.toString());
	} catch {
		return true;
	}
}

export async function shouldSkipRemotePushForTests(cwd: string, remote = "origin", commandRunner: CommandRunner = realCommandRunner, remotePolicy: RemoteGitPolicy = DEFAULT_REMOTE_GIT_POLICY): Promise<boolean> {
	return shouldSkipRemotePush(remotePolicy) || await shouldSkipRemoteGitForTests(cwd, remote, commandRunner, remotePolicy);
}

/**
 * Strip embedded credentials from a git remote URL.
 * e.g. "https://ghp_abc123@github.com/user/repo.git" → "https://github.com/user/repo.git"
 * Prevents tokens from leaking into .git/config inside sandbox containers.
 * Authentication is handled by the credential helper reading GITHUB_TOKEN from env.
 */
export function stripTokenFromGitUrl(url: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.username || parsed.password) {
			parsed.username = "";
			parsed.password = "";
			return parsed.toString();
		}
	} catch {
		// Not a URL (e.g. SSH or local path) — return as-is
	}
	return url;
}

/**
 * Resolve the remote primary branch (e.g. origin/main or origin/master).
 * Uses `git symbolic-ref refs/remotes/origin/HEAD` which is set by `git clone`.
 * Falls back to "HEAD" if detection fails.
 */
/**
 * Detect the bare primary branch name (e.g. "main" or "master").
 * Uses `git symbolic-ref refs/remotes/origin/HEAD`, which is set by `git clone`.
 * Falls back to local `master`, then local `main`, then literal "master".
 *
 * Unlike `resolveRemotePrimary` (which returns the ref with `origin/` prefix),
 * this returns the bare branch name suitable for substituting into prompt
 * templates as `{{baseBranch}}` (the legacy alias `{{master}}` resolves through
 * here too).
 */
export async function detectPrimaryBranch(cwd: string, commandRunner: CommandRunner = realCommandRunner, remotePolicy: RemoteGitPolicy = DEFAULT_REMOTE_GIT_POLICY): Promise<string> {
	try {
		const { stdout } = await execGit(["symbolic-ref", "refs/remotes/origin/HEAD"], {
			cwd,
			timeout: 5_000,
		}, commandRunner);
		const ref = stdout.trim().replace("refs/remotes/origin/", "");
		if (ref) return ref;
	} catch { /* fall through */ }
	try {
		await execGit(["rev-parse", "--verify", "refs/heads/master"], { cwd, timeout: 5_000 }, commandRunner);
		return "master";
	} catch { /* ignore */ }
	try {
		await execGit(["rev-parse", "--verify", "refs/heads/main"], { cwd, timeout: 5_000 }, commandRunner);
		return "main";
	} catch { /* ignore */ }
	await warnPrimaryBranchFallbackIfUseful(cwd, commandRunner, remotePolicy);
	return "master";
}

async function warnPrimaryBranchFallbackIfUseful(cwd: string, commandRunner: CommandRunner = realCommandRunner, remotePolicy: RemoteGitPolicy = DEFAULT_REMOTE_GIT_POLICY): Promise<void> {
	if (!await shouldWarnPrimaryBranchFallback(cwd, commandRunner, remotePolicy)) return;
	const key = path.resolve(cwd);
	if (primaryBranchFallbackWarningCwds.has(key)) return;
	primaryBranchFallbackWarningCwds.add(key);
	console.warn(`[git] detectPrimaryBranch(${cwd}): could not detect primary branch; defaulting to "master"`);
}

async function shouldWarnPrimaryBranchFallback(cwd: string, commandRunner: CommandRunner = realCommandRunner, remotePolicy: RemoteGitPolicy = DEFAULT_REMOTE_GIT_POLICY): Promise<boolean> {
	const expectedTempFallbackPath = isExpectedTempPrimaryBranchFallbackPath(cwd, remotePolicy);
	try {
		await execGit(["remote", "get-url", "origin"], { cwd, timeout: 5_000 }, commandRunner);
		return true;
	} catch { /* no origin remote is fine for minimal temp repos */ }

	try {
		const { stdout } = await execGit(["rev-parse", "--is-inside-work-tree"], { cwd, timeout: 5_000 }, commandRunner);
		if (stdout.trim() !== "true") return !expectedTempFallbackPath;
	} catch {
		return !expectedTempFallbackPath;
	}

	if (expectedTempFallbackPath) return false;

	try {
		const { stdout } = await execGit(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"], {
			cwd,
			timeout: 5_000,
		}, commandRunner);
		return stdout.split(/\r?\n/).some((line) => {
			const ref = line.trim();
			return ref !== "" && ref !== "refs/remotes/origin/HEAD";
		});
	} catch {
		// If even ref enumeration fails, keep the diagnostic for likely bad cwd/repos.
		return true;
	}
}

function isExpectedTempPrimaryBranchFallbackPath(cwd: string, remotePolicy: RemoteGitPolicy = DEFAULT_REMOTE_GIT_POLICY): boolean {
	const resolved = path.resolve(cwd);
	const tmpRoot = path.resolve(os.tmpdir());
	if (sameOrInsidePath(resolved, tmpRoot)) {
		if (samePath(resolved, tmpRoot)) return true;
		if (hasExpectedTempHarnessComponent(resolved)) return true;
	}

	const e2eRoot = path.resolve(remotePolicy.e2eTmpRoot || defaultE2eTempRoot());
	return sameOrInsidePath(resolved, e2eRoot);
}

function defaultE2eTempRoot(): string {
	return process.platform === "win32" ? "C:\\bobbit-e2e" : path.join(os.tmpdir(), "bobbit-e2e");
}

function hasExpectedTempHarnessComponent(p: string): boolean {
	return p.split(/[\\/]+/).some((component) => {
		const c = component.toLowerCase();
		return c === "bobbit-e2e"
			|| c.startsWith("bobbit-e2e-")
			|| c.startsWith("proj-isolation-")
			|| c.startsWith("verif-restart-repo-");
	});
}

function sameOrInsidePath(child: string, parent: string): boolean {
	const c = comparablePath(child);
	const p = comparablePath(parent);
	if (c === p) return true;
	const rel = path.relative(p, c);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function samePath(a: string, b: string): boolean {
	return comparablePath(a) === comparablePath(b);
}

function comparablePath(p: string): string {
	const resolved = path.resolve(p);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.promises.access(filePath);
		return true;
	} catch {
		return false;
	}
}

// Targeted worktree removals share one small process-wide I/O ceiling. Keeping
// the limiter here prevents a bounded outer cleanup (pool drain, purge, or
// inventory) from multiplying concurrency while walking a partial worktree.
let targetedRemovalActive = 0;
const targetedRemovalWaiters: Array<() => void> = [];

async function withTargetedRemovalSlot<T>(operation: () => Promise<T>): Promise<T> {
	if (targetedRemovalActive >= RECOVERY_IO_CONCURRENCY) {
		await new Promise<void>((resolve) => targetedRemovalWaiters.push(resolve));
	} else {
		targetedRemovalActive++;
	}
	try {
		return await operation();
	} finally {
		const next = targetedRemovalWaiters.shift();
		if (next) next();
		else targetedRemovalActive--;
	}
}

/**
 * Remove one exact path through the canonical bounded tree remover. It
 * revalidates an opened directory path before using each returned child name,
 * so replacing a verified directory with a symlink can only unlink the link;
 * it can never redirect child deletion outside the target.
 *
 * The operation owns one process-wide slot for its lifetime. Concurrent
 * worktree/pool cleanup therefore retains the shared recovery I/O ceiling
 * without multiplying it at nested tree levels.
 */
export async function removeTargetedTree(
	targetPath: string,
	treeFs?: Pick<AsyncTreeFs, "lstat" | "opendir" | "rename" | "unlink" | "rmdir">,
): Promise<void> {
	await withTargetedRemovalSlot(() => removeTree(targetPath, {
		fs: treeFs,
		force: true,
	}));
}

async function resolveRemotePrimary(repoPath: string, commandRunner: CommandRunner = realCommandRunner): Promise<string> {
	try {
		const { stdout } = await execGit(["symbolic-ref", "refs/remotes/origin/HEAD"], {
			cwd: repoPath,
			timeout: 5_000,
		}, commandRunner);
		// Returns e.g. "refs/remotes/origin/main\n" — extract "origin/main"
		const ref = stdout.trim().replace("refs/remotes/", "");
		if (ref) return ref;
	} catch {
		// symbolic-ref may fail if origin/HEAD is not set (e.g. bare init, no clone)
	}
	return "HEAD";
}

/**
 * Pure parser — splits a configured `base_ref` value into its component pieces.
 * Exported so sandbox-internal callers can use the same logic without an exec
 * round-trip. Does NOT consult disk; trim() and `origin/` stripping only.
 *
 * Examples:
 *   configured = ""            → { ref: "", branch: "", isRemote: false }   (sentinel: unset)
 *   configured = "  "          → { ref: "", branch: "", isRemote: false }   (whitespace == unset)
 *   configured = "master"      → { ref: "master", branch: "master", isRemote: false }
 *   configured = "origin/dev"  → { ref: "origin/dev", branch: "dev", isRemote: true }
 *   configured = "origin/feature/foo" → { ref: "origin/feature/foo", branch: "feature/foo", isRemote: true }
 *
 * Note: this is a pure parser. It does NOT validate grammar, reject tags, SHAs,
 * or non-`origin` prefixes — those are the REST handler's responsibility at
 * save time. By the time `parseBaseRef` runs, the value has already been
 * persisted to project config and is assumed well-formed.
 */
export function parseBaseRef(configured: string): { ref: string; branch: string; isRemote: boolean } {
	const trimmed = (configured ?? "").trim();
	if (!trimmed) return { ref: "", branch: "", isRemote: false };
	if (trimmed.startsWith("origin/")) {
		return { ref: trimmed, branch: trimmed.slice("origin/".length), isRemote: true };
	}
	return { ref: trimmed, branch: trimmed, isRemote: false };
}

/**
 * Host-side resolver for `base_ref`. Used by the bulk of the server.
 *   - configured non-empty → `parseBaseRef(configured)` (no exec).
 *   - configured empty/undefined → falls back to `resolveRemotePrimary(repoPath)`
 *     (today's behavior — `git symbolic-ref refs/remotes/origin/HEAD`).
 *
 * The fallback path returns the project's remote primary as `{ ref: "origin/main",
 * branch: "main", isRemote: true }`. If primary detection fails, returns
 * `{ ref: "HEAD", branch: "HEAD", isRemote: false }` — same sentinel as
 * `resolveRemotePrimary` returns.
 */
export async function resolveBaseRef(
	repoPath: string,
	configured: string | undefined,
	commandRunner: CommandRunner = realCommandRunner,
): Promise<{ ref: string; branch: string; isRemote: boolean }> {
	const parsed = parseBaseRef(configured ?? "");
	if (parsed.ref) return parsed;
	const remote = await resolveRemotePrimary(repoPath, commandRunner);
	if (remote.startsWith("origin/")) {
		return { ref: remote, branch: remote.slice("origin/".length), isRemote: true };
	}
	return { ref: remote, branch: remote, isRemote: false };
}

/**
 * Sandbox variant of `resolveBaseRef`. Used by `project-sandbox.ts` so the
 * container path doesn't pay an extra docker exec when configured is non-empty.
 *   - configured non-empty → `parseBaseRef` (no exec).
 *   - configured empty/undefined → `exec(["symbolic-ref", "refs/remotes/origin/HEAD"])`.
 *
 * The `exec` callback must run `git` inside the container with the worktree as
 * cwd, returning stdout. Errors are caught and the sentinel `HEAD` is returned
 * (matches `resolveRemotePrimary`'s fallback).
 */
export async function resolveBaseRefWithExec(
	exec: (args: string[]) => Promise<string>,
	configured: string | undefined,
): Promise<{ ref: string; branch: string; isRemote: boolean }> {
	const parsed = parseBaseRef(configured ?? "");
	if (parsed.ref) return parsed;
	try {
		const out = await exec(["symbolic-ref", "refs/remotes/origin/HEAD"]);
		const trimmed = out.trim().replace("refs/remotes/", "");
		if (trimmed.startsWith("origin/")) {
			return { ref: trimmed, branch: trimmed.slice("origin/".length), isRemote: true };
		}
		if (trimmed) return { ref: trimmed, branch: trimmed, isRemote: false };
	} catch {
		// symbolic-ref may fail if origin/HEAD is not set
	}
	return { ref: "HEAD", branch: "HEAD", isRemote: false };
}

/**
 * Parse the first `ref:` line of `git ls-remote --symref origin HEAD` output.
 * Returns the bare branch name (strips `refs/heads/`) or null if absent.
 * Pure parser — no exec, no disk access. Tolerant of tab/space separators and
 * CRLF line endings.
 *
 * Examples:
 *   "ref: refs/heads/master\tHEAD\n<sha>\tHEAD" → "master"
 *   "ref: refs/heads/feature/x\tHEAD"           → "feature/x"
 *   "<sha>\tHEAD"                               → null (no symref line)
 *   ""                                          → null
 */
export function parseLsRemoteSymref(output: string): string | null {
	for (const line of (output ?? "").split(/\r?\n/)) {
		const m = line.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/);
		if (m) return m[1];
	}
	return null;
}

/**
 * Best-effort: run `git ls-remote --symref origin HEAD` in `repoPath`, parse
 * the symref, and return `origin/<branch>` — or null on ANY failure (offline,
 * no remote, not a git repo, unparseable output). Never throws.
 *
 * Used to pin a concrete `base_ref` from the live remote at project-add time.
 * See docs/design/base-ref.md.
 */
export async function detectBaseRefFromRemote(repoPath: string, commandRunner: CommandRunner = realCommandRunner, remotePolicy: RemoteGitPolicy = DEFAULT_REMOTE_GIT_POLICY): Promise<string | null> {
	try {
		if (await shouldSkipRemoteGitForTests(repoPath, "origin", commandRunner, remotePolicy)) return null;
		const { stdout } = await execGit(["ls-remote", "--symref", "origin", "HEAD"], {
			cwd: repoPath,
			timeout: 10_000,
		}, commandRunner);
		const branch = parseLsRemoteSymref(stdout.toString());
		return branch ? `origin/${branch}` : null;
	} catch {
		return null;
	}
}

/** True iff `ref` resolves via `git rev-parse --verify` in repoPath. Never throws. */
export async function refExistsInRepo(repoPath: string, ref: string, commandRunner: CommandRunner = realCommandRunner): Promise<boolean> {
	try {
		await execGit(["rev-parse", "--verify", ref], { cwd: repoPath, timeout: 5_000 }, commandRunner);
		return true;
	} catch {
		return false;
	}
}

/** True iff the repository has a resolved HEAD commit. Never throws. */
export async function hasResolvedHead(repoPath: string, commandRunner: CommandRunner = realCommandRunner): Promise<boolean> {
	try {
		await execGit(["rev-parse", "--verify", "HEAD"], { cwd: repoPath, timeout: 5_000 }, commandRunner);
		return true;
	} catch {
		return false;
	}
}

/** Exec-injected variant for sandbox/container git callers. Never throws. */
export async function hasResolvedHeadWithExec(exec: (args: string[]) => Promise<string>): Promise<boolean> {
	try {
		await exec(["rev-parse", "--verify", "HEAD"]);
		return true;
	} catch {
		return false;
	}
}

/** Check if a directory is inside a git repository. */
export async function isGitRepo(cwd: string, commandRunner: CommandRunner = realCommandRunner): Promise<boolean> {
	try {
		await execGit(["rev-parse", "--is-inside-work-tree"], { cwd }, commandRunner);
		return true;
	} catch {
		return false;
	}
}

/** Get the git repo root for a directory. */
export async function getRepoRoot(cwd: string, commandRunner: CommandRunner = realCommandRunner): Promise<string> {
	const { stdout } = await execGit(["rev-parse", "--show-toplevel"], { cwd }, commandRunner);
	return stdout.toString().trim();
}

/**
 * Canonicalize a path for robust equality comparison: resolve to absolute,
 * follow symlinks via asynchronous `realpath` where possible (no-op when the
 * path doesn't exist), and lowercase on win32 where the filesystem is
 * case-insensitive. Mirrors the comparison style of
 * `worktree-pool.ts::resolveRepoToplevel`.
 */
async function canonicalizePath(p: string): Promise<string> {
	let resolved = path.resolve(p);
	try {
		resolved = await fs.promises.realpath(resolved);
	} catch {
		// realpath fails when the path doesn't exist — fall back to resolve().
	}
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Whether `dir` is the TOPLEVEL of a git working tree (i.e. a git repo ROOT),
 * NOT merely a directory nested somewhere inside one.
 *
 * `isGitRepo` (which runs `git rev-parse --is-inside-work-tree`) returns true
 * for ANY path inside a repo — including a non-git container that happens to be
 * nested under an unrelated parent git repo. That false-positive would cause
 * `createWorktreeSet` to run `git worktree add` against the container root. This
 * helper distinguishes the two by comparing the canonicalized
 * `git rev-parse --show-toplevel` against the canonicalized input dir.
 *
 * Returns false on any error (not a git repo, missing dir, git failure).
 */
export async function isGitRepoRoot(dir: string, commandRunner: CommandRunner = realCommandRunner): Promise<boolean> {
	try {
		const { stdout } = await execGit(["rev-parse", "--show-toplevel"], { cwd: dir }, commandRunner);
		const toplevel = stdout.toString().trim();
		if (!toplevel) return false;
		return await canonicalizePath(toplevel) === await canonicalizePath(dir);
	} catch {
		return false;
	}
}

/**
 * Resolve the canonical main-repo working directory to bind-mount as the sandbox
 * clone source.
 *
 * A linked git worktree's `.git` is a gitdir-FILE pointing at the main repo's
 * object store, not a real `.git` directory. Bind-mounting and `git clone`ing
 * just the worktree dir fails because the objects live in the main repo, which
 * isn't mounted. So we resolve the canonical MAIN repo root via
 * `git rev-parse --git-common-dir` and mount that instead.
 *
 * Returns the realpath of the main working tree (parent of the resolved
 * `.git`), or the realpath of the common dir itself for a bare repo. On any
 * failure, falls back to `canonicalizePath(repoPath)`. Always resolves symlinks
 * (defense in depth: the mount source is never an un-canonicalized path).
 */
export async function resolveSandboxMountRoot(repoPath: string, commandRunner: CommandRunner = realCommandRunner): Promise<string> {
	const realpath = async (p: string): Promise<string> => {
		try {
			return await fs.promises.realpath(p);
		} catch {
			return path.resolve(p);
		}
	};
	try {
		let commonDir: string;
		try {
			const { stdout } = await execGit(
				["-C", repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
				{ timeout: 5_000 },
				commandRunner,
			);
			commonDir = stdout.toString().trim();
		} catch {
			// Older git without --path-format: result may be relative to repoPath.
			const { stdout } = await execGit(["-C", repoPath, "rev-parse", "--git-common-dir"], {
				timeout: 5_000,
			}, commandRunner);
			commonDir = stdout.toString().trim();
		}
		if (!commonDir) return await canonicalizePath(repoPath);
		if (!path.isAbsolute(commonDir)) commonDir = path.resolve(repoPath, commonDir);
		const realCommon = await realpath(commonDir);
		// A non-bare repo's common dir ends in `.git` — the main working tree is its parent.
		if (path.basename(realCommon) === ".git") {
			return await realpath(path.dirname(realCommon));
		}
		// Bare repo — the common dir itself is the canonical source.
		return realCommon;
	} catch {
		return await canonicalizePath(repoPath);
	}
}

export interface CreateWorktreeOptions {
	startPoint?: string;
	worktreeRoot?: string;
	configuredBaseRef?: string;
	commandRunner?: CommandRunner;
	remotePolicy?: RemoteGitPolicy;
	/** @deprecated Ignored. Worktree creation is always local-only. */
	pushPolicy?: "local-only" | "publish";
	/** @deprecated Ignored. Worktree creation is always local-only. */
	skipPush?: boolean;
}

export interface CreateWorktreeSetOptions {
	worktreeRoot?: string;
	configuredBaseRef?: string;
	commandRunner?: CommandRunner;
	remotePolicy?: RemoteGitPolicy;
	/** Exact authoritative start commit/ref for each repository key. */
	startPointsByRepo?: Record<string, string>;
	/** @deprecated Ignored. Worktree creation is always local-only. */
	pushPolicy?: "local-only" | "publish";
	/** @deprecated Ignored. Worktree creation is always local-only. */
	skipPush?: boolean;
}

interface WorktreeSetRollbackEntry {
	repo: string;
	repoPath: string;
	worktreePath: string;
	deleteBranch: boolean;
}

/**
 * Remove only the known empty repo-key ancestors and branch container left
 * after a multi-repo worktree set has been cleaned. This deliberately uses
 * non-recursive rmdir calls so unexpected files are never removed.
 */
export async function removeEmptyWorktreeSetContainer(
	container: string,
	worktreePaths: Iterable<string>,
): Promise<void> {
	const containerPath = path.resolve(container);
	const ancestors = new Set<string>();
	for (const worktreePath of worktreePaths) {
		const relative = path.relative(containerPath, path.resolve(worktreePath));
		if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
		const parts = relative.split(path.sep);
		for (let i = 1; i < parts.length; i++) {
			ancestors.add(path.join(containerPath, ...parts.slice(0, i)));
		}
	}

	const failures: string[] = [];
	const targets = [...ancestors].sort((a, b) => b.length - a.length);
	targets.push(containerPath);
	for (const target of targets) {
		try {
			await fs.promises.rmdir(target);
		} catch (err: any) {
			if (err?.code !== "ENOENT") {
				failures.push(`${target}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}
	if (failures.length > 0) {
		throw new Error(failures.join("; "));
	}
}

async function rollbackWorktreeSet(
	entries: WorktreeSetRollbackEntry[],
	container: string,
	branchName: string,
	commandRunner: CommandRunner,
	remotePolicy: RemoteGitPolicy,
): Promise<string[]> {
	const failures: string[] = [];
	for (const entry of [...entries].reverse()) {
		try {
			await cleanupWorktree(
				entry.repoPath,
				entry.worktreePath,
				branchName,
				entry.deleteBranch,
				commandRunner,
				{ ...remotePolicy, skipRemotePush: true },
			);
			if (await pathExists(entry.worktreePath)) {
				failures.push(`component "${entry.repo}" cleanup left worktree at ${entry.worktreePath}`);
			}
		} catch (err) {
			failures.push(`component "${entry.repo}" cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	try {
		await removeEmptyWorktreeSetContainer(container, entries.map(entry => entry.worktreePath));
	} catch (err) {
		failures.push(`branch container cleanup failed at ${container}: ${err instanceof Error ? err.message : String(err)}`);
	}
	return failures;
}

export interface WorktreeResult {
	worktreePath: string;
	branchName: string;
}

/**
 * Create a git worktree on a new branch from a given start-point (default HEAD).
 * The worktree is placed as a sibling directory to the repo.
 *
 * Fully async — git operations are awaited without blocking the Node.js event
 * loop. Creation is local-only and never publishes the work branch.
 *
 * Per-component worktree setup is the responsibility of the caller —
 * invoke `runComponentSetups()` from `worktree-setup.ts` after this
 * function returns. `components[*].worktreeSetupCommand` is the single
 * source of truth.
 *
 * @param opts.startPoint — git ref to base the new branch on (default `"HEAD"`).
 *   Pass e.g. `origin/my-branch` to start from a remote tracking branch. When
 *   provided, this takes precedence over `configuredBaseRef`.
 * @param opts.configuredBaseRef — the project's configured `base_ref` setting.
 *   When `startPoint` is absent and this is non-empty, it drives both the
 *   worktree start-point and the branch upstream (via `--set-upstream-to`).
 *   Empty/undefined falls back to today's behavior (`resolveRemotePrimary`).
 *   Only fires `--set-upstream-to` when this is non-empty. Explicit-startPoint
 *   callers (for example hierarchical local branching) do not gain an upstream
 *   merely by creating a worktree.
 */
export async function createWorktree(repoPath: string, branchName: string, opts?: CreateWorktreeOptions): Promise<WorktreeResult> {
	const commandRunner = opts?.commandRunner ?? realCommandRunner;
	const remotePolicy = opts?.remotePolicy ?? DEFAULT_REMOTE_GIT_POLICY;
	const runGit = (args: readonly string[], options?: any) => execGit(args, options, commandRunner);
	// Validate repoPath asynchronously — execFile with a bad cwd throws a
	// misleading "spawn git ENOENT" that looks like git isn't installed.
	// Existence is part of this public error contract, so this policy check is
	// intentionally retained rather than delegated to the first Git command.
	if (!await pathExists(repoPath)) {
		throw new Error(`Cannot create worktree: repoPath does not exist: ${repoPath}`);
	}

	// Place all worktrees under a single sibling directory: <repo>-wt/ by default,
	// or under the project-level `worktree_root` override when provided.
	const wtRoot = wtRootHelper({ rootPath: repoPath, worktreeRoot: opts?.worktreeRoot });
	// branchName may contain slashes (e.g. "goal/slug-id"), flatten to a safe dirname
	const safeName = branchName.replace(/\//g, "-");
	const worktreePath = path.join(wtRoot, safeName);

	// Resolve the start point. Precedence:
	//   1. Explicit `opts.startPoint`           (e.g. team-manager's `origin/<goal-branch>`)
	//   2. `opts.configuredBaseRef` (non-empty)  (project's `base_ref` setting)
	//   3. `resolveRemotePrimary(repoPath)`     (today's fallback)
	// We capture whether the resolution came from a configured base so that:
	//   a) worktree-add failures emit the design-spec'd "base_ref no longer exists" message, and
	//   b) `--set-upstream-to=<configuredBaseRef>` fires post-creation.
	const configuredBaseRefTrimmed = (opts?.configuredBaseRef ?? "").trim();
	let startPoint = opts?.startPoint;
	let startPointFromConfiguredBase = false;
	let startPointFromImplicitFallback = false;
	if (!startPoint) {
		if (configuredBaseRefTrimmed) {
			startPoint = parseBaseRef(configuredBaseRefTrimmed).ref;
			startPointFromConfiguredBase = true;
		} else {
			startPoint = await resolveRemotePrimary(repoPath, commandRunner);
			startPointFromImplicitFallback = true;
		}
	}
	if (startPoint === "HEAD" && startPointFromImplicitFallback && !(await hasResolvedHead(repoPath))) {
		throw new UnresolvedHeadWorktreeError(repoPath);
	}

	// Fetch the start point to ensure it's up to date. Test harnesses must never
	// reach real remotes; local bare origins used by explicit remote specs remain allowed.
	try {
		if (!(await shouldSkipRemoteGitForTests(repoPath, "origin", commandRunner, remotePolicy))) {
			const remote = startPoint.startsWith("origin/") ? startPoint.replace("origin/", "") : startPoint;
			await runGit(["fetch", "origin", remote], { cwd: repoPath, timeout: 30_000 });
		}
	} catch {
		// Fetch failure is non-fatal — may be offline, or startPoint is a local ref
	}

	// Check if the branch already exists (e.g. from a previous interrupted attempt)
	let branchExists = false;
	try {
		await runGit(["rev-parse", "--verify", branchName], { cwd: repoPath });
		branchExists = true;
	} catch {
		// Branch doesn't exist — will create below
	}

	if (branchExists) {
		const dirExists = await pathExists(worktreePath);
		const gitFileExists = dirExists && await pathExists(path.join(worktreePath, ".git"));

		if (dirExists && gitFileExists) {
			// Worktree fully exists from a previous attempt — repair and reuse
			try {
				await runGit(["worktree", "repair"], { cwd: repoPath });
				console.log(`[git] Repaired existing worktree for branch "${branchName}" at ${worktreePath}`);
			} catch {
				// repair failed — still usable if .git exists
			}
		} else {
			// Branch exists but worktree is missing or partial — clean up and re-create.
			// Both removals are exact and operation-first; a missing target succeeds.
			const adminPath = path.join(repoPath, ".git", "worktrees", safeName);
			try { await removeTargetedTree(adminPath); } catch { /* best-effort */ }
			if (dirExists && !gitFileExists) {
				try { await removeTargetedTree(worktreePath); } catch { /* best-effort */ }
				if (await pathExists(worktreePath)) {
					throw new Error(`Cannot create worktree: directory "${worktreePath}" exists and could not be removed (file locks?)`);
				}
			}
			// Re-create worktree using existing branch (no -b)
			await runGit(["worktree", "add", worktreePath, branchName], { cwd: repoPath });
			console.log(`[git] Re-created worktree for existing branch "${branchName}" at ${worktreePath}`);
		}
	} else {
		// Branch doesn't exist — create branch and worktree in one step
		try {
			await runGit(["worktree", "add", "-b", branchName, worktreePath, startPoint], {
				cwd: repoPath,
			});
		} catch (err) {
			// If the start-point came from the project's configured `base_ref` and
			// the ref has since vanished (deleted on origin, renamed, etc.), emit
			// the design-spec'd actionable error so the user knows to fetch / fix
			// the setting. For explicit-startPoint callers we let git's error
			// bubble up unchanged.
			if (startPointFromConfiguredBase) {
				const repoName = path.basename(repoPath);
				throw new Error(
					`Failed to create worktree: base_ref '${configuredBaseRefTrimmed}' no longer exists in repo '${repoName}'. ` +
					`It may have been deleted on the remote since the project was configured. ` +
					`Run 'git fetch origin' to refresh, then update the base_ref setting if the branch was renamed.`,
				);
			}
			throw err;
		}
	}

	// A configured `base_ref` is a comparison/upstream baseline, not a request to
	// publish the work branch. Runs whether the base is local (`master`) or
	// remote (`origin/develop`) — save-time validation guarantees the ref
	// resolves at PUT time; the defence-in-depth try/catch below catches the
	// edge case where it has been deleted between save and worktree creation.
	if (configuredBaseRefTrimmed) {
		try {
			await runGit(["branch", `--set-upstream-to=${configuredBaseRefTrimmed}`, branchName], {
				cwd: worktreePath,
				timeout: 10_000,
			});
		} catch (err) {
			const stderr = err instanceof Error ? err.message : String(err);
			throw new Error(
				`Failed to set upstream for branch '${branchName}' to '${configuredBaseRefTrimmed}': ${stderr}. ` +
				`Check that the ref is still a valid branch.`,
			);
		}
	}

	return { worktreePath, branchName };
}

/**
 * Create a coordinated set of worktrees — one per distinct repo declared in
 * `components`. Single-repo (one component, repo===".") collapses to today's
 * `createWorktree` behavior identically; multi-repo creates a per-repo worktree
 * under `<wtRoot>/<branchSlug>/<repo>/` from each repo's source at
 * `<rootPath>/<repo>/`.
 *
 * Does NOT run per-component setup commands — caller is responsible for
 * invoking `runComponentSetups()` afterward.
 *
 * See docs/design/multi-repo-components.md §4 + §5.
 */
export async function createWorktreeSet(
	rootPath: string,
	components: Component[],
	branchName: string,
	baseBranch?: string,
	opts?: CreateWorktreeSetOptions,
): Promise<{ container: string; worktrees: Array<{ repo: string; repoPath: string; worktreePath: string }> }> {
	// Per-component worktree setup is the caller's responsibility — invoke
	// `runComponentSetups()` after this function returns.
	// Distinct repos in declared order.
	const seen = new Set<string>();
	const repos: string[] = [];
	for (const c of components) {
		if (!seen.has(c.repo)) { seen.add(c.repo); repos.push(c.repo); }
	}
	if (repos.length === 0) repos.push(".");  // defensive — empty components → single-repo

	const slug = branchToSlug(branchName);
	const configuredBaseRefTrimmed = (opts?.configuredBaseRef ?? "").trim();
	const commandRunner = opts?.commandRunner ?? realCommandRunner;
	const remotePolicy = opts?.remotePolicy ?? DEFAULT_REMOTE_GIT_POLICY;
	const startPointsByRepo = opts?.startPointsByRepo;
	const runGit = (args: readonly string[], options?: any) => execGit(args, options, commandRunner);

	// Single-repo path collapses to existing behavior. `configuredBaseRef`
	// flows through `createWorktree`, which handles start-point resolution and
	// the `--set-upstream-to` post-step uniformly with the standalone caller.
	if (repos.length === 1 && repos[0] === ".") {
		const result = await createWorktree(rootPath, branchName, {
			startPoint: baseBranch,
			worktreeRoot: opts?.worktreeRoot,
			configuredBaseRef: opts?.configuredBaseRef,
			commandRunner,
			remotePolicy,
		});
		return {
			container: result.worktreePath,
			worktrees: [{ repo: ".", repoPath: rootPath, worktreePath: result.worktreePath }],
		};
	}

	// Multi-repo: keep a distinct repo ONLY if its source dir is itself a git
	// repo ROOT. This skips, in one rule:
	//   • the non-git `.` container in a poly-repo (running `git worktree add`
	//     there fails with `fatal: not a git repository`),
	//   • the nested-parent false-positive — a non-git container nested under an
	//     UNRELATED parent git repo (where `isGitRepo` would return true), and
	//   • non-git sub-repos and missing source dirs (graceful no-worktree).
	// A `.` entry whose source IS a git repo root (genuine container-root
	// component) is kept. See docs/design/multi-repo-components.md.
	const repoList: string[] = [];
	for (const repo of repos) {
		const repoSrc = path.join(rootPath, repo === "." ? "" : repo);
		const hasExactStart = !!startPointsByRepo && Object.prototype.hasOwnProperty.call(startPointsByRepo, repo);
		if (!(await isGitRepoRoot(repoSrc, commandRunner))) {
			if (hasExactStart) {
				throw new Error(`createWorktreeSet: validate source repo failed for component "${repo}": ${repoSrc} is not a Git repository root`);
			}
			continue;
		}
		// When no explicit start point/base_ref is configured, this component would
		// fall back to literal HEAD. Skip unborn repos before git worktree sees an
		// invalid start point; explicit per-repo starts remain authoritative.
		if (!hasExactStart && !baseBranch && !configuredBaseRefTrimmed && !(await hasResolvedHead(repoSrc, commandRunner))) continue;
		repoList.push(repo);
	}

	// Multi-repo: container at `<wtRoot>/<branchSlug>/`, per-repo worktrees underneath.
	// `worktreeRoot` honors the project-level `worktree_root` override; falls back
	// to `<rootPath>-wt/` when unset.
	const wtRoot = wtRootHelper({ rootPath, worktreeRoot: opts?.worktreeRoot });
	const container = path.join(wtRoot, slug);

	// If no worktree-able repo remains after skipping the non-git container,
	// short-circuit WITHOUT creating the container directory. Callers treat an
	// empty `worktrees[]` as "no worktree-able repo" (graceful no-worktree).
	if (repoList.length === 0) {
		return { container, worktrees: [] };
	}

	// Operation-first creation is idempotent and avoids an exists/mkdir race.
	await fs.promises.mkdir(container, { recursive: true });

	const out: Array<{ repo: string; repoPath: string; worktreePath: string }> = [];
	const rollbackEntries: WorktreeSetRollbackEntry[] = [];
	try {
		for (const repo of repoList) {
			const repoSrc = path.join(rootPath, repo);
			const wtPath = path.join(container, repo);
			// Keep the existing actionable result if the source disappears after the
			// canonical repo-root scan and before this component is created.
			if (!await pathExists(repoSrc)) {
				throw new Error(`createWorktreeSet: validate source repo failed for component "${repo}": source repo not found at ${repoSrc}`);
			}
			// An exact per-repo start takes precedence over every shared fallback.
			const exactStart = startPointsByRepo && Object.prototype.hasOwnProperty.call(startPointsByRepo, repo)
				? startPointsByRepo[repo].trim()
				: undefined;
			let startPoint: string;
			let startPointFromConfiguredBase = false;
			if (exactStart !== undefined) {
				if (!exactStart) throw new Error(`createWorktreeSet: resolve exact start failed for component "${repo}": start point is empty`);
				startPoint = exactStart;
			} else if (baseBranch) {
				startPoint = baseBranch;
			} else if (configuredBaseRefTrimmed) {
				startPoint = parseBaseRef(configuredBaseRefTrimmed).ref;
				startPointFromConfiguredBase = true;
			} else {
				startPoint = await resolveRemotePrimary(repoSrc, commandRunner);
			}

			// Branch may already exist from a prior partial attempt.
			let branchExists = false;
			try {
				await runGit(["rev-parse", "--verify", branchName], { cwd: repoSrc });
				branchExists = true;
			} catch { /* not present */ }
			rollbackEntries.push({ repo, repoPath: repoSrc, worktreePath: wtPath, deleteBranch: !branchExists });

			try {
				if (branchExists) {
					await runGit(["worktree", "add", wtPath, branchName], { cwd: repoSrc });
				} else {
					await runGit(["worktree", "add", "-b", branchName, wtPath, startPoint], { cwd: repoSrc });
				}
			} catch (err) {
				if (startPointFromConfiguredBase && !branchExists) {
					throw new Error(
						`Failed to create worktree for component "${repo}": base_ref '${configuredBaseRefTrimmed}' no longer exists. ` +
						`It may have been deleted on the remote since the project was configured. ` +
						`Run 'git fetch origin' to refresh, then update the base_ref setting if the branch was renamed.`,
					);
				}
				throw new Error(`createWorktreeSet: git worktree add failed for component "${repo}" at ${wtPath}: ${err instanceof Error ? err.message : err}`);
			}

			// When the project has a configured `base_ref`, set it as the per-branch
			// upstream so each component's `@{u}` reflects the integration target.
			if (configuredBaseRefTrimmed) {
				try {
					await runGit(["branch", `--set-upstream-to=${configuredBaseRefTrimmed}`, branchName], {
						cwd: wtPath,
						timeout: 10_000,
					});
				} catch (err) {
					const stderr = err instanceof Error ? err.message : String(err);
					throw new Error(
						`Failed to set upstream for branch '${branchName}' to '${configuredBaseRefTrimmed}' in component "${repo}": ${stderr}. ` +
						`Check that the ref is still a valid branch.`,
					);
				}
			}

			out.push({ repo, repoPath: repoSrc, worktreePath: wtPath });
		}
	} catch (err) {
		const rollbackFailures = await rollbackWorktreeSet(rollbackEntries, container, branchName, commandRunner, remotePolicy);
		if (rollbackFailures.length > 0) {
			throw new Error(`${err instanceof Error ? err.message : String(err)}; rollback failures: ${rollbackFailures.join("; ")}`);
		}
		throw err;
	}

	return { container, worktrees: out };
}

/**
 * Remove a git worktree and optionally delete the branch.
 * Async to avoid blocking the Node.js event loop.
 */
export async function cleanupWorktree(
	repoPath: string,
	worktreePath: string,
	branchName?: string,
	deleteBranch = false,
	commandRunner: CommandRunner = realCommandRunner,
	remotePolicy: RemoteGitPolicy = DEFAULT_REMOTE_GIT_POLICY,
): Promise<void> {
	const runGit = (args: readonly string[], options?: any) => execGit(args, options, commandRunner);

	try {
		// Operation first: a successful Git removal needs no preliminary path
		// probe, and a missing worktree is handled by the targeted fallback below.
		await runGit(["worktree", "remove", worktreePath, "--force"], {
			cwd: repoPath,
		});
	} catch {
		// Preserve the old missing-repository warning/early return without making
		// every successful cleanup pay a check-then-act race.
		if (!await pathExists(repoPath)) {
			console.warn(`[git] Cannot clean up worktree: repoPath does not exist: ${repoPath}`);
			return;
		}

		// If remove fails, clean up the admin entry for this specific worktree
		// (NOT a blanket prune — that could damage other worktrees whose
		// directories exist but have broken .git metadata). `basename` keeps the
		// target to one direct admin child; an empty/root basename removes nothing.
		const trimmedWorktreePath = worktreePath.trim();
		const safeName = trimmedWorktreePath && trimmedWorktreePath !== "." && trimmedWorktreePath !== ".."
			? path.basename(path.resolve(trimmedWorktreePath))
			: "";
		if (safeName) {
			const adminPath = path.join(repoPath, ".git", "worktrees", safeName);
			try { await removeTargetedTree(adminPath); } catch { /* best-effort */ }
		}
	}

	if (deleteBranch && branchName) {
		try {
			await runGit(["branch", "-D", branchName], { cwd: repoPath });
		} catch {
			// branch may not exist
		}
		// Also delete the remote branch (best-effort — remote may be unreachable,
		// or the repo may have no remote configured, e.g. in E2E tests).
		if (!(await shouldSkipRemotePushForTests(repoPath, "origin", commandRunner, remotePolicy))) {
			try {
				await runGit(["push", "origin", "--delete", branchName], {
					cwd: repoPath,
					timeout: 15_000,
				});
			} catch {
				// Remote may not exist, branch may not be pushed, or network unreachable
			}
		}
	}
}

/**
 * Result of a local merge of a child goal's branch into its parent.
 *
 * Exactly one of `merged`, `alreadyMerged`, or `conflict` is true; the others
 * are false. `output` carries the raw stdout/stderr from `git merge` for
 * forensic logging.
 */
export interface MergeChildResult {
	merged: boolean;
	conflict: boolean;
	alreadyMerged: boolean;
	output: string;
}

/**
 * Locally merge `childBranch` into `parentBranch` from inside `parentCwd`
 * (the parent goal's worktree). Wraps `git merge --no-ff` and aborts on
 * conflict so the parent worktree is left clean.
 *
 * Contract:
 *   - The current branch in `parentCwd` MUST equal `parentBranch` — guards
 *     against merging into the wrong tree (security / data-safety).
 *   - `git fetch origin <childBranch>` is best-effort: child branches may be
 *     local-only (siblings spawned but not yet pushed); fetch failure is
 *     non-fatal.
 *   - "Already up to date" / "Already up-to-date" output → `alreadyMerged`.
 *   - On conflict: runs `git merge --abort` so the parent worktree returns
 *     to a clean state. Caller decides whether to surface to the user.
 *   - On clean merge: returns `{ merged: true }` with the local merge-commit
 *     message in `output`. This helper never publishes the merge; publication
 *     is a separate operation that must be explicitly requested elsewhere.
 *
 * Anti-pattern (see SUBGOALS-SPEC §9): NEVER auto-resolve conflicts.
 * Escalate to the user.
 */
export async function mergeChildBranchLocal(
	parentBranch: string,
	childBranch: string,
	parentCwd: string,
	commandRunner: CommandRunner = realCommandRunner,
	remotePolicy: RemoteGitPolicy = DEFAULT_REMOTE_GIT_POLICY,
): Promise<MergeChildResult> {
	if (!parentBranch || !childBranch) {
		throw new Error(`mergeChildBranchLocal: parentBranch and childBranch are required (got "${parentBranch}", "${childBranch}")`);
	}
	if (!fs.existsSync(parentCwd)) {
		throw new Error(`mergeChildBranchLocal: parentCwd does not exist: ${parentCwd}`);
	}

	// Verify the parent worktree is actually checked out on parentBranch.
	// Mismatch is a programming error — prevents merging child into the
	// wrong tree (e.g. into master or a sibling goal).
	let currentBranch = "";
	try {
		const { stdout } = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: parentCwd, timeout: 5_000 }, commandRunner);
		currentBranch = stdout.toString().trim();
	} catch (err) {
		throw new Error(`mergeChildBranchLocal: failed to read current branch in ${parentCwd}: ${err instanceof Error ? err.message : err}`);
	}
	if (currentBranch !== parentBranch) {
		throw new Error(
			`mergeChildBranchLocal: parentCwd "${parentCwd}" is on branch "${currentBranch}", expected "${parentBranch}"`,
		);
	}

	// Best-effort fetch — child branch may be local-only. In tests, only local
	// bare origins are allowed so the suite never contacts a real remote.
	try {
		if (!(await shouldSkipRemoteGitForTests(parentCwd, "origin", commandRunner, remotePolicy))) {
			await execGit(["fetch", "origin", childBranch], { cwd: parentCwd, timeout: 30_000 }, commandRunner);
		}
	} catch {
		// non-fatal
	}

	// Attempt the merge.
	let mergeStdout = "";
	let mergeStderr = "";
	let mergeExitCode = 0;
	try {
		const { stdout, stderr } = await execGit([
			"merge", "--no-ff", childBranch,
			"-m", `Merge child goal branch ${childBranch} into ${parentBranch}`,
		], { cwd: parentCwd, timeout: 60_000 }, commandRunner);
		mergeStdout = stdout.toString();
		mergeStderr = stderr.toString();
	} catch (err: any) {
		mergeStdout = err?.stdout?.toString() ?? "";
		mergeStderr = err?.stderr?.toString() ?? (err instanceof Error ? err.message : String(err));
		mergeExitCode = typeof err?.code === "number" ? err.code : 1;
	}

	const combinedOutput = `${mergeStdout}${mergeStderr ? "\n" + mergeStderr : ""}`.trim();

	// "Already up to date" — exit code 0, no merge commit produced.
	if (mergeExitCode === 0 && /Already up[- ]to[- ]date/i.test(combinedOutput)) {
		return { merged: false, alreadyMerged: true, conflict: false, output: combinedOutput };
	}

	if (mergeExitCode !== 0) {
		// Distinguish conflict (unmerged paths in `git status --porcelain`)
		// from other failures. Conflict markers in porcelain output are
		// the two-letter codes UU, AU, UA, DU, UD, AA, DD.
		let porcelain = "";
		try {
			const { stdout } = await execGit(["status", "--porcelain"], { cwd: parentCwd, timeout: 5_000 }, commandRunner);
			porcelain = stdout.toString();
		} catch {
			// ignore — fall through with empty porcelain
		}
		const hasUnmerged = /^(UU|AU|UA|DU|UD|AA|DD) /m.test(porcelain);
		if (hasUnmerged) {
			// Abort so the parent worktree returns to a clean state.
			try {
				await execGit(["merge", "--abort"], { cwd: parentCwd, timeout: 10_000 }, commandRunner);
			} catch {
				// best-effort — if abort itself fails the worktree is in a
				// genuinely broken state, but we still surface the conflict.
			}
			return { merged: false, alreadyMerged: false, conflict: true, output: combinedOutput };
		}
		// Non-conflict failure (e.g. "fatal: not something we can merge" /
		// no upstream / unknown ref). Surface as a thrown error — caller
		// must distinguish a true config bug from a content conflict.
		throw new Error(`mergeChildBranchLocal: merge failed (exit ${mergeExitCode}): ${combinedOutput}`);
	}

	return { merged: true, alreadyMerged: false, conflict: false, output: combinedOutput };
}

/**
 * Recover a worktree whose directory is missing but whose branch still exists.
 *
 * This happens when a worktree directory is deleted (e.g. by cleanup, crash,
 * or manual removal) but the branch is preserved locally or on the remote.
 *
 * Steps:
 * 1. Prune stale worktree references (git tracks worktrees and will refuse
 *    to create one if it thinks the old one still exists)
 * 2. Fetch from origin to ensure we have the latest branch ref
 * 3. Re-create the worktree, checking out the existing branch
 *
 * Per-component setup is the caller's responsibility — invoke
 * `runComponentSetups()` after this function returns.
 *
 * @returns The worktree path, or null if recovery failed
 */
export async function recoverWorktree(
	repoPath: string,
	branchName: string,
	worktreePath: string,
	commandRunner: CommandRunner = realCommandRunner,
	remotePolicy: RemoteGitPolicy = DEFAULT_REMOTE_GIT_POLICY,
): Promise<string | null> {
	const runGit = (args: readonly string[], options?: any) => execGit(args, options, commandRunner);
	if (!fs.existsSync(repoPath)) {
		console.warn(`[git] Cannot recover worktree: repoPath does not exist: ${repoPath}`);
		return null;
	}

	try {
		const dirExists = fs.existsSync(worktreePath);
		const gitFileExists = dirExists && fs.existsSync(path.join(worktreePath, ".git"));

		if (dirExists && gitFileExists) {
			// Directory and .git exist — try `git worktree repair` to fix any
			// path mismatches (e.g. worktree was moved or .git/worktrees entry is stale).
			try {
				await runGit(["worktree", "repair"], { cwd: repoPath });
				console.log(`[git] Repaired worktree for branch "${branchName}" at ${worktreePath}`);
				return worktreePath;
			} catch {
				// repair failed — fall through to full recovery
			}
		}

		if (dirExists && !gitFileExists) {
			// Directory exists but .git metadata is gone (e.g. partial git worktree
			// remove on Windows, or worktree entry pruned while files remain).
			// Try to restore the .git pointer file and repair in-place — this avoids
			// having to delete the directory (which fails on Windows due to file locks
			// in node_modules/.bin, etc.).
			const safeName = path.basename(worktreePath);
			const adminPath = path.join(repoPath, ".git", "worktrees", safeName);
			if (fs.existsSync(adminPath)) {
				// Admin entry exists — restore the .git pointer file
				const gitdirTarget = adminPath.split(path.sep).join("/");
				try {
					fs.writeFileSync(path.join(worktreePath, ".git"), `gitdir: ${gitdirTarget}\n`);
					// Update admin entry's gitdir to point back to this worktree
					fs.writeFileSync(path.join(adminPath, "gitdir"), worktreePath.split(path.sep).join("/") + "/.git\n");
					await runGit(["worktree", "repair"], { cwd: repoPath });
					console.log(`[git] Restored .git pointer and repaired worktree for branch "${branchName}" at ${worktreePath}`);
					return worktreePath;
				} catch (repairErr) {
					console.warn(`[git] Failed to repair worktree in-place for "${branchName}", falling back to recreate:`, repairErr);
					// Clean up the potentially bad .git file
					try { fs.rmSync(path.join(worktreePath, ".git"), { force: true }); } catch { /* best-effort */ }
					try { fs.rmSync(adminPath, { recursive: true, force: true }); } catch { /* best-effort */ }
				}
			}
		} else if (!dirExists) {
			// Directory doesn't exist — remove the stale admin entry if present.
			// Use targeted removal instead of blanket prune.
			const safeName = path.basename(worktreePath);
			const adminPath = path.join(repoPath, ".git", "worktrees", safeName);
			if (fs.existsSync(adminPath)) {
				try { fs.rmSync(adminPath, { recursive: true, force: true }); } catch { /* best-effort */ }
			}
		}

		// Fetch to make sure we have the branch ref. In tests, only local bare
		// origins are allowed so recovery never contacts a real remote.
		try {
			if (!(await shouldSkipRemoteGitForTests(repoPath, "origin", commandRunner, remotePolicy))) {
				await runGit(["fetch", "origin", branchName], {
					cwd: repoPath,
					timeout: 30_000,
				});
			}
		} catch {
			// Fetch failure is non-fatal — branch may exist locally
		}

		// Check if the branch exists locally
		let branchExists = false;
		try {
			await runGit(["rev-parse", "--verify", branchName], { cwd: repoPath });
			branchExists = true;
		} catch {
			// Try the remote tracking branch
			try {
				await runGit(["rev-parse", "--verify", `origin/${branchName}`], { cwd: repoPath });
			} catch {
				console.warn(`[git] Cannot recover worktree: branch "${branchName}" not found locally or on remote`);
				return null;
			}
		}

		// If directory still exists with no .git (in-place repair failed or no admin entry),
		// remove it so git worktree add can recreate it.
		if (fs.existsSync(worktreePath) && !fs.existsSync(path.join(worktreePath, ".git"))) {
			try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* best-effort */ }
		}

		// If the directory still exists after rmSync (Windows file locks), we can't proceed
		if (fs.existsSync(worktreePath)) {
			console.warn(`[git] Cannot recover worktree: directory "${worktreePath}" exists and could not be removed (file locks?)`);
			return null;
		}

		// Create the worktree — use existing branch (no -b) or track from remote
		if (branchExists) {
			await runGit(["worktree", "add", worktreePath, branchName], { cwd: repoPath });
		} else {
			// Create local branch tracking the remote
			await runGit(["worktree", "add", "-b", branchName, worktreePath, `origin/${branchName}`], { cwd: repoPath });
		}

		console.log(`[git] Recovered worktree for branch "${branchName}" at ${worktreePath}`);
		return worktreePath;
	} catch (err) {
		console.error(`[git] Failed to recover worktree for branch "${branchName}":`, err);
		return null;
	}
}
