/**
 * Request identity for Bobbit's direct Anthropic Messages calls.
 *
 * OAuth protocol and refresh remain Pi-owned. These headers intentionally match
 * Pi's current Claude Code request identity; API-key requests retain Anthropic's
 * API-key identity and must not inherit the OAuth-only headers.
 */
export const PI_CLAUDE_CODE_USER_AGENT = "claude-cli/2.1.75";
export const PI_CLAUDE_CODE_BETA = "claude-code-20250219,oauth-2025-04-20";

/**
 * The fixed direct-request identity Pi currently uses for Anthropic OAuth.
 *
 * The optional identity argument on {@link createAnthropicDirectHeaders} is a
 * narrow test seam for controlled, mocked factor matrices. Production callers
 * omit it and always use this exact Pi default; it is not OAuth configuration.
 */
export interface AnthropicDirectRequestIdentity {
	readonly beta: string;
	readonly userAgent: string;
	readonly app: string;
}

export const PI_ANTHROPIC_DIRECT_REQUEST_IDENTITY: AnthropicDirectRequestIdentity = Object.freeze({
	beta: PI_CLAUDE_CODE_BETA,
	userAgent: PI_CLAUDE_CODE_USER_AGENT,
	app: "cli",
});

export interface AnthropicDirectCredentials {
	type: "oauth" | "api-key";
	access: string;
}

export function createAnthropicDirectHeaders(
	auth: AnthropicDirectCredentials,
	identity: AnthropicDirectRequestIdentity = PI_ANTHROPIC_DIRECT_REQUEST_IDENTITY,
): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"anthropic-version": "2023-06-01",
	};

	if (auth.type === "oauth") {
		headers.Authorization = `Bearer ${auth.access}`;
		headers["anthropic-beta"] = identity.beta;
		headers["user-agent"] = identity.userAgent;
		headers["x-app"] = identity.app;
	} else {
		headers["x-api-key"] = auth.access;
	}

	return headers;
}
