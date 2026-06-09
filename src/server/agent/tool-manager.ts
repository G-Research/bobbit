import fs from "node:fs";
import path from "node:path";
import { parse, parseDocument } from "yaml";
import { fileURLToPath } from "node:url";
import type { GrantPolicy } from "./role-store.js";
import { profile } from "./profiling.js";
import { parseContributions, computeRendererKind, type ToolContributions, type PanelContribution } from "./tool-contributions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ToolProvider {
	type: 'builtin' | 'bobbit-extension' | 'mcp';
	tool?: string;       // for builtin
	extension?: string;  // for bobbit-extension
	server?: string;     // for mcp
	mcpTool?: string;    // for mcp
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
	/** Optional advisory `stores:` ids the tool declares (Slice B1, additive wire field). */
	storeIds?: string[];
	/** Optional `panels:` the tool contributes (Slice B4, additive wire field). The
	 *  `entry` path stays server-side; the client addresses panels by `id`. */
	panels?: { id: string; title?: string }[];
	/** Optional declared route names (from `routes.names`) the pack-level RouteRegistry
	 *  indexes by (Slice B3, additive wire field). */
	routeNames?: string[];
	/** Grant policy from YAML; undefined means "not configured" */
	grantPolicy?: GrantPolicy;
	/** Optional positional parameter names (trailing `?` marks optional). */
	params?: string[];
}

/** Map the extension-host contribution fields from a scanned BaseToolInfo onto the
 *  wire ToolInfo (design §2.5). Optional fields only — additive, never reorders or
 *  changes existing values, preserving the `buildPackList` byte-identical invariant. */
function contributionFields(base: BaseToolInfo): Pick<ToolInfo, "rendererKind" | "hasActions" | "actionNames" | "storeIds" | "panels" | "routeNames"> {
	const c = base.contributions;
	return {
		storeIds: c.stores?.map((s) => s.id),
		// Slice B4 — expose declared panels (id + title only; the ESM `entry` path
		// stays server-side, served by the bearer-only panel endpoint).
		panels: c.panels?.map((p) => (p.title !== undefined ? { id: p.id, title: p.title } : { id: p.id })),
		// Slice B3 — expose declared route names for the pack-level RouteRegistry.
		routeNames: c.routes?.names,
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
			if (!entry.isDirectory()) continue;
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
function loadToolDefinitions(toolsDir: string, builtinToolsDir?: string, marketRoots: string[] = []): BaseToolInfo[] {
	return profile("loadToolDefinitions", () => _loadToolDefinitions(toolsDir, builtinToolsDir, marketRoots));
}

function _loadToolDefinitions(toolsDir: string, builtinToolsDir?: string, marketRoots: string[] = []): BaseToolInfo[] {
	// Ordered layers, low→high priority. The builtin layer is lowest, the
	// scope's own user `toolsDir` overlay is highest, market-pack tool roots sit
	// in between (caller orders them server < global-user < project, design §3.2).
	const layers: Array<{ dir: string; isBuiltin: boolean }> = [];
	if (builtinToolsDir) layers.push({ dir: builtinToolsDir, isBuiltin: true });
	for (const r of marketRoots) layers.push({ dir: r, isBuiltin: false });
	layers.push({ dir: toolsDir, isBuiltin: false }); // user `toolsDir` (highest)
	const userIdx = layers.length - 1;

	const scanned = layers.map((l) => scanToolsDirCached(l.dir, l.dir));

	// Builtin ↔ user whole-group replace (legacy, ONLY this pair): a group the
	// USER layer defines fully shadows the SAME group in the BUILTIN layer.
	// Market layers neither own nor are shadowed by groups — they overlay by
	// tool NAME only (design §3.2 / finding #1).
	const userGroups = new Set<string>();
	for (const t of scanned[userIdx]) if (t.groupDir) userGroups.add(t.groupDir);

	// Resolve the winner per tool name (higher layer wins — matches the
	// PackResolver), but emit in first-seen low→high order so prompt/doc output
	// order is stable (builtins first).
	const winner = new Map<string, BaseToolInfo>();
	const order: string[] = [];
	scanned.forEach((tools, idx) => {
		const isBuiltin = layers[idx].isBuiltin;
		for (const t of tools) {
			// Builtin tool in a group the user owns ⇒ whole-group shadowed.
			if (isBuiltin && t.groupDir && userGroups.has(t.groupDir)) continue;
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
	private marketRootsProvider?: () => string[];

	constructor(configDir: string, builtinToolsDir?: string) {
		this.toolsDir = path.join(configDir, "tools");
		this.builtinToolsDir = builtinToolsDir ?? defaultBuiltinToolsDir();
	}

	/** Late-bind the installed market-pack `tools/` roots provider (design §3.2). */
	setMarketToolRootsProvider(provider: () => string[]): void {
		this.marketRootsProvider = provider;
	}

	/** Resolve the current ordered market-pack `tools/` roots (low→high). */
	private marketRoots(): string[] {
		try {
			return this.marketRootsProvider?.() ?? [];
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
		// Check config-level first
		const configGroup = path.join(this.toolsDir, groupDir);
		try {
			if (fs.statSync(configGroup).isDirectory()) return this.toolsDir;
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

	/**
	 * Returns only tools defined locally in the config dir (not inherited from builtins).
	 * Used by the config cascade to determine which tools are server/project overrides.
	 */
	getLocalTools(): ToolInfo[] {
		// Scan only the config-level tools dir — no builtins
		const tools = scanToolsDir(this.toolsDir, this.toolsDir);
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

	/** Returns all tools, re-scanning the YAML directory on every call. */
	getAvailableTools(): ToolInfo[] {
		const tools = loadToolDefinitions(this.toolsDir, this.builtinToolsDir, this.marketRoots());
		const result = tools.map((tool) => ({
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
		return result;
	}

	/** Returns a single tool's full detail, or undefined if not found. Case-insensitive lookup. */
	getToolByName(name: string): ToolInfo | undefined {
		const nameLower = name.toLowerCase();
		// Check external tools (case-insensitive)
		for (const ext of this.externalTools.values()) {
			if (ext.name.toLowerCase() === nameLower) {
				return { name: ext.name, description: ext.description, group: ext.group, docs: ext.docs, detail_docs: undefined, hasRenderer: false, rendererFile: undefined, grantPolicy: undefined };
			}
		}
		const tools = loadToolDefinitions(this.toolsDir, this.builtinToolsDir, this.marketRoots());
		const base = tools.find((t) => t.name.toLowerCase() === nameLower);
		if (!base) return undefined;
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
		};
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
	getToolDocsForPrompt(toolNames?: string[], stateDir?: string): string {
		const tools = loadToolDefinitions(this.toolsDir, this.builtinToolsDir, this.marketRoots());

		type Entry = { name: string; summary: string; params?: string[] };
		const grouped = new Map<string, { groupDir: string; entries: Entry[] }>();

		for (const tool of tools) {
			if (toolNames && !toolNames.includes(tool.name)) continue;
			const group = tool.group;
			const summary = tool.summary ?? tool.description;
			if (!grouped.has(group)) grouped.set(group, { groupDir: tool.groupDir, entries: [] });
			grouped.get(group)!.entries.push({ name: tool.name, summary, params: tool.params });
		}

		// Include external tools (e.g. MCP) — no params, no inlined docs.
		for (const ext of this.externalTools.values()) {
			if (toolNames && !toolNames.includes(ext.name)) continue;
			const group = ext.group;
			const summary = ext.summary ?? ext.description;
			if (!grouped.has(group)) grouped.set(group, { groupDir: '', entries: [] });
			grouped.get(group)!.entries.push({ name: ext.name, summary });
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
	getToolProvider(name: string): ToolProvider | undefined {
		const ext = this.externalTools.get(name);
		if (ext) return ext.provider;
		const tools = loadToolDefinitions(this.toolsDir, this.builtinToolsDir, this.marketRoots());
		const base = tools.find((t) => t.name === name);
		return base?.provider;
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
		/** Slice B4 — typed `panels:` (with the ESM `entry` path) so the panel GET
		 *  endpoint can resolve a panelId to its on-disk module. */
		panels?: PanelContribution[];
		/** Slice B3 — routes module + declared names for the RouteDispatcher/RouteRegistry. */
		routesModule?: string;
		routeNames?: string[];
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
			panels: c.panels,
			// Slice B3: the routes module + declared names the RouteDispatcher loads
			// and the RouteRegistry indexes by (default module "routes.js").
			routesModule: c.routes?.module,
			routeNames: c.routes?.names,
		};
	}

	/** Returns all tool providers with groupDir and baseDir in a single YAML scan. */
	getToolProviders(): Map<string, ToolProvider & { groupDir: string; baseDir: string }> {
		const tools = loadToolDefinitions(this.toolsDir, this.builtinToolsDir, this.marketRoots());
		const map = new Map<string, ToolProvider & { groupDir: string; baseDir: string }>();
		for (const tool of tools) {
			if (tool.provider) map.set(tool.name, { ...tool.provider, groupDir: tool.groupDir, baseDir: tool.baseDir });
		}
		for (const [name, ext] of this.externalTools) {
			map.set(name, { ...ext.provider, groupDir: '', baseDir: '' });
		}
		return map;
	}

	/** Returns all tool names from YAML definitions. */
	getAllToolNames(): string[] {
		const yamlNames = loadToolDefinitions(this.toolsDir, this.builtinToolsDir, this.marketRoots()).map((t) => t.name);
		return [...yamlNames, ...this.externalTools.keys()];
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
