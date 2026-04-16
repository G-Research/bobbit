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
 * Tools that require the full interactive PATH (installed via system package
 * managers, nvm, asdf, etc.). Commands that reference any of these need
 * `--login` on Windows Git Bash.
 *
 * Commands that use only shell builtins (echo, test, [, :, cat, grep, sed,
 * awk, basic operators) run in plain shell — 25× faster on Windows.
 */
const LOGIN_SHELL_TOOLS = [
	"npm", "npx", "yarn", "pnpm", "node",
	"python", "python3", "pip", "pip3", "pytest", "poetry",
	"go", "cargo", "rustc",
	"mvn", "gradle", "sbt",
	"gh", "docker", "kubectl", "helm", "terraform",
	"make", "cmake",
	"ruby", "gem", "bundle", "rails",
	"php", "composer",
	"dotnet",
	"tsc", "eslint", "prettier", "vitest", "jest", "playwright",
];

/**
 * Choose shell for a verification command. Uses --login (slow, full PATH) only
 * when the command references a tool that requires PATH resolution. Otherwise
 * uses plain shell (fast).
 *
 * Examples:
 *   "echo ok"            → plain bash  (150ms)
 *   "[ -f foo.txt ]"     → plain bash  (150ms)
 *   "npm run test"       → login bash  (3700ms — needs PATH)
 *   "gh pr list"         → login bash  (3700ms)
 */
export function getVerificationShell(command: string): ShellConfig {
	if (process.platform !== "win32" || !GIT_BASH) {
		// Non-Windows or no Git Bash: use whatever getShellConfig returns.
		// Shell startup on Linux/macOS is fast (sh -c ≈ 5ms).
		return getShellConfig();
	}

	// Tokenize command — roughly. This is a heuristic, not a shell parser.
	// We just look for whole words matching known tools.
	const words = command.split(/[\s|&;()<>`"'$]+/).filter(Boolean);
	const needsLogin = words.some(w => {
		// Strip leading path prefix (./node_modules/.bin/xyz → xyz)
		const basename = w.includes("/") ? w.substring(w.lastIndexOf("/") + 1) : w;
		return LOGIN_SHELL_TOOLS.includes(basename);
	});

	return needsLogin
		? { shell: GIT_BASH, args: ["--login", "-c"] }
		: { shell: GIT_BASH, args: ["-c"] };
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
