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
	type RuntimeInvocation,
	type RuntimeResolveContext,
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
	/** Resolver context builder for env refs/placeholders. Default: empty. */
	buildContext?: (manifest: RuntimeManifest, contribution: RuntimeContribution) => RuntimeResolveContext;
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

// ── Id encoding (URL-safe, reversible) ───────────────────────────────────────

/** Encode `{packId,runtimeId}` to a single URL-safe, reversible API id. */
export function encodePackRuntimeId(packId: string, runtimeId: string): string {
	return `${encodeURIComponent(packId)}:${encodeURIComponent(runtimeId)}`;
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
	private readonly buildContext: (
		manifest: RuntimeManifest,
		contribution: RuntimeContribution,
	) => RuntimeResolveContext;

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
		this.buildContext = opts.buildContext ?? (() => ({}));
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
		return this._statusFromPs(descriptor, this.composeProjectFor(packId));
	}

	/** Idempotent start. Fast-paths when already running; dedupes concurrent starts. */
	async ensureRuntime(
		packId: string,
		runtimeId: string,
		opts: { projectId?: string; mode?: string } = {},
	): Promise<PackRuntimeStatus> {
		const current = await this.status(packId, runtimeId, opts.projectId);
		if (current.status === "running") return current;
		return this._startDeduped(packId, runtimeId, opts);
	}

	/** Start a runtime (renders env, `compose up -d`, polls to healthy/timeout). */
	async start(
		packId: string,
		runtimeId: string,
		opts: { projectId?: string; mode?: string } = {},
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
		const composeProject = this.composeProjectFor(packId);
		try {
			await this._exec(["compose", "-p", composeProject, "stop"]);
		} catch (err) {
			if (isEnoent(err)) {
				return { ...descriptor, status: "docker-unavailable", composeProject, message: "docker is not available" };
			}
			throw err;
		}
		return this._statusFromPs(descriptor, composeProject);
	}

	/** Stop then start a runtime. */
	async restart(
		packId: string,
		runtimeId: string,
		opts: { projectId?: string; mode?: string } = {},
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
		this._lookup(packId, runtimeId, opts.projectId);
		const composeProject = this.composeProjectFor(packId);
		const tail = clampTail(opts.tail);
		try {
			const { stdout } = await this._exec(["compose", "-p", composeProject, "logs", "--tail", String(tail)]);
			return stdout;
		} catch (err) {
			if (isEnoent(err)) return "";
			throw err;
		}
	}

	// ── internals ────────────────────────────────────────────────────────────

	private _runtimeKey(packId: string, runtimeId: string, projectId?: string): string {
		return `${projectId ?? ""}\u0000${packId}\u0000${runtimeId}`;
	}

	private _startDeduped(
		packId: string,
		runtimeId: string,
		opts: { projectId?: string; mode?: string },
	): Promise<PackRuntimeStatus> {
		const key = this._runtimeKey(packId, runtimeId, opts.projectId);
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
		opts: { projectId?: string; mode?: string },
	): Promise<PackRuntimeStatus> {
		const { contribution, packName } = this._lookup(packId, runtimeId, opts.projectId);
		const descriptor = this._descriptor(contribution, packId, runtimeId, packName);
		const composeProject = this.composeProjectFor(packId);
		const envFile = path.join(this.runtimeDataDir, composeProject, `${sanitizeComposeToken(runtimeId)}.env`);

		const { invocation, modeKey } = this._buildInvocation(contribution, envFile, opts.mode);

		renderRuntimeEnvFile(invocation.envFile, invocation.env);

		const upArgs = [
			"compose",
			"-p",
			composeProject,
			"-f",
			invocation.composeFile,
			"--env-file",
			invocation.envFile,
			...invocation.profiles.flatMap((p) => ["--profile", p]),
			"up",
			"-d",
			...invocation.services,
		];

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

		return this._pollUntilHealthy(descriptor, composeProject, modeKey);
	}

	private async _pollUntilHealthy(
		descriptor: PackRuntimeDescriptor,
		composeProject: string,
		mode: string,
	): Promise<PackRuntimeStatus> {
		const deadline = this.now() + this.startupTimeoutMs;
		for (;;) {
			const status = await this._statusFromPs(descriptor, composeProject, mode);
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
					composeProject,
					services: status.services,
					message: `runtime did not become healthy within ${this.startupTimeoutMs}ms`,
				};
			}
			await this.sleep(this.pollIntervalMs);
		}
	}

	private async _statusFromPs(
		descriptor: PackRuntimeDescriptor,
		composeProject: string,
		mode?: string,
	): Promise<PackRuntimeStatus> {
		try {
			const { stdout } = await this._exec(["compose", "-p", composeProject, "ps", "--format", "json"]);
			const services = parseComposePs(stdout);
			return {
				...descriptor,
				status: mapServicesToState(services),
				mode,
				composeProject,
				services,
			};
		} catch (err) {
			if (isEnoent(err)) {
				return {
					...descriptor,
					status: "docker-unavailable",
					mode,
					composeProject,
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

	private _buildInvocation(
		contribution: RuntimeContribution,
		envFile: string,
		mode?: string,
	): { manifest: RuntimeManifest; modeKey: string; invocation: RuntimeInvocation } {
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
		const modeKeys = Object.keys(manifest.modes ?? {});
		if (mode !== undefined && !manifest.modes?.[mode]) {
			throw new PackRuntimeBadRequestError(`runtime ${contribution.id} has no mode ${JSON.stringify(mode)}`);
		}
		const modeKey = mode ?? modeKeys[0];
		if (!modeKey) {
			throw new PackRuntimeBadRequestError(`runtime ${contribution.id} declares no modes`);
		}
		const invocation = buildRuntimeInvocation(manifest, modeKey, {
			sourceFile: contribution.sourceFile,
			packRoot: contribution.packRoot,
			envFile,
			ctx: this.buildContext(manifest, contribution),
		});
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
