import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Plugin manifest — `plugin.yaml` at the root of a plugin bundle.
 *
 * The manifest is the single declarative entry point: it lists what the
 * plugin contributes (workflows, roles, skills, tools, MCP) and where its
 * runtime entry modules live (gateway-side, UI-side). Verify-step types the
 * plugin will register at runtime are declared here too so the trust prompt
 * can show them to the user before the plugin code ever executes.
 */
export interface PluginManifest {
	name: string;
	version: string;
	description?: string;
	bobbit?: { engines?: string };
	entryPoints?: PluginEntryPoints;
	contributes?: PluginContributions;
	/** Verify-step types the gateway entry will register. Listed up-front so the
	 *  trust prompt can show them before running plugin code. */
	verifyStepTypes?: string[];
	/** Coarse permissions the plugin needs (e.g. "external-webhook", "tool-call"). Shown in the trust prompt. */
	permissions?: string[];
}

export interface PluginEntryPoints {
	/** ESM module path relative to the plugin root, imported by the gateway. */
	gateway?: string;
	/** ESM module path served at GET /api/plugins/:name/ui/index.js and imported by the web UI. */
	ui?: string;
}

export interface PluginContributions {
	workflows?: string[];     // Paths to workflow YAML files
	roles?: string[];         // Paths to role YAML files
	skills?: string[];        // Paths to skill DIRECTORIES (containing SKILL.md)
	tools_dirs?: string[];    // Paths to tool group directories
	mcp?: string[];           // Paths to MCP server JSON config files
}

export interface ManifestValidationError {
	field: string;
	message: string;
}

const NAME_RE = /^[a-z][a-z0-9-]{1,63}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;

/** Read and validate a plugin's manifest. Throws on missing file or malformed YAML;
 *  returns validation errors on schema issues. */
export function readManifest(pluginRoot: string): { manifest: PluginManifest; errors: ManifestValidationError[] } {
	const manifestPath = path.join(pluginRoot, "plugin.yaml");
	const raw = fs.readFileSync(manifestPath, "utf-8");
	const parsed = parseYaml(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Plugin manifest at ${manifestPath} did not parse as an object.`);
	}
	return validateManifest(parsed as Record<string, unknown>, pluginRoot);
}

export function validateManifest(raw: Record<string, unknown>, pluginRoot: string): {
	manifest: PluginManifest;
	errors: ManifestValidationError[];
} {
	const errors: ManifestValidationError[] = [];
	const push = (field: string, message: string) => errors.push({ field, message });

	const name = typeof raw.name === "string" ? raw.name : "";
	if (!name) push("name", "is required");
	else if (!NAME_RE.test(name)) push("name", `must match ${NAME_RE} (got "${name}")`);

	const version = typeof raw.version === "string" ? raw.version : "";
	if (!version) push("version", "is required");
	else if (!VERSION_RE.test(version)) push("version", `must be semver (got "${version}")`);

	const entryPoints: PluginEntryPoints = {};
	const rawEntry = (raw.entryPoints && typeof raw.entryPoints === "object") ? raw.entryPoints as Record<string, unknown> : {};
	if (typeof rawEntry.gateway === "string") entryPoints.gateway = rawEntry.gateway;
	if (typeof rawEntry.ui === "string") entryPoints.ui = rawEntry.ui;

	// Path traversal guard — every entry point must resolve inside the plugin root.
	if (entryPoints.gateway && !insidePluginRoot(pluginRoot, entryPoints.gateway)) {
		push("entryPoints.gateway", `escapes the plugin root: ${entryPoints.gateway}`);
	}
	if (entryPoints.ui && !insidePluginRoot(pluginRoot, entryPoints.ui)) {
		push("entryPoints.ui", `escapes the plugin root: ${entryPoints.ui}`);
	}

	const contributes: PluginContributions = {};
	const rawContrib = (raw.contributes && typeof raw.contributes === "object") ? raw.contributes as Record<string, unknown> : {};
	for (const key of ["workflows", "roles", "skills", "tools_dirs", "mcp"] as const) {
		const v = rawContrib[key];
		if (v === undefined) continue;
		if (!Array.isArray(v) || !v.every(x => typeof x === "string")) {
			push(`contributes.${key}`, `must be an array of strings`);
			continue;
		}
		for (const p of v as string[]) {
			if (!insidePluginRoot(pluginRoot, p)) {
				push(`contributes.${key}`, `path escapes the plugin root: ${p}`);
			}
		}
		contributes[key] = v as string[];
	}

	const verifyStepTypes = Array.isArray(raw.verifyStepTypes) && raw.verifyStepTypes.every(x => typeof x === "string")
		? raw.verifyStepTypes as string[]
		: undefined;
	if (raw.verifyStepTypes !== undefined && verifyStepTypes === undefined) {
		push("verifyStepTypes", "must be an array of strings");
	}

	const permissions = Array.isArray(raw.permissions) && raw.permissions.every(x => typeof x === "string")
		? raw.permissions as string[]
		: undefined;
	if (raw.permissions !== undefined && permissions === undefined) {
		push("permissions", "must be an array of strings");
	}

	const manifest: PluginManifest = {
		name,
		version,
		description: typeof raw.description === "string" ? raw.description : undefined,
		bobbit: (raw.bobbit && typeof raw.bobbit === "object" && typeof (raw.bobbit as any).engines === "string")
			? { engines: (raw.bobbit as any).engines as string }
			: undefined,
		entryPoints: (entryPoints.gateway || entryPoints.ui) ? entryPoints : undefined,
		contributes: Object.keys(contributes).length > 0 ? contributes : undefined,
		verifyStepTypes,
		permissions,
	};
	return { manifest, errors };
}

/** True iff `relPath` (joined onto `pluginRoot`) resolves to a path inside `pluginRoot`. */
export function insidePluginRoot(pluginRoot: string, relPath: string): boolean {
	const root = path.resolve(pluginRoot);
	const resolved = path.resolve(root, relPath);
	const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
	return resolved === root || resolved.startsWith(rootWithSep);
}
