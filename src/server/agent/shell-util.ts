/**
 * Cross-platform shell resolution utility.
 *
 * Consolidates the duplicated Git Bash discovery and shell config logic
 * previously spread across bg-process-manager.ts, verification-harness.ts,
 * and git.ts. On Windows, prefers Git Bash so bash syntax (pipes, redirects,
 * $(), etc.) works reliably. On Linux/macOS, uses /bin/sh.
 */
import { execFile, execSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
 *
 * Prefer `execShellCommand()` for new code — it handles cmd.exe's `/d /s /c`
 * arg form when neither Git Bash nor `sh` is on PATH.
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

/**
 * Run a shell command via `execFile`, picking the right shell binary + args
 * for the current platform via `getShellConfig()`. Use this in place of
 * hardcoded `execFile("sh", ["-c", cmd], …)` calls — on Windows machines
 * without Git Bash on PATH the literal "sh" binary doesn't exist and spawn
 * fails with ENOENT (errno -4058), silently breaking pool / goal / staff /
 * session worktree setup.
 */
export async function execShellCommand(
	command: string,
	opts: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
	const { shell, args } = getShellConfig();
	let spawnArgs = [...args, command];
	let timeoutWrapped = false;
	let nodeTimeout = opts.timeout;
	if (process.platform === "win32" && GIT_BASH && shell === GIT_BASH && opts.timeout && opts.timeout > 0) {
		// Node's timeout/taskkill can kill the Git Bash wrapper while leaving MSYS
		// children (for example `sleep`) holding cwd handles. Let Git Bash's own
		// coreutils `timeout` own the process group, with the Node timer as a later
		// safety net.
		spawnArgs = ["-c", "timeout -k 1s \"$1\" bash -c \"$2\"", "bobbit-timeout", `${opts.timeout / 1000}s`, command];
		timeoutWrapped = true;
		nodeTimeout = opts.timeout + 5_000;
	}
	return spawnShellCommand(shell, spawnArgs, { ...opts, timeout: nodeTimeout }, command, timeoutWrapped, opts.timeout);
}

function spawnShellCommand(
	file: string,
	args: string[],
	opts: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number },
	displayCommand: string,
	timeoutWrapped: boolean,
	declaredTimeoutMs?: number,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(file, args, {
			cwd: opts.cwd,
			env: opts.env,
			windowsHide: true,
			detached: process.platform !== "win32",
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		let timeoutTimer: NodeJS.Timeout | undefined;
		let hardTimeoutTimer: NodeJS.Timeout | undefined;

		const cleanup = () => {
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (hardTimeoutTimer) clearTimeout(hardTimeoutTimer);
		};
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			fn();
		};

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.on("data", (chunk: string) => { stderr += chunk; });
		child.on("error", (err) => finish(() => reject(err)));
		child.on("close", (code, signal) => {
			finish(() => {
				if (timedOut || (timeoutWrapped && (code === 124 || code === 137 || code === 2304))) {
					const err = new Error(`Command timed out after ${declaredTimeoutMs ?? opts.timeout}ms: ${displayCommand}`) as Error & { code?: string; stdout?: string; stderr?: string; signal?: NodeJS.Signals | null };
					err.code = "ETIMEDOUT";
					err.stdout = stdout;
					err.stderr = stderr;
					err.signal = signal;
					reject(err);
					return;
				}
				if (code === 0) {
					resolve({ stdout, stderr });
					return;
				}
				const err = new Error(`Command failed with exit code ${code ?? `signal ${signal}`}: ${displayCommand}`) as Error & { code?: number | null; stdout?: string; stderr?: string; signal?: NodeJS.Signals | null };
				err.code = code;
				err.stdout = stdout;
				err.stderr = stderr;
				err.signal = signal;
				reject(err);
			});
		});

		if (opts.timeout && opts.timeout > 0) {
			timeoutTimer = setTimeout(() => {
				timedOut = true;
				killShellProcessTree(child);
				hardTimeoutTimer = setTimeout(() => {
					try { child.kill("SIGKILL"); } catch { /* already exited */ }
				}, 5_000);
			}, opts.timeout);
		}
	});
}

function killShellProcessTree(child: ChildProcessWithoutNullStreams): void {
	if (!child.pid) return;
	if (process.platform === "win32") {
		execFile("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, timeout: 5_000 }, () => {
			try { child.kill("SIGKILL"); } catch { /* already exited */ }
		});
		return;
	}
	try { process.kill(-child.pid, "SIGTERM"); }
	catch { try { child.kill("SIGTERM"); } catch { /* already exited */ } }
	setTimeout(() => {
		try { process.kill(-child.pid!, "SIGKILL"); }
		catch { try { child.kill("SIGKILL"); } catch { /* already exited */ } }
	}, 500).unref();
}
