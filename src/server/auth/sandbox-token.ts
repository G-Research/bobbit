import crypto from "node:crypto";

export interface SandboxScope {
	projectId: string;
	goalIds: Set<string>;
	sessionIds: Set<string>;
}

/**
 * In-memory store mapping sandbox tokens to their scoped project information.
 *
 * Each sandboxed project gets a unique 256-bit random token that restricts
 * API access to only the endpoints that project's sessions need. Tokens are NOT
 * persisted — they are regenerated on server restart during session restore.
 *
 * SECURITY: Tokens are stored in-memory ONLY (Map). They are never persisted
 * to disk — not in sessions.json, not in any state file. This is by design:
 * tokens are regenerated on server restart during session restore. If a
 * container is compromised, the token cannot be extracted from disk.
 */
export class SandboxTokenStore {
	private tokens = new Map<string, SandboxScope>();
	private projectToToken = new Map<string, string>();

	/** Generate or return the sandbox token for a project. Idempotent. */
	register(projectId: string): string {
		const existing = this.projectToToken.get(projectId);
		if (existing) return existing;

		const token = crypto.randomBytes(32).toString("hex");
		this.tokens.set(token, { projectId, goalIds: new Set(), sessionIds: new Set() });
		this.projectToToken.set(projectId, token);
		return token;
	}

	/** Look up scope for a token. Returns undefined if not a sandbox token. */
	lookup(token: string): SandboxScope | undefined {
		return this.tokens.get(token);
	}

	/** Track a session under the project's scope. */
	addSession(projectId: string, sessionId: string): void {
		const token = this.projectToToken.get(projectId);
		if (!token) return;
		const scope = this.tokens.get(token);
		if (scope) scope.sessionIds.add(sessionId);
	}

	/** Track a goal under the project's scope. */
	addGoal(projectId: string, goalId: string): void {
		const token = this.projectToToken.get(projectId);
		if (!token) return;
		const scope = this.tokens.get(token);
		if (scope) scope.goalIds.add(goalId);
	}

	/** Remove a session from the project's scope. */
	removeSession(projectId: string, sessionId: string): void {
		const token = this.projectToToken.get(projectId);
		if (!token) return;
		const scope = this.tokens.get(token);
		if (scope) scope.sessionIds.delete(sessionId);
	}

	/** Remove a goal from the project's scope. */
	removeGoal(projectId: string, goalId: string): void {
		const token = this.projectToToken.get(projectId);
		if (!token) return;
		const scope = this.tokens.get(token);
		if (scope) scope.goalIds.delete(goalId);
	}

	/** Remove an entire project scope and its token. */
	remove(projectId: string): void {
		const token = this.projectToToken.get(projectId);
		if (!token) return;
		this.tokens.delete(token);
		this.projectToToken.delete(projectId);
	}

	/** Reverse lookup: get the scoped token for a project ID. */
	getTokenForProject(projectId: string): string | undefined {
		return this.projectToToken.get(projectId);
	}
}
