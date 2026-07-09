/**
 * Built-in first-party packs — resolve-in-place band (design
 * `docs/design/built-in-first-party-packs.md` §3.6, §5).
 *
 * Bobbit ships an allowlist of first-party packs (built by `build:packs` and
 * copied to `dist/server/builtin-packs/market-packs/<name>/` by
 * `scripts/copy-builtin-packs.mjs`). These packs are NOT copy-installed into
 * any scope's `.bobbit/config/market-packs/`; they are resolved **in place** as
 * a dedicated band in {@link buildPackList} (and the roles/tools cascade),
 * sitting ABOVE the monolithic builtin defaults and BELOW every user scope band
 * (§5.3). "Auto-installed" therefore means *present + active by default*: the
 * only opt-out is the #734 activation override (default = enabled).
 *
 * The shipped dir lives under a literal `market-packs` segment so the
 * security-critical pack-identity derivation (`derivePackId` /
 * `packIdFromRoot` / `isMarketPackBaseDir`) resolves a correct, stable `packId`
 * with ZERO changes to the identity code (§6.1).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PackEntry, PackManifest } from "./pack-types.js";
import { readManifest } from "./pack-manifest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url)); // dist/server/agent/

/**
 * The {@link PackScope} the built-in first-party pack entries carry. `server`
 * (§7.1): the built-in source is server-global, so disabling a shipped feature
 * is a server-wide admin decision and activation resolves via the existing
 * `getPackActivation("server", packName)` with no widening of `PackOrderScope`.
 */
export const BUILTIN_PACK_SCOPE = "server" as const;

/**
 * Absolute path to the shipped first-party pack band root.
 *
 * Mirrors `builtin-config.ts`'s `__dirname`-relative resolution: this module
 * compiles to `dist/server/agent/`, so `..` → `dist/server/builtin-packs/market-packs`.
 * The `override` param and `BOBBIT_BUILTIN_PACKS_DIR` env var let tests point
 * the band at a fixture dir (e.g. the repo `market-packs/` tree, which already
 * carries the built `lib/` bundles) without touching dist.
 */
export function resolveBuiltinPacksDir(override?: string): string {
	return (
		override ??
		process.env.BOBBIT_BUILTIN_PACKS_DIR ??
		path.join(__dirname, "..", "builtin-packs", "market-packs")
	);
}

/**
 * Resolve every shipped first-party pack as an in-place {@link PackEntry}
 * (low→high within the band; sorted readdir order). No `.pack-meta.yaml` is
 * required — these are resolved in place, not installed (D1). A synthetic
 * `meta` marks provenance (`sourceUrl: "builtin:"`) so the Market UI can flag
 * `builtin: true`. Graceful on a missing dir (returns `[]`).
 */
/**
 * The stored disabled-entity refs relevant to effective-activation. Kept as a
 * structural subset of `DisabledRefs` so this module stays free of a
 * project-config-store dependency (avoids an import cycle).
 */
export interface PackEnableState {
	/** Explicit-enable sentinel for ships-disabled-by-default packs. */
	enabled?: boolean;
	/**
	 * Other stored disabled-entity refs (roles/tools/entrypoints/…) may also be
	 * present on the override. The effective-activation check reads ONLY
	 * `enabled`, but the wider shape is accepted so callers can pass a full
	 * `DisabledRefs` without a cast (and without importing it here — avoids a
	 * project-config-store import cycle).
	 */
	[kind: string]: unknown;
}

/**
 * Effective activation for a pack given its manifest + stored activation refs
 * — the single chokepoint (design option (a)) that all CONTRIBUTION enumerators
 * consult so a ships-disabled-by-default pack resolves NOTHING until explicitly
 * enabled.
 *
 * - Normal packs (`defaultDisabled` absent/false): always "enabled" here;
 *   per-entity disable refs still apply downstream (unchanged behaviour).
 * - Ships-disabled packs (`defaultDisabled === true`): enabled ONLY when an
 *   explicit `{ enabled: true }` override is stored; absence ⇒ OFF.
 *
 * NOTE: this gates whole-pack resolution, NOT the marketplace listing — the
 * Market UI enumerates built-in rows from the RAW
 * {@link builtinFirstPartyPackEntries}, so a disabled pack still shows a row +
 * toggle.
 */
export function isPackEffectivelyEnabled(
	manifest: Pick<PackManifest, "defaultDisabled"> | undefined,
	disabled: PackEnableState | undefined,
): boolean {
	if (!manifest?.defaultDisabled) return true;
	return disabled?.enabled === true;
}

/**
 * Built-in first-party pack entries filtered to only those effectively ENABLED
 * for CONTRIBUTION resolution (roles/tools/providers/entrypoints/routes/…). Use
 * this everywhere a built-in band feeds the resolution/contribution pipelines
 * (NOT the marketplace listing). `activationFor(packName)` returns the stored
 * server-scope activation refs for the pack (missing ⇒ default).
 */
export function activeBuiltinFirstPartyPackEntries(
	builtinPacksDir: string,
	activationFor: (packName: string) => PackEnableState | undefined,
): PackEntry[] {
	return builtinFirstPartyPackEntries(builtinPacksDir).filter((e) =>
		isPackEffectivelyEnabled(e.manifest, e.manifest ? activationFor(e.manifest.name) : undefined),
	);
}

export function builtinFirstPartyPackEntries(builtinPacksDir: string): PackEntry[] {
	let dirents: fs.Dirent[];
	try {
		dirents = fs.readdirSync(builtinPacksDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: PackEntry[] = [];
	for (const d of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!d.isDirectory() || d.name.startsWith(".")) continue;
		const dir = path.join(builtinPacksDir, d.name);
		const manifest = readManifest(dir);
		if (!manifest) continue; // not a pack ⇒ skip
		out.push({
			// `builtin-pack:` prefix keeps these distinguishable from
			// user-installed `market:server:<name>` entries in conflict reports/logs.
			id: `builtin-pack:${manifest.name}`,
			kind: "market", // flows through the same resolver/contribution machinery
			scope: BUILTIN_PACK_SCOPE, // §7: activation + ordering home
			path: dir, // contains a `market-packs` segment → §6 identity works unchanged
			readOnly: true,
			manifest,
			meta: {
				// synthetic provenance — NOT read from disk
				sourceUrl: "builtin:",
				sourceRef: "",
				commit: "",
				packName: manifest.name,
				version: manifest.version,
				installedAt: "",
				updatedAt: "",
				scope: BUILTIN_PACK_SCOPE,
			},
			layout: "defaults-tree",
			skillSource: "project",
		});
	}
	return out;
}
