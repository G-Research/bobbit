// src/server/extension-host/permission-grants.ts
//
// Slice C3 (extension) — the DECLARED-PERMISSION grant model for confined pack
// server modules (Extension Host Phase 2, design docs/design/extension-host-phase2.md
// §9). A pack manifest may OPT IN to a small set of otherwise-denied host
// capabilities via `permissions: ["git", "fs", "net"]`. The grant is resolved
// SERVER-SIDE from the winning contribution (never caller-supplied), threaded into
// the worker's `workerData`, and applied by the worker bootstrap.
//
// **Default is DENY-ALL.** A pack that declares nothing gets exactly today's
// confinement: every dangerous built-in import denied, every outbound-network
// global stripped, an inert `process` shim (empty env, cwd()=>"/"). Each granted
// capability is purely ADDITIVE and narrowly scoped:
//
//   - `git` → un-deny `child_process` (so the pack can spawn the `git` binary) and
//     give the process shim a REAL cwd() (the session working dir) + a MINIMAL env
//     containing only PATH (so the binary resolves). Spawned children are tracked
//     + killed on terminate-on-timeout so a runaway git cannot outlive the cap.
//   - `fs`  → un-deny `fs` (covers `fs`/`fs/promises` via first-segment) and give
//     the process shim the same REAL cwd() + minimal PATH env (relative reads
//     resolve under the session dir).
//   - `net` → KEEP the outbound-network globals (`fetch`/`WebSocket`/…) instead of
//     stripping them, and un-deny the network built-ins (`net`/`http`/`https`/…).
//
// This module is PURE logic (no node imports) so the worker bootstrap can import
// it statically BEFORE the confinement deny-hook is installed without the
// deny-list ever blocking it.

/** The complete set of grantable permission names (design §9 — declared model). */
export const PACK_PERMISSION_VALUES = ["git", "fs", "net"] as const;
export type PackPermission = (typeof PACK_PERMISSION_VALUES)[number];

/** Which first-path-segment deny-list entries each grant REMOVES (un-denies). The
 *  removal is by first segment, so `fs` covers `node:fs/promises` and `net` covers
 *  every outbound-network built-in. */
const GRANT_DENIED_REMOVALS: Record<PackPermission, readonly string[]> = {
	git: ["child_process"],
	fs: ["fs"],
	net: ["net", "http", "https", "http2", "dns", "tls", "dgram"],
};

/** Coerce an arbitrary value into the recognized grant subset (tolerant: unknown
 *  entries dropped, deduped, order-stable). Empty/absent ⇒ deny-all (today). */
export function normalizeGrants(raw: unknown): PackPermission[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const out: PackPermission[] = [];
	for (const v of raw) {
		if (typeof v !== "string") continue;
		const lower = v.toLowerCase();
		if (!(PACK_PERMISSION_VALUES as readonly string[]).includes(lower)) continue;
		if (seen.has(lower)) continue;
		seen.add(lower);
		out.push(lower as PackPermission);
	}
	return out;
}

/** True when the grant set includes `name`. */
export function hasGrant(grants: readonly string[] | undefined, name: PackPermission): boolean {
	return Array.isArray(grants) && grants.includes(name);
}

/**
 * Compute the EFFECTIVE first-segment deny-list for a grant set: start from the
 * full deny-list and remove the entries each granted permission un-denies. An
 * empty grant set returns the base list unchanged (deny-all).
 */
export function deniedForGrants(base: readonly string[], grants: readonly string[] | undefined): string[] {
	const normalized = normalizeGrants(grants);
	if (normalized.length === 0) return [...base];
	const remove = new Set<string>();
	for (const g of normalized) {
		for (const seg of GRANT_DENIED_REMOVALS[g]) remove.add(seg);
	}
	return base.filter((seg) => !remove.has(seg));
}

/** True when the outbound-network globals (`fetch`/`WebSocket`/…) must be KEPT
 *  (the `net` grant) rather than stripped. */
export function keepNetworkGlobals(grants: readonly string[] | undefined): boolean {
	return hasGrant(grants, "net");
}

/** True when the process shim must expose a REAL cwd() + minimal PATH env (the
 *  `git` or `fs` grant) instead of the fully-inert empty shim. */
export function needsRealProcess(grants: readonly string[] | undefined): boolean {
	return hasGrant(grants, "git") || hasGrant(grants, "fs");
}
