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
import type { PackEntry } from "./pack-types.js";
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
