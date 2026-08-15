// src/server/extension-host/service-extension-contract.ts
//
// The deliberately small, declarative boundary for managed service extensions.
// Packs describe a service; core owns commands, processes, paths, and diagnostics.

import { isSafeExtensionGrantIdentifier } from "../agent/project-config-store.js";

export type ServiceRunMode = "local" | "docker" | "compose";
export type ServiceState = "stopped" | "starting" | "ready" | "unhealthy" | "failed";
export type ServiceRestartPolicy = "never" | "on-failure";
export type ServiceStatusDetail =
	| "starting"
	| "readiness-timeout"
	| "port-conflict"
	| "process-exited"
	| "configuration-unavailable";

export interface ServiceReadiness {
	/** A loopback HTTP(S) endpoint. Remote endpoints are never a service probe. */
	url?: string;
	/** A core-recognized, shell-free probe command. */
	command?: string;
	timeoutMs: number;
}

export interface ServiceExtensionSpec {
	id: string;
	runMode: ServiceRunMode;
	readiness: ServiceReadiness;
	stopGraceMs: number;
	restart: ServiceRestartPolicy;
	ports?: readonly number[];
	/** A relative declaration. The runtime chooses the actual owned directory. */
	dataDir?: string;
}

/** Runtime-selected, bounded instance discriminator; it is never a filesystem path. */
export type ServiceInstanceDiscriminator = string;

/**
 * All fields are derived by core. `canonicalWorktreeRoot` is internal-only and
 * must never be serialized into status, host APIs, logs, or worker context.
 */
export interface ServiceInstanceRef {
	projectId: string;
	component: string;
	canonicalWorktreeRoot: string;
	worktreeKey: string;
	packId: string;
	serviceId: string;
	discriminator: ServiceInstanceDiscriminator;
}

/** The path-free projection which is permitted to leave core lifecycle code. */
export type ServiceInstancePublicRef = Omit<ServiceInstanceRef, "canonicalWorktreeRoot">;

/** The only service state that can leave the runtime. It intentionally has no logs or host paths. */
export interface ServiceStatus {
	ref: ServiceInstancePublicRef;
	state: ServiceState;
	updatedAt: string;
	detail?: ServiceStatusDetail;
}

export type ServiceSpecDiagnosticCode =
	| "invalid-object"
	| "unknown-key"
	| "invalid-id"
	| "invalid-run-mode"
	| "invalid-readiness"
	| "invalid-timeout"
	| "invalid-stop-grace"
	| "invalid-restart-policy"
	| "invalid-port"
	| "duplicate-port"
	| "invalid-data-dir";

/** Deliberately value-free: malformed declarations and secrets cannot leak in errors. */
export interface ServiceSpecDiagnostic {
	code: ServiceSpecDiagnosticCode;
	path: string;
}

export type ServiceSpecValidation =
	| { ok: true; value: ServiceExtensionSpec }
	| { ok: false; diagnostics: readonly ServiceSpecDiagnostic[] };

const SPEC_KEYS = new Set(["id", "runMode", "readiness", "stopGraceMs", "restart", "ports", "dataDir"]);
const READINESS_KEYS = new Set(["url", "command", "timeoutMs"]);
const PUBLIC_REF_KEYS = new Set(["projectId", "component", "worktreeKey", "packId", "serviceId", "discriminator"]);
const RUN_MODES = new Set<ServiceRunMode>(["local", "docker", "compose"]);
const RESTART_POLICIES = new Set<ServiceRestartPolicy>(["never", "on-failure"]);
const STATES = new Set<ServiceState>(["stopped", "starting", "ready", "unhealthy", "failed"]);
const DETAILS = new Set<ServiceStatusDetail>([
	"starting", "readiness-timeout", "port-conflict", "process-exited", "configuration-unavailable",
]);

const MIN_DURATION_MS = 100;
const MAX_DURATION_MS = 60_000;
const SAFE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_DISCRIMINATOR = /^[a-z][a-z0-9-]{0,31}$/;
const WORKTREE_KEY = /^[A-Za-z0-9_-]{22}$/;
// The string names a core probe adapter; it is not a command line or executable path.
const SAFE_COMMAND = /^[a-z][a-z0-9-]{0,63}$/;
const SHELL_COMMANDS = new Set(["sh", "bash", "zsh", "cmd", "powershell", "pwsh", "node", "python", "curl"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string, diagnostics: ServiceSpecDiagnostic[]): boolean {
	let valid = true;
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) {
			diagnostics.push({ code: "unknown-key", path: `${path}.${key}` });
			valid = false;
		}
	}
	return valid;
}

function boundedDuration(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= MIN_DURATION_MS && value <= MAX_DURATION_MS;
}

/** Only core chooses this value; consumers can validate, but never derive, it. */
export function isServiceInstanceDiscriminator(value: unknown): value is ServiceInstanceDiscriminator {
	return typeof value === "string" && SAFE_DISCRIMINATOR.test(value);
}

/** Validates a path-free status identity. It deliberately has no root/path field. */
export function isServiceInstancePublicRef(value: unknown): value is ServiceInstancePublicRef {
	if (!isRecord(value) || !hasOnlyKeys(value, PUBLIC_REF_KEYS, "", [])) return false;
	return isSafeExtensionGrantIdentifier(value.projectId)
		&& (value.component === "." || isSafeExtensionGrantIdentifier(value.component))
		&& typeof value.worktreeKey === "string" && WORKTREE_KEY.test(value.worktreeKey)
		&& isSafeExtensionGrantIdentifier(value.packId)
		&& typeof value.serviceId === "string" && SAFE_ID.test(value.serviceId)
		&& isServiceInstanceDiscriminator(value.discriminator);
}

function isSafeDataDir(value: string): boolean {
	if (!value || value.length > 240 || value.includes("\0") || value.includes("\\") || value.startsWith("/")) return false;
	return value.split("/").every(segment => segment !== "" && segment !== "." && segment !== ".." && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment));
}

function isLoopbackUrl(value: string): boolean {
	if (value.length > 1_024 || value.includes("${") || value.includes("{") || value.includes("}")) return false;
	try {
		const parsed = new URL(value);
		return (parsed.protocol === "http:" || parsed.protocol === "https:")
			&& (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]")
			&& !parsed.username && !parsed.password && !parsed.hash;
	} catch {
		return false;
	}
}

/**
 * Validate and copy a pack declaration. Unknown fields are errors rather than
 * future pass-throughs so a newer pack cannot silently request new authority.
 */
export function validateServiceExtensionSpec(input: unknown): ServiceSpecValidation {
	const diagnostics: ServiceSpecDiagnostic[] = [];
	if (!isRecord(input)) return { ok: false, diagnostics: [{ code: "invalid-object", path: "$" }] };
	hasOnlyKeys(input, SPEC_KEYS, "$", diagnostics);

	if (typeof input.id !== "string" || !SAFE_ID.test(input.id)) diagnostics.push({ code: "invalid-id", path: "$.id" });
	if (typeof input.runMode !== "string" || !RUN_MODES.has(input.runMode as ServiceRunMode)) diagnostics.push({ code: "invalid-run-mode", path: "$.runMode" });
	if (!boundedDuration(input.stopGraceMs)) diagnostics.push({ code: "invalid-stop-grace", path: "$.stopGraceMs" });
	if (typeof input.restart !== "string" || !RESTART_POLICIES.has(input.restart as ServiceRestartPolicy)) diagnostics.push({ code: "invalid-restart-policy", path: "$.restart" });

	if (!isRecord(input.readiness)) {
		diagnostics.push({ code: "invalid-readiness", path: "$.readiness" });
	} else {
		hasOnlyKeys(input.readiness, READINESS_KEYS, "$.readiness", diagnostics);
		const { url, command, timeoutMs } = input.readiness;
		if (!boundedDuration(timeoutMs)) diagnostics.push({ code: "invalid-timeout", path: "$.readiness.timeoutMs" });
		if ((url === undefined && command === undefined) || (url !== undefined && command !== undefined)
			|| (url !== undefined && (typeof url !== "string" || !isLoopbackUrl(url)))
			|| (command !== undefined && (typeof command !== "string" || !SAFE_COMMAND.test(command) || SHELL_COMMANDS.has(command)))) {
			diagnostics.push({ code: "invalid-readiness", path: "$.readiness" });
		}
	}

	let ports: number[] | undefined;
	if (input.ports !== undefined) {
		if (!Array.isArray(input.ports) || input.ports.length > 32) {
			diagnostics.push({ code: "invalid-port", path: "$.ports" });
		} else {
			ports = [];
			const seen = new Set<number>();
			for (let index = 0; index < input.ports.length; index++) {
				const port = input.ports[index];
				if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) diagnostics.push({ code: "invalid-port", path: `$.ports[${index}]` });
				else if (seen.has(port)) diagnostics.push({ code: "duplicate-port", path: `$.ports[${index}]` });
				else { seen.add(port); ports.push(port); }
			}
		}
	}

	if (input.dataDir !== undefined && (typeof input.dataDir !== "string" || !isSafeDataDir(input.dataDir))) diagnostics.push({ code: "invalid-data-dir", path: "$.dataDir" });
	if (diagnostics.length > 0) return { ok: false, diagnostics };

	const readiness = input.readiness as Record<string, unknown>;
	return {
		ok: true,
		value: {
			id: input.id as string,
			runMode: input.runMode as ServiceRunMode,
			readiness: { ...(readiness.url === undefined ? {} : { url: readiness.url as string }), ...(readiness.command === undefined ? {} : { command: readiness.command as string }), timeoutMs: readiness.timeoutMs as number },
			stopGraceMs: input.stopGraceMs as number,
			restart: input.restart as ServiceRestartPolicy,
			...(ports === undefined ? {} : { ports }),
			...(input.dataDir === undefined ? {} : { dataDir: input.dataDir as string }),
		},
	};
}

/** State transitions used by the runtime. Terminal failures may be restarted by core. */
const ALLOWED_SERVICE_STATE_TRANSITIONS: Readonly<Record<ServiceState, readonly ServiceState[]>> = {
	stopped: ["starting"],
	starting: ["ready", "unhealthy", "failed", "stopped"],
	ready: ["failed", "unhealthy", "stopped"],
	unhealthy: ["starting", "stopped"],
	failed: ["starting", "stopped"],
};

export function isServiceStateTransitionAllowed(from: ServiceState, to: ServiceState): boolean {
	return from === to || ALLOWED_SERVICE_STATE_TRANSITIONS[from].includes(to);
}

/** Normalize an untrusted status projection, dropping anything not public-safe. */
export function normalizeServiceStatus(input: unknown): ServiceStatus | undefined {
	if (!isRecord(input) || !isServiceInstancePublicRef(input.ref)
		|| typeof input.state !== "string" || !STATES.has(input.state as ServiceState)
		|| typeof input.updatedAt !== "string" || !Number.isFinite(Date.parse(input.updatedAt))) return undefined;
	if (input.detail !== undefined && (typeof input.detail !== "string" || !DETAILS.has(input.detail as ServiceStatusDetail))) return undefined;
	const state = input.state as ServiceState;
	const detail = input.detail as ServiceStatusDetail | undefined;
	const validDetail = detail === undefined
		? state === "stopped" || state === "ready"
		: (state === "starting" && detail === "starting")
			|| (state === "unhealthy" && (detail === "readiness-timeout" || detail === "port-conflict"))
			|| (state === "failed" && (detail === "process-exited" || detail === "configuration-unavailable"));
	if (!validDetail) return undefined;
	const ref = input.ref;
	return {
		ref: {
			projectId: ref.projectId,
			component: ref.component,
			worktreeKey: ref.worktreeKey,
			packId: ref.packId,
			serviceId: ref.serviceId,
			discriminator: ref.discriminator,
		},
		state,
		updatedAt: input.updatedAt,
		...(detail === undefined ? {} : { detail }),
	};
}

/** Remove supplied secret values and clip diagnostic text before local use. Never expose it in ServiceStatus. */
export function redactServiceDiagnostic(value: unknown, secretValues: readonly string[] = []): string {
	let text = value instanceof Error ? value.message : typeof value === "string" ? value : "Service extension operation failed";
	for (const secret of secretValues) if (secret) text = text.split(secret).join("[REDACTED]");
	return text.replace(/[\r\n\t]+/g, " ").slice(0, 512) || "Service extension operation failed";
}
