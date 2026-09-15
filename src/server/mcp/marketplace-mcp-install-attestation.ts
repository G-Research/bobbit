import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import { serverSecretsDir } from "../bobbit-dir.js";
import { loadMcpContributions, type McpPackContribution } from "../agent/pack-contributions.js";
import { parseManifest, validateMeta } from "../agent/pack-manifest.js";
import type { PackManifest, PackMeta } from "../agent/pack-types.js";
import { McpApprovalStore } from "./mcp-approval-store.js";
import type { McpServerConfig } from "./mcp-types.js";

const ATTESTATION_FILE = "marketplace-mcp-install-attestations.json";
const SNAPSHOT_DIRECTORY = "marketplace-mcp-pack-snapshots";
const SNAPSHOT_ID_RE = /^[a-f0-9]{64}$/;
const SCHEMA = 3;
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
	snapshotId: string;
	attestedAt: string;
}

interface PersistedMarketplaceMcpInstallLedger {
	schema: 3;
	attestations: PersistedMarketplaceMcpInstallAttestation[];
}

export type MarketplaceMcpPackSnapshotResolution =
	| { status: "missing" | "invalid" }
	| { status: "changed"; sourceId: string }
	| {
		status: "attested";
		packRoot: string;
		packIntegrity: string;
		sourceId: string;
		manifest: PackManifest;
		meta: PackMeta;
		metaDetails: Record<string, unknown>;
		mcp: McpPackContribution[];
	};

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

export class MarketplaceMcpSnapshotPublicationError extends Error {
	readonly code = "MARKETPLACE_MCP_SNAPSHOT_PUBLISH_FAILED";
	constructor() {
		super("Could not publish the Marketplace MCP install snapshot.");
		this.name = "MarketplaceMcpSnapshotPublicationError";
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
		row.snapshotId,
		row.attestedAt,
	].every(nonEmptyString) && SNAPSHOT_ID_RE.test(String(row.snapshotId));
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
		// Snapshot sealing removes group/other permissions. Only the owner's
		// executable bit is behaviorally relevant to the server-private copy.
		updateString(hash, (entry.stat.mode & 0o100) === 0 ? "0" : "1");

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

function isPlainMapping(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function snapshotFailure(): never {
	throw Object.assign(new Error("Installed Marketplace MCP snapshot could not be verified."), {
		code: "MARKETPLACE_MCP_SNAPSHOT_INVALID",
	});
}

interface ValidatedSnapshot {
	packRoot: string;
	packIntegrity: string;
	sourceId: string;
	manifest: PackManifest;
	meta: PackMeta;
	metaDetails: Record<string, unknown>;
	mcp: McpPackContribution[];
}

/** Server-private proof that an install flow published one exact complete pack. */
export class MarketplaceMcpInstallAttestationStore {
	private attestations: PersistedMarketplaceMcpInstallAttestation[] = [];
	private ledgerInvalid = false;
	private readonly fingerprints: McpApprovalStore;
	readonly ledgerPath: string;
	readonly snapshotsRoot: string;

	constructor(private readonly secretsDir = serverSecretsDir()) {
		this.ledgerPath = path.join(secretsDir, ATTESTATION_FILE);
		this.snapshotsRoot = path.join(secretsDir, SNAPSHOT_DIRECTORY);
		this.fingerprints = new McpApprovalStore(secretsDir);
		this.load();
		if (!this.ledgerInvalid) this.cleanupUnreferencedSnapshots();
	}

	private load(): void {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.ledgerPath, "utf8")) as Partial<PersistedMarketplaceMcpInstallLedger>;
			if (parsed.schema !== SCHEMA || !Array.isArray(parsed.attestations) || !parsed.attestations.every(isAttestation)) {
				throw new Error("invalid Marketplace MCP attestation ledger");
			}
			this.attestations = parsed.attestations;
			this.ledgerInvalid = false;
		} catch (error) {
			this.attestations = [];
			this.ledgerInvalid = (error as NodeJS.ErrnoException).code !== "ENOENT";
			if (this.ledgerInvalid) console.error("[mcp] MARKETPLACE_MCP_ATTESTATION_INVALID");
		}
	}

	private ensureSnapshotsRoot(): void {
		fs.mkdirSync(this.snapshotsRoot, { recursive: true, mode: 0o700 });
		const stat = fs.lstatSync(this.snapshotsRoot);
		if (!stat.isDirectory() || stat.isSymbolicLink()) snapshotFailure();
		if (process.platform !== "win32") fs.chmodSync(this.snapshotsRoot, 0o700);
	}

	private snapshotPath(snapshotId: string): string {
		if (!SNAPSHOT_ID_RE.test(snapshotId)) return snapshotFailure();
		const candidate = path.join(this.snapshotsRoot, snapshotId);
		const relative = path.relative(this.snapshotsRoot, candidate);
		if (!relative || relative === ".." || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)) return snapshotFailure();
		return candidate;
	}

	private readSnapshotPack(packRoot: string, packName: string, sourceId: string): Omit<ValidatedSnapshot, "packIntegrity"> {
		let manifest: PackManifest | null;
		let metaDetails: unknown;
		try {
			manifest = parseManifest(fs.readFileSync(path.join(packRoot, "pack.yaml"), "utf8"));
			metaDetails = parseYaml(fs.readFileSync(path.join(packRoot, ".pack-meta.yaml"), "utf8"));
		} catch {
			return snapshotFailure();
		}
		const meta = validateMeta(metaDetails);
		if (!manifest || !meta || !isPlainMapping(metaDetails)
			|| manifest.name !== packName || meta.packName !== packName
			|| meta.scope !== "project" || meta.sourceId !== sourceId
			|| meta.version !== manifest.version) return snapshotFailure();
		let mcp: McpPackContribution[];
		try {
			mcp = loadMcpContributions(packRoot, manifest, { silent: true });
		} catch {
			return snapshotFailure();
		}
		// Authored packs have always tolerated malformed contributions by dropping
		// them. The snapshot attests only the successfully normalized declarations;
		// a later repair changes the repository digest and cannot inherit pretrust.
		return { packRoot, sourceId, manifest, meta, metaDetails, mcp };
	}

	private validateSnapshotRows(rows: PersistedMarketplaceMcpInstallAttestation[]): ValidatedSnapshot {
		if (rows.length === 0) return snapshotFailure();
		const first = rows[0]!;
		if (rows.some((row) => row.projectId !== first.projectId
			|| row.sourceId !== first.sourceId
			|| row.packName !== first.packName
			|| row.snapshotId !== first.snapshotId)) return snapshotFailure();
		const packRoot = this.snapshotPath(first.snapshotId);
		let packIntegrity: string;
		try {
			const snapshotsStat = fs.lstatSync(this.snapshotsRoot);
			if (!snapshotsStat.isDirectory() || snapshotsStat.isSymbolicLink()) return snapshotFailure();
			const rootStat = fs.lstatSync(packRoot);
			if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return snapshotFailure();
			const rootReal = fs.realpathSync(this.snapshotsRoot);
			const packReal = fs.realpathSync(packRoot);
			const relative = path.relative(rootReal, packReal);
			if (!relative || relative === ".." || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)) return snapshotFailure();
			packIntegrity = measureMarketplaceMcpPackIntegrity(packRoot);
		} catch {
			return snapshotFailure();
		}
		const snapshot = this.readSnapshotPack(packRoot, first.packName, first.sourceId);
		const rowsByContribution = new Map<string, PersistedMarketplaceMcpInstallAttestation>();
		for (const row of rows) {
			const key = `${row.contributionId}\0${row.serverName}`;
			if (rowsByContribution.has(key)) return snapshotFailure();
			rowsByContribution.set(key, row);
		}
		if (rowsByContribution.size !== snapshot.mcp.length) return snapshotFailure();
		for (const contribution of snapshot.mcp) {
			const row = rowsByContribution.get(`${contribution.listName}\0${contribution.serverName}`);
			const fingerprint = this.fingerprints.marketplaceInstallFingerprint(contribution.config, packIntegrity);
			if (!row || !fingerprint || row.fingerprint !== fingerprint) return snapshotFailure();
		}
		return { ...snapshot, packIntegrity };
	}

	resolvePack(projectId: string, packName: string, repositoryPackIntegrity?: string): MarketplaceMcpPackSnapshotResolution {
		const rows = this.attestations.filter((row) => sameInstall(row, projectId, packName));
		if (rows.length === 0) return { status: this.ledgerInvalid ? "invalid" : "missing" };
		let snapshot: ValidatedSnapshot;
		try {
			snapshot = this.validateSnapshotRows(rows);
		} catch {
			return { status: "invalid" };
		}
		if (!repositoryPackIntegrity || repositoryPackIntegrity !== snapshot.packIntegrity) {
			return { status: "changed", sourceId: snapshot.sourceId };
		}
		return { status: "attested", ...snapshot };
	}

	classify(identity: MarketplaceMcpInstallIdentity): "attested" | "changed" | "missing" {
		const tuple = this.attestations.filter((row) => row.projectId === identity.projectId
			&& row.sourceId === identity.sourceId
			&& row.packName === identity.packName
			&& row.contributionId === identity.contributionId
			&& row.serverName === identity.serverName);
		if (tuple.length === 0) return "missing";
		if (!identity.packIntegrity) return "changed";
		const packRows = this.attestations.filter((row) => sameInstall(row, identity.projectId, identity.packName));
		try {
			const snapshot = this.validateSnapshotRows(packRows);
			if (snapshot.packIntegrity !== identity.packIntegrity) return "changed";
			const fingerprint = this.fingerprints.marketplaceInstallFingerprint(identity.config, identity.packIntegrity);
			return fingerprint && tuple.some((row) => row.fingerprint === fingerprint) ? "attested" : "changed";
		} catch {
			return "changed";
		}
	}

	isAttested(identity: MarketplaceMcpInstallIdentity): boolean {
		return this.classify(identity) === "attested";
	}

	private sealSnapshot(packRoot: string): void {
		const directories: string[] = [];
		const pending = [packRoot];
		while (pending.length > 0) {
			const directory = pending.pop()!;
			directories.push(directory);
			for (const name of fs.readdirSync(directory)) {
				const candidate = path.join(directory, name);
				const stat = fs.lstatSync(candidate);
				if (stat.isDirectory() && !stat.isSymbolicLink()) pending.push(candidate);
				else if (stat.isFile() && !stat.isSymbolicLink()) fs.chmodSync(candidate, (stat.mode & 0o100) === 0 ? 0o400 : 0o500);
			}
		}
		for (const directory of directories.reverse()) fs.chmodSync(directory, 0o500);
	}

	private fsyncSnapshot(packRoot: string): void {
		const pending = [packRoot];
		const directories: string[] = [];
		while (pending.length > 0) {
			const directory = pending.pop()!;
			directories.push(directory);
			for (const name of fs.readdirSync(directory)) {
				const candidate = path.join(directory, name);
				const stat = fs.lstatSync(candidate);
				if (stat.isDirectory() && !stat.isSymbolicLink()) pending.push(candidate);
				else if (stat.isFile() && !stat.isSymbolicLink()) {
					// Windows requires a writable handle for fsync. This is still an
					// unpublished private staging tree and is sealed immediately after.
					fs.chmodSync(candidate, (stat.mode & 0o100) === 0 ? 0o600 : 0o700);
					const fd = fs.openSync(candidate, "r+");
					try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
				}
			}
		}
		for (const directory of directories.reverse()) {
			try {
				const fd = fs.openSync(directory, "r");
				try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
			} catch { /* directory fsync is unavailable on some platforms */ }
		}
	}

	private makeSnapshotWritable(packRoot: string): void {
		const pending = [packRoot];
		while (pending.length > 0) {
			const directory = pending.pop()!;
			try { fs.chmodSync(directory, 0o700); } catch { continue; }
			let names: string[];
			try { names = fs.readdirSync(directory); } catch { continue; }
			for (const name of names) {
				const candidate = path.join(directory, name);
				try {
					const stat = fs.lstatSync(candidate);
					if (stat.isDirectory() && !stat.isSymbolicLink()) pending.push(candidate);
					else if (stat.isFile() && !stat.isSymbolicLink()) fs.chmodSync(candidate, 0o600);
				} catch { /* cleanup remains best-effort */ }
			}
		}
	}

	private removeSnapshotBestEffort(packRoot: string): void {
		try {
			const stat = fs.lstatSync(packRoot);
			if (!stat.isDirectory() || stat.isSymbolicLink()) {
				fs.rmSync(packRoot, { force: true });
				return;
			}
		} catch {
			return;
		}
		try { this.makeSnapshotWritable(packRoot); } catch { /* cleanup remains best-effort */ }
		try { fs.rmSync(packRoot, { recursive: true, force: true }); } catch { /* an orphan is inert without a ledger reference */ }
	}

	private cleanupUnreferencedSnapshots(): void {
		let names: string[];
		try {
			const stat = fs.lstatSync(this.snapshotsRoot);
			if (!stat.isDirectory() || stat.isSymbolicLink()) return;
			names = fs.readdirSync(this.snapshotsRoot);
		} catch { return; }
		const referenced = new Set(this.attestations.map((row) => row.snapshotId));
		for (const name of names) {
			if ((SNAPSHOT_ID_RE.test(name) && !referenced.has(name)) || name.startsWith(".tmp-")) {
				this.removeSnapshotBestEffort(path.join(this.snapshotsRoot, name));
			}
		}
	}

	/** Publish a complete private snapshot, then atomically replace one logical project's pack rows. */
	replacePack(
		projectId: string,
		sourceId: string,
		packName: string,
		packRoot: string,
		expectedPackIntegrity?: string,
	): string {
		try {
			return this.replacePackSnapshot(projectId, sourceId, packName, packRoot, expectedPackIntegrity);
		} catch (error) {
			const code = (error as { code?: unknown })?.code;
			if (error instanceof MarketplaceMcpPackIntegrityError
				|| code === "MARKETPLACE_MCP_SNAPSHOT_INVALID"
				|| code === "MARKETPLACE_MCP_ATTESTATION_KEY_UNAVAILABLE"
				|| code === "MARKETPLACE_MCP_ATTESTATION_PERSIST_FAILED") throw error;
			throw new MarketplaceMcpSnapshotPublicationError();
		}
	}

	private replacePackSnapshot(
		projectId: string,
		sourceId: string,
		packName: string,
		packRoot: string,
		expectedPackIntegrity?: string,
	): string {
		this.ensureSnapshotsRoot();
		const beforeCopy = measureMarketplaceMcpPackIntegrity(packRoot);
		if (expectedPackIntegrity !== undefined && beforeCopy !== expectedPackIntegrity) integrityFailure();
		const snapshotId = crypto.randomBytes(32).toString("hex");
		const staging = path.join(this.snapshotsRoot, `.tmp-${snapshotId}-${crypto.randomBytes(8).toString("hex")}`);
		const published = this.snapshotPath(snapshotId);
		let publishedSnapshot = false;
		try {
			fs.cpSync(packRoot, staging, { recursive: true, dereference: false, errorOnExist: true, force: false, verbatimSymlinks: true });
			const afterCopy = measureMarketplaceMcpPackIntegrity(packRoot);
			const copied = measureMarketplaceMcpPackIntegrity(staging);
			if (beforeCopy !== afterCopy || copied !== afterCopy) integrityFailure();
			this.fsyncSnapshot(staging);
			this.sealSnapshot(staging);
			if (measureMarketplaceMcpPackIntegrity(staging) !== copied) integrityFailure();
			fs.renameSync(staging, published);
			publishedSnapshot = true;
			try {
				const rootFd = fs.openSync(this.snapshotsRoot, "r");
				try { fs.fsyncSync(rootFd); } finally { fs.closeSync(rootFd); }
			} catch { /* the complete snapshot still precedes its ledger reference */ }

			const snapshot = this.readSnapshotPack(published, packName, sourceId);
			const attestedAt = new Date().toISOString();
			const rows: PersistedMarketplaceMcpInstallAttestation[] = [];
			for (const contribution of snapshot.mcp) {
				const fingerprint = this.fingerprints.marketplaceInstallFingerprint(contribution.config, copied);
				if (!fingerprint) throw Object.assign(new Error("Could not create Marketplace MCP install attestation."), {
					code: "MARKETPLACE_MCP_ATTESTATION_KEY_UNAVAILABLE",
				});
				rows.push({
					projectId,
					sourceId,
					packName,
					contributionId: contribution.listName,
					serverName: contribution.serverName,
					fingerprint,
					snapshotId,
					attestedAt,
				});
			}
			const next = [
				...this.attestations.filter((row) => !sameInstall(row, projectId, packName)),
				...rows,
			];
			this.persist(next);
			this.attestations = next;
			this.ledgerInvalid = false;
			this.cleanupUnreferencedSnapshots();
			return copied;
		} catch (error) {
			this.removeSnapshotBestEffort(publishedSnapshot ? published : staging);
			throw error;
		}
	}

	removePack(projectId: string, packName: string): void {
		const next = this.attestations.filter((row) => !sameInstall(row, projectId, packName));
		if (next.length === this.attestations.length && !this.ledgerInvalid) return;
		this.persist(next);
		this.attestations = next;
		this.ledgerInvalid = false;
		this.cleanupUnreferencedSnapshots();
	}

	private persist(attestations: PersistedMarketplaceMcpInstallAttestation[]): void {
		fs.mkdirSync(this.secretsDir, { recursive: true, mode: 0o700 });
		if (process.platform !== "win32") {
			try { fs.chmodSync(this.secretsDir, 0o700); } catch { /* parent may be managed externally */ }
		}
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
