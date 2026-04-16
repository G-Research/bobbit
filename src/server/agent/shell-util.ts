/**
 * Cross-platform shell resolution utility.
 *
 * Consolidates the duplicated Git Bash discovery and shell config logic
 * previously spread across bg-process-manager.ts, verification-harness.ts,
 * and git.ts. On Windows, prefers Git Bash so bash syntax (pipes, redirects,
 * $(), etc.) works reliably. On Linux/macOS, uses /bin/sh.
 */
import { execSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

/**
 * Resolve the Git Bash executable path on Windows.
 * Returns null on non-Windows platforms or if Git Bash is not found.
 * Result is computed once and cached.
 */
export function findGitBash(): string | null {
	if (process.platform !== "win32") return null;

	const candidates: string[] = [
		"C:/Program Files/Git/bin/bash.exe",
		"C:/Program Files (x86)/Git/bin/bash.exe",
	];

	// Derive additional paths from `where.exe git` output.
	// Only use bin/bash.exe (the Git for Windows wrapper), never usr/bin/bash.exe
	// (the raw MSYS2 binary) — the latter can trigger the WSL interop layer on
	// systems with WSL installed, causing "execvpe(/bin/bash) failed" errors.
	try {
		const gitExe = execSync("where.exe git", {
			encoding: "utf-8",
			shell: process.env.ComSpec || "cmd.exe",
		}).split("\n")[0].trim();
		if (gitExe) {
			let dir = path.dirname(gitExe);
			for (let i = 0; i < 4; i++) {
				candidates.unshift(path.join(dir, "bin", "bash.exe").replace(/\\/g, "/"));
				dir = path.dirname(dir);
			}
		}
	} catch { /* git not on PATH — rely on hardcoded candidates */ }

	for (const c of candidates) {
		try {
			statSync(c);
			return c;
		} catch { /* not found, try next */ }
	}

	return null;
}

/** Cached Git Bash path — computed once at module load. */
export const GIT_BASH = findGitBash();

export interface ShellConfig {
	shell: string;
	args: string[];
}

/**
 * Returns the shell binary and args to use for `spawn(shell, [...args, command])`.
 * On Windows: Git Bash preferred, cmd.exe fallback.
 * On Linux/macOS: /bin/sh -c.
 */
export function getShellConfig(): ShellConfig {
	if (process.platform === "win32") {
		if (GIT_BASH) {
			return { shell: GIT_BASH, args: ["-c"] };
		}
		return { shell: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c"] };
	}
	return { shell: "/bin/sh", args: ["-c"] };
}

/**
 * Like getShellConfig but uses `--login` for Git Bash so that
 * the full environment (PATH, etc.) is sourced. Needed by the
 * verification harness for running project build/test commands.
 * Falls back to plain getShellConfig on non-Windows or when Git Bash
 * is unavailable.
 */
export function getLoginShellConfig(): ShellConfig {
	if (process.platform === "win32" && GIT_BASH) {
		return { shell: GIT_BASH, args: ["--login", "-c"] };
	}
	return getShellConfig();
}

/**
 * Choose shell for a verification command.
 *
 * Always returns plain bash — 25× faster than `--login` on Windows Git Bash
 * (~150ms vs ~3700ms per spawn). Most commands (echo, node, npm, git, gh,
 * docker, python, etc.) work fine in plain bash because their executables
 * are on the system PATH that Node.js inherits.
 *
 * `--login` is only needed for tools installed via version managers like
 * nvm, asdf, rbenv that modify PATH in `~/.bash_profile`. Projects using
 * those should configure an explicit shell wrapper in their commands, e.g.:
 *     "bash --login -c 'nvm use 20 && npm test'"
 *
 * Trade-off: verification commands that rely on .bash_profile-set PATH will
 * fail, but those were rare and now surface as clear "command not found"
 * errors instead of silently wasting ~3.5s per command step.
 */
export function getVerificationShell(_command: string): ShellConfig {
	return getShellConfig();
}

/**
 * Resolve the `sh` executable path. On Windows returns Git Bash path
 * (or falls back to just "sh" which may be on PATH if Git for Windows is
 * installed). On Linux/macOS returns "sh".
 *
 * Use this instead of hardcoded "sh" for `execFile("sh", ["-c", cmd])` calls.
 */
export function resolveShell(): string {
	if (process.platform === "win32") {
		if (GIT_BASH) return GIT_BASH;
		// Try "sh" on PATH (Git for Windows adds it)
		try {
			execSync("where.exe sh", { stdio: "pipe", shell: process.env.ComSpec || "cmd.exe" });
			return "sh";
		} catch {
			// No sh available — return bash.exe path from Git or fall back
			return "sh"; // will fail at call site with a clear error
		}
	}
	return "sh";
}
