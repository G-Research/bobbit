/**
 * Mask provider tokens in free-form log/error strings. Best-effort: redact
 * aggressively rather than risk leaking access/refresh tokens via stderr/UI.
 */
export function redactSensitive(s: string): string {
	if (typeof s !== "string" || !s) return s;
	let out = s;
	// JWT-ish: aaa.bbb.ccc with base64url segments.
	out = out.replace(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "<redacted-jwt>");
	// Long bearer-shaped tokens (32+ url-safe chars).
	out = out.replace(/[A-Za-z0-9_-]{32,}/g, "<redacted-token>");
	return out;
}
