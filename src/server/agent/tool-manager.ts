import fs from "node:fs";
import path from "node:path";
import { parse, parseDocument } from "yaml";
import { fileURLToPath } from "node:url";
import type { GrantPolicy } from "./role-store.js";

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
	/** Subdirectory name within tools/ (e.g. "shell", "filesystem"). Empty string for flat files. */
	groupDir: string;
	/** Absolute path to the YAML file on disk. */
	filePath: string;
	/** Absolute path to the tools/ parent directory where this tool was found. */
	baseDir: string;
}

export interface ToolInfo {
	name: string;
	description: string;
	group: string;
	docs?: string;
	detail_docs?: string;
	hasRenderer: boolean;
	rendererFile?: string;
	/** Grant policy from YAML; undefined means "not configured" */
	grantPolicy?: GrantPolicy;
}

import { bobbitConfigDir } from "../bobbit-dir.js";


/**
 * Tool definitions directory — .bobbit/config/tools/ (legacy export, deprecated).
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
								groupDir,
								filePath,
								baseDir,
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
						groupDir: "",
						filePath,
						baseDir,
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

/**
 * Load tool definitions with group-level cascade: builtins first, then overlay
 * from config-level toolsDir. A group in the higher layer replaces the entire group.
 */
function loadToolDefinitions(toolsDir: string, builtinToolsDir?: string): BaseToolInfo[] {
	const seen = new Set<string>();     // tool name dedup
	const seenGroups = new Set<string>(); // track which groups came from overlay

	// Scan overlay (config-level) first to determine which groups are overridden
	const overlayTools = scanToolsDir(toolsDir, toolsDir);
	for (const t of overlayTools) {
		if (t.groupDir) seenGroups.add(t.groupDir);
	}

	const result: BaseToolInfo[] = [];

	// Add builtin tools whose group is NOT overridden
	if (builtinToolsDir) {
		const builtinTools = scanToolsDir(builtinToolsDir, builtinToolsDir);
		for (const t of builtinTools) {
			// Skip if the group is overridden by the config level
			if (t.groupDir && seenGroups.has(t.groupDir)) continue;
			if (seen.has(t.name)) continue;
			seen.add(t.name);
			result.push(t);
		}
	}

	// Add overlay tools (these take precedence)
	for (const t of overlayTools) {
		if (seen.has(t.name)) continue;
		seen.add(t.name);
		result.push(t);
	}

	return result;
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

	constructor(configDir: string, builtinToolsDir?: string) {
		this.toolsDir = path.join(configDir, "tools");
		this.builtinToolsDir = builtinToolsDir ?? defaultBuiltinToolsDir();
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

	/** Returns all tools, re-scanning the YAML directory on every call. */
	getAvailableTools(): ToolInfo[] {
		const tools = loadToolDefinitions(this.toolsDir, this.builtinToolsDir);
		const result = tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			group: tool.group,
			docs: tool.docs,
			detail_docs: tool.detail_docs,
			hasRenderer: !!tool.renderer,
			rendererFile: tool.renderer,
			grantPolicy: tool.grantPolicy,
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
		const tools = loadToolDefinitions(this.toolsDir, this.builtinToolsDir);
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
			grantPolicy: base.grantPolicy,
		};
	}

	/**
	 * Returns formatted tool documentation for inclusion in system prompts.
	 *
	 * Generates a single `# Tools` section with per-group summaries, docs, and footer links.
	 *
	 * If `toolNames` is provided, only includes those tools; otherwise includes all.
	 */
	getToolDocsForPrompt(toolNames?: string[]): string {
		const tools = loadToolDefinitions(this.toolsDir, this.builtinToolsDir);

		// Build grouped data: group → { groupDir, entries }
		const grouped = new Map<string, { groupDir: string; entries: Array<{ name: string; summary: string; docs?: string }> }>();

		for (const tool of tools) {
			if (toolNames && !toolNames.includes(tool.name)) continue;
			const group = tool.group;
			const summary = tool.summary ?? tool.description;
			const docs = tool.docs?.trim();

			if (!grouped.has(group)) grouped.set(group, { groupDir: tool.groupDir, entries: [] });
			grouped.get(group)!.entries.push({ name: tool.name, summary, docs });
		}

		// Include external tools (e.g. MCP)
		for (const ext of this.externalTools.values()) {
			if (toolNames && !toolNames.includes(ext.name)) continue;
			const group = ext.group;
			const summary = ext.summary ?? ext.description;
			const docs = ext.docs?.trim();
			if (!grouped.has(group)) grouped.set(group, { groupDir: '', entries: [] });
			grouped.get(group)!.entries.push({ name: ext.name, summary, docs });
		}

		if (grouped.size === 0) return "";

		const sections: string[] = ["# Tools"];

		for (const [group, { groupDir, entries }] of grouped) {
			sections.push(`\n## ${group}\n`);

			// Summary lines
			for (const entry of entries) {
				sections.push(`- **${entry.name}**: ${entry.summary}`);
			}

			// Docs for tools that have them
			const withDocs = entries.filter((e) => e.docs);
			if (withDocs.length > 0) {
				sections.push('');
				for (const entry of withDocs) {
					sections.push(`### ${entry.name}\n\n${entry.docs}\n`);
				}
			}

			// Per-group footer link
			const isMcp = group.startsWith('MCP: ');
			if (isMcp) {
				const serverName = group.slice(5); // strip "MCP: "
				sections.push(`\n_For detailed ${serverName} tool docs (parameters, usage), read \`.bobbit/state/mcp-tool-docs/${serverName}.md\`_\n`);
			} else if (groupDir) {
				sections.push(`\n_For detailed ${group} tool docs (examples, edge cases, full parameters), read the tool's YAML in \`.bobbit/config/tools/${groupDir}/<tool>.yaml\` — see the \`detail_docs\` field._\n`);
			}
		}

		return sections.join("\n");
	}

	/** Returns the provider info for a tool, or undefined if not found. */
	getToolProvider(name: string): ToolProvider | undefined {
		const ext = this.externalTools.get(name);
		if (ext) return ext.provider;
		const tools = loadToolDefinitions(this.toolsDir, this.builtinToolsDir);
		const base = tools.find((t) => t.name === name);
		return base?.provider;
	}

	/** Returns all tool providers with groupDir and baseDir in a single YAML scan. */
	getToolProviders(): Map<string, ToolProvider & { groupDir: string; baseDir: string }> {
		const tools = loadToolDefinitions(this.toolsDir, this.builtinToolsDir);
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
		const yamlNames = loadToolDefinitions(this.toolsDir, this.builtinToolsDir).map((t) => t.name);
		return [...yamlNames, ...this.externalTools.keys()];
	}

	/**
	 * Updates tool metadata (description, group, docs) by writing directly to the YAML file.
	 * If the tool's group only exists in builtins, copies the entire group to toolsDir first.
	 */
	updateToolMetadata(name: string, updates: { description?: string; group?: string; docs?: string; detail_docs?: string; grantPolicy?: string }): boolean {
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
			return true;
		} catch (err) {
			console.error(`[tool-manager] Failed to update ${name} at ${filePath}:`, err);
			return false;
		}
	}
}
