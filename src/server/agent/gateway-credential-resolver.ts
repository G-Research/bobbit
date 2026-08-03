import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Sanitized error: it never includes the expression, stdout, stderr, or token. */
export class GatewayCredentialResolutionError extends Error {
	constructor(gatewayName: string) {
		super(`Unable to resolve API key for gateway "${gatewayName}"`);
		this.name = "GatewayCredentialResolutionError";
	}
}

export async function resolveGatewayCredential(expression: unknown, gatewayName: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
	if (typeof expression !== "string" || !expression.trim() || expression.trim() === "none") return undefined;
	const value = expression.trim();
	if (!value.startsWith("!")) return env[value] || value;
	try {
		const command = process.platform === "win32"
			? { file: env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", value.slice(1)] }
			: { file: "/bin/sh", args: ["-c", value.slice(1)] };
		const { stdout } = await execFileAsync(command.file, command.args, { encoding: "utf-8", timeout: 15_000, windowsHide: true });
		const token = typeof stdout === "string" ? stdout.trim() : "";
		if (!token) throw new Error("empty");
		return token;
	} catch {
		throw new GatewayCredentialResolutionError(gatewayName);
	}
}
