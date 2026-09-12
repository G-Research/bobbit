import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { serverSecretsDir } from "../bobbit-dir.js";
import { McpApprovalStore } from "./mcp-approval-store.js";
import type { McpServerConfig } from "./mcp-types.js";

const ATTESTATION_FILE = "marketplace-mcp-install-attestations.json";
const SCHEMA = 2;
const READ_CHUNK_BYTES = 64 * 1024;
export const MARKETPLACE_MCP_PACK_MAX_ENTRIES = 10_000;
export const MARKETPLACE_MCP_PACK_MAX_BYTES = 256 * 1024 * 1024;
export const MARKETPLACE_MCP_PACK_MAX_PATH_BYTES = 4 * 1024;

export interface MarketplaceMcpPackIntegrityLimits {
	maxEntries?: number;
	maxBytes?: number;
	maxPathBytes?: number;
}

export interface MarketplaceMcpInstallIdentity {
	projectId: string;
	sourceId: string;
	packName: string;
	contributionId: string;
	serverName: string;
	config: McpServerConfig;
	/** Current complete-pack measurement. Undefined means measurement failed closed. */
	packIntegrity?: string;
}

interface PersistedMarketplaceMcpInstallAttestation {
	projectId: string;
	sourceId: string;
	packName: string;
	contributionId: string;
	serverName: string;
	fingerprint: string;
	attestedAt: string;
}

interface PersistedMarketplaceMcpInstallLedger {
	schema: 2;
	attestations: PersistedMarketplaceMcpInstallAttestation[];
}

type EntryType = "directory" | "file" | "symlink";
interface MeasuredEntry {
	fullPath: string;
	relativePath: string;
	type: EntryType;
	stat: fs.Stats;
}

export class MarketplaceMcpPackIntegrityError extends Error {
	readonly code = "MARKETPLACE_MCP_PACK_INTEGRITY_INVALID";
	constructor() {
		super("Installed Marketplace pack integrity could not be verified.");
		this.name = "MarketplaceMcpPackIntegrityError";
	}
}

function integrityFailure(): never {
	throw new MarketplaceMcpPackIntegrityError();
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isAttestation(value: unknown): value is PersistedMarketplaceMcpInstallAttestation {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const row = value as Record<string, unknown>;
	return [
		row.projectId,
		row.sourceId,
		row.packName,
		row.contributionId,
		row.serverName,
		row.fingerprint,
		row.attestedAt,
	].every(nonEmptyString);
}

function normalizedRelative(root: string, candidate: string): string {
	const relative = path.relative(root, candidate);
	if (!relative || relative === ".." || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)) integrityFailure();
	return relative.split(path.sep).join("/");
}

function pathKey(value: string): string {
	return process.platform === "win32" ? value.toLowerCase() : value;
}

function sameSnapshot(left: fs.Stats, right: fs.Stats): boolean {
	return left.isFile() === right.isFile()
		&& left.isDirectory() === right.isDirectory()
		&& left.isSymbolicLink() === right.isSymbolicLink()
		&& left.dev === right.dev
		&& left.ino === right.ino
		&& left.size === right.size
		&& left.mode === right.mode
		&& left.mtimeMs === right.mtimeMs
		&& left.ctimeMs === right.ctimeMs;
}

function updateString(hash: crypto.Hash, value: string): void {
	const bytes = Buffer.from(value, "utf8");
	const length = Buffer.allocUnsafe(4);
	length.writeUInt32BE(bytes.length);
	hash.update(length).update(bytes);
}

function updateSize(hash: crypto.Hash, value: number): void {
	const bytes = Buffer.allocUnsafe(8);
	bytes.writeBigUInt64BE(BigInt(value));
	hash.update(bytes);
}

function validateLimit(value: number): number {
	if (!Number.isSafeInteger(value) || value < 1) integrityFailure();
	return value;
}

/**
 * Measure every entry in an installed pack without following repository-owned
 * links. Directory snapshots and opened-file identities are rechecked so a
 * partial or concurrently replaced traversal fails closed.
 */
export function measureMarketplaceMcpPackIntegrity(
	packRoot: string,
	limits: MarketplaceMcpPackIntegrityLimits = {},
): string {
	const maxEntries = validateLimit(limits.maxEntries ?? MARKETPLACE_MCP_PACK_MAX_ENTRIES);
	const maxBytes = validateLimit(limits.maxBytes ?? MARKETPLACE_MCP_PACK_MAX_BYTES);
	const maxPathBytes = validateLimit(limits.maxPathBytes ?? MARKETPLACE_MCP_PACK_MAX_PATH_BYTES);
	let root: string;
	let rootStat: fs.Stats;
	let suppliedRootStat: fs.Stats;
	try {
		suppliedRootStat = fs.lstatSync(packRoot);
		if (!suppliedRootStat.isDirectory() || suppliedRootStat.isSymbolicLink()) return integrityFailure();
		root = fs.realpathSync(packRoot);
		rootStat = fs.lstatSync(root);
	} catch {
		return integrityFailure();
	}
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !sameSnapshot(suppliedRootStat, rootStat)) integrityFailure();

	const rootEntry: MeasuredEntry = { fullPath: root, relativePath: ".", type: "directory", stat: rootStat };
	const entries: MeasuredEntry[] = [rootEntry];
	const directories: MeasuredEntry[] = [rootEntry];
	const pending = [root];
	while (pending.length > 0) {
		const directory = pending.pop()!;
		let children: string[];
		try {
			children = fs.readdirSync(directory);
		} catch {
			return integrityFailure();
		}
		children.sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
		for (const name of children) {
			const fullPath = path.join(directory, name);
			const relativePath = normalizedRelative(root, fullPath);
			if (Buffer.byteLength(relativePath, "utf8") > maxPathBytes || entries.length >= maxEntries) integrityFailure();
			let stat: fs.Stats;
			try {
				stat = fs.lstatSync(fullPath);
			} catch {
				return integrityFailure();
			}
			let type: EntryType;
			if (stat.isDirectory() && !stat.isSymbolicLink()) type = "directory";
			else if (stat.isFile() && !stat.isSymbolicLink()) type = "file";
			else if (stat.isSymbolicLink()) type = "symlink";
			else integrityFailure();
			const entry = { fullPath, relativePath, type, stat };
			entries.push(entry);
			if (type === "directory") {
				directories.push(entry);
				pending.push(fullPath);
			}
		}
	}
	entries.sort((a, b) => Buffer.compare(Buffer.from(a.relativePath, "utf8"), Buffer.from(b.relativePath, "utf8")));

	const hash = crypto.createHash("sha256").update("bobbit:marketplace-mcp-pack-integrity:v1\0", "utf8");
	const symlinkTargets = new Map<string, string>();
	let totalBytes = 0;
	for (const entry of entries) {
		updateString(hash, entry.relativePath);
		updateString(hash, entry.type);
		// Execute/search bits alter how installed files and directories may be used.
		updateString(hash, (entry.stat.mode & 0o111).toString(8));

		if (entry.type === "directory") continue;
		if (entry.type === "symlink") {
			let target: string;
			let finalStat: fs.Stats;
			try {
				target = fs.readlinkSync(entry.fullPath);
				finalStat = fs.lstatSync(entry.fullPath);
			} catch {
				return integrityFailure();
			}
			if (!sameSnapshot(entry.stat, finalStat) || path.isAbsolute(target) || Buffer.byteLength(target, "utf8") > maxPathBytes) integrityFailure();
			const resolvedTarget = path.resolve(path.dirname(entry.fullPath), target);
			const targetRelative = normalizedRelative(root, resolvedTarget);
			totalBytes += Buffer.byteLength(target, "utf8");
			if (totalBytes > maxBytes) integrityFailure();
			updateString(hash, target);
			symlinkTargets.set(pathKey(entry.relativePath), pathKey(targetRelative));
			continue;
		}

		if (!Number.isSafeInteger(entry.stat.size) || entry.stat.size < 0 || totalBytes + entry.stat.size > maxBytes) integrityFailure();
		let fd: number | undefined;
		try {
			const noFollow = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
			fd = fs.openSync(entry.fullPath, fs.constants.O_RDONLY | noFollow);
			const opened = fs.fstatSync(fd);
			if (!opened.isFile() || !sameSnapshot(entry.stat, opened)) integrityFailure();
			updateSize(hash, opened.size);
			const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, Math.max(1, opened.size)));
			let offset = 0;
			while (offset < opened.size) {
				const read = fs.readSync(fd, chunk, 0, Math.min(chunk.length, opened.size - offset), offset);
				if (read <= 0) integrityFailure();
				hash.update(chunk.subarray(0, read));
				offset += read;
			}
			const afterRead = fs.fstatSync(fd);
			const finalStat = fs.lstatSync(entry.fullPath);
			if (!sameSnapshot(opened, afterRead) || !sameSnapshot(opened, finalStat)) integrityFailure();
			totalBytes += opened.size;
		} catch (error) {
			if (error instanceof MarketplaceMcpPackIntegrityError) throw error;
			return integrityFailure();
		} finally {
			if (fd !== undefined) {
				try { fs.closeSync(fd); } catch { return integrityFailure(); }
			}
		}
	}

	// Validate link chains component-by-component without asking the filesystem to
	// follow them. This catches directory-link cycles such as a -> b/x, b -> a/y.
	for (const initialTarget of symlinkTargets.values()) {
		const seen = new Set<string>();
		let cursor = initialTarget;
		for (;;) {
			if (seen.has(cursor)) integrityFailure();
			seen.add(cursor);
			const components = cursor.split("/");
			let linkPrefix: string | undefined;
			let linkLength = 0;
			for (let length = components.length; length > 0; length -= 1) {
				const candidate = pathKey(components.slice(0, length).join("/"));
				if (symlinkTargets.has(candidate)) {
					linkPrefix = candidate;
					linkLength = length;
					break;
				}
			}
			if (!linkPrefix) break;
			const suffix = components.slice(linkLength).join("/");
			cursor = path.posix.normalize(`${symlinkTargets.get(linkPrefix)!}${suffix ? `/${suffix}` : ""}`);
			if (cursor === ".." || cursor.startsWith("../") || path.posix.isAbsolute(cursor)) integrityFailure();
		}
	}

	for (const directory of directories) {
		let current: fs.Stats;
		try { current = fs.lstatSync(directory.fullPath); }
		catch { return integrityFailure(); }
		if (!sameSnapshot(directory.stat, current)) integrityFailure();
	}
	try {
		const finalSuppliedRoot = fs.lstatSync(packRoot);
		if (!sameSnapshot(suppliedRootStat, finalSuppliedRoot) || fs.realpathSync(packRoot) !== root) integrityFailure();
	} catch {
		return integrityFailure();
	}
	return hash.digest("hex");
}

function sameInstall(
	row: PersistedMarketplaceMcpInstallAttestation,
	projectId: string,
	packName: string,
): boolean {
	return row.projectId === projectId && row.packName === packName;
}

/** Server-private proof that an install flow published one exact complete pack. */
export class MarketplaceMcpInstallAttestationStore {
	private attestations: PersistedMarketplaceMcpInstallAttestation[] = [];
	private readonly fingerprints: McpApprovalStore;
	readonly ledgerPath: string;

	constructor(private readonly secretsDir = serverSecretsDir()) {
		this.ledgerPath = path.join(secretsDir, ATTESTATION_FILE);
		this.fingerprints = new McpApprovalStore(secretsDir);
		this.load();
	}

	private load(): void {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.ledgerPath, "utf8")) as Partial<PersistedMarketplaceMcpInstallLedger>;
			this.attestations = parsed.schema === SCHEMA && Array.isArray(parsed.attestations)
				? parsed.attestations.filter(isAttestation)
				: [];
		} catch (error) {
			this.attestations = [];
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				console.error("[mcp] MARKETPLACE_MCP_ATTESTATION_INVALID");
			}
		}
	}

	classify(identity: MarketplaceMcpInstallIdentity): "attested" | "changed" | "missing" {
		const tuple = this.attestations.filter((row) => row.projectId === identity.projectId
			&& row.sourceId === identity.sourceId
			&& row.packName === identity.packName
			&& row.contributionId === identity.contributionId
			&& row.serverName === identity.serverName);
		if (tuple.length === 0) return "missing";
		if (!identity.packIntegrity) return "changed";
		const fingerprint = this.fingerprints.marketplaceInstallFingerprint(identity.config, identity.packIntegrity);
		return fingerprint && tuple.some((row) => row.fingerprint === fingerprint) ? "attested" : "changed";
	}

	isAttested(identity: MarketplaceMcpInstallIdentity): boolean {
		return this.classify(identity) === "attested";
	}

	/** Atomically replace all attestations owned by one logical project pack. */
	replacePack(
		projectId: string,
		sourceId: string,
		packName: string,
		packRoot: string,
		definitions: Array<{ contributionId: string; serverName: string; config: McpServerConfig }>,
		expectedPackIntegrity?: string,
	): string {
		const packIntegrity = measureMarketplaceMcpPackIntegrity(packRoot);
		if (expectedPackIntegrity !== undefined && packIntegrity !== expectedPackIntegrity) integrityFailure();
		const attestedAt = new Date().toISOString();
		const next = this.attestations.filter((row) => !sameInstall(row, projectId, packName));
		for (const definition of definitions) {
			const fingerprint = this.fingerprints.marketplaceInstallFingerprint(definition.config, packIntegrity);
			if (!fingerprint) throw Object.assign(new Error("Could not create Marketplace MCP install attestation."), {
				code: "MARKETPLACE_MCP_ATTESTATION_KEY_UNAVAILABLE",
			});
			next.push({
				projectId,
				sourceId,
				packName,
				contributionId: definition.contributionId,
				serverName: definition.serverName,
				fingerprint,
				attestedAt,
			});
		}
		this.persist(next);
		this.attestations = next;
		return packIntegrity;
	}

	removePack(projectId: string, packName: string): void {
		const next = this.attestations.filter((row) => !sameInstall(row, projectId, packName));
		if (next.length === this.attestations.length) return;
		this.persist(next);
		this.attestations = next;
	}

	private persist(attestations: PersistedMarketplaceMcpInstallAttestation[]): void {
		fs.mkdirSync(this.secretsDir, { recursive: true });
		const temporary = `${this.ledgerPath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
		let fd: number | undefined;
		try {
			fd = fs.openSync(temporary, "wx", 0o600);
			fs.writeFileSync(fd, `${JSON.stringify({ schema: SCHEMA, attestations } satisfies PersistedMarketplaceMcpInstallLedger, null, 2)}\n`, "utf8");
			fs.fsyncSync(fd);
			fs.closeSync(fd);
			fd = undefined;
			fs.renameSync(temporary, this.ledgerPath);
			if (process.platform !== "win32") {
				try { fs.chmodSync(this.ledgerPath, 0o600); } catch { /* best-effort owner-only mode */ }
			}
			try {
				const directoryFd = fs.openSync(this.secretsDir, "r");
				try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
			} catch { /* the file itself is already durable */ }
		} catch (cause) {
			throw Object.assign(new Error("Could not persist Marketplace MCP install attestation."), {
				code: "MARKETPLACE_MCP_ATTESTATION_PERSIST_FAILED",
				cause,
			});
		} finally {
			if (fd !== undefined) {
				try { fs.closeSync(fd); } catch { /* preserve the original error */ }
			}
			try { fs.rmSync(temporary, { force: true }); } catch { /* preserve the original error */ }
		}
	}
}
