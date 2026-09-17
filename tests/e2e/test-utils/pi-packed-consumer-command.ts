import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	packedConsumerNpmEnv,
	runOwnedCommand,
} from "../../../scripts/testing-v2/prewarm-packed-consumer-cache.mjs";

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

/**
 * Run a package-consumer command through the same tracked process-tree owner as
 * fixture preparation. Timeout and output overflow terminate the complete tree,
 * join its bounded completion barrier, and retain command/cwd/PID/output details.
 */
export async function runPiPackedConsumerCommand(
	command: string,
	args: string[],
	options: PiPackedConsumerCommandOptions,
): Promise<PiPackedConsumerCommandResult> {
	return runOwnedCommand(command, args, {
		cwd: options.cwd,
		env: options.env ?? process.env,
		timeoutMs: options.timeoutMs ?? 120_000,
		maxOutputBytes: options.maxOutputBytes,
	});
}

function npmInvocation(args: string[]): { command: string; args: string[] } {
	const candidates = [
		process.env.npm_execpath,
		join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
		resolve(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
	].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
	const npmCli = candidates.find(candidate => existsSync(candidate));
	if (!npmCli) throw new Error(`Unable to locate npm's JavaScript CLI beside ${process.execPath}`);
	return { command: process.execPath, args: [npmCli, ...args] };
}

export function runPiPackedConsumerNpm(
	args: string[],
	options: PiPackedConsumerCommandOptions,
): Promise<PiPackedConsumerCommandResult> {
	const invocation = npmInvocation(args);
	return runPiPackedConsumerCommand(invocation.command, invocation.args, options);
}

/** External-consumer npm semantics without inherited project/lifecycle state. */
export function piPackedConsumerNpmEnv(cwd: string): NodeJS.ProcessEnv {
	return packedConsumerNpmEnv(cwd, process.env);
}
