import crypto from "node:crypto";

/**
 * S1 — per-session CAPABILITY secret store (server-only).
 *
 * Why this exists
 * ---------------
 * Orchestration Children authz used to compare the client-supplied
 * `X-Bobbit-Spawning-Session` header to the goal's `teamLeadSessionId`. That
 * session id is PUBLIC (any token holder could read another goal's team-lead id
 * via `GET /api/goals/:id/team` or session metadata) and the header is not
 * bound to the caller — so any token-holding agent could forge it and drive
 * team-lead-only orchestration on any goal.
 *
 * This store closes that hole. Each session gets a crypto-random secret. The
 * owning session's process — and ONLY that process — receives the secret in its
 * env as `BOBBIT_SESSION_SECRET` (injected exactly where `BOBBIT_SESSION_ID` is:
 * the bridge spawn env for local sessions, and `docker exec -e` for sandboxed
 * sessions; never on the pool container's PID 1, so it can't leak via
 * `/proc/1/environ`). The `children` extension sends the secret as
 * `X-Bobbit-Session-Secret`; the server resolves it back to the AUTHENTIC
 * caller session id and compares THAT to the team-lead — the public header is
 * never trusted for authz.
 *
 * CONFIDENTIALITY — why agents can't read another session's secret
 * ----------------------------------------------------------------
 * The map is held IN MEMORY ONLY and is never written to disk. It mirrors
 * `SandboxTokenStore` exactly (see `sandbox-token.ts`): nothing is persisted, so
 * there is zero disk surface an agent sandbox could mount and read. Critically,
 * the gateway never bind-mounts the `.bobbit/state` root into agent containers —
 * only specific subdirectories (`sessions/`, `tool-guard/`, `html-snapshots/` —
 * see `docker-args.ts`), and `sessions.json` lives at the state ROOT and is also
 * never mounted. Storing the secret on disk (even in `sessions.json`) was
 * therefore unnecessary; keeping it purely in-memory is strictly safer.
 *
 * RESTART-SAFE
 * ------------
 * On gateway restart the agent child processes die and are re-spawned during
 * session restore, which runs the SAME injection path — a fresh secret is
 * generated and handed to the restarted process while this store records the
 * matching entry. So orchestration authz keeps working across restarts even
 * though the secret value rotates (the value is a capability, not an identity —
 * only the live mapping matters).
 *
 * RESIDUAL RISK (documented, accepted)
 * ------------------------------------
 * Sessions of the same project share a pre-warmed pool container. The secret is
 * injected per-process via `docker exec -e`, so it is not visible on PID 1, but
 * a co-resident session running as the same uid could read another exec'd
 * process's `/proc/<pid>/environ`. This is identical to the existing threat
 * model for the per-project scoped sandbox token (also injected via
 * `docker exec -e`) — full isolation would require per-session containers, which
 * is out of scope here. Even so, the secret is a strict improvement: it makes
 * the public session-id header non-forgeable for the cross-goal attacker who is
 * NOT co-resident in the victim's container.
 */
export class SessionSecretStore {
	private sessionToSecret = new Map<string, string>();
	private secretToSession = new Map<string, string>();

	/** Generate (or return the existing) secret for a session. Idempotent. */
	getOrCreateSecret(sessionId: string): string {
		const existing = this.sessionToSecret.get(sessionId);
		if (existing) return existing;
		const secret = crypto.randomBytes(32).toString("hex");
		this.sessionToSecret.set(sessionId, secret);
		this.secretToSession.set(secret, sessionId);
		return secret;
	}

	/**
	 * Resolve the AUTHENTIC session id that owns a secret. Returns `undefined`
	 * for a missing/blank/unknown secret — the caller MUST treat that as "deny"
	 * (an unforgeable-credential miss), never as "skip the check".
	 */
	resolveSessionIdBySecret(secret: string | null | undefined): string | undefined {
		if (typeof secret !== "string") return undefined;
		const s = secret.trim();
		if (!s) return undefined;
		return this.secretToSession.get(s);
	}

	/** Drop a session's secret (call on session removal/cleanup). */
	remove(sessionId: string): void {
		const secret = this.sessionToSecret.get(sessionId);
		if (secret) this.secretToSession.delete(secret);
		this.sessionToSecret.delete(sessionId);
	}
}
