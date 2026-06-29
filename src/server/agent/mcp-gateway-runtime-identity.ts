import { createHash } from "node:crypto";
import type { PackEntry } from "./pack-types.js";

function safeString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function safeMcpRuntimeSegment(value: unknown, fallback: string): string {
	const raw = safeString(value) ?? fallback;
	const safe = raw.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
	return safe || fallback;
}

export function gatewayMcpRuntimeKey(entry: PackEntry, mcp: { listName?: string; serverName: string; subNamespace?: string }, metaDetails: Record<string, unknown>): string {
	const fingerprint = safeString(entry.meta?.commit) ?? safeString(metaDetails.gatewayFingerprint) ?? "unknown";
	const sourceIdentity = safeString(metaDetails.sourceId) ?? safeString(entry.meta?.sourceUrl) ?? safeString(metaDetails.sourceUrl) ?? "unknown-source";
	const installedPackName = entry.manifest?.name ?? entry.meta?.packName ?? "unknown-pack";
	const identityHash = createHash("sha256").update(JSON.stringify({
		sourceIdentity,
		installedPackName,
		gatewayProviderId: safeString(metaDetails.gatewayProviderId) ?? mcp.subNamespace,
		listName: mcp.listName,
		serverName: mcp.serverName,
		subNamespace: mcp.subNamespace,
	})).digest("hex").slice(0, 12);
	const fingerprintHash = createHash("sha256").update(fingerprint).digest("hex").slice(0, 12);
	return `gateway_${safeMcpRuntimeSegment(mcp.serverName, "server")}_${safeMcpRuntimeSegment(mcp.subNamespace, "default")}_${safeMcpRuntimeSegment(sourceIdentity, "source")}_${identityHash}_${fingerprintHash}`;
}
