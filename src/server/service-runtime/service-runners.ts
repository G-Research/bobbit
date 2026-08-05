import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { execa } from "execa";
import getPort from "get-port";
import Dockerode from "dockerode";
import { isPackPathWithinRoot } from "../extension-host/path-guard.js";
import type { ComposeLaunch, DockerLaunch, LocalLaunch, ServiceRunMode, ServiceRuntimeManifest } from "./service-manifest.js";

const LOOPBACK_HOST = "127.0.0.1";
const STOP_TIMEOUT_MS = 10_000;
const MAX_LOCAL_START_ATTEMPTS = 3;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_LINES = 200;

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
	/** A canonical storage bind prepared by the supervisor. */
	storage?: { hostPath: string; target: string };
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
	exitCode?: number;
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
	if (!isPackPathWithinRoot(root, resolved)) throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", `Escaping ${name}`);
	return resolved;
}

/**
 * Runtimes never inherit the gateway environment. Windows needs a handful of
 * process-loader variables; all other values are descriptor-owned material.
 */
function runtimeEnvironment(values: Record<string, string> = {}): Record<string, string> {
	const environment: Record<string, string> = {};
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

function isBindConflict(error: unknown): boolean {
	return error instanceof Error && /EADDRINUSE|address already in use/i.test(error.message);
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
		assertComposeToken(launch.portEnv, "local portEnv");
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
					env: runtimeEnvironment({ ...input.environment, [launch.portEnv]: String(port) }),
					extendEnv: false,
					shell: false,
					reject: false,
					all: true,
				});
				void child.then(
					(result) => emitOutput(input, result),
					(error: unknown) => input.onOutput?.(safeOutput(error instanceof Error ? error.message : String(error), input.redactions)),
				);
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
		assertNonEmptyString(launch.image, "Docker image");
		if (launch.command) assertArgv(launch.command, "Docker command");
		const portKey = `${input.manifest.endpoint.servicePort}/tcp`;
		let container: DockerContainer | undefined;
		try {
			container = await this.docker.createContainer({
				Image: launch.image,
				Cmd: launch.command,
				Env: Object.entries(input.environment).map(([key, value]) => `${key}=${value}`),
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
			return { endpoint, runnerIdentity: { kind: this.mode, id }, services: [{ id, name: launch.image }] };
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

function composeArgs(project: string, file: string, command: string[]): string[] {
	assertComposeToken(project, "Compose project");
	assertArgv(command, "Compose command");
	return ["compose", "-p", project, "-f", file, ...command];
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

function assertComposeNoUnownedInterpolation(text: string, environment: Record<string, string>): void {
	for (const match of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}/g)) {
		if (!Object.hasOwn(environment, match[1]!)) {
			throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose references an undeclared environment variable");
		}
	}
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
	assertComposeNoUnownedInterpolation(source, input.environment);
	if (!isRecord(document) || !isRecord(document.services)) {
		throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose requires a services mapping");
	}
	const declaredStorage = input.manifest.storage;
	let storageMounts = 0;
	for (const [name, rawService] of Object.entries(document.services)) {
		if (!isRecord(rawService)) throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose service is invalid");
		if (rawService.privileged === true || rawService.network_mode !== undefined || rawService.pid === "host"
			|| rawService.ipc === "host" || rawService.uts === "host" || rawService.userns_mode === "host"
			|| rawService.cap_add !== undefined || rawService.devices !== undefined || rawService.security_opt !== undefined
			|| rawService.command !== undefined || rawService.entrypoint !== undefined || rawService.env_file !== undefined
			|| rawService.build !== undefined || rawService.extends !== undefined) {
			throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose service uses a prohibited host or command feature");
		}
		if (rawService.restart !== undefined && rawService.restart !== "no" && rawService.restart !== false) {
			throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose restart must be disabled");
		}
		const ports = rawService.ports;
		if (name === launch.service) {
			if (!Array.isArray(ports) || ports.length !== 1) throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose service must publish exactly one port");
			assertComposePort(ports[0], input.manifest.endpoint.servicePort);
		} else if (ports !== undefined && (!Array.isArray(ports) || ports.length !== 0)) {
			throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Only the declared Compose service may publish ports");
		}
		if (rawService.volumes !== undefined) {
			if (!declaredStorage || !Array.isArray(rawService.volumes)) throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose storage is undeclared");
			for (const volume of rawService.volumes) {
				if (typeof volume !== "string") throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose volume is invalid");
				const match = volume.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}:([^:]+)$/);
				if (!match || !Object.hasOwn(input.environment, match[1]!) || match[2] !== declaredStorage.target) {
					throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose volume escapes declared storage");
				}
				storageMounts++;
			}
		}
	}
	if (!Object.hasOwn(document.services, launch.service)) throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Declared Compose service is missing");
	if (declaredStorage && storageMounts !== 1) throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose must mount declared storage exactly once");
}

/** Docker Compose plugin runner. Every invocation includes the contained file and declared project. */
export class ComposeServiceRunner implements ServiceRunner {
	readonly mode = "compose" as const;
	private readonly execute: CommandExecutor;

	constructor(options: ComposeRunnerOptions = {}) {
		this.execute = options.execute ?? asCommandExecutor();
	}

	async start(input: ServiceRunnerStartInput): Promise<StartedService> {
		if (input.mode !== this.mode) throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose runner selected for another mode");
		const launch: ComposeLaunch = input.manifest.modes.compose;
		assertComposeToken(launch.service, "Compose service");
		const project = resolveComposeProject(launch, input);
		const file = containedPath(input.packRoot, input.descriptorDir, launch.file, "Compose file");
		validateComposeContract(file, input, launch);
		let upIssued = false;
		try {
			upIssued = true;
			const up = await this.execute("docker", composeArgs(project, file, ["up", "-d", launch.service]), this.commandOptions(input.environment));
			emitOutput(input, up);
			if (commandFailed(up)) throw new ServiceRunnerError("SERVICE_DOCKER_UNAVAILABLE", "Compose up failed");
			const endpoint = await this.discoverEndpoint(input.manifest, file, launch, project, input);
			return {
				endpoint,
				runnerIdentity: { kind: this.mode, id: launch.service, composeProject: project },
				services: [{ id: launch.service, name: launch.service }],
			};
		} catch (cause) {
			if (upIssued) await this.removeStartedService(file, launch, project, input).catch(() => undefined);
			throw cause;
		}
	}

	async inspect(input: ServiceRunnerInspectInput): Promise<StartedService | undefined> {
		if (input.runnerIdentity.kind !== this.mode) return undefined;
		const launch = input.manifest.modes.compose;
		const project = resolveComposeProject(launch, input);
		if (input.runnerIdentity.id !== launch.service || input.runnerIdentity.composeProject !== project) return undefined;
		const file = containedPath(input.packRoot, input.descriptorDir, launch.file, "Compose file");
		const ps = await this.execute("docker", composeArgs(project, file, ["ps", "--status", "running", "-q", launch.service]), this.commandOptions());
		if (commandFailed(ps) || !ps.stdout?.trim()) return undefined;
		const endpoint = await this.discoverEndpoint(input.manifest, file, launch, project, {});
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
		const stopped = await this.execute("docker", composeArgs(project, file, ["stop", "--timeout", "10", launch.service]), this.commandOptions());
		emitOutput(input, stopped);
		if (commandFailed(stopped)) throw new ServiceRunnerError("SERVICE_STOP_TIMEOUT", "Compose stop failed");
	}

	async remove(input: ServiceRunnerControlInput): Promise<void> {
		if (input.runnerIdentity.kind !== this.mode) return;
		const { launch, project } = this.assertComposeIdentity(input);
		const file = containedPath(input.packRoot, input.descriptorDir, launch.file, "Compose file");
		// Remove only the declared service; never run an unscoped project-wide down here.
		const removed = await this.execute("docker", composeArgs(project, file, ["rm", "--stop", "--force", launch.service]), this.commandOptions());
		emitOutput(input, removed);
		if (commandFailed(removed)) throw new ServiceRunnerError("SERVICE_LAUNCH_FAILED", "Compose service removal failed");
	}

	private assertComposeIdentity(input: ServiceRunnerControlInput): { launch: ComposeLaunch; project: string } {
		const launch = input.manifest.modes.compose;
		const project = resolveComposeProject(launch, input);
		if (input.runnerIdentity.id !== launch.service || input.runnerIdentity.composeProject !== project) {
			throw new ServiceRunnerError("SERVICE_RUNNER_IDENTITY_INVALID");
		}
		return { launch, project };
	}

	private commandOptions(environment?: Record<string, string>): Record<string, unknown> {
		return { shell: false, reject: false, all: true, extendEnv: false, env: runtimeEnvironment(environment) };
	}

	private async removeStartedService(file: string, launch: ComposeLaunch, project: string, input: Pick<ServiceRunnerStartInput, "onOutput" | "redactions"> & { environment?: Record<string, string> }): Promise<void> {
		const removed = await this.execute("docker", composeArgs(project, file, ["rm", "--stop", "--force", launch.service]), this.commandOptions(input.environment));
		emitOutput(input, removed);
	}

	private async discoverEndpoint(manifest: ServiceRuntimeManifest, file: string, launch: ComposeLaunch, project: string, input: Pick<ServiceRunnerStartInput, "onOutput" | "redactions"> & { environment?: Record<string, string> }): Promise<string> {
		const port = await this.execute("docker", composeArgs(project, file, ["port", launch.service, String(manifest.endpoint.servicePort)]), this.commandOptions(input.environment));
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
