// src/server/extension-host/surface-binding.ts
//
// Server-minted, opaque SURFACE BINDING TOKEN for the scoped Phase-2 capabilities
// (`host.store.*` / `host.session.*` / `host.callRoute`; design
// docs/design/extension-host-phase2.md §2.3 + §10).
//
// ── WHY (the caller-supplied-`tool` identity hole this closes). ──
//
// Until now every scoped call carried a `tool` field in its body/query (or WS
// frame), and the server resolved the trusted `packId` from THAT field. The host
// API held the contributing tool in closure, so a WELL-BEHAVED pack could not
// override it — but the field is still a plain request parameter. Nothing stopped
// a pack from NAMING ANOTHER PACK'S tool on a raw request and acting AS that pack
// (cross-pack identity confusion — acceptance #4).
//
// ── HOW the token closes it. ──
//
// When the TRUSTED app first constructs a surface's Host API (renderer / panel /
// entrypoint) it asks the server to MINT a token. The server resolves the WINNING
// contribution for that `tool` (the same `resolveToolLocation` resolution that IS
// the pack identity) and mints a token BOUND to {sessionId, packId, contributionId,
// tool}. The token is opaque to the client (HMAC-signed, stateless) and is captured
// in the Host API CLOSURE — pack module code never sees or sets it. Every scoped
// call sends the token; the server DERIVES {packId, tool} from the validated token
// and IGNORES any caller-supplied tool/pack. A missing / invalid / wrong-session
// token is rejected.
//
// ── RESIDUAL (the same-realm reality; documented, not over-claimed). ──
//
// In the SHARED main UI realm (Model A) a deliberately MALICIOUS pack can still
// fetch its own surface-token mint for any tool name, or read another surface's
// token out of a shared closure / monkey-patch `fetch`. TRUE cross-pack isolation
// needs per-pack realm isolation, which Model A de-scoped for UI. So this token
// closes the ACCIDENTAL + non-pack-reachable path and makes the Host API the only
// SANCTIONED identity path; it does NOT defend against a same-realm adversary. The
// residual is documented in docs/marketplace.md (threat model) — exactly parallel to
// the session-write same-realm mint-forgery residual (session-write-permit.ts).
//
// Stateless HMAC keeps this allocation-free: no map to prune, no cross-process
// sharing needed. The token is bound to a sessionId, so a token outliving its
// session is inert (the scoped endpoints' authorizeScopedRequest rejects a dead /
// non-matching session regardless).

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { resolvePackIdentityForTool } from "./pack-identity.js";
import type { ActionToolLocationResolver } from "./action-dispatcher.js";
import type { PackContributionResolver } from "./pack-contribution-registry.js";

/** The trusted identity a surface token binds. Every field is SERVER-resolved at
 *  mint time from the winning contribution — never caller-supplied. */
export interface SurfaceBinding {
	/** The session the surface's Host API is bound to. */
	sessionId: string;
	/** The SERVER-derived pack id (the winning contribution's pack dir). */
	packId: string;
	/** The SERVER-derived contribution id. Tool-bound: `${groupDir}/${tool}`.
	 *  Pack-bound: `panel:<id>` | `entrypoint:<id>` | `route:<name>`. */
	contributionId: string;
	/** The pack's contributing tool name — PRESENT only for tool-bound surfaces
	 *  (renderer/action). ABSENT for pack-bound surfaces (panel/entrypoint/route). */
	tool?: string;
}

interface TokenPayload extends SurfaceBinding {
	/** Issued-at (ms). Used for the soft TTL below. */
	iat: number;
}

/** Per-process signing key. A token only needs to be valid within the lifetime of
 *  the gateway that minted it (it is bound to an in-memory session), so a fresh
 *  random key per boot is correct and needs no persistence. */
const SECRET = randomBytes(32);

/** Soft lifetime. A surface re-mints lazily per page load, so this only bounds how
 *  long a single leaked token stays replayable; the binding to a live session is
 *  the real gate. Generous so a long-lived tab keeps working. */
export const DEFAULT_SURFACE_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function sign(body: string): string {
	return createHmac("sha256", SECRET).update(body).digest("base64url");
}

/**
 * Mint an opaque, HMAC-signed surface token for a SERVER-resolved binding. The
 * returned string is `base64url(payload).base64url(hmac)`; the client treats it as
 * opaque and echoes it on every scoped call.
 */
export function mintSurfaceToken(binding: SurfaceBinding, opts?: { now?: () => number }): string {
	const now = (opts?.now ?? Date.now)();
	const payload: TokenPayload = { ...binding, iat: now };
	const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
	return `${body}.${sign(body)}`;
}

/**
 * Validate + decode a surface token. Returns the bound {sessionId, packId,
 * contributionId, tool} ONLY when the signature verifies and the token is not past
 * its soft TTL; otherwise null. Constant-time signature comparison.
 */
export function validateSurfaceToken(
	token: unknown,
	opts?: { now?: () => number; ttlMs?: number },
): SurfaceBinding | null {
	if (typeof token !== "string" || token.length === 0) return null;
	const dot = token.indexOf(".");
	if (dot <= 0 || dot >= token.length - 1) return null;
	const body = token.slice(0, dot);
	const sig = token.slice(dot + 1);
	const expected = sign(body);
	// Constant-time compare; bail first on a length mismatch (timingSafeEqual throws
	// on unequal lengths).
	const sigBuf = Buffer.from(sig);
	const expBuf = Buffer.from(expected);
	if (sigBuf.length !== expBuf.length) return null;
	if (!timingSafeEqual(sigBuf, expBuf)) return null;
	let payload: TokenPayload;
	try {
		payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
	} catch {
		return null;
	}
	if (
		!payload ||
		typeof payload.sessionId !== "string" || !payload.sessionId ||
		typeof payload.packId !== "string" || !payload.packId ||
		typeof payload.contributionId !== "string" || !payload.contributionId ||
		// `tool` is OPTIONAL (pack-bound surfaces carry no tool); when present it
		// must be a non-empty string.
		(payload.tool !== undefined && (typeof payload.tool !== "string" || !payload.tool)) ||
		typeof payload.iat !== "number"
	) {
		return null;
	}
	const ttl = opts?.ttlMs && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_SURFACE_TOKEN_TTL_MS;
	const now = (opts?.now ?? Date.now)();
	if (now > payload.iat + ttl) return null;
	const out: SurfaceBinding = { sessionId: payload.sessionId, packId: payload.packId, contributionId: payload.contributionId };
	if (payload.tool !== undefined) out.tool = payload.tool;
	return out;
}

export type SurfaceIdentityResult =
	| { ok: true; sessionId: string; packId: string; tool?: string; contributionId: string }
	| { ok: false; status: number; error: string };

/**
 * The SINGLE chokepoint a scoped endpoint (store / session / route) and the WS
 * session-write handler use to derive their TRUSTED {packId, tool} identity from a
 * server-minted surface token — NEVER from a caller-supplied tool/pack field.
 *
 * It validates the token signature + TTL, asserts the token's bound session equals
 * the header-canonical session (no cross-session token use), RE-RESOLVES the pack
 * identity for the token's `tool` through the SAME session-project resolver the
 * dispatcher loads modules from (so a token that went stale after an uninstall /
 * precedence change is rejected), and asserts the freshly-resolved packId still
 * matches the token's. Any failure is a 403; success yields the derived identity the
 * endpoint then uses, ignoring any caller-supplied tool/pack entirely.
 */
export function resolveSurfaceIdentity(input: {
	token: unknown;
	headerSessionId: string | undefined;
	resolver: ActionToolLocationResolver;
	/** Pack-bound re-resolution (pack-schema-v1 §4.4) — required to validate a
	 *  token with no `tool` against the project-scoped pack-contribution registry. */
	contributions?: PackContributionResolver;
	/** The session's project scope, for pack-bound registry re-resolution. */
	projectId?: string;
	now?: () => number;
}): SurfaceIdentityResult {
	const binding = validateSurfaceToken(input.token, { now: input.now });
	if (!binding) return { ok: false, status: 403, error: "missing or invalid surface token" };
	if (!input.headerSessionId || binding.sessionId !== input.headerSessionId) {
		return { ok: false, status: 403, error: "surface token session mismatch" };
	}

	// ── Tool-bound surface (renderer / action): re-resolve via the tool-location
	//    resolver + assert packId match (rejects a token gone stale after an
	//    uninstall / precedence change). Unchanged path. ──
	if (binding.tool !== undefined) {
		const ident = resolvePackIdentityForTool(input.resolver, binding.tool);
		if (!ident.isPack || !ident.packId) {
			return { ok: false, status: 403, error: "surface token does not resolve to a market pack" };
		}
		if (ident.packId !== binding.packId) {
			return { ok: false, status: 403, error: "surface token pack identity mismatch" };
		}
		return { ok: true, sessionId: binding.sessionId, packId: ident.packId, tool: binding.tool, contributionId: ident.contributionId };
	}

	// ── Pack-bound surface (panel / entrypoint / route): re-resolve via the
	//    pack-contribution registry — the pack must still be installed + active in
	//    scope AND still expose binding.contributionId (§4.4/§4.5). No `allowedTools`
	//    gate; the trust boundary is installed + active + own-session. ──
	const contributions = input.contributions;
	if (!contributions) {
		return { ok: false, status: 403, error: "surface token does not resolve to a market pack" };
	}
	const pack = contributions.getPack(input.projectId, binding.packId);
	if (!pack) {
		return { ok: false, status: 403, error: "surface token pack is not installed or active" };
	}
	const sep = binding.contributionId.indexOf(":");
	const kind = sep > 0 ? binding.contributionId.slice(0, sep) : "";
	const id = sep > 0 ? binding.contributionId.slice(sep + 1) : "";
	let exists = false;
	if (kind === "panel") exists = !!contributions.getPanel(input.projectId, binding.packId, id);
	else if (kind === "entrypoint") exists = !!contributions.getEntrypoint(input.projectId, binding.packId, id);
	else if (kind === "route") exists = contributions.hasRoute(input.projectId, binding.packId, id);
	if (!exists) {
		return { ok: false, status: 403, error: "surface token contribution is no longer available" };
	}
	return { ok: true, sessionId: binding.sessionId, packId: pack.packId, contributionId: binding.contributionId };
}
