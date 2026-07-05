/**
 * One-time boot seed for first-party packs that ship PRESENT but DISABLED by
 * default (opt-in).
 *
 * Bobbit's pack activation model is subtractive: a pack's entities are enabled
 * unless explicitly listed in `pack_activation`'s DisabledRefs. Built-in
 * first-party packs (resolved in place by {@link builtinFirstPartyPackEntries})
 * are therefore ENABLED by default. To ship a built-in that is OFF until the
 * user flips the Market "Built-in" toggle, we seed a server-scope
 * `pack_activation` entry that disables every toggleable entity the pack
 * declares — exactly once.
 *
 * A durable marker (`<stateDir>/builtin-pack-defaults.json`, mirroring the
 * per-project migration-marker pattern) records which packs have been seeded so
 * we NEVER re-disable a pack after the user has enabled it (enabling clears the
 * DisabledRefs; the marker keeps it enabled across restarts).
 *
 * Invariants: idempotent, never throws on boot (callers wrap defensively too),
 * server scope only, and a no-op when the pack is not actually shipped as a
 * built-in.
 */

import fs from "node:fs";
import path from "node:path";
import { builtinFirstPartyPackEntries, resolveBuiltinPacksDir } from "./builtin-packs.js";
import { loadPackContributions } from "./pack-contributions.js";
import type { DisabledRefs, ProjectConfigStore } from "./project-config-store.js";

/**
 * First-party built-in packs that ship DISABLED by default. Only packs listed
 * here are opt-in; every other built-in stays enabled-by-default. Keep this
 * list minimal — opt-in is the exception, not the rule.
 */
export const FIRST_PARTY_PACKS_DISABLED_BY_DEFAULT = ["experiment-runner"] as const;

/** Durable seed marker filename under the server state dir. */
export const BUILTIN_PACK_DEFAULTS_MARKER = "builtin-pack-defaults.json";

interface SeedMarker {
	seeded: string[];
}

function markerPath(stateDir: string): string {
	return path.join(stateDir, BUILTIN_PACK_DEFAULTS_MARKER);
}

function readMarker(stateDir: string): SeedMarker {
	try {
		const raw = fs.readFileSync(markerPath(stateDir), "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && Array.isArray((parsed as SeedMarker).seeded)) {
			const seeded = (parsed as SeedMarker).seeded.filter((x): x is string => typeof x === "string");
			return { seeded };
		}
	} catch {
		/* missing/malformed ⇒ nothing seeded yet */
	}
	return { seeded: [] };
}

function writeMarker(stateDir: string, marker: SeedMarker): void {
	fs.mkdirSync(stateDir, { recursive: true });
	fs.writeFileSync(markerPath(stateDir), JSON.stringify(marker, null, 2), "utf-8");
}

/**
 * Compute the DisabledRefs that disable EVERY toggleable entity a built-in
 * declares — read from the manifest contents + entrypoint listNames (resolved
 * via {@link loadPackContributions}, exactly as the activation-catalogue
 * endpoint does).
 */
export function buildFullyDisabledRefs(entry: { path: string; manifest?: { contents: { roles: string[]; tools: string[]; skills: string[]; entrypoints?: string[]; providers?: string[]; mcp?: string[]; piExtensions?: string[]; runtimes?: string[] } } }): DisabledRefs {
	const manifest = entry.manifest;
	if (!manifest) return {};
	const c = manifest.contents;
	let entrypoints: string[] = [...(c.entrypoints ?? [])];
	try {
		// Prefer the resolved, valid entrypoint listNames (same source the
		// activation catalogue uses) so we disable launchers + deep-links.
		const resolved = loadPackContributions(entry.path, manifest as never).entrypoints.map((e) => e.listName);
		if (resolved.length > 0) entrypoints = resolved;
	} catch {
		/* fall back to declared listNames */
	}
	// `hooks`/`workflows` are excluded (finding EXT-03): neither is
	// activation-toggleable (see ACTIVATION_KINDS in project-config-store.ts).
	return {
		roles: [...c.roles],
		tools: [...c.tools],
		skills: [...c.skills],
		entrypoints,
		providers: [...(c.providers ?? [])],
		mcp: [...(c.mcp ?? [])],
		piExtensions: [...(c.piExtensions ?? [])],
		runtimes: [...(c.runtimes ?? [])],
	};
}

/**
 * Seed server-scope `pack_activation` so each {@link
 * FIRST_PARTY_PACKS_DISABLED_BY_DEFAULT} pack ships disabled — exactly once per
 * install. Idempotent and defensive; never throws.
 *
 * @returns the list of pack names newly seeded this call (for logging/tests).
 */
export function seedBuiltinPackDefaults(opts: {
	stateDir: string;
	store: Pick<ProjectConfigStore, "getPackActivation" | "setPackActivation">;
	builtinPacksDir?: string;
}): string[] {
	const { stateDir, store } = opts;
	const newlySeeded: string[] = [];
	try {
		const builtinPacksDir = opts.builtinPacksDir ?? resolveBuiltinPacksDir();
		const marker = readMarker(stateDir);
		const seeded = new Set(marker.seeded);
		const builtinEntries = builtinFirstPartyPackEntries(builtinPacksDir);
		let changed = false;

		for (const packName of FIRST_PARTY_PACKS_DISABLED_BY_DEFAULT) {
			// Already handled in a prior boot ⇒ never re-disable.
			if (seeded.has(packName)) continue;
			// Not actually shipped as a built-in ⇒ do nothing (and do NOT mark, so
			// it gets seeded later if/when it ships).
			const entry = builtinEntries.find((e) => e.manifest?.name === packName);
			if (!entry || !entry.manifest) continue;

			// Respect an existing admin/user decision: only disable when there is no
			// server-scope activation entry yet. Either way the pack is now handled,
			// so record the marker to prevent any future re-disable.
			const existing = store.getPackActivation("server", packName);
			if (Object.keys(existing).length === 0) {
				const disabled = buildFullyDisabledRefs(entry as { path: string; manifest: typeof entry.manifest });
				store.setPackActivation("server", packName, disabled);
				newlySeeded.push(packName);
				console.log(`[builtin-pack-defaults] seeded "${packName}" as disabled-by-default (opt-in)`);
			}
			seeded.add(packName);
			changed = true;
		}

		if (changed) writeMarker(stateDir, { seeded: [...seeded] });
	} catch (err) {
		console.warn(`[builtin-pack-defaults] seed skipped: ${String(err)}`);
	}
	return newlySeeded;
}
