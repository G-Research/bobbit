import fs from "node:fs";
import path from "node:path";
import { stringify, parse } from "yaml";

/** Grant policy controlling what happens when an agent uses an ungranted tool. */
export type GrantPolicy = 'allow' | 'ask' | 'never';

/** Legacy grant policy values accepted during migration. */
type LegacyGrantPolicy = 'always-allow' | 'ask-once' | 'always-ask' | 'never-ask';

/** Normalize legacy grant policy values to the new three-value set. */
export function normalizeGrantPolicy(value: string): GrantPolicy {
	switch (value) {
		case 'always-allow': return 'allow';
		case 'ask-once': return 'ask';
		case 'always-ask': return 'ask';
		case 'never-ask': return 'never';
		case 'allow': return 'allow';
		case 'ask': return 'ask';
		case 'never': return 'never';
		default: return 'allow';
	}
}

/** Check if a value is a valid grant policy (old or new). */
function isGrantPolicyValue(value: unknown): value is GrantPolicy | LegacyGrantPolicy {
	return typeof value === 'string' && ['allow', 'ask', 'never', 'always-allow', 'ask-once', 'always-ask', 'never-ask'].includes(value);
}

/** Normalize all values in a toolPolicies record. */
function normalizeToolPolicies(policies: Record<string, unknown> | undefined): Record<string, GrantPolicy> | undefined {
	if (!policies || typeof policies !== 'object') return undefined;
	const result: Record<string, GrantPolicy> = {};
	for (const [key, value] of Object.entries(policies)) {
		if (isGrantPolicyValue(value)) {
			result[key] = normalizeGrantPolicy(value);
		}
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

export interface Role {
	/** Unique identifier — lowercase alphanumeric + hyphens, immutable after creation */
	name: string;
	/** Human-readable display label */
	label: string;
	/** Markdown system prompt template (supports {{GOAL_BRANCH}} and {{AGENT_ID}} placeholders) */
	promptTemplate: string;
	/** Pixel-art accessory ID for the Bobbit sprite overlay */
	accessory: string;
	/** Default personalities applied when no explicit personalities are specified */
	defaultPersonalities?: string[];
	/** Per-tool or per-group grant policy overrides (tool name or MCP server prefix → policy) */
	toolPolicies?: Record<string, GrantPolicy>;
	createdAt: number;
	updatedAt: number;
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
						normalizeToolPolicies(data.toolPolicies);

					const role: Role = {
						name: data.name,
						label: data.label ?? data.name,
						promptTemplate: data.promptTemplate ?? "",
						accessory: data.accessory ?? "none",
						defaultPersonalities: Array.isArray(data.defaultPersonalities) ? data.defaultPersonalities : undefined,
						toolPolicies,
						createdAt: data.createdAt ?? 0,
						updatedAt: data.updatedAt ?? 0,
					};

					this.roles.set(data.name, role);
				}
			} catch (err) {
				console.error(`[role-store] Failed to load ${filePath}:`, err);
			}
		}
	}

	private saveOne(role: Role): void {
		const filePath = this.roleFilePath(role.name);
		try {
			const obj: Record<string, unknown> = {
				name: role.name,
				label: role.label,
				accessory: role.accessory,
			};
			if (role.defaultPersonalities && role.defaultPersonalities.length > 0) {
				obj.defaultPersonalities = role.defaultPersonalities;
			}
			if (role.toolPolicies && Object.keys(role.toolPolicies).length > 0) {
				obj.toolPolicies = role.toolPolicies;
			}
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
		// Normalize any legacy policy values
		if (role.toolPolicies) {
			role.toolPolicies = normalizeToolPolicies(role.toolPolicies) ?? {};
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

		Object.assign(existing, cleaned, { updatedAt: Date.now() });
		this.saveOne(existing);
		return true;
	}
}
