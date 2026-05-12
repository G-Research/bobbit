/**
 * Three-layer config resolution engine: builtin → server → project.
 *
 * Merges config items from embedded builtins, the server-level (default
 * project's config stores), and an optional project-level layer. Each
 * returned item carries an `origin` tag and an optional `overrides` field
 * indicating which lower layer it shadows.
 */

import type { Role, GrantPolicy } from "./role-store.js";
import type { Workflow } from "./workflow-store.js";
import type { ToolInfo } from "./tool-manager.js";
import type { BuiltinConfigProvider } from "./builtin-config.js";
import type { ProjectContextManager } from "./project-context-manager.js";

export type ConfigOrigin = "builtin" | "server" | "project";

export interface ResolvedItem<T> {
	item: T;
	origin: ConfigOrigin;
	/** Which layer this item shadows, if any. */
	overrides?: ConfigOrigin;
}

export interface ResolvedPolicy {
	policy: GrantPolicy;
	origin: ConfigOrigin;
	overrides?: ConfigOrigin;
}

/**
 * Explicit server-level store accessors.
 *
 * These wire the cascade's server layer to the standalone server stores
 * (backed by <server-cwd>/.bobbit/config/), independent of any project.
 * Zero-project installs still resolve system-scope config this way.
 */
export interface ServerStores {
	getRoles(): Role[];
	getTools(): ToolInfo[];
	getToolGroupPolicies(): Record<string, GrantPolicy>;
}

/**
 * Minimal structural interface for the project registry, sufficient to walk
 * ancestor chains during field-level role resolution. Kept structural so
 * unit tests can inject a fake without spinning up the real registry.
 */
export interface ProjectAncestorRegistry {
	getAncestors(projectId: string): { id: string }[];
}

export class ConfigCascade {
	constructor(
		private builtins: BuiltinConfigProvider,
		private serverStores: ServerStores,
		private projectContextManager: ProjectContextManager,
		private projectRegistry?: ProjectAncestorRegistry,
	) {}

	// ── Field-level role resolution (model / thinkingLevel / promptTemplate) ──
	//
	// Unlike `resolveRoles()` which replaces whole role items at each layer,
	// the field-level resolvers walk: current project → ancestor chain →
	// server → builtin and return the first non-empty value. This lets a
	// project override `model` without discarding the server/builtin
	// `thinkingLevel` for the same role.

	private readRoleField(
		roles: Role[] | undefined,
		roleName: string,
		field: "model" | "thinkingLevel" | "promptTemplate",
	): string | undefined {
		if (!roles) return undefined;
		const r = roles.find(x => x.name === roleName);
		if (!r) return undefined;
		const v = (r as any)[field];
		if (typeof v !== "string") return undefined;
		const trimmed = v.trim();
		return trimmed.length > 0 ? v : undefined;
	}

	private localRoleField(
		projectId: string,
		roleName: string,
		field: "model" | "thinkingLevel" | "promptTemplate",
	): string | undefined {
		const ctx = this.projectContextManager.getOrCreate(projectId);
		if (!ctx) return undefined;
		const role = ctx.roleStore.getLocal(roleName);
		if (!role) return undefined;
		const v = (role as any)[field];
		if (typeof v !== "string") return undefined;
		const trimmed = v.trim();
		return trimmed.length > 0 ? v : undefined;
	}

	private resolveRoleField(
		roleName: string,
		field: "model" | "thinkingLevel" | "promptTemplate",
		projectId?: string,
	): string | undefined {
		if (projectId) {
			const v = this.localRoleField(projectId, roleName, field);
			if (v !== undefined) return v;
			if (this.projectRegistry) {
				for (const anc of this.projectRegistry.getAncestors(projectId)) {
					const av = this.localRoleField(anc.id, roleName, field);
					if (av !== undefined) return av;
				}
			}
		}
		const sv = this.readRoleField(this.serverStores.getRoles(), roleName, field);
		if (sv !== undefined) return sv;
		const bv = this.readRoleField(this.builtins.getRoles(), roleName, field);
		if (bv !== undefined) return bv;
		return undefined;
	}

	resolveRoleModel(roleName: string, projectId?: string): string | undefined {
		return this.resolveRoleField(roleName, "model", projectId);
	}

	resolveRoleThinkingLevel(roleName: string, projectId?: string): string | undefined {
		return this.resolveRoleField(roleName, "thinkingLevel", projectId);
	}

	resolveRolePromptTemplate(roleName: string, projectId?: string): string | undefined {
		return this.resolveRoleField(roleName, "promptTemplate", projectId);
	}

	// ── Roles ────────────────────────────────────────────────────

	resolveRoles(projectId?: string): ResolvedItem<Role>[] {
		return this.resolve<Role>(
			this.builtins.getRoles(),
			r => r.name,
			projectId,
			this.serverStores.getRoles(),
			ctx => ctx.roleStore.getAllLocal(),
		);
	}

	// ── Workflows ────────────────────────────────────────────────

	resolveWorkflows(projectId?: string): ResolvedItem<Workflow>[] {
		// Workflows are project-scoped only — they live inline in each
		// project's project.yaml::workflows block. There is no builtin or
		// server-scope layer. Without a projectId, the cascade returns [].
		// Hidden workflows (e.g. test-only fixtures injected via project
		// config) are filtered out for API/UI surfaces.
		if (!projectId) return [];
		const ctx = this.projectContextManager.getOrCreate(projectId);
		if (!ctx) return [];
		return ctx.workflowStore.getAllLocal()
			.filter(w => !w.hidden)
			.map(item => ({ item, origin: "project" as const }));
	}

	// ── Tools ────────────────────────────────────────────────────

	resolveTools(projectId?: string): ResolvedItem<ToolInfo>[] {
		return this.resolve<ToolInfo>(
			this.builtins.getTools(),
			t => t.name,
			projectId,
			this.serverStores.getTools(),
			ctx => ctx.toolManager.getLocalTools(),
		);
	}

	// ── Tool Group Policies ──────────────────────────────────────

	resolveToolGroupPolicies(projectId?: string): Record<string, ResolvedPolicy> {
		const merged = new Map<string, ResolvedPolicy>();

		// Layer 1: builtins
		for (const [group, policy] of Object.entries(this.builtins.getToolGroupPolicies())) {
			merged.set(group, { policy, origin: "builtin" });
		}

		// Layer 2: server-level (explicit server stores)
		for (const [group, policy] of Object.entries(this.serverStores.getToolGroupPolicies())) {
			const existing = merged.get(group);
			merged.set(group, {
				policy,
				origin: "server",
				overrides: existing?.origin,
			});
		}

		// Layer 3: project-level (when a projectId is specified).
		// Without projectId, only builtins + server stores are used (system scope).
		if (projectId) {
			const projectCtx = this.projectContextManager.getOrCreate(projectId);
			if (projectCtx) {
				for (const [group, policy] of Object.entries(projectCtx.toolGroupPolicyStore.getAll())) {
					const existing = merged.get(group);
					merged.set(group, {
						policy,
						origin: "project",
						overrides: existing?.origin,
					});
				}
			}
		}

		return Object.fromEntries(merged);
	}

	// ── Generic resolution helper ────────────────────────────────

	/**
	 * Merge three layers of config items by a unique key.
	 *
	 * 1. Builtins (origin "builtin")
	 * 2. Server-level = standalone server stores (origin "server")
	 * 3. Project-level = specified project's store, if a projectId was given (origin "project")
	 *
	 * Later layers shadow earlier ones. The `overrides` field records what was shadowed.
	 */
	private resolve<T>(
		builtinItems: T[],
		keyFn: (item: T) => string,
		projectId: string | undefined,
		serverItems: T[],
		getProjectItems: (ctx: import("./project-context.js").ProjectContext) => T[],
	): ResolvedItem<T>[] {
		const merged = new Map<string, ResolvedItem<T>>();

		// Layer 1: builtins
		for (const item of builtinItems) {
			merged.set(keyFn(item), { item, origin: "builtin" });
		}

		// Layer 2: server-level (explicit server stores)
		for (const item of serverItems) {
			const key = keyFn(item);
			const existing = merged.get(key);
			merged.set(key, {
				item,
				origin: "server",
				overrides: existing?.origin,
			});
		}

		// Layer 3: project-level (when a projectId is specified).
		// Without projectId, only builtins + server stores are used (system scope).
		if (projectId) {
			const projectCtx = this.projectContextManager.getOrCreate(projectId);
			if (projectCtx) {
				for (const item of getProjectItems(projectCtx)) {
					const key = keyFn(item);
					const existing = merged.get(key);
					merged.set(key, {
						item,
						origin: "project",
						overrides: existing?.origin,
					});
				}
			}
		}

		return [...merged.values()];
	}
}
