/** Server-owned discriminator written only by the human bypass mutation. */
export const HUMAN_BYPASS_SIGNAL_KIND = "human-bypass" as const;

interface HumanBypassSignalShape {
	id?: unknown;
	signalKind?: unknown;
	sessionId?: unknown;
	timestamp?: unknown;
	commitSha?: unknown;
	metadata?: unknown;
	verification?: unknown;
}

/**
 * Canonical trusted-human provenance check.
 *
 * New rows carry `signalKind`. Genuine rows written before that discriminator
 * existed are accepted only through the exact synthetic shape produced by the
 * server-owned bypass mutation. Normal gate signals cannot choose their ID,
 * verification result, or session identity.
 */
export function isHumanBypassSignal(signal: HumanBypassSignalShape | null | undefined): boolean {
	if (!signal || (signal.signalKind !== undefined && signal.signalKind !== "human-bypass")) return false;
	if (typeof signal.id !== "string" || !signal.id.startsWith("bypass-") || signal.id.length <= "bypass-".length) return false;
	if (signal.sessionId !== "human-bypass" || signal.commitSha !== "" || !Number.isFinite(signal.timestamp)) return false;
	const metadata = signal.metadata;
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
	const audit = metadata as Record<string, unknown>;
	if (audit.bypass !== "true"
		|| typeof audit.whyBypassed !== "string" || audit.whyBypassed.trim().length === 0
		|| typeof audit.whoAmI !== "string" || audit.whoAmI.trim().length === 0
		|| typeof audit.bypassedAt !== "string" || Number(audit.bypassedAt) !== signal.timestamp) return false;
	const verification = signal.verification;
	if (!verification || typeof verification !== "object" || Array.isArray(verification)) return false;
	const result = verification as { status?: unknown; steps?: unknown };
	return result.status === "passed" && Array.isArray(result.steps) && result.steps.length === 0;
}

/** The exact predicate injected into eval workers, avoiding a second classifier. */
export const HUMAN_BYPASS_SIGNAL_PREDICATE_SOURCE = `(${isHumanBypassSignal.toString()})`;

const RESERVED_HUMAN_BYPASS_METADATA_KEYS = new Set([
	"bypass",
	"whyBypassed",
	"whoAmI",
	"bypassedAt",
	"bypassTruncated",
	"whyBypassedTruncated",
	"whoAmITruncated",
	"bypassedAtTruncated",
]);

/** Return the first server-owned bypass audit key supplied by an ordinary signal. */
export function findReservedHumanBypassMetadataKey(metadata: unknown): string | undefined {
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
	return Object.keys(metadata).find(key => RESERVED_HUMAN_BYPASS_METADATA_KEYS.has(key));
}
