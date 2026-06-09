// src/server/extension-host/session-write.ts
//
// The PURE handler for the C2 session-WRITE endpoint
// (POST /api/ext/session/message; design docs/design/extension-host-phase2.md §8
// C2.1). Factored out of server.ts — exactly like `action-guard.ts` — so the
// whole authorize → validate → post → audit sequence is unit-testable without a
// live gateway: the endpoint supplies real resolvers/poster/auditor; tests supply
// stubs.
//
// `session.postMessage` DRIVES the agent, so it is the HIGHEST-RISK Host-API
// addition. Its security posture (design §8 / §15):
//   - authorizeScopedRequest (NOT authorizeActionRequest): header-canonical
//     session + body===header + session resolves + pack's `tool` ∈ allowedTools.
//     Driving a turn acts on NO specific prior tool call, so toolUseId-ownership
//     is the wrong check and `toolUseId` is NOT required — this is what lets a
//     panel/entrypoint (which binds toolUseId:undefined) post.
//   - server-derived packId (reject a non-pack caller) — never caller-supplied.
//   - the target session is ALWAYS the header-bound session, NEVER a body param,
//     so cross-session posting is structurally impossible.
//   - every post/resume is AUDITED ({tool, packId, sessionId, role, resumeTurn,
//     ms}) — mandatory.
// The client layers a MANDATORY real user-activation check on top
// (navigator.userActivation, gesture-context.ts) AND attaches the unforgeable
// per-session secret this handler verifies (below).

import { authorizeScopedRequest, type ActionGuardSession } from "./action-guard.js";

// ── UNFORGEABLE per-session SECRET (design §8 C2.1 / Fix A). ──
//
// The client `navigator.userActivation` check (gesture-context.ts) blocks a post
// on mount, but it is a CLIENT concept the server cannot see — and a same-realm
// pack renderer/panel can `fetch('/api/ext/session/message', …)` directly during
// its own button click (user-activation IS active then), so user-activation alone
// does not stop a malicious pack raw-fetch. To make "only trusted UI may drive the
// agent" UNFORGEABLE, this endpoint additionally REQUIRES the trusted-only
// `x-bobbit-session-secret` header: the per-session capability secret
// (SessionSecretStore) delivered to trusted UI over the authenticated app
// connection and held in a client module closure that is never on `window`/the
// `host` object. Pack code cannot obtain it (it shares ambient creds — bearer
// token, cookies — but not trusted closure state), so a raw pack fetch carries no
// valid secret and is rejected 403. The secret is NOT a v1 API parameter
// (postMessage(msg) is unchanged); it is an internal request header the trusted
// client attaches.

/** Pack identity as resolved SERVER-SIDE from the winning contribution. */
export interface SessionPostPackIdentity {
	isPack: boolean;
	packId: string;
}

/** Audit record emitted for EVERY post/resume (design §8 C2.1 step 4). */
export interface SessionPostAudit {
	tool: string;
	packId: string;
	sessionId: string;
	role: "user" | "system";
	resumeTurn: boolean;
	ms: number;
	outcome: "ok" | "error";
	error?: string;
}

export interface SessionPostInput {
	/** The pack's contributing tool name (proves pack ownership via allowedTools). */
	tool: string;
	/** Raw x-bobbit-session-id header value. */
	headerSessionId: string | string[] | undefined;
	/** Untrusted body.sessionId — accepted only to fail fast on a header mismatch. */
	bodySessionId: unknown;
	/** Untrusted body.role — must be "user" | "system". */
	role: unknown;
	/** Untrusted body.text — must be a non-empty string. */
	text: unknown;
	/** Untrusted body.resumeTurn — defaults to true (resume the agent turn). */
	resumeTurn?: unknown;
	/** The trusted-only `x-bobbit-session-secret` header (Fix A). REQUIRED: the post
	 *  is rejected (403) unless this resolves to the SAME header-bound session. Pack
	 *  code cannot obtain it (held in trusted client closure state, not window/host),
	 *  so a raw pack fetch is rejected. Not a v1 API param — an internal header. */
	sessionSecret: unknown;
	/** Resolve the AUTHENTIC session id that owns a capability secret (or undefined).
	 *  Wired to `sessionManager.sessionSecretStore.resolveSessionIdBySecret` by the
	 *  endpoint. A miss MUST deny — never "skip the check". */
	resolveSecretSession: (secret: string) => string | undefined;
	/** Resolve a session (live or persisted) by id; undefined when not found. */
	resolveSession: (id: string) => ActionGuardSession | undefined;
	/** SERVER-derive the pack identity from the proven `tool` (never caller input). */
	resolvePackIdentity: (tool: string) => SessionPostPackIdentity;
	/**
	 * Post into the HEADER-BOUND session. `resume === true` resumes the agent turn
	 * (enqueuePrompt path); `resume === false` delivers without resuming
	 * (deliverLiveSteer / non-resuming append). The target session id is supplied
	 * by the handler (the verified header-bound session) — there is NO other-session
	 * parameter, so cross-session posting is impossible.
	 */
	post: (sessionId: string, text: string, opts: { role: "user" | "system"; resume: boolean }) => Promise<void>;
	/** Audit sink — invoked for EVERY post/resume (success AND failure). */
	audit: (record: SessionPostAudit) => void;
	/** Injectable clock (tests). Defaults to Date.now. */
	now?: () => number;
}

export type SessionPostResult =
	| { ok: true }
	| { ok: false; status: number; error: string };

/**
 * Authorize, validate, post, and audit a session-write request. Pure: no I/O of
 * its own beyond the injected `post`/`audit`/`resolve*` callbacks.
 */
export async function handleSessionPost(input: SessionPostInput): Promise<SessionPostResult> {
	const clock = input.now ?? Date.now;

	// 1. Pack-scoped authorization (NO toolUseId-ownership — §2a). The header is the
	//    single canonical identity; the body sessionId is accepted only to fail fast.
	const guard = authorizeScopedRequest({
		tool: input.tool,
		headerSessionId: input.headerSessionId,
		bodySessionId: input.bodySessionId,
		resolveSession: input.resolveSession,
	});
	if (!guard.ok) return guard;

	// 2. Validate the message: role ∈ {user, system} + non-empty text.
	if (input.role !== "user" && input.role !== "system") {
		return { ok: false, status: 400, error: 'role must be "user" or "system"' };
	}
	const role: "user" | "system" = input.role;
	if (typeof input.text !== "string" || input.text.trim().length === 0) {
		return { ok: false, status: 400, error: "text must be a non-empty string" };
	}
	const text = input.text;

	// 3. SERVER-derive the pack identity from the proven `tool`; reject a non-pack
	//    caller (session messaging is a pack-only capability).
	const ident = input.resolvePackIdentity(input.tool);
	if (!ident.isPack || !ident.packId) {
		return { ok: false, status: 403, error: "session messaging is available only to market-pack tools" };
	}

	// 3b. REQUIRE the trusted-only per-session secret (Fix A). It must resolve to the
	//     SAME header-bound session. Trusted UI delivers it over the authenticated app
	//     connection and holds it in a client closure unreachable from pack code, so a
	//     same-realm pack raw-fetch of this endpoint carries no valid secret and is
	//     rejected here — making "only trusted UI may drive the agent" unforgeable.
	if (
		typeof input.sessionSecret !== "string" ||
		input.resolveSecretSession(input.sessionSecret) !== guard.sessionId
	) {
		return { ok: false, status: 403, error: "missing or invalid session secret" };
	}

	// 4. Post into the HEADER-BOUND session ONLY (never a body param → cross-session
	//    posting is impossible). resumeTurn defaults to true.
	const resume = input.resumeTurn !== false;
	const start = clock();
	const base = { tool: input.tool, packId: ident.packId, sessionId: guard.sessionId, role, resumeTurn: resume };
	try {
		await input.post(guard.sessionId, text, { role, resume });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		input.audit({ ...base, ms: clock() - start, outcome: "error", error: message });
		return { ok: false, status: 500, error: message };
	}

	// 5. AUDIT every post/resume (mandatory).
	input.audit({ ...base, ms: clock() - start, outcome: "ok" });
	return { ok: true };
}
