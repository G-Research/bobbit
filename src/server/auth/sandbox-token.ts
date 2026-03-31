import crypto from "node:crypto";

export interface SandboxScope {
	sessionId: string;
	goalId?: string;
	childSessionIds: Set<string>;
}

/**
 * In-memory store mapping sandbox tokens to their scoped session information.
 *
 * Each sandboxed session gets a unique 256-bit random token that restricts
 * API access to only the endpoints that session needs. Tokens are NOT
 * persisted — they are regenerated on server restart during session restore
 * (applySandboxWiring calls register() which is idempotent).
 */
export class SandboxTokenStore {
	private tokens = new Map<string, SandboxScope>();
	private sessionToToken = new Map<string, string>();

	/** Generate a new sandbox token and register it for the given session. Idempotent. */
	register(sessionId: string, goalId?: string): string {
		const existing = this.sessionToToken.get(sessionId);
		if (existing) return existing;

		const token = crypto.randomBytes(32).toString("hex");
		this.tokens.set(token, { sessionId, goalId, childSessionIds: new Set() });
		this.sessionToToken.set(sessionId, token);
		return token;
	}

	/** Look up scope for a token. Returns undefined if not a sandbox token. */
	lookup(token: string): SandboxScope | undefined {
		return this.tokens.get(token);
	}

	/** Register a delegate child session under the parent's scope. */
	addChild(parentSessionId: string, childSessionId: string): void {
		const token = this.sessionToToken.get(parentSessionId);
		if (!token) return;
		const scope = this.tokens.get(token);
		if (scope) scope.childSessionIds.add(childSessionId);
	}

	/** Remove a session's token on termination. */
	remove(sessionId: string): void {
		const token = this.sessionToToken.get(sessionId);
		if (!token) return;
		this.tokens.delete(token);
		this.sessionToToken.delete(sessionId);
	}

	/** Reverse lookup: get the scoped token for a session ID. */
	getTokenForSession(sessionId: string): string | undefined {
		return this.sessionToToken.get(sessionId);
	}
}
