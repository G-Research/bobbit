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
	type RuntimeContribution,
	type ChannelContribution,
	type HookContribution,
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
	/** Resolve a managed runtime descriptor within a pack. */
	getRuntime(projectId: string | undefined, packId: string, runtimeId: string): RuntimeContribution | undefined;
	/** List active inert hook metadata across all active packs. */
	listHooks(projectId: string | undefined): HookContribution[];
	/** Resolve a channel handler within a pack. */
	getChannel(projectId: string | undefined, packId: string, name: string): ChannelContribution | undefined;
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
/** Explicit durable config lookup result. `error` is deliberately distinct from
 * `absent`: a provider must not start with defaults when its stored config is
 * unreadable. The diagnostic is an already-sanitized StoreRead diagnostic. */
export type ProviderConfigOverrideReadResult =
	| { state: "absent" }
	| { state: "present"; value: Record<string, unknown> }
	| { state: "error"; diagnostic: { code: string; retryable: boolean } };

/** Legacy record/undefined returns remain accepted while callers migrate. */
export type ProviderConfigOverrideLookupResult =
	| ProviderConfigOverrideReadResult
	| Record<string, unknown>
	| undefined;

export type ProviderConfigOverrideLookup = (
	scope: PackScope,
	projectId: string | undefined,
	packId: string,
	providerId: string,
) => ProviderConfigOverrideLookupResult;

/** Project settings targets the contribution registry may activate. `pack` is a
 * control lookup only: persisted setting target identities remain provider/hook. */
export type ProjectExtensionSettingsTargetKind = "pack" | "provider" | "hook";

/** Runtime-only effective settings for one project target. `values` can contain
 * secret bytes, so this contract must never be used by a public/API projection. */
export type ProjectExtensionSettingsReadResult =
	| { state: "absent" }
	| { state: "present"; enabled: boolean; values: Record<string, unknown> }
	| { state: "error"; diagnostic: { code: string; retryable: boolean } };

/** Optional synchronous bridge to project-scoped extension settings. `absent`
 * means there is no project target record, which deliberately permits the legacy
 * provider config fallback. `error` is fail-closed and is never treated as
 * defaults/absent. The lookup owns project isolation and may merge runtime-only
 * secret values into its returned `values`. */
export type ProjectExtensionSettingsLookup = (
	projectId: string | undefined,
	packId: string,
	kind: ProjectExtensionSettingsTargetKind,
	/** Omitted for the pack-level enablement control. */
	id?: string,
) => ProjectExtensionSettingsReadResult | undefined;

interface IndexedScope {
	list: PackContributions[];
	byId: Map<string, PackContributions>;
	/** Never retain an index built from unreadable durable config: the next
	 * lookup must retry rather than leaving a provider permanently stale. */
	retryableConfigError: boolean;
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
		private readonly disabledProviders?: DisabledEntrypointsLookup,
		private readonly providerConfigOverrides?: ProviderConfigOverrideLookup,
		private readonly disabledHooks?: DisabledEntrypointsLookup,
		// Reserved positional EP-6 seams remain intentionally inert here; this
		// integration only consumes the public EP-7 settings lookup.
		_unusedDisabledSystemPrompts?: DisabledEntrypointsLookup,
		_unusedSystemPromptAuthorization?: unknown,
		private readonly projectExtensionSettings?: ProjectExtensionSettingsLookup,
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

	listProviders(projectId: string | undefined): ProviderContribution[] {
		return this.index(projectId).list.flatMap((pack) => pack.providers);
	}

	getRuntime(projectId: string | undefined, packId: string, runtimeId: string): RuntimeContribution | undefined {
		// Runtime ids are canonicalised by the schema-2 loader and provider loader;
		// keep this read-only registry lookup equally case-stable for host callers.
		return this.getPack(projectId, packId)?.runtimes.find((runtime) => runtime.id === runtimeId.toLowerCase());
	}

	listHooks(projectId: string | undefined): HookContribution[] {
		return this.index(projectId).list.flatMap((pack) => pack.hooks);
	}

	getChannel(projectId: string | undefined, packId: string, name: string): ChannelContribution | undefined {
		return this.getPack(projectId, packId)?.channels.find((c) => c.name === name);
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
		if (!built.retryableConfigError) this.cache.set(key, built);
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
		let retryableConfigError = false;
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
			// Project settings are evaluated only after installed-pack enumeration has
			// selected the winning pack, so they can never revive an uninstalled or
			// pack_activation-disabled contribution. A failed public settings read is
			// fail-closed for the entire pack (including its panels/routes).
			const packSettings = readProjectExtensionSettings(
				this.projectExtensionSettings,
				projectId,
				contrib.packId,
				"pack",
			);
			if (packSettings.state === "error") {
				retryableConfigError = true;
				console.warn(`[pack-contributions] project settings unavailable packId=${contrib.packId} code=${safeDiagnosticCode(packSettings.diagnostic)}`);
				continue;
			}
			if (packSettings.state === "present" && !packSettings.enabled) continue;

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
			// (`activation.requiresConfig`) against that effective config. Steps (2)+(3)
			// run for EVERY provider — a provider with no overrides + no requiresConfig
			// is unchanged.
			const disabledProviders = this.disabledProviders
				? new Set(this.disabledProviders(e.scope, projectId, contrib.packName))
				: undefined;
			const resolvedProviders: ProviderContribution[] = [];
			for (const p of contrib.providers) {
				// The loader owns schema validation. A rejected declaration is never
				// allowed to reach config overlays, activation, or runtime authorization consumers.
				// Deliberately do not log its diagnostic: it can contain pack-controlled text.
				if (p.settingsSchemaDiagnostic !== undefined) continue;
				if (disabledProviders?.has(p.listName)) continue; // DisabledRefs kill-switch

				// A project target, when present, supersedes legacy PackStore overrides.
				// This is specifically important for clearing a migrated setting: a
				// project-owned empty target must not resurrect its old global value.
				const projectSettings = readProjectExtensionSettings(
					this.projectExtensionSettings,
					projectId,
					contrib.packId,
					"provider",
					p.id,
				);
				if (projectSettings.state === "error") {
					retryableConfigError = true;
					console.warn(`[pack-contributions] project settings unavailable packId=${contrib.packId} providerId=${p.id} code=${safeDiagnosticCode(projectSettings.diagnostic)}`);
					continue;
				}
				if (projectSettings.state === "present" && !projectSettings.enabled) continue;

				const defaults = p.config ?? {};
				const configRead = projectSettings.state === "present"
					? { state: "present" as const, value: projectSettings.values }
					: this.providerConfigOverrides?.(e.scope, projectId, contrib.packId, p.id);
				const normalized = normalizeProviderConfigRead(configRead);
				if (normalized.state === "error") {
					// Fail closed: an unreadable durable config is not the same as an
					// absent config. Do not activate with defaults or cache this result;
					// subsequent registry calls deliberately retry the store read.
					retryableConfigError = true;
					console.warn(`[pack-contributions] provider config unavailable packId=${contrib.packId} providerId=${p.id} code=${safeDiagnosticCode(normalized.diagnostic)}`);
					continue;
				}
				const overrides = normalized.state === "present" ? normalized.value : undefined;
				const hasOverrides = !!overrides && Object.keys(overrides).length > 0;
				const effective = hasOverrides ? { ...defaults, ...overrides } : defaults;
				const provider = hasOverrides ? { ...p, config: effective } : p;
				if (!providerActivationSatisfied(provider)) continue; // dormant until configured
				resolvedProviders.push(provider);
			}
			if (resolvedProviders.length !== contrib.providers.length || resolvedProviders.some((p, i) => p !== contrib.providers[i])) {
				contrib = { ...contrib, providers: resolvedProviders };
			}
			// Hook declarations remain inert metadata. Activation only filters their
			// manifest listName; it never evaluates config or confers capabilities.
			const disabledHooks = this.disabledHooks
				? new Set(this.disabledHooks(e.scope, projectId, contrib.packName))
				: undefined;
			if (disabledHooks && disabledHooks.size > 0) {
				contrib = { ...contrib, hooks: contrib.hooks.filter((hook) => !disabledHooks.has(hook.listName)) };
			}
			const resolvedHooks: HookContribution[] = [];
			for (const hook of contrib.hooks) {
				if (hook.settingsSchemaDiagnostic !== undefined) continue;
				const projectSettings = readProjectExtensionSettings(this.projectExtensionSettings, projectId, contrib.packId, "hook", hook.id);
				if (projectSettings.state === "error") {
					retryableConfigError = true;
					console.warn(`[pack-contributions] project settings unavailable packId=${contrib.packId} hookId=${hook.id} code=${safeDiagnosticCode(projectSettings.diagnostic)}`);
					continue;
				}
				if (projectSettings.state !== "present" || projectSettings.enabled) resolvedHooks.push(hook);
			}
			if (resolvedHooks.length !== contrib.hooks.length) contrib = { ...contrib, hooks: resolvedHooks };

			const authorizedChannels = authorizeChannelCapabilities(e, contrib.channels);
			if (authorizedChannels !== contrib.channels) contrib = { ...contrib, channels: authorizedChannels };
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
		return { list: filtered, byId, retryableConfigError };
	}
}

/** Preserve declared channel capabilities for installed/enabled packs.
 *  `sessionPty` authorization is the explicit channel declaration itself;
 *  runtime session restrictions remain in ChannelPtyService. */
function authorizeChannelCapabilities(_entry: PackEntry, channels: ChannelContribution[]): ChannelContribution[] {
	return channels;
}

/** Read and defensively validate a runtime-only project settings target. Storage
 * implementations may throw on a public or secret read; the registry must never
 * turn that into defaults, and must not expose a backend error's message/path. */
function readProjectExtensionSettings(
	lookup: ProjectExtensionSettingsLookup | undefined,
	projectId: string | undefined,
	packId: string,
	kind: ProjectExtensionSettingsTargetKind,
	id?: string,
): ProjectExtensionSettingsReadResult {
	if (!lookup) return { state: "absent" };
	try {
		const result = lookup(projectId, packId, kind, id);
		if (!result || result.state === "absent") return { state: "absent" };
		if (result.state === "error") {
			return isStoreReadDiagnostic(result.diagnostic)
				? result
				: { state: "error", diagnostic: { code: "SETTINGS_READ_UNAVAILABLE", retryable: true } };
		}
		if (result.state === "present") {
			return typeof result.enabled === "boolean" && isFlatConfig(result.values)
				? result
				: { state: "error", diagnostic: { code: "SETTINGS_READ_INVALID", retryable: false } };
		}
	} catch {
		// Deliberately do not log the thrown error: secret-store implementations can
		// include user-controlled bytes in their error messages.
	}
	return { state: "error", diagnostic: { code: "SETTINGS_READ_UNAVAILABLE", retryable: true } };
}

/** True when a provider's `activation.requiresConfig` is satisfied by its EFFECTIVE
 *  flat config — every required key present and, for a string, non-empty after
 *  trimming. No `activation` (or empty `requiresConfig`) ⇒ unconditionally active. */
function normalizeProviderConfigRead(value: ProviderConfigOverrideLookupResult): ProviderConfigOverrideReadResult {
	if (!value) return { state: "absent" };
	if (typeof value === "object" && "state" in value) {
		const state = (value as { state?: unknown }).state;
		if (state === "absent") return { state };
		if (state === "error") {
			const diagnostic = (value as { diagnostic?: unknown }).diagnostic;
			return isStoreReadDiagnostic(diagnostic)
				? { state, diagnostic }
				: { state, diagnostic: { code: "STORE_READ_UNAVAILABLE", retryable: true } };
		}
		if (state === "present") {
			const present = (value as { value?: unknown }).value;
			if (isFlatConfig(present)) return { state, value: present };
			return { state: "error", diagnostic: { code: "STORE_READ_INVALID_CONFIG", retryable: false } };
		}
	}
	// Compatibility for pre-UH-1 registry callers which returned an override
	// record directly. Records containing a `state` field are still config values
	// unless that field is one of the recognized result tags above.
	return isFlatConfig(value)
		? { state: "present", value }
		: { state: "error", diagnostic: { code: "STORE_READ_INVALID_CONFIG", retryable: false } };
}

function isStoreReadDiagnostic(value: unknown): value is { code: string; retryable: boolean } {
	return !!value && typeof value === "object"
		&& typeof (value as { code?: unknown }).code === "string"
		&& typeof (value as { retryable?: unknown }).retryable === "boolean";
}

function isFlatConfig(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Only expose a stable identifier in lifecycle diagnostics, never a filesystem
 * path or raw error text potentially carried by a failed storage backend. */
function safeDiagnosticCode(diagnostic: unknown): string {
	const code = diagnostic && typeof diagnostic === "object"
		? (diagnostic as { code?: unknown }).code
		: undefined;
	return typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code)
		? code
		: "STORE_READ_UNAVAILABLE";
}

function providerActivationSatisfied(provider: ProviderContribution): boolean {
	const required = provider.activation?.requiresConfig;
	if (!required || required.length === 0) return true;
	const config = provider.config ?? {};
	return required.every((key) => {
		const value = config[key];
		if (value === undefined || value === null) return false;
		if (typeof value === "string") return value.trim().length > 0;
		return true;
	});
}
