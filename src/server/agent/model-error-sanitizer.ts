import { redactSensitive } from "../auth/redact.js";

/**
 * Sanitize provider/model setup errors before they reach logs, transcripts, or
 * client-visible session state. Provider SDKs sometimes echo Authorization
 * headers, API-key values, or bearer tokens in their thrown messages.
 */
export function sanitizeModelErrorText(value: unknown, maxLength = 1000): string {
	const raw = value instanceof Error ? value.message : String(value ?? "");
	return redactSensitive(raw).slice(0, maxLength);
}

/** Same as sanitizeModelErrorText, but keeps a redacted stack when available. */
export function sanitizeModelErrorForLog(value: unknown, maxLength = 4000): string {
	const raw = value instanceof Error ? (value.stack || value.message) : String(value ?? "");
	return redactSensitive(raw).slice(0, maxLength);
}
