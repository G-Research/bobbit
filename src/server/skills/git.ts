import { execFile as execFileCb } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { cpuDiagnosticsEnabled, getCpuDiagnostics } from "../agent/cpu-diagnostics.js";
import type { Component } from "../agent/project-config-store.js";
import { branchToSlug, worktreeRoot as wtRootHelper } from "./worktree-paths.js";

const execFile = promisify(execFileCb);

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
): Promise<{ stdout: string; stderr: string }> {
	if (!cpuDiagnosticsEnabled()) {
		return await execFile("git", args, options) as unknown as { stdout: string; stderr: string };
	}
	const start = performance.now();
	let success = 0;
	let errorCode = "none";
	try {
		const result = await execFile("git", args, options) as unknown as { stdout: string; stderr: string };
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

/**
 * Whether remote git push operations should be skipped.
 * Set BOBBIT_TEST_NO_PUSH=1 in E2E tests to prevent any network traffic to GitHub.
 */
export function shouldSkipRemotePush(): boolean {
	return process.env.BOBBIT_TEST_NO_PUSH === "1";
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
 * templates as `{{master}}`.
 */
export async function detectPrimaryBranch(cwd: string): Promise<string> {
	try {
		const { stdout } = await execGit(["symbolic-ref", "refs/remotes/origin/HEAD"], {
			cwd,
			timeout: 5_000,
		});
		const ref = stdout.trim().replace("refs/remotes/origin/", "");
		if (ref) return ref;
	} catch { /* fall through */ }
	try {
		await execGit(["rev-parse", "--verify", "refs/heads/master"], { cwd, timeout: 5_000 });
		return "master";
	} catch { /* ignore */ }
	try {
		await execGit(["rev-parse", "--verify", "refs/heads/main"], { cwd, timeout: 5_000 });
		return "main";
	} catch { /* ignore */ }
	console.warn(`[git] detectPrimaryBranch(${cwd}): could not detect primary branch; defaulting to "master"`);
	return "master";
}

async function resolveRemotePrimary(repoPath: string): Promise<string> {
	try {
		const { stdout } = await execGit(["symbolic-ref", "refs/remotes/origin/HEAD"], {
			cwd: repoPath,
			timeout: 5_000,
		});
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
): Promise<{ ref: string; branch: string; isRemote: boolean }> {
	const parsed = parseBaseRef(configured ?? "");
	if (parsed.ref) return parsed;
	const remote = await resolveRemotePrimary(repoPath);
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
export async function detectBaseRefFromRemote(repoPath: string): Promise<string | null> {
	try {
		const { stdout } = await execGit(["ls-remote", "--symref", "origin", "HEAD"], {
			cwd: repoPath,
			timeout: 10_000,
		});
		const branch = parseLsRemoteSymref(stdout.toString());
		return branch ? `origin/${branch}` : null;
	} catch {
		return null;
	}
}

/** True iff `ref` resolves via `git rev-parse --verify` in repoPath. Never throws. */
export async function refExistsInRepo(repoPath: string, ref: string): Promise<boolean> {
	try {
		await execGit(["rev-parse", "--verify", ref], { cwd: repoPath, timeout: 5_000 });
		return true;
	} catch {
		return false;
	}
}

/** Check if a directory is inside a git repository. */
export async function isGitRepo(cwd: string): Promise<boolean> {
	try {
		await execGit(["rev-parse", "--is-inside-work-tree"], { cwd });
		return true;
	} catch {
		return false;
	}
}

/** Get the git repo root for a directory. */
export async function getRepoRoot(cwd: string): Promise<string> {
	const { stdout } = await execGit(["rev-parse", "--show-toplevel"], { cwd });
	return stdout.toString().trim();
}

/**
 * Canonicalize a path for robust equality comparison: resolve to absolute,
 * follow symlinks via `realpathSync.native` where possible (no-op when the
 * path doesn't exist), and lowercase on win32 where the filesystem is
 * case-insensitive. Mirrors the comparison style of
 * `worktree-pool.ts::resolveRepoToplevel`.
 */
function canonicalizePath(p: string): string {
	let resolved = path.resolve(p);
	try {
		resolved = fs.realpathSync.native(resolved);
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
export async function isGitRepoRoot(dir: string): Promise<boolean> {
	try {
		const { stdout } = await execGit(["rev-parse", "--show-toplevel"], { cwd: dir });
		const toplevel = stdout.toString().trim();
		if (!toplevel) return false;
		return canonicalizePath(toplevel) === canonicalizePath(dir);
	} catch {
		return false;
	}
}

export interface WorktreeResult {
	worktreePath: string;
	branchName: string;
}

/**
 * Create a git worktree on a new branch from a given start-point (default HEAD).
 * The worktree is placed as a sibling directory to the repo.
 *
 * Fully async — the `git worktree add` and `git push` are all awaited
 * without blocking the Node.js event loop.
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
 *   Only fires `--set-upstream-to` when this is non-empty — explicit-startPoint
 *   callers (e.g. team-manager's hierarchical branching) keep today's
 *   `origin/<branch>` upstream semantics after a safe explicit-refspec publish.
 */
export async function createWorktree(repoPath: string, branchName: string, opts?: { startPoint?: string; skipPush?: boolean; worktreeRoot?: string; configuredBaseRef?: string }): Promise<WorktreeResult> {
	// Validate repoPath exists — execFile with a bad cwd throws a misleading
	// "spawn git ENOENT" that looks like git isn't installed
	if (!fs.existsSync(repoPath)) {
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
	if (!startPoint) {
		if (configuredBaseRefTrimmed) {
			startPoint = parseBaseRef(configuredBaseRefTrimmed).ref;
			startPointFromConfiguredBase = true;
		} else {
			startPoint = await resolveRemotePrimary(repoPath);
		}
	}

	// Fetch the start point to ensure it's up to date
	try {
		const remote = startPoint.startsWith("origin/") ? startPoint.replace("origin/", "") : startPoint;
		await execGit(["fetch", "origin", remote], { cwd: repoPath, timeout: 30_000 });
	} catch {
		// Fetch failure is non-fatal — may be offline, or startPoint is a local ref
	}

	// Check if the branch already exists (e.g. from a previous interrupted attempt)
	let branchExists = false;
	try {
		await execGit(["rev-parse", "--verify", branchName], { cwd: repoPath });
		branchExists = true;
	} catch {
		// Branch doesn't exist — will create below
	}

	if (branchExists) {
		const dirExists = fs.existsSync(worktreePath);
		const gitFileExists = dirExists && fs.existsSync(path.join(worktreePath, ".git"));

		if (dirExists && gitFileExists) {
			// Worktree fully exists from a previous attempt — repair and reuse
			try {
				await execGit(["worktree", "repair"], { cwd: repoPath });
				console.log(`[git] Repaired existing worktree for branch "${branchName}" at ${worktreePath}`);
			} catch {
				// repair failed — still usable if .git exists
			}
		} else {
			// Branch exists but worktree is missing or partial — clean up and re-create
			const adminPath = path.join(repoPath, ".git", "worktrees", safeName);
			if (fs.existsSync(adminPath)) {
				try { fs.rmSync(adminPath, { recursive: true, force: true }); } catch { /* best-effort */ }
			}
			if (dirExists && !gitFileExists) {
				try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* best-effort */ }
				if (fs.existsSync(worktreePath)) {
					throw new Error(`Cannot create worktree: directory "${worktreePath}" exists and could not be removed (file locks?)`);
				}
			}
			// Re-create worktree using existing branch (no -b)
			await execGit(["worktree", "add", worktreePath, branchName], { cwd: repoPath });
			console.log(`[git] Re-created worktree for existing branch "${branchName}" at ${worktreePath}`);
		}
	} else {
		// Branch doesn't exist — create branch and worktree in one step
		try {
			await execGit(["worktree", "add", "-b", branchName, worktreePath, startPoint], {
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

	// Push the new branch with an explicit destination refspec so inherited
	// upstream config (for example origin/master) can never redirect the publish.
	// Set upstream tracking only after that safe publish succeeds so git-status can
	// report ahead/behind and `git rev-parse @{u}` doesn't emit "fatal: no upstream" errors.
	if (!opts?.skipPush && !shouldSkipRemotePush()) {
		try {
			await execGit(["push", "origin", `${branchName}:refs/heads/${branchName}`], {
				cwd: worktreePath,
				timeout: 30_000, // 30s max for push
			});
			await execGit(["fetch", "origin", `refs/heads/${branchName}:refs/remotes/origin/${branchName}`], {
				cwd: worktreePath,
				timeout: 15_000,
			});
			await execGit(["branch", `--set-upstream-to=origin/${branchName}`, branchName], {
				cwd: worktreePath,
				timeout: 10_000,
			});
		} catch {
			// Push/upstream setup may fail (no remote, auth issues, offline) — not fatal
		}
	}

	// When the project has a configured `base_ref`, override the per-branch
	// upstream so `@{u}` (and the ahead/behind pair in git-status-native) points
	// at the configured integration target rather than `origin/<branch>` created
	// above. Runs whether the base is local (`master`) or
	// remote (`origin/develop`) — save-time validation guarantees the ref
	// resolves at PUT time; the defence-in-depth try/catch below catches the
	// edge case where it has been deleted between save and worktree creation.
	if (configuredBaseRefTrimmed) {
		try {
			await execGit(["branch", `--set-upstream-to=${configuredBaseRefTrimmed}`, branchName], {
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
	opts?: { worktreeRoot?: string; configuredBaseRef?: string },
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

	// Single-repo path collapses to existing behavior. `configuredBaseRef`
	// flows through `createWorktree`, which handles start-point resolution and
	// the `--set-upstream-to` post-step uniformly with the standalone caller.
	if (repos.length === 1 && repos[0] === ".") {
		const result = await createWorktree(rootPath, branchName, {
			startPoint: baseBranch,
			skipPush: true,
			worktreeRoot: opts?.worktreeRoot,
			configuredBaseRef: opts?.configuredBaseRef,
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
		if (await isGitRepoRoot(repoSrc)) repoList.push(repo);
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

	if (!fs.existsSync(container)) {
		fs.mkdirSync(container, { recursive: true });
	}

	const configuredBaseRefTrimmed = (opts?.configuredBaseRef ?? "").trim();

	const out: Array<{ repo: string; repoPath: string; worktreePath: string }> = [];
	for (const repo of repoList) {
		const repoSrc = path.join(rootPath, repo);
		const wtPath = path.join(container, repo);
		if (!fs.existsSync(repoSrc)) {
			throw new Error(`createWorktreeSet: source repo not found: ${repoSrc}`);
		}
		// Start-point precedence mirrors `createWorktree`:
		//   1. explicit `baseBranch` arg            (per-call override)
		//   2. `opts.configuredBaseRef` (non-empty) (project's `base_ref` setting)
		//   3. `resolveRemotePrimary(repoSrc)`     (today's fallback)
		let startPoint: string;
		let startPointFromConfiguredBase = false;
		if (baseBranch) {
			startPoint = baseBranch;
		} else if (configuredBaseRefTrimmed) {
			startPoint = parseBaseRef(configuredBaseRefTrimmed).ref;
			startPointFromConfiguredBase = true;
		} else {
			startPoint = await resolveRemotePrimary(repoSrc);
		}

		// Branch may already exist from a prior partial attempt.
		let branchExists = false;
		try {
			await execGit(["rev-parse", "--verify", branchName], { cwd: repoSrc });
			branchExists = true;
		} catch { /* not present */ }

		try {
			if (branchExists) {
				await execGit(["worktree", "add", wtPath, branchName], { cwd: repoSrc });
			} else {
				await execGit(["worktree", "add", "-b", branchName, wtPath, startPoint], { cwd: repoSrc });
			}
		} catch (err) {
			if (startPointFromConfiguredBase && !branchExists) {
				// Configured base ref disappeared between save and creation in this
				// component repo. Emit the design-spec'd actionable message naming
				// the repo so the user knows which one to `git fetch origin` in.
				throw new Error(
					`Failed to create worktree: base_ref '${configuredBaseRefTrimmed}' no longer exists in repo '${repo}'. ` +
					`It may have been deleted on the remote since the project was configured. ` +
					`Run 'git fetch origin' to refresh, then update the base_ref setting if the branch was renamed.`,
				);
			}
			throw new Error(`createWorktreeSet: git worktree add failed for repo "${repo}" at ${wtPath}: ${err instanceof Error ? err.message : err}`);
		}

		// When the project has a configured `base_ref`, override per-branch
		// upstream so each component's `@{u}` reflects the integration target.
		// Single-repo path delegates to `createWorktree` above, which handles
		// this; the multi-repo loop must do it explicitly per worktree because
		// it skips the `push -u` step entirely.
		if (configuredBaseRefTrimmed) {
			try {
				await execGit(["branch", `--set-upstream-to=${configuredBaseRefTrimmed}`, branchName], {
					cwd: wtPath,
					timeout: 10_000,
				});
			} catch (err) {
				const stderr = err instanceof Error ? err.message : String(err);
				throw new Error(
					`Failed to set upstream for branch '${branchName}' to '${configuredBaseRefTrimmed}' in repo '${repo}': ${stderr}. ` +
					`Check that the ref is still a valid branch.`,
				);
			}
		}

		out.push({ repo, repoPath: repoSrc, worktreePath: wtPath });
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
): Promise<void> {
	if (!fs.existsSync(repoPath)) {
		console.warn(`[git] Cannot clean up worktree: repoPath does not exist: ${repoPath}`);
		return;
	}

	try {
		await execGit(["worktree", "remove", worktreePath, "--force"], {
			cwd: repoPath,
		});
	} catch {
		// If remove fails, clean up the admin entry for this specific worktree
		// (NOT a blanket prune — that could damage other worktrees whose
		// directories exist but have broken .git metadata).
		try {
			const safeName = path.basename(worktreePath);
			const adminPath = path.join(repoPath, ".git", "worktrees", safeName);
			if (fs.existsSync(adminPath)) {
				fs.rmSync(adminPath, { recursive: true, force: true });
			}
		} catch {
			// ignore
		}
	}

	if (deleteBranch && branchName) {
		try {
			await execGit(["branch", "-D", branchName], { cwd: repoPath });
		} catch {
			// branch may not exist
		}
		// Also delete the remote branch (best-effort — remote may be unreachable,
		// or the repo may have no remote configured, e.g. in E2E tests).
		if (!shouldSkipRemotePush()) {
			try {
				await execGit(["push", "origin", "--delete", branchName], {
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
): Promise<string | null> {
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
				await execGit(["worktree", "repair"], { cwd: repoPath });
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
					await execGit(["worktree", "repair"], { cwd: repoPath });
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

		// Fetch to make sure we have the branch ref
		try {
			await execGit(["fetch", "origin", branchName], {
				cwd: repoPath,
				timeout: 30_000,
			});
		} catch {
			// Fetch failure is non-fatal — branch may exist locally
		}

		// Check if the branch exists locally
		let branchExists = false;
		try {
			await execGit(["rev-parse", "--verify", branchName], { cwd: repoPath });
			branchExists = true;
		} catch {
			// Try the remote tracking branch
			try {
				await execGit(["rev-parse", "--verify", `origin/${branchName}`], { cwd: repoPath });
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
			await execGit(["worktree", "add", worktreePath, branchName], { cwd: repoPath });
		} else {
			// Create local branch tracking the remote
			await execGit(["worktree", "add", "-b", branchName, worktreePath, `origin/${branchName}`], { cwd: repoPath });
		}

		console.log(`[git] Recovered worktree for branch "${branchName}" at ${worktreePath}`);
		return worktreePath;
	} catch (err) {
		console.error(`[git] Failed to recover worktree for branch "${branchName}":`, err);
		return null;
	}
}
