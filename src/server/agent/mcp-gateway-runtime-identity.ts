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

function stableGatewayContributionId(fields: Record<string, unknown>): string {
	return `mcp:${createHash("sha256").update(JSON.stringify(fields)).digest("hex").slice(0, 16)}`;
}

function gatewaySourceActivationIdentity(entry: PackEntry, metaDetails: Record<string, unknown>, fallbackSourceId?: string): string {
	// Activation state is user preference, not a cache/runtime connection key. Prefer
	// the persisted source id because it survives URL metadata refreshes; only fall
	// back to URL when older/hand-authored gateway metadata lacks a source id.
	return safeString(metaDetails.sourceId)
		?? safeString(fallbackSourceId)
		?? safeString(entry.meta?.sourceUrl)
		?? safeString(metaDetails.sourceUrl)
		?? "unknown-source";
}

export function gatewayMcpActivationContributionId(
	entry: PackEntry,
	mcp: { listName?: string; serverName: string; subNamespace?: string },
	metaDetails: Record<string, unknown>,
	fallbackSourceId?: string,
): string {
	return stableGatewayContributionId({
		sourceIdentity: gatewaySourceActivationIdentity(entry, metaDetails, fallbackSourceId),
		installedPackName: entry.manifest?.name ?? entry.meta?.packName,
		gatewayProviderId: safeString(metaDetails.gatewayProviderId) ?? mcp.subNamespace,
		listName: mcp.listName,
		serverName: mcp.serverName,
		subNamespace: mcp.subNamespace,
	});
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
