// src/server/extension-host/pack-identity.ts
//
// Slice A — server-resolved pack identity (Extension Host Phase 2 foundation,
// design docs/design/extension-host-phase2.md §2).
//
// Every Host API instance (client + server) carries a TRUSTED, host-derived
// `{ packId, contributionId }` that extension code can never set or forge
// (design extension-host.md §3.2). This is the security keystone for the scoped
// Phase-2 capabilities — store namespacing (B1) and the route namespace
// constraint (B3) both key off the SERVER-DERIVED `packId`, never caller input.
//
// `packId` is derived purely structurally from the WINNING contribution's
// on-disk location: the directory name an install writes under `market-packs/`
// (`<scope>/.bobbit/config/market-packs/<name>/tools`). It is stable across
// installs and identical for every tool the pack contributes. NEVER read from
// request args/body.

import { isMarketPackBaseDir } from "../agent/tool-contributions.js";
import type { ActionToolLocationResolver } from "./action-dispatcher.js";

export interface PackIdentity {
	/** Stable id = the pack directory name under `market-packs/` (the segment
	 *  AFTER the `market-packs` segment in baseDir). Empty string for a non-pack
	 *  (builtin). */
	packId: string;
	/** The contributing tool/group key that won resolution: `${groupDir}/${tool}`. */
	contributionId: string;
	/** True when baseDir is a market-pack root (mirrors isMarketPackBaseDir). */
	isPack: boolean;
}

/**
 * Derive the pack id from a resolved winning baseDir: split on path separators,
 * find the `market-packs` segment, take the NEXT segment. Mirrors the structural
 * path-segment logic in `tool-contributions.ts:isMarketPackBaseDir` (not a
 * fragile substring match). Returns "" when there is no market-packs segment, or
 * when it is the last segment (no pack-name segment follows).
 */
function derivePackId(baseDir: string | undefined): string {
	if (!baseDir) return "";
	const segments = baseDir.split(/[\\/]+/);
	const idx = segments.indexOf("market-packs");
	if (idx < 0 || idx + 1 >= segments.length) return "";
	return segments[idx + 1] ?? "";
}

/**
 * Derive identity from a resolved tool location. NEVER reads caller input — the
 * only inputs are the host-resolved `loc` and the `tool` name that won
 * resolution. A non-pack location (no `market-packs` segment) yields
 * `{ packId: "", contributionId, isPack: false }`.
 */
export function resolvePackIdentity(
	loc: { baseDir: string; groupDir: string } | undefined,
	tool: string,
): PackIdentity {
	const isPack = isMarketPackBaseDir(loc?.baseDir);
	const groupDir = loc?.groupDir ?? "";
	return {
		packId: isPack ? derivePackId(loc?.baseDir) : "",
		contributionId: `${groupDir}/${tool}`,
		isPack,
	};
}

/**
 * Resolve identity for a tool via a tool-location resolver (the session's
 * project-scoped ToolManager, picked by `resolveActionToolManager`). The winning
 * `{baseDir,groupDir}` comes from the SAME `resolveToolLocation` the action
 * dispatcher loads the module from, so identity and module agree by construction
 * (design §3.2: "that resolution IS the pack identity").
 */
export function resolvePackIdentityForTool(
	resolver: ActionToolLocationResolver,
	tool: string,
): PackIdentity {
	const loc = resolver.resolveToolLocation(tool);
	return resolvePackIdentity(loc, tool);
}
