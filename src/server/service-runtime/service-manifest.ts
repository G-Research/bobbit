// src/server/service-runtime/service-manifest.ts
//
// Strict parser for schema-2 pack runtime descriptors. This module deliberately
// has no runner or supervisor dependency: descriptor validation must not start,
// allocate, or inspect a service.

import fs from "node:fs";
import path from "node:path";
import { isSafeRelativePath } from "../agent/tool-contributions.js";
import { isPackPathWithinRoot } from "../extension-host/path-guard.js";

export type ServiceRunMode = "local" | "docker" | "compose";
export type RestartPolicy = "never" | "on-failure";

export type ServiceEnvSource =
	| { value: string }
	| { setting: string }
	| { secret: string; optional?: true }
	| { generatedSecret: string }
	| { endpointPort: true };

export interface HttpProbe {
	path: string;
	expectedStatus: number;
	requestTimeoutMs: number;
	intervalMs: number;
	startupTimeoutMs: number;
}

export interface RuntimeEndpoint {
	protocol: "http" | "https";
	servicePort: number;
	health: HttpProbe;
}

export interface RuntimeStorage {
	setting: string;
	target: string;
	survival: "preserve";
}

export interface RuntimeRestart {
	policy: RestartPolicy;
	maxAttempts: number;
	windowMs: number;
	initialBackoffMs: number;
	maxBackoffMs: number;
}

export interface LocalLaunch {
	command: string;
	args: string[];
	cwd?: string;
	portEnv: string;
	/** Declared listener-host variable, forced to loopback by the local runner. */
	hostEnv: string;
}

export interface DockerLaunch {
	image: string;
	command?: string[];
}

export interface ComposeLaunch {
	file: string;
	service: string;
	projectName: string;
}

export interface ServiceRuntimeManifest {
	apiVersion: 1;
	id: string;
	title: string;
	endpoint: RuntimeEndpoint;
	lifecycle: { startPolicy: "manual"; restart: RuntimeRestart };
	environment: Record<string, ServiceEnvSource>;
	storage?: RuntimeStorage;
	modes: { local: LocalLaunch; docker: DockerLaunch; compose: ComposeLaunch };
}

/** Filesystem provenance required to validate descriptor-owned paths. */
export interface ServiceManifestSourceContext {
	sourceFile: string;
	packRoot: string;
}

const RUNTIME_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SETTING_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/;
const SERVICE_TOKEN_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
// Literal segments and approved substitutions may be safely joined with hyphens.
const PROJECT_TEMPLATE_RE = /^(?:[a-z0-9][a-z0-9_-]*|\$\{(?:packId|runtimeId|serverIdentity)\})(?:[a-z0-9_-]*|\$\{(?:packId|runtimeId|serverIdentity)\})*$/;
const COMMAND_RE = /^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/;
// OCI registry hosts may carry a port (for offline/private registries), while
// image path segments remain shell-free. Resolution still happens only in an
// explicit runner start, never while parsing or saving settings.
const IMAGE_RE = /^(?=.{1,255}$)(?:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?::(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9][A-Za-z0-9._-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;
/** Safe OCI reference accepted on an inert settings save; resolution/pull occurs
 * only when a generic runtime runner explicitly starts. */
export function isSafeServiceImageReference(value: unknown): value is string {
	return typeof value === "string" && IMAGE_RE.test(value);
}
const SHELL_METACHAR_RE = /[\0\r\n;&|`$<>]/;
const LIKELY_SECRET_KEY_RE = /(secret|password|token|api[_-]?key|credential|private[_-]?key)/i;
const LIKELY_SECRET_VALUE_RE = /(?:^|\s)(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_-]{12,}|bearer\s+\S+|eyJ[A-Za-z0-9_-]{10,}\.)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string, problems: string[]): boolean {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) {
			problems.push(`${label} has unknown key ${JSON.stringify(key)}`);
			return false;
		}
	}
	return true;
}

function integerIn(value: unknown, min: number, max: number, label: string, problems: string[]): value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
		problems.push(`${label} must be an integer in ${min}..${max}`);
		return false;
	}
	return true;
}

function stringToken(value: unknown, re: RegExp, label: string, problems: string[]): value is string {
	if (typeof value !== "string" || !re.test(value)) {
		problems.push(`${label} is invalid`);
		return false;
	}
	return true;
}

function parseArgv(value: unknown, label: string, problems: string[]): string[] | null {
	if (!Array.isArray(value)) {
		problems.push(`${label} must be an array of argv strings`);
		return null;
	}
	const result: string[] = [];
	for (const arg of value) {
		if (typeof arg !== "string" || arg.length === 0 || SHELL_METACHAR_RE.test(arg)) {
			problems.push(`${label} must contain non-empty strings without shell metacharacters`);
			return null;
		}
		result.push(arg);
	}
	return result;
}

/** Reject argv forms whose only purpose is to hand descriptor text to a shell. */
function isShellInterpreterInvocation(command: string, args: readonly string[]): boolean {
	const executable = command.replace(/^.*[\\/]/, "").toLowerCase();
	if (["sh", "bash", "dash", "zsh", "ksh", "fish"].includes(executable)) {
		return args.some((arg) => arg === "--command" || /^-[a-z]*c[a-z]*$/i.test(arg));
	}
	if (["cmd", "cmd.exe"].includes(executable)) return args.some((arg) => /^\/c$/i.test(arg));
	if (["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(executable)) {
		return args.some((arg) => /^(?:-|\/)(?:command|c|encodedcommand|ec)$/i.test(arg));
	}
	return false;
}

function rejectShellInterpreterInvocation(command: string, args: readonly string[], label: string, problems: string[]): boolean {
	if (!isShellInterpreterInvocation(command, args)) return false;
	problems.push(`${label} must not invoke a shell interpreter command mode`);
	return true;
}

function isLikelySecretLiteral(envName: string, value: string): boolean {
	return LIKELY_SECRET_KEY_RE.test(envName) || LIKELY_SECRET_VALUE_RE.test(value);
}

function parseEnvironment(value: unknown, problems: string[]): Record<string, ServiceEnvSource> | null {
	if (!isRecord(value)) {
		problems.push("environment must be a mapping");
		return null;
	}
	const result: Record<string, ServiceEnvSource> = {};
	let endpointPortCount = 0;
	for (const [name, raw] of Object.entries(value)) {
		if (!ENV_NAME_RE.test(name)) {
			problems.push(`environment has invalid variable name ${JSON.stringify(name)}`);
			return null;
		}
		if (!isRecord(raw) || !hasOnlyKeys(raw, ["value", "setting", "secret", "generatedSecret", "endpointPort", "optional"], `environment.${name}`, problems)) return null;
		const keys = Object.keys(raw).filter(key => key !== "optional");
		if (keys.length !== 1 || (raw.optional !== undefined && (raw.optional !== true || keys[0] !== "secret"))) {
			problems.push(`environment.${name} must declare exactly one source`);
			return null;
		}
		const key = keys[0]!;
		const source = raw[key];
		if (key === "endpointPort") {
			if (source !== true) {
				problems.push(`environment.${name}.endpointPort must be true`);
				return null;
			}
			endpointPortCount++;
			result[name] = { endpointPort: true };
			continue;
		}
		if (key === "value") {
			// Descriptor literals are values, not setting identifiers. Keep them
			// bounded and text-only while allowing ordinary values such as an IP
			// address; secrets still require the dedicated provenance types.
			if (typeof source !== "string" || source.length === 0 || source.length > 4_096 || /[\0\r\n]/.test(source)) {
				problems.push(`environment.${name}.value must be a bounded non-empty string`);
				return null;
			}
			if (isLikelySecretLiteral(name, source)) {
				problems.push(`environment.${name}.value looks like a secret; use secret or generatedSecret`);
				return null;
			}
			result[name] = { value: source };
		} else {
			if (!stringToken(source, SETTING_NAME_RE, `environment.${name}.${key}`, problems)) return null;
			if (key === "setting") result[name] = { setting: source };
			else if (key === "secret") result[name] = raw.optional === true ? { secret: source, optional: true } : { secret: source };
			else result[name] = { generatedSecret: source };
		}
	}
	if (endpointPortCount !== 1) {
		problems.push("environment must declare exactly one endpointPort source");
		return null;
	}
	return result;
}

function parseEndpoint(value: unknown, problems: string[]): RuntimeEndpoint | null {
	if (!isRecord(value) || !hasOnlyKeys(value, ["protocol", "servicePort", "health"], "endpoint", problems)) return null;
	if (value.protocol !== "http" && value.protocol !== "https") {
		problems.push("endpoint.protocol must be http or https");
		return null;
	}
	if (!integerIn(value.servicePort, 1, 65535, "endpoint.servicePort", problems)) return null;
	if (!isRecord(value.health) || !hasOnlyKeys(value.health, ["path", "expectedStatus", "requestTimeoutMs", "intervalMs", "startupTimeoutMs"], "endpoint.health", problems)) return null;
	const health = value.health;
	if (typeof health.path !== "string" || !/^\/(?!\/)/.test(health.path) || health.path.includes("?") || health.path.includes("#") || health.path.includes("\\") || health.path.includes("..")) {
		problems.push("endpoint.health.path must be an absolute path without host, query, fragment, or traversal");
		return null;
	}
	if (!integerIn(health.expectedStatus, 100, 599, "endpoint.health.expectedStatus", problems)
		|| !integerIn(health.requestTimeoutMs, 100, 10_000, "endpoint.health.requestTimeoutMs", problems)
		|| !integerIn(health.intervalMs, 100, 10_000, "endpoint.health.intervalMs", problems)
		|| !integerIn(health.startupTimeoutMs, 1_000, 300_000, "endpoint.health.startupTimeoutMs", problems)) return null;
	return { protocol: value.protocol, servicePort: value.servicePort, health: {
		path: health.path,
		expectedStatus: health.expectedStatus,
		requestTimeoutMs: health.requestTimeoutMs,
		intervalMs: health.intervalMs,
		startupTimeoutMs: health.startupTimeoutMs,
	} };
}

function parseRestart(value: unknown, problems: string[]): RuntimeRestart | null {
	if (!isRecord(value) || !hasOnlyKeys(value, ["policy", "maxAttempts", "windowMs", "initialBackoffMs", "maxBackoffMs"], "lifecycle.restart", problems)) return null;
	if (value.policy !== "never" && value.policy !== "on-failure") {
		problems.push("lifecycle.restart.policy must be never or on-failure");
		return null;
	}
	if (!integerIn(value.maxAttempts, 0, 10, "lifecycle.restart.maxAttempts", problems)
		|| !integerIn(value.windowMs, 1_000, 3_600_000, "lifecycle.restart.windowMs", problems)
		|| !integerIn(value.initialBackoffMs, 100, 60_000, "lifecycle.restart.initialBackoffMs", problems)
		|| !integerIn(value.maxBackoffMs, value.initialBackoffMs, 300_000, "lifecycle.restart.maxBackoffMs", problems)) return null;
	return { policy: value.policy, maxAttempts: value.maxAttempts, windowMs: value.windowMs, initialBackoffMs: value.initialBackoffMs, maxBackoffMs: value.maxBackoffMs };
}

function isPackPathOrRoot(packRoot: string, candidate: string): boolean {
	if (isPackPathWithinRoot(packRoot, candidate)) return true;
	// The shared guard deliberately excludes the root itself. A descriptor at
	// that root may intentionally use `cwd: .`; prove lexical and realpath root
	// identity so an outside symlink cannot claim the exception.
	try {
		return path.resolve(packRoot) === path.resolve(candidate)
			&& fs.realpathSync(packRoot) === fs.realpathSync(candidate);
	} catch {
		return false;
	}
}

function parseContainedPath(value: unknown, label: string, context: ServiceManifestSourceContext, problems: string[]): string | null {
	// `.` deliberately means the descriptor directory. It remains subject to the
	// same realpath containment check below, while absolute/traversal escapes do not.
	if (typeof value !== "string" || (value !== "." && !isSafeRelativePath(value))) {
		problems.push(`${label} must be a safe pack-relative path`);
		return null;
	}
	const resolved = path.resolve(path.dirname(context.sourceFile), value);
	if (!isPackPathOrRoot(context.packRoot, resolved)) {
		problems.push(`${label} escapes the pack root (including via symlink)`);
		return null;
	}
	return value;
}

function parseModes(value: unknown, environment: Record<string, ServiceEnvSource>, context: ServiceManifestSourceContext, problems: string[]): ServiceRuntimeManifest["modes"] | null {
	if (!isRecord(value) || !hasOnlyKeys(value, ["local", "docker", "compose"], "modes", problems)) return null;
	if (!isRecord(value.local) || !hasOnlyKeys(value.local, ["command", "args", "cwd", "portEnv", "hostEnv"], "modes.local", problems)) return null;
	const local = value.local;
	if (!stringToken(local.command, COMMAND_RE, "modes.local.command", problems) || local.command.includes("..")) return null;
	const localArgs = parseArgv(local.args, "modes.local.args", problems);
	if (!localArgs || rejectShellInterpreterInvocation(local.command, localArgs, "modes.local", problems)
		|| !stringToken(local.portEnv, ENV_NAME_RE, "modes.local.portEnv", problems)
		|| !stringToken(local.hostEnv, ENV_NAME_RE, "modes.local.hostEnv", problems)) return null;
	const portSource = environment[local.portEnv];
	if (!portSource || !("endpointPort" in portSource) || portSource.endpointPort !== true) {
		problems.push("modes.local.portEnv must name the endpointPort environment variable");
		return null;
	}
	const hostSource = environment[local.hostEnv];
	if (local.hostEnv === local.portEnv || !hostSource || !("value" in hostSource) || hostSource.value !== "127.0.0.1") {
		problems.push("modes.local.hostEnv must name a distinct literal 127.0.0.1 environment variable");
		return null;
	}
	let cwd: string | undefined;
	if (local.cwd !== undefined) {
		cwd = parseContainedPath(local.cwd, "modes.local.cwd", context, problems) ?? undefined;
		if (!cwd) return null;
	}

	if (!isRecord(value.docker) || !hasOnlyKeys(value.docker, ["image", "command"], "modes.docker", problems)) return null;
	const docker = value.docker;
	if (!stringToken(docker.image, IMAGE_RE, "modes.docker.image", problems)) return null;
	let dockerCommand: string[] | undefined;
	if (docker.command !== undefined) {
		dockerCommand = parseArgv(docker.command, "modes.docker.command", problems) ?? undefined;
		if (!dockerCommand || rejectShellInterpreterInvocation(dockerCommand[0]!, dockerCommand.slice(1), "modes.docker.command", problems)) return null;
	}

	if (!isRecord(value.compose) || !hasOnlyKeys(value.compose, ["file", "service", "projectName"], "modes.compose", problems)) return null;
	const compose = value.compose;
	const file = parseContainedPath(compose.file, "modes.compose.file", context, problems);
	if (!file || !stringToken(compose.service, SERVICE_TOKEN_RE, "modes.compose.service", problems)
		|| !stringToken(compose.projectName, PROJECT_TEMPLATE_RE, "modes.compose.projectName", problems)) return null;
	// Compose projects are a control boundary: without the persisted gateway
	// identity two gateways could issue scoped commands against the same project.
	if (!compose.projectName.includes("${serverIdentity}")) {
		problems.push("modes.compose.projectName must include ${serverIdentity}");
		return null;
	}
	return {
		local: { command: local.command, args: localArgs, ...(cwd ? { cwd } : {}), portEnv: local.portEnv, hostEnv: local.hostEnv },
		docker: { image: docker.image, ...(dockerCommand ? { command: dockerCommand } : {}) },
		compose: { file, service: compose.service, projectName: compose.projectName },
	};
}

/**
 * Parse an already-decoded YAML descriptor. `null` is a deliberate, safe
 * invalid-descriptor result for discovery; callers performing explicit control
 * can map it to `SERVICE_MANIFEST_INVALID` without preserving raw error text.
 */
export function parseServiceManifest(raw: unknown, context: ServiceManifestSourceContext, problems?: string[]): ServiceRuntimeManifest | null {
	const errors: string[] = [];
	const fail = (): null => {
		problems?.push(...errors);
		return null;
	};
	if (!isPackPathWithinRoot(context.packRoot, context.sourceFile)) {
		errors.push("sourceFile escapes the pack root (including via symlink)");
		return fail();
	}
	if (!isRecord(raw) || !hasOnlyKeys(raw, ["apiVersion", "id", "title", "endpoint", "lifecycle", "environment", "storage", "modes"], "runtime manifest", errors)) return fail();
	if (raw.apiVersion !== 1) {
		errors.push("apiVersion must be 1");
		return fail();
	}
	if (!stringToken(raw.id, RUNTIME_ID_RE, "id", errors) || !stringToken(raw.title, /^\S(?:[\s\S]{0,159}\S)?$/, "title", errors)) return fail();
	const endpoint = parseEndpoint(raw.endpoint, errors);
	const environment = parseEnvironment(raw.environment, errors);
	if (!endpoint || !environment) return fail();
	if (!isRecord(raw.lifecycle) || !hasOnlyKeys(raw.lifecycle, ["startPolicy", "restart"], "lifecycle", errors) || raw.lifecycle.startPolicy !== "manual") {
		errors.push("lifecycle.startPolicy must be manual");
		return fail();
	}
	const restart = parseRestart(raw.lifecycle.restart, errors);
	if (!restart) return fail();
	let storage: RuntimeStorage | undefined;
	if (raw.storage !== undefined) {
		if (!isRecord(raw.storage) || !hasOnlyKeys(raw.storage, ["setting", "target", "survival"], "storage", errors)
			|| !stringToken(raw.storage.setting, SETTING_NAME_RE, "storage.setting", errors)
			|| typeof raw.storage.target !== "string" || !/^\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(raw.storage.target) || raw.storage.target.includes("..") || raw.storage.target.includes("\\")
			|| raw.storage.survival !== "preserve") {
			errors.push("storage must use an absolute contained POSIX target and survival: preserve");
			return fail();
		}
		storage = { setting: raw.storage.setting, target: raw.storage.target, survival: "preserve" };
	}
	const modes = parseModes(raw.modes, environment, context, errors);
	if (!modes) return fail();
	return { apiVersion: 1, id: raw.id.toLowerCase(), title: raw.title, endpoint, lifecycle: { startPolicy: "manual", restart }, environment, ...(storage ? { storage } : {}), modes };
}
