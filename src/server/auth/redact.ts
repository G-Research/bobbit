/**
 * Mask provider tokens in free-form log/error strings. Best-effort: redact
 * aggressively rather than risk leaking access/refresh tokens via stderr/UI.
 */
export function redactSensitive(s: string, replacement?: string): string {
	if (typeof s !== "string" || !s) return s;
	const token = replacement ?? "<redacted-token>";
	const apiKey = replacement ?? "<redacted-api-key>";
	const jwt = replacement ?? "<redacted-jwt>";
	let out = s;
	// Authorization/Bearer headers can contain opaque tokens with punctuation.
	out = out.replace(/\b(Bearer\s+)[^\s"',;]+/gi, `$1${token}`);
	// Common API-key/token assignment forms in provider error bodies.
	out = out.replace(
		/\b((?:api[_-]?key|x-api-key|authorization|access[_-]?token|accessToken|refresh[_-]?token|client[_-]?secret|private[_-]?key|credential|password|secret|token)\s*[:=]\s*)(["']?)([^"'\s,;]{4,})\2/gi,
		`$1$2${token}$2`,
	);
	// Known API-key prefixes that are often shorter than generic bearer tokens.
	out = out.replace(/\b(?:sk|pk|rk)-(?:or-)?[A-Za-z0-9_-]{4,}\b/gi, apiKey);
	out = out.replace(/\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9_]{8,}\b/gi, token);
	out = out.replace(/\bgithub_pat_[A-Za-z0-9_-]{8,}\b/gi, token);
	out = out.replace(/\bya29\.[A-Za-z0-9._-]{20,}\b/gi, token);
	// JWT-ish: aaa.bbb.ccc with base64url segments.
	out = out.replace(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, jwt);
	// Long bearer-shaped tokens (32+ url-safe chars).
	out = out.replace(/[A-Za-z0-9_-]{32,}/g, token);
	return out;
}
