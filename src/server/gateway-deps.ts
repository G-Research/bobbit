import { execFileSync as nodeExecFileSync, spawn as nodeSpawn, type ChildProcess, type ExecFileOptions, type ExecFileSyncOptions, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import { execFileSafe } from "./exec-file-safe.js";
import type { RpcBridgeFactory } from "./agent/rpc-bridge.js";
import { realVerificationCommandRunner, type VerificationCommandRunner } from "./agent/verification-command-runner.js";

export type { ExecFileOptions, ExecFileSyncOptions, SpawnOptions } from "node:child_process";

export type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

export interface Clock {
	now(): number;
	setTimeout(handler: () => void, ms: number): TimerHandle;
	setInterval(handler: () => void, ms: number): TimerHandle;
	clearTimeout(handle: TimerHandle): void;
	clearInterval(handle: TimerHandle): void;
}

export interface ExecFileResult {
	stdout: string | Buffer;
	stderr: string | Buffer;
}

export interface CommandRunner {
	execFile(file: string, args: readonly string[], options?: ExecFileOptions): Promise<ExecFileResult>;
	execFileSync?(file: string, args: readonly string[], options?: ExecFileSyncOptions): Buffer | string;
	spawn?(file: string, args: readonly string[], options?: SpawnOptions): ChildProcess;
}

export interface GatewayDeps {
	clock?: Clock;
	commandRunner?: CommandRunner;
	/**
	 * Executor for verification COMMAND steps (separate from `commandRunner`,
	 * which handles git/gh/docker). Defaults to the real durable spawn path;
	 * tier-1 injects a non-spawning fake. See agent/verification-command-runner.ts.
	 */
	commandStepRunner?: VerificationCommandRunner;
	fetchImpl?: typeof fetch;
	agentBridgeFactory?: RpcBridgeFactory;
	fsImpl?: FsLike;
}

export interface ResolvedGatewayDeps {
	clock: Clock;
	commandRunner: CommandRunner;
	commandStepRunner: VerificationCommandRunner;
	fetchImpl: typeof fetch;
	agentBridgeFactory: RpcBridgeFactory;
	fsImpl: FsLike;
}

export interface FsLike extends Pick<typeof fs,
	| "existsSync"
	| "mkdirSync"
	| "readFileSync"
	| "writeFileSync"
	| "appendFileSync"
	| "readdirSync"
	| "statSync"
	| "lstatSync"
	| "renameSync"
	| "rmSync"
	| "unlinkSync"
	| "copyFileSync"
> {
	promises: Pick<typeof fs.promises,
		| "access"
		| "mkdir"
		| "readFile"
		| "writeFile"
		| "appendFile"
		| "readdir"
		| "stat"
		| "lstat"
		| "rename"
		| "rm"
		| "unlink"
		| "copyFile"
	>;
}

export const realClock: Clock = {
	now: () => Date.now(),
	setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
	setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
	clearTimeout: (handle) => globalThis.clearTimeout(handle),
	clearInterval: (handle) => globalThis.clearInterval(handle),
};

export const realCommandRunner: CommandRunner = {
	execFile: (file, args, options) => execFileSafe(file, args, options),
	execFileSync: (file, args, options) => nodeExecFileSync(file, [...args], options),
	spawn: (file, args, options) => options === undefined ? nodeSpawn(file, [...args]) : nodeSpawn(file, [...args], options),
};

export const realFetch: typeof fetch = globalThis.fetch;
export const realFs: FsLike = fs;

export const defaultRpcBridgeFactory: RpcBridgeFactory = () => null;

export function resolveGatewayDeps(deps: GatewayDeps = {}): ResolvedGatewayDeps {
	return {
		clock: deps.clock ?? realClock,
		commandRunner: deps.commandRunner ?? realCommandRunner,
		commandStepRunner: deps.commandStepRunner ?? realVerificationCommandRunner,
		fetchImpl: deps.fetchImpl ?? realFetch,
		agentBridgeFactory: deps.agentBridgeFactory ?? defaultRpcBridgeFactory,
		fsImpl: deps.fsImpl ?? realFs,
	};
}
