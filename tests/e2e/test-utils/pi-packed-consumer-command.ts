import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

export interface PiPackedConsumerCommandOptions {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	maxOutputBytes?: number;
}

export interface PiPackedConsumerCommandResult {
	command: string;
	args: string[];
	code: number;
	stdout: string;
	stderr: string;
}

function displayCommand(command: string, args: readonly string[]): string {
	return [command, ...args].map(value => /\s/.test(value) ? JSON.stringify(value) : value).join(" ");
}

function terminateProcessTree(child: ChildProcess): void {
	if (!child.pid) return;
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
		return;
	}
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		child.kill("SIGTERM");
	}
}

/**
 * Run a real command while retaining stdout for machine-readable npm output.
 * Non-zero exits are returned to the caller (npm audit intentionally exits 1);
 * spawn failures, signals, timeouts, and output overflows are infrastructure
 * errors and reject immediately.
 */
export function runPiPackedConsumerCommand(
	command: string,
	args: string[],
	options: PiPackedConsumerCommandOptions,
): Promise<PiPackedConsumerCommandResult> {
	const timeoutMs = options.timeoutMs ?? 120_000;
	const maxOutputBytes = options.maxOutputBytes ?? 20 * 1024 * 1024;
	const rendered = displayCommand(command, args);

	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			windowsHide: true,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let outputBytes = 0;
		let terminalError: Error | undefined;
		let settled = false;

		const failAndTerminate = (message: string): void => {
			if (terminalError) return;
			terminalError = new Error(message);
			terminateProcessTree(child);
		};
		const collect = (target: Buffer[], chunk: Buffer | string): void => {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			outputBytes += buffer.byteLength;
			if (outputBytes > maxOutputBytes) {
				failAndTerminate(`${rendered} exceeded the ${maxOutputBytes}-byte output limit`);
				return;
			}
			target.push(buffer);
		};

		child.stdout?.on("data", chunk => collect(stdout, chunk));
		child.stderr?.on("data", chunk => collect(stderr, chunk));

		const timer = setTimeout(() => {
			failAndTerminate(`${rendered} timed out after ${timeoutMs}ms`);
		}, timeoutMs);

		child.once("error", error => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`Failed to spawn ${rendered}: ${error.message}`, { cause: error }));
		});
		child.once("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const stdoutText = Buffer.concat(stdout).toString("utf8");
			const stderrText = Buffer.concat(stderr).toString("utf8");
			if (terminalError) {
				reject(new Error(`${terminalError.message}\nstdout:\n${stdoutText}\nstderr:\n${stderrText}`, {
					cause: terminalError,
				}));
				return;
			}
			if (signal || code === null) {
				reject(new Error(`${rendered} terminated without an exit code (signal: ${signal ?? "unknown"})`));
				return;
			}
			resolve({ command, args: [...args], code, stdout: stdoutText, stderr: stderrText });
		});
	});
}

function npmInvocation(args: string[]): { command: string; args: string[] } {
	const npmExecPath = process.env.npm_execpath;
	if (npmExecPath && existsSync(npmExecPath)) {
		return { command: process.execPath, args: [npmExecPath, ...args] };
	}
	return { command: process.platform === "win32" ? "npm.cmd" : "npm", args };
}

export function runPiPackedConsumerNpm(
	args: string[],
	options: PiPackedConsumerCommandOptions,
): Promise<PiPackedConsumerCommandResult> {
	const invocation = npmInvocation(args);
	return runPiPackedConsumerCommand(invocation.command, invocation.args, options);
}

/** Remove npm-script state that would make the empty project inherit Bobbit's
 * load-bearing package-lock=false configuration. Registry/auth/cache settings
 * remain inherited, just as they would for a normal consumer on this machine. */
export function piPackedConsumerNpmEnv(cwd: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	const projectScopedKeys = new Set([
		"npm_config_local_prefix",
		"npm_config_package_lock",
		"npm_config_shrinkwrap",
		"npm_config_workspace",
		"npm_config_workspaces",
		"npm_config_include_workspace_root",
		"npm_config_ignore_scripts",
		"npm_config_omit",
		"npm_config_include",
		"npm_config_optional",
		"npm_config_audit_level",
		"npm_config_dry_run",
	]);
	for (const key of Object.keys(env)) {
		const lower = key.toLowerCase();
		if (projectScopedKeys.has(lower) || lower.startsWith("npm_package_") || lower.startsWith("npm_lifecycle_")) {
			delete env[key];
		}
	}
	delete env.INIT_CWD;
	delete env.init_cwd;
	// npm will set INIT_CWD for dependency lifecycle scripts from this value.
	env.INIT_CWD = cwd;
	return env;
}
