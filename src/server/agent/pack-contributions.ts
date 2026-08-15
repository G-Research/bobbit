// src/server/agent/pack-contributions.ts
//
// Loaders for the PACK-SCOPED Extension Host contributions
// (pack-schema-v1-rationalisation §5.1). These declarations moved OFF the tool
// YAML to their own pack-level sites:
//
//   - `panels/<panel>.yaml`     → PanelContribution[]  (auto-discovered)
//   - `entrypoints/<ep>.yaml`   → EntrypointContribution[] (filtered by
//                                  manifest.contents.entrypoints[])
//   - `providers/<id>.yaml`     → ProviderContribution[] (filtered by
//                                  manifest.contents.providers[])
//   - `channels/<name>.yaml`    → ChannelContribution[] (filtered by
//                                  manifest.contents.channels[])
//   - `hooks/<name>.yaml`       → HookContribution[] (filtered by
//                                  manifest.contents.hooks[]; metadata only)
//   - `system-prompts/<name>.yaml` → SystemPromptSectionContribution[] (filtered
//                                  by manifest.contents.systemPrompts[])
//   - `pack.yaml.routes`        → RouteContribution
//
// Mirrors the tolerance of `tool-contributions.ts`: a malformed file is warned +
// dropped and never crashes the scan — EXCEPT the hard conflicts of §5.4,
// which throw {@link PackContributionError}:
//
//   1. duplicate route name within a pack;
//   2. (duplicate host-global routeId — detected at registry build, cross-pack);
//   3. duplicate panel id within a pack;
//   4. duplicate entrypoint id within a pack;
//   5. duplicate provider id within a pack;
//   6. duplicate hook id or hook listName within a pack.
//
// Each contribution carries its declaring `sourceFile` + the absolute `packRoot`
// so the serve/import sites can resolve a path-bearing field RELATIVE to the
// declaring YAML and enforce realpath containment against the pack root (§2).

import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { PackManifest } from "./pack-types.js";
import { isSafeRelativePath, parseEntrypoints } from "./tool-contributions.js";
import type { EntrypointIconId } from "../../shared/entrypoint-icons.js";
import { isSafeBasename, isValidPackName } from "./pack-manifest.js";
import { isPackPathWithinRoot } from "../extension-host/path-guard.js";
import { validateServiceExtensionSpec, type ServiceExtensionSpec } from "../extension-host/service-extension-contract.js";
import type { McpServerConfig } from "../mcp/mcp-types.js";
import { containsReservedCorePromptDelimiter, CORE_PROMPT_RESERVED_DELIMITER_TOKENS } from "./prompt-delimiters.js";
import { normalizeExtensionSettingsSchema, type ExtensionSettingsSchema } from "./extension-settings-schema.js";

// Panel ids may use dotted namespaces (e.g. `artifacts.viewer`).
const PANEL_ID_RE = /^[a-z0-9][a-z0-9_.-]*$/i;
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_.-]*$/i;
const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const CHANNEL_HANDLER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const ROUTE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const PROVIDER_KINDS = new Set(["memory", "selector", "generic"]);
const PROVIDER_HOOKS = new Set([
	"sessionSetup",
	"beforePrompt",
	"afterTurn",
	"beforeCompact",
	"sessionShutdown",
	// Goal-lifecycle hook (hierarchical goal metadata): fired once per worktree
	// provisioning in a goal's subtree with the resolved goal metadata. Lets a
	// provider apply per-goal filesystem treatments (content-addressed marker/
	// cache) without per-turn cost. See docs/design/goal-metadata.md.
	"goalProvisioned",
]);
const HOOK_ID_RE = /^[a-z0-9][a-z0-9_.-]*$/i;
const HOOK_EVENTS = new Set(["sessionSetup", "beforePrompt", "beforeToolCall", "afterToolResult", "afterTurn", "beforeCompact", "sessionShutdown", "goalProvisioned"] as const);
const HOOK_CAPABILITIES = new Set(["store", "session", "agents", "mutate", "filter:tool-result", "prompt:system-static", "prompt:system-author"] as const);
const HOOK_TOP_LEVEL_KEYS = new Set(["id", "module", "events", "mode", "capabilities", "budget", "config", "activation", "schedule", "selectors"]);

/** Static prompt-section identifiers are pack-local, durable attribution keys. */
export const SYSTEM_PROMPT_SECTION_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/i;
/** Keep display metadata bounded without imposing a project prompt budget here. */
export const MAX_SYSTEM_PROMPT_SECTION_TITLE_BYTES = 256;
/** Loader safety ceiling; project policy applies the lower effective prompt budget. */
export const MAX_SYSTEM_PROMPT_SECTION_CONTENT_BYTES = 64 * 1024;
/** Contributions may not forge any core-owned prompt delimiter. */
export const SYSTEM_PROMPT_RESERVED_DELIMITER_PREFIXES = CORE_PROMPT_RESERVED_DELIMITER_TOKENS;

/** A hard pack-contribution conflict (§5.4). Throwing aborts the pack's load so
 *  the registry can surface a loud error instead of silently registering an
 *  ambiguous surface. */
export class PackContributionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PackContributionError";
	}
}

/** A strict validation failure for a single MCP contribution file. Loaders catch
 *  this and drop the malformed file with a warning; callers using the exported
 *  normalizer can surface the precise reason directly. */
export class McpContributionValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpContributionValidationError";
	}
}

export interface McpPackOperationMetadata {
	name: string;
	label?: string;
	description?: string;
}

/** A pack-owned MCP server contribution (mcp/<listName>.yaml|json). */
export interface McpPackContribution {
	/** Pack-local activation key from contents.mcp[] and DisabledRefs.mcp. */
	listName: string;
	/** Public/model-facing MCP server name in mcp__<server>__... tool names. */
	serverName: string;
	/** Runtime MCP client key in the merged connection map. Defaults to serverName. */
	runtimeServerKey?: string;
	/** Optional model-facing sub-namespace owner for shared MCP clients. */
	subNamespace?: string;
	/** Optional enabled operation allow-list after activation has been applied. */
	selectedOperations?: string[];
	/** Optional disabled operation list for contribution-scoped activation. */
	disabledOperations?: string[];
	/** Optional operation metadata from gateway catalogues. */
	operationMetadata?: McpPackOperationMetadata[];
	/** Optional catalogue/display metadata. */
	label?: string;
	description?: string;
	/** Transport normalized to the existing MCP runtime config shape. */
	config: McpServerConfig;
	/** Absolute path of the declaring mcp/<listName>.yaml|json file. */
	sourceFile: string;
	/** Absolute pack root (market-packs/<name>). */
	packRoot: string;
}

export type McpContributionTransportType = "stdio" | "http";

export interface NormalizeMcpContributionOptions {
	listName: string;
	sourceFile: string;
	packRoot: string;
}

/** A pack-scoped panel (panels/<file>.yaml). */
export interface PanelContribution {
	id: string; // unique within the pack (dotted allowed)
	title?: string;
	entry: string; // path relative to sourceFile, contained in packRoot
	/** Durable tab identity mode. Omitted/default is singleton compatibility. */
	instanceMode?: "singleton" | "parameterized";
	/** Allowlisted params key that must match the tab instanceKey for parameterized panels. */
	instanceParam?: string;
	/** Absolute path of the declaring YAML (panels/<file>.yaml). */
	sourceFile: string;
	/** Absolute pack root (market-packs/<name>). */
	packRoot: string;
}

/** A pack-scoped entrypoint (entrypoints/<file>.yaml). */
export interface EntrypointContribution {
	id: string; // unique within the pack
	kind: "composer-slash" | "session-menu" | "route";
	label?: string; // required for launcher kinds
	icon?: EntrypointIconId;
	routeId?: string; // required for kind:"route"; host-global
	target?: { action?: string; panelId?: string; route?: string; channel?: string; singletonKey?: string; params?: Record<string, unknown> };
	paramKeys?: string[];
	/** The contents.entrypoints[] basename that lists this file — the SINGLE
	 *  activation toggle key. Maps one toggle onto BOTH the launcher id AND the
	 *  deep-link routeId the client registry keys by. */
	listName: string;
	sourceFile: string;
	packRoot: string;
}

/** The pack-level routes ref (pack.yaml `routes`). */
export interface RouteContribution {
	module: string; // path relative to pack.yaml, contained in packRoot
	names: string[]; // allowlist
	sourceFile: string; // = <packRoot>/pack.yaml
	packRoot: string;
}

export type ChannelCapability = "sessionPty";

export interface ChannelQuotas {
	maxChannelsPerSessionPerPack?: number;
	maxGatewayChannels?: number;
	maxFrameBytes?: number;
	maxInboundBytes?: number;
	maxInboundFrames?: number;
	maxOutboundBytes?: number;
	maxOutboundFrames?: number;
	maxClientOutboundBytes?: number;
	maxClientOutboundFrames?: number;
	maxClientSendRatePerSecond?: number;
	idleTimeoutMs?: number;
	openTimeoutMs?: number;
	closeGraceMs?: number;
}

/** A pack-owned long-lived channel handler (channels/<listName>.yaml). */
export interface ChannelContribution {
	/** Pack-local channel name resolved by host.channels.open(name). */
	name: string;
	/** Documentation/diagnostics protocol string; never controls dispatch. */
	protocol?: string;
	/** Handler module path relative to sourceFile, contained in packRoot. */
	module: string;
	/** Export member name in the module; defaults to `name`. */
	handler: string;
	/** Known privileged capability declarations; authorization is applied by the registry/dispatcher. */
	capabilities?: ChannelCapability[];
	requiresUserGesture?: boolean;
	quotas?: ChannelQuotas;
	/** The contents.channels[] basename that listed this file. */
	listName: string;
	sourceFile: string;
	packRoot: string;
}

/** A schema-2 declarative managed-service contribution. The pack supplies only
 * this metadata; the core runtime owns commands, processes, ports, and secrets. */
export interface ServiceExtensionContribution {
	id: string;
	spec: ServiceExtensionSpec;
	settingsSchema?: ExtensionSettingsSchema;
	settingsSchemaDiagnostic?: string;
	activation?: { requiresConfig: string[] };
	listName: string;
	sourceFile: string;
	packRoot: string;
}

/** Schema-3 inert request for a core-owned sandbox toolchain. This declaration
 * contains only approved profile IDs; it has no Docker/build execution surface. */
export interface SandboxRequirementContribution {
	id: string;
	profiles: readonly ("python")[];
	settingsSchema?: ExtensionSettingsSchema;
	activation?: { requiresConfig: string[] };
	listName: string;
	sourceFile: string;
	packRoot: string;
}

export interface ProviderContribution {
	id: string;
	kind: "memory" | "selector" | "generic";
	module: string;
	hooks: string[];
	runtime?: string;
	budget: { maxTokens: number; timeoutMs: number };
	/** FLAT, resolved config values handed to the provider as `ctx.config` — each
	 *  `providers/<id>.yaml` `config` schema entry collapsed to its `default` (or
	 *  omitted when optional with no default). The registry overlays persisted
	 *  store config ON TOP of these before constructing the effective config; a
	 *  provider therefore reads `ctx.config.mode === "external"`, NOT a raw
	 *  `{ type, default }` schema descriptor. */
	config?: Record<string, unknown>;
	/** The RAW config schema descriptors (the verbatim `config` mapping) preserved
	 *  for route-side validation; never handed to the provider as `ctx.config`. */
	configSchema?: Record<string, unknown>;
	/** Strict settings declaration derived from `configSchema`, when editable. */
	settingsSchema?: ExtensionSettingsSchema;
	/** Safe declaration diagnostic. A present value makes the target fail closed. */
	settingsSchemaDiagnostic?: string;
	/** Config-gated activation: the provider is omitted from the active provider
	 *  listing until the EFFECTIVE flat config has a non-empty value for every
	 *  key in `requiresConfig` (DisabledRefs/pack activation still wins). Enables a
	 *  truly dormant install — no provider bridge, no per-turn hook routes, no
	 *  network — until configured. */
	activation?: { requiresConfig: string[] };
	schedule?: HookSchedule;
	listName: string;
	sourceFile: string;
	packRoot: string;
}

/** Supported inert hook declaration events. Declaring one does not register or execute it. */
export type HookEvent = "sessionSetup" | "beforePrompt" | "beforeToolCall" | "afterToolResult" | "afterTurn" | "beforeCompact" | "sessionShutdown" | "goalProvisioned";
export type HookMode = "observe" | "decide";
/** Optional dynamic capability selector stages; declarations remain inert metadata. */
export type HookSelector = "skills" | "mcp";
/** Optional cadence metadata. Wall-clock cadence remains inert. */
export type ScheduledHookKind = "advisor" | "decision";
export interface HookSchedule {
	everyNTurns?: number;
	wallClockMs?: number;
	/** Omitted retains the compatible scheduled-advisor behavior. */
	kind?: ScheduledHookKind;
}
export type HookCapability = "store" | "session" | "agents" | "mutate" | "filter:tool-result" | "prompt:system-static" | "prompt:system-author";

/** A manifest-listed, inert hook metadata declaration. This is never imported,
 * authorized, config-gated, or registered for dispatch by the contribution loader. */
export interface HookContribution {
	id: string;
	module: string;
	events: HookEvent[];
	mode: HookMode;
	capabilities: HookCapability[];
	budget: { maxTokens: number; timeoutMs: number };
	/** Opaque static config remains inert unless it validates as a settings schema. */
	config?: Record<string, unknown>;
	settingsSchema?: ExtensionSettingsSchema;
	/** Only descriptor-shaped malformed hook config is surfaced as invalid. */
	settingsSchemaDiagnostic?: string;
	activation?: { requiresConfig: string[] };
	schedule?: HookSchedule;
	/** Only decide hooks on sessionSetup may declare these bounded selector stages. */
	selectors?: HookSelector[];
	listName: string;
	sourceFile: string;
	packRoot: string;
}

/** A literal, static system-prompt section declared by a schema-2 pack. */
export interface SystemPromptSectionContribution {
	/** Pack-local stable identifier, used for deterministic ordering and attribution. */
	id: string;
	/** Bounded display metadata only; never used as a prompt instruction or sort key. */
	title: string;
	/** Literal static markdown. The loader never interpolates this string. */
	content: string;
	/** Optional declaration cap; final project policy applies the lower cap. */
	maxBytes?: number;
	/** The manifest `contents.systemPrompts` basename that activates this declaration. */
	listName: string;
	sourceFile: string;
	packRoot: string;
}

/** Pack-store key under which a provider's persisted flat config overrides live
 *  (server-derived packId scopes the store; this names the per-provider record).
 *  The provider's `config` route writes the same key so the loader/registry can
 *  overlay the override on top of the schema defaults. Single source of truth for
 *  the key convention shared between the host loader and the pack route. */
export const PROVIDER_CONFIG_KEY_PREFIX = "provider-config:";
export function providerConfigStoreKey(providerId: string): string {
	return `${PROVIDER_CONFIG_KEY_PREFIX}${providerId}`;
}

/** Collapse a provider `config` mapping to flat runtime values. A
 * descriptor-shaped object contributes its `.default` (omitted when it has none
 * — an optional field with no default stays `undefined`); scalar and opaque
 * object values are historic literal defaults. Never recurses. */
export function resolveProviderConfigDefaults(schema: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, descriptor] of Object.entries(schema)) {
		if (isPlainObject(descriptor) && "type" in descriptor) {
			if ("default" in descriptor) out[key] = descriptor.default;
			// optional with no default → omitted (effective value is `undefined`).
		} else {
			out[key] = descriptor; // scalar or opaque static config = literal default
		}
	}
	return out;
}

/** Parse a provider `activation` block. Only `requiresConfig: string[]` is
 *  recognised; anything else is dropped (tolerant). Returns `undefined` when no
 *  usable gating keys are present so the provider stays unconditionally active. */
function parseProviderActivation(raw: unknown): { requiresConfig: string[] } | undefined {
	if (!isPlainObject(raw)) return undefined;
	const rc = raw.requiresConfig;
	if (!Array.isArray(rc)) return undefined;
	const keys = rc.filter((k): k is string => typeof k === "string" && k.length > 0);
	if (keys.length === 0) return undefined;
	return { requiresConfig: keys };
}

/** An explicit config gate opts into strict validation even if the tolerant
 * runtime parser cannot interpret it. Other legacy activation metadata remains
 * inert and does not become a settings declaration. */
function hasOwnRequiresConfig(raw: unknown): raw is Record<string, unknown> {
	return isPlainObject(raw) && Object.prototype.hasOwnProperty.call(raw, "requiresConfig");
}

/** A config-free target cannot declare a satisfiable config gate. Normalize it
 * to preserve the canonical diagnostic; an empty array otherwise normalizes as
 * an empty schema, so explicitly retain the invalid declaration state. */
function configlessActivationDiagnostic(rawActivation: unknown): string {
	const settings = normalizeExtensionSettingsSchema({}, rawActivation);
	return settings.diagnostic ?? "activation.requiresConfig must reference declared fields";
}

/** A config map opts into strict project settings only when at least one field
 * is descriptor-shaped. Historic providers and inert hooks also use `config:`
 * for arbitrary static maps, so scalar and opaque values remain runtime config,
 * not a malformed settings declaration. */
function hasSettingsDescriptor(config: Record<string, unknown>): boolean {
	return Object.values(config).some(value => isPlainObject(value) && "type" in value);
}

/** All pack-scoped contributions for ONE installed pack. */
export interface PackContributions {
	packId: string; // structural, from the pack root dir name
	packName: string;
	packRoot: string;
	panels: PanelContribution[];
	entrypoints: EntrypointContribution[];
	providers: ProviderContribution[];
	/** Declarative runtime files listed by contents.runtimes[]. */
	runtimes: ServiceExtensionContribution[];
	/** Schema-3 inert toolchain requests listed by contents.sandboxRequirements[]. */
	sandboxRequirements: SandboxRequirementContribution[];
	/** Channel handler files listed by contents.channels[]. */
	channels: ChannelContribution[];
	/** Schema-2 hook metadata files listed by contents.hooks[]. Never executable. */
	hooks: HookContribution[];
	/** Schema-2 literal static prompt sections listed by contents.systemPrompts[]. */
	systemPrompts?: SystemPromptSectionContribution[];
	/** Schema-2 MCP contribution files listed by contents.mcp[]. */
	mcp?: McpPackContribution[];
	routes?: RouteContribution;
}

/** Structural packId from a pack root: the dir name AFTER `market-packs`, else
 *  the basename. Mirrors `pack-identity.ts::derivePackId` keyed on the root. */
export function packIdFromRoot(packRoot: string): string {
	const segs = packRoot.split(/[\\/]+/).filter((s) => s.length > 0);
	const idx = segs.lastIndexOf("market-packs");
	if (idx >= 0 && idx + 1 < segs.length) return segs[idx + 1] ?? "";
	return segs[segs.length - 1] ?? "";
}

function readYaml(file: string): unknown {
	const raw = fs.readFileSync(file, "utf-8");
	return parse(raw);
}

/**
 * Load every pack-scoped contribution for an installed pack. Tolerant (warn +
 * drop malformed files), except the §5.4 hard conflicts which throw
 * {@link PackContributionError}.
 */
export function loadPackContributions(packRoot: string, manifest: PackManifest): PackContributions {
	const packId = packIdFromRoot(packRoot);
	const out: PackContributions = {
		packId,
		packName: manifest.name,
		packRoot,
		panels: loadPanels(packRoot),
		entrypoints: loadEntrypoints(packRoot, manifest),
		providers: loadProviders(packRoot, manifest),
		runtimes: loadServiceExtensions(packRoot, manifest),
		sandboxRequirements: loadSandboxRequirements(packRoot, manifest),
		channels: loadChannels(packRoot, manifest),
		hooks: loadHooks(packRoot, manifest),
		systemPrompts: loadSystemPromptSections(packRoot, manifest),
		mcp: loadMcpContributions(packRoot, manifest),
	};
	const routes = loadRoutes(packRoot, manifest);
	if (routes) out.routes = routes;
	return out;
}

/** Auto-discover `panels/*.yaml`. Duplicate panel id within the pack = hard conflict. */
function loadPanels(packRoot: string): PanelContribution[] {
	const dir = path.join(packRoot, "panels");
	let files: string[];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
	} catch {
		return []; // no panels/ dir
	}
	const out: PanelContribution[] = [];
	const seen = new Set<string>();
	for (const f of files.sort()) {
		const sourceFile = path.join(dir, f);
		let data: unknown;
		try {
			data = readYaml(sourceFile);
		} catch (err) {
			console.warn(`[pack-contributions] skipping malformed panel ${sourceFile}: ${String(err)}`);
			continue;
		}
		if (!data || typeof data !== "object" || Array.isArray(data)) {
			console.warn(`[pack-contributions] panel ${sourceFile} is not a mapping; dropping`);
			continue;
		}
		const obj = data as Record<string, unknown>;
		const id = obj.id;
		const entry = obj.entry;
		if (typeof id !== "string" || !PANEL_ID_RE.test(id)) {
			console.warn(`[pack-contributions] panel ${sourceFile} has invalid id; dropping`);
			continue;
		}
		if (typeof entry !== "string" || !isSafeRelativePath(entry)) {
			console.warn(`[pack-contributions] panel '${id}' (${sourceFile}) has unsafe/missing entry; dropping`);
			continue;
		}
		if (seen.has(id)) {
			throw new PackContributionError(
				`pack "${packIdFromRoot(packRoot)}" declares panel id "${id}" more than once; panel ids must be unique within a pack`,
			);
		}
		seen.add(id);
		const panel: PanelContribution = { id, entry, sourceFile, packRoot };
		if (typeof obj.title === "string" && obj.title.length > 0) panel.title = obj.title;
		if (obj.instanceMode === "singleton" || obj.instanceMode === "parameterized") panel.instanceMode = obj.instanceMode;
		if (typeof obj.instanceParam === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(obj.instanceParam)) panel.instanceParam = obj.instanceParam;
		out.push(panel);
	}
	return out;
}

/** Load `entrypoints/<name>.yaml` ONLY for names listed in contents.entrypoints[].
 *  Duplicate entrypoint id within the pack = hard conflict. */
function loadEntrypoints(packRoot: string, manifest: PackManifest): EntrypointContribution[] {
	const listNames = manifest.contents.entrypoints ?? [];
	const dir = path.join(packRoot, "entrypoints");
	const out: EntrypointContribution[] = [];
	const seenId = new Set<string>();
	for (const listName of listNames) {
		if (typeof listName !== "string" || listName.length === 0) continue;
		// Defense-in-depth (validateManifest is the primary guard): a listName must
		// be a safe file basename — never path structure — before it is joined into
		// the entrypoints/ dir. Drop-with-warning keeps the tolerant-loader contract.
		if (!isSafeBasename(listName)) {
			console.warn(`[pack-contributions] entrypoint listName ${JSON.stringify(listName)} is not a safe basename; skipping`);
			continue;
		}
		// Resolve the file; tolerate either .yaml or .yml.
		let sourceFile = path.join(dir, `${listName}.yaml`);
		if (!fs.existsSync(sourceFile)) {
			const alt = path.join(dir, `${listName}.yml`);
			if (fs.existsSync(alt)) sourceFile = alt;
		}
		// Assert the resolved file stays within entrypoints/ (realpath-aware) — no
		// read outside the dir even if the basename guard were ever bypassed.
		if (!isPackPathWithinRoot(dir, sourceFile)) {
			console.warn(`[pack-contributions] entrypoint '${listName}' resolves outside entrypoints/ (${sourceFile}); skipping`);
			continue;
		}
		let data: unknown;
		try {
			data = readYaml(sourceFile);
		} catch (err) {
			console.warn(`[pack-contributions] skipping missing/malformed entrypoint '${listName}' (${sourceFile}): ${String(err)}`);
			continue;
		}
		// Reuse the tool-contributions field validator by wrapping the single object.
		const parsed = parseEntrypoints([data], sourceFile);
		if (parsed.length === 0) {
			console.warn(`[pack-contributions] entrypoint '${listName}' (${sourceFile}) failed validation; dropping`);
			continue;
		}
		const base = parsed[0];
		if (seenId.has(base.id)) {
			throw new PackContributionError(
				`pack "${packIdFromRoot(packRoot)}" declares entrypoint id "${base.id}" more than once; entrypoint ids must be unique within a pack`,
			);
		}
		seenId.add(base.id);
		out.push({ ...base, listName, sourceFile, packRoot });
	}
	return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
	const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
	return Math.min(max, Math.max(min, n));
}

const CHANNEL_CAPABILITIES = new Set<ChannelCapability>(["sessionPty"]);
const CHANNEL_QUOTA_KEYS = new Set<keyof ChannelQuotas>([
	"maxChannelsPerSessionPerPack",
	"maxGatewayChannels",
	"maxFrameBytes",
	"maxInboundBytes",
	"maxInboundFrames",
	"maxOutboundBytes",
	"maxOutboundFrames",
	"maxClientOutboundBytes",
	"maxClientOutboundFrames",
	"maxClientSendRatePerSecond",
	"idleTimeoutMs",
	"openTimeoutMs",
	"closeGraceMs",
]);
const CHANNEL_QUOTA_ALIASES: Record<string, keyof ChannelQuotas> = {
	maxInboundBufferedBytesPerChannel: "maxInboundBytes",
	maxInboundBufferedFramesPerChannel: "maxInboundFrames",
	maxOutboundBufferedBytesPerChannel: "maxOutboundBytes",
	maxOutboundBufferedFramesPerChannel: "maxOutboundFrames",
	maxBufferedBytesPerAttachedClient: "maxClientOutboundBytes",
	maxAttachedClientBufferedFrames: "maxClientOutboundFrames",
	sendRateFramesPerSecond: "maxClientSendRatePerSecond",
	maxInboundFramesPerSecond: "maxClientSendRatePerSecond",
};

function parseChannelCapabilities(raw: unknown, sourceFile: string, channelName: string): ChannelCapability[] | undefined {
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw)) {
		console.warn(`[pack-contributions] channel '${channelName}' (${sourceFile}) has invalid capabilities; dropping capabilities`);
		return undefined;
	}
	const out: ChannelCapability[] = [];
	for (const cap of raw) {
		if (typeof cap === "string" && CHANNEL_CAPABILITIES.has(cap as ChannelCapability)) {
			if (!out.includes(cap as ChannelCapability)) out.push(cap as ChannelCapability);
		} else {
			console.warn(`[pack-contributions] channel '${channelName}' (${sourceFile}) declares unknown capability ${JSON.stringify(cap)}; ignoring`);
		}
	}
	return out.length > 0 ? out : undefined;
}

function parseChannelQuotas(raw: unknown, sourceFile: string, channelName: string): ChannelQuotas | undefined {
	if (raw === undefined) return undefined;
	if (!isPlainObject(raw)) {
		console.warn(`[pack-contributions] channel '${channelName}' (${sourceFile}) has invalid quotas; dropping quotas`);
		return undefined;
	}
	const quotas: ChannelQuotas = {};
	for (const [key, value] of Object.entries(raw)) {
		const quotaKey = CHANNEL_QUOTA_KEYS.has(key as keyof ChannelQuotas) ? key as keyof ChannelQuotas : CHANNEL_QUOTA_ALIASES[key];
		if (!quotaKey) continue; // unknown fields are inert metadata
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
			console.warn(`[pack-contributions] channel '${channelName}' (${sourceFile}) quota ${JSON.stringify(key)} must be a non-negative integer; ignoring`);
			continue;
		}
		quotas[quotaKey] = value;
	}
	return Object.keys(quotas).length > 0 ? quotas : undefined;
}

function resolveContributionFile(dir: string, listName: string): string {
	const yaml = path.join(dir, `${listName}.yaml`);
	if (fs.existsSync(yaml)) return yaml;
	const yml = path.join(dir, `${listName}.yml`);
	return fs.existsSync(yml) ? yml : yaml;
}

/** Load `channels/<name>.yaml` ONLY for names listed in contents.channels[].
 *  Duplicate channel name within the pack = hard conflict. */
export function loadChannels(packRoot: string, manifest: PackManifest): ChannelContribution[] {
	const listNames = manifest.contents.channels ?? [];
	const dir = path.join(packRoot, "channels");
	const out: ChannelContribution[] = [];
	const seenListName = new Set<string>();
	const seenName = new Set<string>();
	for (const listName of listNames) {
		if (typeof listName !== "string" || listName.length === 0) continue;
		if (!isSafeBasename(listName)) {
			console.warn(`[pack-contributions] channel listName ${JSON.stringify(listName)} is not a safe basename; skipping`);
			continue;
		}
		if (seenListName.has(listName)) {
			throw new PackContributionError(
				`pack "${packIdFromRoot(packRoot)}" declares channel listName "${listName}" more than once; channel listNames must be unique within a pack`,
			);
		}
		seenListName.add(listName);
		const sourceFile = resolveContributionFile(dir, listName);
		if (!isPackPathWithinRoot(dir, sourceFile)) {
			console.warn(`[pack-contributions] channel '${listName}' resolves outside channels/ (${sourceFile}); skipping`);
			continue;
		}
		let data: unknown;
		try {
			data = readYaml(sourceFile);
		} catch (err) {
			console.warn(`[pack-contributions] skipping missing/malformed channel '${listName}' (${sourceFile}): ${String(err)}`);
			continue;
		}
		if (!isPlainObject(data)) {
			console.warn(`[pack-contributions] channel '${listName}' (${sourceFile}) is not a mapping; dropping`);
			continue;
		}
		const name = data.name;
		if (typeof name !== "string" || !CHANNEL_NAME_RE.test(name)) {
			console.warn(`[pack-contributions] channel '${listName}' (${sourceFile}) has invalid name; dropping`);
			continue;
		}
		const mod = data.module;
		if (typeof mod !== "string" || !isSafeRelativePath(mod)) {
			console.warn(`[pack-contributions] channel '${name}' (${sourceFile}) has unsafe/missing module; dropping`);
			continue;
		}
		const resolvedModule = path.resolve(path.dirname(sourceFile), mod);
		if (!isPackPathWithinRoot(packRoot, resolvedModule)) {
			throw new PackContributionError(
				`pack "${packIdFromRoot(packRoot)}" channel "${name}" module resolves outside the pack root`,
			);
		}
		if (seenName.has(name)) {
			throw new PackContributionError(
				`pack "${packIdFromRoot(packRoot)}" declares channel name "${name}" more than once; channel names must be unique within a pack`,
			);
		}
		seenName.add(name);
		const handler = data.handler === undefined ? name : data.handler;
		if (typeof handler !== "string" || !CHANNEL_HANDLER_RE.test(handler)) {
			console.warn(`[pack-contributions] channel '${name}' (${sourceFile}) has invalid handler; dropping`);
			continue;
		}
		const channel: ChannelContribution = { name, module: mod, handler, listName, sourceFile, packRoot };
		if (typeof data.protocol === "string" && data.protocol.trim().length > 0) channel.protocol = data.protocol.trim();
		const capabilities = parseChannelCapabilities(data.capabilities, sourceFile, name);
		if (capabilities) channel.capabilities = capabilities;
		if (typeof data.requiresUserGesture === "boolean") channel.requiresUserGesture = data.requiresUserGesture;
		const quotas = parseChannelQuotas({ ...data, ...(isPlainObject(data.quotas) ? data.quotas : {}) }, sourceFile, name);
		if (quotas) channel.quotas = quotas;
		out.push(channel);
	}
	return out;
}

interface ParsedHookActivation {
	activation?: { requiresConfig: string[] };
	error?: string;
}

interface ParsedHookSchedule { schedule?: HookSchedule; error?: string; }
interface ParsedHookSelectors { selectors?: HookSelector[]; error?: string; }
function parseHookSchedule(raw: unknown): ParsedHookSchedule {
	if (raw === undefined) return {};
	if (!isPlainObject(raw)) return { error: "schedule must be a mapping" };
	for (const key of Object.keys(raw)) if (key !== "everyNTurns" && key !== "wallClockMs" && key !== "kind") return { error: `schedule has unknown key ${JSON.stringify(key)}` };
	const schedule: HookSchedule = {};
	for (const key of ["everyNTurns", "wallClockMs"] as const) { const value = raw[key]; if (value === undefined) continue; if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 10_000) return { error: `schedule.${key} must be a safe integer in 1..10000` }; schedule[key] = value; }
	if (raw.kind !== undefined) {
		if (raw.kind !== "advisor" && raw.kind !== "decision") return { error: "schedule.kind must be advisor or decision" };
		schedule.kind = raw.kind;
	}
	return { schedule };
}

function parseHookSelectors(raw: unknown): ParsedHookSelectors {
	if (raw === undefined) return {};
	if (!Array.isArray(raw) || raw.length === 0) return { error: "selectors must be a non-empty array" };
	const selectors: HookSelector[] = [];
	const seen = new Set<string>();
	for (const selector of raw) {
		if ((selector !== "skills" && selector !== "mcp") || seen.has(selector)) return { error: "selectors must contain unique supported stages" };
		seen.add(selector);
		selectors.push(selector);
	}
	return { selectors };
}

/** Hook activation is declaration metadata only. Its syntax is intentionally
 * strict here, but the loader never evaluates it or reads persisted config. */
function parseHookActivation(raw: unknown): ParsedHookActivation {
	if (raw === undefined) return {};
	if (!isPlainObject(raw)) return { error: "activation must be a mapping" };
	for (const key of Object.keys(raw)) {
		if (key !== "requiresConfig") return { error: `activation has unknown key ${JSON.stringify(key)}` };
	}
	if (raw.requiresConfig === undefined) return {};
	if (!Array.isArray(raw.requiresConfig) || raw.requiresConfig.length === 0) {
		return { error: "activation.requiresConfig must be a non-empty array of non-empty strings" };
	}
	const requiresConfig: string[] = [];
	const seen = new Set<string>();
	for (const key of raw.requiresConfig) {
		if (typeof key !== "string" || key.length === 0) {
			return { error: "activation.requiresConfig must contain only non-empty strings" };
		}
		if (seen.has(key)) return { error: `activation.requiresConfig contains duplicate key ${JSON.stringify(key)}` };
		seen.add(key);
		requiresConfig.push(key);
	}
	return { activation: { requiresConfig } };
}

/** Load `hooks/<name>.yaml` ONLY for schema-2 names listed in contents.hooks.
 * These are inert declarations: loading only validates and indexes metadata. */
export function loadHooks(packRoot: string, manifest: PackManifest): HookContribution[] {
	if ((manifest.schema ?? 1) < 2) return [];
	const listNames = manifest.contents.hooks ?? [];
	const dir = path.join(packRoot, "hooks");
	const out: HookContribution[] = [];
	const seenListName = new Set<string>();
	const seenId = new Set<string>();
	for (const listName of listNames) {
		if (typeof listName !== "string" || listName.length === 0) continue;
		if (!isSafeBasename(listName)) {
			console.warn(`[pack-contributions] hook listName ${JSON.stringify(listName)} is not a safe basename; skipping`);
			continue;
		}
		// Check duplicate refs before reading so malformed files cannot hide this
		// ambiguous activation identity.
		if (seenListName.has(listName)) {
			throw new PackContributionError(
				`pack "${packIdFromRoot(packRoot)}" declares hook listName "${listName}" more than once; hook listNames must be unique within a pack`,
			);
		}
		seenListName.add(listName);
		const sourceFile = resolveContributionFile(dir, listName);
		if (!isPackPathWithinRoot(dir, sourceFile)) {
			console.warn(`[pack-contributions] hook '${listName}' resolves outside hooks/ (${sourceFile}); skipping`);
			continue;
		}
		let data: unknown;
		try {
			data = readYaml(sourceFile);
		} catch (err) {
			console.warn(`[pack-contributions] skipping missing/malformed hook '${listName}' (${sourceFile}): ${String(err)}`);
			continue;
		}
		if (!isPlainObject(data)) {
			console.warn(`[pack-contributions] hook '${listName}' (${sourceFile}) is not a mapping; dropping`);
			continue;
		}
		const unknownKey = Object.keys(data).find((key) => !HOOK_TOP_LEVEL_KEYS.has(key));
		if (unknownKey !== undefined) {
			console.warn(`[pack-contributions] hook '${listName}' (${sourceFile}) has unknown top-level key ${JSON.stringify(unknownKey)}; dropping`);
			continue;
		}
		const id = data.id;
		if (typeof id !== "string" || !HOOK_ID_RE.test(id)) {
			console.warn(`[pack-contributions] hook '${listName}' (${sourceFile}) has invalid id; dropping`);
			continue;
		}
		const mod = data.module;
		if (typeof mod !== "string" || mod.length === 0) {
			console.warn(`[pack-contributions] hook '${id}' (${sourceFile}) has missing module; dropping`);
			continue;
		}
		if (!isSafeRelativePath(mod)) {
			throw new PackContributionError(
				`pack "${packIdFromRoot(packRoot)}" hook "${id}" has unsafe module path`,
			);
		}
		const resolvedModule = path.resolve(path.dirname(sourceFile), mod);
		if (!isPackPathWithinRoot(packRoot, resolvedModule)) {
			throw new PackContributionError(
				`pack "${packIdFromRoot(packRoot)}" hook "${id}" module resolves outside the pack root`,
			);
		}
		const events = data.events;
		if (!Array.isArray(events) || events.length === 0) {
			console.warn(`[pack-contributions] hook '${id}' (${sourceFile}) has invalid events; dropping`);
			continue;
		}
		const normalizedEvents: HookEvent[] = [];
		const seenEvents = new Set<string>();
		let invalidEvents = false;
		for (const event of events) {
			if (typeof event !== "string" || !HOOK_EVENTS.has(event as HookEvent) || seenEvents.has(event)) {
				invalidEvents = true;
				break;
			}
			seenEvents.add(event);
			normalizedEvents.push(event as HookEvent);
		}
		if (invalidEvents) {
			console.warn(`[pack-contributions] hook '${id}' (${sourceFile}) events must be supported and duplicate-free; dropping`);
			continue;
		}
		const mode = data.mode;
		if (mode !== "observe" && mode !== "decide") {
			console.warn(`[pack-contributions] hook '${id}' (${sourceFile}) has invalid mode; dropping`);
			continue;
		}
		const capabilities = data.capabilities;
		if (!Array.isArray(capabilities)) {
			console.warn(`[pack-contributions] hook '${id}' (${sourceFile}) has invalid capabilities; dropping`);
			continue;
		}
		const normalizedCapabilities: HookCapability[] = [];
		const seenCapabilities = new Set<string>();
		let invalidCapabilities = false;
		for (const capability of capabilities) {
			if (typeof capability !== "string" || !HOOK_CAPABILITIES.has(capability as HookCapability) || seenCapabilities.has(capability)) {
				invalidCapabilities = true;
				break;
			}
			seenCapabilities.add(capability);
			normalizedCapabilities.push(capability as HookCapability);
		}
		if (invalidCapabilities) {
			console.warn(`[pack-contributions] hook '${id}' (${sourceFile}) capabilities must be supported and duplicate-free; dropping`);
			continue;
		}
		let config: Record<string, unknown> | undefined;
		if (data.config !== undefined) {
			if (!isPlainObject(data.config)) {
				console.warn(`[pack-contributions] hook '${id}' (${sourceFile}) config must be a mapping; dropping`);
				continue;
			}
			config = data.config;
		}
		const parsedActivation = parseHookActivation(data.activation);
		const configlessConfigGate = config === undefined && hasOwnRequiresConfig(data.activation);
		const parsedSchedule = parseHookSchedule(data.schedule);
		const parsedSelectors = parseHookSelectors(data.selectors);
		if (parsedSchedule.error) { console.warn(`[pack-contributions] hook '${id}' (${sourceFile}) ${parsedSchedule.error}; dropping`); continue; }
		if (parsedSelectors.error) { console.warn(`[pack-contributions] hook '${id}' (${sourceFile}) ${parsedSelectors.error}; dropping`); continue; }
		if (parsedSelectors.selectors && (mode !== "decide" || !normalizedEvents.includes("sessionSetup"))) { console.warn(`[pack-contributions] hook '${id}' (${sourceFile}) selectors require mode 'decide' and event 'sessionSetup'; dropping`); continue; }
		if (parsedSchedule.schedule?.everyNTurns !== undefined && (mode !== "decide" || normalizedEvents.length !== 1 || normalizedEvents[0] !== "afterTurn")) { console.warn(`[pack-contributions] hook '${id}' (${sourceFile}) schedule.everyNTurns requires mode 'decide' and exactly events: [afterTurn]; dropping`); continue; }
		if (parsedSchedule.schedule?.kind === "decision" && (mode !== "decide" || normalizedEvents.length !== 1 || normalizedEvents[0] !== "afterTurn" || parsedSchedule.schedule.everyNTurns === undefined)) { console.warn(`[pack-contributions] hook '${id}' (${sourceFile}) schedule.kind 'decision' requires mode 'decide', exactly events: [afterTurn], and everyNTurns; dropping`); continue; }
		if (parsedActivation.error && !configlessConfigGate) {
			console.warn(`[pack-contributions] hook '${id}' (${sourceFile}) ${parsedActivation.error}; dropping`);
			continue;
		}
		if (seenId.has(id)) {
			throw new PackContributionError(
				`pack "${packIdFromRoot(packRoot)}" declares hook id "${id}" more than once; hook ids must be unique within a pack`,
			);
		}
		seenId.add(id);
		const budgetRaw = isPlainObject(data.budget) ? data.budget : {};
		const hook: HookContribution = {
			id,
			module: mod,
			events: normalizedEvents,
			mode,
			capabilities: normalizedCapabilities,
			budget: {
				maxTokens: clampNumber(budgetRaw.maxTokens, 1600, 64, 8192),
				timeoutMs: clampNumber(budgetRaw.timeoutMs, 1500, 100, 10000),
			},
			listName,
			sourceFile,
			packRoot,
		};
		if (config !== undefined) {
			hook.config = config;
			if (hasSettingsDescriptor(config)) {
				const settings = normalizeExtensionSettingsSchema(config, data.activation);
				if (settings.schema) hook.settingsSchema = settings.schema;
				else hook.settingsSchemaDiagnostic = settings.diagnostic;
			}
		} else if (configlessConfigGate) {
			// Keep every explicit, config-free gate visible for repair, including
			// malformed scalar/empty/mixed requiresConfig forms that the tolerant
			// parser cannot retain as runtime activation metadata.
			hook.settingsSchemaDiagnostic = configlessActivationDiagnostic(data.activation);
		}
		if (parsedActivation.activation) hook.activation = parsedActivation.activation;
		if (parsedSchedule.schedule) hook.schedule = parsedSchedule.schedule;
		if (parsedSelectors.selectors) hook.selectors = parsedSelectors.selectors;
		out.push(hook);
	}
	return out;
}

/** True only for strings that round-trip through UTF-8 without replacement.
 * YAML produces JavaScript strings, so reject lone UTF-16 surrogates before
 * Buffer.byteLength would silently encode them as U+FFFD. */
function isWellFormedText(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const unit = value.charCodeAt(i);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(i + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			i++;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			return false;
		}
	}
	return true;
}

function containsReservedSystemPromptDelimiter(content: string): boolean {
	return containsReservedCorePromptDelimiter(content);
}

/** Load schema-2 `system-prompts/<name>.yaml` declarations listed by the
 * manifest. These are inert literal text declarations: malformed files are
 * warned and omitted, while duplicate activation/section identities reject the
 * ambiguous pack exactly like other hard contribution conflicts. */
export function loadSystemPromptSections(packRoot: string, manifest: PackManifest): SystemPromptSectionContribution[] {
	if ((manifest.schema ?? 1) < 2) return [];
	const listNames = manifest.contents.systemPrompts ?? [];
	const dir = path.join(packRoot, "system-prompts");
	const out: SystemPromptSectionContribution[] = [];
	const seenListName = new Set<string>();
	const seenId = new Set<string>();
	for (const listName of listNames) {
		if (typeof listName !== "string" || listName.length === 0) continue;
		if (!isSafeBasename(listName)) {
			console.warn(`[pack-contributions] system-prompt listName ${JSON.stringify(listName)} is not a safe basename; skipping`);
			continue;
		}
		if (seenListName.has(listName)) {
			throw new PackContributionError(
				`pack "${packIdFromRoot(packRoot)}" declares system-prompt listName "${listName}" more than once; system-prompt listNames must be unique within a pack`,
			);
		}
		seenListName.add(listName);
		const sourceFile = resolveContributionFile(dir, listName);
		if (!isPackPathWithinRoot(dir, sourceFile)) {
			console.warn(`[pack-contributions] system-prompt '${listName}' resolves outside system-prompts/ (${sourceFile}); skipping`);
			continue;
		}
		let data: unknown;
		try {
			data = readYaml(sourceFile);
		} catch (err) {
			console.warn(`[pack-contributions] skipping missing/malformed system-prompt '${listName}' (${sourceFile}): ${String(err)}`);
			continue;
		}
		if (!isPlainObject(data)) {
			console.warn(`[pack-contributions] system-prompt '${listName}' (${sourceFile}) is not a mapping; dropping`);
			continue;
		}
		const id = data.id;
		const title = data.title;
		const content = data.content;
		if (typeof id !== "string" || !SYSTEM_PROMPT_SECTION_ID_RE.test(id)) {
			console.warn(`[pack-contributions] system-prompt '${listName}' (${sourceFile}) has invalid id; dropping`);
			continue;
		}
		if (typeof title !== "string" || title.trim().length === 0 || !isWellFormedText(title)
			|| Buffer.byteLength(title, "utf8") > MAX_SYSTEM_PROMPT_SECTION_TITLE_BYTES
			|| /[\0\r\n]/.test(title)) {
			console.warn(`[pack-contributions] system-prompt '${id}' (${sourceFile}) has invalid title; dropping`);
			continue;
		}
		if (typeof content !== "string" || content.length === 0 || !isWellFormedText(content)
			|| Buffer.byteLength(content, "utf8") > MAX_SYSTEM_PROMPT_SECTION_CONTENT_BYTES
			|| containsReservedSystemPromptDelimiter(content)) {
			console.warn(`[pack-contributions] system-prompt '${id}' (${sourceFile}) has invalid content; dropping`);
			continue;
		}
		let maxBytes: number | undefined;
		if (data.maxBytes !== undefined) {
			if (typeof data.maxBytes !== "number" || !Number.isSafeInteger(data.maxBytes) || data.maxBytes <= 0) {
				console.warn(`[pack-contributions] system-prompt '${id}' (${sourceFile}) has invalid maxBytes; dropping`);
				continue;
			}
			maxBytes = data.maxBytes;
		}
		if (seenId.has(id)) {
			throw new PackContributionError(
				`pack "${packIdFromRoot(packRoot)}" declares system-prompt id "${id}" more than once; system-prompt ids must be unique within a pack`,
			);
		}
		seenId.add(id);
		out.push({ id, title, content, ...(maxBytes !== undefined ? { maxBytes } : {}), listName, sourceFile, packRoot });
	}
	return out;
}

// §0.2: providers are pack-scoped, keyed (packId, contributionId).
// They are NOT an EntityType; two packs may each ship id "memory" and both stay active.
export function loadProviders(packRoot: string, manifest: PackManifest): ProviderContribution[] {
	if ((manifest.schema ?? 1) < 2) return [];
	const listNames = manifest.contents.providers ?? [];
	const dir = path.join(packRoot, "providers");
	const out: ProviderContribution[] = [];
	const seenId = new Set<string>();
	for (const listName of listNames) {
		if (typeof listName !== "string" || listName.length === 0) continue;
		if (!isSafeBasename(listName)) {
			console.warn(`[pack-contributions] provider listName ${JSON.stringify(listName)} is not a safe basename; skipping`);
			continue;
		}
		let sourceFile = path.join(dir, `${listName}.yaml`);
		if (!fs.existsSync(sourceFile)) {
			const alt = path.join(dir, `${listName}.yml`);
			if (fs.existsSync(alt)) sourceFile = alt;
		}
		if (!isPackPathWithinRoot(dir, sourceFile)) {
			console.warn(`[pack-contributions] provider '${listName}' resolves outside providers/ (${sourceFile}); skipping`);
			continue;
		}
		let data: unknown;
		try {
			data = readYaml(sourceFile);
		} catch (err) {
			console.warn(`[pack-contributions] skipping missing/malformed provider '${listName}' (${sourceFile}): ${String(err)}`);
			continue;
		}
		if (!isPlainObject(data)) {
			console.warn(`[pack-contributions] provider '${listName}' (${sourceFile}) is not a mapping; dropping`);
			continue;
		}
		const id = data.id;
		if (typeof id !== "string" || !PROVIDER_ID_RE.test(id)) {
			console.warn(`[pack-contributions] provider '${listName}' (${sourceFile}) has invalid id; dropping`);
			continue;
		}
		const kindRaw = data.kind;
		const kind = kindRaw === undefined ? "generic" : kindRaw;
		if (typeof kind !== "string" || !PROVIDER_KINDS.has(kind)) {
			console.warn(`[pack-contributions] provider '${id}' (${sourceFile}) has invalid kind; dropping`);
			continue;
		}
		const mod = data.module;
		if (typeof mod !== "string" || !isSafeRelativePath(mod)) {
			console.warn(`[pack-contributions] provider '${id}' (${sourceFile}) has unsafe/missing module; dropping`);
			continue;
		}
		const resolvedModule = path.resolve(path.dirname(sourceFile), mod);
		if (!isPackPathWithinRoot(packRoot, resolvedModule)) {
			console.warn(`[pack-contributions] provider '${id}' (${sourceFile}) module resolves outside pack root; dropping`);
			continue;
		}
		const hooksRaw = data.hooks ?? [];
		if (!Array.isArray(hooksRaw) || !hooksRaw.every((h): h is string => typeof h === "string")) {
			console.warn(`[pack-contributions] provider '${id}' (${sourceFile}) has invalid hooks; dropping`);
			continue;
		}
		const unknownHook = hooksRaw.find((h) => !PROVIDER_HOOKS.has(h));
		if (unknownHook !== undefined) {
			console.warn(`[pack-contributions] provider '${id}' (${sourceFile}) declares unknown hook ${JSON.stringify(unknownHook)}; dropping`);
			continue;
		}
		if (seenId.has(id)) {
			throw new PackContributionError(
				`pack "${packIdFromRoot(packRoot)}" declares provider id "${id}" more than once; provider ids must be unique within a pack`,
			);
		}
		seenId.add(id);
		const budgetRaw = isPlainObject(data.budget) ? data.budget : {};
		const provider: ProviderContribution = {
			id,
			kind: kind as ProviderContribution["kind"],
			module: mod,
			hooks: hooksRaw,
			budget: {
				maxTokens: clampNumber(budgetRaw.maxTokens, 1600, 64, 8192),
				timeoutMs: clampNumber(budgetRaw.timeoutMs, 1500, 100, 10000),
			},
			listName,
			sourceFile,
			packRoot,
		};
		if (typeof data.runtime === "string" && data.runtime.length > 0) provider.runtime = data.runtime;
		const activation = parseProviderActivation(data.activation);
		const configlessConfigGate = data.config === undefined && hasOwnRequiresConfig(data.activation);
		if (isPlainObject(data.config)) {
			provider.configSchema = data.config;
			provider.config = resolveProviderConfigDefaults(data.config);
			if (hasSettingsDescriptor(data.config)) {
				const settings = normalizeExtensionSettingsSchema(data.config, data.activation);
				if (settings.schema) provider.settingsSchema = settings.schema;
				else provider.settingsSchemaDiagnostic = settings.diagnostic;
			}
		} else if (configlessConfigGate) {
			// Preserve opaque/bare-scalar config compatibility and tolerate unrelated
			// legacy activation metadata, but an explicit gate with no declaration is
			// invalid and must fail closed while remaining repairable in Market.
			provider.settingsSchemaDiagnostic = configlessActivationDiagnostic(data.activation);
		}
		if (activation) provider.activation = activation;
		out.push(provider);
	}
	return out;
}

const SERVICE_EXTENSION_TOP_LEVEL_KEYS = new Set(["id", "service", "config", "activation"]);

/** Load schema-2 `runtimes/<name>.yaml` service declarations only when their
 * basename is listed by the manifest. Invalid declarations are inert; no pack
 * document can smuggle a process command or an unbounded timing knob through
 * this projection. */
export function loadServiceExtensions(packRoot: string, manifest: PackManifest): ServiceExtensionContribution[] {
	if ((manifest.schema ?? 1) < 2) return [];
	const dir = path.join(packRoot, "runtimes");
	const out: ServiceExtensionContribution[] = [];
	const seenListNames = new Set<string>();
	const seenIds = new Set<string>();
	for (const listName of manifest.contents.runtimes ?? []) {
		if (!isSafeBasename(listName)) {
			console.warn(`[pack-contributions] runtime listName ${JSON.stringify(listName)} is not a safe basename; skipping`);
			continue;
		}
		if (seenListNames.has(listName)) {
			throw new PackContributionError(`pack "${packIdFromRoot(packRoot)}" declares runtime listName "${listName}" more than once; runtime listNames must be unique within a pack`);
		}
		seenListNames.add(listName);
		const sourceFile = resolveContributionFile(dir, listName);
		if (!isPackPathWithinRoot(dir, sourceFile)) {
			console.warn(`[pack-contributions] runtime '${listName}' resolves outside runtimes/ (${sourceFile}); skipping`);
			continue;
		}
		let data: unknown;
		try { data = readYaml(sourceFile); } catch (err) {
			console.warn(`[pack-contributions] skipping missing/malformed runtime '${listName}' (${sourceFile}): ${String(err)}`);
			continue;
		}
		if (!isPlainObject(data) || Object.keys(data).some(key => !SERVICE_EXTENSION_TOP_LEVEL_KEYS.has(key))) {
			console.warn(`[pack-contributions] runtime '${listName}' (${sourceFile}) has invalid top-level shape; dropping`);
			continue;
		}
		const id = data.id;
		if (typeof id !== "string" || !HOOK_ID_RE.test(id) || seenIds.has(id)) {
			if (seenIds.has(id as string)) throw new PackContributionError(`pack "${packIdFromRoot(packRoot)}" declares runtime id "${String(id)}" more than once; runtime ids must be unique within a pack`);
			console.warn(`[pack-contributions] runtime '${listName}' (${sourceFile}) has invalid id; dropping`);
			continue;
		}
		if (!isPlainObject(data.service)) {
			console.warn(`[pack-contributions] runtime '${id}' (${sourceFile}) has no service mapping; dropping`);
			continue;
		}
		const validated = validateServiceExtensionSpec({ ...data.service, id });
		if (!validated.ok) {
			console.warn(`[pack-contributions] runtime '${id}' (${sourceFile}) has invalid service declaration; dropping`);
			continue;
		}
		let settingsSchema: ExtensionSettingsSchema | undefined;
		let settingsSchemaDiagnostic: string | undefined;
		if (data.config !== undefined) {
			if (!isPlainObject(data.config) || !hasSettingsDescriptor(data.config)) {
				console.warn(`[pack-contributions] runtime '${id}' (${sourceFile}) config must be a settings descriptor mapping; dropping`);
				continue;
			}
			const normalized = normalizeExtensionSettingsSchema(data.config, data.activation);
			settingsSchema = normalized.schema;
			settingsSchemaDiagnostic = normalized.diagnostic;
		} else if (hasOwnRequiresConfig(data.activation)) {
			settingsSchemaDiagnostic = configlessActivationDiagnostic(data.activation);
		}
		const activation = parseProviderActivation(data.activation);
		if (settingsSchemaDiagnostic !== undefined || (data.activation !== undefined && !activation && !hasOwnRequiresConfig(data.activation))) {
			console.warn(`[pack-contributions] runtime '${id}' (${sourceFile}) has invalid settings/activation declaration; dropping`);
			continue;
		}
		seenIds.add(id);
		out.push({ id, spec: validated.value, ...(settingsSchema ? { settingsSchema } : {}), ...(activation ? { activation } : {}), listName, sourceFile, packRoot });
	}
	return out;
}

const SANDBOX_REQUIREMENT_TOP_LEVEL_KEYS = new Set(["id", "profiles", "config", "activation"]);
const SANDBOX_TOOLCHAIN_IDS = new Set(["python"] as const);
const MAX_SANDBOX_REQUIREMENT_PROFILES = 8;

/** Load schema-3 inert sandbox requirements from manifest-listed files only.
 * Reject rather than partially interpret every malformed declaration: only the
 * core-owned profile vocabulary can reach later authorization and planning. */
export function loadSandboxRequirements(packRoot: string, manifest: PackManifest): SandboxRequirementContribution[] {
	if ((manifest.schema ?? 1) < 3) return [];
	const dir = path.join(packRoot, "sandbox-requirements");
	const out: SandboxRequirementContribution[] = [];
	const seenListNames = new Set<string>();
	const seenIds = new Set<string>();
	for (const listName of manifest.contents.sandboxRequirements ?? []) {
		if (!isSafeBasename(listName)) {
			console.warn(`[pack-contributions] sandbox requirement listName ${JSON.stringify(listName)} is not a safe basename; skipping`);
			continue;
		}
		if (seenListNames.has(listName)) {
			throw new PackContributionError(`pack "${packIdFromRoot(packRoot)}" declares sandbox requirement listName "${listName}" more than once; listNames must be unique within a pack`);
		}
		seenListNames.add(listName);
		const sourceFile = resolveContributionFile(dir, listName);
		if (!isPackPathWithinRoot(dir, sourceFile)) {
			console.warn(`[pack-contributions] sandbox requirement '${listName}' resolves outside sandbox-requirements/ (${sourceFile}); skipping`);
			continue;
		}
		let data: unknown;
		try { data = readYaml(sourceFile); } catch (err) {
			console.warn(`[pack-contributions] skipping missing/malformed sandbox requirement '${listName}' (${sourceFile}): ${String(err)}`);
			continue;
		}
		if (!isPlainObject(data) || Object.keys(data).some(key => !SANDBOX_REQUIREMENT_TOP_LEVEL_KEYS.has(key))) {
			console.warn(`[pack-contributions] sandbox requirement '${listName}' (${sourceFile}) has invalid top-level shape; dropping`);
			continue;
		}
		const id = data.id;
		if (typeof id !== "string" || !HOOK_ID_RE.test(id) || seenIds.has(id)) {
			if (seenIds.has(id as string)) throw new PackContributionError(`pack "${packIdFromRoot(packRoot)}" declares sandbox requirement id "${String(id)}" more than once; ids must be unique within a pack`);
			console.warn(`[pack-contributions] sandbox requirement '${listName}' (${sourceFile}) has invalid id; dropping`);
			continue;
		}
		if (!Array.isArray(data.profiles) || data.profiles.length === 0 || data.profiles.length > MAX_SANDBOX_REQUIREMENT_PROFILES) {
			console.warn(`[pack-contributions] sandbox requirement '${id}' (${sourceFile}) has invalid profiles; dropping`);
			continue;
		}
		const profiles: ("python")[] = [];
		const seenProfiles = new Set<string>();
		let validProfiles = true;
		for (const profile of data.profiles) {
			if (typeof profile !== "string" || !SANDBOX_TOOLCHAIN_IDS.has(profile as "python") || seenProfiles.has(profile)) {
				validProfiles = false;
				break;
			}
			seenProfiles.add(profile);
			profiles.push(profile as "python");
		}
		if (!validProfiles) {
			console.warn(`[pack-contributions] sandbox requirement '${id}' (${sourceFile}) has unsupported or duplicate profiles; dropping`);
			continue;
		}
		if (data.config === undefined && data.activation !== undefined) {
			console.warn(`[pack-contributions] sandbox requirement '${id}' (${sourceFile}) has activation without config; dropping`);
			continue;
		}
		let settingsSchema: ExtensionSettingsSchema | undefined;
		if (data.config !== undefined) {
			const normalized = normalizeExtensionSettingsSchema(data.config, data.activation);
			if (!normalized.schema || normalized.schema.fields.some(field => field.type === "secret")) {
				console.warn(`[pack-contributions] sandbox requirement '${id}' (${sourceFile}) has invalid public settings/activation declaration; dropping`);
				continue;
			}
			settingsSchema = normalized.schema;
		}
		seenIds.add(id);
		const activation = settingsSchema?.requiresConfig;
		out.push({ id, profiles, ...(settingsSchema ? { settingsSchema } : {}), ...(activation && activation.length > 0 ? { activation: { requiresConfig: [...activation] } } : {}), listName, sourceFile, packRoot });
	}
	return out;
}

const MCP_LIST_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MCP_SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const WINDOWS_DEVICE_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const MCP_TOP_LEVEL_KEYS = new Set([
	"server",
	"runtimeServerKey",
	"label",
	"description",
	"subNamespace",
	"selectedOperations",
	"disabledOperations",
	"operations",
	"transport",
]);
const MCP_STDIO_KEYS = new Set(["type", "command", "args", "env", "cwd"]);
const MCP_HTTP_KEYS = new Set(["type", "url", "headers"]);

function failMcp(message: string): never {
	throw new McpContributionValidationError(message);
}

function hasPathSyntax(value: string): boolean {
	return value.includes("\0") || value.includes("/") || value.includes("\\") || path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

function isWindowsDeviceName(value: string): boolean {
	return WINDOWS_DEVICE_NAME_RE.test(value);
}

/** Strict pack-local MCP basename guard. This is intentionally tighter than the
 *  historical manifest basename guard: MCP refs are also install/materialization
 *  identities and must not use leading dots or Windows device names. */
export function isSafeMcpListName(name: unknown): name is string {
	if (typeof name !== "string") return false;
	if (!MCP_LIST_NAME_RE.test(name)) return false;
	if (name.includes("..") || name.startsWith(".") || hasPathSyntax(name)) return false;
	if (isWindowsDeviceName(name)) return false;
	return true;
}

/** Runtime MCP server names become model-facing meta-tool names and policy keys,
 *  so keep them display-safe and stable. */
export function isValidMcpServerName(name: unknown): name is string {
	if (typeof name !== "string") return false;
	if (!MCP_SERVER_NAME_RE.test(name)) return false;
	if (name === "." || name === ".." || name.includes("__") || hasPathSyntax(name)) return false;
	return true;
}

/** Registry/discovery entries materialize to pack name `mcp-${id}`. */
export function mcpGeneratedPackNameForId(id: string): string {
	if (!isSafeMcpListName(id)) failMcp(`invalid MCP id/listName ${JSON.stringify(id)}`);
	const packName = `mcp-${id}`;
	if (!isValidPackName(packName)) failMcp(`generated MCP pack name ${JSON.stringify(packName)} is not a valid marketplace pack name`);
	return packName;
}

function ensureOnlyKeys(obj: Record<string, unknown>, allowed: Set<string>, where: string): void {
	for (const key of Object.keys(obj)) {
		if (!allowed.has(key)) failMcp(`${where} has unknown key ${JSON.stringify(key)}`);
	}
}

function optionalString(obj: Record<string, unknown>, key: "label" | "description" | "subNamespace"): string | undefined {
	const value = obj[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0) failMcp(`${key} must be a non-empty string when present`);
	return value;
}

function stringArray(value: unknown, where: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
		failMcp(`${where} must be an array of strings`);
	}
	return [...value];
}

function stringRecord(value: unknown, where: string): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) failMcp(`${where} must be a string map`);
	const out: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (!key || key.includes("\0") || key.includes("\n") || key.includes("\r")) failMcp(`${where} contains an invalid key`);
		if (typeof item !== "string") failMcp(`${where}.${key} must be a string`);
		out[key] = item;
	}
	return out;
}

function operationName(value: unknown, where: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
		failMcp(`${where} must be a non-empty operation name`);
	}
	return value;
}

function operationNameArray(value: unknown, where: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) failMcp(`${where} must be an array of operation names`);
	return [...new Set(value.map((item, index) => operationName(item, `${where}[${index}]`)))];
}

function operationMetadataArray(value: unknown): McpPackOperationMetadata[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) failMcp("operations must be an array");
	const out: McpPackOperationMetadata[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < value.length; i++) {
		const item = value[i];
		let entry: McpPackOperationMetadata;
		if (typeof item === "string") {
			entry = { name: operationName(item, `operations[${i}]`) };
		} else if (isPlainObject(item)) {
			const allowed = new Set(["name", "label", "description"]);
			ensureOnlyKeys(item, allowed, `operations[${i}]`);
			entry = { name: operationName(item.name, `operations[${i}].name`) };
			if (typeof item.label === "string" && item.label.length > 0) entry.label = item.label;
			if (typeof item.description === "string" && item.description.length > 0) entry.description = item.description;
		} else {
			failMcp(`operations[${i}] must be a string or mapping`);
		}
		if (seen.has(entry.name)) failMcp(`operations contains duplicate operation ${JSON.stringify(entry.name)}`);
		seen.add(entry.name);
		out.push(entry);
	}
	return out;
}

function resolvePackCwd(cwd: unknown, packRoot: string): string | undefined {
	if (cwd === undefined) return undefined;
	if (typeof cwd !== "string" || cwd.length === 0) failMcp("transport.cwd must be a non-empty relative string");
	if (!isSafeRelativePath(cwd)) failMcp("transport.cwd must be relative and must not contain NUL bytes");
	const resolved = path.resolve(packRoot, cwd);
	const rel = path.relative(packRoot, resolved);
	if (rel.startsWith("..") || path.isAbsolute(rel)) failMcp("transport.cwd resolves outside the pack root");
	let rootReal: string;
	let cwdReal: string;
	try {
		rootReal = fs.realpathSync(packRoot);
		cwdReal = fs.realpathSync(resolved);
	} catch {
		failMcp("transport.cwd must resolve to an existing path inside the pack root");
	}
	const realRel = path.relative(rootReal, cwdReal);
	if (realRel.startsWith("..") || path.isAbsolute(realRel)) failMcp("transport.cwd realpath resolves outside the pack root");
	return resolved;
}

function normalizeHttpUrl(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) failMcp("transport.url must be a non-empty string");
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		failMcp("transport.url must be a valid URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") failMcp("transport.url must use http: or https:");
	if (parsed.username || parsed.password) failMcp("transport.url must not include credentials");
	if (parsed.hash) failMcp("transport.url must not include a fragment");
	return parsed.toString();
}

function normalizeMcpTransport(raw: unknown, packRoot: string): McpServerConfig {
	if (!isPlainObject(raw)) failMcp("transport is required and must be a mapping");
	const type = raw.type;
	if (type === "stdio") {
		ensureOnlyKeys(raw, MCP_STDIO_KEYS, "stdio transport");
		if (typeof raw.command !== "string" || raw.command.length === 0) failMcp("stdio transport.command must be a non-empty string");
		const config: McpServerConfig = { command: raw.command };
		const args = stringArray(raw.args, "stdio transport.args");
		if (args !== undefined) config.args = args;
		const env = stringRecord(raw.env, "stdio transport.env");
		if (env !== undefined) config.env = env;
		const cwd = resolvePackCwd(raw.cwd, packRoot);
		if (cwd !== undefined) config.cwd = cwd;
		return config;
	}
	if (type === "http") {
		ensureOnlyKeys(raw, MCP_HTTP_KEYS, "http transport");
		const config: McpServerConfig = { url: normalizeHttpUrl(raw.url) };
		const headers = stringRecord(raw.headers, "http transport.headers");
		if (headers !== undefined) config.headers = headers;
		return config;
	}
	failMcp("transport.type must be either 'stdio' or 'http'");
}

/** Strictly validate and normalize one already-parsed MCP contribution object. */
export function normalizeMcpContribution(raw: unknown, opts: NormalizeMcpContributionOptions): McpPackContribution {
	if (!isSafeMcpListName(opts.listName)) failMcp(`invalid MCP listName ${JSON.stringify(opts.listName)}`);
	if (!isPlainObject(raw)) failMcp("MCP contribution must be a mapping");
	ensureOnlyKeys(raw, MCP_TOP_LEVEL_KEYS, "MCP contribution");
	const serverName = raw.server === undefined ? opts.listName : raw.server;
	if (!isValidMcpServerName(serverName)) failMcp(`invalid MCP server name ${JSON.stringify(serverName)}`);
	const runtimeServerKey = raw.runtimeServerKey === undefined ? undefined : raw.runtimeServerKey;
	if (runtimeServerKey !== undefined && !isValidMcpServerName(runtimeServerKey)) failMcp(`invalid MCP runtimeServerKey ${JSON.stringify(runtimeServerKey)}`);
	const label = optionalString(raw, "label");
	const description = optionalString(raw, "description");
	const subNamespace = optionalString(raw, "subNamespace");
	if (subNamespace !== undefined && !isValidMcpServerName(subNamespace)) failMcp(`invalid MCP subNamespace ${JSON.stringify(subNamespace)}`);
	const selectedOperations = operationNameArray(raw.selectedOperations, "selectedOperations");
	const disabledOperations = operationNameArray(raw.disabledOperations, "disabledOperations");
	const operationMetadata = operationMetadataArray(raw.operations);
	const contribution: McpPackContribution = {
		listName: opts.listName,
		serverName,
		config: normalizeMcpTransport(raw.transport, opts.packRoot),
		sourceFile: opts.sourceFile,
		packRoot: opts.packRoot,
	};
	if (runtimeServerKey !== undefined) contribution.runtimeServerKey = runtimeServerKey;
	if (label !== undefined) contribution.label = label;
	if (description !== undefined) contribution.description = description;
	if (subNamespace !== undefined) contribution.subNamespace = subNamespace;
	if (selectedOperations !== undefined) contribution.selectedOperations = selectedOperations;
	if (disabledOperations !== undefined) contribution.disabledOperations = disabledOperations;
	if (operationMetadata !== undefined) contribution.operationMetadata = operationMetadata;
	return contribution;
}

function readMcpContributionFile(file: string): unknown {
	const raw = fs.readFileSync(file, "utf-8");
	if (file.endsWith(".json")) return JSON.parse(raw);
	return parse(raw);
}

function resolveMcpContributionFile(dir: string, listName: string): string {
	const candidates = [
		path.join(dir, `${listName}.yaml`),
		path.join(dir, `${listName}.yml`),
		path.join(dir, `${listName}.json`),
	];
	return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

/** Load `mcp/<name>.yaml|json` ONLY for names listed in contents.mcp[]. */
export function loadMcpContributions(packRoot: string, manifest: PackManifest): McpPackContribution[] {
	if ((manifest.schema ?? 1) < 2) return [];
	const listNames = manifest.contents.mcp ?? [];
	const dir = path.join(packRoot, "mcp");
	const out: McpPackContribution[] = [];
	const seenListName = new Set<string>();
	for (const listName of listNames) {
		if (typeof listName !== "string" || listName.length === 0) continue;
		if (!isSafeMcpListName(listName)) {
			console.warn(`[pack-contributions] MCP listName ${JSON.stringify(listName)} is not a safe MCP basename; skipping`);
			continue;
		}
		if (seenListName.has(listName)) {
			throw new PackContributionError(
				`pack "${packIdFromRoot(packRoot)}" declares MCP listName "${listName}" more than once; MCP listNames must be unique within a pack`,
			);
		}
		seenListName.add(listName);
		const sourceFile = resolveMcpContributionFile(dir, listName);
		if (!isPackPathWithinRoot(dir, sourceFile)) {
			console.warn(`[pack-contributions] MCP '${listName}' resolves outside mcp/ (${sourceFile}); skipping`);
			continue;
		}
		let data: unknown;
		try {
			data = readMcpContributionFile(sourceFile);
			out.push(normalizeMcpContribution(data, { listName, sourceFile, packRoot }));
		} catch (err) {
			console.warn(`[pack-contributions] skipping missing/malformed MCP '${listName}' (${sourceFile}): ${String(err)}`);
			continue;
		}
	}
	return out;
}

/** Build the pack-level RouteContribution from pack.yaml.routes. Duplicate route
 *  name within the allowlist = hard conflict. */
function loadRoutes(packRoot: string, manifest: PackManifest): RouteContribution | undefined {
	const ref = manifest.routes;
	if (!ref || !ref.module) return undefined;
	if (!isSafeRelativePath(ref.module)) {
		console.warn(`[pack-contributions] pack "${packIdFromRoot(packRoot)}" routes.module "${ref.module}" is unsafe; dropping routes`);
		return undefined;
	}
	const names = (ref.names ?? []).filter((n): n is string => typeof n === "string" && ROUTE_NAME_RE.test(n));
	const seen = new Set<string>();
	for (const n of names) {
		if (seen.has(n)) {
			throw new PackContributionError(
				`pack "${packIdFromRoot(packRoot)}" declares route name "${n}" more than once; route names must be unique within a pack`,
			);
		}
		seen.add(n);
	}
	return {
		module: ref.module,
		names,
		sourceFile: path.join(packRoot, "pack.yaml"),
		packRoot,
	};
}
