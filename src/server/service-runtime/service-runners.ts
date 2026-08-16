import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { execa } from "execa";
import getPort from "get-port";
import Dockerode from "dockerode";
import { isPackPathWithinRoot } from "../extension-host/path-guard.js";
import { isSafeServiceImageReference, type ComposeLaunch, type DockerLaunch, type LocalLaunch, type ServiceRunMode, type ServiceRuntimeManifest } from "./service-manifest.js";

const LOOPBACK_HOST = "127.0.0.1";
const STOP_TIMEOUT_MS = 10_000;
const MAX_LOCAL_START_ATTEMPTS = 3;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_LINES = 200;
const EARLY_LOCAL_FAILURE_WINDOW_MS = 50;
/** A minimal executable lookup path; runtimes never inherit the gateway PATH. */
const POSIX_LOADER_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

export type ServiceRunnerErrorCode =
	| "SERVICE_DOCKER_UNAVAILABLE"
	| "SERVICE_LAUNCH_FAILED"
	| "SERVICE_PORT_CONFLICT"
	| "SERVICE_RUNNER_IDENTITY_INVALID"
	| "SERVICE_STOP_TIMEOUT"
	| "SERVICE_UNHEALTHY";

/** An error whose message is safe to use as a stable supervisor diagnostic code. */
export class ServiceRunnerError extends Error {
	constructor(readonly code: ServiceRunnerErrorCode, message: string = code, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "ServiceRunnerError";
	}
}

export interface ServiceRunnerIdentity {
	kind: ServiceRunMode;
	/** A child PID surrogate, Docker container id, or Compose service name. */
	id: string;
	/** Present only for Compose, so operations cannot escape the declared project. */
	composeProject?: string;
}

export interface StartedService {
	endpoint: string;
	runnerIdentity: ServiceRunnerIdentity;
	services: Array<{ id: string; name: string }>;
}

export interface ServiceRunnerStartInput {
	manifest: ServiceRuntimeManifest;
	/** The mode already selected by the settings owner. */
	mode: ServiceRunMode;
	/** Absolute pack root, used to prove descriptor-owned path containment. */
	packRoot: string;
	/** Descriptor directory; relative launch paths are resolved from here. */
	descriptorDir?: string;
	/** Stable server identity, used to prevent cross-gateway Docker control. */
	serverIdentity: string;
	/** Stable pack/runtime identity, used for labels only. */
	serviceIdentity: string;
	/** Safe pack id used only when resolving the manifest's declared Compose project template. */
	packId?: string;
	/** Values resolved by the supervisor; this adapter never resolves settings or secrets. */
	environment: Record<string, string>;
	/** Owner-only persisted environment artifact. Compose receives this only as a validated filename. */
	envFile?: string;
	/** A canonical storage bind prepared by the supervisor. */
	storage?: { hostPath: string; target: string };
	/** Validated settings-owned OCI ref, resolved only during explicit start. */
	imageOverride?: string;
	/** Exact secrets which must not enter the bounded command-output hook. */
	redactions?: string[];
	onOutput?: (output: string) => void;
}

export interface ServiceRunnerInspectInput {
	manifest: ServiceRuntimeManifest;
	packRoot: string;
	descriptorDir?: string;
	serverIdentity: string;
	serviceIdentity: string;
	packId?: string;
	/** Owner-only persisted environment artifact; this is never read by the supervisor. */
	envFile?: string;
	runnerIdentity: ServiceRunnerIdentity;
}

export interface ServiceRunnerControlInput extends ServiceRunnerInspectInput {
	redactions?: string[];
	onOutput?: (output: string) => void;
}

/**
 * Runners own only resources they created. Inspection is intentionally read-only:
 * it must not allocate a port, start a child, render environment, or resolve secrets.
 */
export interface ServiceRunner {
	readonly mode: ServiceRunMode;
	start(input: ServiceRunnerStartInput): Promise<StartedService>;
	inspect(input: ServiceRunnerInspectInput): Promise<StartedService | undefined>;
	stop(input: ServiceRunnerControlInput): Promise<void>;
	remove(input: ServiceRunnerControlInput): Promise<void>;
}

interface CommandResult {
	stdout?: string;
	stderr?: string;
	/** execa's combined output when `all: true` is requested. */
	all?: string;
	exitCode?: number;
	failed?: boolean;
}

interface ChildCommand extends Promise<CommandResult> {
	pid?: number;
	exitCode?: number | null;
	kill(signal?: NodeJS.Signals | number): boolean;
}

type CommandExecutor = (file: string, args: readonly string[], options: Record<string, unknown>) => ChildCommand;
type PortAllocator = (options: { host: string }) => Promise<number>;
type ReadinessProbe = (endpoint: string, manifest: ServiceRuntimeManifest) => Promise<void>;

interface LocalRunnerOptions {
	execute?: CommandExecutor;
	getPort?: PortAllocator;
	readiness?: ReadinessProbe;
	stopTimeoutMs?: number;
}

interface DockerContainer {
	id?: string;
	start(): Promise<void>;
	inspect(): Promise<unknown>;
	stop(options?: { t?: number }): Promise<void>;
	remove(options?: { force?: boolean }): Promise<void>;
}

interface DockerClient {
	createContainer(options: Record<string, unknown>): Promise<DockerContainer>;
	getContainer(id: string): DockerContainer;
}

interface DockerRunnerOptions {
	docker?: DockerClient;
	readiness?: ReadinessProbe;
}

interface ComposeRunnerOptions {
	execute?: CommandExecutor;
	readiness?: ReadinessProbe;
}

function asCommandExecutor(): CommandExecutor {
	return execa as unknown as CommandExecutor;
}

function asPortAllocator(): PortAllocator {
	return getPort as PortAllocator;
}

function assertNonEmptyString(value: unknown, name: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
		throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", `Invalid ${name}`);
	}
}

function assertArgv(args: readonly string[], name: string): void {
	for (const [index, value] of args.entries()) assertNonEmptyString(value, `${name}[${index}]`);
}

/** Defense in depth for callers that bypass descriptor parsing with typed input. */
function assertNoShellInterpreterInvocation(command: string, args: readonly string[], name: string): void {
	const executable = command.replace(/^.*[\\/]/, "").toLowerCase();
	const shellCommand = ["sh", "bash", "dash", "zsh", "ksh", "fish"].includes(executable)
		&& args.some((arg) => arg === "--command" || /^-[a-z]*c[a-z]*$/i.test(arg));
	const cmdCommand = ["cmd", "cmd.exe"].includes(executable) && args.some((arg) => /^\/c$/i.test(arg));
	const powershellCommand = ["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(executable)
		&& args.some((arg) => /^(?:-|\/)(?:command|c|encodedcommand|ec)$/i.test(arg));
	if (shellCommand || cmdCommand || powershellCommand) {
		throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", `${name} must not invoke a shell interpreter command mode`);
	}
}

/** Compose project/service values occupy an argv token and must never contain shell syntax. */
function assertComposeToken(value: string, name: string): void {
	assertNonEmptyString(value, name);
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) {
		throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", `Invalid ${name}`);
	}
}

function endpointFor(manifest: ServiceRuntimeManifest, port: number): string {
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Invalid discovered port");
	}
	return `${manifest.endpoint.protocol}://${LOOPBACK_HOST}:${port}`;
}

function containedPath(packRoot: string, baseDir: string | undefined, candidate: string, name: string): string {
	assertNonEmptyString(packRoot, "packRoot");
	assertNonEmptyString(candidate, name);
	if (path.isAbsolute(candidate)) throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", `Absolute ${name}`);
	const root = path.resolve(packRoot);
	const resolved = path.resolve(baseDir ?? root, candidate);
	if (isPackPathWithinRoot(root, resolved)) return resolved;
	// The shared guard excludes the root itself. `cwd: .` at a root-level
	// descriptor is safe only when both its spelling and realpath are that root.
	try {
		if (path.resolve(root) === path.resolve(resolved) && fs.realpathSync(root) === fs.realpathSync(resolved)) return resolved;
	} catch { /* fall through to the stable launch error */ }
	throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", `Escaping ${name}`);
}

/**
 * Runtimes never inherit the gateway environment. The fixed loader path makes
 * validated bare commands usable without accepting a caller's gateway PATH.
 * Windows additionally needs its OS loader variables; descriptor values retain
 * the final override so a runtime can intentionally use its own loader path.
 */
function runtimeEnvironment(values: Record<string, string> = {}): Record<string, string> {
	const windowsRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
	const environment: Record<string, string> = process.platform === "win32"
		? { PATH: windowsRoot ? `${path.join(windowsRoot, "System32")};${windowsRoot}` : "" }
		: { PATH: POSIX_LOADER_PATH };
	if (process.platform === "win32") {
		for (const key of ["SystemRoot", "SYSTEMROOT", "ComSpec", "PATHEXT"]) {
			const value = process.env[key];
			if (value) environment[key] = value;
		}
	}
	return { ...environment, ...values };
}

function safeOutput(raw: string | undefined, redactions: readonly string[] = []): string {
	let output = raw ?? "";
	for (const secret of redactions) {
		if (secret) output = output.split(secret).join("[REDACTED]");
	}
	// Environment diagnostics often contain values that are not supplied in the command result.
	output = output.replace(/\b[A-Z][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)/g, (entry) => `${entry.slice(0, entry.indexOf("=") + 1)}[REDACTED]`);
	if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) output = output.slice(-MAX_OUTPUT_BYTES);
	return output.split(/\r?\n/).slice(-MAX_OUTPUT_LINES).join("\n");
}

function emitOutput(input: Pick<ServiceRunnerStartInput, "onOutput" | "redactions">, result: CommandResult): void {
	const output = safeOutput([result.stdout, result.stderr].filter(Boolean).join("\n"), input.redactions);
	if (output) input.onOutput?.(output);
}

function errorText(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (error && typeof error === "object") {
		const result = error as CommandResult;
		return [result.all, result.stderr, result.stdout].filter((value): value is string => typeof value === "string").join("\n");
	}
	return String(error);
}

function isBindConflict(error: unknown): boolean {
	return /EADDRINUSE|address already in use/i.test(errorText(error));
}

/**
 * `reject:false` resolves an early child failure instead of throwing it. A
 * small bounded observation window leaves readiness exclusively supervisor-owned
 * while ensuring any child which has already exited cannot be reported as a
 * successful start.
 */
async function observeEarlyLocalExit(child: ChildCommand): Promise<{ settled: boolean; outcome?: unknown }> {
	let outcome: unknown;
	let settled = false;
	void child.then(
		(result) => { outcome = result; settled = true; },
		(error: unknown) => { outcome = error; settled = true; },
	);
	await new Promise<void>((resolve) => setTimeout(resolve, EARLY_LOCAL_FAILURE_WINDOW_MS));
	return { settled, outcome };
}

function isNotFound(error: unknown): boolean {
	return error instanceof Error && /not found|no such container|404/i.test(error.message);
}

async function waitForExit(child: ChildCommand, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== undefined && child.exitCode !== null) return true;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			child.then(() => true, () => true),
			new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Runs ordinary upstream services with a fresh loopback port for each bounded retry. */
export class LocalServiceRunner implements ServiceRunner {
	readonly mode = "local" as const;
	private readonly children = new Map<string, { child: ChildCommand; started: StartedService }>();
	private sequence = 0;
	private readonly execute: CommandExecutor;
	private readonly allocatePort: PortAllocator;
	private readonly stopTimeoutMs: number;

	constructor(options: LocalRunnerOptions = {}) {
		this.execute = options.execute ?? asCommandExecutor();
		this.allocatePort = options.getPort ?? asPortAllocator();
		this.stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
	}

	async start(input: ServiceRunnerStartInput): Promise<StartedService> {
		if (input.mode !== this.mode) throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Local runner selected for another mode");
		const launch: LocalLaunch = input.manifest.modes.local;
		assertNonEmptyString(launch.command, "local command");
		assertArgv(launch.args, "local args");
		assertNoShellInterpreterInvocation(launch.command, launch.args, "local command");
		assertComposeToken(launch.portEnv, "local portEnv");
		assertComposeToken(launch.hostEnv, "local hostEnv");
		const hostSource = input.manifest.environment[launch.hostEnv];
		if (launch.hostEnv === launch.portEnv || !hostSource || !("value" in hostSource) || hostSource.value !== LOOPBACK_HOST) {
			throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Local host binding declaration is invalid");
		}
		const cwd = launch.cwd === undefined ? (input.descriptorDir ?? input.packRoot) : containedPath(input.packRoot, input.descriptorDir, launch.cwd, "local cwd");
		let lastFailure: unknown;
		for (let attempt = 0; attempt < MAX_LOCAL_START_ATTEMPTS; attempt++) {
			const port = await this.allocatePort({ host: LOOPBACK_HOST });
			const endpoint = endpointFor(input.manifest, port);
			let child: ChildCommand | undefined;
			let id: string | undefined;
			try {
				child = this.execute(launch.command, launch.args, {
					cwd,
					// Both values are assigned after the resolved environment: neither
					// a setting nor a direct runner caller can turn a local child into
					// a wildcard listener.
					env: runtimeEnvironment({ ...input.environment, [launch.portEnv]: String(port), [launch.hostEnv]: LOOPBACK_HOST }),
					extendEnv: false,
					shell: false,
					reject: false,
					all: true,
				});
				void child.then(
					(result) => emitOutput(input, result),
					(error: unknown) => input.onOutput?.(safeOutput(error instanceof Error ? error.message : String(error), input.redactions)),
				);
				const earlyExit = await observeEarlyLocalExit(child);
				if (earlyExit.settled) {
					if (isBindConflict(earlyExit.outcome)) throw new Error("EADDRINUSE");
					throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Local service exited during launch", { cause: earlyExit.outcome });
				}
				id = `local-${++this.sequence}-${child.pid ?? port}`;
				const started: StartedService = {
					endpoint,
					runnerIdentity: { kind: this.mode, id },
					services: [{ id, name: launch.command }],
				};
				this.children.set(id, { child, started });
				return started;
			} catch (cause) {
				lastFailure = cause;
				if (id) this.children.delete(id);
				if (child) child.kill("SIGTERM");
				if (isBindConflict(cause)) continue;
				throw cause;
			}
		}
		throw new ServiceRunnerError(isBindConflict(lastFailure) ? "SERVICE_PORT_CONFLICT" : "SERVICE_UNHEALTHY", undefined, { cause: lastFailure });
	}

	async inspect(input: ServiceRunnerInspectInput): Promise<StartedService | undefined> {
		if (input.runnerIdentity.kind !== this.mode) return undefined;
		const record = this.children.get(input.runnerIdentity.id);
		if (!record || (record.child.exitCode !== undefined && record.child.exitCode !== null)) return undefined;
		return record.started;
	}

	async stop(input: ServiceRunnerControlInput): Promise<void> {
		if (input.runnerIdentity.kind !== this.mode) return;
		const record = this.children.get(input.runnerIdentity.id);
		if (!record) return;
		record.child.kill("SIGTERM");
		if (!(await waitForExit(record.child, this.stopTimeoutMs))) {
			record.child.kill("SIGKILL");
			if (!(await waitForExit(record.child, this.stopTimeoutMs))) {
				throw new ServiceRunnerError("SERVICE_STOP_TIMEOUT");
			}
		}
	}

	async remove(input: ServiceRunnerControlInput): Promise<void> {
		await this.stop(input);
		this.children.delete(input.runnerIdentity.id);
	}
}

function labelsFor(input: Pick<ServiceRunnerStartInput | ServiceRunnerInspectInput, "serverIdentity" | "serviceIdentity">): Record<string, string> {
	return {
		"io.bobbit.server": input.serverIdentity,
		"io.bobbit.service": input.serviceIdentity,
	};
}

function matchesLabels(inspected: unknown, input: Pick<ServiceRunnerInspectInput, "serverIdentity" | "serviceIdentity">): boolean {
	if (!inspected || typeof inspected !== "object") return false;
	const config = (inspected as { Config?: { Labels?: Record<string, string> } }).Config;
	const labels = config?.Labels;
	return labels?.["io.bobbit.server"] === input.serverIdentity && labels["io.bobbit.service"] === input.serviceIdentity;
}

function dockerEndpoint(inspected: unknown, manifest: ServiceRuntimeManifest): string | undefined {
	if (!inspected || typeof inspected !== "object") return undefined;
	const key = `${manifest.endpoint.servicePort}/tcp`;
	const ports = (inspected as { NetworkSettings?: { Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> } }).NetworkSettings?.Ports;
	const binding = ports?.[key]?.find((candidate) => candidate.HostIp === LOOPBACK_HOST);
	if (!binding?.HostPort || !/^\d+$/.test(binding.HostPort)) return undefined;
	return endpointFor(manifest, Number(binding.HostPort));
}

/** Docker Engine runner. Docker, not Bobbit, atomically allocates the host port. */
export class DockerServiceRunner implements ServiceRunner {
	readonly mode = "docker" as const;
	private readonly docker: DockerClient;

	constructor(options: DockerRunnerOptions = {}) {
		this.docker = options.docker ?? (new Dockerode() as unknown as DockerClient);
	}

	async start(input: ServiceRunnerStartInput): Promise<StartedService> {
		if (input.mode !== this.mode) throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Docker runner selected for another mode");
		const launch: DockerLaunch = input.manifest.modes.docker;
		const image = input.imageOverride ?? launch.image;
		if (!isSafeServiceImageReference(image)) throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Docker image is invalid");
		if (launch.command) {
			assertArgv(launch.command, "Docker command");
			assertNoShellInterpreterInvocation(launch.command[0]!, launch.command.slice(1), "Docker command");
		}
		const portKey = `${input.manifest.endpoint.servicePort}/tcp`;
		let container: DockerContainer | undefined;
		try {
			// `local.hostEnv` is meaningful only to a host-process listener. Never
			// pass it into a container, where loopback would be the container's own
			// network namespace and make the published port unreachable.
			const environment = { ...input.environment };
			delete environment[input.manifest.modes.local.hostEnv];
			container = await this.docker.createContainer({
				Image: image,
				Cmd: launch.command,
				Env: Object.entries(environment).map(([key, value]) => `${key}=${value}`),
				Labels: labelsFor(input),
				ExposedPorts: { [portKey]: {} },
				HostConfig: {
					PortBindings: { [portKey]: [{ HostIp: LOOPBACK_HOST, HostPort: "0" }] },
					Binds: input.storage ? [`${input.storage.hostPath}:${input.storage.target}`] : undefined,
				},
			});
			await container.start();
		} catch (cause) {
			await container?.remove({ force: true }).catch(() => undefined);
			throw new ServiceRunnerError("SERVICE_DOCKER_UNAVAILABLE", "SERVICE_DOCKER_UNAVAILABLE", { cause });
		}
		const id = container.id;
		if (!id) {
			await container.remove({ force: true }).catch(() => undefined);
			throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Docker did not return a container id");
		}
		try {
			const inspected = await container.inspect();
			const endpoint = dockerEndpoint(inspected, input.manifest);
			if (!endpoint) throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Docker did not publish a loopback port");
			return { endpoint, runnerIdentity: { kind: this.mode, id }, services: [{ id, name: image }] };
		} catch (cause) {
			await container.remove({ force: true }).catch(() => undefined);
			throw cause;
		}
	}

	async inspect(input: ServiceRunnerInspectInput): Promise<StartedService | undefined> {
		if (input.runnerIdentity.kind !== this.mode) return undefined;
		try {
			const inspected = await this.docker.getContainer(input.runnerIdentity.id).inspect();
			if (!matchesLabels(inspected, input)) return undefined;
			const running = (inspected as { State?: { Running?: boolean } }).State?.Running;
			const endpoint = dockerEndpoint(inspected, input.manifest);
			if (!running || !endpoint) return undefined;
			return { endpoint, runnerIdentity: input.runnerIdentity, services: [{ id: input.runnerIdentity.id, name: input.manifest.modes.docker.image }] };
		} catch (cause) {
			if (isNotFound(cause)) return undefined;
			throw new ServiceRunnerError("SERVICE_DOCKER_UNAVAILABLE", "SERVICE_DOCKER_UNAVAILABLE", { cause });
		}
	}

	async stop(input: ServiceRunnerControlInput): Promise<void> {
		if (input.runnerIdentity.kind !== this.mode) return;
		const container = this.docker.getContainer(input.runnerIdentity.id);
		try {
			const inspected = await container.inspect();
			if (!matchesLabels(inspected, input)) throw new ServiceRunnerError("SERVICE_RUNNER_IDENTITY_INVALID");
			await container.stop({ t: 10 });
		} catch (cause) {
			if (isNotFound(cause)) return;
			if (cause instanceof ServiceRunnerError) throw cause;
			throw new ServiceRunnerError("SERVICE_STOP_TIMEOUT", "SERVICE_STOP_TIMEOUT", { cause });
		}
	}

	async remove(input: ServiceRunnerControlInput): Promise<void> {
		if (input.runnerIdentity.kind !== this.mode) return;
		const container = this.docker.getContainer(input.runnerIdentity.id);
		try {
			const inspected = await container.inspect();
			if (!matchesLabels(inspected, input)) throw new ServiceRunnerError("SERVICE_RUNNER_IDENTITY_INVALID");
			await container.remove({ force: true });
		} catch (cause) {
			if (isNotFound(cause)) return;
			if (cause instanceof ServiceRunnerError) throw cause;
			throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Docker container removal failed", { cause });
		}
	}
}

function trustedComposeEnvironmentFile(envFile: string | undefined): string {
	if (!envFile || !path.isAbsolute(envFile) || envFile.includes("\0")) {
		throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose requires an owner-only runtime environment file");
	}
	try {
		const stat = fs.lstatSync(envFile);
		if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600)) {
			throw new Error("unsafe runtime environment file");
		}
		return envFile;
	} catch (cause) {
		throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose runtime environment file is unavailable", { cause });
	}
}

function composeArgs(project: string, file: string, envFile: string, command: string[]): string[] {
	assertComposeToken(project, "Compose project");
	assertArgv(command, "Compose command");
	return ["compose", "--env-file", trustedComposeEnvironmentFile(envFile), "-p", project, "-f", file, ...command];
}

function resolveComposeProject(launch: ComposeLaunch, input: Pick<ServiceRunnerStartInput | ServiceRunnerInspectInput, "manifest" | "packId" | "serverIdentity">): string {
	const project = launch.projectName.replace(/\$\{(packId|runtimeId|serverIdentity)\}/g, (_whole, key: "packId" | "runtimeId" | "serverIdentity") => ({
		packId: input.packId ?? "pack",
		runtimeId: input.manifest.id,
		serverIdentity: input.serverIdentity,
	})[key]);
	assertComposeToken(project, "Compose project");
	return project;
}

function commandFailed(result: CommandResult): boolean {
	return result.exitCode !== undefined && result.exitCode !== 0;
}

function parseComposeLoopbackPort(output: string | undefined, manifest: ServiceRuntimeManifest): string | undefined {
	const match = output?.trim().match(/^127\.0\.0\.1:(\d+)$/);
	if (!match) return undefined;
	return endpointFor(manifest, Number(match[1]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

const MAX_COMPOSE_INTERPOLATION_BYTES = 1024 * 1024;
const MAX_COMPOSE_INTERPOLATION_DEPTH = 16;
const MAX_COMPOSE_INTERPOLATIONS = 256;
const COMPOSE_FALLBACK_OPERATORS = new Set(["-", ":-", "+", ":+"]);

/**
 * Docker Compose interpolation is implemented by the Compose CLI, not Docker
 * Engine, and neither `yaml` nor Dockerode parses it. This bounded scanner is
 * deliberately limited to the four default/alternate forms we allow; it
 * validates nested substitutions without rendering the untrusted document.
 */
function composeInterpolations(text: string, depth = 0, seen = { count: 0 }): Array<{ name: string; operator?: string }> {
	if (Buffer.byteLength(text) > MAX_COMPOSE_INTERPOLATION_BYTES || depth > MAX_COMPOSE_INTERPOLATION_DEPTH) {
		throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose interpolation is too large or deeply nested");
	}
	const references: Array<{ name: string; operator?: string }> = [];
	for (let cursor = 0; cursor < text.length;) {
		const start = text.indexOf("${", cursor);
		if (start < 0) break;
		let index = start + 2;
		let nesting = 1;
		for (; index < text.length && nesting > 0; index++) {
			if (text.startsWith("${", index)) { nesting++; index++; }
			else if (text[index] === "}") nesting--;
		}
		if (nesting !== 0) throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose interpolation is malformed");
		if (++seen.count > MAX_COMPOSE_INTERPOLATIONS) throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose has too many interpolations");
		const expression = text.slice(start + 2, index - 1);
		const name = expression.match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0];
		if (!name) throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose interpolation is malformed");
		const remainder = expression.slice(name.length);
		const operator = [":-", ":+", "-", "+"].find((candidate) => remainder.startsWith(candidate));
		if (remainder && (!operator || !COMPOSE_FALLBACK_OPERATORS.has(operator))) {
			throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose interpolation uses an unsupported operator");
		}
		references.push({ name, ...(operator ? { operator } : {}) });
		if (operator) references.push(...composeInterpolations(remainder.slice(operator.length), depth + 1, seen));
		cursor = index;
	}
	return references;
}

function assertComposeNoUnownedInterpolation(text: string, input: Pick<ServiceRunnerStartInput, "manifest" | "environment">): void {
	for (const reference of composeInterpolations(text)) {
		const source = input.manifest.environment[reference.name];
		// SERVICE_RUNTIME_IMAGE is the one generic runner-owned interpolation,
		// injected only after validating an explicit image override.
		const isRunnerImage = reference.name === "SERVICE_RUNTIME_IMAGE" && Object.hasOwn(input.environment, reference.name);
		if (!source && !isRunnerImage) {
			throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose references an undeclared environment variable");
		}
		if (!Object.hasOwn(input.environment, reference.name)) {
			if (!(source && "secret" in source && source.optional === true && reference.operator && COMPOSE_FALLBACK_OPERATORS.has(reference.operator))) {
				throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose omits an environment variable without an optional fallback");
			}
		}
	}
}

function resolveComposeImage(value: unknown, environment: Record<string, string>): unknown {
	if (typeof value !== "string") return value;
	const interpolation = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
	return interpolation ? environment[interpolation[1]!] : value;
}

function assertComposePort(value: unknown, port: number): void {
	if (typeof value === "string" && value === `127.0.0.1::${port}`) return;
	if (isRecord(value)
		&& value.host_ip === LOOPBACK_HOST
		&& (value.published === undefined || value.published === "" || value.published === null)
		&& String(value.target) === String(port)) return;
	throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose must use a dynamic loopback port");
}

/**
 * Validate the static Compose contract before `up`. This deliberately accepts
 * only the limited generic service shape rather than asking Compose to render
 * an untrusted file (which could consume gateway variables or create host
 * resources before endpoint validation).
 */
function validateComposeContract(file: string, input: ServiceRunnerStartInput, launch: ComposeLaunch): void {
	if (!isPackPathWithinRoot(input.packRoot, file)) {
		throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose file escaped its pack root");
	}
	let source: string;
	let document: unknown;
	try {
		source = fs.readFileSync(file, "utf8");
		document = parseYaml(source);
	} catch (cause) {
		throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose file is invalid", { cause });
	}
	assertComposeNoUnownedInterpolation(source, input);
	if (composeInterpolations(source).some((reference) => reference.name === input.manifest.modes.local.hostEnv)) {
		throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose must not use the local listener-host variable");
	}
	// Compose named volumes are permitted only when they are project-owned (no
	// `external`, custom `name`, drivers, or driver options). Compose prefixes the
	// declared key with the server-derived project name, so `down` preserves an
	// owned durable volume without ever reaching a host path or live legacy data.
	if (!isRecord(document) || !hasOnlyComposeKeys(document, ["services", "volumes"]) || !isRecord(document.services)) {
		throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose requires services and optional owned volumes");
	}
	const volumes = document.volumes;
	const namedVolumes = new Set<string>();
	if (volumes !== undefined) {
		if (!isRecord(volumes)) throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose volumes are invalid");
		for (const [name, declaration] of Object.entries(volumes)) {
			assertComposeToken(name, "Compose volume");
			if (declaration !== null && (!isRecord(declaration) || Object.keys(declaration).length !== 0)) {
				throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose volume must be project-owned");
			}
			namedVolumes.add(name);
		}
	}
	const services = document.services as Record<string, unknown>;
	const declaredStorage = input.manifest.storage;
	let storageMounts = 0;
	for (const [name, rawService] of Object.entries(services)) {
		if (!isRecord(rawService) || !hasOnlyComposeKeys(rawService, ["image", "restart", "environment", "ports", "volumes", "depends_on"])) {
			throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose service uses an unsupported feature");
		}
		const image = resolveComposeImage(rawService.image, input.environment);
		if (!isSafeServiceImageReference(image)) {
			throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose service image is invalid");
		}
		if (rawService.restart !== undefined && rawService.restart !== "no" && rawService.restart !== false) {
			throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose restart must be disabled");
		}
		if (rawService.environment !== undefined && (!isRecord(rawService.environment)
			|| Object.values(rawService.environment).some((value) => value !== null && typeof value !== "string"))) {
			throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose environment is invalid");
		}
		if (rawService.depends_on !== undefined && (!Array.isArray(rawService.depends_on)
			|| rawService.depends_on.some((dependency) => typeof dependency !== "string" || !Object.hasOwn(services, dependency)))) {
			throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose dependencies are invalid");
		}
		const ports = rawService.ports;
		if (name === launch.service) {
			if (!Array.isArray(ports) || ports.length !== 1) throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose service must publish exactly one port");
			assertComposePort(ports[0], input.manifest.endpoint.servicePort);
		} else if (ports !== undefined && (!Array.isArray(ports) || ports.length !== 0)) {
			throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Only the declared Compose service may publish ports");
		}
		if (rawService.volumes !== undefined) {
			if (!Array.isArray(rawService.volumes)) throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose volume is invalid");
			for (const volume of rawService.volumes) {
				if (typeof volume !== "string") throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose volume is invalid");
				const bind = volume.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}:([^:]+)$/);
				const named = volume.match(/^([A-Za-z0-9][A-Za-z0-9_.-]*):([^:]+)$/);
				const environmentSource = bind ? input.manifest.environment[bind[1]!] : undefined;
				const validBind = !!bind && !!declaredStorage && !!input.storage && !!environmentSource && "setting" in environmentSource
					&& environmentSource.setting === declaredStorage.setting && input.environment[bind[1]!] === input.storage.hostPath
					&& bind[2] === declaredStorage.target && bind[2] === input.storage.target;
				// A descriptor-owned Compose named volume is a valid durable backing
				// even when no generic host bind is declared. It stays constrained to
				// the YAML's own key; custom/external volume declarations are rejected.
				const validNamed = !!named && namedVolumes.has(named[1]!);
				if (!validBind && !validNamed) throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose volume escapes declared storage");
				if (validBind) storageMounts++;
			}
		}
	}
	if (!Object.hasOwn(services, launch.service)) throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Declared Compose service is missing");
	if (declaredStorage && storageMounts !== 1) throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose must mount declared storage exactly once");
}

function hasOnlyComposeKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

/** Docker Compose plugin runner. Every invocation includes the contained file and declared project. */
export class ComposeServiceRunner implements ServiceRunner {
	readonly mode = "compose" as const;
	private readonly execute: CommandExecutor;
	/**
	 * Compatibility for direct runner callers only. Supervisor callers always
	 * supply the durable store-owned path. Keeping the fallback in memory means
	 * a later process cannot control it without the trusted store artifact.
	 */
	private readonly transientEnvFiles = new Map<string, { file: string; dir: string }>();

	constructor(options: ComposeRunnerOptions = {}) {
		this.execute = options.execute ?? asCommandExecutor();
	}

	async start(input: ServiceRunnerStartInput): Promise<StartedService> {
		if (input.mode !== this.mode) throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose runner selected for another mode");
		const launch: ComposeLaunch = input.manifest.modes.compose;
		assertComposeToken(launch.service, "Compose service");
		const project = resolveComposeProject(launch, input);
		const file = containedPath(input.packRoot, input.descriptorDir, launch.file, "Compose file");
		const composeInput = input.imageOverride
			? { ...input, environment: { ...input.environment, SERVICE_RUNTIME_IMAGE: input.imageOverride } }
			: input;
		validateComposeContract(file, composeInput, launch);
		const envFile = this.startEnvironmentFile(composeInput, project, launch.service);
		let upIssued = false;
		try {
			upIssued = true;
			const up = await this.execute("docker", composeArgs(project, file, envFile, ["up", "-d", launch.service]), this.commandOptions());
			emitOutput(input, up);
			if (commandFailed(up)) throw new ServiceRunnerError("SERVICE_DOCKER_UNAVAILABLE", "Compose up failed");
			const endpoint = await this.discoverEndpoint(input.manifest, file, launch, project, envFile, input);
			return {
				endpoint,
				runnerIdentity: { kind: this.mode, id: launch.service, composeProject: project },
				services: [{ id: launch.service, name: launch.service }],
			};
		} catch (cause) {
			if (upIssued) await this.removeStartedService(file, launch, project, envFile, input).catch(() => undefined);
			this.removeTransientEnvironmentFile(project, launch.service);
			throw cause;
		}
	}

	async inspect(input: ServiceRunnerInspectInput): Promise<StartedService | undefined> {
		if (input.runnerIdentity.kind !== this.mode) return undefined;
		const launch = input.manifest.modes.compose;
		const project = resolveComposeProject(launch, input);
		if (input.runnerIdentity.id !== launch.service || input.runnerIdentity.composeProject !== project) return undefined;
		const file = containedPath(input.packRoot, input.descriptorDir, launch.file, "Compose file");
		const envFile = this.controlEnvironmentFile(input, project, launch.service);
		const ps = await this.execute("docker", composeArgs(project, file, envFile, ["ps", "--status", "running", "-q", launch.service]), this.commandOptions());
		if (commandFailed(ps) || !ps.stdout?.trim()) return undefined;
		const endpoint = await this.discoverEndpoint(input.manifest, file, launch, project, envFile, {});
		return {
			endpoint,
			runnerIdentity: input.runnerIdentity,
			services: [{ id: launch.service, name: launch.service }],
		};
	}

	async stop(input: ServiceRunnerControlInput): Promise<void> {
		if (input.runnerIdentity.kind !== this.mode) return;
		const { launch, project } = this.assertComposeIdentity(input);
		const file = containedPath(input.packRoot, input.descriptorDir, launch.file, "Compose file");
		const envFile = this.controlEnvironmentFile(input, project, launch.service);
		// `up service` also starts its declared dependencies. Stop the owned
		// project, not only the endpoint service, so no dependency is orphaned.
		const stopped = await this.execute("docker", composeArgs(project, file, envFile, ["stop", "--timeout", "10"]), this.commandOptions());
		emitOutput(input, stopped);
		if (commandFailed(stopped)) throw new ServiceRunnerError("SERVICE_STOP_TIMEOUT", "Compose stop failed");
	}

	async remove(input: ServiceRunnerControlInput): Promise<void> {
		if (input.runnerIdentity.kind !== this.mode) return;
		const { launch, project } = this.assertComposeIdentity(input);
		const file = containedPath(input.packRoot, input.descriptorDir, launch.file, "Compose file");
		const envFile = this.controlEnvironmentFile(input, project, launch.service);
		// `up service` also starts declared dependencies. A project-scoped down
		// removes that full owned graph (including any orphaned sidecars) while
		// deliberately omitting `-v`, preserving the declared bind storage.
		const removed = await this.execute("docker", composeArgs(project, file, envFile, ["down", "--remove-orphans", "--timeout", "10"]), this.commandOptions());
		emitOutput(input, removed);
		if (commandFailed(removed)) throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose project removal failed");
		this.removeTransientEnvironmentFile(project, launch.service);
	}

	private assertComposeIdentity(input: ServiceRunnerControlInput): { launch: ComposeLaunch; project: string } {
		const launch = input.manifest.modes.compose;
		const project = resolveComposeProject(launch, input);
		if (input.runnerIdentity.id !== launch.service || input.runnerIdentity.composeProject !== project) {
			throw new ServiceRunnerError("SERVICE_RUNNER_IDENTITY_INVALID");
		}
		return { launch, project };
	}

	private transientKey(project: string, service: string): string {
		return `${project}\u0000${service}`;
	}

	private startEnvironmentFile(input: ServiceRunnerStartInput, project: string, service: string): string {
		if (input.envFile) return trustedComposeEnvironmentFile(input.envFile);
		const key = this.transientKey(project, service);
		const prior = this.transientEnvFiles.get(key);
		if (prior) return trustedComposeEnvironmentFile(prior.file);
		let dir: string | undefined;
		try {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-compose-env-"));
			fs.chmodSync(dir, 0o700);
			const file = path.join(dir, "runtime.env");
			const contents = Object.keys(input.environment).sort().map((name) => `${name}=${JSON.stringify(input.environment[name])}`).join("\n");
			fs.writeFileSync(file, contents ? `${contents}\n` : "", { mode: 0o600, flag: "wx" });
			fs.chmodSync(file, 0o600);
			this.transientEnvFiles.set(key, { file, dir });
			return trustedComposeEnvironmentFile(file);
		} catch (cause) {
			if (dir) fs.rmSync(dir, { recursive: true, force: true });
			throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose requires a persisted runtime environment file", { cause });
		}
	}

	private controlEnvironmentFile(input: ServiceRunnerInspectInput, project: string, service: string): string {
		if (input.envFile) return trustedComposeEnvironmentFile(input.envFile);
		const transient = this.transientEnvFiles.get(this.transientKey(project, service));
		if (!transient) throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose requires a persisted runtime environment file");
		return trustedComposeEnvironmentFile(transient.file);
	}

	private removeTransientEnvironmentFile(project: string, service: string): void {
		const key = this.transientKey(project, service);
		const transient = this.transientEnvFiles.get(key);
		if (!transient) return;
		this.transientEnvFiles.delete(key);
		try { fs.rmSync(transient.dir, { recursive: true, force: true }); }
		catch { /* teardown has already removed the owned Compose service */ }
	}

	private commandOptions(): Record<string, unknown> {
		return { shell: false, reject: false, all: true, extendEnv: false, env: runtimeEnvironment() };
	}

	private async removeStartedService(file: string, _launch: ComposeLaunch, project: string, envFile: string, input: Pick<ServiceRunnerStartInput, "onOutput" | "redactions">): Promise<void> {
		// Failure after `up service` must clean its dependency graph too. The
		// project is validated from the descriptor and `-v` is intentionally absent.
		const removed = await this.execute("docker", composeArgs(project, file, envFile, ["down", "--remove-orphans", "--timeout", "10"]), this.commandOptions());
		emitOutput(input, removed);
	}

	private async discoverEndpoint(manifest: ServiceRuntimeManifest, file: string, launch: ComposeLaunch, project: string, envFile: string, input: Pick<ServiceRunnerStartInput, "onOutput" | "redactions">): Promise<string> {
		const port = await this.execute("docker", composeArgs(project, file, envFile, ["port", launch.service, String(manifest.endpoint.servicePort)]), this.commandOptions());
		emitOutput(input, port);
		const endpoint = !commandFailed(port) ? parseComposeLoopbackPort(port.stdout, manifest) : undefined;
		if (!endpoint) throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose did not publish a loopback port");
		return endpoint;
	}
}

/** Selects an adapter without allowing mode-specific provider or client behavior. */
export function selectServiceRunner(runners: readonly ServiceRunner[], mode: ServiceRunMode): ServiceRunner {
	const runner = runners.find((candidate) => candidate.mode === mode);
	if (!runner) throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", `No runner for ${mode}`);
	return runner;
}

export const runnerOutputLimits = { maxBytes: MAX_OUTPUT_BYTES, maxLines: MAX_OUTPUT_LINES } as const;
