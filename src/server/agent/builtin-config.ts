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
import { buildDefaultWorkflows } from "../state-migration/seed-default-workflows.js";

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

	// ── Public getters ──────────────────────────────────────────

	getRoles(): Role[] {
		if (!this._roles) this._roles = this.loadRoles();
		return this._roles;
	}

	/**
	 * Canonical builtin workflows seeded as the lowest-priority layer for every
	 * project's workflow store. Project-defined workflows in `project.yaml`
	 * shadow same-id builtins; this layer guarantees that structural
	 * infrastructure (notably the `parent` workflow used by the nested-goals
	 * feature) is always available even when a project's `project.yaml`
	 * declares its own `workflows:` map without listing it.
	 *
	 * Component name defaults to `"app"` because builtin workflows are seeded
	 * **before** a project's components are known. The component name only
	 * appears in `type: command` verify steps (build/check/unit/e2e/lint),
	 * which are defaults that any project either:
	 *   - re-declares in its own `workflows:` (shadows the builtin entirely), or
	 *   - relies on per-component scaffolds from `buildPerComponentWorkflow`.
	 *
	 * The structural layer (gates, dependencies, manual flags, prompts, the
	 * `parent` workflow's whole shape) is component-independent.
	 *
	 * Pre-PR #402 these workflows were also user-mutable at the system scope.
	 * That scope was removed; the builtins remain as a read-only safety net.
	 */
	getWorkflows(): Workflow[] {
		const seeded = buildDefaultWorkflows("app");
		const out: Workflow[] = [];
		for (const [id, wf] of Object.entries(seeded)) {
			out.push({
				id,
				name: wf.name,
				description: wf.description ?? "",
				gates: wf.gates as Workflow["gates"],
				createdAt: 0,
				updatedAt: 0,
			});
		}
		return out;
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
		const dir = path.join(this.builtinsDir, "roles");
		const roles: Role[] = [];
		for (const entry of this.readYamlDir(dir)) {
			try {
				const data = parse(entry.content);
				if (!data?.name) continue;

				let toolPolicies: Record<string, GrantPolicy> | undefined;
				if (data.toolPolicies && typeof data.toolPolicies === "object") {
					toolPolicies = {};
					for (const [k, v] of Object.entries(data.toolPolicies)) {
						if (typeof v === "string") toolPolicies[k] = normalizeGrantPolicy(v);
					}
					if (Object.keys(toolPolicies).length === 0) toolPolicies = undefined;
				}

				roles.push({
					name: data.name,
					label: data.label ?? data.name,
					promptTemplate: data.promptTemplate ?? "",
					accessory: data.accessory ?? "none",
					toolPolicies,
					model: validateModelString(data.model),
					thinkingLevel: validateThinkingLevel(data.thinkingLevel),
					createdAt: data.createdAt ?? 0,
					updatedAt: data.updatedAt ?? 0,
				});
			} catch (err) {
				console.error(`[builtin-config] Failed to parse role ${entry.file}:`, err);
			}
		}
		return roles;
	}

	private loadTools(): ToolInfo[] {
		const toolsDir = path.join(this.builtinsDir, "tools");
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
						const raw = fs.readFileSync(path.join(groupPath, file.name), "utf-8");
						const data = parse(raw);
						if (!data?.name || seen.has(data.name)) continue;
						seen.add(data.name);
						tools.push({
							name: data.name,
							description: data.description || "",
							group: data.group || entry.name,
							docs: data.docs,
							detail_docs: data.detail_docs,
							hasRenderer: !!data.renderer,
							rendererFile: data.renderer,
							grantPolicy: data.grantPolicy,
						});
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
				const raw = fs.readFileSync(path.join(toolsDir, entry.name), "utf-8");
				const data = parse(raw);
				if (!data?.name || seen.has(data.name)) continue;
				seen.add(data.name);
				tools.push({
					name: data.name,
					description: data.description || "",
					group: data.group || "Other",
					docs: data.docs,
					detail_docs: data.detail_docs,
					hasRenderer: !!data.renderer,
					rendererFile: data.renderer,
					grantPolicy: data.grantPolicy,
				});
			} catch (err) {
				console.error(`[builtin-config] Failed to parse tool ${entry.name}:`, err);
			}
		}

		return tools;
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

	// ── Helpers ──────────────────────────────────────────────────

	/** Read all .yaml files from a flat directory. */
	private readYamlDir(dir: string): Array<{ file: string; content: string }> {
		const results: Array<{ file: string; content: string }> = [];
		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
				try {
					results.push({
						file: entry.name,
						content: fs.readFileSync(path.join(dir, entry.name), "utf-8"),
					});
				} catch { /* skip unreadable files */ }
			}
		} catch { /* directory doesn't exist */ }
		return results;
	}
}
