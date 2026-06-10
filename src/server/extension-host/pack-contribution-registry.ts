// src/server/extension-host/pack-contribution-registry.ts
//
// Project-scoped registry of the PACK-SCOPED contributions (panels / entrypoints
// / routes), the pack-scoped analogue of the tool cascade
// (pack-schema-v1-rationalisation §5.2).
//
// It enumerates installed market packs (the SAME enumeration the tool cascade
// uses), collapses to the WINNING pack per `packId` BEFORE indexing (§5.2.1 — so
// a project-scope pack shadows a same-named global-user pack and only the winner
// contributes), applies activation filtering (disabled entrypoints dropped, §7),
// detects the cross-pack duplicate-`routeId` hard conflict (§5.4.2), and serves
// `getPack`/`getPanel`/`getEntrypoint`/`hasRoute`/`list` from the collapsed,
// filtered, per-project index. The cache is dropped by `invalidate()` inside
// `invalidateResolverCaches()`.

import {
	loadPackContributions,
	packIdFromRoot,
	PackContributionError,
	type PackContributions,
	type PanelContribution,
	type EntrypointContribution,
} from "../agent/pack-contributions.js";
import type { PackEntry, PackScope } from "../agent/pack-types.js";

/** The read interface scoped Host API + the RouteRegistry depend on. */
export interface PackContributionResolver {
	/** All active packs' contributions for a project scope (low→high precedence). */
	list(projectId: string | undefined): PackContributions[];
	/** A single pack's contributions, or undefined when not installed/active. */
	getPack(projectId: string | undefined, packId: string): PackContributions | undefined;
	/** Resolve a panel within a pack. */
	getPanel(projectId: string | undefined, packId: string, panelId: string): PanelContribution | undefined;
	/** Resolve an entrypoint within a pack. */
	getEntrypoint(projectId: string | undefined, packId: string, entrypointId: string): EntrypointContribution | undefined;
	/** True when the pack declares routeName in its routes.names allowlist. */
	hasRoute(projectId: string | undefined, packId: string, routeName: string): boolean;
}

/** A resolver for the disabled-entrypoint activation overrides (listName values)
 *  for a given install scope + project + pack name. Default (absent / returns
 *  empty) = all enabled. */
export type DisabledEntrypointsLookup = (
	scope: PackScope,
	projectId: string | undefined,
	packName: string,
) => Iterable<string>;

interface IndexedScope {
	list: PackContributions[];
	byId: Map<string, PackContributions>;
}

const DEFAULT_KEY = "\u0000default";

export class PackContributionRegistry implements PackContributionResolver {
	private cache = new Map<string, IndexedScope>();

	/**
	 * @param enumerate  Returns the installed market-pack entries for a project
	 *                   scope, low→high precedence, already deduped-on-path
	 *                   (mirrors `marketToolRoots`).
	 * @param disabledEntrypoints  Activation override lookup (§7). Absent ⇒ all enabled.
	 */
	constructor(
		private readonly enumerate: (projectId: string | undefined) => PackEntry[],
		private readonly disabledEntrypoints?: DisabledEntrypointsLookup,
	) {}

	/** Drop the per-project index cache (rebuilt lazily on next read). */
	invalidate(): void {
		this.cache = new Map();
	}

	list(projectId: string | undefined): PackContributions[] {
		return this.index(projectId).list;
	}

	getPack(projectId: string | undefined, packId: string): PackContributions | undefined {
		return this.index(projectId).byId.get(packId);
	}

	getPanel(projectId: string | undefined, packId: string, panelId: string): PanelContribution | undefined {
		return this.getPack(projectId, packId)?.panels.find((p) => p.id === panelId);
	}

	getEntrypoint(projectId: string | undefined, packId: string, entrypointId: string): EntrypointContribution | undefined {
		return this.getPack(projectId, packId)?.entrypoints.find((e) => e.id === entrypointId);
	}

	hasRoute(projectId: string | undefined, packId: string, routeName: string): boolean {
		const routes = this.getPack(projectId, packId)?.routes;
		return !!routes && routes.names.includes(routeName);
	}

	private index(projectId: string | undefined): IndexedScope {
		const key = projectId ?? DEFAULT_KEY;
		const hit = this.cache.get(key);
		if (hit) return hit;
		const built = this.build(projectId);
		this.cache.set(key, built);
		return built;
	}

	private build(projectId: string | undefined): IndexedScope {
		// 1. Enumerate low→high, then collapse to the WINNING entry per packId
		//    (keep the LAST = highest precedence). §5.2.1.
		const entries = this.enumerate(projectId);
		const winning = new Map<string, PackEntry>();
		for (const e of entries) {
			if (!e.manifest) continue;
			const packId = packIdFromRoot(e.path);
			if (!packId) continue;
			winning.set(packId, e); // last wins (highest precedence)
		}

		// 2. Load + activation-filter each winning pack. Intra-pack hard conflicts
		//    (dup panel/entrypoint/route name) reject that pack (drop + loud error).
		const loaded: PackContributions[] = [];
		for (const e of winning.values()) {
			let contrib: PackContributions;
			try {
				contrib = loadPackContributions(e.path, e.manifest!);
			} catch (err) {
				if (err instanceof PackContributionError) {
					console.error(`[pack-contributions] rejecting pack at ${e.path}: ${err.message}`);
					continue;
				}
				throw err;
			}
			// Activation filtering (§7): drop disabled entrypoints by listName.
			const disabled = this.disabledEntrypoints
				? new Set(this.disabledEntrypoints(e.scope, projectId, contrib.packName))
				: undefined;
			if (disabled && disabled.size > 0) {
				contrib = { ...contrib, entrypoints: contrib.entrypoints.filter((ep) => !disabled.has(ep.listName)) };
			}
			loaded.push(contrib);
		}

		// 3. Cross-pack duplicate-routeId hard conflict (§5.4.2): register NEITHER.
		const routeIdOwners = new Map<string, string[]>();
		for (const pack of loaded) {
			for (const ep of pack.entrypoints) {
				if (ep.kind === "route" && ep.routeId) {
					const owners = routeIdOwners.get(ep.routeId) ?? [];
					owners.push(pack.packId);
					routeIdOwners.set(ep.routeId, owners);
				}
			}
		}
		const conflictingRouteIds = new Set<string>();
		for (const [routeId, owners] of routeIdOwners) {
			if (owners.length > 1) {
				conflictingRouteIds.add(routeId);
				console.error(
					`[pack-contributions] host-global routeId "${routeId}" claimed by multiple packs (${owners.join(", ")}); registering NEITHER deep-link`,
				);
			}
		}
		const filtered = conflictingRouteIds.size === 0
			? loaded
			: loaded.map((pack) => ({
				...pack,
				entrypoints: pack.entrypoints.filter(
					(ep) => !(ep.kind === "route" && ep.routeId && conflictingRouteIds.has(ep.routeId)),
				),
			}));

		const byId = new Map<string, PackContributions>();
		for (const pack of filtered) byId.set(pack.packId, pack);
		return { list: filtered, byId };
	}
}
