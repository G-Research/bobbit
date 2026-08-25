import { execFileSync as nodeExecFileSync, type ChildProcess, type ExecFileOptions, type ExecFileSyncOptions } from "node:child_process";
import fs from "node:fs";
import { execFileSafe } from "./exec-file-safe.js";
import type { RpcBridgeFactory } from "./agent/rpc-bridge.js";
import { realVerificationCommandRunner, type VerificationCommandRunner } from "./agent/verification-command-runner.js";
import { createCommandSpawnAdapter, type CommandSpawnOptions } from "./owned-tree-command-spawn.js";
import { realClock } from "./clock.js";

export type { ExecFileOptions, ExecFileSyncOptions, SpawnOptions } from "node:child_process";
export { realClock } from "./clock.js";
export type { Clock, TimerHandle } from "./clock.js";
import type { Clock } from "./clock.js";

export interface ExecFileResult {
	stdout: string | Buffer;
	stderr: string | Buffer;
}

export interface CommandRunner {
	execFile(file: string, args: readonly string[], options?: ExecFileOptions): Promise<ExecFileResult>;
	execFileSync?(file: string, args: readonly string[], options?: ExecFileSyncOptions): Buffer | string;
	spawn?(file: string, args: readonly string[], options?: CommandSpawnOptions): ChildProcess;
	/** The spawn implementation honors branded owned-tree requests synchronously. */
	supportsOwnedTreeSpawn?: true;
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
	| "linkSync"
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

export const realCommandRunner: CommandRunner = {
	execFile: (file, args, options) => execFileSafe(file, args, options),
	execFileSync: (file, args, options) => nodeExecFileSync(file, [...args], options),
	spawn: createCommandSpawnAdapter(),
	supportsOwnedTreeSpawn: true,
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
