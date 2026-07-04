// src/server/extension-host/pack-contribution-registry.ts
//
// Project-scoped registry of the PACK-SCOPED contributions (panels / entrypoints
// / providers / channels / routes), the pack-scoped analogue of the tool cascade
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
	type ProviderContribution,
	type ChannelContribution,
	type RuntimeContribution,
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
	/** List active provider contributions across all active packs. */
	listProviders(projectId: string | undefined): ProviderContribution[];
	/** Resolve a channel handler within a pack. */
	getChannel(projectId: string | undefined, packId: string, name: string): ChannelContribution | undefined;
	/** Resolve a runtime descriptor within a pack. */
	getRuntime(projectId: string | undefined, packId: string, runtimeId: string): RuntimeContribution | undefined;
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

/** Synchronous lookup of a provider's PERSISTED flat config overrides (store
 *  config) for an install scope + project + pack + provider. `packId` is the
 *  SERVER-DERIVED pack identity (the pack store is keyed by it, NOT by packName).
 *  Overlaid ON TOP of the provider's schema-default flat config to form the
 *  effective config the Hub hands to the provider AND the config-gated activation
 *  filter evaluates. Absent / returns undefined ⇒ no overrides (schema defaults
 *  only). Must be synchronous: `listProviders` feeds the sync session-setup
 *  bridge-injection decision. */
export type ProviderConfigOverrideLookup = (
	scope: PackScope,
	projectId: string | undefined,
	packId: string,
	providerId: string,
) => Record<string, unknown> | undefined;

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
	 * @param disabledRuntimes  Disabled-runtime activation override lookup (DisabledRefs.runtimes).
	 *                          A disabled runtime is dropped from `getPack().runtimes` /
	 *                          `getRuntime`, so the supervisor's registry lookup 404s and
	 *                          runtime listings omit it. Absent ⇒ all enabled.
	 */
	constructor(
		private readonly enumerate: (projectId: string | undefined) => PackEntry[],
		private readonly disabledEntrypoints?: DisabledEntrypointsLookup,
		private readonly disabledProviders?: DisabledEntrypointsLookup,
		private readonly providerConfigOverrides?: ProviderConfigOverrideLookup,
		private readonly disabledRuntimes?: DisabledEntrypointsLookup,
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

	/**
	 * A single pack's RAW (activation-UNFILTERED) contributions, or undefined when
	 * the pack is not installed. Unlike {@link getPack}, this does NOT drop dormant
	 * providers (those whose `activation` gate is unsatisfied), disabled entrypoints,
	 * or disabled runtimes — it returns exactly what `loadPackContributions` parses
	 * from disk for the WINNING pack entry (highest precedence per packId).
	 *
	 * Used by the managed-runtime REST surface (`/api/pack-runtimes/:id/{capabilities,
	 * start,restart}`) to CLASSIFY the deployment mode/config from a pack whose
	 * provider is still dormant — e.g. Hindsight's external-mode `memory` provider,
	 * which only activates once `externalUrl` is configured. Reading the
	 * activation-filtered `getPack` there would misclassify fresh/default Hindsight as
	 * provider-less and disclose / start the Docker default mode instead of the
	 * external (no-Docker) setup path. Actual runtime availability (disabled-runtime
	 * filtering) stays enforced by the supervisor's activation-filtered registry
	 * lookups, NOT by this method. Providers carry their SCHEMA-DEFAULT flat config
	 * (`config`); callers overlay persisted store config themselves.
	 */
	getRawPack(projectId: string | undefined, packId: string): PackContributions | undefined {
		const entries = this.enumerate(projectId);
		let winning: PackEntry | undefined;
		for (const e of entries) {
			if (!e.manifest) continue;
			if (packIdFromRoot(e.path) !== packId) continue;
			winning = e; // last wins (highest precedence)
		}
		if (!winning?.manifest) return undefined;
		try {
			return loadPackContributions(winning.path, winning.manifest);
		} catch (err) {
			if (err instanceof PackContributionError) {
				console.error(`[pack-contributions] rejecting pack at ${winning.path}: ${err.message}`);
				return undefined;
			}
			throw err;
		}
	}

	getPanel(projectId: string | undefined, packId: string, panelId: string): PanelContribution | undefined {
		return this.getPack(projectId, packId)?.panels.find((p) => p.id === panelId);
	}

	getEntrypoint(projectId: string | undefined, packId: string, entrypointId: string): EntrypointContribution | undefined {
		return this.getPack(projectId, packId)?.entrypoints.find((e) => e.id === entrypointId);
	}

	listProviders(projectId: string | undefined): ProviderContribution[] {
		return this.index(projectId).list.flatMap((pack) => pack.providers);
	}

	getChannel(projectId: string | undefined, packId: string, name: string): ChannelContribution | undefined {
		return this.getPack(projectId, packId)?.channels.find((c) => c.name === name);
	}

	getRuntime(projectId: string | undefined, packId: string, runtimeId: string): RuntimeContribution | undefined {
		return this.getPack(projectId, packId)?.runtimes.find((r) => r.id === runtimeId);
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
			// Providers: (1) drop entries disabled via pack_activation (DisabledRefs
			// wins), (2) overlay persisted store config on the schema-default flat
			// config to form the effective config, (3) apply config-gated activation
			// (`activation.requiresConfig` / `activation.activeWhenConfig`) against that
			// effective config. Steps (2)+(3) run for EVERY provider — a provider with no
			// overrides + no activation gate is unchanged.
			const disabledProviders = this.disabledProviders
				? new Set(this.disabledProviders(e.scope, projectId, contrib.packName))
				: undefined;
			const resolvedProviders: ProviderContribution[] = [];
			for (const p of contrib.providers) {
				if (disabledProviders?.has(p.listName)) continue; // DisabledRefs kill-switch
				const defaults = p.config ?? {};
				const overrides = this.providerConfigOverrides?.(e.scope, projectId, contrib.packId, p.id);
				const hasOverrides = !!overrides && Object.keys(overrides).length > 0;
				const effective = hasOverrides ? { ...defaults, ...overrides } : defaults;
				const provider = hasOverrides ? { ...p, config: effective } : p;
				if (!providerActivationSatisfied(provider)) continue; // dormant until configured
				resolvedProviders.push(provider);
			}
			if (resolvedProviders.length !== contrib.providers.length || resolvedProviders.some((p, i) => p !== contrib.providers[i])) {
				contrib = { ...contrib, providers: resolvedProviders };
			}
			const authorizedChannels = authorizeChannelCapabilities(e, contrib.channels);
			if (authorizedChannels !== contrib.channels) contrib = { ...contrib, channels: authorizedChannels };
			// Runtimes: drop entries disabled via pack_activation (DisabledRefs.runtimes
			// kill-switch), keyed by listName — mirrors the entrypoint/provider toggles.
			// A disabled managed runtime is absent from `getPack().runtimes` /
			// `getRuntime`, so the PackRuntimeSupervisor's registry lookup 404s
			// (start/stop/capabilities reject) and runtime listings omit it; managed
			// runtime dormancy is a deliberate activation decision.
			const disabledRuntimes = this.disabledRuntimes
				? new Set(this.disabledRuntimes(e.scope, projectId, contrib.packName))
				: undefined;
			if (disabledRuntimes && disabledRuntimes.size > 0) {
				contrib = { ...contrib, runtimes: contrib.runtimes.filter((r) => !disabledRuntimes.has(r.listName)) };
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

/** Preserve declared channel capabilities for installed/enabled packs.
 *  `sessionPty` authorization is the explicit channel declaration itself;
 *  runtime session restrictions remain in ChannelPtyService. */
function authorizeChannelCapabilities(_entry: PackEntry, channels: ChannelContribution[]): ChannelContribution[] {
	return channels;
}

/** True when a provider's `activation` gate is satisfied by its EFFECTIVE flat
 *  config. No `activation` ⇒ unconditionally active. Otherwise, in priority order:
 *
 *    1. `activeWhenConfig` (OR escape hatch / deployment-mode linkage): if ANY
 *       listed key's effective value is in its allowed-value list, the provider is
 *       active — this is what lets a managed deployment mode activate without an
 *       external URL.
 *    2. `requiresConfig` (AND gate): every listed key present and, for a string,
 *       non-empty after trimming.
 *
 *  When `activeWhenConfig` is declared but unmatched AND there is no `requiresConfig`
 *  to fall back on, the provider stays dormant (the gate was declared for a reason). */
function providerActivationSatisfied(provider: ProviderContribution): boolean {
	const activation = provider.activation;
	if (!activation) return true;
	const config = provider.config ?? {};
	const { activeWhenConfig, requiresConfig } = activation;
	if (activeWhenConfig) {
		for (const [key, allowed] of Object.entries(activeWhenConfig)) {
			const value = config[key];
			if (typeof value === "string" && allowed.includes(value)) return true;
		}
	}
	if (!requiresConfig || requiresConfig.length === 0) {
		// No AND gate: an unmatched `activeWhenConfig` means dormant; otherwise active.
		return !activeWhenConfig;
	}
	return requiresConfig.every((key) => {
		const value = config[key];
		if (value === undefined || value === null) return false;
		if (typeof value === "string") return value.trim().length > 0;
		return true;
	});
}
