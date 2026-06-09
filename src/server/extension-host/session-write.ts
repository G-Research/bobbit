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
// The client layers a MANDATORY user-gesture token on top (gesture-context.ts).

import { randomBytes } from "node:crypto";
import { authorizeScopedRequest, type ActionGuardSession } from "./action-guard.js";

// ── Server-validated single-use USER-GESTURE TOKEN (design §8 C2.1 / Fix 5). ──
//
// The client `consumeGesture()` flag (gesture-context.ts) is pure client-side
// defense and is BYPASSABLE: a pack renderer/panel runs in the main UI realm and
// can `fetch('/api/ext/session/message', …)` directly, never touching the client
// gate. To make "no post without a genuine user gesture" UNFORGEABLE, the gateway
// mints a cryptographically-random, single-use, short-TTL nonce (POST
// /api/ext/session/gesture) bound to the header-bound session. Trusted client code
// fetches that nonce ONLY inside `runWithUserGesture(…)` and holds it in a module
// closure that is never exposed on `window`/the `host` object — so pack code cannot
// read it. `host.session.postMessage` attaches the closure nonce; this endpoint
// REQUIRES + CONSUMES it. A same-realm pack raw-fetch of /api/ext/session/message
// therefore has no live nonce and is rejected 403 — in ADDITION to
// authorizeScopedRequest + allowedTools + audit. The nonce is NOT a v1 API
// parameter (postMessage(msg) is unchanged); it is an internal request field.

/** Process-singleton store of live, single-use gesture nonces keyed by session. */
export interface GestureNonceStore {
	/** Mint + persist a fresh single-use nonce bound to `sessionId`. */
	mint(sessionId: string): string;
	/** Validate + CONSUME (delete) a nonce. Returns true exactly once for a live,
	 *  unexpired nonce of THIS session; false if missing/expired/reused/cross-session. */
	consume(sessionId: string, nonce: string): boolean;
}

export interface GestureNonceStoreOptions {
	/** Nonce lifetime in ms (default 10s). */
	ttlMs?: number;
	/** Injectable clock (tests). Defaults to Date.now. */
	now?: () => number;
	/** Injectable nonce minter (tests). Defaults to 32 random bytes, base64url. */
	mintNonce?: () => string;
}

export function createGestureNonceStore(opts: GestureNonceStoreOptions = {}): GestureNonceStore {
	const ttlMs = opts.ttlMs ?? 10_000;
	const now = opts.now ?? Date.now;
	const mintNonce = opts.mintNonce ?? (() => randomBytes(32).toString("base64url"));
	// sessionId -> (nonce -> expiry epoch ms). Bound per session so a nonce minted
	// for one session can NEVER authorize a post into another (cross-session reject).
	const live = new Map<string, Map<string, number>>();
	const prune = (m: Map<string, number>, t: number): void => {
		for (const [n, exp] of m) if (exp <= t) m.delete(n);
	};
	return {
		mint(sessionId: string): string {
			const t = now();
			let m = live.get(sessionId);
			if (!m) { m = new Map(); live.set(sessionId, m); }
			prune(m, t);
			const nonce = mintNonce();
			m.set(nonce, t + ttlMs);
			return nonce;
		},
		consume(sessionId: string, nonce: string): boolean {
			const t = now();
			const m = live.get(sessionId);
			if (!m) return false;
			prune(m, t); // drops expired (incl. this one if stale) BEFORE the lookup
			const exp = m.get(nonce);
			if (exp === undefined) return false; // missing / expired / already consumed
			m.delete(nonce); // SINGLE-USE: consumed on first valid use
			if (m.size === 0) live.delete(sessionId);
			return exp > t;
		},
	};
}

let _gestureStore: GestureNonceStore | undefined;
/** Process-singleton gesture-nonce store (the gateway endpoints share one). */
export function getGestureNonceStore(): GestureNonceStore {
	if (!_gestureStore) _gestureStore = createGestureNonceStore();
	return _gestureStore;
}

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
	/** Untrusted body.gestureNonce — a server-minted single-use user-gesture token.
	 *  REQUIRED: the post is rejected (403) without a live, unconsumed nonce for the
	 *  header-bound session. Not a v1 API param — an internal request field. */
	gestureNonce: unknown;
	/** Validate + CONSUME (single-use) a gesture nonce for the BOUND session. Wired
	 *  to the process-singleton GestureNonceStore by the endpoint. */
	consumeGesture: (sessionId: string, nonce: string) => boolean;
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

	// 3b. REQUIRE + CONSUME a server-minted, single-use user-gesture nonce for the
	//     BOUND session (Fix 5). The client mints it ONLY inside runWithUserGesture
	//     and holds it in a closure unreachable from pack code, so a same-realm pack
	//     raw-fetch of this endpoint has no live nonce and is rejected here. Consumed
	//     (single-use) on a valid post. Validated AFTER the cheap checks so a malformed
	//     request does not burn a token.
	if (typeof input.gestureNonce !== "string" || !input.consumeGesture(guard.sessionId, input.gestureNonce)) {
		return { ok: false, status: 403, error: "missing or invalid user-gesture token" };
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
