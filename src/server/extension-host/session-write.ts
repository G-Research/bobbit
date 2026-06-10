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
	/** The pack's contributing tool name (proves pack ownership via allowedTools)
	 *  for a TOOL-bound surface. ABSENT for a PACK-bound surface (panel/entrypoint/
	 *  route, pack-schema-v1 §4.5) — which skips the allowedTools gate and relies on
	 *  the pre-resolved {@link packId} (installed + active + own-session already
	 *  proved by the surface-token validation). */
	tool?: string;
	/** SERVER-derived packId for a PACK-bound surface (no carrier tool). When
	 *  present, the allowedTools gate + tool→pack resolution are skipped. */
	packId?: string;
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
	const start = clock();

	// EVERY rejection path is audited (design §8 C2.1 step 4 — "audit every
	// post/resume"). A rejection records whatever identity is known at that point
	// (packId is "" before it is server-derived; role coerced to a valid union for
	// the typed record) plus the rejection reason, so an attempted-but-denied write
	// is never silent. Successful posts are audited at the end.
	const reject = (status: number, error: string, ctx?: { packId?: string; role?: "user" | "system"; resumeTurn?: boolean }): SessionPostResult => {
		input.audit({
			tool: input.tool ?? input.packId ?? "",
			packId: ctx?.packId ?? input.packId ?? "",
			sessionId: typeof input.sessionId === "string" ? input.sessionId : "",
			role: ctx?.role ?? (input.role === "system" ? "system" : "user"),
			resumeTurn: ctx?.resumeTurn ?? (input.resumeTurn !== false),
			ms: clock() - start,
			outcome: "error",
			error,
		});
		return { ok: false, status, error };
	};

	// 1. Pack-scoped authorization. The session is the TRUSTED, server-authenticated
	//    WS-bound session, so the body===header invariant authorizeScopedRequest
	//    enforces holds trivially (both are the same trusted id). What this still
	//    gates is: the session resolves, and the pack's `tool` ∈ allowedTools. (No
	//    toolUseId-ownership — driving a turn acts on no specific prior tool call,
	//    and panels/entrypoints have no toolUseId. §2a / Fix B.)
	// TOOL-bound: gate the pack's `tool` ∈ allowedTools (+ session resolve). The
	// session is the TRUSTED WS-bound session, so body===header holds trivially.
	// PACK-bound (no tool): skip allowedTools (§4.5 — the surface-token validation
	// already proved installed + active + own-session); only resolve the session.
	let guardSessionId: string;
	if (input.tool !== undefined) {
		const guard = authorizeScopedRequest({
			tool: input.tool,
			headerSessionId: input.sessionId,
			bodySessionId: input.sessionId,
			resolveSession: input.resolveSession,
		});
		if (!guard.ok) return reject(guard.status, guard.error);
		guardSessionId = guard.sessionId;
	} else {
		if (typeof input.sessionId !== "string" || !input.sessionId || !input.resolveSession(input.sessionId)) {
			return reject(403, "unknown session");
		}
		guardSessionId = input.sessionId;
	}

	// 2. Validate the message: role ∈ {user, system} + non-empty text.
	if (input.role !== "user" && input.role !== "system") {
		return reject(400, 'role must be "user" or "system"');
	}
	const role: "user" | "system" = input.role;
	if (typeof input.text !== "string" || input.text.trim().length === 0) {
		return reject(400, "text must be a non-empty string", { role });
	}
	const text = input.text;

	// 3. SERVER-derive the pack identity. TOOL-bound: from the proven `tool`.
	//    PACK-bound: from the pre-resolved {@link packId} (already validated against
	//    the pack-contribution registry by the surface-token resolution).
	const ident = input.tool !== undefined
		? input.resolvePackIdentity(input.tool)
		: { isPack: !!input.packId, packId: input.packId ?? "" };
	if (!ident.isPack || !ident.packId) {
		return reject(403, "session messaging is available only to market-pack contributions", { role });
	}

	// 3b. REQUIRE a server-minted, one-time, content-bound write permit. The
	//     contentHash is recomputed HERE from the validated role+text and bound to
	//     {sessionId, packId, tool} — so a replayed frame (permit already consumed),
	//     a forged frame (no valid nonce), or a tampered role/text (hash mismatch)
	//     are all rejected with NO post. (§8 C2.1 — session-write-permit.ts.)
	if (typeof input.nonce !== "string" || input.nonce.length === 0) {
		return reject(403, "session post requires a server-minted write permit", { packId: ident.packId, role });
	}
	const contentHash = computeContentHash(role, text);
	const permitOk = input.consumePermit(input.nonce, {
		sessionId: guardSessionId,
		packId: ident.packId,
		tool: input.tool ?? "",
		contentHash,
	});
	if (!permitOk) {
		return reject(403, "invalid, expired, or already-used write permit", { packId: ident.packId, role });
	}

	// 4. Post into the TRUSTED bound session ONLY (never a caller param →
	//    cross-session posting is impossible). resumeTurn defaults to true. Role-aware:
	//    "system" is framed as a system directive (NOT delivered as raw user text).
	const resume = input.resumeTurn !== false;
	const deliveredText = formatSessionMessage(role, text);
	const base = { tool: input.tool ?? ident.packId, packId: ident.packId, sessionId: guardSessionId, role, resumeTurn: resume };
	try {
		await input.post(guardSessionId, deliveredText, { role, resume });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		input.audit({ ...base, ms: clock() - start, outcome: "error", error: message });
		return { ok: false, status: 500, error: message };
	}

	// 5. AUDIT every post/resume (mandatory).
	input.audit({ ...base, ms: clock() - start, outcome: "ok" });
	return { ok: true };
}
