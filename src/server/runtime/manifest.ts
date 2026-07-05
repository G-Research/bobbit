// src/server/runtime/manifest.ts
//
// P1 — Runtime manifest parser/validator (PURE).
//
// Parses pack-authored `runtimes/<name>.yaml` descriptors into a typed
// {@link RuntimeManifest}. This module is intentionally PURE: it performs NO
// Docker CLI/API calls, NO compose expansion, and NO filesystem reads of the
// compose file itself. The only path work it does is a LEXICAL containment
// check that rejects a `composeFile` which — after being resolved relative to
// the declaring manifest file — would escape the pack root (the explicit
// "compose-path escape rejection" requirement of the P1 design).
//
// Validation is tolerant in the same spirit as the pack-contribution loaders:
// problems are pushed onto an optional `problems[]` sink and the parse returns
// `null` for an unusable manifest rather than throwing.

import path from "node:path";
import { parse } from "yaml";
import { isSafeRelativePath } from "../agent/tool-contributions.js";

/** Runtime/runtime-mode ids: lowercase-friendly, dotted/dashed allowed. */
const RUNTIME_ID_RE = /^[a-z0-9][a-z0-9_.-]*$/i;
/** Env var names: conventional shell-env identifiers. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Persistence keys for secrets/ports: safe key tokens. */
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/** A declarative reference for an env value that is resolved at build time. */
export interface RuntimeEnvRef {
	/** Resolve from a USER-CONFIGURED secret (e.g. the LLM API key). */
	secret?: string;
	/** Resolve from a GENERATED+persisted secret (idempotent). */
	generate?: string;
	/** Resolve from an allocated host port (rendered as a string). */
	port?: string;
	/** Literal value (supports ${var} / ${var:-default} placeholders). */
	value?: string;
}

export type RuntimeEnvValue = string | RuntimeEnvRef;

/** A secret the runtime needs available before launch. */
export interface RuntimeSecretSpec {
	/** SecretsStore key under which the value lives / is persisted. */
	key: string;
	/** When true the value is generated+persisted; otherwise user-supplied. */
	generate?: boolean;
	/** Optional env var name to expose the value under. */
	env?: string;
}

/** A host port the runtime needs allocated + persisted. */
export interface RuntimePortSpec {
	/** Persistence key for the chosen host port. */
	key: string;
	/** Optional env var name to expose the chosen port under. */
	env?: string;
	/** Informational container-side port. */
	container?: number;
}

/** A launch mode (e.g. managed-postgres vs external-postgres). */
export interface RuntimeModeSpec {
	title?: string;
	/** Compose services to bring up for this mode. */
	services?: string[];
	/** Compose profiles to activate for this mode. */
	profiles?: string[];
	/** Services explicitly excluded (external-postgres omits `db`). */
	omitServices?: string[];
	/** Mode-specific env overlay (merged over manifest.env). */
	env?: Record<string, RuntimeEnvValue>;
	/** Env var names that MUST be supplied for this mode (validation hint). */
	requireEnv?: string[];
}

/** Declarative link from a PROVIDER-level "deployment mode" value (e.g. a
 *  Hindsight-style `managed` / `managed-external-postgres` config `mode`)
 *  onto this runtime manifest's OWN mode id (a key of {@link RuntimeManifest.modes}).
 *  A deployment-mode value with NO entry in `deploymentModes` has no
 *  Docker-backed runtime mode — it is the non-Docker / operator-supplied setup
 *  path, so no runtime start is requested for it. Consumed by
 *  `resolveRuntimeStartPlan` (src/server/server.ts) — see S1 in
 *  docs/design (extension-seam audit): this replaces what used to be a
 *  hard-coded mode-name switch in core. */
export interface RuntimeDeploymentModeSpec {
	/** This runtime manifest's mode id to start under. */
	runtimeMode: string;
}

export interface RuntimeManifest {
	id: string;
	title?: string;
	description?: string;
	/** Pack-relative compose file, resolved relative to the manifest's dir. */
	composeFile: string;
	env?: Record<string, RuntimeEnvValue>;
	secrets?: RuntimeSecretSpec[];
	ports?: RuntimePortSpec[];
	modes?: Record<string, RuntimeModeSpec>;
	/** Provider deployment-config `mode` value → this manifest's own mode id.
	 *  See {@link RuntimeDeploymentModeSpec}. */
	deploymentModes?: Record<string, RuntimeDeploymentModeSpec>;
	/** Provider deployment-config FIELD name → this manifest's ENV KEY (e.g. a
	 *  provider's `externalDatabaseUrl` field onto `HINDSIGHT_API_DATABASE_URL`).
	 *  A value already present under the target env key wins (never
	 *  overwritten) — the precedence rule is enforced by the consumer
	 *  (`resolveRuntimeStartPlan`), not by this schema. */
	configRemap?: Record<string, string>;
}

function note(problems: string[] | undefined, msg: string): void {
	if (problems) problems.push(msg);
}

/** True for a syntactically valid runtime/mode id. */
export function isSafeRuntimeId(id: unknown): id is string {
	return typeof id === "string" && id.length > 0 && RUNTIME_ID_RE.test(id);
}

/**
 * LEXICAL containment check for a pack-relative compose path. Resolves
 * `composeFile` relative to the directory of `sourceFile`, then requires the
 * result to stay inside `packRoot`. PURE — never touches the filesystem.
 *
 * @returns the resolved absolute compose path when contained, else null.
 */
export function resolveContainedComposePath(
	composeFile: string,
	sourceFile: string,
	packRoot: string,
): string | null {
	if (!isSafeRelativePath(composeFile)) return null;
	const baseDir = path.dirname(path.resolve(sourceFile));
	const rootAbs = path.resolve(packRoot);
	const composeAbs = path.resolve(baseDir, composeFile);
	const rel = path.relative(rootAbs, composeAbs);
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
	return composeAbs;
}

function validateEnvValue(raw: unknown, label: string, problems?: string[]): RuntimeEnvValue | null {
	if (typeof raw === "string") return raw;
	if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		note(problems, `${label}: env value must be a string or {secret|generate|port|value} ref`);
		return null;
	}
	const obj = raw as Record<string, unknown>;
	const ref: RuntimeEnvRef = {};
	let count = 0;
	for (const k of ["secret", "generate", "port", "value"] as const) {
		const v = obj[k];
		if (v === undefined) continue;
		if (typeof v !== "string" || v.length === 0) {
			note(problems, `${label}: env ref '${k}' must be a non-empty string`);
			return null;
		}
		(ref as Record<string, string>)[k] = v;
		count++;
	}
	if (count !== 1) {
		note(problems, `${label}: env ref must declare exactly one of secret|generate|port|value`);
		return null;
	}
	return ref;
}

function validateEnvMap(
	raw: unknown,
	label: string,
	problems?: string[],
): Record<string, RuntimeEnvValue> | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		note(problems, `${label} must be a mapping`);
		return null;
	}
	const out: Record<string, RuntimeEnvValue> = {};
	for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
		if (!ENV_NAME_RE.test(name)) {
			note(problems, `${label}: invalid env name ${JSON.stringify(name)}`);
			return null;
		}
		const val = validateEnvValue(v, `${label}.${name}`, problems);
		if (val === null) return null;
		out[name] = val;
	}
	return out;
}

function validateStringArray(raw: unknown, label: string, problems?: string[]): string[] | null {
	if (!Array.isArray(raw)) {
		note(problems, `${label} must be an array of strings`);
		return null;
	}
	const out: string[] = [];
	for (const v of raw) {
		if (typeof v !== "string" || v.length === 0) {
			note(problems, `${label} entries must be non-empty strings`);
			return null;
		}
		out.push(v);
	}
	return out;
}

function validateSecrets(raw: unknown, problems?: string[]): RuntimeSecretSpec[] | null {
	if (!Array.isArray(raw)) {
		note(problems, "secrets must be an array");
		return null;
	}
	const out: RuntimeSecretSpec[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			note(problems, "secrets[]: each entry must be a mapping");
			return null;
		}
		const obj = item as Record<string, unknown>;
		if (typeof obj.key !== "string" || !KEY_RE.test(obj.key)) {
			note(problems, `secrets[]: invalid key ${JSON.stringify(obj.key)}`);
			return null;
		}
		if (seen.has(obj.key)) {
			note(problems, `secrets[]: duplicate key ${JSON.stringify(obj.key)}`);
			return null;
		}
		seen.add(obj.key);
		const spec: RuntimeSecretSpec = { key: obj.key };
		if (obj.generate !== undefined) {
			if (typeof obj.generate !== "boolean") {
				note(problems, `secrets[${obj.key}]: generate must be a boolean`);
				return null;
			}
			spec.generate = obj.generate;
		}
		if (obj.env !== undefined) {
			if (typeof obj.env !== "string" || !ENV_NAME_RE.test(obj.env)) {
				note(problems, `secrets[${obj.key}]: invalid env name`);
				return null;
			}
			spec.env = obj.env;
		}
		out.push(spec);
	}
	return out;
}

function validatePorts(raw: unknown, problems?: string[]): RuntimePortSpec[] | null {
	if (!Array.isArray(raw)) {
		note(problems, "ports must be an array");
		return null;
	}
	const out: RuntimePortSpec[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			note(problems, "ports[]: each entry must be a mapping");
			return null;
		}
		const obj = item as Record<string, unknown>;
		if (typeof obj.key !== "string" || !KEY_RE.test(obj.key)) {
			note(problems, `ports[]: invalid key ${JSON.stringify(obj.key)}`);
			return null;
		}
		if (seen.has(obj.key)) {
			note(problems, `ports[]: duplicate key ${JSON.stringify(obj.key)}`);
			return null;
		}
		seen.add(obj.key);
		const spec: RuntimePortSpec = { key: obj.key };
		if (obj.env !== undefined) {
			if (typeof obj.env !== "string" || !ENV_NAME_RE.test(obj.env)) {
				note(problems, `ports[${obj.key}]: invalid env name`);
				return null;
			}
			spec.env = obj.env;
		}
		if (obj.container !== undefined) {
			if (typeof obj.container !== "number" || !Number.isInteger(obj.container) || obj.container < 1 || obj.container > 65535) {
				note(problems, `ports[${obj.key}]: container must be an integer in 1..65535`);
				return null;
			}
			spec.container = obj.container;
		}
		out.push(spec);
	}
	return out;
}

function validateModes(raw: unknown, problems?: string[]): Record<string, RuntimeModeSpec> | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		note(problems, "modes must be a mapping");
		return null;
	}
	const out: Record<string, RuntimeModeSpec> = {};
	for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
		if (!isSafeRuntimeId(name)) {
			note(problems, `modes: invalid mode id ${JSON.stringify(name)}`);
			return null;
		}
		if (!v || typeof v !== "object" || Array.isArray(v)) {
			note(problems, `modes.${name} must be a mapping`);
			return null;
		}
		const obj = v as Record<string, unknown>;
		const spec: RuntimeModeSpec = {};
		if (typeof obj.title === "string") spec.title = obj.title;
		if (obj.services !== undefined) {
			const arr = validateStringArray(obj.services, `modes.${name}.services`, problems);
			if (arr === null) return null;
			spec.services = arr;
		}
		if (obj.profiles !== undefined) {
			const arr = validateStringArray(obj.profiles, `modes.${name}.profiles`, problems);
			if (arr === null) return null;
			spec.profiles = arr;
		}
		if (obj.omitServices !== undefined) {
			const arr = validateStringArray(obj.omitServices, `modes.${name}.omitServices`, problems);
			if (arr === null) return null;
			spec.omitServices = arr;
		}
		if (obj.requireEnv !== undefined) {
			const arr = validateStringArray(obj.requireEnv, `modes.${name}.requireEnv`, problems);
			if (arr === null) return null;
			spec.requireEnv = arr;
		}
		if (obj.env !== undefined) {
			const env = validateEnvMap(obj.env, `modes.${name}.env`, problems);
			if (env === null) return null;
			spec.env = env;
		}
		out[name] = spec;
	}
	return out;
}

function validateDeploymentModes(raw: unknown, problems?: string[]): Record<string, RuntimeDeploymentModeSpec> | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		note(problems, "deploymentModes must be a mapping");
		return null;
	}
	const out: Record<string, RuntimeDeploymentModeSpec> = {};
	for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
		if (!v || typeof v !== "object" || Array.isArray(v)) {
			note(problems, `deploymentModes.${name} must be a mapping`);
			return null;
		}
		const obj = v as Record<string, unknown>;
		if (typeof obj.runtimeMode !== "string" || obj.runtimeMode.length === 0) {
			note(problems, `deploymentModes.${name}: runtimeMode must be a non-empty string`);
			return null;
		}
		out[name] = { runtimeMode: obj.runtimeMode };
	}
	return out;
}

function validateConfigRemap(raw: unknown, problems?: string[]): Record<string, string> | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		note(problems, "configRemap must be a mapping");
		return null;
	}
	const out: Record<string, string> = {};
	for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof v !== "string" || !ENV_NAME_RE.test(v)) {
			note(problems, `configRemap.${name}: value must be a valid env var name`);
			return null;
		}
		out[name] = v;
	}
	return out;
}

/**
 * Validate an already-parsed runtime descriptor. Returns the typed manifest or
 * null; problems (when provided) accumulate human-readable reasons.
 */
export function validateRuntimeManifest(
	data: unknown,
	sourceFile: string,
	packRoot: string,
	problems?: string[],
): RuntimeManifest | null {
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		note(problems, "runtime manifest must be a mapping");
		return null;
	}
	const obj = data as Record<string, unknown>;

	if (!isSafeRuntimeId(obj.id)) {
		note(problems, `runtime manifest has invalid/missing id ${JSON.stringify(obj.id)}`);
		return null;
	}
	if (typeof obj.composeFile !== "string" || obj.composeFile.length === 0) {
		note(problems, "runtime manifest is missing composeFile");
		return null;
	}
	if (resolveContainedComposePath(obj.composeFile, sourceFile, packRoot) === null) {
		note(problems, `composeFile ${JSON.stringify(obj.composeFile)} escapes the pack root or is unsafe`);
		return null;
	}

	const manifest: RuntimeManifest = { id: obj.id, composeFile: obj.composeFile };
	if (typeof obj.title === "string") manifest.title = obj.title;
	if (typeof obj.description === "string") manifest.description = obj.description;

	if (obj.env !== undefined) {
		const env = validateEnvMap(obj.env, "env", problems);
		if (env === null) return null;
		manifest.env = env;
	}
	if (obj.secrets !== undefined) {
		const secrets = validateSecrets(obj.secrets, problems);
		if (secrets === null) return null;
		manifest.secrets = secrets;
	}
	if (obj.ports !== undefined) {
		const ports = validatePorts(obj.ports, problems);
		if (ports === null) return null;
		manifest.ports = ports;
	}
	if (obj.modes !== undefined) {
		const modes = validateModes(obj.modes, problems);
		if (modes === null) return null;
		manifest.modes = modes;
	}
	if (obj.deploymentModes !== undefined) {
		const deploymentModes = validateDeploymentModes(obj.deploymentModes, problems);
		if (deploymentModes === null) return null;
		manifest.deploymentModes = deploymentModes;
	}
	if (obj.configRemap !== undefined) {
		const configRemap = validateConfigRemap(obj.configRemap, problems);
		if (configRemap === null) return null;
		manifest.configRemap = configRemap;
	}

	return manifest;
}

/**
 * Parse runtime YAML text into a validated {@link RuntimeManifest}. Returns
 * null (and records the reason) on malformed YAML or failed validation.
 */
export function parseRuntimeManifest(
	raw: string,
	sourceFile: string,
	packRoot: string,
	problems?: string[],
): RuntimeManifest | null {
	let data: unknown;
	try {
		data = parse(raw);
	} catch (err) {
		note(problems, `runtime manifest ${sourceFile} is not valid YAML: ${String(err)}`);
		return null;
	}
	return validateRuntimeManifest(data, sourceFile, packRoot, problems);
}
