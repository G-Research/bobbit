/**
 * Redaction helpers for AgentMemory save/observe payloads.
 *
 * Goals:
 * - Strip bearer tokens, API-key-looking assignments, .env-style secret
 *   assignments, Bobbit gateway tokens, and long base64-ish blobs.
 * - Cap field and total payload length so we never ship multi-megabyte
 *   transcripts to a memory backend.
 *
 * Redaction is best-effort, never the only line of defense — callers
 * MUST also avoid passing raw transcripts or tool stdout/stderr.
 */

export const MAX_FIELD_CHARS = 8 * 1024;        // single string field cap
export const MAX_TOTAL_CHARS = 32 * 1024;       // whole payload cap (post-redaction)

const REDACTED = "[REDACTED]";

/** Regexes applied to free-form strings. Order matters: longer/more specific first. */
const PATTERNS: { re: RegExp; replace: string }[] = [
	// Authorization: Bearer <token>
	{ re: /(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._\-+/=]{12,}/gi, replace: `$1${REDACTED}` },
	// Bearer <token> in free text
	{ re: /\bbearer\s+[A-Za-z0-9._\-+/=]{20,}\b/gi, replace: `bearer ${REDACTED}` },
	// Generic provider API key prefixes (sk-..., ghp_..., xoxb-..., AKIA..., google AIza...).
	{ re: /\bsk-[A-Za-z0-9_\-]{16,}\b/g, replace: REDACTED },
	{ re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, replace: REDACTED },
	{ re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replace: REDACTED },
	{ re: /\bAKIA[0-9A-Z]{16}\b/g, replace: REDACTED },
	{ re: /\bAIza[0-9A-Za-z_\-]{30,}\b/g, replace: REDACTED },
	// JWT (three dot-separated base64url segments)
	{ re: /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/g, replace: REDACTED },
	// .env style assignments: NAME=value where NAME looks secret-ish.
	{
		re: /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|API|CREDENTIAL|PRIVATE)[A-Z0-9_]*)\s*[:=]\s*("[^"\n]+"|'[^'\n]+'|[^\s"',;]+)/g,
		replace: `$1=${REDACTED}`,
	},
	// JSON-style "name": "value" for secret-looking keys.
	{
		re: /("(?:[A-Za-z0-9_\-]*(?:key|token|secret|password|passwd|credential|private)[A-Za-z0-9_\-]*)"\s*:\s*)"[^"\\\n]{4,}"/gi,
		replace: `$1"${REDACTED}"`,
	},
	// Long base64-ish blobs (likely keys / tokens / binaries).
	{ re: /\b[A-Za-z0-9+/]{80,}={0,2}\b/g, replace: REDACTED },
];

/** Redact secret-looking patterns from a string. */
export function redactString(input: string): string {
	if (!input) return input;
	let out = input;
	for (const { re, replace } of PATTERNS) {
		out = out.replace(re, replace);
	}
	return out;
}

/** Truncate a string to a max length with an ellipsis marker. */
export function truncateString(input: string, max: number = MAX_FIELD_CHARS): string {
	if (input.length <= max) return input;
	return input.slice(0, Math.max(0, max - 12)) + "…[truncated]";
}

/** Recursively redact + truncate a JSON-able value. Returns a cleaned clone. */
export function redactValue(value: unknown, depth = 0): unknown {
	if (depth > 8) return REDACTED;
	if (value == null) return value;
	if (typeof value === "string") return truncateString(redactString(value));
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) {
		// Cap array length to avoid blowing payload budget on huge arrays.
		const capped = value.slice(0, 100);
		return capped.map((v) => redactValue(v, depth + 1));
	}
	if (typeof value === "object") {
		const out: Record<string, unknown> = {};
		let i = 0;
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (i++ > 100) break;
			// Redact secret-shaped keys outright.
			if (/^(authorization|bearer|password|passwd|secret|.*token|.*api[_\-]?key|.*credential)$/i.test(k)) {
				out[k] = REDACTED;
				continue;
			}
			out[k] = redactValue(v, depth + 1);
		}
		return out;
	}
	return REDACTED;
}

/** Cap a stringified payload to MAX_TOTAL_CHARS. Returns the (possibly truncated) JSON string. */
export function capPayloadJson(value: unknown): string {
	const json = JSON.stringify(value);
	if (json.length <= MAX_TOTAL_CHARS) return json;
	// Defensive: re-truncate the JSON literal. Callers should already have
	// truncated big string fields via redactValue; this is a last-resort cap.
	return json.slice(0, MAX_TOTAL_CHARS - 12) + '"[truncated]"';
}

/** Convenience: full redact pipeline for a capture/save payload. */
export function redactPayload<T>(value: T): T {
	return redactValue(value) as T;
}
