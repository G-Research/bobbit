// src/server/runtimes/pack-runtime-supervisor.ts
//
// P2 — Docker-backed managed-runtime supervisor.
//
// Builds on the PURE P1 runtime manifest layer (`src/server/runtime/*`). This
// module is the ONLY place that shells out to Docker for managed pack runtimes.
// All Docker invocation goes through `execFile` (never a shell string) via an
// injectable executor so unit/API tests can fully mock Docker — production code
// must never run a real Docker daemon during automated tests.
//
// Design: docs/design — "P2 PackRuntimeSupervisor + REST design".

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import type { PackContributionResolver } from "../extension-host/pack-contribution-registry.js";
import type { RuntimeContribution } from "../agent/pack-contributions.js";
import {
	validateRuntimeManifest,
	type RuntimeManifest,
} from "../runtime/manifest.js";
import {
	buildRuntimeInvocation,
	renderRuntimeEnvFile,
	getOrCreateRuntimeSecret,
	generateSecretValue,
	allocateHostPort,
	probeFreePort,
	substitutePlaceholders,
	type RuntimeInvocation,
	type RuntimeResolveContext,
	type SecretLike,
	type PortStore,
} from "../runtime/helpers.js";

const execFileAsync = promisify(execFileCb);

// ── Public types ─────────────────────────────────────────────────────────────

export type PackRuntimeStatusState =
	| "docker-unavailable"
	| "stopped"
	| "starting"
	| "running"
	| "unhealthy";

export interface PackRuntimeServiceStatus {
	name: string;
	state?: string;
	health?: string;
}

export interface PackRuntimeDescriptor {
	/** Stable, URL-safe, reversible API id (see {@link encodePackRuntimeId}). */
	id: string;
	packId: string;
	packName?: string;
	runtimeId: string;
	title?: string;
	description?: string;
}

export interface PackRuntimeStatus extends PackRuntimeDescriptor {
	status: PackRuntimeStatusState;
	mode?: string;
	composeProject: string;
	services?: PackRuntimeServiceStatus[];
	message?: string;
}

/**
 * Start policy for a managed runtime (P3 — consent/activation layer).
 *
 * - `manual`   : the runtime NEVER starts implicitly. A user must explicitly
 *                start it (runtime UI / `POST /api/pack-runtimes/:id/start`).
 * - `on-enable`: enabling the runtime via the marketplace pack-activation toggle
 *                IS the explicit user start action — and the ONLY implicit-start
 *                trigger. Boot, install, update, list and status must still never
 *                bring the runtime up.
 *
 * Existing descriptors with no declared policy default to `manual` (no
 * auto-start), preserving the P2 behaviour.
 */
export type PackRuntimeStartPolicy = "manual" | "on-enable";

/** One declared host port in a {@link PackRuntimeCapabilitySummary}. */
export interface PackRuntimeCapabilityPort {
	/** Manifest persistence/env key (e.g. HINDSIGHT_API_PORT). */
	key: string;
	/** Env var name the chosen host port is exposed under, when declared. */
	env?: string;
	/** Informational container-side port. */
	container?: number;
	/** Allocated/persisted host port when one is already known (never allocates). */
	host?: number;
}

/**
 * Pre-start consent disclosure for a managed runtime (P3 §8). Derived purely
 * from the validated manifest + selected mode + already-persisted ports — it
 * NEVER touches Docker and NEVER allocates new ports/secrets, so it is safe to
 * render before the user has consented to a start.
 */
export interface PackRuntimeCapabilitySummary extends PackRuntimeDescriptor {
	/** Selected (or default) runtime mode the summary describes. */
	mode: string;
	/** Whether enabling this runtime starts it (`on-enable`) or not (`manual`). */
	startPolicy: PackRuntimeStartPolicy;
	/** Collision-guarded compose project name. */
	composeProject: string;
	/** Compose services started for the selected mode (after `omitServices`). */
	services: string[];
	/** Service/image names disclosed to the user (currently the service list). */
	images: string[];
	/** Declared host ports + their persisted host assignment when known. */
	ports: PackRuntimeCapabilityPort[];
	/** Effective data/volume path for managed data (e.g. ~/.hindsight). */
	volumePath?: string;
	/** First-party memory/trust disclosure copy. */
	trust: string;
}

/** Options/result shapes for the injectable Docker executor. */
export interface DockerExecOptions {
	env: NodeJS.ProcessEnv;
	timeout: number;
	windowsHide: boolean;
	maxBuffer: number;
	encoding: "utf-8";
}
export interface DockerExecResult {
	stdout: string;
	stderr: string;
}
export type DockerExecutor = (
	file: string,
	args: readonly string[],
	options: DockerExecOptions,
) => Promise<DockerExecResult>;

export interface PackRuntimeSupervisorOptions {
	/** Resolves active pack runtime contributions for a project scope. */
	registry: PackContributionResolver;
	/** Docker executable; defaults to `process.env.DOCKER_BIN || "docker"`. */
	dockerBin?: string;
	/** Docker invocation seam; defaults to promisified `execFile`. */
	executor?: DockerExecutor;
	/** Per-server suffix on compose project names (collision guard, §15.5). */
	serverIdentitySuffix?: string;
	/** Max time to wait for a runtime to become healthy after `up -d`. */
	startupTimeoutMs?: number;
	/** Health re-poll interval during startup. */
	pollIntervalMs?: number;
	/** Per-Docker-command timeout. */
	commandTimeoutMs?: number;
	/** Where rendered `.env` files live (one dir per compose project). */
	runtimeDataDir?: string;
	/** Clock seam (deterministic timeout tests). Defaults to `Date.now`. */
	now?: () => number;
	/** Sleep seam (deterministic timeout tests). Defaults to real timers. */
	sleep?: (ms: number) => Promise<void>;
	/**
	 * Persisted user-configured + generated secret store (satisfied by the
	 * production `SecretsStore`). When supplied, the default resolver context
	 * idempotently generates+persists `generate: true` secrets and reads
	 * user-configured `secret:` values from it. When absent, generated secrets
	 * fall back to ephemeral values and user-configured secrets are unresolved
	 * (a runtime that actually references one then fails with a clear error).
	 */
	secretsStore?: SecretLike;
	/**
	 * Persisted host-port store (satisfied by {@link FilePortStore}). When
	 * supplied, the default resolver context allocates+persists a stable host
	 * port per declared `port` key; otherwise an ephemeral free port is probed.
	 */
	portStore?: PortStore;
	/**
	 * Resolver context builder for env refs/placeholders. When omitted, a
	 * production-safe default resolves declared generated secrets + ports (and
	 * user-configured secrets from {@link secretsStore}) so real pack runtimes
	 * no longer throw in `buildRuntimeInvocation` before Docker starts. May be
	 * async (port allocation is async).
	 */
	buildContext?: (
		manifest: RuntimeManifest,
		contribution: RuntimeContribution,
	) => RuntimeResolveContext | Promise<RuntimeResolveContext>;
}

// ── Errors (mappable to HTTP codes by the REST layer) ────────────────────────

/** Unknown pack/runtime → REST should answer 404. */
export class PackRuntimeNotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PackRuntimeNotFoundError";
	}
}

/** Malformed id / mode / tail → REST should answer 400. */
export class PackRuntimeBadRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PackRuntimeBadRequestError";
	}
}

/**
 * Docker executable not found (`ENOENT`). Operations that return a
 * {@link PackRuntimeStatus} surface this as a `docker-unavailable` state; the
 * string-returning {@link PackRuntimeSupervisor.logs} throws this instead so the
 * REST layer can answer a consistent `docker-unavailable` shape rather than
 * hiding a Docker-installation failure behind empty output.
 */
export class PackRuntimeDockerUnavailableError extends Error {
	constructor(message = "docker is not available") {
		super(message);
		this.name = "PackRuntimeDockerUnavailableError";
	}
}

// ── File-backed host-port store (production default) ─────────────────────────

/**
 * Minimal JSON-file-backed {@link PortStore} for persisted host-port
 * assignments, mirroring `SecretsStore`'s on-disk discipline. Read/write errors
 * are swallowed (best-effort persistence) so a corrupt file degrades to fresh
 * allocation rather than crashing the supervisor.
 */
export class FilePortStore implements PortStore {
	private data: Record<string, number> = {};
	private readonly filePath: string;

	constructor(filePath: string) {
		this.filePath = filePath;
		try {
			if (fs.existsSync(filePath)) {
				const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
				if (raw && typeof raw === "object" && !Array.isArray(raw)) {
					for (const [k, v] of Object.entries(raw)) {
						if (typeof v === "number" && Number.isInteger(v)) this.data[k] = v;
					}
				}
			}
		} catch {
			/* best effort — start fresh on unreadable/corrupt state */
		}
	}

	get(key: string): number | undefined {
		return this.data[key];
	}

	set(key: string, value: number): void {
		this.data[key] = value;
		this._persist();
	}

	/** Drop a persisted port assignment (purge path). Best-effort persistence. */
	remove(key: string): void {
		if (!(key in this.data)) return;
		delete this.data[key];
		this._persist();
	}

	private _persist(): void {
		try {
			fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
			fs.writeFileSync(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`, "utf-8");
		} catch {
			/* best effort */
		}
	}
}

/**
 * Read a runtime's declared {@link PackRuntimeStartPolicy} from its RAW manifest
 * object (the un-validated `RuntimeContribution.manifest`). Anything other than
 * the literal `"on-enable"` — including an absent field — resolves to `manual`,
 * so existing descriptors keep their no-auto-start P2 behaviour.
 */
export function readRuntimeStartPolicy(manifest: Record<string, unknown> | undefined): PackRuntimeStartPolicy {
	return manifest?.startPolicy === "on-enable" ? "on-enable" : "manual";
}

// ── Id encoding (URL-safe, reversible) ───────────────────────────────────────

/** Encode `{packId,runtimeId}` to a single URL-safe, reversible API id. */
export function encodePackRuntimeId(packId: string, runtimeId: string): string {
	return `${encodeURIComponent(packId)}:${encodeURIComponent(runtimeId)}`;
}

/**
 * Namespace a GENERATED-secret / HOST-port persistence key by pack+runtime
 * identity. Two unrelated pack runtimes that both declare a key like `WEB_PORT`,
 * `PORT`, or `DB_PASSWORD` would otherwise collide on the raw manifest key in the
 * shared global `SecretsStore` / port store and overwrite each other's persisted
 * value. The RAW manifest key is still used for the rendered env-var NAME and for
 * reading USER-CONFIGURED secrets (which are intentionally global/shared — a user
 * configures one LLM key once across runtimes), so only the persisted storage
 * slot for auto-generated secrets and allocated ports is namespaced.
 */
export function packRuntimePersistKey(packId: string, runtimeId: string, rawKey: string): string {
	return `pack-runtime:${encodeURIComponent(packId)}:${encodeURIComponent(runtimeId)}:${rawKey}`;
}

/** Reverse {@link encodePackRuntimeId}. Throws {@link PackRuntimeBadRequestError}. */
export function decodePackRuntimeId(id: string): { packId: string; runtimeId: string } {
	if (typeof id !== "string" || id.length === 0) {
		throw new PackRuntimeBadRequestError("pack runtime id is required");
	}
	const idx = id.indexOf(":");
	if (idx <= 0 || idx >= id.length - 1) {
		throw new PackRuntimeBadRequestError(`malformed pack runtime id ${JSON.stringify(id)}`);
	}
	let packId: string;
	let runtimeId: string;
	try {
		packId = decodeURIComponent(id.slice(0, idx));
		runtimeId = decodeURIComponent(id.slice(idx + 1));
	} catch {
		throw new PackRuntimeBadRequestError(`malformed pack runtime id ${JSON.stringify(id)}`);
	}
	if (!packId || !runtimeId) {
		throw new PackRuntimeBadRequestError(`malformed pack runtime id ${JSON.stringify(id)}`);
	}
	return { packId, runtimeId };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const TAIL_DEFAULT = 200;
const TAIL_MAX = 5000;

/** Sanitize a token for use inside a compose project name (`[a-z0-9_-]`). */
export function sanitizeComposeToken(token: string): string {
	const cleaned = String(token ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/[-_]{2,}/g, "-")
		.replace(/^[-_]+|[-_]+$/g, "");
	return cleaned.length > 0 ? cleaned.slice(0, 40) : "x";
}

/** True when an error is a missing-executable ENOENT (Docker not installed). */
function isEnoent(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const e = err as { code?: unknown; message?: unknown };
	if (e.code === "ENOENT") return true;
	return typeof e.message === "string" && e.message.includes("ENOENT");
}

/** Clamp/sanitize a requested log `tail` to a safe positive range. */
export function clampTail(tail: unknown): number {
	if (tail === undefined || tail === null) return TAIL_DEFAULT;
	const n = typeof tail === "number" ? tail : Number(tail);
	if (!Number.isFinite(n)) {
		throw new PackRuntimeBadRequestError(`invalid tail ${JSON.stringify(tail)}`);
	}
	const int = Math.floor(n);
	if (int < 1) return 1;
	if (int > TAIL_MAX) return TAIL_MAX;
	return int;
}

interface RawComposePsRow {
	[key: string]: unknown;
}

/** Tolerantly parse `docker compose ps --format json` (array OR JSON-lines). */
export function parseComposePs(stdout: string): PackRuntimeServiceStatus[] {
	const text = (stdout ?? "").trim();
	if (!text) return [];
	const rows: RawComposePsRow[] = [];
	if (text.startsWith("[")) {
		try {
			const arr = JSON.parse(text);
			if (Array.isArray(arr)) rows.push(...(arr as RawComposePsRow[]));
		} catch {
			/* fall through — nothing parseable */
		}
	} else {
		for (const line of text.split(/\r?\n/)) {
			const l = line.trim();
			if (!l) continue;
			try {
				rows.push(JSON.parse(l) as RawComposePsRow);
			} catch {
				/* skip non-JSON noise lines */
			}
		}
	}
	const out: PackRuntimeServiceStatus[] = [];
	for (const row of rows) {
		const name =
			(typeof row.Service === "string" && row.Service) ||
			(typeof row.service === "string" && row.service) ||
			(typeof row.Name === "string" && row.Name) ||
			(typeof row.name === "string" && row.name) ||
			"";
		if (!name) continue;
		const svc: PackRuntimeServiceStatus = { name };
		const state = row.State ?? row.state;
		if (typeof state === "string" && state.length > 0) svc.state = state;
		const health = row.Health ?? row.health;
		if (typeof health === "string" && health.length > 0) svc.health = health;
		out.push(svc);
	}
	return out;
}

/** Map parsed compose service states to a runtime status state. */
export function mapServicesToState(services: PackRuntimeServiceStatus[]): PackRuntimeStatusState {
	if (services.length === 0) return "stopped";
	const norm = services.map((s) => ({
		state: (s.state ?? "").toLowerCase(),
		health: (s.health ?? "").toLowerCase(),
	}));
	if (norm.some((s) => s.health === "unhealthy")) return "unhealthy";
	const isReady = (s: { state: string; health: string }) =>
		s.state === "running" && (s.health === "" || s.health === "healthy");
	if (norm.every(isReady)) return "running";
	if (
		norm.some(
			(s) =>
				s.state === "running" ||
				s.state === "created" ||
				s.state === "restarting" ||
				s.health === "starting",
		)
	) {
		return "starting";
	}
	return "stopped";
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The compose addressing context shared by every Docker command for a runtime:
 * the collision-guarded project name plus the validated invocation's resolved
 * `composeFile` and rendered `envFile`. Carrying `-f`/`--env-file` on EVERY
 * call (not just `up`) means status/stop/logs inspect/control the correct
 * compose context regardless of the gateway's cwd.
 */
interface ComposeTarget {
	composeProject: string;
	composeFile: string;
	envFile: string;
}

// ── Supervisor ───────────────────────────────────────────────────────────────

export class PackRuntimeSupervisor {
	private readonly registry: PackContributionResolver;
	private readonly dockerBin: string;
	private readonly executor: DockerExecutor;
	private readonly suffix: string;
	private readonly startupTimeoutMs: number;
	private readonly pollIntervalMs: number;
	private readonly commandTimeoutMs: number;
	private readonly runtimeDataDir: string;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly secretsStore?: SecretLike;
	private readonly portStore?: PortStore;
	private readonly buildContext?: (
		manifest: RuntimeManifest,
		contribution: RuntimeContribution,
	) => RuntimeResolveContext | Promise<RuntimeResolveContext>;

	/**
	 * Dedupes concurrent `ensureRuntime`/`start` for one runtime key: while a
	 * start is in flight, later callers await the same Promise (one `compose up`).
	 * On settle, the entry is cleared so a later call can retry. Mirrors
	 * `sandbox-manager.ts`'s `_ensureInFlight` discipline.
	 */
	private readonly _startInFlight = new Map<string, Promise<PackRuntimeStatus>>();

	constructor(opts: PackRuntimeSupervisorOptions) {
		this.registry = opts.registry;
		this.dockerBin = opts.dockerBin ?? process.env.DOCKER_BIN ?? "docker";
		this.executor = opts.executor ?? (execFileAsync as unknown as DockerExecutor);
		this.suffix = sanitizeComposeToken(opts.serverIdentitySuffix ?? crypto.randomBytes(4).toString("hex"));
		this.startupTimeoutMs = opts.startupTimeoutMs ?? 60_000;
		this.pollIntervalMs = opts.pollIntervalMs ?? 1_000;
		this.commandTimeoutMs = opts.commandTimeoutMs ?? 120_000;
		this.runtimeDataDir = opts.runtimeDataDir ?? path.join(os.tmpdir(), "bobbit-pack-runtimes");
		this.now = opts.now ?? Date.now;
		this.sleep = opts.sleep ?? defaultSleep;
		this.secretsStore = opts.secretsStore;
		this.portStore = opts.portStore;
		this.buildContext = opts.buildContext;
	}

	/** Compose project name for a pack (collision-guarded by server suffix). */
	composeProjectFor(packId: string): string {
		return `bobbit-pack-${sanitizeComposeToken(packId)}-${this.suffix}`;
	}

	/** Status for every active pack runtime in a project scope. */
	async list(projectId?: string): Promise<PackRuntimeStatus[]> {
		const out: PackRuntimeStatus[] = [];
		for (const pack of this.registry.list(projectId)) {
			for (const runtime of pack.runtimes) {
				out.push(await this.status(pack.packId, runtime.id, projectId));
			}
		}
		return out;
	}

	/** Current status for a single runtime (Docker queried via `compose ps`). */
	async status(packId: string, runtimeId: string, projectId?: string): Promise<PackRuntimeStatus> {
		const { contribution, packName } = this._lookup(packId, runtimeId, projectId);
		const descriptor = this._descriptor(contribution, packId, runtimeId, packName);
		// Derive the compose target (project + `-f composeFile` + `--env-file`) from
		// the validated runtime invocation so status inspects the SAME compose
		// context start uses, regardless of the gateway's cwd. Manifest/invocation
		// errors propagate (→ PackRuntimeBadRequestError → 400).
		const { target, services } = await this._composeContext(packId, runtimeId, contribution);
		return this._statusFromPs(descriptor, target, services);
	}

	/** Idempotent start. Fast-paths when already running; dedupes concurrent starts. */
	async ensureRuntime(
		packId: string,
		runtimeId: string,
		opts: { projectId?: string; mode?: string } = {},
	): Promise<PackRuntimeStatus> {
		const current = await this.status(packId, runtimeId, opts.projectId);
		if (current.status === "running") return current;
		// Preserve a clear docker-unavailable state — do not fall through to start
		// (which would re-run Docker / render env and surface a noisier error).
		if (current.status === "docker-unavailable") return current;
		return this._startDeduped(packId, runtimeId, opts);
	}

	/** Start a runtime (renders env, `compose up -d`, polls to healthy/timeout). */
	async start(
		packId: string,
		runtimeId: string,
		opts: { projectId?: string; mode?: string; config?: Record<string, unknown> } = {},
	): Promise<PackRuntimeStatus> {
		return this._startDeduped(packId, runtimeId, opts);
	}

	/** Stop a runtime (`compose stop`) and report the resulting status. */
	async stop(
		packId: string,
		runtimeId: string,
		opts: { projectId?: string } = {},
	): Promise<PackRuntimeStatus> {
		const { contribution, packName } = this._lookup(packId, runtimeId, opts.projectId);
		const descriptor = this._descriptor(contribution, packId, runtimeId, packName);
		// Derive the compose target + this runtime's owned services from the
		// validated invocation. A manifest validation/invocation failure propagates
		// (it never degrades to an unscoped whole-pack `stop`); the service list is
		// empty ONLY for a valid manifest that truly declares no services.
		const { target, services } = await this._composeContext(packId, runtimeId, contribution);
		try {
			await this._exec(this._composeArgs(target, "stop", ...services));
		} catch (err) {
			if (isEnoent(err)) {
				return { ...descriptor, status: "docker-unavailable", composeProject: target.composeProject, message: "docker is not available" };
			}
			throw err;
		}
		return this._statusFromPs(descriptor, target, services);
	}

	/** Stop then start a runtime. */
	async restart(
		packId: string,
		runtimeId: string,
		opts: { projectId?: string; mode?: string; config?: Record<string, unknown> } = {},
	): Promise<PackRuntimeStatus> {
		await this.stop(packId, runtimeId, { projectId: opts.projectId });
		return this.start(packId, runtimeId, opts);
	}

	/** Recent logs for a runtime (`compose logs --tail N`). */
	async logs(
		packId: string,
		runtimeId: string,
		opts: { projectId?: string; tail?: number } = {},
	): Promise<string> {
		// Validate the runtime exists (404 mapping) before touching Docker.
		const { contribution } = this._lookup(packId, runtimeId, opts.projectId);
		const tail = clampTail(opts.tail);
		// Derive the compose target + this runtime's owned services from the
		// validated invocation. Invalid manifests propagate rather than degrading to
		// an unscoped whole-pack `logs`.
		const { target, services } = await this._composeContext(packId, runtimeId, contribution);
		try {
			const { stdout } = await this._exec(
				this._composeArgs(target, "logs", "--tail", String(tail), ...services),
			);
			return stdout;
		} catch (err) {
			// Surface a consistent docker-unavailable failure instead of hiding a
			// missing-Docker install behind empty output (REST maps this to a
			// docker-unavailable shaped response).
			if (isEnoent(err)) throw new PackRuntimeDockerUnavailableError();
			throw err;
		}
	}

	/**
	 * Tear a runtime down (`docker compose down`). Unlike {@link stop} (which
	 * `compose stop`s the runtime's services but leaves the compose project,
	 * networks and ANONYMOUS volumes in place), `down` removes the project's
	 * containers + networks. It is the uninstall/purge primitive:
	 *
	 * - `volumes: false` (default) — `compose down`. Bind-mounted data (e.g. the
	 *   managed Postgres data dir) is OUTSIDE compose-managed volumes and SURVIVES,
	 *   so an uninstall→reinstall keeps the user's memory. This is the uninstall path.
	 * - `volumes: true` — `compose down -v`. Removes named/anonymous compose volumes
	 *   too. The explicit PURGE path.
	 * - `removeState: true` — additionally delete supervisor-owned local runtime
	 *   state (rendered env file + persisted generated secrets + allocated ports).
	 *   Bind-mounted DATA is never deleted here.
	 *
	 * A missing Docker install surfaces as a `docker-unavailable` status (never a
	 * throw) so an uninstall on a Docker-less host still proceeds; local state
	 * removal still runs when requested.
	 */
	async down(
		packId: string,
		runtimeId: string,
		opts: { projectId?: string; volumes?: boolean; removeState?: boolean } = {},
	): Promise<PackRuntimeStatus> {
		const { contribution, packName } = this._lookup(packId, runtimeId, opts.projectId);
		const descriptor = this._descriptor(contribution, packId, runtimeId, packName);
		const composeProject = this.composeProjectFor(packId);
		const { target } = await this._composeContext(packId, runtimeId, contribution);
		const downArgs = this._composeArgs(target, "down", ...(opts.volumes ? ["-v"] : []));
		try {
			await this._exec(downArgs);
		} catch (err) {
			if (isEnoent(err)) {
				// Docker is unavailable — local state removal is still meaningful (the
				// rendered env / persisted ports/secrets live on the host FS).
				if (opts.removeState) this._removeRuntimeState(packId, runtimeId, contribution, composeProject);
				return { ...descriptor, status: "docker-unavailable", composeProject, message: "docker is not available" };
			}
			throw err;
		}
		if (opts.removeState) this._removeRuntimeState(packId, runtimeId, contribution, composeProject);
		// `compose down` removed the project's containers — the runtime is stopped.
		return { ...descriptor, status: "stopped", composeProject };
	}

	/**
	 * Pre-start consent disclosure (P3 §8). PURE w.r.t. Docker — derived only from
	 * the validated manifest, the selected mode, and any ALREADY-persisted host
	 * ports (never allocates). Safe to render before the user consents to a start.
	 */
	async capabilitySummary(
		packId: string,
		runtimeId: string,
		opts: { projectId?: string; mode?: string; config?: Record<string, unknown> } = {},
	): Promise<PackRuntimeCapabilitySummary> {
		const { contribution, packName } = this._lookup(packId, runtimeId, opts.projectId);
		const descriptor = this._descriptor(contribution, packId, runtimeId, packName);
		const manifest = this._resolveManifest(contribution);
		const modeKeys = Object.keys(manifest.modes ?? {});
		if (opts.mode !== undefined && !manifest.modes?.[opts.mode]) {
			throw new PackRuntimeBadRequestError(`runtime ${contribution.id} has no mode ${JSON.stringify(opts.mode)}`);
		}
		const modeKey = opts.mode ?? modeKeys[0];
		if (!modeKey) {
			throw new PackRuntimeBadRequestError(`runtime ${contribution.id} declares no modes`);
		}
		const modeSpec = manifest.modes![modeKey];
		const omit = new Set(modeSpec.omitServices ?? []);
		const services = (modeSpec.services ?? []).filter((s) => !omit.has(s));
		const ports: PackRuntimeCapabilityPort[] = (manifest.ports ?? []).map((spec) => {
			const p: PackRuntimeCapabilityPort = { key: spec.key };
			if (spec.env) p.env = spec.env;
			if (typeof spec.container === "number") p.container = spec.container;
			// Disclose the persisted host port WITHOUT allocating a new one.
			const host = this.portStore?.get(packRuntimePersistKey(packId, runtimeId, spec.key));
			if (typeof host === "number" && Number.isInteger(host)) p.host = host;
			return p;
		});
		const volumePath = this._resolveVolumePath(manifest, modeSpec, opts.config);
		return {
			...descriptor,
			mode: modeKey,
			startPolicy: readRuntimeStartPolicy(contribution.manifest),
			composeProject: this.composeProjectFor(packId),
			services,
			images: [...services],
			ports,
			...(volumePath ? { volumePath } : {}),
			trust:
				"Enabling this managed runtime lets Bobbit store and recall agent memory " +
				"(conversation summaries and project/goal/session tags) in the configured bank. " +
				"Disabling stops the containers but keeps the data on disk; purge removes Docker " +
				"volumes and supervisor-owned runtime state.",
		};
	}

	/** The runtime's declared start policy (defaults to `manual`). No Docker. */
	startPolicyFor(packId: string, runtimeId: string, projectId?: string): PackRuntimeStartPolicy {
		const { contribution } = this._lookup(packId, runtimeId, projectId);
		return readRuntimeStartPolicy(contribution.manifest);
	}

	// ── internals ────────────────────────────────────────────────────────────

	/**
	 * Best-effort resolution of the managed data/volume path for the consent
	 * disclosure. Scans the merged (manifest + mode) env for a literal `value` ref
	 * whose env NAME ends in `_DATA_DIR`, substituting any config-overlay vars so a
	 * `${dataDir:-~/.hindsight}` default resolves. Falls back to a configured
	 * `dataDir`. PURE.
	 */
	private _resolveVolumePath(
		manifest: RuntimeManifest,
		modeSpec: { env?: Record<string, unknown> },
		configOverlay?: Record<string, unknown>,
	): string | undefined {
		const vars: Record<string, string> = {};
		if (configOverlay) {
			for (const [k, v] of Object.entries(configOverlay)) {
				if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") vars[k] = String(v);
			}
		}
		const merged: Record<string, unknown> = { ...(manifest.env ?? {}), ...(modeSpec.env ?? {}) };
		for (const [name, value] of Object.entries(merged)) {
			if (!/_DATA_DIR$/.test(name)) continue;
			const raw =
				typeof value === "string"
					? value
					: value && typeof value === "object" && typeof (value as { value?: unknown }).value === "string"
						? (value as { value: string }).value
						: undefined;
			if (raw === undefined) continue;
			const resolved = substitutePlaceholders(raw, vars);
			if (resolved) return resolved;
		}
		const dataDir = configOverlay?.dataDir;
		return typeof dataDir === "string" && dataDir.length > 0 ? dataDir : undefined;
	}

	/**
	 * Delete supervisor-owned LOCAL runtime state for a purge: the rendered env
	 * file (and the compose-project env dir when it becomes empty), persisted
	 * generated secrets, and allocated host ports — all namespaced by
	 * {@link packRuntimePersistKey}. Bind-mounted DATA (e.g. HINDSIGHT_DATA_DIR) is
	 * NEVER touched here; only the supervisor's own bookkeeping. Best-effort.
	 */
	private _removeRuntimeState(
		packId: string,
		runtimeId: string,
		contribution: RuntimeContribution,
		composeProject: string,
	): void {
		// 1. Rendered .env file + persisted config sidecar + the (now-empty) dir.
		try {
			fs.rmSync(this._envFilePath(composeProject, runtimeId), { force: true });
		} catch {
			/* best effort */
		}
		try {
			fs.rmSync(this._runtimeConfigPath(composeProject, runtimeId), { force: true });
		} catch {
			/* best effort */
		}
		try {
			const dir = path.join(this.runtimeDataDir, composeProject);
			if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
		} catch {
			/* best effort */
		}

		// 2. Persisted generated secrets + allocated ports. Compute the keys from the
		//    manifest (same collection logic as `_resolveContext`) and drop their
		//    namespaced persistence slots. Structural `remove` calls keep us decoupled
		//    from the concrete SecretsStore / FilePortStore types.
		let manifest: RuntimeManifest | null = null;
		try {
			manifest = this._resolveManifest(contribution);
		} catch {
			manifest = null;
		}
		if (!manifest) return;
		const generatedKeys = new Set<string>();
		const portKeys = new Set<string>();
		for (const spec of manifest.secrets ?? []) {
			if (spec.generate) generatedKeys.add(spec.key);
		}
		for (const spec of manifest.ports ?? []) portKeys.add(spec.key);
		const envMaps = [manifest.env, ...Object.values(manifest.modes ?? {}).map((m) => m.env)];
		for (const env of envMaps) {
			for (const value of Object.values(env ?? {})) {
				if (!value || typeof value !== "object") continue;
				if (typeof value.generate === "string") generatedKeys.add(value.generate);
				if (typeof value.port === "string") portKeys.add(value.port);
			}
		}
		const secretsRemover = this.secretsStore as unknown as { remove?: (key: string) => void } | undefined;
		for (const key of generatedKeys) {
			try {
				secretsRemover?.remove?.(packRuntimePersistKey(packId, runtimeId, key));
			} catch {
				/* best effort */
			}
		}
		const portRemover = this.portStore as unknown as { remove?: (key: string) => void } | undefined;
		for (const key of portKeys) {
			try {
				portRemover?.remove?.(packRuntimePersistKey(packId, runtimeId, key));
			} catch {
				/* best effort */
			}
		}
	}

	/**
	 * Dedupe key for an in-flight start. The selected `mode` is part of the key so
	 * two concurrent EXPLICIT `start` calls requesting DIFFERENT modes never
	 * collapse onto the first request's promise (which would silently ignore the
	 * second mode). Mode-agnostic `ensureRuntime` callers pass the same (usually
	 * `undefined`) mode, so they still share one key → one `compose up`.
	 */
	private _runtimeKey(packId: string, runtimeId: string, projectId?: string, mode?: string): string {
		return `${projectId ?? ""}\u0000${packId}\u0000${runtimeId}\u0000${mode ?? ""}`;
	}

	private _startDeduped(
		packId: string,
		runtimeId: string,
		opts: { projectId?: string; mode?: string; config?: Record<string, unknown> },
	): Promise<PackRuntimeStatus> {
		const key = this._runtimeKey(packId, runtimeId, opts.projectId, opts.mode);
		const inFlight = this._startInFlight.get(key);
		if (inFlight) return inFlight;
		const p = this._doStart(packId, runtimeId, opts);
		this._startInFlight.set(key, p);
		const cleanup = () => {
			if (this._startInFlight.get(key) === p) this._startInFlight.delete(key);
		};
		p.then(cleanup, cleanup);
		return p;
	}

	private async _doStart(
		packId: string,
		runtimeId: string,
		opts: { projectId?: string; mode?: string; config?: Record<string, unknown> },
	): Promise<PackRuntimeStatus> {
		const { contribution, packName } = this._lookup(packId, runtimeId, opts.projectId);
		const descriptor = this._descriptor(contribution, packId, runtimeId, packName);
		const composeProject = this.composeProjectFor(packId);
		const envFile = this._envFilePath(composeProject, runtimeId);

		const { invocation, modeKey } = await this._buildInvocation(packId, runtimeId, contribution, envFile, opts.mode, {
			configOverlay: opts.config,
		});

		renderRuntimeEnvFile(invocation.envFile, invocation.env);
		// Persist the effective mode + config overlay used for THIS start so later
		// read/control commands (status/stop/logs/down) can rebuild the SAME compose
		// env. Without this, a runtime started with config-only secrets/placeholders
		// (e.g. an LLM key or external DB URL supplied via deployment config, not the
		// global secret store) would fail to re-resolve its env on control/teardown.
		this._persistRuntimeConfig(composeProject, runtimeId, modeKey, opts.config);

		const target: ComposeTarget = {
			composeProject,
			composeFile: invocation.composeFile,
			envFile: invocation.envFile,
		};
		const upArgs = this._composeArgs(
			target,
			...invocation.profiles.flatMap((p) => ["--profile", p]),
			"up",
			"-d",
			...invocation.services,
		);

		try {
			await this._exec(upArgs);
		} catch (err) {
			if (isEnoent(err)) {
				return {
					...descriptor,
					status: "docker-unavailable",
					mode: modeKey,
					composeProject,
					message: "docker is not available",
				};
			}
			throw err;
		}

		return this._pollUntilHealthy(descriptor, target, modeKey, invocation.services);
	}

	private async _pollUntilHealthy(
		descriptor: PackRuntimeDescriptor,
		target: ComposeTarget,
		mode: string,
		services: string[],
	): Promise<PackRuntimeStatus> {
		const deadline = this.now() + this.startupTimeoutMs;
		for (;;) {
			const status = await this._statusFromPs(descriptor, target, services, mode);
			if (
				status.status === "running" ||
				status.status === "unhealthy" ||
				status.status === "docker-unavailable"
			) {
				return status;
			}
			if (this.now() >= deadline) {
				return {
					...descriptor,
					status: "unhealthy",
					mode,
					composeProject: target.composeProject,
					services: status.services,
					message: `runtime did not become healthy within ${this.startupTimeoutMs}ms`,
				};
			}
			await this.sleep(this.pollIntervalMs);
		}
	}

	private async _statusFromPs(
		descriptor: PackRuntimeDescriptor,
		target: ComposeTarget,
		scopeServices: string[],
		mode?: string,
	): Promise<PackRuntimeStatus> {
		try {
			// Scope `ps` to this runtime's services so status never reflects (or maps
			// the health of) sibling runtimes sharing the pack compose project. The
			// `-f composeFile`/`--env-file` come from the validated invocation so the
			// inspected compose context is correct regardless of the gateway cwd.
			const { stdout } = await this._exec(
				this._composeArgs(target, "ps", "--format", "json", ...scopeServices),
			);
			const services = parseComposePs(stdout);
			return {
				...descriptor,
				status: mapServicesToState(services),
				mode,
				composeProject: target.composeProject,
				services,
			};
		} catch (err) {
			if (isEnoent(err)) {
				return {
					...descriptor,
					status: "docker-unavailable",
					mode,
					composeProject: target.composeProject,
					message: "docker is not available",
				};
			}
			throw err;
		}
	}

	private _lookup(
		packId: string,
		runtimeId: string,
		projectId?: string,
	): { contribution: RuntimeContribution; packName?: string } {
		const contribution = this.registry.getRuntime(projectId, packId, runtimeId);
		if (!contribution) {
			throw new PackRuntimeNotFoundError(`unknown pack runtime ${packId}:${runtimeId}`);
		}
		const packName = this.registry.getPack(projectId, packId)?.packName;
		return { contribution, packName };
	}

	private _descriptor(
		contribution: RuntimeContribution,
		packId: string,
		runtimeId: string,
		packName?: string,
	): PackRuntimeDescriptor {
		const d: PackRuntimeDescriptor = {
			id: encodePackRuntimeId(packId, runtimeId),
			packId,
			runtimeId,
		};
		if (packName) d.packName = packName;
		if (contribution.title) d.title = contribution.title;
		if (contribution.description) d.description = contribution.description;
		return d;
	}

	/**
	 * Validate the carried manifest (deep, P1 semantics). Throws
	 * {@link PackRuntimeBadRequestError} for an unusable manifest.
	 */
	private _resolveManifest(contribution: RuntimeContribution): RuntimeManifest {
		const problems: string[] = [];
		const manifest = validateRuntimeManifest(
			contribution.manifest,
			contribution.sourceFile,
			contribution.packRoot,
			problems,
		);
		if (!manifest) {
			throw new PackRuntimeBadRequestError(
				`invalid runtime manifest for ${contribution.id}: ${problems.join("; ") || "unknown error"}`,
			);
		}
		return manifest;
	}

	/**
	 * The set of compose services this runtime owns — the union of every mode's
	 * declared `services` (a mode's `omitServices` only changes what `up` starts,
	 * not what the runtime manages). Used to scope `ps`/`stop`/`logs` so one
	 * runtime cannot read or stop a sibling runtime's services in a shared
	 * pack-scoped compose project.
	 *
	 * The empty (project-wide) list is reserved EXCLUSIVELY for a successfully
	 * validated manifest that genuinely declares no services. Manifest validation
	 * failures must NEVER reach here as `[]` — they propagate from
	 * {@link _resolveManifest}/{@link _buildInvocation} (callers go through
	 * {@link _composeContext}), so an invalid/uncontained manifest can never
	 * silently broaden a `stop`/`logs` to the whole pack project.
	 */
	private _servicesForManifest(manifest: RuntimeManifest): string[] {
		const set = new Set<string>();
		for (const mode of Object.values(manifest.modes ?? {})) {
			for (const svc of mode.services ?? []) set.add(svc);
		}
		return [...set];
	}

	/** Rendered `.env` file path for a runtime (one dir per compose project). */
	private _envFilePath(composeProject: string, runtimeId: string): string {
		return path.join(this.runtimeDataDir, composeProject, `${sanitizeComposeToken(runtimeId)}.env`);
	}

	/**
	 * Sidecar path persisting the effective mode + config overlay used at start.
	 * Lives beside the rendered `.env` file (one per compose project) and is
	 * removed by the purge path ({@link _removeRuntimeState}).
	 */
	private _runtimeConfigPath(composeProject: string, runtimeId: string): string {
		return path.join(this.runtimeDataDir, composeProject, `${sanitizeComposeToken(runtimeId)}.config.json`);
	}

	/**
	 * Persist the effective start `mode` + config overlay (0600, same posture as the
	 * rendered env file) so later read/control commands rebuild the SAME compose env.
	 * Best-effort: a write failure degrades to the prior no-overlay behaviour rather
	 * than failing the start.
	 */
	private _persistRuntimeConfig(
		composeProject: string,
		runtimeId: string,
		mode: string,
		config?: Record<string, unknown>,
	): void {
		try {
			const file = this._runtimeConfigPath(composeProject, runtimeId);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, `${JSON.stringify({ mode, config: config ?? {} })}\n`, { mode: 0o600 });
			fs.chmodSync(file, 0o600);
		} catch {
			/* best effort — control commands fall back to no overlay */
		}
	}

	/** Load the persisted start mode + config overlay (best-effort; `{}` on miss). */
	private _loadRuntimeConfig(
		composeProject: string,
		runtimeId: string,
	): { mode?: string; config?: Record<string, unknown> } {
		try {
			const file = this._runtimeConfigPath(composeProject, runtimeId);
			if (!fs.existsSync(file)) return {};
			const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
			const out: { mode?: string; config?: Record<string, unknown> } = {};
			if (typeof raw.mode === "string" && raw.mode.length > 0) out.mode = raw.mode;
			if (raw.config && typeof raw.config === "object" && !Array.isArray(raw.config)) {
				out.config = raw.config as Record<string, unknown>;
			}
			return out;
		} catch {
			return {};
		}
	}

	/** Base `docker compose` args carrying the project + `-f`/`--env-file`. */
	private _composeArgs(target: ComposeTarget, ...rest: string[]): string[] {
		return [
			"compose",
			"-p",
			target.composeProject,
			"-f",
			target.composeFile,
			"--env-file",
			target.envFile,
			...rest,
		];
	}

	/**
	 * Build the compose target (project + resolved `composeFile` + rendered
	 * `envFile`) and the runtime's owned service list for read/control commands
	 * (`status`/`stop`/`logs`). Derives everything from the VALIDATED runtime
	 * invocation so these commands address the same compose context `start` uses
	 * regardless of the gateway cwd, and so a manifest validation/invocation
	 * failure propagates (→ 400/500) instead of silently falling back to an
	 * unscoped whole-pack command. The default mode supplies the env file (the
	 * compose file is mode-independent; the owned-service list is the union of all
	 * modes).
	 */
	private async _composeContext(
		packId: string,
		runtimeId: string,
		contribution: RuntimeContribution,
	): Promise<{ target: ComposeTarget; services: string[] }> {
		const composeProject = this.composeProjectFor(packId);
		const envFile = this._envFilePath(composeProject, runtimeId);
		// Reuse the mode + config overlay persisted at start so read/control commands
		// rebuild the SAME compose env: config-only secrets/placeholders (LLM key,
		// external DB URL, dataDir) re-resolve instead of throwing on teardown. A
		// persisted mode that no longer exists after an updatePack falls back to the
		// default mode.
		const persisted = this._loadRuntimeConfig(composeProject, runtimeId);
		let mode = persisted.mode;
		if (mode) {
			let modes: Record<string, unknown> | undefined;
			try {
				modes = this._resolveManifest(contribution).modes as Record<string, unknown> | undefined;
			} catch {
				modes = undefined;
			}
			if (!modes || !modes[mode]) mode = undefined;
		}
		// Read/control paths MUST reuse persisted port allocations as-is. While the
		// runtime is running its host ports are bound, so a revalidating allocation
		// (`allocateHostPort`) would find them un-bindable, rotate to fresh ports, and
		// rewrite ports.json + the env file — desyncing the persisted port from the
		// live container and breaking the NEXT restart. `reusePersisted: true` keeps
		// the stored port without a bindability probe.
		const { manifest, invocation } = await this._buildInvocation(packId, runtimeId, contribution, envFile, mode, {
			reusePersisted: true,
			configOverlay: persisted.config,
		});
		renderRuntimeEnvFile(invocation.envFile, invocation.env);
		return {
			target: {
				composeProject,
				composeFile: invocation.composeFile,
				envFile: invocation.envFile,
			},
			services: this._servicesForManifest(manifest),
		};
	}

	/**
	 * Build a production-safe resolver context for a manifest's env refs. The
	 * injected {@link PackRuntimeSupervisorOptions.buildContext} wins when set;
	 * otherwise generated secrets are idempotently created+persisted, declared
	 * ports are allocated+persisted, and user-configured secrets are read from
	 * the secret store. This prevents real runtimes (e.g. Hindsight) from
	 * throwing in `buildRuntimeInvocation` before Docker is ever invoked.
	 */
	private async _resolveContext(
		packId: string,
		runtimeId: string,
		manifest: RuntimeManifest,
		contribution: RuntimeContribution,
		opts: { reusePersisted?: boolean; configOverlay?: Record<string, unknown> } = {},
	): Promise<RuntimeResolveContext> {
		if (this.buildContext) return this.buildContext(manifest, contribution);

		// Collect every key the manifest references, from BOTH the explicit
		// secrets[]/ports[] declarations AND any env `secret|generate|port` refs
		// (the LLM-key style user secret is declared only as an env `secret:` ref,
		// not in secrets[]). Generated secrets win over user-configured for a key.
		const generatedKeys = new Set<string>();
		const userSecretKeys = new Set<string>();
		const portKeys = new Set<string>();
		for (const spec of manifest.secrets ?? []) {
			(spec.generate ? generatedKeys : userSecretKeys).add(spec.key);
		}
		for (const spec of manifest.ports ?? []) portKeys.add(spec.key);
		const envMaps = [manifest.env, ...Object.values(manifest.modes ?? {}).map((m) => m.env)];
		for (const env of envMaps) {
			for (const value of Object.values(env ?? {})) {
				if (!value || typeof value !== "object") continue;
				if (typeof value.generate === "string") generatedKeys.add(value.generate);
				if (typeof value.secret === "string") userSecretKeys.add(value.secret);
				if (typeof value.port === "string") portKeys.add(value.port);
			}
		}

		const secrets: Record<string, string> = {};
		const generated: Record<string, string> = {};
		const ports: Record<string, number> = {};
		// Generated secrets + allocated ports persist under a pack/runtime-namespaced
		// store key (collision guard); the returned context maps stay keyed by the RAW
		// manifest key so env refs still resolve by their declared name. User-configured
		// secrets are read by their RAW key (intentionally global/shared).
		for (const key of generatedKeys) {
			generated[key] = this.secretsStore
				? getOrCreateRuntimeSecret(this.secretsStore, packRuntimePersistKey(packId, runtimeId, key))
				: generateSecretValue();
		}
		for (const key of userSecretKeys) {
			if (generatedKeys.has(key)) continue;
			const v = this.secretsStore?.get(key);
			if (typeof v === "string" && v.length > 0) secrets[key] = v;
		}
		for (const key of portKeys) {
			if (!this.portStore) {
				ports[key] = await probeFreePort();
				continue;
			}
			const storeKey = packRuntimePersistKey(packId, runtimeId, key);
			if (opts.reusePersisted) {
				// Reuse the persisted assignment verbatim (no bindability probe) so a
				// running runtime's bound port is never rotated by a read/control call.
				// Only when nothing valid is persisted do we allocate one.
				const existing = this.portStore.get(storeKey);
				if (typeof existing === "number" && Number.isInteger(existing) && existing >= 1 && existing <= 65535) {
					ports[key] = existing;
					continue;
				}
			}
			ports[key] = await allocateHostPort(this.portStore, storeKey);
		}

		// Configuration overlay (P3): the effective pack/provider config (e.g. the
		// Hindsight deployment config — dataDir, externalDatabaseUrl, …) is mapped
		// GENERICALLY onto the resolve context. Every scalar config entry is exposed
		// as a placeholder var under its own key (so a literal env `value` ref like
		// `${dataDir:-~/.hindsight}` resolves), AND, when a USER-configured secret
		// ref's key is unresolved by the secret store, a config value of the same
		// key fills it (so `secret: HINDSIGHT_API_DATABASE_URL` can be satisfied from
		// config without persisting it to the global secret store). Generated secrets
		// and allocated ports are never overridden by config.
		const vars: Record<string, string> = {};
		if (opts.configOverlay) {
			for (const [k, v] of Object.entries(opts.configOverlay)) {
				if (v === undefined || v === null) continue;
				if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
					vars[k] = String(v);
				}
			}
			for (const key of userSecretKeys) {
				if (generatedKeys.has(key)) continue;
				if (secrets[key] !== undefined) continue;
				const v = opts.configOverlay[key];
				if (typeof v === "string" && v.length > 0) secrets[key] = v;
			}
		}
		return { secrets, generated, ports, vars };
	}

	private async _buildInvocation(
		packId: string,
		runtimeId: string,
		contribution: RuntimeContribution,
		envFile: string,
		mode?: string,
		opts: { reusePersisted?: boolean; configOverlay?: Record<string, unknown> } = {},
	): Promise<{ manifest: RuntimeManifest; modeKey: string; invocation: RuntimeInvocation }> {
		const manifest = this._resolveManifest(contribution);
		const modeKeys = Object.keys(manifest.modes ?? {});
		if (mode !== undefined && !manifest.modes?.[mode]) {
			throw new PackRuntimeBadRequestError(`runtime ${contribution.id} has no mode ${JSON.stringify(mode)}`);
		}
		const modeKey = mode ?? modeKeys[0];
		if (!modeKey) {
			throw new PackRuntimeBadRequestError(`runtime ${contribution.id} declares no modes`);
		}
		const ctx = await this._resolveContext(packId, runtimeId, manifest, contribution, opts);
		let invocation: RuntimeInvocation;
		try {
			invocation = buildRuntimeInvocation(manifest, modeKey, {
				sourceFile: contribution.sourceFile,
				packRoot: contribution.packRoot,
				envFile,
				ctx,
			});
		} catch (err) {
			// `buildRuntimeInvocation` rejects config/user errors (unresolved env refs,
			// unmet requireEnv, compose-path containment, …) as plain `Error`. These are
			// client/config faults, not server faults — surface them as a bad-request so
			// the REST layer answers 400 instead of a misleading 500. Already-typed
			// supervisor errors propagate unchanged.
			if (
				err instanceof PackRuntimeBadRequestError ||
				err instanceof PackRuntimeNotFoundError ||
				err instanceof PackRuntimeDockerUnavailableError
			) {
				throw err;
			}
			throw new PackRuntimeBadRequestError(
				`runtime ${contribution.id} invocation failed: ${(err as Error)?.message ?? String(err)}`,
			);
		}
		return { manifest, modeKey, invocation };
	}

	private _exec(args: readonly string[]): Promise<DockerExecResult> {
		return this.executor(this.dockerBin, args, {
			env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
			timeout: this.commandTimeoutMs,
			windowsHide: true,
			maxBuffer: 16 * 1024 * 1024,
			encoding: "utf-8",
		});
	}
}
