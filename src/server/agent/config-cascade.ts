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
import type { LoadedEntity, PackEntry, PackScope, ResolvedEntity } from "./pack-types.js";
import { PackResolver, RoleLoader, ToolLoader } from "./pack-resolver.js";

/**
 * `user` corresponds to the global-user scope. It is additive: global-user is
 * empty for roles/tools today, so no existing response value changes — `user`
 * only appears for newly-installed global-user packs (design §5.2).
 */
export type ConfigOrigin = "builtin" | "server" | "user" | "project";

/** Map a resolver pack scope to the wire `ConfigOrigin` (design §5.2). */
function scopeToOrigin(scope: PackScope): ConfigOrigin {
	switch (scope) {
		case "builtin": return "builtin";
		case "server": return "server";
		case "global-user": return "user";
		case "project": return "project";
	}
}

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

export class ConfigCascade {
	constructor(
		private builtins: BuiltinConfigProvider,
		private serverStores: ServerStores,
		private projectContextManager: ProjectContextManager,
	) {}

	// ── Roles ────────────────────────────────────────────────────

	resolveRoles(projectId?: string): ResolvedItem<Role>[] {
		return this.resolveViaPacks<Role>(
			"roles",
			[new RoleLoader()],
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
		return this.resolveViaPacks<ToolInfo>(
			"tools",
			[new ToolLoader()],
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

	// ── Generic resolution adapter (over the single PackResolver) ──

	/**
	 * Resolve the three cascade layers (builtin → server → project) through
	 * the unified {@link PackResolver}.
	 *
	 * The layers' data lives in injected in-memory stores (not on a scannable
	 * directory), so each layer is wrapped as a `preloaded` {@link PackEntry}
	 * — the same single resolver pipeline, fed pre-loaded entities. With zero
	 * market packs (the only state this cascade exercises) the ordered list is
	 * exactly builtin < server < project, so the merge — insertion order,
	 * shadowing, and `origin`/`overrides` — is byte-identical to the legacy
	 * three-layer merge (design §6.1).
	 *
	 * `resolveWorkflows`/`resolveToolGroupPolicies` are deliberately NOT routed
	 * here — they are non-installable types with no loader (design §2.2 note).
	 */
	private resolveViaPacks<T>(
		type: import("./pack-types.js").EntityType,
		loaders: import("./pack-types.js").EntityLoader<unknown>[],
		builtinItems: T[],
		keyFn: (item: T) => string,
		projectId: string | undefined,
		serverItems: T[],
		getProjectItems: (ctx: import("./project-context.js").ProjectContext) => T[],
	): ResolvedItem<T>[] {
		const wrap = (items: T[]): LoadedEntity<unknown>[] =>
			items.map(item => ({ name: keyFn(item), item }));
		const layer = (id: string, scope: PackScope, items: T[]): PackEntry => ({
			id,
			kind: scope === "builtin" ? "builtin" : "user",
			scope,
			path: "",
			readOnly: scope === "builtin",
			layout: "defaults-tree",
			preloaded: { [type]: wrap(items) },
		});

		const entries: PackEntry[] = [
			layer("builtin", "builtin", builtinItems),
			layer("user:server", "server", serverItems),
		];
		// Without projectId, only builtins + server stores are used (system scope).
		if (projectId) {
			const projectCtx = this.projectContextManager.getOrCreate(projectId);
			if (projectCtx) entries.push(layer("user:project", "project", getProjectItems(projectCtx)));
		}

		const resolved = new PackResolver(entries, loaders).resolve<T>(type);
		return resolved.map((r: ResolvedEntity<T>) => {
			const out: ResolvedItem<T> = { item: r.item, origin: scopeToOrigin(r.origin.scope) };
			if (r.shadows.length > 0) {
				out.overrides = scopeToOrigin(r.shadows[r.shadows.length - 1].scope);
			}
			return out;
		});
	}
}
