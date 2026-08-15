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
	type HookContribution,
	type SystemPromptSectionContribution,
	type ServiceExtensionContribution,
	type SandboxRequirementContribution,
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
	/** List active inert hook metadata across all active packs. */
	listHooks(projectId: string | undefined): HookContribution[];
	/** List active declarative service extensions across winning packs. Optional so
	 * existing resolver fakes remain source-compatible during adoption. */
	listServiceExtensions?(projectId: string | undefined): ServiceExtensionContribution[];
	/** List active, authorized core-toolchain requests. Optional preserves existing
	 * resolver fakes until sandbox requirement consumers are wired. */
	listSandboxRequirements?(projectId: string | undefined): ActiveSandboxRequirement[];
	/** List active, runnable every-N-turn advisor declarations. */
	listScheduledAdvisorHooks(projectId: string | undefined): HookContribution[];
	/** List active scheduled decision declarations due at the server-owned turn index. */
	listScheduledDecisionHooks(projectId: string | undefined, turnIndex: number): HookContribution[];
	/** List active, explicitly authorized static prompt sections in pack-priority order.
	 * Optional so existing resolver fakes stay source-compatible during adoption. */
	listSystemPromptSections?(projectId: string | undefined): ActiveSystemPromptSection[];
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

/** Exact live `sandbox:build` authorization for an installed winning pack.
 * Missing lookup is denial: a declaration alone must never affect an image. */
export type SandboxRequirementAuthorizationLookup = (
	projectId: string | undefined,
	packId: string,
) => boolean;

/** The public, deterministic projection supplied to the core image-plan resolver. */
export interface ActiveSandboxRequirement {
	packId: string;
	requirementId: string;
	profiles: readonly ("python")[];
}

/** Per-project EP-6 authorization for static prompt text. Absence is a denial;
 * activation alone must never make a pack's instructions effective. */
export type SystemPromptStaticAuthorizationLookup = (
	projectId: string | undefined,
	packId: string,
	/** Loaded winning-pack hooks; lets project authorization revalidate its principal. */
	activeHooks?: readonly HookContribution[],
) => boolean;

/** The deterministic, active registry projection consumed by the sole prompt
 * assembler. `sectionId`, not the display title, is the stable identity. */
export type ActiveSystemPromptSection = Omit<SystemPromptSectionContribution, "id"> & {
	packId: string;
	packName: string;
	sectionId: string;
};

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
export type ProjectExtensionSettingsTargetKind = "pack" | "provider" | "hook" | "runtime";

type ExtendedProjectExtensionSettingsLookup = (
	projectId: string | undefined,
	packId: string,
	kind: ProjectExtensionSettingsTargetKind | "sandboxRequirement",
	id?: string,
) => ProjectExtensionSettingsReadResult | undefined;

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
	/** A transient settings read failure leaves this index uncached so the next
	 * lookup can retry; permanent failures remain cached and fail closed. */
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
		private readonly disabledSystemPrompts?: DisabledEntrypointsLookup,
		private readonly hasSystemPromptStaticAuthorization?: SystemPromptStaticAuthorizationLookup,
		private readonly projectExtensionSettings?: ProjectExtensionSettingsLookup,
		private readonly disabledRuntimes?: DisabledEntrypointsLookup,
		private readonly disabledSandboxRequirements?: DisabledEntrypointsLookup,
		private readonly hasSandboxRequirementAuthorization?: SandboxRequirementAuthorizationLookup,
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

	listHooks(projectId: string | undefined): HookContribution[] {
		return this.index(projectId).list.flatMap((pack) => pack.hooks);
	}

	listServiceExtensions(projectId: string | undefined): ServiceExtensionContribution[] {
		return this.index(projectId).list.flatMap((pack) => pack.runtimes);
	}

	listSandboxRequirements(projectId: string | undefined): ActiveSandboxRequirement[] {
		return this.index(projectId).list.flatMap(pack =>
			[...pack.sandboxRequirements]
				.sort((a, b) => a.id.localeCompare(b.id))
				.map(requirement => ({
					packId: pack.packId,
					requirementId: requirement.id,
					profiles: [...requirement.profiles].sort(),
				})),
		);
	}

	listScheduledAdvisorHooks(projectId: string | undefined): HookContribution[] {
		return this.listHooks(projectId).filter(hook => hook.mode === "decide" && hook.events.length === 1 && hook.events[0] === "afterTurn" && hook.schedule?.everyNTurns !== undefined && hook.schedule.kind !== "decision");
	}

	listScheduledDecisionHooks(projectId: string | undefined, turnIndex: number): HookContribution[] {
		if (!Number.isSafeInteger(turnIndex) || turnIndex < 1) return [];
		return this.listHooks(projectId).filter(hook => {
			const everyNTurns = hook.schedule?.everyNTurns;
			return hook.mode === "decide" && hook.events.length === 1 && hook.events[0] === "afterTurn"
				&& hook.schedule?.kind === "decision" && everyNTurns !== undefined && turnIndex % everyNTurns === 0;
		});
	}

	listSystemPromptSections(projectId: string | undefined): ActiveSystemPromptSection[] {
		// `index().list` is the project-scoped low→high winning-pack order. Sort
		// only within a pack: filesystem/list declaration order must not affect the
		// bytes of the effective prompt.
		return this.index(projectId).list.flatMap((pack) =>
			[...(pack.systemPrompts ?? [])]
				.sort((a, b) => a.id.localeCompare(b.id))
				.map(({ id, ...section }) => ({ packId: pack.packId, packName: pack.packName, sectionId: id, ...section })),
		);
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
				retryableConfigError ||= packSettings.diagnostic.retryable;
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
					retryableConfigError ||= projectSettings.diagnostic.retryable;
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
					// absent config. Do not activate with defaults. Transient diagnostics
					// retry; permanent diagnostics cache this fail-closed index.
					retryableConfigError ||= normalized.diagnostic.retryable;
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
			// Hooks remain inert declaration metadata, but their project enablement and
			// declared configuration gate determine whether dispatch consumers can see
			// them. Capability authority is evaluated separately.
			const disabledHooks = this.disabledHooks
				? new Set(this.disabledHooks(e.scope, projectId, contrib.packName))
				: undefined;
			if (disabledHooks && disabledHooks.size > 0) {
				contrib = { ...contrib, hooks: contrib.hooks.filter((hook) => !disabledHooks.has(hook.listName)) };
			}
			const resolvedHooks: HookContribution[] = [];
			for (const hook of contrib.hooks) {
				// Keep malformed declarations out of all runtime authorization projections even
				// when project settings are not wired. Do not log the loader diagnostic.
				if (hook.settingsSchemaDiagnostic !== undefined) continue;
				const projectSettings = readProjectExtensionSettings(
					this.projectExtensionSettings,
					projectId,
					contrib.packId,
					"hook",
					hook.id,
				);
				if (projectSettings.state === "error") {
					retryableConfigError ||= projectSettings.diagnostic.retryable;
					console.warn(`[pack-contributions] project settings unavailable packId=${contrib.packId} hookId=${hook.id} code=${safeDiagnosticCode(projectSettings.diagnostic)}`);
					continue;
				}
				if (projectSettings.state === "present" && !projectSettings.enabled) continue;
				const values = hook.settingsSchema
					? projectSettings.state === "present"
						? projectSettings.values
						: settingsDefaults(hook.settingsSchema.fields)
					: hook.config ?? emptySettings();
				if (!activationSatisfied(hook.activation, values)) continue;
				resolvedHooks.push(hook);
			}
			if (resolvedHooks.length !== contrib.hooks.length) contrib = { ...contrib, hooks: resolvedHooks };

			// Runtime declarations follow the same activation/settings projection as
			// hooks. They remain data only here: this registry never starts a process.
			const disabledRuntimes = this.disabledRuntimes
				? new Set(this.disabledRuntimes(e.scope, projectId, contrib.packName))
				: undefined;
			const resolvedRuntimes: ServiceExtensionContribution[] = [];
			for (const runtime of contrib.runtimes) {
				if (runtime.settingsSchemaDiagnostic !== undefined || disabledRuntimes?.has(runtime.listName)) continue;
				const projectSettings = readProjectExtensionSettings(this.projectExtensionSettings, projectId, contrib.packId, "runtime", runtime.id);
				if (projectSettings.state === "error") {
					retryableConfigError ||= projectSettings.diagnostic.retryable;
					console.warn(`[pack-contributions] project settings unavailable packId=${contrib.packId} runtimeId=${runtime.id} code=${safeDiagnosticCode(projectSettings.diagnostic)}`);
					continue;
				}
				if (projectSettings.state === "present" && !projectSettings.enabled) continue;
				const values = runtime.settingsSchema
					? projectSettings.state === "present" ? projectSettings.values : settingsDefaults(runtime.settingsSchema.fields)
					: emptySettings();
				if (!activationSatisfied(runtime.activation, values)) continue;
				resolvedRuntimes.push(runtime);
			}
			if (resolvedRuntimes.length !== contrib.runtimes.length) contrib = { ...contrib, runtimes: resolvedRuntimes };

			// Sandbox requirements are inert catalog entries until every independent
			// eligibility check succeeds. The final authorization lookup is mandatory
			// and pack-principal-only at its server wiring boundary.
			const disabledSandboxRequirements = this.disabledSandboxRequirements
				? new Set(this.disabledSandboxRequirements(e.scope, projectId, contrib.packName))
				: undefined;
			const resolvedSandboxRequirements: SandboxRequirementContribution[] = [];
			for (const requirement of contrib.sandboxRequirements) {
				if (disabledSandboxRequirements?.has(requirement.listName)) continue;
				const projectSettings = readSandboxRequirementSettings(
					this.projectExtensionSettings,
					projectId,
					contrib.packId,
					requirement.id,
				);
				if (projectSettings.state === "error") {
					retryableConfigError ||= projectSettings.diagnostic.retryable;
					console.warn(`[pack-contributions] project settings unavailable packId=${contrib.packId} sandboxRequirementId=${requirement.id} code=${safeDiagnosticCode(projectSettings.diagnostic)}`);
					continue;
				}
				if (projectSettings.state === "present" && !projectSettings.enabled) continue;
				const values = requirement.settingsSchema
					? projectSettings.state === "present" ? projectSettings.values : settingsDefaults(requirement.settingsSchema.fields)
					: emptySettings();
				if (!activationSatisfied(requirement.activation, values)) continue;
				if (this.hasSandboxRequirementAuthorization?.(projectId, contrib.packId) !== true) continue;
				resolvedSandboxRequirements.push(requirement);
			}
			if (resolvedSandboxRequirements.length !== contrib.sandboxRequirements.length) {
				contrib = { ...contrib, sandboxRequirements: resolvedSandboxRequirements };
			}

			// Static sections need both the ordinary manifest-list activation toggle
			// and explicit EP-6 authorization. Missing authorization is deny-by-default;
			// retain the pack row but never leak its prompt bytes into a projection.
			const disabledSystemPrompts = this.disabledSystemPrompts
				? new Set(this.disabledSystemPrompts(e.scope, projectId, contrib.packName))
				: undefined;
			const staticallyAuthorized = this.hasSystemPromptStaticAuthorization?.(projectId, contrib.packId, contrib.hooks) === true;
			if (!staticallyAuthorized || (disabledSystemPrompts && disabledSystemPrompts.size > 0)) {
				contrib = {
					...contrib,
					systemPrompts: staticallyAuthorized
						? (contrib.systemPrompts ?? []).filter((section) => !disabledSystemPrompts!.has(section.listName))
						: [],
				};
			}
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
function readSandboxRequirementSettings(
	lookup: ProjectExtensionSettingsLookup | undefined,
	projectId: string | undefined,
	packId: string,
	id: string,
): ProjectExtensionSettingsReadResult {
	// The live server wiring adds this target alongside the declaration catalogue.
	// Keep this registry source-compatible with existing settings callbacks until
	// then; an unwired callback yields the same fail-closed/absent semantics.
	return readProjectExtensionSettings(
		lookup as unknown as ExtendedProjectExtensionSettingsLookup | undefined,
		projectId,
		packId,
		"sandboxRequirement",
		id,
	);
}

function readProjectExtensionSettings(
	lookup: ProjectExtensionSettingsLookup | ExtendedProjectExtensionSettingsLookup | undefined,
	projectId: string | undefined,
	packId: string,
	kind: ProjectExtensionSettingsTargetKind | "sandboxRequirement",
	id?: string,
): ProjectExtensionSettingsReadResult {
	if (!lookup) return { state: "absent" };
	try {
		const result = (lookup as ExtendedProjectExtensionSettingsLookup)(projectId, packId, kind, id);
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

function emptySettings(): Record<string, unknown> {
	return Object.create(null) as Record<string, unknown>;
}

function settingsDefaults(fields: readonly { key: string; type: string; default?: unknown }[] | undefined): Record<string, unknown> {
	const values = emptySettings();
	for (const field of fields ?? []) {
		if (field.type !== "secret" && field.default !== undefined) values[field.key] = field.default;
	}
	return values;
}

/** A declaration is config-active only when every required field has an
 * effective value; whitespace-only strings deliberately remain dormant. */
function activationSatisfied(activation: { requiresConfig: string[] } | undefined, values: Readonly<Record<string, unknown>>): boolean {
	const required = activation?.requiresConfig;
	if (!required || required.length === 0) return true;
	return required.every((key) => {
		if (!Object.hasOwn(values, key)) return false;
		const value = values[key];
		if (value === undefined || value === null) return false;
		if (Array.isArray(value)) return value.length > 0;
		return typeof value !== "string" || value.trim().length > 0;
	});
}

function providerActivationSatisfied(provider: ProviderContribution): boolean {
	return activationSatisfied(provider.activation, provider.config ?? {});
}
