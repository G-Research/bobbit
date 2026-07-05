// src/server/extension-host/settings-section-preferences.ts
//
// Server-side gate for PACK-ATTRIBUTED preference writes from a Settings-page
// pack contribution (docs/design/pack-settings-contribution.md §4.3; S5-build
// amendment 2 — FULL-TIER orchestrator-reviewed security surface).
//
// A settings-section has NO session and NO toolUseId (unlike every other pack
// surface), so it cannot use the session-bound `surface-binding.ts` mint/resolve
// pair (`resolveSurfaceIdentity` hard-requires a matching header session). This
// module reuses the SAME underlying HMAC primitive (`mintSurfaceToken` /
// `validateSurfaceToken` — unmodified, zero blast radius to the session-bound
// panel/entrypoint/route call sites) with a fixed sentinel `sessionId` that can
// never collide with a real session id, and a `contributionId` namespaced
// `settings-section:<id>` so a settings-section token can never be replayed
// against a panel/entrypoint/route endpoint or vice versa (different
// `contributionId` shape AND different sessionId sentinel — both must match).
//
// THE ALLOWLIST IS NEVER TRUSTED FROM THE TOKEN. The token proves only
// `{packId, sectionId}` identity (server-minted, HMAC-signed, opaque to the
// client). `guardPackAttributedPreferenceWrite` re-resolves the section's
// `preferenceKeys` LIVE from the installed pack contribution on every call — a
// caller cannot assert its own allowlist by shaping the token payload, and an
// uninstalled/updated pack's stale token stops validating the moment the
// section's registry entry disappears (mirrors `resolveSurfaceIdentity`'s own
// re-resolution-over-trust discipline for panels/entrypoints/routes).
//
// ── THE SECURITY-CRITICAL LINE (review this closely) ──────────────────────
// Keys already gated behind `blockedAgentDirKeys` / `isClaudeCodePreferenceKey`
// in the `PUT /api/preferences` handler are HARD-REJECTED for ANY pack-
// attributed write, UNCONDITIONALLY — even for a key a pack's own manifest
// explicitly declares in `preferenceKeys`, and even if the request otherwise
// carries a valid operator-confirmation token. A pack settings-section's
// sanctioned Host API must never become a side channel that reaches a
// Claude-Code-runtime key (which the UI gates behind an explicit operator
// confirmation dialog for a REASON — see `claude-code-config.ts`) or the
// agent-directory workflow (`agentDir`/`agentDirHistory`, which has its own
// dedicated `/api/agent-dir/pending` flow) merely because the user happened to
// interact with an installed pack's innocuous-looking settings widget. This
// check runs BEFORE the allowlist check, so a blocked key is rejected even when
// it is (incorrectly, or maliciously) present in the pack's own declared
// `preferenceKeys` list. See the adversarial pin in
// tests/pack-contributions.test.ts ("hard-rejects a Claude-Code-gated key for a
// synthetic pack token that declares it").
//
// Residual (documented, not over-claimed, consistent with docs/marketplace.md's
// "Model A" same-realm trust model): this gate protects the SANCTIONED
// `host.preferences.set()` path only. A pack's JS runs unsandboxed in the main
// frame like any panel/renderer today, so a deliberately malicious pack could
// still skip this API entirely and issue a raw authenticated `fetch` — that
// residual is pre-existing and out of scope for this contribution kind (§4.4).

import { validateSurfaceToken, mintSurfaceToken } from "./surface-binding.js";
import type { PackContributionResolver } from "./pack-contribution-registry.js";

/** Sentinel `sessionId` for settings-section tokens — never a valid real
 *  session id, so a session-bound token can never validate here and vice versa. */
export const SETTINGS_SECTION_TOKEN_SESSION = "__settings-section__";

const CONTRIBUTION_PREFIX = "settings-section:";

export function settingsSectionContributionId(sectionId: string): string {
	return `${CONTRIBUTION_PREFIX}${sectionId}`;
}

/** Mint an opaque settings-section surface token, bound to `{packId, sectionId}`
 *  ONLY — it carries no preference-key claims (those are re-resolved live from
 *  the registry on every guarded write, never from the token). */
export function mintSettingsSectionToken(packId: string, sectionId: string): string {
	return mintSurfaceToken({ sessionId: SETTINGS_SECTION_TOKEN_SESSION, packId, contributionId: settingsSectionContributionId(sectionId) });
}

export type SettingsSectionGuardResult =
	| { ok: true }
	| { ok: false; status: number; error: string; key?: string };

/**
 * The single chokepoint `PUT /api/preferences` calls when a request carries a
 * pack settings-section surface token. Validates the token, re-resolves the
 * section's LIVE declared allowlist, and enforces the two gates documented at
 * the top of this file. Any failure is 400/403; success means every key in
 * `patchKeys` is safe to honor via the normal preference-write path.
 */
export function guardPackAttributedPreferenceWrite(input: {
	token: unknown;
	patchKeys: readonly string[];
	contributions: PackContributionResolver;
	projectId: string | undefined;
	/** Caller-supplied predicate for the EXISTING gated-key set
	 *  (`blockedAgentDirKeys.includes(key) || isClaudeCodePreferenceKey(key)`) —
	 *  injected rather than imported so this module has no dependency on
	 *  `claude-code-config.ts` / the specific literal key list, which may grow. */
	isBlockedKey: (key: string) => boolean;
}): SettingsSectionGuardResult {
	const binding = validateSurfaceToken(input.token);
	if (!binding || binding.sessionId !== SETTINGS_SECTION_TOKEN_SESSION || !binding.contributionId.startsWith(CONTRIBUTION_PREFIX)) {
		return { ok: false, status: 403, error: "missing or invalid pack settings-section surface token" };
	}
	const sectionId = binding.contributionId.slice(CONTRIBUTION_PREFIX.length);
	const section = input.contributions.getSettingsSection(input.projectId, binding.packId, sectionId);
	if (!section) {
		return { ok: false, status: 403, error: "pack settings-section is no longer installed or active" };
	}
	// Gate 1 — non-negotiable, checked for EVERY key before the allowlist below.
	for (const key of input.patchKeys) {
		if (input.isBlockedKey(key)) {
			return { ok: false, status: 403, error: `pack settings-section may not write gated preference key "${key}"`, key };
		}
	}
	// Gate 2 — the pack's OWN live-declared allowlist.
	const allowlist = new Set(section.preferenceKeys);
	for (const key of input.patchKeys) {
		if (!allowlist.has(key)) {
			return { ok: false, status: 400, error: `pack settings-section "${binding.packId}/${sectionId}" is not declared to write preference key "${key}"`, key };
		}
	}
	return { ok: true };
}
