/**
 * Native parallel git-status implementation. Replaces the legacy single-spawn
 * Git Bash batch script for the host path; preserves the batched docker exec
 * script for the container path.
 *
 * Host path: spawns `git` directly via execFile in two phases:
 *   Phase A — six parallel calls (HEAD, origin/HEAD, master, main, porcelain, @{u})
 *   Phase B — one verify of `origin/<primary>` then four parallel rev-list counts
 *
 * Per-call timeout 3 s; worst-case wall-clock = 2 × 3 s = 6 s. Typical p50 on
 * Windows: 50–150 ms; on Linux: 10–30 ms.
 *
 * Container path: keep one `docker exec sh -c <batch>` invocation — single
 * round-trip is faster than 11 × docker exec on Windows.
 *
 * See `docs/internals.md` (Git status cache section) and the design doc on
 * the goal "Faster git status".
 */
import { execFile as execFileCb } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { cpuDiagnosticsEnabled, getCpuDiagnostics } from "../agent/cpu-diagnostics.js";
import type { GitStatusResult } from "../server.js";
import { parseBaseRef } from "./git.js";
import { type RuntimeBin, DEFAULT_RUNTIME_BIN } from "../agent/runtime-bin.js";

const execFileAsync = promisify(execFileCb);

function childErrorCode(err: unknown): string {
	const code = (err as { code?: unknown } | null)?.code;
	return typeof code === "string" || typeof code === "number" ? String(code) : "error";
}

function statusGitOperation(args: readonly string[]): string {
	const [cmd, sub] = args;
	if (cmd === "-c") return "status";
	if (cmd === "rev-list") return "rev-list";
	if (cmd === "rev-parse") return "rev-parse";
	if (cmd === "symbolic-ref") return "symbolic-ref";
	if (cmd === "diff") return "diff";
	return sub ? `${cmd} ${sub}` : (cmd || "git");
}

export interface BatchGitStatusOpts {
	/** When true, runs porcelain with -uall (untracked included). Default false → -uno. */
	untracked?: boolean;
	/** When set, all git invocations route through `<runtime> exec -w cwd <cid> git ...`. */
	containerId?: string;
	/** Container CLI binary to spawn when `containerId` is set. Defaults to "docker". */
	runtime?: RuntimeBin;
	/**
	 * Project-level `base_ref` configuration. When non-empty, drives the
	 * `primaryBranch` used for `aheadOfPrimary`/`behindPrimary` counters,
	 * overriding the default `origin/HEAD` resolution. Empty/undefined →
	 * preserves today's behaviour (`symbolic-ref refs/remotes/origin/HEAD`
	 * with `master`/`main` fallback).
	 *
	 * See `docs/design/base-ref.md`.
	 */
	configuredBaseRef?: string;
}

const PER_CALL_TIMEOUT_MS = 3000;
const CONTAINER_BATCH_TIMEOUT_MS = 15000;

/** Spawn `git` (or `docker exec ... git`) and capture stdout. Never throws —
 * returns `{ ok: false, stdout: "" }` on any failure (non-zero exit, timeout,
 * spawn error). Argv array — never goes through a shell.
 *
 * `trim` defaults to true (strip surrounding whitespace, mirroring the legacy
 * bash script's behavior for single-line metadata). Pass `trim: false` for
 * porcelain output where leading spaces in status codes are significant. */
async function runGit(
	args: string[],
	cwd: string,
	containerId?: string,
	timeoutMs = PER_CALL_TIMEOUT_MS,
	trim = true,
	runtime: RuntimeBin = DEFAULT_RUNTIME_BIN,
): Promise<{ stdout: string; ok: boolean }> {
	const diagEnabled = cpuDiagnosticsEnabled();
	const diagStart = diagEnabled ? performance.now() : 0;
	let success = 0;
	let errorCode = "none";
	try {
		let stdout: string;
		if (containerId) {
			const r = await execFileAsync(
				runtime,
				["exec", "-w", cwd, containerId, "git", ...args],
				{ encoding: "utf-8", timeout: timeoutMs, windowsHide: true },
			);
			stdout = r.stdout;
		} else {
			const r = await execFileAsync("git", args, {
				cwd,
				encoding: "utf-8",
				timeout: timeoutMs,
				windowsHide: true,
			});
			stdout = r.stdout;
		}
		success = 1;
		return { stdout: trim ? stdout.trim() : stdout.replace(/\r?\n$/, ""), ok: true };
	} catch (err) {
		errorCode = childErrorCode(err);
		return { stdout: "", ok: false };
	} finally {
		if (diagEnabled) {
			getCpuDiagnostics().recordChildProcess(containerId ? "docker exec git status" : "git status", performance.now() - diagStart, {
				mode: containerId ? "container" : "host",
				operation: statusGitOperation(args),
				success,
				errorCode,
				timeoutMs,
			});
		}
	}
}

/** Parse `git diff --shortstat` output:
 *   ` 3 files changed, 12 insertions(+), 4 deletions(-)`
 *   ` 1 file changed, 5 insertions(+)`
 *   ` 2 files changed, 3 deletions(-)`
 *   ` 0 files changed`        (or empty)
 * Either insertions or deletions may be absent. Returns 0/0 on empty/parse failure. */
export function parseShortstat(raw: string): { insertions: number; deletions: number } {
	if (!raw) return { insertions: 0, deletions: 0 };
	const ins = /(\d+)\s+insertions?\(\+\)/.exec(raw);
	const del = /(\d+)\s+deletions?\(-\)/.exec(raw);
	return {
		insertions: ins ? parseInt(ins[1], 10) || 0 : 0,
		deletions: del ? parseInt(del[1], 10) || 0 : 0,
	};
}

/** Parse porcelain v1 output into the GitStatusResult.status[] / summary shape.
 * Verbatim port from the legacy `runBatchGitStatus` reducer. */
function parsePorcelain(raw: string): { status: { file: string; status: string }[]; clean: boolean; summary: string } {
	const statusLines = raw ? raw.split("\n") : [];
	const status = statusLines
		.filter((l) => l.length > 0)
		.map((line) => {
			const l = line.endsWith("\r") ? line.slice(0, -1) : line;
			return { file: l.substring(3), status: l.substring(0, 2).trim() };
		});
	const clean = status.length === 0;
	let summary = "clean";
	if (!clean) {
		const counts: Record<string, number> = {};
		for (const { status: code } of status) {
			let key: string;
			if (code.includes("?")) key = "?";
			else if (code.includes("M")) key = "M";
			else if (code.includes("A")) key = "A";
			else if (code.includes("D")) key = "D";
			else if (code.includes("R")) key = "R";
			else if (code.includes("U")) key = "U";
			else key = code;
			counts[key] = (counts[key] || 0) + 1;
		}
		summary = Object.entries(counts).map(([k, v]) => `${v}${k}`).join(" ");
	}
	return { status, clean, summary };
}

/** Host path: parallel native execFile per design §2 (Phase A then Phase B). */
async function runHost(cwd: string, untracked: boolean, configuredBaseRef?: string): Promise<GitStatusResult | null> {
	const porcelainArgs = [
		"-c",
		"core.filemode=false",
		"status",
		"--porcelain=v1",
		untracked ? "-uall" : "-uno",
	];

	// Phase A — six independent calls in parallel.
	const [a1, a2, a3, a4, a5, a6] = await Promise.all([
		runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
		runGit(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd),
		runGit(["rev-parse", "--verify", "refs/heads/master"], cwd),
		runGit(["rev-parse", "--verify", "refs/heads/main"], cwd),
		runGit(porcelainArgs, cwd, undefined, PER_CALL_TIMEOUT_MS, false),
		runGit(["rev-parse", "--abbrev-ref", "@{u}"], cwd),
	]);

	// A1 mandatory.
	if (!a1.ok || !a1.stdout) return null;
	const branch = a1.stdout;

	// primaryBranch resolution — honour configured `base_ref` when set, else
	// fall back to A2 (origin/HEAD) → local master/main detection. See
	// `docs/design/base-ref.md` §5.
	let primaryBranch = "master";
	const parsedBase = parseBaseRef(configuredBaseRef ?? "");
	if (parsedBase.branch) {
		primaryBranch = parsedBase.branch;
	} else if (a2.ok && a2.stdout) {
		primaryBranch = a2.stdout.replace("refs/remotes/origin/", "");
	} else {
		const masterExists = a3.ok;
		const mainExists = a4.ok;
		if (!masterExists && mainExists) primaryBranch = "main";
	}

	const isOnPrimary = branch === primaryBranch;
	const hasUpstream = a6.ok && a6.stdout !== "";
	const { status, clean, summary } = parsePorcelain(a5.ok ? a5.stdout : "");

	// Phase B0 — verify origin/<primary> exists (serialized between phases).
	const b0 = await runGit(["rev-parse", "--verify", `origin/${primaryBranch}`], cwd);
	const pref = b0.ok ? `origin/${primaryBranch}` : primaryBranch;

	// Phase B — four parallel rev-list counts + two shortstat diffs.
	const [b1, b2, b3, b4, b5, b6] = await Promise.all([
		runGit(["rev-list", "--count", "@{u}..HEAD"], cwd),
		runGit(["rev-list", "--count", "HEAD..@{u}"], cwd),
		runGit(["rev-list", "--count", `${pref}..HEAD`], cwd),
		runGit(["rev-list", "--count", `HEAD..${pref}`], cwd),
		// shortstat against primary committed delta (three-dot)
		!isOnPrimary && b0.ok
			? runGit(["diff", "--shortstat", `${pref}...HEAD`], cwd)
			: Promise.resolve({ stdout: "", ok: true }),
		// shortstat against working tree (uncommitted: staged + unstaged)
		!isOnPrimary
			? runGit(["diff", "--shortstat", "HEAD"], cwd)
			: Promise.resolve({ stdout: "", ok: true }),
	]);

	let ahead = 0;
	let behind = 0;
	if (hasUpstream) {
		ahead = b1.ok ? (parseInt(b1.stdout, 10) || 0) : 0;
		behind = b2.ok ? (parseInt(b2.stdout, 10) || 0) : 0;
	}

	let aheadOfPrimary = 0;
	let behindPrimary = 0;
	let mergedIntoPrimary = false;
	let insertionsVsPrimary = 0;
	let deletionsVsPrimary = 0;
	if (!isOnPrimary) {
		aheadOfPrimary = b3.ok ? (parseInt(b3.stdout, 10) || 0) : 0;
		behindPrimary = b4.ok ? (parseInt(b4.stdout, 10) || 0) : 0;
		mergedIntoPrimary = aheadOfPrimary === 0;
		const c = parseShortstat(b5.ok ? b5.stdout : "");
		const w = parseShortstat(b6.ok ? b6.stdout : "");
		insertionsVsPrimary = c.insertions + w.insertions;
		deletionsVsPrimary = c.deletions + w.deletions;
	}

	return {
		branch,
		primaryBranch,
		primaryRef: pref,
		isOnPrimary,
		status,
		hasUpstream,
		ahead,
		behind,
		aheadOfPrimary,
		behindPrimary,
		mergedIntoPrimary,
		insertionsVsPrimary,
		deletionsVsPrimary,
		clean,
		summary,
		unpushed: hasUpstream ? ahead > 0 : !mergedIntoPrimary,
		partial: false,
		untrackedIncluded: untracked,
	};
}

/** Container path: preserve the legacy single-spawn batched script. The
 * Windows tax is host-side only; inside Linux containers `git` is fast and
 * one `docker exec sh -c` round-trip beats 11 parallel `docker exec` calls. */
async function runContainer(cwd: string, containerId: string, untracked: boolean, configuredBaseRef?: string, runtime: RuntimeBin = DEFAULT_RUNTIME_BIN): Promise<GitStatusResult | null> {
	const porcelainLine = untracked
		? "git -c core.filemode=false status --porcelain=v1 -uall 2>/dev/null"
		: "git -c core.filemode=false status --porcelain=v1 -uno 2>/dev/null";

	// When `base_ref` is configured, substitute the resolved branch name
	// directly into the script (saves a `symbolic-ref` round-trip and honours
	// the configured integration target). When unset, keep today's chain.
	// See `docs/design/base-ref.md` §5.
	const parsedBase = parseBaseRef(configuredBaseRef ?? "");
	const primaryResolutionScript = parsedBase.branch
		? `PRIMARY=${shellSingleQuote(parsedBase.branch)}`
		: [
				'PRIMARY=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed "s|refs/remotes/origin/||")',
				'if [ -z "$PRIMARY" ]; then PRIMARY=master; fi',
			].join("\n");

	const batchScript = [
		"git rev-parse --abbrev-ref HEAD 2>/dev/null || echo __FAIL__",
		'printf "\\0"',
		"git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || echo __FAIL__",
		'printf "\\0"',
		"git rev-parse --verify refs/heads/master 2>/dev/null && echo yes || echo no",
		'printf "\\0"',
		"git rev-parse --verify refs/heads/main 2>/dev/null && echo yes || echo no",
		'printf "\\0"',
		porcelainLine,
		'printf "\\0"',
		"BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)",
		'git rev-parse --abbrev-ref "$BRANCH@{u}" 2>/dev/null || echo __FAIL__',
		'printf "\\0"',
		"git rev-list --count @{u}..HEAD 2>/dev/null || echo 0",
		'printf "\\0"',
		"git rev-list --count HEAD..@{u} 2>/dev/null || echo 0",
		'printf "\\0"',
		primaryResolutionScript,
		'if git rev-parse --verify "origin/$PRIMARY" >/dev/null 2>&1; then PREF="origin/$PRIMARY"; else PREF="$PRIMARY"; fi',
		'git rev-list --count "$PREF..HEAD" 2>/dev/null || echo 0',
		'printf "\\0"',
		'git rev-list --count "HEAD..$PREF" 2>/dev/null || echo 0',
		'printf "\\0"',
		'git diff --shortstat "$PREF...HEAD" 2>/dev/null || true',
		'printf "\\0"',
		'git diff --shortstat HEAD 2>/dev/null || true',
		'printf "\\0"',
		// Echo the resolved PREF so the host can report which ref was actually
		// used (`origin/<primary>` if it exists, else the bare local branch).
		'printf "%s" "$PREF"',
	].join("\n");

	const diagEnabled = cpuDiagnosticsEnabled();
	const diagStart = diagEnabled ? performance.now() : 0;
	let success = 0;
	let errorCode = "none";
	let stdout: string;
	try {
		const result = await execFileAsync(
			runtime,
			["exec", "-w", cwd, containerId, "/bin/sh", "-c", batchScript],
			{
				encoding: "utf-8",
				timeout: CONTAINER_BATCH_TIMEOUT_MS,
				env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
				windowsHide: true,
			},
		);
		success = 1;
		stdout = result.stdout;
	} catch (err) {
		errorCode = childErrorCode(err);
		throw err;
	} finally {
		if (diagEnabled) {
			getCpuDiagnostics().recordChildProcess("docker exec git status", performance.now() - diagStart, {
				mode: "container-batch",
				operation: "batch",
				success,
				errorCode,
				timeoutMs: CONTAINER_BATCH_TIMEOUT_MS,
			});
		}
	}

	const sections = stdout.split("\0").map((s) => s.replace(/\s+$/, ""));
	const branchRaw = sections[0] || "";
	if (branchRaw === "__FAIL__" || !branchRaw) return null;
	const branch = branchRaw;

	let primaryBranch = "master";
	if (parsedBase.branch) {
		primaryBranch = parsedBase.branch;
	} else {
		const remoteHeadRaw = sections[1] || "";
		if (remoteHeadRaw !== "__FAIL__" && remoteHeadRaw) {
			primaryBranch = remoteHeadRaw.replace("refs/remotes/origin/", "");
		} else {
			const masterExists = (sections[2] || "").startsWith("yes");
			const mainExists = (sections[3] || "").startsWith("yes");
			if (!masterExists && mainExists) primaryBranch = "main";
		}
	}

	const isOnPrimary = branch === primaryBranch;
	const upstreamRaw = sections[5] || "";
	const hasUpstream = upstreamRaw !== "__FAIL__" && upstreamRaw !== "";
	let ahead = 0;
	let behind = 0;
	if (hasUpstream) {
		ahead = parseInt(sections[6] || "0", 10) || 0;
		behind = parseInt(sections[7] || "0", 10) || 0;
	}
	let aheadOfPrimary = 0;
	let behindPrimary = 0;
	let mergedIntoPrimary = false;
	let insertionsVsPrimary = 0;
	let deletionsVsPrimary = 0;
	if (!isOnPrimary) {
		aheadOfPrimary = parseInt(sections[8] || "0", 10) || 0;
		behindPrimary = parseInt(sections[9] || "0", 10) || 0;
		mergedIntoPrimary = aheadOfPrimary === 0;
		const c = parseShortstat(sections[10] || "");
		const w = parseShortstat(sections[11] || "");
		insertionsVsPrimary = c.insertions + w.insertions;
		deletionsVsPrimary = c.deletions + w.deletions;
	}

	const { status, clean, summary } = parsePorcelain(sections[4] || "");

	// Section 12: the resolved PREF echoed by the batch script (see above).
	// Fall back to the host-side mirror of the same `origin/<primary>` vs bare
	// branch decision when the section is missing (older container script).
	const primaryRef = sections[12] && sections[12] !== "" ? sections[12] : primaryBranch;

	return {
		branch,
		primaryBranch,
		primaryRef,
		isOnPrimary,
		status,
		hasUpstream,
		ahead,
		behind,
		aheadOfPrimary,
		behindPrimary,
		mergedIntoPrimary,
		insertionsVsPrimary,
		deletionsVsPrimary,
		clean,
		summary,
		unpushed: hasUpstream ? ahead > 0 : !mergedIntoPrimary,
		partial: false,
		untrackedIncluded: untracked,
	};
}

/** Top-level entry — dispatches to host (parallel native) or container
 * (batched docker exec). Never retries internally; caller (single-flight
 * cache + client) handles transient failure. */
export async function runBatchGitStatusNative(
	cwd: string,
	opts?: BatchGitStatusOpts,
): Promise<GitStatusResult | null> {
	const untracked = opts?.untracked === true;
	if (opts?.containerId) {
		return runContainer(cwd, opts.containerId, untracked, opts?.configuredBaseRef, opts?.runtime ?? DEFAULT_RUNTIME_BIN);
	}
	return runHost(cwd, untracked, opts?.configuredBaseRef);
}

/** Single-quote a string for safe inclusion in an `sh -c` shell script.
 * Escapes embedded single quotes via the classic `'\''` dance. */
function shellSingleQuote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

