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
//   5. duplicate provider id within a pack.
//
// Each contribution carries its declaring `sourceFile` + the absolute `packRoot`
// so the serve/import sites can resolve a path-bearing field RELATIVE to the
// declaring YAML and enforce realpath containment against the pack root (§2).

import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { PackManifest } from "./pack-types.js";
import { isSafeRelativePath, parseEntrypoints } from "./tool-contributions.js";
import { isSafeBasename, isValidPackName } from "./pack-manifest.js";
import { isPackPathWithinRoot } from "../extension-host/path-guard.js";
import type { McpServerConfig } from "../mcp/mcp-types.js";

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
	/** Config-gated activation: the provider is omitted from the active provider
	 *  listing until the EFFECTIVE flat config has a non-empty value for every
	 *  key in `requiresConfig` (DisabledRefs/pack activation still wins). Enables a
	 *  truly dormant install — no provider bridge, no per-turn hook routes, no
	 *  network — until configured. */
	activation?: { requiresConfig: string[] };
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

/** Collapse a provider `config` SCHEMA mapping to FLAT default values: a
 *  descriptor object contributes its `.default` (omitted when it has none — an
 *  optional field with no default stays `undefined`); a bare scalar is treated as
 *  the literal default. Never recurses — provider config is a flat key→descriptor
 *  surface. */
export function resolveProviderConfigDefaults(schema: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, descriptor] of Object.entries(schema)) {
		if (isPlainObject(descriptor)) {
			if ("default" in descriptor) out[key] = descriptor.default;
			// optional with no default → omitted (effective value is `undefined`).
		} else {
			out[key] = descriptor; // bare-scalar shorthand = the literal default
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

/** All pack-scoped contributions for ONE installed pack. */
export interface PackContributions {
	packId: string; // structural, from the pack root dir name
	packName: string;
	packRoot: string;
	panels: PanelContribution[];
	entrypoints: EntrypointContribution[];
	providers: ProviderContribution[];
	/** Channel handler files listed by contents.channels[]. */
	channels: ChannelContribution[];
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
		channels: loadChannels(packRoot, manifest),
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
		if (isPlainObject(data.config)) {
			provider.configSchema = data.config;
			provider.config = resolveProviderConfigDefaults(data.config);
		}
		const activation = parseProviderActivation(data.activation);
		if (activation) provider.activation = activation;
		out.push(provider);
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
