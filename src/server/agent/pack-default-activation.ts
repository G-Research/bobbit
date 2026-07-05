// ── Default-disabled pack activation resolution ──────────────────────────────
//
// Some built-in (server-scope) first-party packs ship DORMANT — they appear in
// the Marketplace built-in band but their contributed entities (tools, provider,
// entrypoints, managed runtime) stay de-activated on a fresh server until the
// user deliberately turns them on. Hindsight is the first such pack: a fresh
// install must NOT inject memory tools / hooks until the operator configures or
// enables it, while an EXISTING live setup (already configured) must keep working
// untouched.
//
// This module holds the PURE decision logic (the priority ladder + the helpers
// that build the synthesized "everything disabled" override and detect an
// already-configured provider). The host (server.ts) supplies the live inputs
// (stored activation refs, the explicit-enable marker, the persisted provider
// config) and injects {@link resolveDefaultActivationOverlay} into the
// ProjectConfigStore so EVERY `getPackActivation` consumer — the roles/tools
// cascade, the pack-contribution registry, the tool-manager, the slash-skills
// catalog, and the Marketplace activation endpoints — observes the same
// effective state through a single seam.
//
// The synthesized override is a READ-TIME overlay only: it is NEVER persisted, so
// the dormancy invariant (disable/uninstall returns prompts byte-identical) holds
// and an explicit user enable/disable (a real persisted activation record, or the
// explicit-enable marker) always wins.

import type { PackManifest } from "./pack-types.js";
import type { DisabledRefs, PackOrderScope } from "./project-config-store.js";

/** Pack-order scopes whose built-in packs can ship default-disabled. Built-in
 *  first-party packs are toggleable at SERVER scope only (§7.4), so the overlay
 *  applies there and is inert at `global-user`/`project`. */
const DEFAULT_DISABLED_SCOPE: PackOrderScope = "server";

/** Live inputs for one (scope, pack) activation resolution. */
export interface DefaultActivationContext {
	scope: PackOrderScope;
	packName: string;
	/** The RAW persisted disabled-entity refs for this pack (before any overlay). */
	stored: DisabledRefs;
	/** Whether the pack's manifest declares `defaultDisabled: true`. */
	isDefaultDisabled: boolean;
	/** Whether the user has explicitly enabled this default-disabled pack (the
	 *  persisted force-enabled marker carries the pack name). An explicit
	 *  enable clears all disabled refs (empty record), which is indistinguishable
	 *  from "never touched" — the marker disambiguates so the enable persists. */
	isForceEnabled: boolean;
	/** Whether the pack is "already configured" (live-setup preservation rule). */
	isConfigured: boolean;
	/** The full "every contributed entity disabled" refs for this pack, used as
	 *  the synthesized overlay when the pack resolves dormant. */
	allDisabledRefs: DisabledRefs;
}

/**
 * Decide the EFFECTIVE disabled-refs overlay for a default-disabled pack.
 * Returns the synthesized all-disabled refs when the pack must resolve DORMANT,
 * or `undefined` to fall through to the raw stored refs (the normal path).
 *
 * Priority — an explicit user choice always wins:
 *   1. non-server scope OR not default-disabled  → undefined (no overlay; normal pack)
 *   2. explicit stored override (non-empty refs)  → undefined (honor verbatim — an
 *                                                    explicit per-entity / disable-all
 *                                                    record always wins, even if configured)
 *   3. explicit-enable marker present             → undefined (user turned it on)
 *   4. already configured (live setup)            → undefined (preserve the live instance)
 *   5. otherwise (fresh + unconfigured + untouched) → allDisabledRefs (dormant)
 */
export function resolveDefaultActivationOverlay(
	ctx: DefaultActivationContext,
): DisabledRefs | undefined {
	if (ctx.scope !== DEFAULT_DISABLED_SCOPE) return undefined;
	if (!ctx.isDefaultDisabled) return undefined;
	if (Object.keys(ctx.stored).length > 0) return undefined;
	if (ctx.isForceEnabled) return undefined;
	if (ctx.isConfigured) return undefined;
	return ctx.allDisabledRefs;
}

/** Activation-ref kinds in their canonical order. Mirrors ACTIVATION_KINDS in
 *  project-config-store.ts (kept local to avoid a value import cycle). `hooks`
 *  and `workflows` are deliberately excluded — see ACTIVATION_KINDS (finding
 *  EXT-03: neither is activation-toggleable). */
const DISABLED_REF_KINDS = [
	"roles",
	"tools",
	"skills",
	"entrypoints",
	"providers",
	"mcp",
	"piExtensions",
	"runtimes",
] as const;

/**
 * Build the "every contributed entity disabled" {@link DisabledRefs} for a pack
 * — the synthesized overlay a dormant default-disabled pack resolves to. Mirrors
 * the Marketplace UI's "disable all" (which derives the same set from the
 * activation catalogue): `tools` are CONCRETE tool names (not group dir names),
 * every other kind is the manifest's declared basenames. Empty kinds are omitted.
 *
 * @param manifest      the pack manifest (contents drive most kinds)
 * @param concreteTools concrete tool NAMES resolved from the pack's tool groups
 *                      (readConcretePackToolsFromGroups), since DisabledRefs.tools
 *                      is keyed by tool name, not by the contents.tools group dir.
 */
export function buildAllDisabledRefs(
	manifest: PackManifest,
	concreteTools: readonly string[],
): DisabledRefs {
	const c = manifest.contents;
	const byKind: Record<(typeof DISABLED_REF_KINDS)[number], readonly string[] | undefined> = {
		roles: c.roles,
		tools: concreteTools,
		skills: c.skills,
		entrypoints: c.entrypoints,
		providers: c.providers,
		mcp: c.mcp,
		piExtensions: c.piExtensions,
		runtimes: c.runtimes,
	};
	const out: DisabledRefs = {};
	for (const kind of DISABLED_REF_KINDS) {
		const arr = byKind[kind];
		if (Array.isArray(arr) && arr.length > 0) out[kind] = [...arr];
	}
	return out;
}

/**
 * The "already configured" rule (live-setup preservation). A persisted provider
 * config counts as configured when it has a non-empty `externalUrl` OR selects a
 * managed deployment mode (`managed` / `managed-external-postgres`). Pure over a
 * single provider-config object; the host calls it for each of the pack's
 * providers and treats the pack as configured if ANY provider is.
 */
export function isProviderConfigConfigured(cfg: unknown): boolean {
	if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return false;
	const obj = cfg as Record<string, unknown>;
	const url = obj.externalUrl;
	if (typeof url === "string" && url.trim().length > 0) return true;
	const mode = obj.mode;
	return mode === "managed" || mode === "managed-external-postgres";
}
