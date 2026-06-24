/**
 * Mask provider tokens in free-form log/error strings. Best-effort: redact
 * aggressively rather than risk leaking access/refresh tokens via stderr/UI.
 */
export function redactSensitive(s: string): string {
	if (typeof s !== "string" || !s) return s;
	let out = s;
	// Authorization/Bearer headers can contain opaque tokens with punctuation.
	out = out.replace(/\b(Bearer\s+)[^\s"',;]+/gi, "$1<redacted-token>");
	// Common API-key/token assignment forms in provider error bodies.
	out = out.replace(
		/\b((?:api[_-]?key|x-api-key|authorization|access[_-]?token|refresh[_-]?token|secret|token)\s*[:=]\s*)(["']?)([^"'\s,;]{4,})\2/gi,
		"$1$2<redacted-token>$2",
	);
	// Known API-key prefixes that are often shorter than generic bearer tokens.
	out = out.replace(/\b(?:sk|pk|rk)-(?:or-)?[A-Za-z0-9_-]{4,}\b/gi, "<redacted-api-key>");
	out = out.replace(/\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9_]{8,}\b/gi, "<redacted-token>");
	out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{8,}\b/gi, "<redacted-token>");
	out = out.replace(/\bya29\.[A-Za-z0-9._-]{20,}\b/gi, "<redacted-token>");
	// JWT-ish: aaa.bbb.ccc with base64url segments.
	out = out.replace(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "<redacted-jwt>");
	// Long bearer-shaped tokens (32+ url-safe chars).
	out = out.replace(/[A-Za-z0-9_-]{32,}/g, "<redacted-token>");
	return out;
}
