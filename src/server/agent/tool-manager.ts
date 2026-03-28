import fs from "node:fs";
import path from "node:path";
import { parse, parseDocument } from "yaml";

export interface ToolProvider {
	type: 'builtin' | 'bobbit-extension';
	tool?: string;       // for builtin
	extension?: string;  // for bobbit-extension
}

/** Base tool definition loaded from YAML */
interface BaseToolInfo {
	name: string;
	description: string;
	summary?: string;
	group: string;
	renderer?: string;
	docs?: string;
	provider?: ToolProvider;
	/** Subdirectory name within tools/ (e.g. "shell", "filesystem"). Empty string for flat files. */
	groupDir: string;
	/** Absolute path to the YAML file on disk. */
	filePath: string;
}

export interface ToolInfo {
	name: string;
	description: string;
	group: string;
	docs?: string;
	hasRenderer: boolean;
	rendererFile?: string;
}

import { bobbitConfigDir } from "../bobbit-dir.js";


/** Tool definitions directory — .bobbit/config/tools/ (YAML definitions AND extension code, scaffolded from defaults) */
const TOOLS_DIR = path.join(bobbitConfigDir(), "tools");


export { TOOLS_DIR };

/**
 * Scan the tools/ YAML directory and return all tool definitions.
 * Supports both grouped layout (tools/<group>/*.yaml) and flat layout (tools/*.yaml).
 * Called on every request so new/edited YAML files are picked up without restart.
 */
function loadToolDefinitions(): BaseToolInfo[] {
	const tools: BaseToolInfo[] = [];
	const seen = new Set<string>();

	try {
		const entries = fs.readdirSync(TOOLS_DIR, { withFileTypes: true });

		// First pass: scan group subdirectories (tools/<group>/*.yaml)
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const groupDir = entry.name;
			const groupPath = path.join(TOOLS_DIR, groupDir);
			try {
				const files = fs.readdirSync(groupPath, { withFileTypes: true });
				for (const file of files) {
					if (!file.isFile() || !file.name.endsWith(".yaml")) continue;
					const filePath = path.join(groupPath, file.name);
					try {
						const raw = fs.readFileSync(filePath, "utf-8");
						const data = parse(raw);
						if (data && typeof data === "object" && data.name) {
							if (seen.has(data.name)) continue;
							seen.add(data.name);
							tools.push({
								name: data.name,
								description: data.description || "",
								summary: data.summary,
								group: data.group || groupDir,
								renderer: data.renderer,
								docs: data.docs,
								provider: data.provider,
								groupDir,
								filePath,
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
			const filePath = path.join(TOOLS_DIR, entry.name);
			try {
				const raw = fs.readFileSync(filePath, "utf-8");
				const data = parse(raw);
				if (data && typeof data === "object" && data.name) {
					if (seen.has(data.name)) continue; // Group dir version takes precedence
					seen.add(data.name);
					tools.push({
						name: data.name,
						description: data.description || "",
						summary: data.summary,
						group: data.group || "Other",
						renderer: data.renderer,
						docs: data.docs,
						provider: data.provider,
						groupDir: "",
						filePath,
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
 * Manages tool definitions and metadata.
 * Tool definitions are loaded from tools/<group>/*.yaml on every read.
 * Metadata updates write directly to the YAML files.
 */
export class ToolManager {
	constructor() {}

	/** Returns all tools, re-scanning the YAML directory on every call. */
	getAvailableTools(): ToolInfo[] {
		const tools = loadToolDefinitions();
		return tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			group: tool.group,
			docs: tool.docs,
			hasRenderer: !!tool.renderer,
			rendererFile: tool.renderer,
		}));
	}

	/** Returns a single tool's full detail, or undefined if not found. */
	getToolByName(name: string): ToolInfo | undefined {
		const tools = loadToolDefinitions();
		const base = tools.find((t) => t.name === name);
		if (!base) return undefined;
		return {
			name: base.name,
			description: base.description,
			group: base.group,
			docs: base.docs,
			hasRenderer: !!base.renderer,
			rendererFile: base.renderer,
		};
	}

	/**
	 * Returns formatted tool documentation for inclusion in system prompts.
	 *
	 * Generates two sections:
	 * 1. **Tool Overview** — grouped by `group`, one-line `summary` per tool
	 * 2. **Tool Documentation** — grouped by `group`, full `docs` per tool
	 *
	 * If `toolNames` is provided, only includes those tools; otherwise includes all.
	 */
	getToolDocsForPrompt(toolNames?: string[]): string {
		const tools = loadToolDefinitions();

		// Build grouped data: group → [{ name, summary, docs }]
		const grouped = new Map<string, Array<{ name: string; summary: string; docs?: string }>>();

		for (const tool of tools) {
			if (toolNames && !toolNames.includes(tool.name)) continue;
			const group = tool.group;
			const summary = tool.summary ?? tool.description;
			const docs = tool.docs?.trim();

			if (!grouped.has(group)) grouped.set(group, []);
			grouped.get(group)!.push({
				name: tool.name,
				summary,
				docs,
			});
		}

		if (grouped.size === 0) return "";

		// Part 1: Tool Overview
		const sections: string[] = ["# Tools"];
		for (const [group, entries] of grouped) {
			sections.push(`\n## ${group}\n`);
			for (const entry of entries) {
				sections.push(`- **${entry.name}**: ${entry.summary}`);
			}
		}

		// Part 2: Tool Documentation (only tools that have docs)
		const docSections: string[] = [];
		for (const [group, entries] of grouped) {
			const withDocs = entries.filter((e) => e.docs);
			if (withDocs.length === 0) continue;
			docSections.push(`\n## ${group}\n`);
			for (const entry of withDocs) {
				docSections.push(`### ${entry.name}\n\n${entry.docs}\n`);
			}
		}

		if (docSections.length > 0) {
			sections.push("\n# Tool Documentation");
			sections.push(...docSections);
		}

		return sections.join("\n");
	}

	/** Returns the provider info for a tool, or undefined if not found. */
	getToolProvider(name: string): ToolProvider | undefined {
		const tools = loadToolDefinitions();
		const base = tools.find((t) => t.name === name);
		return base?.provider;
	}

	/** Returns all tool providers with groupDir in a single YAML scan. */
	getToolProviders(): Map<string, ToolProvider & { groupDir: string }> {
		const tools = loadToolDefinitions();
		const map = new Map<string, ToolProvider & { groupDir: string }>();
		for (const tool of tools) {
			if (tool.provider) map.set(tool.name, { ...tool.provider, groupDir: tool.groupDir });
		}
		return map;
	}

	/** Returns all tool names from YAML definitions. */
	getAllToolNames(): string[] {
		return loadToolDefinitions().map((t) => t.name);
	}

	/** Updates tool metadata (description, group, docs) by writing directly to the YAML file. */
	updateToolMetadata(name: string, updates: { description?: string; group?: string; docs?: string }): boolean {
		const tools = loadToolDefinitions();
		const base = tools.find((t) => t.name === name);
		if (!base) return false;

		try {
			const raw = fs.readFileSync(base.filePath, "utf-8");
			const doc = parseDocument(raw);

			if (updates.description !== undefined) doc.set("description", updates.description);
			if (updates.group !== undefined) doc.set("group", updates.group);
			if (updates.docs !== undefined) doc.set("docs", updates.docs);

			fs.writeFileSync(base.filePath, doc.toString(), "utf-8");
			return true;
		} catch (err) {
			console.error(`[tool-manager] Failed to update ${name} at ${base.filePath}:`, err);
			return false;
		}
	}
}
