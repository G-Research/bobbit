// src/server/runtime/helpers.ts
//
// P1 — Pure runtime helper utilities.
//
// These helpers prepare the INPUTS a later Docker phase will consume. They are
// deliberately PURE with respect to Docker: NO Docker CLI, NO Docker API, NO
// shelling out. The only side effects are local filesystem writes (the .env
// file) and persisted state via injected stores — both safe to exercise from
// unit tests against temp dirs.

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type {
	RuntimeEnvRef,
	RuntimeEnvValue,
	RuntimeManifest,
	RuntimeModeSpec,
} from "./manifest.js";

// ── Secrets ────────────────────────────────────────────────────────────────

/** Minimal get/set surface — satisfied by SecretsStore and by test fakes. */
export interface SecretLike {
	get(key: string): string | undefined;
	set(key: string, value: string): void;
}

/** Crypto seam so tests can assert exact values; defaults to real randomBytes. */
export interface SecretGenerator {
	(): string;
}

/** The canonical generated-secret format used across the runtime layer. */
export function generateSecretValue(): string {
	return crypto.randomBytes(24).toString("base64url");
}

/**
 * Idempotently return a persisted secret. If a non-empty value already exists
 * under `key` it is returned unchanged; otherwise a new value is generated,
 * persisted via `store.set`, and returned. Repeated calls are stable.
 */
export function getOrCreateRuntimeSecret(
	store: SecretLike,
	key: string,
	generate: SecretGenerator = generateSecretValue,
): string {
	const existing = store.get(key);
	if (typeof existing === "string" && existing.length > 0) return existing;
	const value = generate();
	store.set(key, value);
	return value;
}

// ── Env file rendering ───────────────────────────────────────────────────────

/**
 * Conservatively quote a value for a dotenv file. Always double-quotes and
 * escapes backslash, double-quote, CR and LF so a value can never break out of
 * its line or inject another assignment.
 */
export function escapeDotenvValue(value: string): string {
	const escaped = value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\r/g, "\\r")
		.replace(/\n/g, "\\n");
	return `"${escaped}"`;
}

/**
 * Render `env` to a dotenv file at `filePath` with stable (sorted) key order
 * and mode 0600. Parent directories are created as needed. An existing file's
 * mode is also corrected to 0600 (writeFileSync's mode only applies on create).
 */
export function renderRuntimeEnvFile(filePath: string, env: Record<string, string>): void {
	const keys = Object.keys(env).sort();
	const body = keys.map((k) => `${k}=${escapeDotenvValue(env[k] ?? "")}`).join("\n");
	const content = body.length > 0 ? `${body}\n` : "";
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(filePath, content, { mode: 0o600 });
	// Correct the mode for a pre-existing file (writeFileSync mode is create-only).
	fs.chmodSync(filePath, 0o600);
}

// ── Host port allocation ──────────────────────────────────────────────────────

/** Minimal numeric get/set store for persisted port assignments. */
export interface PortStore {
	get(key: string): number | undefined;
	set(key: string, value: number): void;
}

export interface PortAllocOptions {
	/** Bind host for the probe. Default 127.0.0.1. */
	host?: string;
}

function isValidPort(p: unknown): p is number {
	return typeof p === "number" && Number.isInteger(p) && p >= 1 && p <= 65535;
}

/** Probe a free ephemeral port by binding :0 and reading the assigned port. */
export function probeFreePort(host = "127.0.0.1"): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const server = net.createServer();
		server.once("error", (err) => {
			server.close();
			reject(err);
		});
		server.listen(0, host, () => {
			const addr = server.address();
			if (addr && typeof addr === "object") {
				const port = addr.port;
				server.close(() => resolve(port));
			} else {
				server.close();
				reject(new Error("could not determine allocated port"));
			}
		});
	});
}

/** True if `port` can currently be bound on `host`. */
export function isPortAvailable(port: number, host = "127.0.0.1"): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const server = net.createServer();
		server.once("error", () => {
			server.close();
			resolve(false);
		});
		server.listen(port, host, () => {
			server.close(() => resolve(true));
		});
	});
}

/**
 * Return a persisted host port for `key`, allocating one if none is stored.
 * A valid + currently-bindable persisted port is kept; otherwise a fresh port
 * is probed and persisted.
 */
export async function allocateHostPort(
	store: PortStore,
	key: string,
	opts: PortAllocOptions = {},
): Promise<number> {
	const host = opts.host ?? "127.0.0.1";
	const existing = store.get(key);
	if (isValidPort(existing) && (await isPortAvailable(existing, host))) {
		return existing;
	}
	const port = await probeFreePort(host);
	store.set(key, port);
	return port;
}

/**
 * Boot-time revalidation: keep the persisted port if it is still valid AND
 * available; otherwise allocate + persist a new one. Identical contract to
 * {@link allocateHostPort} but named for the boot path's intent.
 */
export async function revalidateHostPort(
	store: PortStore,
	key: string,
	opts: PortAllocOptions = {},
): Promise<number> {
	return allocateHostPort(store, key, opts);
}

// ── Placeholder substitution ──────────────────────────────────────────────────

/**
 * Substitute `${name}` and `${name:-default}` placeholders using `vars`. A
 * placeholder whose var is missing/empty falls back to its `:-default`; with no
 * default it resolves to the EMPTY string (never left as a literal `${...}`),
 * so unresolved values cannot leak into the env file and `requireEnv` can detect
 * a missing required value as empty.
 */
export function substitutePlaceholders(input: string, vars: Record<string, string> = {}): string {
	return input.replace(/\$\{([A-Za-z0-9_.-]+)(?::-(.*?))?\}/g, (_m, name: string, def?: string) => {
		const v = vars[name];
		if (v !== undefined && v.length > 0) return v;
		if (def !== undefined) return def;
		return "";
	});
}

// ── Env resolution + mode-specific invocation ────────────────────────────────

/** Context supplying resolved values for env refs + placeholders. */
export interface RuntimeResolveContext {
	/** User-configured secret values, keyed by SecretsStore key. */
	secrets?: Record<string, string>;
	/** Generated secret values, keyed by SecretsStore key. */
	generated?: Record<string, string>;
	/** Allocated host ports, keyed by port key. */
	ports?: Record<string, number>;
	/** Variables for ${name} / ${name:-default} placeholder substitution. */
	vars?: Record<string, string>;
}

function resolveEnvValue(value: RuntimeEnvValue, ctx: RuntimeResolveContext): string {
	if (typeof value === "string") {
		return substitutePlaceholders(value, ctx.vars ?? {});
	}
	const ref = value as RuntimeEnvRef;
	if (ref.value !== undefined) return substitutePlaceholders(ref.value, ctx.vars ?? {});
	if (ref.secret !== undefined) {
		const v = ctx.secrets?.[ref.secret];
		if (v === undefined) throw new Error(`runtime env: missing configured secret '${ref.secret}'`);
		return v;
	}
	if (ref.generate !== undefined) {
		const v = ctx.generated?.[ref.generate];
		if (v === undefined) throw new Error(`runtime env: missing generated secret '${ref.generate}'`);
		return v;
	}
	if (ref.port !== undefined) {
		const v = ctx.ports?.[ref.port];
		if (v === undefined) throw new Error(`runtime env: missing allocated port '${ref.port}'`);
		return String(v);
	}
	throw new Error("runtime env: empty env ref");
}

/**
 * Resolve the effective env map for a mode by merging the manifest-level env
 * with the mode-level env overlay and resolving every ref/placeholder. PURE —
 * reads only from `ctx`.
 */
export function resolveRuntimeEnv(
	manifest: RuntimeManifest,
	mode: RuntimeModeSpec | undefined,
	ctx: RuntimeResolveContext,
): Record<string, string> {
	const merged: Record<string, RuntimeEnvValue> = { ...(manifest.env ?? {}), ...(mode?.env ?? {}) };
	const out: Record<string, string> = {};
	for (const name of Object.keys(merged).sort()) {
		out[name] = resolveEnvValue(merged[name], ctx);
	}
	return out;
}

/** Inputs for building a mode-specific invocation. */
export interface RuntimeBuildInputs {
	/** Absolute path of the declaring runtime manifest file (compose anchor). */
	sourceFile: string;
	/** Absolute pack root (compose containment root). */
	packRoot: string;
	/** Path to the rendered .env file to hand to compose. */
	envFile: string;
	/** Resolution context for env refs + placeholders. */
	ctx?: RuntimeResolveContext;
}

/** The data-only result later consumed by the Docker phase. */
export interface RuntimeInvocation {
	runtimeId: string;
	mode: string;
	/** Resolved absolute compose file path (containment already enforced). */
	composeFile: string;
	/** Path to the .env file. */
	envFile: string;
	/** Compose services to bring up (empty = compose default). */
	services: string[];
	/** Compose profiles to activate. */
	profiles: string[];
	/** Fully resolved environment for the mode. */
	env: Record<string, string>;
}

/**
 * Build a mode-specific, data-only invocation. NO Docker execution. The compose
 * path is re-validated for containment (defense-in-depth); env refs/placeholders
 * are resolved; the mode's `omitServices` are removed from `services`.
 *
 * The managed-postgres mode keeps the `db` service + managed DB env, while the
 * external-postgres mode omits `db` and is expected to inject
 * HINDSIGHT_API_DATABASE_URL via its mode `env` (a `${databaseUrl}` placeholder
 * or a literal) — both expressed declaratively in the manifest.
 */
export function buildRuntimeInvocation(
	manifest: RuntimeManifest,
	mode: string,
	inputs: RuntimeBuildInputs,
): RuntimeInvocation {
	const modeSpec = manifest.modes?.[mode];
	if (!modeSpec) throw new Error(`runtime '${manifest.id}' has no mode '${mode}'`);

	const baseDir = path.dirname(path.resolve(inputs.sourceFile));
	const rootAbs = path.resolve(inputs.packRoot);
	const composeAbs = path.resolve(baseDir, manifest.composeFile);
	const rel = path.relative(rootAbs, composeAbs);
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(`runtime '${manifest.id}' composeFile escapes the pack root`);
	}

	const ctx = inputs.ctx ?? {};

	// Validate required env for the mode resolves before rendering.
	const env = resolveRuntimeEnv(manifest, modeSpec, ctx);
	for (const required of modeSpec.requireEnv ?? []) {
		if (env[required] === undefined || env[required].length === 0) {
			throw new Error(`runtime '${manifest.id}' mode '${mode}' requires env '${required}'`);
		}
	}

	const omit = new Set(modeSpec.omitServices ?? []);
	const services = (modeSpec.services ?? []).filter((s) => !omit.has(s));
	const profiles = [...(modeSpec.profiles ?? [])];

	return {
		runtimeId: manifest.id,
		mode,
		composeFile: composeAbs,
		envFile: inputs.envFile,
		services,
		profiles,
		env,
	};
}
