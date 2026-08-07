import { randomUUID, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/** The only lifecycle state persisted before a runner has any side effects. */
export type ServiceRuntimeDesiredState = "stopped" | "running";
export type ServiceRuntimeObservedState = "stopped" | "starting" | "ready" | "degraded" | "blocked" | "unavailable";
export type ServiceRuntimeMode = "local" | "docker" | "compose";

export interface ServiceRuntimeIdentity {
	packId: string;
	runtimeId: string;
}

export interface ServiceRuntimeRunnerIdentity {
	kind: ServiceRuntimeMode;
	id: string;
	composeProject?: string;
}

/** A deliberately non-verbatim diagnostic; logs belong in the bounded artifact. */
export interface ServiceRuntimeDiagnostic {
	code: string;
	retryAt?: string;
}

/**
 * Metadata intentionally cannot carry environment values or secrets.  Secrets
 * live in their respective injected owners, and runtime output lives in the
 * owner-only artifact files.
 */
export interface PersistedServiceRuntime {
	version: 1;
	serverIdentity: string;
	desired: ServiceRuntimeDesiredState;
	selectedMode: ServiceRuntimeMode;
	settingsRevision: string;
	/** Opaque owner-derived continuity key. It must never contain a path, URL, or secret. */
	storageIdentity?: string;
	runnerIdentity?: ServiceRuntimeRunnerIdentity;
	endpoint?: string;
	restartAttempts: number[];
	lastDiagnostic?: ServiceRuntimeDiagnostic;
	updatedAt: string;
}

/** Generated service secrets are separate from EP-7 user-configured secrets. */
export interface GeneratedSecretOwner {
	get(key: string): string | undefined | Promise<string | undefined>;
	set(key: string, value: string): void | Promise<void>;
	remove?(key: string): void | Promise<void>;
}

/** EP-7's write-only secret lookup. This value is never persisted by this store. */
export interface UserSecretResolver {
	resolveSecret(setting: string): string | undefined | Promise<string | undefined>;
}

export interface ServiceRuntimeStoreOptions {
	stateDir: string;
	serverIdentity: string;
	generatedSecrets?: GeneratedSecretOwner;
	userSecrets?: UserSecretResolver;
	/** Injectable for deterministic tests; production defaults to cryptographic random bytes. */
	generateSecret?: () => string;
	platform?: NodeJS.Platform;
}

export interface RuntimeStorageDeclaration {
	/** Absolute, descriptor-resolved data directory. Never accepted from a request. */
	dataPath: string;
	/** Absolute descriptor-owned root containing dataPath. */
	ownedRoot: string;
}

export interface RuntimePurgeRequest {
	/** Exact identity confirmation acquired before this destructive operation. */
	confirmation: ServiceRuntimeIdentity;
	storage?: RuntimeStorageDeclaration;
	/** Names declared by the descriptor; user-configured secrets are never removed. */
	generatedSecretNames?: readonly string[];
	/** The supervisor supplies graceful runner teardown; it runs before deletion. */
	stop?: () => Promise<void>;
}

export const SERVICE_RUNTIME_STORE_ERROR = "SERVICE_RUNTIME_STORE_PERSIST_FAILED";

export class ServiceRuntimeStoreError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "ServiceRuntimeStoreError";
		this.code = code;
	}
}

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MAX_ARTIFACT_BYTES = 64 * 1024;
const MAX_ARTIFACT_LINES = 200;
const ID_RE = /^@?[A-Za-z0-9][A-Za-z0-9._@/-]{0,199}$/;
const RUNTIME_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const DIAGNOSTIC_CODE_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const STORAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function isNotFound(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function assertIdentity(identity: ServiceRuntimeIdentity): void {
	if (!ID_RE.test(identity.packId) || identity.packId.includes("..") || identity.packId.includes("\\")) {
		throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_INVALID_ID", "invalid service runtime pack identity");
	}
	if (!RUNTIME_ID_RE.test(identity.runtimeId)) {
		throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_INVALID_ID", "invalid service runtime identity");
	}
}

function assertServerIdentity(value: string): void {
	if (!value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
		throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_INVALID_ID", "invalid server identity");
	}
}

function encodePackId(packId: string): string {
	return Buffer.from(packId, "utf8").toString("base64url");
}

function secretKey(identity: ServiceRuntimeIdentity, key: string): string {
	if (!RUNTIME_ID_RE.test(key)) {
		throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_INVALID_SECRET", "invalid generated secret name");
	}
	return `service-runtime:${identity.packId}:${identity.runtimeId}:${key}`;
}

function assertSafeString(value: unknown, name: string, max = 1024): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000]/.test(value)) {
		throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_CORRUPT", `invalid persisted ${name}`);
	}
}

function assertRecord(record: PersistedServiceRuntime, serverIdentity: string): void {
	const allowed = new Set(["version", "serverIdentity", "desired", "selectedMode", "settingsRevision", "storageIdentity", "runnerIdentity", "endpoint", "restartAttempts", "lastDiagnostic", "updatedAt"]);
	if (!record || typeof record !== "object" || Object.keys(record).some((key) => !allowed.has(key)) || record.version !== 1 || record.serverIdentity !== serverIdentity) {
		throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_CORRUPT", "invalid persisted runtime record");
	}
	if (record.desired !== "stopped" && record.desired !== "running") {
		throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_CORRUPT", "invalid persisted desired state");
	}
	if (!(["local", "docker", "compose"] as const).includes(record.selectedMode)) {
		throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_CORRUPT", "invalid persisted runtime mode");
	}
	assertSafeString(record.settingsRevision, "settings revision", 512);
	if (record.storageIdentity !== undefined && (typeof record.storageIdentity !== "string" || !STORAGE_ID_RE.test(record.storageIdentity))) {
		throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_CORRUPT", "invalid persisted storage identity");
	}
	assertSafeString(record.updatedAt, "timestamp", 64);
	if (!Array.isArray(record.restartAttempts) || record.restartAttempts.some((value) => !Number.isFinite(value) || value < 0)) {
		throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_CORRUPT", "invalid persisted restart attempts");
	}
	if (record.endpoint !== undefined) assertSafeString(record.endpoint, "endpoint", 2048);
	if (record.runnerIdentity) {
		const allowedRunnerKeys = new Set(["kind", "id", "composeProject"]);
		if (Object.keys(record.runnerIdentity).some((key) => !allowedRunnerKeys.has(key)) || !(["local", "docker", "compose"] as const).includes(record.runnerIdentity.kind)) {
			throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_CORRUPT", "invalid persisted runner identity");
		}
		assertSafeString(record.runnerIdentity.id, "runner id", 512);
		if (record.runnerIdentity.composeProject !== undefined) assertSafeString(record.runnerIdentity.composeProject, "compose project", 512);
	}
	if (record.lastDiagnostic) {
		const allowedDiagnosticKeys = new Set(["code", "retryAt"]);
		if (Object.keys(record.lastDiagnostic).some((key) => !allowedDiagnosticKeys.has(key)) || !DIAGNOSTIC_CODE_RE.test(record.lastDiagnostic.code)) {
			throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_CORRUPT", "invalid persisted diagnostic");
		}
		if (record.lastDiagnostic.retryAt !== undefined) assertSafeString(record.lastDiagnostic.retryAt, "diagnostic retry time", 64);
	}
}

function cloneRecord(record: PersistedServiceRuntime): PersistedServiceRuntime {
	return JSON.parse(JSON.stringify(record)) as PersistedServiceRuntime;
}

const MAX_EXTERNAL_DATABASE_URL_BYTES = 8 * 1024;
const MAX_EXTERNAL_DATABASE_REDACTION_VARIANTS = 32;
const SUPPRESSED_RUNTIME_ARTIFACT = "[REDACTED]";

function isCredentialQueryComponent(name: string): boolean {
	const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
	return /(?:pass(?:word|phrase)?|pwd|token|credential|secret|auth(?:entication|orization)?|apikey|sslkey|sslcert|privatekey)/.test(normalized);
}

/** Match percent-encoded bytes regardless of hexadecimal casing, but never case-fold secret text. */
function escapeSecretForPattern(secret: string): string {
	let pattern = "";
	for (let index = 0; index < secret.length;) {
		const encodedByte = secret.slice(index, index + 3);
		if (/^%[0-9a-f]{2}$/i.test(encodedByte)) {
			pattern += `%[${encodedByte[1]!.toLowerCase()}${encodedByte[1]!.toUpperCase()}][${encodedByte[2]!.toLowerCase()}${encodedByte[2]!.toUpperCase()}]`;
			index += 3;
			continue;
		}
		pattern += secret[index]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		index++;
	}
	return pattern;
}

function formEncode(value: string): string {
	return new URLSearchParams([["value", value]]).toString().slice("value=".length);
}

/**
 * External database URLs may be echoed by adapters as either whole URLs or
 * individual URL/userinfo/query components. Derive only bounded, local
 * redaction variants from a valid PostgreSQL URL; never persist them.
 */
function externalDatabaseRedactionVariants(secret: string): readonly string[] | undefined {
	if (!/^postgres(?:ql)?:/i.test(secret)) return [];
	if (Buffer.byteLength(secret, "utf8") > MAX_EXTERNAL_DATABASE_URL_BYTES) return undefined;
	try {
		const url = new URL(secret);
		const protocol = url.protocol.toLowerCase();
		if ((protocol !== "postgres:" && protocol !== "postgresql:") || !url.hostname || !url.pathname || url.pathname === "/") return undefined;

		const variants: string[] = [url.href];
		const add = (candidate: string): boolean => {
			if (!candidate || variants.includes(candidate)) return true;
			if (variants.length >= MAX_EXTERNAL_DATABASE_REDACTION_VARIANTS) return false;
			variants.push(candidate);
			return true;
		};
		const addComponentVariants = (encoded: string, decoded: string): boolean =>
			add(encoded) && add(decoded) && add(encodeURIComponent(decoded)) && add(formEncode(decoded));

		if (url.password && !addComponentVariants(url.password, decodeURIComponent(url.password))) return undefined;
		for (const queryComponent of url.search.slice(1).split("&")) {
			if (!queryComponent) continue;
			const separator = queryComponent.indexOf("=");
			const rawName = separator === -1 ? queryComponent : queryComponent.slice(0, separator);
			const rawValue = separator === -1 ? "" : queryComponent.slice(separator + 1);
			const name = decodeURIComponent(rawName.replace(/\+/g, " "));
			const decodedValue = decodeURIComponent(rawValue.replace(/\+/g, " "));
			if (isCredentialQueryComponent(name) && !addComponentVariants(rawValue, decodedValue)) return undefined;
		}
		return variants;
	} catch {
		return undefined;
	}
}

function redactionVariants(secrets: readonly string[]): readonly string[] | undefined {
	const variants = [...new Set(secrets.filter((item) => item.length > 0))];
	for (const secret of variants.slice()) {
		const externalDatabaseVariants = externalDatabaseRedactionVariants(secret);
		if (!externalDatabaseVariants) return undefined;
		for (const variant of externalDatabaseVariants) if (!variants.includes(variant)) variants.push(variant);
	}
	return variants;
}

function redact(value: string, secrets: readonly string[]): string | undefined {
	const variants = redactionVariants(secrets);
	if (!variants) return undefined;
	let sanitized = value;
	for (const secret of [...variants].sort((a, b) => b.length - a.length)) {
		const escaped = escapeSecretForPattern(secret);
		sanitized = sanitized.replace(new RegExp(`\\b[A-Za-z_][A-Za-z0-9_]*=${escaped}`, "g"), (entry) => {
			const equals = entry.indexOf("=");
			return `${entry.slice(0, equals)}=[REDACTED]`;
		});
		sanitized = sanitized.replace(new RegExp(escaped, "g"), "[REDACTED]");
	}
	return sanitized;
}

/** Redact resolved secret values and retain only a bounded artifact tail. */
export function sanitizeRuntimeArtifact(value: string, secrets: readonly string[] = []): string {
	const redacted = redact(value, secrets);
	if (redacted === undefined) return SUPPRESSED_RUNTIME_ARTIFACT;
	const lines = redacted.split(/\r?\n/).slice(-MAX_ARTIFACT_LINES);
	let result = lines.join("\n");
	while (Buffer.byteLength(result, "utf8") > MAX_ARTIFACT_BYTES) result = result.slice(1);
	return result;
}

/**
 * Atomic, fail-closed metadata and artifact store. It deliberately has no
 * in-memory metadata cache: a failed write is never observable as durable state.
 */
export class ServiceRuntimeStore {
	private readonly root: string;
	private readonly serverIdentity: string;
	private readonly generatedSecrets?: GeneratedSecretOwner;
	private readonly userSecrets?: UserSecretResolver;
	private readonly generateSecret: () => string;
	private readonly platform: NodeJS.Platform;
	private readonly queues = new Map<string, Promise<void>>();

	constructor(options: ServiceRuntimeStoreOptions) {
		assertServerIdentity(options.serverIdentity);
		this.root = path.resolve(options.stateDir, "service-runtimes");
		this.serverIdentity = options.serverIdentity;
		this.generatedSecrets = options.generatedSecrets;
		this.userSecrets = options.userSecrets;
		this.generateSecret = options.generateSecret ?? (() => randomBytes(32).toString("base64url"));
		this.platform = options.platform ?? process.platform;
	}

	identity(packId: string, runtimeId: string): ServiceRuntimeIdentity {
		const identity = { packId, runtimeId };
		assertIdentity(identity);
		return identity;
	}

	private paths(identity: ServiceRuntimeIdentity): { dir: string; state: string; env: string; log: string } {
		assertIdentity(identity);
		const packDir = path.resolve(this.root, encodePackId(identity.packId));
		const dir = path.resolve(packDir, identity.runtimeId);
		if (!dir.startsWith(`${packDir}${path.sep}`)) {
			throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_INVALID_ID", "runtime path escapes state directory");
		}
		return { dir, state: path.join(dir, "state.json"), env: path.join(dir, "runtime.env"), log: path.join(dir, "runtime.log") };
	}

	private async queued<T>(identity: ServiceRuntimeIdentity, action: () => Promise<T>): Promise<T> {
		const key = `${identity.packId}\u0000${identity.runtimeId}`;
		const previous = this.queues.get(key) ?? Promise.resolve();
		let release!: () => void;
		const next = new Promise<void>((resolve) => { release = resolve; });
		const tail = previous.then(() => next, () => next);
		this.queues.set(key, tail);
		await previous;
		try {
			return await action();
		} finally {
			release();
			if (this.queues.get(key) === tail) this.queues.delete(key);
		}
	}

	private runtimeDirectories(dir: string): string[] {
		const relative = path.relative(this.root, dir);
		if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("runtime directory escapes state root");
		return [this.root, ...relative.split(path.sep).filter(Boolean).map((_, index, parts) => path.join(this.root, ...parts.slice(0, index + 1)))];
	}

	private async assertOwnedDirectory(dir: string, enforceMode = false): Promise<void> {
		for (const candidate of this.runtimeDirectories(dir)) {
			const stat = await fs.lstat(candidate);
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("runtime directory is not owned");
			if (enforceMode && this.platform !== "win32") {
				await fs.chmod(candidate, DIRECTORY_MODE);
				if (((await fs.stat(candidate)).mode & 0o777) !== DIRECTORY_MODE) throw new Error("runtime directory permissions are not owner-only");
			}
		}
	}

	private async ensureDirectory(dir: string): Promise<void> {
		await fs.mkdir(dir, { recursive: true, mode: DIRECTORY_MODE });
		await this.assertOwnedDirectory(dir, true);
	}

	private async syncDirectory(dir: string): Promise<void> {
		if (this.platform === "win32") return;
		const handle = await fs.open(dir, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	private async atomicWrite(file: string, contents: string): Promise<void> {
		const dir = path.dirname(file);
		await this.ensureDirectory(dir);
		const temporary = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
		let published = false;
		try {
			const handle = await fs.open(temporary, "wx", FILE_MODE);
			try {
				await handle.writeFile(contents, "utf8");
				await handle.chmod(FILE_MODE);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await fs.rename(temporary, file);
			published = true;
			if (this.platform !== "win32") {
				await fs.chmod(file, FILE_MODE);
				const stat = await fs.stat(file);
				if ((stat.mode & 0o777) !== FILE_MODE) throw new Error("runtime file permissions are not owner-only");
			}
			await this.syncDirectory(dir);
		} catch (error) {
			throw new ServiceRuntimeStoreError(SERVICE_RUNTIME_STORE_ERROR, "service runtime state could not be persisted");
		} finally {
			if (!published) await fs.rm(temporary, { force: true }).catch(() => undefined);
		}
	}

	async load(identity: ServiceRuntimeIdentity): Promise<PersistedServiceRuntime | undefined> {
		return this.queued(identity, async () => {
			const { dir, state } = this.paths(identity);
			let raw: string;
			try {
				await this.assertOwnedDirectory(dir);
				const stateFile = await fs.lstat(state);
				if (!stateFile.isFile() || stateFile.isSymbolicLink()) {
					throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_CORRUPT", "runtime state path is unsafe");
				}
				raw = await fs.readFile(state, "utf8");
			} catch (error) {
				if (error instanceof ServiceRuntimeStoreError) throw error;
				if (isNotFound(error)) return undefined;
				throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_READ_FAILED", "service runtime state could not be read");
			}
			let record: PersistedServiceRuntime;
			try {
				record = JSON.parse(raw) as PersistedServiceRuntime;
				assertRecord(record, this.serverIdentity);
			} catch (error) {
				if (error instanceof ServiceRuntimeStoreError) throw error;
				throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_CORRUPT", "service runtime state is corrupt");
			}
			return cloneRecord(record);
		});
	}

	async list(): Promise<Array<{ identity: ServiceRuntimeIdentity; record: PersistedServiceRuntime }>> {
		let packNames: string[];
		try {
			packNames = await fs.readdir(this.root);
		} catch (error) {
			if (isNotFound(error)) return [];
			throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_READ_FAILED", "service runtime state could not be listed");
		}
		const results: Array<{ identity: ServiceRuntimeIdentity; record: PersistedServiceRuntime }> = [];
		for (const packName of packNames) {
			let packId: string;
			try { packId = Buffer.from(packName, "base64url").toString("utf8"); } catch { continue; }
			if (!ID_RE.test(packId) || packId.includes("..") || packId.includes("\\")) continue;
			const packDir = path.join(this.root, packName);
			const stat = await fs.lstat(packDir).catch(() => undefined);
			if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
			for (const runtimeId of await fs.readdir(packDir)) {
				if (!RUNTIME_ID_RE.test(runtimeId)) continue;
				const identity = { packId, runtimeId };
				const record = await this.load(identity);
				if (record) results.push({ identity, record });
			}
		}
		return results;
	}

	async replace(identity: ServiceRuntimeIdentity, record: PersistedServiceRuntime): Promise<void> {
		return this.queued(identity, async () => {
			assertRecord(record, this.serverIdentity);
			await this.atomicWrite(this.paths(identity).state, `${JSON.stringify(cloneRecord(record), null, "\t")}\n`);
		});
	}

	async remove(identity: ServiceRuntimeIdentity): Promise<void> {
		return this.queued(identity, async () => {
			const { dir } = this.paths(identity);
			const stat = await fs.lstat(dir).catch((error: unknown) => isNotFound(error) ? undefined : Promise.reject(error));
			if (!stat) return;
			try {
				await this.assertOwnedDirectory(dir);
				await fs.rm(dir, { recursive: true, force: false });
				await this.syncDirectory(path.dirname(dir));
			} catch {
				throw new ServiceRuntimeStoreError(SERVICE_RUNTIME_STORE_ERROR, "service runtime state could not be removed");
			}
		});
	}

	async writeEnvironment(identity: ServiceRuntimeIdentity, environment: Readonly<Record<string, string>>): Promise<void> {
		for (const [key, value] of Object.entries(environment)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || typeof value !== "string" || value.includes("\u0000")) {
				throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_INVALID_ENV", "invalid runtime environment artifact");
			}
		}
		const contents = Object.keys(environment).sort().map((key) => `${key}=${JSON.stringify(environment[key])}`).join("\n");
		await this.queued(identity, () => this.atomicWrite(this.paths(identity).env, contents ? `${contents}\n` : ""));
	}

	/**
	 * Returns the already-materialized environment artifact without reading its
	 * contents. Compose control paths need its filename after a restart, but
	 * status must never resolve or load settings/secrets to reconstruct it.
	 */
	async environmentFile(identity: ServiceRuntimeIdentity): Promise<string> {
		return this.queued(identity, async () => {
			const { dir, env } = this.paths(identity);
			try {
				await this.assertOwnedDirectory(dir);
				const envStat = await fs.lstat(env);
				if (!envStat.isFile() || envStat.isSymbolicLink()) {
					throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_CORRUPT", "runtime environment path is unsafe");
				}
				if (this.platform !== "win32" && (envStat.mode & 0o777) !== FILE_MODE) {
					throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_CORRUPT", "runtime environment file is not owner-only");
				}
				return env;
			} catch (error) {
				if (error instanceof ServiceRuntimeStoreError) throw error;
				if (isNotFound(error)) {
					throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_ENV_UNAVAILABLE", "runtime environment artifact is unavailable");
				}
				throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_READ_FAILED", "runtime environment path could not be read");
			}
		});
	}

	async writeLog(identity: ServiceRuntimeIdentity, output: string, resolvedSecrets: readonly string[] = []): Promise<void> {
		if (typeof output !== "string") throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_INVALID_ARTIFACT", "invalid runtime log artifact");
		await this.queued(identity, async () => {
			const { dir, log } = this.paths(identity);
			try { await this.assertOwnedDirectory(dir); }
			catch (error) { if (!isNotFound(error)) throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_CORRUPT", "runtime log directory is unsafe"); }
			let prior = "";
			try {
				const priorStat = await fs.lstat(log);
				if (!priorStat.isFile() || priorStat.isSymbolicLink()) throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_CORRUPT", "runtime log path is unsafe");
				prior = await fs.readFile(log, "utf8");
			} catch (error) {
				if (error instanceof ServiceRuntimeStoreError) throw error;
				if (!isNotFound(error)) throw error;
			}
			await this.atomicWrite(log, sanitizeRuntimeArtifact(`${prior}${prior && output ? "\n" : ""}${output}`, resolvedSecrets));
		});
	}

	async readLog(identity: ServiceRuntimeIdentity): Promise<string | undefined> {
		return this.queued(identity, async () => {
			try {
				const { dir, log } = this.paths(identity);
				await this.assertOwnedDirectory(dir);
				const logStat = await fs.lstat(log);
				if (!logStat.isFile() || logStat.isSymbolicLink()) throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_CORRUPT", "runtime log path is unsafe");
				return await fs.readFile(log, "utf8");
			} catch (error) {
				if (error instanceof ServiceRuntimeStoreError) throw error;
				if (isNotFound(error)) return undefined;
				throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_READ_FAILED", "runtime log could not be read");
			}
		});
	}

	async getOrCreateGeneratedSecret(identity: ServiceRuntimeIdentity, name: string): Promise<string> {
		return this.queued(identity, async () => {
			if (!this.generatedSecrets) throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_SECRET_OWNER_MISSING", "generated secret owner is unavailable");
			const key = secretKey(identity, name);
			const existing = await this.generatedSecrets.get(key);
			if (typeof existing === "string" && existing.length > 0) return existing;
			const generated = this.generateSecret();
			if (!generated || /[\u0000]/.test(generated)) throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_INVALID_SECRET", "generated invalid service secret");
			try { await this.generatedSecrets.set(key, generated); }
			catch { throw new ServiceRuntimeStoreError(SERVICE_RUNTIME_STORE_ERROR, "generated service secret could not be persisted"); }
			return generated;
		});
	}

	async resolveUserSecret(setting: string): Promise<string | undefined> {
		if (!this.userSecrets) throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_SECRET_OWNER_MISSING", "user secret resolver is unavailable");
		if (!RUNTIME_ID_RE.test(setting)) throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_INVALID_SECRET", "invalid user secret setting");
		try { return await this.userSecrets.resolveSecret(setting); }
		catch { throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_STORE_SECRET_UNAVAILABLE", "user service secret is unavailable"); }
	}

	async purge(identity: ServiceRuntimeIdentity, request: RuntimePurgeRequest): Promise<void> {
		assertIdentity(request.confirmation);
		if (request.confirmation.packId !== identity.packId || request.confirmation.runtimeId !== identity.runtimeId) {
			throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_PURGE_CONFIRMATION_REQUIRED", "runtime purge confirmation does not match");
		}
		if (request.stop) await request.stop();
		await this.remove(identity);
		if (request.storage) await this.removeDeclaredStorage(request.storage);
		if (this.generatedSecrets?.remove) {
			for (const name of request.generatedSecretNames ?? []) {
				try { await this.generatedSecrets.remove(secretKey(identity, name)); }
				catch { throw new ServiceRuntimeStoreError(SERVICE_RUNTIME_STORE_ERROR, "generated service secret could not be removed"); }
			}
		}
	}

	private async removeDeclaredStorage(declaration: RuntimeStorageDeclaration): Promise<void> {
		if (!path.isAbsolute(declaration.dataPath) || !path.isAbsolute(declaration.ownedRoot)) {
			throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_PURGE_INVALID_STORAGE", "runtime storage declaration must be absolute");
		}
		const root = path.resolve(declaration.ownedRoot);
		const target = path.resolve(declaration.dataPath);
		if (target === root || !target.startsWith(`${root}${path.sep}`)) {
			throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_PURGE_INVALID_STORAGE", "runtime storage escapes its declared owner");
		}
		const rootStat = await fs.lstat(root).catch((error: unknown) => isNotFound(error) ? undefined : Promise.reject(error));
		if (!rootStat) return;
		if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
			throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_PURGE_INVALID_STORAGE", "runtime storage owner is unsafe");
		}
		const canonicalRoot = await fs.realpath(root);
		const targetStat = await fs.lstat(target).catch((error: unknown) => isNotFound(error) ? undefined : Promise.reject(error));
		if (!targetStat) return;
		if (targetStat.isSymbolicLink()) throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_PURGE_INVALID_STORAGE", "runtime storage is a symbolic link");
		const canonicalParent = await fs.realpath(path.dirname(target));
		if (canonicalParent !== canonicalRoot && !canonicalParent.startsWith(`${canonicalRoot}${path.sep}`)) {
			throw new ServiceRuntimeStoreError("SERVICE_RUNTIME_PURGE_INVALID_STORAGE", "runtime storage escaped its declared owner");
		}
		try { await fs.rm(target, { recursive: true, force: false }); }
		catch { throw new ServiceRuntimeStoreError(SERVICE_RUNTIME_STORE_ERROR, "runtime storage could not be purged"); }
	}
}
