// src/server/extension-host/session-write.ts
//
// The PURE handler for the C2 session-WRITE capability (`host.session.postMessage`;
// design docs/design/extension-host-phase2.md §8 C2.1). Factored out of the WS
// handler — exactly like `action-guard.ts` — so the whole authorize → validate →
// post → audit sequence is unit-testable without a live gateway: the WS handler
// supplies real resolvers/poster/auditor; tests supply stubs.
//
// `session.postMessage` DRIVES the agent, so it is the HIGHEST-RISK Host-API
// addition.
//
// ── TRANSPORT: the trusted session WebSocket, NOT a fetch. ──
//
// THREAT (resolved here): a pack renderer/panel runs in the MAIN UI realm. It
// shares the app's ambient credentials (bearer token, cookies) and can monkey-
// patch `window.fetch`. An earlier design carried an unforgeable per-session
// `x-bobbit-session-secret` on a `fetch` to a `/api/ext/session/message` endpoint;
// but a same-realm pack could monkey-patch `fetch`, CAPTURE that header during one
// legitimate user-gesture post, then REPLAY it without a gesture — exfiltrating the
// secret and driving the agent at will.
//
// RESOLUTION: the SEND now rides the app's already-authenticated session
// WebSocket. The WS object is private to the client `RemoteAgent` — pack code has
// no handle to it and cannot send on it (and cannot import the trusted client
// transport module: pack renderers/panels are Blob-URL modules that cannot resolve
// app modules; the `host` object is their only surface). So there is NO session
// secret on any `fetch` for pack code to capture/replay, and no fetch path to the
// post capability at all. The TARGET session is the WS connection's OWN
// server-authenticated session — never a caller parameter — so cross-session
// posting is structurally impossible. This handler therefore takes a TRUSTED,
// server-authenticated `sessionId` (resolved by the WS handler from the
// authenticated connection), not a header/body pair plus a secret.
//
// The client still layers a MANDATORY real user-activation check on top
// (navigator.userActivation, gesture-context.ts) as defense-in-depth — no
// mount-time posts. The server-side gates that remain unforgeable regardless of the
// client are: the pack's `tool` ∈ the session's allowedTools, a SERVER-derived
// packId (reject a non-pack caller), and an AUDIT of every post/resume.

import { authorizeScopedRequest, type ActionGuardSession } from "./action-guard.js";
import { computeContentHash, type WritePermitBinding } from "./session-write-permit.js";

/** Pack identity as resolved SERVER-SIDE from the winning contribution. */
export interface SessionPostPackIdentity {
	isPack: boolean;
	packId: string;
}

/**
 * Role-aware delivery shaping (design §8 C2.1 — "honor PostMessageInput.role").
 *
 * The frozen contract `PostMessageInput { role: "user" | "system" }` requires BOTH
 * roles to work, and a "system" message must NOT be silently delivered as raw user
 * input. Bobbit's runtime feeds the model via two seams (a user prompt / a steer);
 * there is no separate model-level system-role command. So a genuine SYSTEM message
 * is injected by framing the content in an explicit `<system-reminder>` envelope —
 * the model unambiguously perceives it as an out-of-band system directive rather
 * than user free-text — while a "user" message is delivered verbatim.
 *
 * The framing is applied to the DELIVERED text only; the permit's contentHash and
 * the audit record bind/record the ORIGINAL role+text (what the client hashed).
 */
const SYSTEM_REMINDER_OPEN = "<system-reminder>";
const SYSTEM_REMINDER_CLOSE = "</system-reminder>";

export function formatSessionMessage(role: "user" | "system", text: string): string {
	if (role === "system") return `${SYSTEM_REMINDER_OPEN}\n${text}\n${SYSTEM_REMINDER_CLOSE}`;
	return text;
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
	/**
	 * The TRUSTED, server-authenticated bound session id. This is the WS
	 * connection's OWN session, resolved server-side from the authenticated
	 * connection — NEVER a caller-supplied header/body value. Because pack code
	 * cannot send on the trusted WS, this id is not caller-influenced, and the post
	 * always targets it, so cross-session posting is structurally impossible.
	 */
	sessionId: string;
	/** Untrusted body.role — must be "user" | "system". */
	role: unknown;
	/** Untrusted body.text — must be a non-empty string. */
	text: unknown;
	/** Untrusted body.resumeTurn — defaults to true (resume the agent turn). */
	resumeTurn?: unknown;
	/**
	 * Untrusted body.nonce — the SERVER-MINTED, one-time, content-bound write permit
	 * (design §8 C2.1). REQUIRED: without it (or with an invalid/expired/replayed
	 * one) the post is rejected. This closes the same-realm forge/replay vector the
	 * WS-only move left open (see session-write-permit.ts).
	 */
	nonce?: unknown;
	/** Resolve a session (live or persisted) by id; undefined when not found. Used
	 *  to gate the pack's `tool` against the session's allowedTools. */
	resolveSession: (id: string) => ActionGuardSession | undefined;
	/** SERVER-derive the pack identity from the proven `tool` (never caller input). */
	resolvePackIdentity: (tool: string) => SessionPostPackIdentity;
	/**
	 * Validate + single-use consume the write permit bound to {sessionId, packId,
	 * tool, contentHash}. Returns true ONLY for a fresh, matching, unexpired permit.
	 * Injected so the handler stays pure/unit-testable (WS handler wires the real
	 * `consumeWritePermit`; tests supply a spy).
	 */
	consumePermit: (nonce: string, binding: WritePermitBinding) => boolean;
	/**
	 * Post into the TRUSTED bound session. `resume === true` resumes the agent turn
	 * (enqueuePrompt path); `resume === false` delivers without resuming
	 * (deliverLiveSteer / non-resuming append). The target session id is supplied by
	 * the handler (the verified, server-authenticated session) — there is NO
	 * other-session parameter, so cross-session posting is impossible.
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

	// 1. Pack-scoped authorization. The session is the TRUSTED, server-authenticated
	//    WS-bound session, so the body===header invariant authorizeScopedRequest
	//    enforces holds trivially (both are the same trusted id). What this still
	//    gates is: the session resolves, and the pack's `tool` ∈ allowedTools. (No
	//    toolUseId-ownership — driving a turn acts on no specific prior tool call,
	//    and panels/entrypoints have no toolUseId. §2a / Fix B.)
	const guard = authorizeScopedRequest({
		tool: input.tool,
		headerSessionId: input.sessionId,
		bodySessionId: input.sessionId,
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

	// 3b. REQUIRE a server-minted, one-time, content-bound write permit. The
	//     contentHash is recomputed HERE from the validated role+text and bound to
	//     {sessionId, packId, tool} — so a replayed frame (permit already consumed),
	//     a forged frame (no valid nonce), or a tampered role/text (hash mismatch)
	//     are all rejected with NO post. (§8 C2.1 — session-write-permit.ts.)
	if (typeof input.nonce !== "string" || input.nonce.length === 0) {
		return { ok: false, status: 403, error: "session post requires a server-minted write permit" };
	}
	const contentHash = computeContentHash(role, text);
	const permitOk = input.consumePermit(input.nonce, {
		sessionId: guard.sessionId,
		packId: ident.packId,
		tool: input.tool,
		contentHash,
	});
	if (!permitOk) {
		return { ok: false, status: 403, error: "invalid, expired, or already-used write permit" };
	}

	// 4. Post into the TRUSTED bound session ONLY (never a caller param →
	//    cross-session posting is impossible). resumeTurn defaults to true. Role-aware:
	//    "system" is framed as a system directive (NOT delivered as raw user text).
	const resume = input.resumeTurn !== false;
	const deliveredText = formatSessionMessage(role, text);
	const start = clock();
	const base = { tool: input.tool, packId: ident.packId, sessionId: guard.sessionId, role, resumeTurn: resume };
	try {
		await input.post(guard.sessionId, deliveredText, { role, resume });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		input.audit({ ...base, ms: clock() - start, outcome: "error", error: message });
		return { ok: false, status: 500, error: message };
	}

	// 5. AUDIT every post/resume (mandatory).
	input.audit({ ...base, ms: clock() - start, outcome: "ok" });
	return { ok: true };
}
