/**
 * Read-only provider for built-in (factory default) config shipped with Bobbit.
 *
 * At build time, `scripts/copy-defaults.mjs` copies `defaults/` →
 * `dist/server/defaults/`. This class reads those defaults at runtime so
 * they serve as the lowest-priority layer in the config cascade.
 *
 * All results are cached after first load. Call `reload()` to re-read.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import type { Role, GrantPolicy } from "./role-store.js";
import { normalizeGrantPolicy, validateModelString, validateThinkingLevel } from "./role-store.js";
import type { Workflow } from "./workflow-store.js";
import type { ToolInfo } from "./tool-manager.js";
import { parseContributions, computeRendererKind } from "./tool-contributions.js";

// ── Shared parse helpers (single source of truth) ───────────────
//
// Extracted so BOTH BuiltinConfigProvider and the pack-resolver loaders
// (RoleLoader / ToolLoader) parse byte-identically. Do NOT fork these.

/** Parse a single role YAML document into a Role, or null if it has no name. */
export function parseRoleYaml(content: string): Role | null {
	const data = parse(content);
	if (!data?.name) return null;

	let toolPolicies: Record<string, GrantPolicy> | undefined;
	if (data.toolPolicies && typeof data.toolPolicies === "object") {
		toolPolicies = {};
		for (const [k, v] of Object.entries(data.toolPolicies)) {
			if (typeof v === "string") toolPolicies[k] = normalizeGrantPolicy(v);
		}
		if (Object.keys(toolPolicies).length === 0) toolPolicies = undefined;
	}

	return {
		name: data.name,
		label: data.label ?? data.name,
		promptTemplate: data.promptTemplate ?? "",
		accessory: data.accessory ?? "none",
		toolPolicies,
		model: validateModelString(data.model),
		thinkingLevel: validateThinkingLevel(data.thinkingLevel),
		createdAt: data.createdAt ?? 0,
		updatedAt: data.updatedAt ?? 0,
	};
}

/** Read all role YAML files from `<dir>` (flat) into Role[]. */
export function parseRolesDir(rolesDir: string): Role[] {
	const roles: Role[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(rolesDir, { withFileTypes: true });
	} catch {
		return roles;
	}
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
		try {
			const role = parseRoleYaml(fs.readFileSync(path.join(rolesDir, entry.name), "utf-8"));
			if (role) roles.push(role);
		} catch (err) {
			console.error(`[builtin-config] Failed to parse role ${entry.name}:`, err);
		}
	}
	return roles;
}

function toolInfoFrom(data: any, fallbackGroup: string, baseDir: string, filePath: string): ToolInfo {
	const contributions = parseContributions(data, filePath);
	return {
		name: data.name,
		description: data.description || "",
		group: data.group || fallbackGroup,
		docs: data.docs,
		detail_docs: data.detail_docs,
		hasRenderer: !!data.renderer,
		rendererFile: data.renderer,
		rendererKind: computeRendererKind(baseDir, data.renderer),
		hasActions: !!contributions.actions,
		actionNames: contributions.actions?.names,
		routeNames: contributions.routes?.names,
		grantPolicy: data.grantPolicy,
		params: Array.isArray(data.params)
			? data.params.filter((p: unknown): p is string => typeof p === "string")
			: undefined,
	};
}

/**
 * Read tools from `<toolsDir>` using the grouped+flat two-pass logic:
 *   1. grouped subdirectories `tools/<group>/*.yaml` (group = dir name)
 *   2. flat files `tools/*.yaml` (group = data.group || "Other")
 * First-seen name wins within the dir.
 */
export function parseToolsDir(toolsDir: string): ToolInfo[] {
	const tools: ToolInfo[] = [];
	const seen = new Set<string>();

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(toolsDir, { withFileTypes: true });
	} catch {
		return tools;
	}

	// First pass: grouped subdirectories (tools/<group>/*.yaml)
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const groupPath = path.join(toolsDir, entry.name);
		try {
			const files = fs.readdirSync(groupPath, { withFileTypes: true });
			for (const file of files) {
				if (!file.isFile() || !file.name.endsWith(".yaml")) continue;
				try {
					const data = parse(fs.readFileSync(path.join(groupPath, file.name), "utf-8"));
					if (!data?.name || seen.has(data.name)) continue;
					seen.add(data.name);
					tools.push(toolInfoFrom(data, entry.name, toolsDir, path.join(groupPath, file.name)));
				} catch (err) {
					console.error(`[builtin-config] Failed to parse tool ${file.name}:`, err);
				}
			}
		} catch { /* skip unreadable group dir */ }
	}

	// Second pass: flat files (tools/*.yaml)
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
		try {
			const data = parse(fs.readFileSync(path.join(toolsDir, entry.name), "utf-8"));
			if (!data?.name || seen.has(data.name)) continue;
			seen.add(data.name);
			tools.push(toolInfoFrom(data, "Other", toolsDir, path.join(toolsDir, entry.name)));
		} catch (err) {
			console.error(`[builtin-config] Failed to parse tool ${entry.name}:`, err);
		}
	}

	return tools;
}

export class BuiltinConfigProvider {
	private readonly builtinsDir: string;

	// Lazy caches — null means "not loaded yet"
	private _roles: Role[] | null = null;
	private _tools: ToolInfo[] | null = null;
	private _toolGroupPolicies: Record<string, GrantPolicy> | null = null;

	constructor(builtinsDir?: string) {
		// Default: dist/server/agent/ → ../defaults → dist/server/defaults/
		this.builtinsDir = builtinsDir ?? path.join(__dirname, "..", "defaults");
	}

	/** Absolute path to the builtin `defaults/` tree (the builtin pack root). */
	getBuiltinsDir(): string {
		return this.builtinsDir;
	}

	// ── Public getters ──────────────────────────────────────────

	getRoles(): Role[] {
		if (!this._roles) this._roles = this.loadRoles();
		return this._roles;
	}

	/**
	 * Workflows are project-scoped only; this method exists for shape compat
	 * with the cascade and may be removed once `ServerStores` drops it.
	 */
	getWorkflows(): Workflow[] {
		return [];
	}

	getTools(): ToolInfo[] {
		if (!this._tools) this._tools = this.loadTools();
		return this._tools;
	}

	getToolGroupPolicies(): Record<string, GrantPolicy> {
		if (!this._toolGroupPolicies) this._toolGroupPolicies = this.loadToolGroupPolicies();
		return this._toolGroupPolicies;
	}

	/** Clear all caches so the next getter call re-reads from disk. */
	reload(): void {
		this._roles = null;
		this._tools = null;
		this._toolGroupPolicies = null;
	}

	// ── Private loaders (mirror the existing store parsing logic) ─

	private loadRoles(): Role[] {
		return parseRolesDir(path.join(this.builtinsDir, "roles"));
	}

	private loadTools(): ToolInfo[] {
		return parseToolsDir(path.join(this.builtinsDir, "tools"));
	}

	private loadToolGroupPolicies(): Record<string, GrantPolicy> {
		const filePath = path.join(this.builtinsDir, "tool-group-policies.yaml");
		try {
			const raw = fs.readFileSync(filePath, "utf-8");
			const data = parse(raw);
			if (!data || typeof data !== "object") return {};
			const result: Record<string, GrantPolicy> = {};
			const validPolicies = new Set(["allow", "ask", "never", "always-ask", "ask-once", "never-ask", "always-allow"]);
			for (const [key, value] of Object.entries(data)) {
				if (typeof value === "string" && validPolicies.has(value)) {
					result[key] = normalizeGrantPolicy(value);
				}
			}
			return result;
		} catch {
			return {};
		}
	}

}
