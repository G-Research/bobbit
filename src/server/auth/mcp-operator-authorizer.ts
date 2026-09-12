import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { serverSecretsDir } from "../bobbit-dir.js";

export const MCP_OPERATOR_AUTHORIZATION_FILE = "mcp-operator-authorization.json";
export const MCP_OPERATOR_PAIRING_TTL_MS = 10 * 60_000;
export const MCP_OPERATOR_PAIRING_MAX_FAILURES = 5;
export const MCP_OPERATOR_PAIRING_RATE_WINDOW_MS = 60_000;

const PAIRING_CODE_BYTES = 32;
const CREDENTIAL_ID_BYTES = 16;
const CREDENTIAL_SECRET_BYTES = 32;
const DIGEST_BYTES = 32;
const MAX_TRACKED_REMOTE_ADDRESSES = 1_024;
const PAIRING_DIGEST_DOMAIN = Buffer.from("bobbit:mcp-operator-pairing-code:v1\0", "utf8");
const CREDENTIAL_VERIFIER_DOMAIN = Buffer.from("bobbit:mcp-operator-credential:v1\0", "utf8");

export type McpOperatorCredential = `v1.${string}.${string}`;

export interface McpOperatorClaim {
	purpose: "mcp-approval:v1";
	credentialId: string;
}

export interface PairingCode {
	code: string;
	expiresAt: string;
}

interface PersistedMcpOperatorAuthorization {
	schema: 1;
	credential: {
		id: string;
		verifier: string;
		createdAt: string;
	} | null;
}

interface ActivePairingCode {
	digest: Buffer;
	expiresAt: number;
}

interface FailureWindow {
	count: number;
	startedAt: number;
}

type McpOperatorFileSystem = Pick<
	typeof fs,
	"chmodSync" | "closeSync" | "fsyncSync" | "lstatSync" | "mkdirSync" | "openSync" | "readFileSync"
> & {
	promises: Pick<typeof fs.promises, "open" | "rename" | "unlink">;
};

export interface McpOperatorAuthorizerOptions {
	secretsDir?: string;
	fileSystem?: McpOperatorFileSystem;
	now?: () => number;
	randomBytes?: (size: number) => Buffer;
	platform?: NodeJS.Platform;
	pairingTtlMs?: number;
	maxPairingFailures?: number;
	pairingRateWindowMs?: number;
	maxTrackedRemoteAddresses?: number;
}

export type McpOperatorAuthorizationErrorCode =
	| "MCP_OPERATOR_PAIRING_REQUIRED"
	| "MCP_OPERATOR_PAIRING_RATE_LIMITED"
	| "MCP_OPERATOR_PERSIST_FAILED";

export class McpOperatorAuthorizationError extends Error {
	constructor(readonly code: McpOperatorAuthorizationErrorCode) {
		super(code === "MCP_OPERATOR_PAIRING_RATE_LIMITED"
			? "Too many unsuccessful MCP operator pairing attempts. Try again later."
			: code === "MCP_OPERATOR_PERSIST_FAILED"
				? "MCP operator authorization could not be saved. Check server secret storage permissions and retry."
				: "A current MCP operator pairing code is required.");
		this.name = "McpOperatorAuthorizationError";
	}
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function decodeCanonicalBase64Url(value: unknown, bytes: number): Buffer | undefined {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
	try {
		const decoded = Buffer.from(value, "base64url");
		if (decoded.length !== bytes || decoded.toString("base64url") !== value) return undefined;
		return decoded;
	} catch {
		return undefined;
	}
}

function parseIsoTimestamp(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const milliseconds = Date.parse(value);
	if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) return undefined;
	return value;
}

function parsePersisted(value: unknown): PersistedMcpOperatorAuthorization | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const root = value as Record<string, unknown>;
	if (!hasExactKeys(root, ["schema", "credential"]) || root.schema !== 1) return undefined;
	if (root.credential === null) return { schema: 1, credential: null };
	if (!root.credential || typeof root.credential !== "object" || Array.isArray(root.credential)) return undefined;
	const credential = root.credential as Record<string, unknown>;
	if (!hasExactKeys(credential, ["id", "verifier", "createdAt"])) return undefined;
	if (!decodeCanonicalBase64Url(credential.id, CREDENTIAL_ID_BYTES)
		|| !decodeCanonicalBase64Url(credential.verifier, DIGEST_BYTES)) return undefined;
	const createdAt = parseIsoTimestamp(credential.createdAt);
	if (!createdAt) return undefined;
	return {
		schema: 1,
		credential: {
			id: credential.id as string,
			verifier: credential.verifier as string,
			createdAt,
		},
	};
}

function digest(domain: Buffer, ...parts: Buffer[]): Buffer {
	const hash = crypto.createHash("sha256");
	hash.update(domain);
	for (const part of parts) hash.update(part);
	return hash.digest();
}

function isErrno(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error
		&& (error as NodeJS.ErrnoException).code === code;
}

/**
 * Owns the terminal-to-browser capability used only for project MCP approval
 * decisions. Raw pairing codes and credentials are never persisted.
 */
export class McpOperatorAuthorizer {
	private readonly secretsDir: string;
	private readonly fileSystem: McpOperatorFileSystem;
	private readonly now: () => number;
	private readonly randomBytes: (size: number) => Buffer;
	private readonly platform: NodeJS.Platform;
	private readonly pairingTtlMs: number;
	private readonly maxPairingFailures: number;
	private readonly pairingRateWindowMs: number;
	private readonly maxTrackedRemoteAddresses: number;
	private credential: PersistedMcpOperatorAuthorization["credential"] = null;
	private activePairingCode: ActivePairingCode | undefined;
	private failures = new Map<string, FailureWindow>();
	private pairQueue: Promise<void> = Promise.resolve();
	private readonly authorizationPath: string;

	constructor(options: McpOperatorAuthorizerOptions = {}) {
		this.secretsDir = path.resolve(options.secretsDir ?? serverSecretsDir());
		this.authorizationPath = path.join(this.secretsDir, MCP_OPERATOR_AUTHORIZATION_FILE);
		this.fileSystem = options.fileSystem ?? fs;
		this.now = options.now ?? Date.now;
		this.randomBytes = options.randomBytes ?? crypto.randomBytes;
		this.platform = options.platform ?? process.platform;
		this.pairingTtlMs = this.positiveInteger(options.pairingTtlMs, MCP_OPERATOR_PAIRING_TTL_MS, "pairingTtlMs");
		this.maxPairingFailures = this.positiveInteger(options.maxPairingFailures, MCP_OPERATOR_PAIRING_MAX_FAILURES, "maxPairingFailures");
		this.pairingRateWindowMs = this.positiveInteger(options.pairingRateWindowMs, MCP_OPERATOR_PAIRING_RATE_WINDOW_MS, "pairingRateWindowMs");
		this.maxTrackedRemoteAddresses = this.positiveInteger(options.maxTrackedRemoteAddresses, MAX_TRACKED_REMOTE_ADDRESSES, "maxTrackedRemoteAddresses");
		this.load();
	}

	createPairingCode(): PairingCode {
		const codeBytes = this.secureRandomBytes(PAIRING_CODE_BYTES);
		const now = this.currentTime();
		const expiresAt = now + this.pairingTtlMs;
		this.activePairingCode = {
			digest: digest(PAIRING_DIGEST_DOMAIN, codeBytes),
			expiresAt,
		};
		return { code: codeBytes.toString("base64url"), expiresAt: new Date(expiresAt).toISOString() };
	}

	pair(code: string, remoteAddress: string): Promise<{ credential: McpOperatorCredential }> {
		const operation = this.pairQueue.then(() => this.pairSerialized(code, remoteAddress));
		this.pairQueue = operation.then(() => undefined, () => undefined);
		return operation;
	}

	verify(value: string | undefined): McpOperatorClaim | undefined {
		if (!this.credential || typeof value !== "string") return undefined;
		const pieces = value.split(".");
		if (pieces.length !== 3 || pieces[0] !== "v1") return undefined;
		const id = decodeCanonicalBase64Url(pieces[1], CREDENTIAL_ID_BYTES);
		const secret = decodeCanonicalBase64Url(pieces[2], CREDENTIAL_SECRET_BYTES);
		const persistedId = decodeCanonicalBase64Url(this.credential.id, CREDENTIAL_ID_BYTES);
		const persistedVerifier = decodeCanonicalBase64Url(this.credential.verifier, DIGEST_BYTES);
		if (!id || !secret || !persistedId || !persistedVerifier) return undefined;
		const candidateVerifier = digest(CREDENTIAL_VERIFIER_DOMAIN, id, secret);
		// Always perform both fixed-length comparisons. The public credential id is
		// not an early-exit oracle for the secret verifier.
		const idMatches = crypto.timingSafeEqual(id, persistedId);
		const verifierMatches = crypto.timingSafeEqual(candidateVerifier, persistedVerifier);
		if (!idMatches || !verifierMatches) return undefined;
		return { purpose: "mcp-approval:v1", credentialId: pieces[1] };
	}

	private async pairSerialized(code: string, remoteAddress: string): Promise<{ credential: McpOperatorCredential }> {
		const now = this.currentTime();
		const remoteKey = digest(Buffer.from("bobbit:mcp-operator-remote:v1\0", "utf8"), Buffer.from(remoteAddress, "utf8")).toString("base64url");
		if (this.isRateLimited(remoteKey, now)) {
			throw new McpOperatorAuthorizationError("MCP_OPERATOR_PAIRING_RATE_LIMITED");
		}

		const codeBytes = decodeCanonicalBase64Url(code, PAIRING_CODE_BYTES);
		const active = this.activePairingCode;
		if (!active || now >= active.expiresAt || !codeBytes
			|| !crypto.timingSafeEqual(digest(PAIRING_DIGEST_DOMAIN, codeBytes), active.digest)) {
			if (active && now >= active.expiresAt) this.activePairingCode = undefined;
			this.recordFailure(remoteKey, now);
			throw new McpOperatorAuthorizationError("MCP_OPERATOR_PAIRING_REQUIRED");
		}

		const idBytes = this.secureRandomBytes(CREDENTIAL_ID_BYTES);
		const secretBytes = this.secureRandomBytes(CREDENTIAL_SECRET_BYTES);
		const id = idBytes.toString("base64url");
		const secret = secretBytes.toString("base64url");
		const candidate: NonNullable<PersistedMcpOperatorAuthorization["credential"]> = {
			id,
			verifier: digest(CREDENTIAL_VERIFIER_DOMAIN, idBytes, secretBytes).toString("base64url"),
			createdAt: new Date(now).toISOString(),
		};

		await this.persist({ schema: 1, credential: candidate });
		this.credential = candidate;
		// createPairingCode() may have deliberately rotated the terminal code while
		// this serialized exchange was waiting on durable publication. Only consume
		// the exact code this operation validated.
		if (this.activePairingCode === active) this.activePairingCode = undefined;
		this.failures.delete(remoteKey);
		return { credential: `v1.${id}.${secret}` };
	}

	private load(): void {
		try {
			this.ensureSecretsDirectory();
			const stat = this.fileSystem.lstatSync(this.authorizationPath);
			if (!stat.isFile() || stat.isSymbolicLink()) return;
			const parsed = parsePersisted(JSON.parse(this.fileSystem.readFileSync(this.authorizationPath, "utf8")));
			if (!parsed) return;
			this.enforceMode(this.authorizationPath, 0o600);
			this.credential = parsed.credential;
		} catch (error) {
			if (!isErrno(error, "ENOENT")) this.credential = null;
		}
	}

	private ensureSecretsDirectory(): void {
		this.fileSystem.mkdirSync(this.secretsDir, { recursive: true, mode: 0o700 });
		const stat = this.fileSystem.lstatSync(this.secretsDir);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("MCP operator secrets path must be a real directory");
		this.enforceMode(this.secretsDir, 0o700);
	}

	private enforceMode(target: string, mode: number): void {
		if (this.platform === "win32") return;
		this.fileSystem.chmodSync(target, mode);
		const actual = this.fileSystem.lstatSync(target).mode & 0o777;
		if (actual !== mode) throw new Error("MCP operator authorization permissions are not restrictive");
	}

	private async persist(state: PersistedMcpOperatorAuthorization): Promise<void> {
		let temporary: string | undefined;
		let handle: fs.promises.FileHandle | undefined;
		try {
			this.ensureSecretsDirectory();
			const suffix = this.secureRandomBytes(8).toString("base64url");
			temporary = path.join(this.secretsDir, `.${MCP_OPERATOR_AUTHORIZATION_FILE}.${process.pid}.${suffix}.tmp`);
			handle = await this.fileSystem.promises.open(temporary, "wx", 0o600);
			await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			this.enforceMode(temporary, 0o600);
			await this.fileSystem.promises.rename(temporary, this.authorizationPath);
			temporary = undefined;
			this.syncDirectoryBestEffort();
		} catch (error) {
			throw Object.assign(new McpOperatorAuthorizationError("MCP_OPERATOR_PERSIST_FAILED"), { cause: error });
		} finally {
			if (handle) await handle.close().catch(() => undefined);
			if (temporary) await this.fileSystem.promises.unlink(temporary).catch(() => undefined);
		}
	}

	private syncDirectoryBestEffort(): void {
		let descriptor: number | undefined;
		try {
			descriptor = this.fileSystem.openSync(this.secretsDir, "r");
			this.fileSystem.fsyncSync(descriptor);
		} catch {
			// The replacement is already atomic; directory fsync is unsupported on
			// Windows and some filesystems, so extra durability is best-effort.
		} finally {
			if (descriptor !== undefined) this.fileSystem.closeSync(descriptor);
		}
	}

	private isRateLimited(remoteKey: string, now: number): boolean {
		const record = this.failures.get(remoteKey);
		if (!record) return false;
		if (now < record.startedAt || now - record.startedAt >= this.pairingRateWindowMs) {
			this.failures.delete(remoteKey);
			return false;
		}
		return record.count >= this.maxPairingFailures;
	}

	private recordFailure(remoteKey: string, now: number): void {
		const record = this.failures.get(remoteKey);
		if (!record || now < record.startedAt || now - record.startedAt >= this.pairingRateWindowMs) {
			if (!record && this.failures.size >= this.maxTrackedRemoteAddresses) {
				const oldest = this.failures.keys().next().value as string | undefined;
				if (oldest) this.failures.delete(oldest);
			}
			this.failures.set(remoteKey, { count: 1, startedAt: now });
			return;
		}
		record.count += 1;
	}

	private secureRandomBytes(size: number): Buffer {
		const value = this.randomBytes(size);
		if (!Buffer.isBuffer(value) || value.length !== size) {
			throw new Error(`MCP operator random source must return exactly ${size} bytes`);
		}
		return Buffer.from(value);
	}

	private currentTime(): number {
		const value = this.now();
		if (!Number.isFinite(value) || value < 0 || value > 8_640_000_000_000_000) {
			throw new Error("MCP operator clock returned an invalid timestamp");
		}
		return value;
	}

	private positiveInteger(value: number | undefined, fallback: number, name: string): number {
		const selected = value ?? fallback;
		if (!Number.isSafeInteger(selected) || selected <= 0) throw new Error(`${name} must be a positive integer`);
		return selected;
	}
}
