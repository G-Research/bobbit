/**
 * Low-level git shell-out helpers (host or container-aware).
 * Extracted from server.ts (commit: split server.ts).
 */
import { exec, execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFileCb);

export async function execGit(
	cmd: string,
	cwd: string,
	timeout = 5000,
	containerId?: string,
): Promise<string> {
	if (containerId) {
		// Run inside Docker container
		const { stdout } = await execFileAsync(
			"docker",
			["exec", "-w", cwd, containerId, "/bin/sh", "-c", cmd],
			{ encoding: "utf-8", timeout, env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" } },
		);
		return stdout.trim();
	}
	const { stdout } = await execAsync(cmd, { cwd, encoding: "utf-8", timeout });
	return stdout.trim();
}

export async function execGitSafe(
	cmd: string,
	cwd: string,
	fallback = "",
	containerId?: string,
): Promise<string> {
	try {
		return await execGit(cmd, cwd, 5000, containerId);
	} catch {
		return fallback;
	}
}
