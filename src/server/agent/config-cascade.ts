/**
 * Three-layer config resolution engine: builtin → server → project.
 *
 * Merges config items from embedded builtins, the server-level (default
 * project's config stores), and an optional project-level layer. Each
 * returned item carries an `origin` tag and an optional `overrides` field
 * indicating which lower layer it shadows.
 */

import type { Role, GrantPolicy } from "./role-store.js";
import type { Personality } from "./personality-store.js";
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
 * These decouple the cascade's server layer from the default project's stores,
 * ensuring the cascade reads from the same stores that PUT/POST endpoints
 * write to (which matters when BOBBIT_DIR differs from rootPath/.bobbit/).
 */
export interface ServerStores {
	getRoles(): Role[];
	getPersonalities(): Personality[];
	getWorkflows(): Workflow[];
	getTools(): ToolInfo[];
	getToolGroupPolicies(): Record<string, GrantPolicy>;
}

export class ConfigCascade {
	constructor(
		private builtins: BuiltinConfigProvider,
		private serverStores: ServerStores,
		private projectContextManager: ProjectContextManager,
	) {}

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

	// ── Personalities ────────────────────────────────────────────

	resolvePersonalities(projectId?: string): ResolvedItem<Personality>[] {
		return this.resolve<Personality>(
			this.builtins.getPersonalities(),
			p => p.name,
			projectId,
			this.serverStores.getPersonalities(),
			ctx => ctx.personalityStore.getAllLocal(),
		);
	}

	// ── Workflows ────────────────────────────────────────────────

	resolveWorkflows(projectId?: string): ResolvedItem<Workflow>[] {
		// Filter out hidden workflows (e.g. test-fast) from the resolved set.
		// Builtins include all workflows (hidden ones needed for seeding),
		// but the API/UI should not expose them.
		return this.resolve<Workflow>(
			this.builtins.getWorkflows(),
			w => w.id,
			projectId,
			this.serverStores.getWorkflows(),
			ctx => ctx.workflowStore.getAllLocal(),
		).filter(r => !r.item.hidden);
	}

	// ── Tools ────────────────────────────────────────────────────

	resolveTools(projectId?: string): ResolvedItem<ToolInfo>[] {
		return this.resolve<ToolInfo>(
			this.builtins.getTools(),
			t => t.name,
			projectId,
			this.serverStores.getTools(),
			ctx => ctx.toolManager.getAvailableTools(),
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

		// Layer 3: project-level (if specified and different from default)
		const defaultId = this.projectContextManager.getDefaultProjectIdOrNull();
		if (projectId && projectId !== defaultId) {
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
	 * 2. Server-level = default project's store (origin "server")
	 * 3. Project-level = specified project's store, if different from default (origin "project")
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

		// Layer 3: project-level (only if projectId differs from default)
		const defaultId = this.projectContextManager.getDefaultProjectIdOrNull();
		if (projectId && projectId !== defaultId) {
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
