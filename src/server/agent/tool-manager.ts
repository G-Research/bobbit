import fs from "node:fs";
import path from "node:path";
import { parse, parseDocument } from "yaml";
import { fileURLToPath } from "node:url";
import type { GrantPolicy } from "./role-store.js";
import { profile } from "./profiling.js";
import { parseContributions, computeRendererKind, type ToolContributions } from "./tool-contributions.js";
import { __resetToolExtensionPreflightDiagnostics, isIgnoredToolGroupDir, logToolExtensionDiagnostic, preflightConfigBobbitExtension, preflightConfigExtensionFile, type ToolExtensionDiagnostic } from "./tool-extension-preflight.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ToolProvider {
	type: 'builtin' | 'bobbit-extension' | 'mcp' | 'pi-extension';
	tool?: string;       // for builtin
	extension?: string;  // for bobbit-extension
	server?: string;     // for mcp
	mcpTool?: string;    // for mcp
	providerKey?: string; // for pi-extension
}

export interface ScopedToolContext {
	projectId?: string;
	cwd?: string;
	scopeKey: string;
}

export interface PiExtensionToolProviderInfo {
	providerKey: string;
	packName: string;
	packId: string;
	listName: string;
	scope: string;
	sourcePath?: string;
}

export interface PiExtensionExternalTool {
	name: string;
	runtimeName?: string;
	description?: string;
	summary?: string;
	group?: string;
	docs?: string;
	inputSchema?: Record<string, unknown>;
	providerKey?: string;
	packName: string;
	packId: string;
	listName: string;
	scope: string;
	sourcePath?: string;
}

/**
 * One installed market-pack `tools/` root, carrying the pack-activation
 * disabled-tool-name list for that pack at the resolving scope (pack-schema-v1
 * §7). Runtime tool resolution (renderer GET, action POST, surface-token mint,
 * prompt docs, `/api/tools`) drops disabled pack tool names so it matches the
 * ConfigCascade listing instead of split-braining — a disabled high-priority
 * pack tool stops resolving and a lower-priority same-name tool reappears.
 * `disabledTools` is keyed by the SAME `pack_activation` store the cascade reads.
 */
export interface MarketToolRoot {
	dir: string;
	disabledTools?: string[];
}

/** Base tool definition loaded from YAML */
interface BaseToolInfo {
	name: string;
	description: string;
	summary?: string;
	group: string;
	renderer?: string;
	docs?: string;
	detail_docs?: string;
	provider?: ToolProvider;
	/** Grant policy loaded from YAML; undefined means "not configured" */
	grantPolicy?: GrantPolicy;
	/** Optional positional parameter names (trailing `?` marks optional). Drives compact `(args)` rendering. */
	params?: string[];
	/** Subdirectory name within tools/ (e.g. "shell", "filesystem"). Empty string for flat files. */
	groupDir: string;
	/** Absolute path to the YAML file on disk. */
	filePath: string;
	/** Absolute path to the tools/ parent directory where this tool was found. */
	baseDir: string;
	/** Extension-host contribution points parsed from the tool YAML (design §2). */
	contributions: ToolContributions;
}

export interface ToolInfo {
	name: string;
	description: string;
	group: string;
	docs?: string;
	detail_docs?: string;
	hasRenderer: boolean;
	rendererFile?: string;
	/** Extension-host renderer delivery (design §2.5): "pack" ⇒ serve + lazy-import the
	 *  pre-built ESM renderer at runtime; "builtin" ⇒ display-only metadata. */
	rendererKind?: "builtin" | "pack";
	/** True when the tool declares an `actions:` server-actions module (design §2.5). */
	hasActions?: boolean;
	/** Optional declared action-name allowlist (from `actions.names`). */
	actionNames?: string[];
	/** Grant policy from YAML; undefined means "not configured" */
	grantPolicy?: GrantPolicy;
	/** Optional positional parameter names (trailing `?` marks optional). */
	params?: string[];
	providerType?: "pi-extension";
	origin?: "marketplace-pi-extension" | string;
	originPackName?: string;
	originPackId?: string;
	sourcePath?: string;
	providers?: PiExtensionToolProviderInfo[];
	/** Invalid config-level override diagnostics related to this tool, when a lower-priority fallback won. */
	diagnostics?: ToolExtensionDiagnostic[];
}

/** Map the extension-host contribution fields from a scanned BaseToolInfo onto the
 *  wire ToolInfo (design §2.5). Optional fields only — additive, never reorders or
 *  changes existing values, preserving the `buildPackList` byte-identical invariant. */
function contributionFields(base: BaseToolInfo): Pick<ToolInfo, "rendererKind" | "hasActions" | "actionNames"> {
	const c = base.contributions;
	return {
		// Source the renderer from the PARSED/validated contribution — NOT the raw
		// `base.renderer` — so an unsafe/dropped renderer path (e.g. `../evil.js`,
		// rejected by parseContributions) yields rendererKind "builtin", never "pack".
		// For safe paths `c.renderer === base.renderer`, so this is byte-identical.
		rendererKind: computeRendererKind(base.baseDir, c.renderer),
		hasActions: !!c.actions,
		actionNames: c.actions?.names,
	};
}

function parseParamsField(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: string[] = [];
	for (const v of value) {
		if (typeof v === "string" && v.trim().length > 0) out.push(v.trim());
	}
	return out.length > 0 ? out : undefined;
}

import { bobbitConfigDir } from "../bobbit-dir.js";


/**
 * Tool definitions directory — .bobbit/config/tools/ (runtime config-layer, legacy export, deprecated).
 * @deprecated Use ToolManager.getExtensionPath() or ToolManager.getToolsDir() instead.
 */
export const TOOLS_DIR = path.join(bobbitConfigDir(), "tools");

/** Default builtins tools directory: dist/server/defaults/tools/ */
function defaultBuiltinToolsDir(): string {
	return path.join(__dirname, "..", "defaults", "tools");
}

/**
 * Scan a single tools/ directory and return all tool definitions.
 * Supports both grouped layout (tools/<group>/*.yaml) and flat layout (tools/*.yaml).
 */
function scanToolsDir(toolsDir: string, baseDir: string): BaseToolInfo[] {
	const tools: BaseToolInfo[] = [];

	try {
		const entries = fs.readdirSync(toolsDir, { withFileTypes: true });

		// First pass: scan group subdirectories (tools/<group>/*.yaml)
		for (const entry of entries) {
			if (!entry.isDirectory() || isIgnoredToolGroupDir(entry.name)) continue;
			const groupDir = entry.name;
			const groupPath = path.join(toolsDir, groupDir);
			try {
				const files = fs.readdirSync(groupPath, { withFileTypes: true });
				for (const file of files) {
					if (!file.isFile() || !file.name.endsWith(".yaml")) continue;
					const filePath = path.join(groupPath, file.name);
					try {
						const raw = fs.readFileSync(filePath, "utf-8");
						const data = parse(raw);
						if (data && typeof data === "object" && data.name) {
							tools.push({
								name: data.name,
								description: data.description || "",
								summary: data.summary,
								group: data.group || groupDir,
								renderer: data.renderer,
								docs: data.docs,
								detail_docs: data.detail_docs,
								provider: data.provider,
								grantPolicy: data.grantPolicy,
								params: parseParamsField(data.params),
								groupDir,
								filePath,
								baseDir,
								contributions: parseContributions(data, filePath),
							});
						}
					} catch (err) {
						console.error(`[tool-manager] Failed to load tool ${filePath}:`, err);
					}
				}
			} catch {
				// Can't read group dir — skip
			}
		}

		// Second pass: scan flat files (tools/*.yaml) for backward compat
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
			const filePath = path.join(toolsDir, entry.name);
			try {
				const raw = fs.readFileSync(filePath, "utf-8");
				const data = parse(raw);
				if (data && typeof data === "object" && data.name) {
					tools.push({
						name: data.name,
						description: data.description || "",
						summary: data.summary,
						group: data.group || "Other",
						renderer: data.renderer,
						docs: data.docs,
						detail_docs: data.detail_docs,
						provider: data.provider,
						grantPolicy: data.grantPolicy,
						params: parseParamsField(data.params),
						groupDir: "",
						filePath,
						baseDir,
						contributions: parseContributions(data, filePath),
					});
				}
			} catch (err) {
				console.error(`[tool-manager] Failed to load tool ${entry.name}:`, err);
			}
		}
	} catch {
		// Directory doesn't exist — return empty
	}
	return tools;
}

// ── mtime-keyed cache for scanToolsDir ────────────────────────────────────
//
// Tool YAMLs almost never change at runtime. Re-reading 51 builtin YAMLs +
// any project overlays on every session create burns 100–800ms per worker
// under FS contention (Defender, parallel workers competing for the same
// inodes). We hash the directory tree's structural mtimes (cheap stat()
// calls) and reuse the parsed result while the tree is unchanged.
//
// Invalidation is conservative: if anything looks off we re-scan. The cost
// of a false miss is one full scan; the cost of a false hit would be a
// stale tool list, so we err on the side of re-scanning.
const _scanCache = new Map<string, { fingerprint: string; tools: BaseToolInfo[] }>();

function directoryFingerprint(dir: string): string {
	try {
		const rootStat = fs.statSync(dir);
		const parts: string[] = [`${dir}:${rootStat.mtimeMs}`];
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, entry.name);
			try {
				const st = fs.statSync(p);
				parts.push(`${entry.name}:${st.mtimeMs}:${st.size}`);
			} catch {
				parts.push(`${entry.name}:miss`);
			}
		}
		return parts.join("|");
	} catch {
		return "missing";
	}
}

function scanToolsDirCached(toolsDir: string, baseDir: string): BaseToolInfo[] {
	const fp = directoryFingerprint(toolsDir);
	const hit = _scanCache.get(toolsDir);
	if (hit && hit.fingerprint === fp) return hit.tools;
	const tools = scanToolsDir(toolsDir, baseDir);
	_scanCache.set(toolsDir, { fingerprint: fp, tools });
	return tools;
}

/** Test/maintenance hook: drop the scan cache. */
export function __resetToolScanCache(): void {
	_scanCache.clear();
	__resetToolExtensionPreflightDiagnostics();
}

function invalidConfigToolDiagnostic(tool: BaseToolInfo): ToolExtensionDiagnostic | undefined {
	return preflightConfigBobbitExtension({
		toolName: tool.name,
		groupDir: tool.groupDir,
		baseDir: tool.baseDir,
		provider: tool.provider,
	});
}

function groupHasBobbitProviderForExtension(tools: BaseToolInfo[], groupDir: string, extension: string): boolean {
	return tools.some((tool) => tool.groupDir === groupDir && tool.provider?.type === "bobbit-extension" && (tool.provider.extension ?? "extension.ts") === extension);
}

function invalidConfigGroupExtensionDiagnostic(toolsDir: string, groupDir: string, extension = "extension.ts", groupTools?: BaseToolInfo[]): ToolExtensionDiagnostic | undefined {
	if (groupTools && groupHasBobbitProviderForExtension(groupTools, groupDir, extension)) return undefined;
	const extensionPath = path.join(toolsDir, groupDir, extension);
	try {
		if (!fs.statSync(extensionPath).isFile()) return undefined;
	} catch {
		return undefined;
	}
	return preflightConfigExtensionFile({
		toolName: `${groupDir}/${extension}`,
		groupDir,
		baseDir: toolsDir,
		extension,
	});
}

function collectInvalidConfigGroupExtensionDiagnostics(toolsDir: string, tools: BaseToolInfo[] = scanToolsDirCached(toolsDir, toolsDir)): ToolExtensionDiagnostic[] {
	const diagnostics: ToolExtensionDiagnostic[] = [];
	try {
		for (const entry of fs.readdirSync(toolsDir, { withFileTypes: true })) {
			if (!entry.isDirectory() || isIgnoredToolGroupDir(entry.name)) continue;
			const diagnostic = invalidConfigGroupExtensionDiagnostic(toolsDir, entry.name, "extension.ts", tools);
			if (diagnostic) diagnostics.push(diagnostic);
		}
	} catch { /* config tools dir absent */ }
	return diagnostics;
}

function collectInvalidConfigToolDiagnostics(tools: BaseToolInfo[]): ToolExtensionDiagnostic[] {
	const diagnostics: ToolExtensionDiagnostic[] = [];
	const seen = new Set<string>();
	for (const tool of tools) {
		const diagnostic = invalidConfigToolDiagnostic(tool);
		if (!diagnostic) continue;
		const key = `${diagnostic.toolName}\0${diagnostic.extensionPath}\0${diagnostic.message}`;
		if (seen.has(key)) continue;
		seen.add(key);
		diagnostics.push(diagnostic);
	}
	return diagnostics;
}

function filterInvalidConfigTools(tools: BaseToolInfo[], invalidGroupExtensions: Set<string> = new Set()): BaseToolInfo[] {
	const invalidNames = new Set<string>();
	for (const diagnostic of collectInvalidConfigToolDiagnostics(tools)) {
		logToolExtensionDiagnostic(diagnostic);
		invalidNames.add(diagnostic.toolName);
	}
	return tools.filter((tool) => !invalidNames.has(tool.name) && !toolDependsOnInvalidGroupExtension(tool, invalidGroupExtensions));
}

function toolDependsOnInvalidGroupExtension(tool: BaseToolInfo, invalidGroupExtensions: Set<string>): boolean {
	if (!tool.groupDir || !invalidGroupExtensions.has(tool.groupDir)) return false;
	if (tool.provider?.type === "builtin" && tool.provider.tool === "bash") return true;
	if (tool.provider?.type === "bobbit-extension" && (tool.provider.extension ?? "extension.ts") === "extension.ts") return true;
	return false;
}

/**
 * Load tool definitions over an ordered cascade of layers (low→high priority):
 *
 *   builtin (lowest)  <  market-pack roots (low→high)  <  config-level toolsDir
 *
 * Precedence is **by tool NAME** — a higher layer's tool overrides a lower
 * layer's same-named tool, matching the unified `PackResolver`/`ToolLoader`
 * that powers `/api/tools` (design §3.2). Runtime resolution and the config
 * API therefore return the SAME tool set for any pack arrangement (finding #1).
 *
 * The ONE legacy exception, preserved byte-identical, is the builtin ↔ user
 * `toolsDir` pair: if the user layer defines a group, it shadows that ENTIRE
 * same-named group in the BUILTIN layer (the pre-cascade two-layer behavior
 * pinned by `tests/e2e/tools-cascade.spec.ts` etc.). This whole-group replace
 * is identical to a by-name merge in practice because customizing a builtin
 * tool copies the WHOLE group into `toolsDir` first (see `updateToolMetadata`).
 *
 * Market-pack layers are pure **by-name overlays**: they add new tools and may
 * override an individual same-named tool, but NEVER shadow the rest of a
 * builtin/user group. So installing a market pack that touches a shared group
 * (e.g. `tools/shell/extra.yaml`) can never drop builtin tools like `bash`.
 *
 * With zero market roots this collapses to the original two-layer cascade
 * (builtin → toolsDir) and is byte-identical to the legacy behavior — see
 * docs/design/pack-based-marketplace.md §3.2 / finding #1.
 */
function loadToolDefinitions(toolsDir: string, builtinToolsDir?: string, marketRoots: MarketToolRoot[] = []): BaseToolInfo[] {
	return profile("loadToolDefinitions", () => _loadToolDefinitions(toolsDir, builtinToolsDir, marketRoots));
}

function _loadToolDefinitions(toolsDir: string, builtinToolsDir?: string, marketRoots: MarketToolRoot[] = []): BaseToolInfo[] {
	// Ordered layers, low→high priority. The builtin layer is lowest, the
	// scope's own user `toolsDir` overlay is highest, market-pack tool roots sit
	// in between (caller orders them server < global-user < project, design §3.2).
	// Each market layer carries its pack-activation `disabledTools` set so a
	// disabled pack tool is dropped at winner selection — mirroring the
	// ConfigCascade activation filter so runtime and `/api/tools` never split-brain.
	const layers: Array<{ dir: string; isBuiltin: boolean; disabledTools?: Set<string> }> = [];
	if (builtinToolsDir) layers.push({ dir: builtinToolsDir, isBuiltin: true });
	for (const r of marketRoots) {
		layers.push({
			dir: r.dir,
			isBuiltin: false,
			disabledTools: r.disabledTools && r.disabledTools.length > 0 ? new Set(r.disabledTools) : undefined,
		});
	}
	layers.push({ dir: toolsDir, isBuiltin: false }); // user `toolsDir` (highest)
	const userIdx = layers.length - 1;

	const invalidUserGroupExtensions = new Set<string>();
	for (const diagnostic of collectInvalidConfigGroupExtensionDiagnostics(toolsDir)) {
		logToolExtensionDiagnostic(diagnostic);
		invalidUserGroupExtensions.add(diagnostic.groupDir);
	}
	const invalidUserToolGroups = new Set<string>(invalidUserGroupExtensions);
	const scanned = layers.map((l, idx) => {
		const tools = scanToolsDirCached(l.dir, l.dir);
		if (idx !== userIdx) return tools;
		for (const diagnostic of collectInvalidConfigToolDiagnostics(tools)) invalidUserToolGroups.add(diagnostic.groupDir);
		return filterInvalidConfigTools(tools, invalidUserGroupExtensions);
	});

	// Builtin ↔ user whole-group replace (legacy, ONLY this pair): a group the
	// USER layer defines fully shadows the SAME group in the BUILTIN layer.
	// Market layers neither own nor are shadowed by groups — they overlay by
	// tool NAME only (design §3.2 / finding #1). If any config tool/extension in
	// the group failed preflight, disable whole-group shadowing so lower-priority
	// builtins can still provide per-tool fallbacks while valid config tools keep
	// winning by name.
	const userGroups = new Set<string>();
	for (const t of scanned[userIdx]) if (t.groupDir && !invalidUserToolGroups.has(t.groupDir)) userGroups.add(t.groupDir);

	// Resolve the winner per tool name (higher layer wins — matches the
	// PackResolver), but emit in first-seen low→high order so prompt/doc output
	// order is stable (builtins first).
	const winner = new Map<string, BaseToolInfo>();
	const order: string[] = [];
	scanned.forEach((tools, idx) => {
		const isBuiltin = layers[idx].isBuiltin;
		const disabledTools = layers[idx].disabledTools;
		for (const t of tools) {
			// Builtin tool in a group the user owns ⇒ whole-group shadowed.
			if (isBuiltin && t.groupDir && userGroups.has(t.groupDir)) continue;
			// pack-schema-v1 §7: a market-pack tool disabled via pack_activation
			// drops out, so a lower-priority same-name tool (an earlier market
			// layer or the builtin) becomes the resolved winner — exactly as the
			// ConfigCascade does for the `/api/tools` listing. Builtins are never
			// toggleable (no disabledTools set), so they are unaffected.
			if (disabledTools && disabledTools.has(t.name)) continue;
			if (!winner.has(t.name)) order.push(t.name);
			winner.set(t.name, t); // higher layer overwrites lower by name
		}
	});

	return order.map((n) => winner.get(n)!);
}

/** Recursively copy a directory. */
export function copyDirRecursive(src: string, dest: string): void {
	if (!fs.existsSync(src)) return;
	fs.mkdirSync(dest, { recursive: true });
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		const srcPath = path.join(src, entry.name);
		const destPath = path.join(dest, entry.name);
		if (entry.isDirectory()) {
			copyDirRecursive(srcPath, destPath);
		} else {
			fs.copyFileSync(srcPath, destPath);
		}
	}
}

/**
 * Manages tool definitions and metadata.
 * Tool definitions are loaded from tools/<group>/*.yaml on every read.
 * Supports a two-layer cascade: builtinToolsDir (read-only) → toolsDir (overrides).
 */
export class ToolManager {
	private externalTools = new Map<string, { name: string; description: string; summary?: string; group: string; docs?: string; provider: ToolProvider }>();
	private scopedPiExtensionTools = new Map<string, Map<string, PiExtensionExternalTool[]>>();
	private readonly toolsDir: string;
	private readonly builtinToolsDir: string | undefined;
	/**
	 * Supplies the ordered `tools/` roots of installed market packs (low→high
	 * priority) so market-pack tools resolve at runtime — listed, documented,
	 * provider-loaded, and usable in sessions. Injected by `server.ts` (mirrors
	 * the roles/tools cascade `marketPackProvider`). Omitted ⇒ no market roots,
	 * so resolution is byte-identical to the legacy two-layer cascade.
	 * See docs/design/pack-based-marketplace.md §3.2 / finding #1.
	 */
	private marketRootsProvider?: () => Array<string | MarketToolRoot>;

	constructor(configDir: string, builtinToolsDir?: string) {
		this.toolsDir = path.join(configDir, "tools");
		this.builtinToolsDir = builtinToolsDir ?? defaultBuiltinToolsDir();
	}

	private configGroupHasInvalidExtension(groupDir: string): boolean {
		let invalid = false;
		const tools = scanToolsDirCached(this.toolsDir, this.toolsDir).filter((tool) => tool.groupDir === groupDir);
		const groupDiagnostic = invalidConfigGroupExtensionDiagnostic(this.toolsDir, groupDir, "extension.ts", tools);
		if (groupDiagnostic) {
			logToolExtensionDiagnostic(groupDiagnostic);
			invalid = true;
		}
		for (const tool of tools) {
			const diagnostic = invalidConfigToolDiagnostic(tool);
			if (!diagnostic) continue;
			logToolExtensionDiagnostic(diagnostic);
			invalid = true;
		}
		return invalid;
	}

	/**
	 * Late-bind the installed market-pack `tools/` roots provider (design §3.2).
	 * A root may be a bare `dir` string (no activation filtering) or a
	 * {@link MarketToolRoot} carrying the pack's `pack_activation` disabled-tool
	 * list, so disabled pack tools drop out of runtime resolution consistently
	 * with the cascade listing (pack-schema-v1 §7).
	 */
	setMarketToolRootsProvider(provider: () => Array<string | MarketToolRoot>): void {
		this.marketRootsProvider = provider;
	}

	/** Resolve the current ordered market-pack `tools/` roots (low→high), normalized. */
	private marketRoots(): MarketToolRoot[] {
		try {
			const raw = this.marketRootsProvider?.() ?? [];
			return raw.map((r) => (typeof r === "string" ? { dir: r } : r));
		} catch {
			return [];
		}
	}

	/** Get the config-level tools directory. */
	getToolsDir(): string {
		return this.toolsDir;
	}

	/** Get the builtins tools directory (dist/server/defaults/tools/). */
	getBuiltinToolsDir(): string | undefined {
		return this.builtinToolsDir;
	}

	/**
	 * Resolve which tools/ parent directory contains a given group.
	 * Config-level (toolsDir) takes priority over builtins.
	 */
	getToolGroupBaseDir(groupDir: string): string {
		// Check config-level first. Archived/disabled groups and groups with broken
		// config-level bobbit-extension providers must not shadow bundled tools.
		const configGroup = path.join(this.toolsDir, groupDir);
		try {
			if (!isIgnoredToolGroupDir(groupDir) && fs.statSync(configGroup).isDirectory() && !this.configGroupHasInvalidExtension(groupDir)) return this.toolsDir;
		} catch { /* not found */ }

		// Check builtins
		if (this.builtinToolsDir) {
			const builtinGroup = path.join(this.builtinToolsDir, groupDir);
			try {
				if (fs.statSync(builtinGroup).isDirectory()) return this.builtinToolsDir;
			} catch { /* not found */ }
		}

		// Fallback to config dir (for new user-created groups)
		return this.toolsDir;
	}

	/**
	 * Resolve the absolute path to a file within a tool group, respecting the cascade.
	 * This is the primary method for resolving extension paths — replaces direct TOOLS_DIR usage.
	 */
	getExtensionPath(groupDir: string, filename: string): string {
		const baseDir = this.getToolGroupBaseDir(groupDir);
		return path.join(baseDir, groupDir, filename);
	}

	/**
	 * Delete a tool group from the config-level tools directory, reverting to the builtin version.
	 * Returns true if the group was deleted, false if it didn't exist.
	 */
	revertToolGroup(groupDir: string): boolean {
		const configGroup = path.join(this.toolsDir, groupDir);
		try {
			if (fs.statSync(configGroup).isDirectory()) {
				fs.rmSync(configGroup, { recursive: true, force: true });
				// Invalidate the scan cache (PR #388) so the next read sees the
				// reverted state on Windows where mtime resolution is coarse.
				_scanCache.delete(this.toolsDir);
				return true;
			}
		} catch { /* not found */ }
		return false;
	}

	/** Register tools from external sources (e.g. MCP servers). */
	registerExternalTools(tools: Array<{ name: string; description: string; summary?: string; group: string; docs?: string; provider: ToolProvider }>): void {
		for (const tool of tools) {
			this.externalTools.set(tool.name, tool);
		}
	}

	/** Remove all external tools whose name starts with the given prefix. */
	removeExternalTools(prefix: string): void {
		for (const key of this.externalTools.keys()) {
			if (key.startsWith(prefix)) this.externalTools.delete(key);
		}
	}

	/** Replace discovered pi-extension tools for one scoped context. */
	setScopedPiExtensionTools(context: ScopedToolContext, tools: PiExtensionExternalTool[]): void {
		const scopeKey = this.normalizeScopeKey(context);
		const grouped = new Map<string, PiExtensionExternalTool[]>();
		for (const tool of tools) {
			const runtimeName = this.piToolRuntimeName(tool);
			if (!runtimeName) continue;
			const key = runtimeName.toLowerCase();
			const list = grouped.get(key) ?? [];
			list.push({ ...tool, name: runtimeName, runtimeName });
			grouped.set(key, list);
		}
		this.scopedPiExtensionTools.set(scopeKey, grouped);
	}

	/** Append discovered pi-extension tools to one scoped context. */
	registerScopedPiExtensionTools(context: ScopedToolContext, tools: PiExtensionExternalTool[]): void {
		const scoped = this.scopedPiExtensionTools.get(this.normalizeScopeKey(context));
		const existing = scoped ? [...scoped.values()].flat() : [];
		this.setScopedPiExtensionTools(context, [...existing, ...tools]);
	}

	/** Remove discovered pi-extension tools for one scoped context. */
	clearScopedPiExtensionTools(context?: ScopedToolContext): void {
		if (!context) {
			this.scopedPiExtensionTools.clear();
			return;
		}
		this.scopedPiExtensionTools.delete(this.normalizeScopeKey(context));
	}

	/** Return pi-extension tools visible in the supplied scope (global/default + exact scope). */
	resolveScopedPiExtensionTools(context?: ScopedToolContext): PiExtensionExternalTool[] {
		const keys = this.visibleScopeKeys(context);
		const out: PiExtensionExternalTool[] = [];
		for (const key of keys) {
			const scoped = this.scopedPiExtensionTools.get(key);
			if (!scoped) continue;
			for (const providers of scoped.values()) out.push(...providers);
		}
		return out;
	}

	private normalizeScopeKey(context?: ScopedToolContext): string {
		return context?.scopeKey?.trim() || "default";
	}

	private visibleScopeKeys(context?: ScopedToolContext): string[] {
		const scopeKey = this.normalizeScopeKey(context);
		return scopeKey === "default" ? ["default"] : ["default", scopeKey];
	}

	private piToolRuntimeName(tool: PiExtensionExternalTool): string {
		return (tool.runtimeName || tool.name || "").trim();
	}

	private piToolProviderInfo(tool: PiExtensionExternalTool, scopeKey: string): PiExtensionToolProviderInfo {
		const runtimeName = this.piToolRuntimeName(tool);
		return {
			providerKey: tool.providerKey || `pi-ext:${scopeKey}:${tool.packId}:${tool.listName}:${runtimeName}`,
			packName: tool.packName,
			packId: tool.packId,
			listName: tool.listName,
			scope: tool.scope,
			sourcePath: tool.sourcePath,
		};
	}

	private scopedPiToolGroups(context?: ScopedToolContext): Map<string, { runtimeName: string; tools: PiExtensionExternalTool[]; providers: PiExtensionToolProviderInfo[] }> {
		const out = new Map<string, { runtimeName: string; tools: PiExtensionExternalTool[]; providers: PiExtensionToolProviderInfo[] }>();
		for (const scopeKey of this.visibleScopeKeys(context)) {
			const scoped = this.scopedPiExtensionTools.get(scopeKey);
			if (!scoped) continue;
			for (const providers of scoped.values()) {
				for (const tool of providers) {
					const runtimeName = this.piToolRuntimeName(tool);
					if (!runtimeName) continue;
					const key = runtimeName.toLowerCase();
					let entry = out.get(key);
					if (!entry) {
						entry = { runtimeName, tools: [], providers: [] };
						out.set(key, entry);
					}
					entry.tools.push(tool);
					entry.providers.push(this.piToolProviderInfo(tool, scopeKey));
				}
			}
		}
		return out;
	}

	private piToolInfoFromGroup(entry: { runtimeName: string; tools: PiExtensionExternalTool[]; providers: PiExtensionToolProviderInfo[] }): ToolInfo {
		const first = entry.tools[0];
		return {
			name: entry.runtimeName,
			description: first?.description || `Tool provided by pi extension ${first?.listName ?? "unknown"}`,
			group: first?.group || "Pi Extensions",
			docs: first?.docs,
			detail_docs: undefined,
			hasRenderer: false,
			rendererFile: undefined,
			grantPolicy: undefined,
			params: undefined,
			providerType: "pi-extension",
			origin: "marketplace-pi-extension",
			originPackName: first?.packName,
			originPackId: first?.packId,
			sourcePath: first?.sourcePath,
			providers: entry.providers,
		};
	}

	/**
	 * Returns only tools defined locally in the config dir (not inherited from builtins).
	 * Used by the config cascade to determine which tools are server/project overrides.
	 */
	getLocalTools(): ToolInfo[] {
		// Scan only the config-level tools dir — no builtins. Apply the same
		// invalid direct group-extension filtering as runtime resolution so the
		// config cascade and /api/tools do not advertise overrides that launch will skip.
		const scanned = scanToolsDir(this.toolsDir, this.toolsDir);
		const invalidGroupExtensions = new Set<string>();
		for (const diagnostic of collectInvalidConfigGroupExtensionDiagnostics(this.toolsDir, scanned)) {
			logToolExtensionDiagnostic(diagnostic);
			invalidGroupExtensions.add(diagnostic.groupDir);
		}
		const tools = filterInvalidConfigTools(scanned, invalidGroupExtensions);
		return tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			group: tool.group,
			docs: tool.docs,
			detail_docs: tool.detail_docs,
			hasRenderer: !!tool.renderer,
			rendererFile: tool.renderer,
			...contributionFields(tool),
			grantPolicy: tool.grantPolicy,
			params: tool.params,
		}));
	}

	/** Invalid active config-level tool override diagnostics for this manager's config dir. */
	getToolDiagnostics(): ToolExtensionDiagnostic[] {
		const diagnostics = [
			...collectInvalidConfigGroupExtensionDiagnostics(this.toolsDir),
			...collectInvalidConfigToolDiagnostics(scanToolsDir(this.toolsDir, this.toolsDir)),
		];
		const seen = new Set<string>();
		const unique = diagnostics.filter((diagnostic) => {
			const key = `${diagnostic.toolName}\0${diagnostic.extensionPath}\0${diagnostic.message}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
		for (const diagnostic of unique) logToolExtensionDiagnostic(diagnostic);
		return unique;
	}

	/** Returns all tools, re-scanning the YAML directory on every call. */
	getAvailableTools(scopedContext?: ScopedToolContext): ToolInfo[] {
		const tools = loadToolDefinitions(this.toolsDir, this.builtinToolsDir, this.marketRoots());
		const result: ToolInfo[] = tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			group: tool.group,
			docs: tool.docs,
			detail_docs: tool.detail_docs,
			hasRenderer: !!tool.renderer,
			rendererFile: tool.renderer,
			...contributionFields(tool),
			grantPolicy: tool.grantPolicy,
			params: tool.params,
		}));
		for (const ext of this.externalTools.values()) {
			result.push({
				name: ext.name,
				description: ext.description,
				group: ext.group,
				docs: ext.docs,
				detail_docs: undefined,
				hasRenderer: false,
				rendererFile: undefined,
				grantPolicy: undefined,
				params: undefined,
			});
		}
		const byLower = new Map<string, ToolInfo>();
		for (const tool of result) byLower.set(tool.name.toLowerCase(), tool);
		for (const entry of this.scopedPiToolGroups(scopedContext).values()) {
			const existing = byLower.get(entry.runtimeName.toLowerCase());
			if (existing) {
				existing.providers = [...(existing.providers ?? []), ...entry.providers];
				continue;
			}
			const info = this.piToolInfoFromGroup(entry);
			result.push(info);
			byLower.set(info.name.toLowerCase(), info);
		}
		return result;
	}

	/** Returns a single tool's full detail, or undefined if not found. Case-insensitive lookup. */
	getToolByName(name: string, scopedContext?: ScopedToolContext): ToolInfo | undefined {
		const nameLower = name.toLowerCase();
		// Check external tools (case-insensitive)
		for (const ext of this.externalTools.values()) {
			if (ext.name.toLowerCase() === nameLower) {
				const pi = this.scopedPiToolGroups(scopedContext).get(nameLower);
				return { name: ext.name, description: ext.description, group: ext.group, docs: ext.docs, detail_docs: undefined, hasRenderer: false, rendererFile: undefined, grantPolicy: undefined, providers: pi?.providers };
			}
		}
		const tools = loadToolDefinitions(this.toolsDir, this.builtinToolsDir, this.marketRoots());
		const base = tools.find((t) => t.name.toLowerCase() === nameLower);
		if (base) {
			const pi = this.scopedPiToolGroups(scopedContext).get(nameLower);
			return {
				name: base.name,
				description: base.description,
				group: base.group,
				docs: base.docs,
				detail_docs: base.detail_docs,
				hasRenderer: !!base.renderer,
				rendererFile: base.renderer,
				...contributionFields(base),
				grantPolicy: base.grantPolicy,
				params: base.params,
				providers: pi?.providers,
			};
		}
		const pi = this.scopedPiToolGroups(scopedContext).get(nameLower);
		return pi ? this.piToolInfoFromGroup(pi) : undefined;
	}

	/**
	 * Generate per-group detail docs markdown files in the state directory.
	 * These are the full reference docs that the system prompt footer links to.
	 * Call once at startup (or when tool definitions change).
	 */
	generateDetailDocs(stateDir: string): void {
		const dir = path.join(stateDir, 'tool-docs');
		fs.mkdirSync(dir, { recursive: true });

		const tools = loadToolDefinitions(this.toolsDir, this.builtinToolsDir, this.marketRoots());

		// Group tools by groupDir
		const grouped = new Map<string, Array<{ name: string; docs?: string; detail_docs?: string; description: string }>>();
		for (const tool of tools) {
			if (!tool.groupDir) continue;
			if (!grouped.has(tool.groupDir)) grouped.set(tool.groupDir, []);
			grouped.get(tool.groupDir)!.push({ name: tool.name, docs: tool.docs, detail_docs: tool.detail_docs, description: tool.description });
		}

		for (const [groupDir, tools] of grouped) {
			const parts: string[] = [`# ${groupDir} — Tool Reference\n`];
			for (const tool of tools) {
				parts.push(`## ${tool.name}\n`);
				const docs = tool.docs?.trim();
				const detail = tool.detail_docs?.trim();
				if (docs) parts.push(docs + '\n');
				if (detail) parts.push(detail + '\n');
				if (!docs && !detail) parts.push(tool.description + '\n');
			}
			fs.writeFileSync(path.join(dir, `${groupDir}.md`), parts.join('\n'));
		}
	}

	/**
	 * Returns formatted tool documentation for inclusion in system prompts.
	 *
	 * Generates a single `# Tools` section with per-group summaries, docs, and footer links.
	 *
	 * If `toolNames` is provided, only includes those tools; otherwise includes all.
	 */
	getToolDocsForPrompt(toolNames?: string[], stateDir?: string, scopedContext?: ScopedToolContext): string {
		const tools = loadToolDefinitions(this.toolsDir, this.builtinToolsDir, this.marketRoots());

		type Entry = { name: string; summary: string; params?: string[] };
		const grouped = new Map<string, { groupDir: string; entries: Entry[] }>();
		const included = new Set<string>();

		for (const tool of tools) {
			if (toolNames && !toolNames.includes(tool.name)) continue;
			const group = tool.group;
			const summary = tool.summary ?? tool.description;
			if (!grouped.has(group)) grouped.set(group, { groupDir: tool.groupDir, entries: [] });
			grouped.get(group)!.entries.push({ name: tool.name, summary, params: tool.params });
			included.add(tool.name.toLowerCase());
		}

		// Include external tools (e.g. MCP) — no params, no inlined docs.
		for (const ext of this.externalTools.values()) {
			if (toolNames && !toolNames.includes(ext.name)) continue;
			const group = ext.group;
			const summary = ext.summary ?? ext.description;
			if (!grouped.has(group)) grouped.set(group, { groupDir: '', entries: [] });
			grouped.get(group)!.entries.push({ name: ext.name, summary });
			included.add(ext.name.toLowerCase());
		}

		for (const entry of this.scopedPiToolGroups(scopedContext).values()) {
			if (included.has(entry.runtimeName.toLowerCase())) continue;
			if (toolNames && !toolNames.includes(entry.runtimeName)) continue;
			const info = this.piToolInfoFromGroup(entry);
			if (!grouped.has(info.group)) grouped.set(info.group, { groupDir: '', entries: [] });
			grouped.get(info.group)!.entries.push({ name: info.name, summary: info.description });
			included.add(info.name.toLowerCase());
		}

		if (grouped.size === 0) return "";

		const sections: string[] = ["# Tools", ""];

		for (const [group, { groupDir, entries }] of grouped) {
			const isMcp = group.startsWith('MCP: ');

			// Compute pointer path on the same line as the group header.
			let pointer = "";
			if (isMcp) {
				const serverName = group.slice(5); // strip "MCP: "
				const docPath = stateDir
					? path.join(stateDir, 'mcp-tool-docs', `${serverName}.md`)
					: `.bobbit/state/mcp-tool-docs/${serverName}.md`;
				pointer = ` — see ${docPath}`;
			} else if (groupDir) {
				const docPath = stateDir
					? path.join(stateDir, 'tool-docs', `${groupDir}.md`)
					: `.bobbit/state/tool-docs/${groupDir}.md`;
				pointer = ` — see ${docPath}`;
			}

			sections.push(`## ${group}${pointer}`);

			for (const entry of entries) {
				const summary = entry.summary.replace(/\s+/g, " ").trim();
				let head: string;
				if (entry.params && entry.params.length > 0) {
					head = `${entry.name}(${entry.params.join(", ")})`;
				} else {
					head = entry.name;
				}
				sections.push(summary ? `- ${head} — ${summary}` : `- ${head}`);
			}

			sections.push("");
		}

		// Trim trailing blank.
		while (sections.length > 0 && sections[sections.length - 1] === "") sections.pop();

		return sections.join("\n");
	}

	/** Returns the provider info for a tool, or undefined if not found. */
	getToolProvider(name: string, scopedContext?: ScopedToolContext): ToolProvider | undefined {
		const ext = this.externalTools.get(name);
		if (ext) return ext.provider;
		const tools = loadToolDefinitions(this.toolsDir, this.builtinToolsDir, this.marketRoots());
		const base = tools.find((t) => t.name === name);
		if (base?.provider) return base.provider;
		const pi = this.scopedPiToolGroups(scopedContext).get(name.toLowerCase());
		const provider = pi?.providers[0];
		return provider ? { type: "pi-extension", providerKey: provider.providerKey } : undefined;
	}

	/**
	 * Resolve the WINNING tool's on-disk location + extension-host contribution
	 * metadata, sourced from `loadToolDefinitions()` so it honors the SAME pack
	 * precedence/shadowing every other resolution uses (design §4b). Unlike
	 * `getToolProviders()` (which gates on `provider:` for the MCP/extension
	 * activation path), this returns location for ANY scanned tool — a pack tool
	 * declaring `renderer:`/`actions:` needs NO `provider:` to be served/dispatched.
	 * Case-insensitive lookup, matching `getToolByName`.
	 */
	resolveToolLocation(name: string): {
		baseDir: string;
		groupDir: string;
		rendererFile?: string;
		actionsModule?: string;
		rendererKind?: "builtin" | "pack";
		actionNames?: string[];
	} | undefined {
		const nameLower = name.toLowerCase();
		const tools = loadToolDefinitions(this.toolsDir, this.builtinToolsDir, this.marketRoots());
		const base = tools.find((t) => t.name.toLowerCase() === nameLower);
		if (!base) return undefined;
		const c = base.contributions;
		return {
			baseDir: base.baseDir,
			groupDir: base.groupDir,
			// Renderer sourced from the PARSED/validated contribution so a dropped
			// unsafe path resolves to no pack renderer (rendererKind "builtin",
			// rendererFile undefined) instead of a path the GET endpoint would reject.
			rendererFile: c.renderer,
			actionsModule: c.actions?.module,
			rendererKind: computeRendererKind(base.baseDir, c.renderer),
			actionNames: c.actions?.names,
		};
	}

	/** Returns all tool providers with groupDir and baseDir in a single YAML scan. */
	getToolProviders(scopedContext?: ScopedToolContext): Map<string, ToolProvider & { groupDir: string; baseDir: string }> {
		const tools = loadToolDefinitions(this.toolsDir, this.builtinToolsDir, this.marketRoots());
		const map = new Map<string, ToolProvider & { groupDir: string; baseDir: string }>();
		for (const tool of tools) {
			if (tool.provider) map.set(tool.name, { ...tool.provider, groupDir: tool.groupDir, baseDir: tool.baseDir });
		}
		for (const [name, ext] of this.externalTools) {
			map.set(name, { ...ext.provider, groupDir: '', baseDir: '' });
		}
		for (const entry of this.scopedPiToolGroups(scopedContext).values()) {
			if (map.has(entry.runtimeName)) continue;
			const provider = entry.providers[0];
			map.set(entry.runtimeName, { type: "pi-extension", providerKey: provider.providerKey, groupDir: '', baseDir: '' });
		}
		return map;
	}

	/** Returns all tool names from YAML definitions. */
	getAllToolNames(scopedContext?: ScopedToolContext): string[] {
		return this.getAvailableTools(scopedContext).map((t) => t.name);
	}

	/**
	 * Updates tool metadata (description, group, docs) by writing directly to the YAML file.
	 * If the tool's group only exists in builtins, copies the entire group to toolsDir first.
	 */
	updateToolMetadata(name: string, updates: { description?: string; group?: string; docs?: string; detail_docs?: string; grantPolicy?: string }): boolean {
		// Market tools are read-only: omit market roots so a market-pack tool is
		// not found here and can never be written back into market-packs/.
		const tools = loadToolDefinitions(this.toolsDir, this.builtinToolsDir);
		const base = tools.find((t) => t.name === name);
		if (!base) return false;

		// If the tool is from builtins, copy the entire group to config dir first
		let filePath = base.filePath;
		if (base.baseDir === this.builtinToolsDir && base.groupDir && this.builtinToolsDir) {
			const srcGroup = path.join(this.builtinToolsDir, base.groupDir);
			const destGroup = path.join(this.toolsDir, base.groupDir);
			copyDirRecursive(srcGroup, destGroup);
			// Update filePath to point to the new copy
			const relPath = path.relative(path.join(base.baseDir, base.groupDir), base.filePath);
			filePath = path.join(destGroup, relPath);
		}

		try {
			const raw = fs.readFileSync(filePath, "utf-8");
			const doc = parseDocument(raw);

			if (updates.description !== undefined) doc.set("description", updates.description);
			if (updates.group !== undefined) doc.set("group", updates.group);
			if (updates.docs !== undefined) doc.set("docs", updates.docs);
			if (updates.detail_docs !== undefined) doc.set("detail_docs", updates.detail_docs);
			if (updates.grantPolicy !== undefined) doc.set("grantPolicy", updates.grantPolicy);

			fs.writeFileSync(filePath, doc.toString(), "utf-8");
			// Invalidate the mtime-keyed scan cache. Without this, a PUT followed
			// by an immediate GET can return stale data on Windows where mtime
			// resolution is coarse (1–2s) and the directory fingerprint matches
			// the pre-write state. PR #388 introduced the cache; PUT must drop it.
			_scanCache.delete(this.toolsDir);
			return true;
		} catch (err) {
			console.error(`[tool-manager] Failed to update ${name} at ${filePath}:`, err);
			return false;
		}
	}
}
