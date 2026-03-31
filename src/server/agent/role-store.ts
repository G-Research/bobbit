import fs from "node:fs";
import path from "node:path";
import { stringify, parse } from "yaml";

/** Grant policy controlling what happens when an agent uses an ungranted MCP tool. */
export type GrantPolicy = 'always-ask' | 'ask-once' | 'never-ask' | 'always-allow' | 'never';

export interface Role {
	/** Unique identifier — lowercase alphanumeric + hyphens, immutable after creation */
	name: string;
	/** Human-readable display label */
	label: string;
	/** Markdown system prompt template (supports {{GOAL_BRANCH}} and {{AGENT_ID}} placeholders) */
	promptTemplate: string;
	/** Derived from toolPolicies — tools whose resolved policy is "always-allow". Written to YAML for backward compat. */
	allowedTools: string[];
	/** Pixel-art accessory ID for the Bobbit sprite overlay */
	accessory: string;
	/** Default personalities applied when no explicit personalities are specified */
	defaultPersonalities?: string[];
	/** Per-tool or per-group grant policy overrides (tool name or MCP server prefix → policy) */
	toolPolicies?: Record<string, GrantPolicy>;
	/** Whether this role has been migrated from allowedTools to toolPolicies */
	_policyMigrated?: boolean;
	createdAt: number;
	updatedAt: number;
}

/** Compute allowedTools from toolPolicies: collect all keys where value is "always-allow" */
function deriveAllowedTools(toolPolicies?: Record<string, GrantPolicy>): string[] {
	if (!toolPolicies) return [];
	return Object.entries(toolPolicies)
		.filter(([, v]) => v === 'always-allow')
		.map(([k]) => k);
}

/**
 * File-backed role store. Each role is a YAML file in roles/<name>.yaml
 * at the repo root. Version controlled — edits via the UI write back
 * to the same files so they can be committed.
 */
export class RoleStore {
	private roles: Map<string, Role> = new Map();
	private readonly rolesDir: string;

	constructor(configDir: string) {
		this.rolesDir = path.join(configDir, "roles");
		fs.mkdirSync(this.rolesDir, { recursive: true });
		this.loadAll();
	}

	private roleFilePath(name: string): string {
		return path.join(this.rolesDir, `${name}.yaml`);
	}

	private loadAll(): void {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(this.rolesDir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
			const filePath = path.join(this.rolesDir, entry.name);
			try {
				const raw = fs.readFileSync(filePath, "utf-8");
				const data = parse(raw);
				if (data && typeof data === "object" && data.name) {
					const toolPolicies: Record<string, GrantPolicy> | undefined =
						data.toolPolicies && typeof data.toolPolicies === "object" ? data.toolPolicies : undefined;
					const allowedTools: string[] = Array.isArray(data.allowedTools) ? data.allowedTools : [];
					const policyMigrated: boolean = !!data._policyMigrated;

					const role: Role = {
						name: data.name,
						label: data.label ?? data.name,
						promptTemplate: data.promptTemplate ?? "",
						allowedTools,
						accessory: data.accessory ?? "none",
						defaultPersonalities: Array.isArray(data.defaultPersonalities) ? data.defaultPersonalities : undefined,
						toolPolicies,
						_policyMigrated: policyMigrated,
						createdAt: data.createdAt ?? 0,
						updatedAt: data.updatedAt ?? 0,
					};

					// Migration: allowedTools → toolPolicies
					if (!policyMigrated) {
						const policies: Record<string, GrantPolicy> = { ...toolPolicies };
						let migrated = false;
						for (const tool of allowedTools) {
							if (!(tool in policies)) {
								policies[tool] = 'always-allow';
								migrated = true;
							}
						}
						role.toolPolicies = Object.keys(policies).length > 0 ? policies : undefined;
						role._policyMigrated = true;
						// Recompute allowedTools from the (now authoritative) toolPolicies
						role.allowedTools = deriveAllowedTools(role.toolPolicies);
						this.roles.set(data.name, role);
						// Persist migration
						if (migrated || !policyMigrated) {
							this.saveOne(role);
						}
					} else {
						// Already migrated — allowedTools is derived from toolPolicies
						role.allowedTools = deriveAllowedTools(role.toolPolicies);
						this.roles.set(data.name, role);
					}
				}
			} catch (err) {
				console.error(`[role-store] Failed to load ${filePath}:`, err);
			}
		}
	}

	private saveOne(role: Role): void {
		const filePath = this.roleFilePath(role.name);
		try {
			// Derive allowedTools from toolPolicies for backward compatibility
			const derivedAllowed = deriveAllowedTools(role.toolPolicies);

			const obj: Record<string, unknown> = {
				name: role.name,
				label: role.label,
				accessory: role.accessory,
				allowedTools: derivedAllowed,
			};
			if (role.defaultPersonalities && role.defaultPersonalities.length > 0) {
				obj.defaultPersonalities = role.defaultPersonalities;
			}
			if (role.toolPolicies && Object.keys(role.toolPolicies).length > 0) {
				obj.toolPolicies = role.toolPolicies;
			}
			obj._policyMigrated = true;
			obj.createdAt = role.createdAt;
			obj.updatedAt = role.updatedAt;
			obj.promptTemplate = role.promptTemplate;
			const content = stringify(obj, { lineWidth: 0 });
			fs.writeFileSync(filePath, content, "utf-8");
		} catch (err) {
			console.error(`[role-store] Failed to save ${filePath}:`, err);
		}
	}

	put(role: Role): void {
		// Ensure toolPolicies is populated from allowedTools if missing
		// (prevents data loss when a role is created with allowedTools but no toolPolicies)
		if (role.allowedTools.length > 0 && (!role.toolPolicies || Object.keys(role.toolPolicies).length === 0)) {
			role.toolPolicies = role.toolPolicies || {};
			for (const tool of role.allowedTools) {
				if (!role.toolPolicies[tool]) {
					role.toolPolicies[tool] = 'always-allow';
				}
			}
		}
		this.roles.set(role.name, role);
		this.saveOne(role);
	}

	get(name: string): Role | undefined {
		return this.roles.get(name);
	}

	remove(name: string): void {
		this.roles.delete(name);
		const filePath = this.roleFilePath(name);
		try { fs.unlinkSync(filePath); } catch { /* ignore */ }
	}

	/** Re-read all YAML files from disk, picking up external changes */
	reload(): void {
		this.roles.clear();
		this.loadAll();
	}

	getAll(): Role[] {
		this.reload();
		return Array.from(this.roles.values());
	}

	update(name: string, updates: Partial<Omit<Role, "name" | "createdAt">>): boolean {
		const existing = this.roles.get(name);
		if (!existing) return false;
		const cleaned: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(updates)) {
			if (v !== undefined) cleaned[k] = v;
		}

		// If toolPolicies is being updated, recompute allowedTools
		if ('toolPolicies' in updates && updates.toolPolicies !== undefined) {
			cleaned.allowedTools = deriveAllowedTools(updates.toolPolicies);
		}

		// If allowedTools is updated directly (backward compat), merge into toolPolicies as "always-allow"
		if ('allowedTools' in updates && updates.allowedTools !== undefined && !('toolPolicies' in updates)) {
			const newPolicies: Record<string, GrantPolicy> = { ...(existing.toolPolicies ?? {}) };
			// Remove existing "always-allow" entries that are no longer in the new allowedTools
			const newAllowed = new Set(updates.allowedTools);
			for (const [tool, policy] of Object.entries(newPolicies)) {
				if (policy === 'always-allow' && !newAllowed.has(tool)) {
					delete newPolicies[tool];
				}
			}
			// Add new allowedTools entries
			for (const tool of updates.allowedTools) {
				if (!(tool in newPolicies)) {
					newPolicies[tool] = 'always-allow';
				}
			}
			cleaned.toolPolicies = Object.keys(newPolicies).length > 0 ? newPolicies : undefined;
		}

		Object.assign(existing, cleaned, { updatedAt: Date.now() });
		this.saveOne(existing);
		return true;
	}
}
