// src/server/extension-host/session-write-permit.ts
//
// Server-minted, one-time, content-bound WRITE PERMIT for the C2 session WRITE
// (`host.session.postMessage`; design docs/design/extension-host-phase2.md §8 C2.1).
//
// ── WHY (the same-realm replay vector the WS-only move did NOT close). ──
//
// Routing the session-write over the trusted WebSocket (instead of a fetch carrying
// a capturable per-session secret) removed the *secret-exfiltration* vector, but it
// did NOT close the same-realm *forge/replay* vector: a pack renderer/panel runs in
// the MAIN UI realm and can monkey-patch `WebSocket.prototype.send` (or otherwise
// capture the live socket) and then FORGE or REPLAY an `ext_session_post` frame —
// e.g. capture one legitimate gesture-driven post frame and resend it later with no
// gesture, driving the agent at will.
//
// ── HOW the permit closes it. ──
//
// Every post must now carry a SERVER-MINTED, one-time nonce that is BOUND to the
// exact {sessionId, packId, tool, contentHash} of the message:
//   - `mintWritePermit(...)` is invoked over the trusted WS only after the client's
//     synchronous transient-activation assertion passes; it returns an opaque nonce
//     and records the binding with a short TTL (~5s).
//   - `consumeWritePermit(nonce, binding)` validates that ALL bindings match, the
//     permit is not expired, and not already consumed; on success it marks the
//     permit consumed (single-use) and drops it.
// Net:
//   - a CAPTURED post frame REPLAYED → its permit is already consumed → rejected.
//   - a FORGED post WITHOUT a server-minted permit → no valid nonce → rejected.
//   - a post whose role/text was TAMPERED after mint → contentHash mismatch → rejected.
//   - each agent-drive needs a FRESH mint (fresh transient activation on the client).
//
// ── RESIDUAL (documented; the realm-isolation follow-up). ──
//
// A pack forging the MINT itself during an unrelated genuine user gesture is inherent
// to the same-realm model — pack code shares the realm's transient-activation state
// and (absent realm isolation) could ride a real gesture to mint+post. The permit
// removes the replay/forge-without-mint surface; eliminating mint-forgery requires
// running pack UI in an isolated realm (the documented follow-up — see
// docs/marketplace.md threat model).
//
// In-memory, per-gateway (not persisted, not shared cross-process). A short TTL plus
// single-use consumption keeps the map bounded; we also prune expired entries on mint.

import { createHash, randomBytes } from "node:crypto";

/** The exact identity a permit is bound to. Every field must match at consume. */
export interface WritePermitBinding {
	/** The trusted, server-authenticated bound session id. */
	sessionId: string;
	/** The SERVER-derived pack id (never caller-supplied). */
	packId: string;
	/** The pack's contributing tool name. */
	tool: string;
	/** sha256 hex of `role + "\n" + text` — binds the permit to the exact content. */
	contentHash: string;
}

interface StoredPermit extends WritePermitBinding {
	expiresAt: number;
	consumed: boolean;
}

/** Default permit lifetime. Short on purpose: a permit exists only to bridge the
 *  mint→post round-trip of a single gesture-driven write. */
export const DEFAULT_WRITE_PERMIT_TTL_MS = 5_000;

/** Hard cap on the live permit map (defense against a mint flood). Oldest-by-
 *  insertion entries are dropped past the cap; legitimate use mints one at a time. */
const MAX_LIVE_PERMITS = 1_000;

const permits = new Map<string, StoredPermit>();

/** Canonical content hash: sha256 hex of `role + "\n" + text`. The client computes
 *  the SAME value via SubtleCrypto so mint and consume bindings agree. */
export function computeContentHash(role: string, text: string): string {
	return createHash("sha256").update(`${role}\n${text}`, "utf8").digest("hex");
}

/** Drop expired entries. Cheap O(n) sweep; called on mint (mints are rare relative
 *  to reads and are the only growth path). */
function pruneExpired(now: number): void {
	for (const [nonce, p] of permits) {
		if (p.consumed || now > p.expiresAt) permits.delete(nonce);
	}
}

/**
 * Mint a one-time, content-bound write permit. Returns an opaque, unguessable
 * nonce. The caller (WS handler) supplies a SERVER-derived binding only — no field
 * here is caller-supplied except via the server's own resolution.
 */
export function mintWritePermit(
	binding: WritePermitBinding,
	opts?: { ttlMs?: number; now?: () => number },
): string {
	const clock = opts?.now ?? Date.now;
	const now = clock();
	pruneExpired(now);
	// Bound the map even if many mints arrive without matching consumes.
	if (permits.size >= MAX_LIVE_PERMITS) {
		const oldest = permits.keys().next().value;
		if (oldest !== undefined) permits.delete(oldest);
	}
	const ttl = opts?.ttlMs && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_WRITE_PERMIT_TTL_MS;
	const nonce = randomBytes(32).toString("base64url");
	permits.set(nonce, { ...binding, expiresAt: now + ttl, consumed: false });
	return nonce;
}

/**
 * Validate + single-use consume a write permit. Returns true ONLY when the nonce
 * exists, is not expired, is not already consumed, and EVERY binding field matches.
 * On success the permit is marked consumed and removed (single-use). Any failure
 * (unknown / expired / already-consumed / mismatched) returns false and never posts.
 */
export function consumeWritePermit(
	nonce: string,
	binding: WritePermitBinding,
	opts?: { now?: () => number },
): boolean {
	if (typeof nonce !== "string" || nonce.length === 0) return false;
	const clock = opts?.now ?? Date.now;
	const p = permits.get(nonce);
	if (!p) return false;
	// Single-use: a consumed permit (replayed frame) is dead even before TTL.
	if (p.consumed) {
		permits.delete(nonce);
		return false;
	}
	if (clock() > p.expiresAt) {
		permits.delete(nonce);
		return false;
	}
	if (
		p.sessionId !== binding.sessionId ||
		p.packId !== binding.packId ||
		p.tool !== binding.tool ||
		p.contentHash !== binding.contentHash
	) {
		// Mismatch: do NOT consume the legitimate permit on a forged-binding attempt;
		// just reject this request (the real post can still consume it within TTL).
		return false;
	}
	p.consumed = true;
	permits.delete(nonce);
	return true;
}

/** Test/diagnostic helper: current live (unconsumed, unexpired-ish) permit count. */
export function _livePermitCount(): number {
	return permits.size;
}

/** Test helper: clear all permits (isolation between unit tests). */
export function _resetWritePermits(): void {
	permits.clear();
}
