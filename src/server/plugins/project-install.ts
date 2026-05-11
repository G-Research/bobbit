import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ProjectConfigStore } from "../agent/project-config-store.js";
import type { InlineWorkflowDef } from "../agent/project-config-store.js";
import type { DiscoveredPlugin } from "./plugin-loader.js";
import { insidePluginRoot } from "./plugin-manifest.js";

export interface InstallResult {
	ok: true;
	workflowsInstalled: string[]; // namespaced ids: "<plugin>::<id>"
}

export interface InstallFailure {
	ok: false;
	error: string;
	details?: unknown;
}

/**
 * Install a plugin into a project: copy its contributed workflow YAMLs into
 * `project.yaml::plugin_workflows` as frozen snapshots and add an entry to
 * `project.yaml::plugins`. Roles / skills / tools / MCP contributions are not
 * surfaced to the cascade yet — that needs `config_directories` integration,
 * which lives in a follow-up.
 *
 * Idempotent on re-install: replaces the prior install record and snapshots.
 * Existing goals that snapshotted the old workflow into `PersistedGoal.workflow`
 * are unaffected (their snapshot is frozen at goal creation).
 */
export function installPluginIntoProject(
	cfg: ProjectConfigStore,
	plugin: DiscoveredPlugin,
): InstallResult | InstallFailure {
	if (plugin.manifestErrors.length > 0) {
		return { ok: false, error: "manifest has errors", details: plugin.manifestErrors };
	}

	const workflowPaths = plugin.manifest.contributes?.workflows ?? [];
	const entries: { id: string; snapshot: InlineWorkflowDef }[] = [];
	for (const rel of workflowPaths) {
		if (!insidePluginRoot(plugin.path, rel)) {
			return { ok: false, error: `workflow path escapes plugin root: ${rel}` };
		}
		const abs = path.resolve(plugin.path, rel);
		if (!fs.existsSync(abs)) {
			return { ok: false, error: `workflow file not found: ${rel}` };
		}
		try {
			const raw = parseYaml(fs.readFileSync(abs, "utf-8")) as unknown;
			const list = workflowsFromYaml(raw);
			if (list.length === 0) {
				return { ok: false, error: `workflow file ${rel} contains no parseable workflow entries.` };
			}
			for (const item of list) entries.push(item);
		} catch (e) {
			return { ok: false, error: `failed to parse ${rel}: ${e instanceof Error ? e.message : String(e)}` };
		}
	}

	// Reject duplicate ids within this plugin's contributions.
	const seen = new Set<string>();
	for (const e of entries) {
		if (seen.has(e.id)) {
			return { ok: false, error: `plugin ships duplicate workflow id '${e.id}'.` };
		}
		seen.add(e.id);
	}

	cfg.setPluginWorkflows(plugin.name, entries);
	cfg.addInstalledPlugin({
		name: plugin.name,
		version: plugin.manifest.version,
		installedAt: Date.now(),
	});

	return { ok: true, workflowsInstalled: entries.map(e => `${plugin.name}::${e.id}`) };
}

/**
 * Uninstall a plugin from a project: drop its install record and any
 * `plugin_workflows` snapshots it contributed. Returns false if the plugin was
 * not installed.
 *
 * Goal snapshots are not touched — an in-flight goal whose workflow originally
 * came from this plugin keeps running off its frozen `PersistedGoal.workflow`.
 * The signal-time "no handler registered" failure (if the plugin also ships
 * verify-step types and is then untrusted) is the safety net.
 */
export function uninstallPluginFromProject(
	cfg: ProjectConfigStore,
	pluginName: string,
): { ok: boolean; removed: boolean } {
	const removed = cfg.removeInstalledPlugin(pluginName);
	return { ok: true, removed };
}

/** Parse a workflow YAML file. Supports either a top-level Workflow object
 *  (single workflow, id in file) or a map of `id → Workflow` (multiple in one file). */
function workflowsFromYaml(raw: unknown): { id: string; snapshot: InlineWorkflowDef }[] {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
	const obj = raw as Record<string, unknown>;
	const out: { id: string; snapshot: InlineWorkflowDef }[] = [];

	// Shape A: single workflow with an explicit `id:` field at the top level.
	if (typeof obj.id === "string" && Array.isArray(obj.gates)) {
		out.push({ id: obj.id, snapshot: obj as unknown as InlineWorkflowDef });
		return out;
	}

	// Shape B: map of `id → Workflow`. Each value must look like a workflow definition.
	for (const [k, v] of Object.entries(obj)) {
		if (v && typeof v === "object" && !Array.isArray(v)) {
			const wf = v as Record<string, unknown>;
			if (Array.isArray(wf.gates)) {
				out.push({ id: typeof wf.id === "string" ? wf.id : k, snapshot: wf as unknown as InlineWorkflowDef });
			}
		}
	}
	return out;
}
