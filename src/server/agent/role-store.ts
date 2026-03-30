import fs from "node:fs";
import path from "node:path";
import { stringify, parse } from "yaml";
import { bobbitConfigDir } from "../bobbit-dir.js";

/** Grant policy controlling what happens when an agent uses an ungranted MCP tool. */
export type GrantPolicy = 'always-ask' | 'ask-once' | 'never-ask';

export interface Role {
	/** Unique identifier — lowercase alphanumeric + hyphens, immutable after creation */
	name: string;
	/** Human-readable display label */
	label: string;
	/** Markdown system prompt template (supports {{GOAL_BRANCH}} and {{AGENT_ID}} placeholders) */
	promptTemplate: string;
	/** Subset of allowed agent tools */
	allowedTools: string[];
	/** Pixel-art accessory ID for the Bobbit sprite overlay */
	accessory: string;
	/** Default personalities applied when no explicit personalities are specified */
	defaultPersonalities?: string[];
	/** Per-tool or per-group grant policy overrides (tool name or MCP server prefix → policy) */
	toolPolicies?: Record<string, GrantPolicy>;
	createdAt: number;
	updatedAt: number;
}

/** roles/ directory in .bobbit/config — version controlled */
const ROLES_DIR = path.join(bobbitConfigDir(), "roles");

/**
 * File-backed role store. Each role is a YAML file in roles/<name>.yaml
 * at the repo root. Version controlled — edits via the UI write back
 * to the same files so they can be committed.
 */
export class RoleStore {
	private roles: Map<string, Role> = new Map();

	constructor() {
		fs.mkdirSync(ROLES_DIR, { recursive: true });
		this.loadAll();
	}

	private roleFilePath(name: string): string {
		return path.join(ROLES_DIR, `${name}.yaml`);
	}

	private loadAll(): void {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(ROLES_DIR, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
			const filePath = path.join(ROLES_DIR, entry.name);
			try {
				const raw = fs.readFileSync(filePath, "utf-8");
				const data = parse(raw);
				if (data && typeof data === "object" && data.name) {
					this.roles.set(data.name, {
						name: data.name,
						label: data.label ?? data.name,
						promptTemplate: data.promptTemplate ?? "",
						allowedTools: Array.isArray(data.allowedTools) ? data.allowedTools : [],
						accessory: data.accessory ?? "none",
						defaultPersonalities: Array.isArray(data.defaultPersonalities) ? data.defaultPersonalities : undefined,
						toolPolicies: data.toolPolicies && typeof data.toolPolicies === "object" ? data.toolPolicies : undefined,
						createdAt: data.createdAt ?? 0,
						updatedAt: data.updatedAt ?? 0,
					});
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
				allowedTools: role.allowedTools,
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
