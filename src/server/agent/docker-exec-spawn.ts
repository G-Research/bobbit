import { spawn, type ChildProcess } from "node:child_process";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

export type DockerSpawn = typeof spawn;

/** Fixed image identity for OAuth-bearing Claude SDK processes only. */
export const CLAUDE_AGENT_SDK_DOCKER_USER = "bobbit-sdk";
export const CLAUDE_AGENT_SDK_DOCKER_UID = "1001";
export const CLAUDE_AGENT_SDK_DOCKER_HOME = "/home/bobbit-sdk";

/** Server-owned execution identities; arbitrary Docker `-u` values are never accepted. */
export type DockerExecUser = "claude-agent-sdk";

function dockerUserArg(user: DockerExecUser | undefined): string | undefined {
	if (user === undefined) return undefined;
	if (user === "claude-agent-sdk") return CLAUDE_AGENT_SDK_DOCKER_USER;
	throw new Error("Docker sandbox execution user is invalid");
}

export interface DockerExecCommand {
	containerId: string;
	cwd: string;
	env: Record<string, string | undefined>;
	/** Selects only a fixed server-owned image user, never a caller-supplied Docker identity. */
	user?: DockerExecUser;
	/** Appended after the fixed environment; preserves legacy duplicate override order. */
	envEntries?: Iterable<readonly [string, string | undefined]>;
	command: readonly string[];
	spawn?: DockerSpawn;
	logPrefix?: string;
	/** Consume stderr for SDK-owned children which otherwise have no fd-2 owner. */
	drainStderr?: boolean;
}

/** Docker accepts no host paths here: setup must have translated this first. */
export function isSandboxContainerCwd(cwd: string | undefined): cwd is string {
	if (typeof cwd !== "string") return false;
	const segments = cwd.split("/");
	if (segments[0] !== "" || (segments[1] !== "workspace" && segments[1] !== "workspace-wt")) return false;
	// Do not normalize persisted paths: traversal or duplicate separators could
	// otherwise turn a hostile container CWD into an apparently safe one.
	return segments.slice(2).every(segment => segment.length > 0 && segment !== "." && segment !== "..");
}

function validEnvName(name: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * Render Docker exec diagnostics without leaking per-process credentials,
 * correlation IDs, private directories, gateway authority, or SDK resume IDs.
 * Keep option and environment names visible so the log remains actionable.
 */
export function redactDockerArgs(args: readonly string[]): string {
	const redacted = "<REDACTED>";
	const sensitiveName = /^(BOBBIT_TOKEN|GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|AWS_SECRET|.*_SECRET|.*_TOKEN|.*_API_KEY|.*_OAUTH_TOKEN|.*_ACCESS_KEY)$/i;
	const privateEnvironmentNames = new Set([
		"BOBBIT_SESSION_ID",
		"BOBBIT_GOAL_ID",
		"BOBBIT_STAFF_ID",
		"BOBBIT_CWD",
		"BOBBIT_GATEWAY_URL",
		"CLAUDE_CONFIG_DIR",
	]);
	const isSensitiveEnvironment = (name: string): boolean => privateEnvironmentNames.has(name.toUpperCase()) || sensitiveName.test(name);
	const hasValue = (index: number): boolean => index < args.length && !args[index].startsWith("-");
	const rendered = [...args];

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "-e" || arg === "--env") {
			const environment = args[index + 1];
			if (!environment) continue;
			const equals = environment.indexOf("=");
			const name = equals === -1 ? environment : environment.slice(0, equals);
			if (!isSensitiveEnvironment(name)) continue;
			if (equals !== -1) rendered[index + 1] = `${name}=${redacted}`;
			else if (hasValue(index + 2)) rendered[index + 2] = redacted;
			continue;
		}

		if (arg.startsWith("--resume=")) {
			rendered[index] = `--resume=${redacted}`;
			continue;
		}
		if (arg === "--resume" && hasValue(index + 1)) {
			rendered[index + 1] = redacted;
			continue;
		}

		if ((arg === "-w" || arg === "--workdir") && hasValue(index + 1)) {
			rendered[index + 1] = redacted;
			// Docker exec takes its container immediately after its final option.
			// The shared spawner always emits -w last, so this preserves safe
			// command paths while removing the raw container correlation ID.
			if (hasValue(index + 2)) rendered[index + 2] = redacted;
		}
	}

	return rendered.join(" ");
}

/**
 * Spawn one process in an existing project container. It owns no sandbox or
 * session lifecycle; callers retain the returned child and decide its command.
 */
export function spawnDockerExec(
	input: DockerExecCommand,
	args: readonly string[] = [],
): ChildProcess {
	if (!input.containerId.trim()) throw new Error("Docker sandbox container is unavailable");
	if (!isSandboxContainerCwd(input.cwd)) throw new Error("Docker sandbox working directory is invalid");
	if (input.command.length === 0) throw new Error("Docker sandbox command is required");

	const execArgs = ["exec", "-i"];
	const dockerUser = dockerUserArg(input.user);
	if (dockerUser) execArgs.push("-u", dockerUser);
	for (const [name, value] of [...Object.entries(input.env), ...(input.envEntries ? [...input.envEntries] : [])]) {
		if (!validEnvName(name) || value === undefined) continue;
		execArgs.push("-e", `${name}=${value}`);
	}
	execArgs.push("-w", input.cwd, input.containerId, ...input.command, ...args);
	console.log(`[${input.logPrefix ?? "docker-exec"}] Docker exec args: ${redactDockerArgs(execArgs)}`);
	const child = (input.spawn ?? spawn)("docker", execArgs, {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
	});
	// A container can exit between spawn and a queued protocol write. These two
	// expected stream errors must not escape as uncaught gateway exceptions.
	child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") return;
		console.warn(`[${input.logPrefix ?? "docker-exec"}] stdin error: ${error.code ?? "unknown"}`);
	});
	// Pi owns and forwards stderr itself. SDK-owned children have no fd-2
	// consumer, so explicitly opt in to discard it and prevent pipe backpressure.
	if (input.drainStderr) {
		child.stderr?.on("data", () => undefined);
		child.stderr?.on("error", () => undefined);
	}
	return child;
}

export interface ClaudeSdkDockerSpawn extends DockerExecCommand {
	/** The fixed, image-pinned wrapper; SDK-provided command is intentionally ignored. */
	command: readonly [string, ...string[]];
}

/**
 * Adapt the SDK's bundled process launch to a `docker exec` child. The SDK
 * supplies an abort only after its graceful stdin shutdown window, so it is
 * observed here rather than passed to Node's spawn options.
 */
export function createClaudeSdkDockerSpawn(input: ClaudeSdkDockerSpawn): (options: SpawnOptions) => SpawnedProcess {
	return (options) => {
		// The SDK adds protocol metadata to its replacement environment. Preserve
		// only those fixed metadata keys, never an arbitrary SDK/host env merge.
		const sdkMetadata = Object.fromEntries(
			["CLAUDE_AGENT_SDK_CLIENT_APP", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_ENTRYPOINT"]
				.map((name) => [name, options.env[name]] as const)
				.filter((entry): entry is [string, string] => typeof entry[1] === "string"),
		);
		const child = spawnDockerExec({
			...input,
			// Only the OAuth-bearing SDK process uses the image's separate UID.
			user: "claude-agent-sdk",
			env: { ...input.env, ...sdkMetadata },
			drainStderr: true,
		}, options.args);
		if (!child.stdin || !child.stdout) {
			child.kill("SIGTERM");
			throw new Error("Docker sandbox process did not provide pipe stdio");
		}
		const onAbort = () => {
			if (!child.killed && child.exitCode === null) child.kill("SIGTERM");
		};
		const cleanup = () => options.signal.removeEventListener("abort", onAbort);
		options.signal.addEventListener("abort", onAbort, { once: true });
		child.once("exit", cleanup);
		child.once("error", cleanup);
		return {
			stdin: child.stdin,
			stdout: child.stdout,
			get killed() { return child.killed; },
			get exitCode() { return child.exitCode; },
			get signalCode() { return child.signalCode; },
			kill: (signal) => child.kill(signal),
			on: (event, listener) => { child.on(event as any, listener as any); },
			once: (event, listener) => { child.once(event as any, listener as any); },
			off: (event, listener) => { child.off(event as any, listener as any); },
		};
	};
}
