import { redactSensitive } from "../auth/redact.js";

/** The sole provider-facing category that may cross an SDK runtime boundary. */
export const SDK_SESSION_UNAVAILABLE = "SDK_SESSION_UNAVAILABLE";

const diagnostics = new WeakMap<ClaudeAgentSdkUnavailableError, string>();

/**
 * Public SDK failures intentionally contain no provider-controlled detail.
 * Retain only a bounded, redacted diagnostic in a private module-side map for
 * server logs at the owning API boundary.
 */
export class ClaudeAgentSdkUnavailableError extends Error {
	readonly code = SDK_SESSION_UNAVAILABLE;
	constructor(diagnostic?: unknown) {
		super(SDK_SESSION_UNAVAILABLE);
		this.name = "ClaudeAgentSdkUnavailableError";
		diagnostics.set(this, sanitizeClaudeAgentSdkErrorForLog(diagnostic));
	}
}

export function isClaudeAgentSdkUnavailableError(error: unknown): error is ClaudeAgentSdkUnavailableError {
	return error instanceof ClaudeAgentSdkUnavailableError;
}

export function normalizeClaudeAgentSdkUnavailableError(error?: unknown): ClaudeAgentSdkUnavailableError {
	return error instanceof ClaudeAgentSdkUnavailableError ? error : new ClaudeAgentSdkUnavailableError(error);
}

/** Safe, bounded diagnostic text for server logs only. */
export function sanitizeClaudeAgentSdkErrorForLog(error: unknown, maxLength = 1_000): string {
	const raw = error instanceof Error ? (error.stack || error.message) : String(error ?? "");
	return redactClaudeCredentialPaths(redactSensitive(raw)).slice(0, maxLength);
}

export function claudeAgentSdkUnavailableDiagnostic(error: unknown): string {
	return error instanceof ClaudeAgentSdkUnavailableError
		? diagnostics.get(error) || SDK_SESSION_UNAVAILABLE
		: sanitizeClaudeAgentSdkErrorForLog(error);
}

/** Stable HTTP/event payload: never spread an Error or upstream diagnostic. */
export function claudeAgentSdkUnavailablePayload(): { error: typeof SDK_SESSION_UNAVAILABLE; code: typeof SDK_SESSION_UNAVAILABLE } {
	return { error: SDK_SESSION_UNAVAILABLE, code: SDK_SESSION_UNAVAILABLE };
}

function redactClaudeCredentialPaths(value: string): string {
	// Provider errors commonly echo the config or credential file they attempted
	// to load. Only redact path-shaped Claude/config credential locations, not
	// arbitrary paths needed to diagnose the caller's own request.
	return value.replace(
		/(?:[A-Za-z]:[\\/][^\s"'`]*|\/[^\s"'`]*|~\/[^\s"'`]*)[\\/](?:\.claude(?:[\\/][^\s"'`]*)?|\.claude\.json|claude\.json|credentials\.json)\b/gi,
		"<redacted-claude-config-path>",
	);
}
