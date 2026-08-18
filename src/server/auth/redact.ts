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

/**
 * Redact only high-confidence credentials from durable, authorized audit diffs.
 * Unlike redactSensitive(), this intentionally preserves ordinary prompt prose,
 * paths, digests, UUIDs, and dotted identifiers verbatim.
 */
export function redactAuditDiffSecrets(s: string, replacement = "[REDACTED]"): string {
	if (typeof s !== "string" || !s) return s;
	let out = s;
	// A bearer credential is explicit context. Require a token-length value so
	// prose such as "Bearer token handling" remains inspectable.
	out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}={0,2}/gi, `$1${replacement}`);
	// Explicit credential assignments retain their field name and quoting.
	out = out.replace(
		/\b((?:api[_-]?key|x-api-key|authorization|access[_-]?token|accessToken|refresh[_-]?token|client[_-]?secret|private[_-]?key|credential|password|secret|token)\s*[:=]\s*)(["']?)([^"'\s,;]{4,})\2/gi,
		`$1$2${replacement}$2`,
	);
	// Provider-issued credential formats are unambiguous even without a label.
	out = out.replace(/\b(?:sk|pk|rk)-(?:or-)?[A-Za-z0-9_-]{4,}\b/gi, replacement);
	out = out.replace(/\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9_]{8,}\b/gi, replacement);
	out = out.replace(/\bgithub_pat_[A-Za-z0-9_-]{8,}\b/gi, replacement);
	out = out.replace(/\bya29\.[A-Za-z0-9._-]{20,}\b/gi, replacement);
	// Only redact compact JWTs whose header and payload both decode as JWT JSON.
	return out.replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g, candidate =>
		isGenuineJwt(candidate) ? replacement : candidate,
	);
}

function isGenuineJwt(candidate: string): boolean {
	const [encodedHeader, encodedPayload, encodedSignature, ...rest] = candidate.split(".");
	if (!encodedHeader || !encodedPayload || !encodedSignature || rest.length > 0) return false;
	const header = decodeBase64UrlJson(encodedHeader);
	const payload = decodeBase64UrlJson(encodedPayload);
	return isJsonRecord(header) && typeof header.alg === "string" && header.alg.length > 0 && isJsonRecord(payload);
}

function decodeBase64UrlJson(segment: string): unknown {
	try {
		const decoded = Buffer.from(segment, "base64url");
		if (!decoded.length || decoded.toString("base64url") !== segment) return undefined;
		return JSON.parse(decoded.toString("utf8"));
	} catch {
		return undefined;
	}
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
