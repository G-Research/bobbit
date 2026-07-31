/**
 * Request identity for Bobbit's direct Anthropic Messages calls.
 *
 * OAuth protocol and refresh remain Pi-owned. These headers intentionally match
 * Pi's current Claude Code request identity; API-key requests retain Anthropic's
 * API-key identity and must not inherit the OAuth-only headers.
 */
export const PI_CLAUDE_CODE_USER_AGENT = "claude-cli/2.1.75";
export const PI_CLAUDE_CODE_BETA = "claude-code-20250219,oauth-2025-04-20";

export interface AnthropicDirectCredentials {
	type: "oauth" | "api-key";
	access: string;
}

export function createAnthropicDirectHeaders(auth: AnthropicDirectCredentials): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"anthropic-version": "2023-06-01",
	};

	if (auth.type === "oauth") {
		headers.Authorization = `Bearer ${auth.access}`;
		headers["anthropic-beta"] = PI_CLAUDE_CODE_BETA;
		headers["user-agent"] = PI_CLAUDE_CODE_USER_AGENT;
		headers["x-app"] = "cli";
	} else {
		headers["x-api-key"] = auth.access;
	}

	return headers;
}
