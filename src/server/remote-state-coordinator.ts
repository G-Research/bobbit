import { createHash } from "node:crypto";
import path from "node:path";
import { realClock, realCommandRunner, type Clock, type CommandRunner } from "./gateway-deps.js";

/** The only failure details which can cross the coordinator boundary. */
export type RemoteStateErrorKind = "offline" | "auth" | "rate_limited" | "unavailable";
export type RemoteStateIntent = "automatic" | "visible" | "explicit";
export type RemoteStateSource = "repository" | "pull_request";

export interface RemoteStateLastError {
	kind: RemoteStateErrorKind;
	observedAt: number;
}

/** Safe, copied projection suitable for REST and WebSocket consumers. */
export interface RemoteStateSnapshot<T> {
	data?: T;
	observedAt: number;
	refreshedAt?: number;
	stale: boolean;
	source: RemoteStateSource;
	lastError?: RemoteStateLastError;
	ageMs?: number;
}

/** Addresses are deliberately application-facing; canonical keys never leave this module. */
export interface RemoteStateAddress {
	kind: "goal" | "session" | "sidebar";
	id: string;
}

export interface RepositoryIdentityInput {
	cwd: string;
	/** Different execution environments with coincident paths must not share state. */
	executionNamespace?: string;
	/** Runs Git in the repository's execution environment (for example, a sandbox). */
	executeGit?: (args: readonly string[], timeoutMs: number) => Promise<string>;
}

export interface RepositoryIdentity {
	key: string;
	/** False means no origin is configured and callers must not fetch. */
	hasRemote: boolean;
}

export interface PullRequestIdentityInput {
	host?: string;
	owner: string;
	repository: string;
	head?: string;
	number?: number;
}

export interface PullRequestIdentity {
	key: string;
}

export interface RemoteStateReadOptions {
	intent?: RemoteStateIntent;
	/** PR sidebar demand is deliberately less frequent than active consumers. */
	cadence?: "active" | "sidebar";
	address?: RemoteStateAddress;
	/** Internal request-arrival marker used to collapse one burst of forced reads. */
	forceRequestedAt?: number;
	forceCoalesceMs?: number;
}

export type RemoteStateTelemetryOutcome =
	| "fresh"
	| "admitted"
	| "joined"
	| "backoff"
	| "budget"
	| "coalesced"
	| "queued"
	| "started"
	| "success"
	| "failure"
	| "identity_failure";

/**
 * Credential-safe operational telemetry. Every string is a closed enum or a
 * one-way record digest; paths, remotes, refs, commands and error text are never
 * accepted by this shape.
 */
export interface RemoteStateTelemetryEvent {
	type: "remote_state_refresh";
	source: RemoteStateSource;
	outcome: RemoteStateTelemetryOutcome;
	observedAt: number;
	record?: string;
	intent?: RemoteStateIntent;
	cadence?: "active" | "sidebar";
	queueDepth?: number;
	waitMs?: number;
	durationMs?: number;
	ageMs?: number;
	stale?: boolean;
	errorKind?: RemoteStateErrorKind;
}

export interface RemoteStateCoordinatorOptions {
	clock?: Pick<Clock, "now">;
	commandRunner?: CommandRunner;
	maxConcurrent?: number;
	/** Repository identity probes use a separate bound so they cannot starve refreshes. */
	maxConcurrentIdentityProbes?: number;
	/** Finite timeout applied to every Git subprocess used to resolve repository identity. */
	identityProbeTimeoutMs?: number;
	/** Receives only public addresses and safe copied snapshots. */
	broadcast?: (address: RemoteStateAddress, snapshot: RemoteStateSnapshot<unknown>) => void;
	/** Best-effort sink which receives only the closed, credential-safe event shape. */
	telemetry?: (event: RemoteStateTelemetryEvent) => void;
	repositoryFreshnessMs?: number;
	activePrFreshnessMs?: number;
	sidebarPrFreshnessMs?: number;
	backoffBaseMs?: number;
	backoffMaxMs?: number;
}

type Refresh<T> = () => Promise<T>;

interface RemoteStateRecord<T> {
	readonly key: string;
	readonly source: RemoteStateSource;
	refresh: Refresh<T>;
	lastGood?: T;
	refreshedAt?: number;
	lastAttemptAt?: number;
	lastForceRequestAt?: number;
	invalidated: boolean;
	/** Monotonic marker so invalidation racing a refresh is not cleared by that refresh. */
	invalidationVersion: number;
	failureCount: number;
	nextRetryAt: number;
	lastError?: RemoteStateLastError;
	inFlight?: Promise<void>;
	readonly addresses: Map<string, RemoteStateAddress>;
	readonly repositoryBindings: Map<string, RepositorySnapshotBinding>;
}

interface RegisterOptions<T> {
	refresh: Refresh<T>;
	address?: RemoteStateAddress;
}

/** Entity-local projection recomputed after shared repository refs refresh. */
export interface RepositorySnapshotBinding<T = unknown> {
	address: RemoteStateAddress;
	/** Invalidates every local-status cache owned by this entity before projection. */
	invalidate?: () => void;
	/** Must perform local-only work; remote I/O remains owned by the canonical refresh. */
	project: () => Promise<T>;
}

interface RegisterRepositoryOptions<T> extends RegisterOptions<T> {
	binding?: RepositorySnapshotBinding;
}

const REPOSITORY_PREFIX = "repo:";
const PR_PREFIX = "pr:";
const LOCAL_REMOTE = "local";
const DEFAULT_REPOSITORY_FRESHNESS_MS = 30_000;
const DEFAULT_ACTIVE_PR_FRESHNESS_MS = 20_000;
const DEFAULT_SIDEBAR_PR_FRESHNESS_MS = 60_000;
const DEFAULT_BACKOFF_BASE_MS = 5_000;
const DEFAULT_BACKOFF_MAX_MS = 5 * 60_000;
const DEFAULT_IDENTITY_PROBE_TIMEOUT_MS = 5_000;

/**
 * Normalizes a remote without ever returning its credential-bearing form. This value
 * is process-private and is hashed before becoming a coordinator key.
 */
export function normalizeRemoteIdentity(remote: string): string {
	const value = remote.trim();
	if (!value) return LOCAL_REMOTE;

	// Parse URL forms before scp syntax: otherwise the scheme colon in an HTTPS
	// URL is mistaken for the host/path separator and credentials become part of
	// the normalized identity.
	if (value.includes("://")) {
		try {
			const url = new URL(value);
			if (url.protocol === "file:") return `file:${normalizeLocalPath(decodeURIComponent(url.pathname))}`;
			if (url.hostname) return normalizeHostedPath(normalizeUrlAuthority(url), url.pathname);
		} catch {
			// Invalid URL-shaped values fall through to local path normalization.
		}
	}

	// scp-style SSH, including a user that may itself contain non-sensitive text.
	const scp = value.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
	if (scp && !/^[A-Za-z]:[\\/]/.test(value)) {
		return normalizeHostedPath(scp[1], scp[2]);
	}
	return `file:${normalizeLocalPath(value)}`;
}

/** Normalized GitHub/GHE web/API authority for PR identity. */
export function normalizeGithubHost(host?: string): string {
	const candidate = (host ?? "github.com").trim();
	const authority = /^([^:/]+?)(?::(\d+))?$/.exec(candidate);
	if (!authority) return candidate.replace(/\.$/, "").toLowerCase();
	const normalizedHostname = authority[1].replace(/\.$/, "").toLowerCase();
	const canonicalHostname = normalizedHostname === "www.github.com" || normalizedHostname === "ssh.github.com"
		? "github.com"
		: normalizedHostname;
	return authority[2] ? `${canonicalHostname}:${authority[2]}` : canonicalHostname;
}

export function isTrustedGithubRemoteHost(host: string, configuredEnterpriseHosts: readonly string[] = []): boolean {
	const hostname = authorityHostname(host);
	if (!hostname) return false;
	const normalized = normalizeGithubHost(hostname);
	if (normalized === "github.com") return true;
	return configuredEnterpriseHosts.some((candidate) => normalizeGithubHost(candidate) === normalized);
}

export interface TrustedGithubRemote {
	host: string;
	owner: string;
	repository: string;
}

/**
 * Structurally parse a complete GitHub-shaped remote without deciding whether
 * its host is trusted. Callers must apply an independent host trust decision
 * before using the result for any external operation.
 */
export function parseUntrustedGithubRemoteCandidate(remote: string): TrustedGithubRemote | undefined {
	const value = remote.trim();
	if (!value || /[\u0000-\u001f\u007f]/.test(value)) return undefined;

	let host: string;
	let rawOwner: string;
	let rawRepository: string;
	if (value.includes("://")) {
		let url: URL;
		try { url = new URL(value); } catch { return undefined; }
		if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "ssh:") return undefined;
		if (url.search || url.hash) return undefined;
		if (url.protocol === "ssh:" && url.password) return undefined;
		if (url.protocol === "ssh:" && url.username && url.username !== "git") return undefined;
		// An SSH port belongs to Git transport, not to the GitHub web/API
		// authority used by `gh` and host-scoped credentials. HTTPS/HTTP ports do
		// identify a distinct API authority and therefore remain canonical.
		host = url.protocol === "ssh:" ? normalizeGithubHost(url.hostname) : normalizeUrlAuthority(url);
		if (!/^\/[^/]+\/[^/]+\/?$/.test(url.pathname)) return undefined;
		const segments = url.pathname.replace(/^\//, "").replace(/\/$/, "").split("/");
		[rawOwner, rawRepository] = segments;
	} else {
		const scp = value.match(/^git@([^:/\s]+):([^/\s]+)\/([^/\s]+?)\/?$/);
		if (!scp) return undefined;
		[, host, rawOwner, rawRepository] = scp;
	}

	if (!host) return undefined;
	const owner = decodeGithubPathSegment(rawOwner);
	const decodedRepository = decodeGithubPathSegment(rawRepository);
	if (!owner || !decodedRepository) return undefined;
	const repository = stripGitSuffix(decodedRepository);
	if (!repository || !isGithubRepositorySegment(owner) || !isGithubRepositorySegment(repository)) return undefined;
	return {
		host: normalizeGithubHost(host),
		owner: owner.toLowerCase(),
		repository: repository.toLowerCase(),
	};
}

/** Parse a complete Git remote and trust-gate its actual host against the existing list. */
export function parseTrustedGithubRemote(
	remote: string,
	configuredEnterpriseHosts: readonly string[] = [],
): TrustedGithubRemote | undefined {
	const candidate = parseUntrustedGithubRemoteCandidate(remote);
	if (!candidate) return undefined;
	return isTrustedGithubRemoteHost(candidate.host, configuredEnterpriseHosts) ? candidate : undefined;
}

function decodeGithubPathSegment(value: string): string | undefined {
	if (/%(?:2f|5c|00)/i.test(value)) return undefined;
	try {
		const decoded = decodeURIComponent(value);
		if (!decoded || /[\/\\\u0000]|%(?:2f|5c|00)/i.test(decoded)) return undefined;
		return decoded;
	} catch {
		return undefined;
	}
}

function isGithubRepositorySegment(value: string): boolean {
	return value !== "." && value !== ".." && /^[A-Za-z0-9_.-]+$/.test(value);
}

export function normalizePullRequestIdentity(input: PullRequestIdentityInput): string {
	const host = normalizeGithubHost(input.host);
	const owner = input.owner.trim().toLowerCase();
	const repository = stripGitSuffix(input.repository.trim()).toLowerCase();
	if (!owner || !repository) throw new Error("Pull request identity requires owner and repository");
	let selector: string;
	if (input.number !== undefined) {
		if (!Number.isSafeInteger(input.number) || input.number <= 0) throw new Error("Pull request identity requires a positive integer number");
		selector = `number:${input.number}`;
	} else {
		const head = input.head?.trim();
		if (!head) throw new Error("Pull request identity requires a number or resolved head");
		selector = `head:${head}`;
	}
	return `${host}/${owner}/${repository}#${selector}`;
}

function normalizeUrlAuthority(url: URL): string {
	const hostname = url.hostname.replace(/\.$/, "").toLowerCase();
	const defaultPort = (url.protocol === "https:" && url.port === "443")
		|| (url.protocol === "http:" && url.port === "80")
		|| (url.protocol === "ssh:" && url.port === "22");
	return url.port && !defaultPort ? `${hostname}:${url.port}` : hostname;
}

function authorityHostname(authority: string): string | undefined {
	const candidate = authority.trim();
	if (!candidate || candidate.includes("@") || candidate.includes("/")) return undefined;
	try {
		return new URL(`https://${candidate}`).hostname.replace(/\.$/, "").toLowerCase();
	} catch {
		return undefined;
	}
}

function normalizeHostedPath(host: string, pathname: string): string {
	const normalizedHost = normalizeGithubHost(host);
	const normalizedPath = stripGitSuffix(pathname.replace(/^\/+|\/+$/g, "")).toLowerCase();
	return `${normalizedHost}/${normalizedPath}`;
}

function stripGitSuffix(value: string): string {
	return value.replace(/\.git$/i, "");
}

function normalizeLocalPath(value: string): string {
	const slashPath = value.replace(/\\/g, "/");
	// URL pathname turns C:\\repo into /C:/repo on non-Windows hosts.
	if (/^\/?[A-Za-z]:\//.test(slashPath)) return slashPath.replace(/^\//, "").toLowerCase();
	return path.resolve(slashPath).replace(/\\/g, "/");
}

function isAbsolutePath(value: string): boolean {
	return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function opaqueKey(prefix: string, value: string): string {
	return `${prefix}${createHash("sha256").update(value).digest("base64url")}`;
}

function addressKey(address: RemoteStateAddress): string {
	return `${address.kind}:${address.id}`;
}

function safeClone<T>(value: T): T {
	// Remote state is deliberately JSON-shaped. structuredClone handles undefined
	// fields and avoids sharing mutable values with a WebSocket/REST consumer.
	return structuredClone(value);
}

function isIdentityProbeTimeout(error: unknown): boolean {
	const candidate = error as { code?: unknown; killed?: unknown; signal?: unknown; message?: unknown } | undefined;
	const code = typeof candidate?.code === "string" ? candidate.code.toLowerCase() : "";
	const message = typeof candidate?.message === "string" ? candidate.message.toLowerCase() : "";
	return candidate?.killed === true || candidate?.signal != null || code === "etimedout" || /timed out|timeout/.test(message);
}

function categorizeError(error: unknown): RemoteStateErrorKind {
	const candidate = error as { code?: unknown; status?: unknown; message?: unknown; stderr?: unknown } | undefined;
	const text = [candidate?.code, candidate?.status, candidate?.message, candidate?.stderr]
		.map((part) => typeof part === "string" || typeof part === "number" ? String(part) : "")
		.join(" ")
		.toLowerCase();
	if (/401|403|auth|credential|permission denied|bad credentials/.test(text)) return "auth";
	if (/429|rate.?limit|secondary rate/.test(text)) return "rate_limited";
	if (/enotfound|econn|network|offline|timed out|timeout|unreachable/.test(text)) return "offline";
	return "unavailable";
}

/**
 * Process-owned canonical remote state. All refresh results must already be safe
 * public projections; this class never serializes canonical identities or errors.
 */
export class RemoteStateCoordinator {
	private readonly clock: Pick<Clock, "now">;
	private readonly commandRunner: CommandRunner;
	private readonly maxConcurrent: number;
	private readonly maxConcurrentIdentityProbes: number;
	private readonly identityProbeTimeoutMs: number;
	private readonly broadcast?: RemoteStateCoordinatorOptions["broadcast"];
	private readonly telemetry?: RemoteStateCoordinatorOptions["telemetry"];
	private readonly repositoryFreshnessMs: number;
	private readonly activePrFreshnessMs: number;
	private readonly sidebarPrFreshnessMs: number;
	private readonly backoffBaseMs: number;
	private readonly backoffMaxMs: number;
	private readonly records = new Map<string, RemoteStateRecord<unknown>>();
	private readonly repositoryAliases = new Map<string, string>();
	private readonly repositoryIdentityInFlight = new Map<string, Promise<RepositoryIdentity>>();
	private readonly prAliases = new Map<string, string>();
	private active = 0;
	private readonly queued: Array<() => void> = [];
	private activeIdentityProbes = 0;
	private readonly queuedIdentityProbes: Array<() => void> = [];

	constructor(options: RemoteStateCoordinatorOptions = {}) {
		this.clock = options.clock ?? realClock;
		this.commandRunner = options.commandRunner ?? realCommandRunner;
		this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 4);
		this.maxConcurrentIdentityProbes = Math.max(1, options.maxConcurrentIdentityProbes ?? this.maxConcurrent);
		this.identityProbeTimeoutMs = Math.max(1, options.identityProbeTimeoutMs ?? DEFAULT_IDENTITY_PROBE_TIMEOUT_MS);
		this.broadcast = options.broadcast;
		this.telemetry = options.telemetry;
		this.repositoryFreshnessMs = options.repositoryFreshnessMs ?? DEFAULT_REPOSITORY_FRESHNESS_MS;
		this.activePrFreshnessMs = options.activePrFreshnessMs ?? DEFAULT_ACTIVE_PR_FRESHNESS_MS;
		this.sidebarPrFreshnessMs = options.sidebarPrFreshnessMs ?? DEFAULT_SIDEBAR_PR_FRESHNESS_MS;
		this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
		this.backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
	}

	/** Resolve worktree siblings through their Git common directory, not cwd/branch. */
	async resolveRepositoryIdentity(input: RepositoryIdentityInput): Promise<RepositoryIdentity> {
		const executionNamespace = input.executionNamespace?.trim() || "host";
		const executionAlias = `${executionNamespace}\0${normalizeLocalPath(input.cwd)}`;
		const existing = this.repositoryIdentityInFlight.get(executionAlias);
		if (existing) return { ...(await existing) };

		const pending = this.resolveRepositoryIdentityUncached(input.cwd, executionNamespace, input.executeGit).catch((error) => {
			this.emitTelemetry(undefined, "identity_failure", { source: "repository", errorKind: categorizeError(error) });
			throw error;
		});
		this.repositoryIdentityInFlight.set(executionAlias, pending);
		try {
			return { ...(await pending) };
		} finally {
			if (this.repositoryIdentityInFlight.get(executionAlias) === pending) {
				this.repositoryIdentityInFlight.delete(executionAlias);
			}
		}
	}

	private async resolveRepositoryIdentityUncached(
		cwd: string,
		executionNamespace: string,
		executeGit?: RepositoryIdentityInput["executeGit"],
	): Promise<RepositoryIdentity> {
		await this.acquireIdentityProbe();
		try {
			// Older Git versions do not support --path-format. Only this compatibility
			// probe may fail silently; all other probe failures remain generic.
			const commonDir = await this.readGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { suppressFailure: true }, executeGit)
				?? await this.readGit(cwd, ["rev-parse", "--git-common-dir"], {}, executeGit);
			if (!commonDir) throw new Error("Unable to resolve Git common directory");
			const normalizedCommonDir = normalizeLocalPath(isAbsolutePath(commonDir) ? commonDir : path.resolve(cwd, commonDir));
			const origin = await this.readGit(cwd, ["remote", "get-url", "origin"], { missingRemoteIsUndefined: true }, executeGit);
			const remote = origin ? normalizeRemoteIdentity(origin) : LOCAL_REMOTE;
			const canonicalAlias = `${executionNamespace}\0${normalizedCommonDir}\0${remote}`;
			const existing = this.repositoryAliases.get(canonicalAlias);
			if (existing) return { key: existing, hasRemote: remote !== LOCAL_REMOTE };
			const key = opaqueKey(REPOSITORY_PREFIX, canonicalAlias);
			this.repositoryAliases.set(canonicalAlias, key);
			return { key, hasRemote: remote !== LOCAL_REMOTE };
		} finally {
			this.releaseIdentityProbe();
		}
	}

	resolvePullRequestIdentity(input: PullRequestIdentityInput): PullRequestIdentity {
		const alias = normalizePullRequestIdentity(input);
		const existing = this.prAliases.get(alias);
		if (existing) return { key: existing };
		const key = opaqueKey(PR_PREFIX, alias);
		this.prAliases.set(alias, key);
		return { key };
	}

	registerRepository<T>(identity: RepositoryIdentity, options: RegisterRepositoryOptions<T>): string {
		const key = this.register(identity.key, "repository", options);
		if (options.binding) {
			const record = this.requireRecord(key);
			record.repositoryBindings.set(addressKey(options.binding.address), options.binding);
		}
		return key;
	}

	registerPullRequest<T>(identity: PullRequestIdentity, options: RegisterOptions<T>): string {
		return this.register(identity.key, "pull_request", options);
	}

	/** Immediate stale-while-revalidate read. Explicit reads bypass freshness/backoff but join in-flight work. */
	readSnapshot<T>(key: string, options: RemoteStateReadOptions = {}): RemoteStateSnapshot<T> {
		const record = this.requireRecord(key) as RemoteStateRecord<T>;
		if (options.address) record.addresses.set(addressKey(options.address), { ...options.address });
		const intent = options.intent ?? "automatic";
		const now = this.clock.now();
		this.requestRefresh(record, intent, now, options);
		return this.snapshot(record, now, options.cadence);
	}

	/** Marks retained data stale. It intentionally does not discard last-good data. */
	invalidate(key: string, options: { allowImmediateRefresh?: boolean } = {}): void {
		const record = this.requireRecord(key);
		record.invalidated = true;
		record.invalidationVersion += 1;
		// A force completed before this mutation/cache-bust is no longer equivalent;
		// concurrent force callers still join through the installed in-flight promise.
		record.lastForceRequestAt = undefined;
		// PR creation/cache-bust must make the next canonical read eligible now.
		// Normal repository mutations deliberately retain the 30-second automatic
		// attempt budget; an explicit force still bypasses both cadence and backoff.
		if (options.allowImmediateRefresh) record.lastAttemptAt = undefined;
	}

	/** Blocking staff path: honors repository cadence and automatic backoff. */
	async ensureFreshRepository<T>(key: string, options: { address?: RemoteStateAddress } = {}): Promise<RemoteStateSnapshot<T>> {
		const record = this.requireRecord(key) as RemoteStateRecord<T>;
		if (record.source !== "repository") throw new Error("ensureFreshRepository requires a repository key");
		if (options.address) record.addresses.set(addressKey(options.address), { ...options.address });
		const now = this.clock.now();
		this.requestRefresh(record, "automatic", now, { cadence: "active" });
		await record.inFlight;
		return this.snapshot(record, this.clock.now(), "active");
	}

	/** Explicit callers which need completion can await this rather than polling snapshots. */
	async refreshSnapshot<T>(key: string, options: RemoteStateReadOptions = {}): Promise<RemoteStateSnapshot<T>> {
		const record = this.requireRecord(key) as RemoteStateRecord<T>;
		if (options.address) record.addresses.set(addressKey(options.address), { ...options.address });
		const intent = options.intent ?? "explicit";
		this.requestRefresh(record, intent, this.clock.now(), options);
		await record.inFlight;
		return this.snapshot(record, this.clock.now(), options.cadence);
	}

	private register<T>(key: string, source: RemoteStateSource, options: RegisterOptions<T>): string {
		const existing = this.records.get(key);
		if (existing) {
			if (existing.source !== source) throw new Error("Remote state key is registered with a different source");
			// Do not change the execution cwd underneath queued or running work.
			// Sibling worktrees share one canonical record, and the first caller owns
			// the refresh that every concurrent caller joins.
			if (!existing.inFlight) (existing as RemoteStateRecord<T>).refresh = options.refresh;
			if (options.address) existing.addresses.set(addressKey(options.address), { ...options.address });
			return key;
		}
		const record: RemoteStateRecord<T> = {
			key,
			source,
			refresh: options.refresh,
			invalidated: false,
			invalidationVersion: 0,
			failureCount: 0,
			nextRetryAt: 0,
			addresses: new Map(),
			repositoryBindings: new Map(),
		};
		if (options.address) record.addresses.set(addressKey(options.address), { ...options.address });
		this.records.set(key, record as RemoteStateRecord<unknown>);
		return key;
	}

	private requireRecord(key: string): RemoteStateRecord<unknown> {
		const record = this.records.get(key);
		if (!record) throw new Error("Remote state key is not registered");
		return record;
	}

	private isFresh(record: RemoteStateRecord<unknown>, intent: RemoteStateIntent, now: number, cadence: "active" | "sidebar" = "active"): boolean {
		if (intent === "explicit" || record.invalidated || record.refreshedAt === undefined) return false;
		return now - record.refreshedAt < this.freshness(record, cadence);
	}

	private freshness(record: RemoteStateRecord<unknown>, cadence: "active" | "sidebar"): number {
		if (record.source === "repository") return this.repositoryFreshnessMs;
		return cadence === "sidebar" ? this.sidebarPrFreshnessMs : this.activePrFreshnessMs;
	}

	private requestRefresh(
		record: RemoteStateRecord<unknown>,
		intent: RemoteStateIntent,
		now: number,
		options: RemoteStateReadOptions = {},
	): void {
		const cadence = options.cadence ?? "active";
		if (this.isFresh(record, intent, now, cadence)) {
			this.emitTelemetry(record, "fresh", { intent, cadence });
			return;
		}
		if (record.inFlight) {
			this.emitTelemetry(record, "joined", { intent, cadence });
			return;
		}
		if (intent !== "explicit" && now < record.nextRetryAt) {
			this.emitTelemetry(record, "backoff", { intent, cadence });
			return;
		}
		if (
			intent === "explicit"
			&& options.forceRequestedAt !== undefined
			&& options.forceCoalesceMs !== undefined
			&& record.lastForceRequestAt !== undefined
			&& Math.abs(options.forceRequestedAt - record.lastForceRequestAt) < options.forceCoalesceMs
		) {
			this.emitTelemetry(record, "coalesced", { intent, cadence });
			return;
		}
		// A failed attempt still consumes the automatic external-call budget.
		if (intent !== "explicit" && record.lastAttemptAt !== undefined && now - record.lastAttemptAt < this.freshness(record, cadence)) {
			this.emitTelemetry(record, "budget", { intent, cadence });
			return;
		}
		if (intent === "explicit" && options.forceRequestedAt !== undefined) record.lastForceRequestAt = options.forceRequestedAt;
		this.emitTelemetry(record, "admitted", { intent, cadence });
		this.startRefresh(record, intent, cadence);
	}

	private startRefresh(record: RemoteStateRecord<unknown>, intent: RemoteStateIntent, cadence: "active" | "sidebar"): void {
		if (record.inFlight) return;
		const queuedAt = this.clock.now();
		if (this.active >= this.maxConcurrent) {
			this.emitTelemetry(record, "queued", { intent, cadence, queueDepth: this.queued.length + 1 });
		}
		const refresh = async () => {
			const startedAt = this.clock.now();
			record.lastAttemptAt = startedAt;
			this.emitTelemetry(record, "started", { intent, cadence, waitMs: Math.max(0, startedAt - queuedAt) });
			// Invalidation before execution is satisfied by this refresh. Invalidation
			// while remote I/O is running remains pending for the next eligible read.
			const invalidationVersion = record.invalidationVersion;
			let outcome: "success" | "failure" = "success";
			try {
				const data = await record.refresh();
				record.lastGood = safeClone(data);
				record.refreshedAt = this.clock.now();
				record.invalidated = record.invalidationVersion !== invalidationVersion;
				record.failureCount = 0;
				record.nextRetryAt = 0;
				record.lastError = undefined;
				this.reconcilePullRequestNumber(record, data);
			} catch (error) {
				outcome = "failure";
				const now = this.clock.now();
				record.invalidated = true;
				record.failureCount += 1;
				record.lastError = { kind: categorizeError(error), observedAt: now };
				const exponent = Math.min(record.failureCount - 1, 16);
				record.nextRetryAt = now + Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** exponent);
			} finally {
				this.emitTelemetry(record, outcome, {
					intent,
					cadence,
					durationMs: Math.max(0, this.clock.now() - startedAt),
					...(record.lastError ? { errorKind: record.lastError.kind } : {}),
				});
				// Remote admission is released before entity-local projection. The
				// canonical in-flight promise remains installed until fanout completes,
				// so forced callers still join rather than starting duplicate fetches.
				this.release();
				await this.broadcastRecord(record);
				record.inFlight = undefined;
			}
		};
		record.inFlight = this.acquire().then(refresh);
		// The promise is observed by blocking callers; this handler prevents an
		// accidental unhandled rejection if a future implementation changes refresh.
		void record.inFlight.catch(() => undefined);
	}

	private reconcilePullRequestNumber(record: RemoteStateRecord<unknown>, data: unknown): void {
		if (record.source !== "pull_request" || !data || typeof data !== "object") return;
		const number = (data as { number?: unknown }).number;
		if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) return;
		const prAlias = [...this.prAliases.entries()].find(([, key]) => key === record.key)?.[0];
		if (!prAlias) return;
		const prefix = prAlias.replace(/#(?:head|number):.*$/, "");
		this.prAliases.set(`${prefix}#number:${number}`, record.key);
	}

	private snapshot<T>(record: RemoteStateRecord<T>, observedAt: number, cadence: "active" | "sidebar" = "active"): RemoteStateSnapshot<T> {
		const refreshedAt = record.refreshedAt;
		return {
			...(record.lastGood === undefined ? {} : { data: safeClone(record.lastGood) }),
			observedAt,
			...(refreshedAt === undefined ? {} : { refreshedAt }),
			stale: record.invalidated || refreshedAt === undefined || observedAt - refreshedAt >= this.freshness(record, cadence),
			source: record.source,
			...(record.lastError ? { lastError: { ...record.lastError } } : {}),
			...(refreshedAt === undefined ? {} : { ageMs: Math.max(0, observedAt - refreshedAt) }),
		};
	}

	private async broadcastRecord(record: RemoteStateRecord<unknown>): Promise<void> {
		if (!this.broadcast) return;
		const projectedAddresses = new Set<string>();

		if (record.source === "repository" && record.repositoryBindings.size > 0) {
			// Invalidate every bound entity before any projector runs. This ensures a
			// refresh owned by one sibling worktree cannot leave another sibling's
			// short-lived local status cache pinned to pre-fetch refs.
			for (const binding of record.repositoryBindings.values()) {
				try { binding.invalidate?.(); } catch { /* local cache invalidation is best-effort */ }
			}
			for (const binding of record.repositoryBindings.values()) {
				const key = addressKey(binding.address);
				projectedAddresses.add(key);
				try {
					const data = await binding.project();
					const snapshot = { ...this.snapshot(record, this.clock.now(), "active"), data: safeClone(data) };
					this.emit(binding.address, snapshot);
				} catch {
					// A local projector failure must not turn a successful canonical fetch
					// into a remote failure. Metadata still tells the entity that refs were
					// refreshed; its next normal local read can recover independently.
					this.emit(binding.address, this.snapshot(record, this.clock.now(), "active"));
				}
			}
		}

		const snapshot = this.snapshot(record, this.clock.now(), "active");
		for (const address of record.addresses.values()) {
			if (!projectedAddresses.has(addressKey(address))) this.emit(address, snapshot);
		}
	}

	private emit(address: RemoteStateAddress, snapshot: RemoteStateSnapshot<unknown>): void {
		try { this.broadcast?.({ ...address }, safeClone(snapshot)); } catch { /* broadcast failure cannot strand canonical state */ }
	}

	private emitTelemetry(
		record: RemoteStateRecord<unknown> | undefined,
		outcome: RemoteStateTelemetryOutcome,
		detail: Omit<RemoteStateTelemetryEvent, "type" | "source" | "outcome" | "observedAt" | "record"> & { source?: RemoteStateSource } = {},
	): void {
		if (!this.telemetry) return;
		try {
			const now = this.clock.now();
			const refreshedAt = record?.refreshedAt;
			const ageMs = refreshedAt === undefined ? undefined : Math.max(0, now - refreshedAt);
			const stale = record
				? record.invalidated || refreshedAt === undefined || now - refreshedAt >= this.freshness(record, detail.cadence ?? "active")
				: undefined;
			const event: RemoteStateTelemetryEvent = {
				type: "remote_state_refresh",
				source: record?.source ?? detail.source ?? "repository",
				outcome,
				observedAt: now,
				...(record ? { record: opaqueKey("state:", record.key) } : {}),
				...(detail.intent ? { intent: detail.intent } : {}),
				...(detail.cadence ? { cadence: detail.cadence } : {}),
				...(detail.queueDepth === undefined ? {} : { queueDepth: detail.queueDepth }),
				...(detail.waitMs === undefined ? {} : { waitMs: detail.waitMs }),
				...(detail.durationMs === undefined ? {} : { durationMs: detail.durationMs }),
				...(ageMs === undefined ? {} : { ageMs }),
				...(stale === undefined ? {} : { stale }),
				...(detail.errorKind ? { errorKind: detail.errorKind } : {}),
			};
			this.telemetry(event);
		} catch { /* diagnostics are strictly best-effort */ }
	}

	private async readGit(
		cwd: string,
		args: string[],
		options: { suppressFailure?: boolean; missingRemoteIsUndefined?: boolean } = {},
		executeGit?: RepositoryIdentityInput["executeGit"],
	): Promise<string | undefined> {
		try {
			const stdout = executeGit
				? await executeGit(args, this.identityProbeTimeoutMs)
				: (await this.commandRunner.execFile("git", args, {
					cwd,
					encoding: "utf-8",
					windowsHide: true,
					timeout: this.identityProbeTimeoutMs,
				})).stdout.toString();
			const value = stdout.trim();
			return value || undefined;
		} catch (error) {
			if (options.suppressFailure && !isIdentityProbeTimeout(error)) return undefined;
			// `git remote get-url origin` reports absence as a command failure. Test
			// runners do not necessarily model Git's exact stderr, so every bounded
			// non-timeout failure on this optional probe means local-only.
			if (options.missingRemoteIsUndefined && !isIdentityProbeTimeout(error)) return undefined;
			// Never carry subprocess details, paths, remotes, or stderr beyond the
			// identity boundary. Callers only need to know that resolution failed.
			throw new Error("Repository identity probe failed");
		}
	}

	private async acquireIdentityProbe(): Promise<void> {
		if (this.activeIdentityProbes < this.maxConcurrentIdentityProbes) {
			this.activeIdentityProbes += 1;
			return;
		}
		await new Promise<void>((resolve) => this.queuedIdentityProbes.push(resolve));
	}

	private releaseIdentityProbe(): void {
		const next = this.queuedIdentityProbes.shift();
		if (next) {
			next();
			return;
		}
		this.activeIdentityProbes -= 1;
	}

	private async acquire(): Promise<void> {
		if (this.active < this.maxConcurrent) {
			this.active += 1;
			return;
		}
		await new Promise<void>((resolve) => this.queued.push(resolve));
	}

	private release(): void {
		const next = this.queued.shift();
		if (next) {
			next();
			return;
		}
		this.active -= 1;
	}
}
