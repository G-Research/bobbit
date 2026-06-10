/**
 * Three-layer config resolution engine: builtin → server → project.
 *
 * Merges config items from embedded builtins, the server-level (default
 * project's config stores), and an optional project-level layer. Each
 * returned item carries an `origin` tag and an optional `overrides` field
 * indicating which lower layer it shadows.
 */

import os from "node:os";
import path from "node:path";
import type { Role, GrantPolicy } from "./role-store.js";
import type { Workflow } from "./workflow-store.js";
import type { ToolInfo } from "./tool-manager.js";
import type { BuiltinConfigProvider } from "./builtin-config.js";
import type { ProjectContextManager } from "./project-context-manager.js";
import type { LoadedEntity, PackEntry, PackScope, ResolvedEntity } from "./pack-types.js";
import { scopePaths } from "./pack-types.js";
import { PackResolver, RoleLoader, ToolLoader } from "./pack-resolver.js";
import { builtinFirstPartyPackEntries, resolveBuiltinPacksDir } from "./builtin-packs.js";

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
	/** {@link PackEntry.id} when the winner is a market pack (design §5.2); null otherwise. */
	originPackId?: string | null;
	/** Market pack `name` when the winner is a market pack; null otherwise. */
	originPackName?: string | null;
}

/**
 * Supplies the installed market-pack {@link PackEntry} list for a scope so the
 * cascade adapter can interleave them into roles/tools resolution (market packs
 * sit BELOW the scope's user pack — design §3.2). Injected (not derived from
 * fs here) so {@link ConfigCascade} stays decoupled from path/store wiring.
 * Omitted ⇒ no market packs (existing cascade tests resolve unchanged).
 */
export interface MarketPackProvider {
	marketEntries(scope: "server" | "global-user" | "project", projectId?: string): PackEntry[];
}

/**
 * Supplies the per-scope pack-activation disabled-entity refs so the cascade can
 * drop disabled roles/tools BEFORE precedence merge (pack-schema-v1 §7). Injected
 * (server.ts wires it to the pack_activation store) so {@link ConfigCascade} stays
 * decoupled from store wiring. Omitted ⇒ no activation filtering.
 */
export interface PackActivationProvider {
	disabled(
		scope: "server" | "global-user" | "project",
		projectId: string | undefined,
		packName: string,
	): { roles?: string[]; tools?: string[]; skills?: string[]; entrypoints?: string[] };
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
	/**
	 * Base dir for the global-user scope's user pack (`<base>/.bobbit/config`,
	 * via {@link scopePaths}). Defaults to `os.homedir()`; injectable so unit
	 * tests can point the global-user user pack at a fixture dir instead of the
	 * real home dir (design §3.1/§5.2).
	 */
	private globalUserBase: string;

	/**
	 * The first-party pack band root (`resolveBuiltinPacksDir()`). Shipped
	 * first-party packs resolve in place as a band ABOVE the builtin defaults
	 * and BELOW every user scope band (design §5.3). Injectable so unit tests can
	 * point it at a fixture dir; defaults to the shipped dist tree (which is
	 * absent under source/test runs ⇒ no band ⇒ byte-identical legacy merge).
	 */
	private builtinPacksDir: string;

	constructor(
		private builtins: BuiltinConfigProvider,
		private serverStores: ServerStores,
		private projectContextManager: ProjectContextManager,
		private projectRegistry?: ProjectAncestorRegistry,
		private marketPackProvider?: MarketPackProvider,
		globalUserBase?: string,
		builtinPacksDir?: string,
	) {
		this.globalUserBase = globalUserBase ?? os.homedir();
		this.builtinPacksDir = builtinPacksDir ?? resolveBuiltinPacksDir();
	}

	/** Late-bind the market-pack provider (server.ts wires it after fs/store setup). */
	setMarketPackProvider(provider: MarketPackProvider): void {
		this.marketPackProvider = provider;
	}

	private packActivationProvider?: PackActivationProvider;

	/** Late-bind the pack-activation provider (server.ts wires it after store setup). */
	setPackActivationProvider(provider: PackActivationProvider): void {
		this.packActivationProvider = provider;
	}

	/** Override the global-user scope base (tests; defaults to `os.homedir()`). */
	setGlobalUserBase(base: string): void {
		this.globalUserBase = base;
	}

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
		return this.resolveRolesEntries(projectId).map(r => toResolvedItem(r));
	}

	/** Raw resolved role entries (with origin pack + shadows) — for conflicts. */
	resolveRolesEntries(projectId?: string): ResolvedEntity<Role>[] {
		return this.resolveEntities<Role>(
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
		return this.resolveToolsEntries(projectId).map(r => toResolvedItem(r));
	}

	/** Raw resolved tool entries (with origin pack + shadows) — for conflicts. */
	resolveToolsEntries(projectId?: string): ResolvedEntity<ToolInfo>[] {
		return this.resolveEntities<ToolInfo>(
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
	 * Resolve the cascade layers (builtin → server → global-user → project)
	 * through the unified {@link PackResolver}, interleaving installed market
	 * packs into each scope segment (market BELOW the scope's user pack —
	 * design §3.2).
	 *
	 * The user/builtin layers' data lives in injected in-memory stores (not on
	 * a scannable directory), so each is wrapped as a `preloaded`
	 * {@link PackEntry}; market packs are real on-disk `defaults-tree` entries
	 * loaded by the same loaders. With zero market packs (the only state the
	 * legacy cascade tests exercise) the ordered list is exactly
	 * builtin < server < project, so insertion order, shadowing, and
	 * `origin`/`overrides` are byte-identical to the legacy three-layer merge
	 * (design §6.1). The global-user segment is empty for roles/tools today.
	 *
	 * `resolveWorkflows`/`resolveToolGroupPolicies` are deliberately NOT routed
	 * here — they are non-installable types with no loader (design §2.2 note).
	 */
	private resolveEntities<T>(
		type: import("./pack-types.js").EntityType,
		loaders: import("./pack-types.js").EntityLoader<unknown>[],
		builtinItems: T[],
		keyFn: (item: T) => string,
		projectId: string | undefined,
		serverItems: T[],
		getProjectItems: (ctx: import("./project-context.js").ProjectContext) => T[],
	): ResolvedEntity<T>[] {
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
		// Dedup market entries by absolute path: when two scopes resolve to the
		// same `market-packs` dir (a self-managed project whose rootPath equals
		// the server cwd — design §1.3.1 path collision), attribute the pack to
		// the FIRST (lowest) scope and skip the duplicate, so it never appears
		// to "conflict with itself".
		const seenMarketPaths = new Set<string>();
		const pushMarket = (scope: "server" | "global-user" | "project"): void => {
			const list = this.marketPackProvider ? this.marketPackProvider.marketEntries(scope, projectId) : [];
			for (const e of list) {
				const key = path.resolve(e.path);
				if (seenMarketPaths.has(key)) continue;
				seenMarketPaths.add(key);
				entries.push(e);
			}
		};

		const entries: PackEntry[] = [layer("builtin", "builtin", builtinItems)];
		// Built-in first-party packs (resolve-in-place band, design §5.3): above
		// the monolithic builtin defaults, below every user scope band. Deduped by
		// path like market entries. Activation filtering (below) treats them as
		// normal server-scope market packs.
		for (const e of builtinFirstPartyPackEntries(this.builtinPacksDir)) {
			const key = path.resolve(e.path);
			if (seenMarketPaths.has(key)) continue;
			seenMarketPaths.add(key);
			entries.push(e);
		}
		// Server segment: market packs below the server user pack.
		pushMarket("server");
		entries.push(layer("user:server", "server", serverItems));
		// Global-user segment: market packs, then the global-user user pack
		// (`~/.bobbit/config/roles|tools`). The user pack is a real on-disk
		// `defaults-tree` entry scanned by the same loaders (design §3.1/§5.2);
		// it sits above global-user market packs (§3.2) and below the project
		// segment. Empty today ⇒ byte-identical to the legacy 3-layer merge.
		pushMarket("global-user");
		entries.push({
			id: "user:global-user",
			kind: "user",
			scope: "global-user",
			path: scopePaths("global-user", this.globalUserBase).userPackRoot,
			readOnly: false,
			layout: "defaults-tree",
		});
		// Project segment (only when a projectId is specified — system scope omits it).
		if (projectId) {
			const projectCtx = this.projectContextManager.getOrCreate(projectId);
			if (projectCtx) {
				pushMarket("project");
				entries.push(layer("user:project", "project", getProjectItems(projectCtx)));
			}
		}

		// Activation filtering (§7): drop disabled market-pack entities BEFORE merge
		// so a lower-priority shadow can win. Non-market entries are never filtered.
		const provider = this.packActivationProvider;
		const filter = provider
			? (entry: PackEntry, t: import("./pack-types.js").EntityType, name: string): boolean => {
				if (entry.kind !== "market" || !entry.manifest) return true;
				if (t !== "roles" && t !== "tools" && t !== "skills") return true;
				const scope = entry.scope;
				if (scope !== "server" && scope !== "global-user" && scope !== "project") return true;
				const disabled = provider.disabled(scope, projectId, entry.manifest.name);
				const list = disabled[t];
				return !list || !list.includes(name);
			}
			: undefined;
		return new PackResolver(entries, loaders, filter).resolve<T>(type);
	}
}

/** Map a raw {@link ResolvedEntity} to the wire {@link ResolvedItem} (origin/overrides + pack tags). */
function toResolvedItem<T>(r: ResolvedEntity<T>): ResolvedItem<T> {
	const out: ResolvedItem<T> = { item: r.item, origin: scopeToOrigin(r.origin.scope) };
	if (r.shadows.length > 0) {
		out.overrides = scopeToOrigin(r.shadows[r.shadows.length - 1].scope);
	}
	if (r.origin.kind === "market") {
		out.originPackId = r.origin.id;
		out.originPackName = r.origin.manifest?.name ?? null;
	}
	return out;
}
