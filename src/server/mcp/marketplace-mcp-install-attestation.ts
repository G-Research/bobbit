import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { serverSecretsDir } from "../bobbit-dir.js";
import { canonicalMcpServerConfig } from "./mcp-approval-store.js";
import type { McpServerConfig } from "./mcp-types.js";

const ATTESTATION_FILE = "marketplace-mcp-install-attestations.json";
const SCHEMA = 1;

export interface MarketplaceMcpInstallIdentity {
	projectId: string;
	sourceId: string;
	packName: string;
	contributionId: string;
	serverName: string;
	config: McpServerConfig;
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
	schema: 1;
	attestations: PersistedMarketplaceMcpInstallAttestation[];
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

/** Hash the exact execution/connection semantics without persisting raw values. */
export function marketplaceMcpBehaviorFingerprint(config: McpServerConfig): string {
	return crypto.createHash("sha256")
		.update(JSON.stringify(canonicalMcpServerConfig(config)))
		.digest("hex");
}

function sameInstall(
	row: PersistedMarketplaceMcpInstallAttestation,
	projectId: string,
	packName: string,
): boolean {
	return row.projectId === projectId && row.packName === packName;
}

/**
 * Server-private proof that a project Marketplace install flow deliberately
 * published an exact MCP definition. Project-owned pack metadata is only a
 * locator; it is never authority without an exact row in this external ledger.
 */
export class MarketplaceMcpInstallAttestationStore {
	private attestations: PersistedMarketplaceMcpInstallAttestation[] = [];
	readonly ledgerPath: string;

	constructor(private readonly secretsDir = serverSecretsDir()) {
		this.ledgerPath = path.join(secretsDir, ATTESTATION_FILE);
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
		const fingerprint = marketplaceMcpBehaviorFingerprint(identity.config);
		return tuple.some((row) => row.fingerprint === fingerprint) ? "attested" : "changed";
	}

	isAttested(identity: MarketplaceMcpInstallIdentity): boolean {
		return this.classify(identity) === "attested";
	}

	/** Atomically replace all attestations owned by one logical project pack. */
	replacePack(
		projectId: string,
		sourceId: string,
		packName: string,
		definitions: Array<{ contributionId: string; serverName: string; config: McpServerConfig }>,
	): void {
		const attestedAt = new Date().toISOString();
		const next = this.attestations.filter((row) => !sameInstall(row, projectId, packName));
		for (const definition of definitions) {
			next.push({
				projectId,
				sourceId,
				packName,
				contributionId: definition.contributionId,
				serverName: definition.serverName,
				fingerprint: marketplaceMcpBehaviorFingerprint(definition.config),
				attestedAt,
			});
		}
		this.persist(next);
		this.attestations = next;
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
