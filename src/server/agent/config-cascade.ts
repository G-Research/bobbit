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
import { HEADQUARTERS_PROJECT_ID } from "./project-registry.js";
import { mergeVerificationPolicyRaw, resolveVerificationPolicy as resolveVerificationPolicyPure, type VerificationPolicy } from "./verification-logic.js";

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
 * Headquarters is the user-facing alias for server/global config. Non-workflow
 * config must therefore omit the project layer when callers pass its project id.
 */
export function normalizeConfigProjectId(projectId?: string): string | undefined {
	return projectId === HEADQUARTERS_PROJECT_ID ? undefined : projectId;
}

/**
 * Where a resolved role field's effective value comes from, for the Roles UI
 * source badges + inline-edit gating:
 *
 * - `role` — the field is a direct override at the CURRENT scope's directly
 *   editable layer (project-local when scoped to a project, else the server
 *   layer). `PUT /api/roles/:name` writes this layer, so the row is editable
 *   in place.
 * - `inherited-role` — the value comes from a lower/ancestor role layer (an
 *   ancestor project, the server layer, a built-in role, or a market pack). The
 *   row can still be customized-then-edited unless `editable` is false.
 * - `default` — no role layer supplies the field; the effective value falls back
 *   to the global session/review model + thinking defaults (the client formats
 *   the default label and may further distinguish `auto`).
 */
export type RoleFieldSourceKind = "role" | "inherited-role" | "default";

export interface RoleFieldSource {
	/** Resolved field value when a role layer supplies it; omitted for `default`. */
	value?: string;
	source: RoleFieldSourceKind;
	/** Cascade layer the value came from (omitted for `default`). */
	origin?: ConfigOrigin;
	/** Market-pack name when the value comes from a pack-defined role; null otherwise. */
	originPackName?: string | null;
	/** False only for pack-managed (read-only) roles; true otherwise. */
	editable: boolean;
	/** Short human label for the source ("Project", "Server", "Built-in", pack name…). */
	sourceLabel: string;
}

export interface RoleModelResolution {
	model: RoleFieldSource;
	thinkingLevel: RoleFieldSource;
}

/** Short human label for a cascade origin (used in role source badges). */
function originSourceLabel(o: ConfigOrigin): string {
	switch (o) {
		case "builtin": return "Built-in";
		case "server": return "Server";
		case "user": return "User";
		case "project": return "Project";
	}
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
	/**
	 * Raw (pre-validation) server-scope verification-policy override, merged
	 * with the builtin layer by the caller (e.g.
	 * `groupPolicyStore`-style: `verificationPolicyStore.getMergedRaw()`).
	 * Optional so existing `ServerStores` fakes across the test suite don't
	 * need updating for a field they never exercise — omitted ⇒ no
	 * server-scope override (system scope falls straight through to builtin).
	 */
	getVerificationPolicyRaw?(): Record<string, unknown>;
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
		const normalizedProjectId = normalizeConfigProjectId(projectId);
		if (normalizedProjectId) {
			const v = this.localRoleField(normalizedProjectId, roleName, field);
			if (v !== undefined) return v;
			if (this.projectRegistry) {
				for (const anc of this.projectRegistry.getAncestors(normalizedProjectId)) {
					const normalizedAncestorId = normalizeConfigProjectId(anc.id);
					if (!normalizedAncestorId) continue;
					const av = this.localRoleField(normalizedAncestorId, roleName, field);
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

	/**
	 * Resolve the source hierarchy for a role's `model` and `thinkingLevel`
	 * fields so the Roles UI can render accurate source badges and decide inline
	 * editability without re-deriving the cascade order itself.
	 *
	 * The per-field walk follows the same layers as {@link resolveRoleField}
	 * (current project local → ancestor projects → server → builtin), then falls
	 * back to the resolved whole-role winner for values that only exist in a
	 * market pack. Editability is gated solely by pack-managed status (market
	 * packs are read-only), matching the whole-role customize/revert rules.
	 */
	resolveRoleModelResolution(roleName: string, projectId?: string): RoleModelResolution {
		const entry = this.resolveRolesEntries(projectId).find(e => e.name === roleName);
		const packName = entry && entry.origin.kind === "market"
			? (entry.origin.manifest?.name ?? null)
			: null;
		const packManaged = packName != null;
		return {
			model: this.resolveRoleFieldSource(roleName, "model", projectId, entry, packManaged, packName),
			thinkingLevel: this.resolveRoleFieldSource(roleName, "thinkingLevel", projectId, entry, packManaged, packName),
		};
	}

	private resolveRoleFieldSource(
		roleName: string,
		field: "model" | "thinkingLevel",
		projectId: string | undefined,
		entry: ResolvedEntity<Role> | undefined,
		packManaged: boolean,
		packName: string | null,
	): RoleFieldSource {
		const editable = !packManaged;
		// Headquarters is the server-scope alias — normalize the same way
		// resolveRoleField/resolveRolesEntries do (design §"Headquarters" note
		// above `normalizeConfigProjectId`), so a Headquarters projectId resolves
		// identically to the system (no-project) scope for source metadata too.
		const normalizedProjectId = normalizeConfigProjectId(projectId);

		// Rank a cascade band to mirror PackResolver precedence (low→high):
		//   builtin < server-market < server < global-user-market < global-user
		//   < project-market < project. Market packs sit just below their scope's
		//   user pack (design §3.2).
		const bandRank = (scope: PackScope, isMarket: boolean): number => {
			const base = { builtin: 0, server: 2, "global-user": 4, project: 6 }[scope];
			return base - (isMarket ? 1 : 0);
		};
		// The directly-editable band for this view: the project's own local layer
		// when scoped to a project, otherwise the server-level store.
		const editableRank = normalizedProjectId ? bandRank("project", false) : bandRank("server", false);

		// The whole-role PackResolver winner is the effective role at this scope.
		// Whenever it *supplies* the field, that value/source IS the effective
		// metadata and must outrank the plain server/builtin field walk below —
		// even for market / global-user / ancestor-project winners that sit BELOW
		// the current editable band but ABOVE server/builtin. The previous
		// `winnerRank >= editableRank` guard let those lower-but-still-winning
		// bands fall through and report a shadowed server/builtin field instead
		// of the real winner (finding #1).
		if (entry) {
			const wv = (entry.item as any)[field];
			if (typeof wv === "string" && wv.trim().length > 0) {
				const origin = scopeToOrigin(entry.origin.scope);
				const winnerRank = bandRank(entry.origin.scope, entry.origin.kind === "market");
				// Equal rank with a non-market winner ⇒ the winner IS the directly
				// editable layer (a user-authored override at this scope). Anything
				// else (higher, lower, or a market pack at the same rank) is an
				// effective value inherited from another band the user cannot edit
				// in place at this scope.
				const isEditableLayer = winnerRank === editableRank && entry.origin.kind !== "market";
				// A winner ABOVE the editable band shadows any write to the editable
				// layer: e.g. a `global-user` override while editing the server layer.
				// `PUT /api/roles/:name` writes the server (or project) layer, which
				// cannot override a higher-precedence winner, so the field is NOT
				// editable in place at this scope — reporting it editable would make
				// the inline control appear to no-op (review finding #3). Lower
				// winners (builtin under server, server under project) remain editable
				// because the editable-layer write DOES shadow them.
				const shadowsEditableLayer = winnerRank > editableRank;
				return {
					value: wv,
					source: isEditableLayer ? "role" : "inherited-role",
					origin,
					originPackName: packName,
					editable: editable && !shadowsEditableLayer,
					sourceLabel: packName ?? originSourceLabel(origin),
				};
			}
			// Winner role does not define the field ⇒ the runtime field-merge
			// (resolveRoleField) pulls it from a lower plain layer. Fall through to
			// the field-level walk below, which mirrors that field-merge order.
		}

		if (normalizedProjectId) {
			// Current editable layer: the project's own local override.
			const local = this.localRoleField(normalizedProjectId, roleName, field);
			if (local !== undefined) {
				return { value: local, source: "role", origin: "project", editable, sourceLabel: "Project" };
			}
			// Inherited from an ancestor project layer.
			if (this.projectRegistry) {
				for (const anc of this.projectRegistry.getAncestors(normalizedProjectId)) {
					const normalizedAncestorId = normalizeConfigProjectId(anc.id);
					if (!normalizedAncestorId) continue;
					const av = this.localRoleField(normalizedAncestorId, roleName, field);
					if (av !== undefined) {
						return { value: av, source: "inherited-role", origin: "project", editable, sourceLabel: "Inherited project" };
					}
				}
			}
			// Inherited from the server / builtin role layers.
			const sv = this.readRoleField(this.serverStores.getRoles(), roleName, field);
			if (sv !== undefined) {
				return { value: sv, source: "inherited-role", origin: "server", editable, sourceLabel: "Server" };
			}
			const bv = this.readRoleField(this.builtins.getRoles(), roleName, field);
			if (bv !== undefined) {
				return { value: bv, source: "inherited-role", origin: "builtin", editable, sourceLabel: "Built-in" };
			}
		} else {
			// Current editable layer: the server-level role store.
			const sv = this.readRoleField(this.serverStores.getRoles(), roleName, field);
			if (sv !== undefined) {
				return { value: sv, source: "role", origin: "server", editable, sourceLabel: "Server" };
			}
			const bv = this.readRoleField(this.builtins.getRoles(), roleName, field);
			if (bv !== undefined) {
				return { value: bv, source: "inherited-role", origin: "builtin", editable, sourceLabel: "Built-in" };
			}
		}
		// No role layer supplies the field — the client renders the session/review
		// (or auto) default for this label.
		return { source: "default", editable, sourceLabel: "Default" };
	}

	// ── Roles ────────────────────────────────────────────────────

	resolveRoles(projectId?: string): ResolvedItem<Role>[] {
		return this.resolveRolesEntries(projectId).map(r => toResolvedItem(r));
	}

	/** Raw resolved role entries (with origin pack + shadows) — for conflicts. */
	resolveRolesEntries(projectId?: string): ResolvedEntity<Role>[] {
		const normalizedProjectId = normalizeConfigProjectId(projectId);
		return this.resolveEntities<Role>(
			"roles",
			[new RoleLoader()],
			this.builtins.getRoles(),
			r => r.name,
			normalizedProjectId,
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
		const normalizedProjectId = normalizeConfigProjectId(projectId);
		return this.resolveEntities<ToolInfo>(
			"tools",
			[new ToolLoader()],
			this.builtins.getTools(),
			t => t.name,
			normalizedProjectId,
			this.serverStores.getTools(),
			ctx => ctx.toolManager.getLocalTools(),
		);
	}

	// ── Tool Group Policies ──────────────────────────────────────

	resolveToolGroupPolicies(projectId?: string): Record<string, ResolvedPolicy> {
		const normalizedProjectId = normalizeConfigProjectId(projectId);
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
		// Headquarters normalizes to server scope for non-workflow config.
		// Without projectId, only builtins + server stores are used (system scope).
		if (normalizedProjectId) {
			const projectCtx = this.projectContextManager.getOrCreate(normalizedProjectId);
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

	// ── Verification policy (S8 seam, V0) ────────────────────────
	//
	// Deliberately NOT routed through PackResolver — VerificationPolicy is a
	// fixed-shape object (not a name-keyed entity list), and the doc explicitly
	// stages it as a ConfigCascade-loaded sibling of tool-group-policies.yaml.
	// See docs/design/verification-policy-seam.md §2/§4.

	/**
	 * Resolve the effective `VerificationPolicy`: builtin ->
	 * server-scope override -> project-scope override, merged raw (per-field,
	 * `gateRoles` merged by key) and defaulted/validated in a single final
	 * `resolveVerificationPolicy` pass. Headquarters normalizes to system
	 * scope (no project layer), same as `resolveToolGroupPolicies`.
	 */
	resolveVerificationPolicy(projectId?: string): VerificationPolicy {
		const normalizedProjectId = normalizeConfigProjectId(projectId);

		let merged = mergeVerificationPolicyRaw(
			this.builtins.getVerificationPolicyRaw(),
			this.serverStores.getVerificationPolicyRaw?.() ?? {},
		);

		if (normalizedProjectId) {
			const projectCtx = this.projectContextManager.getOrCreate(normalizedProjectId);
			if (projectCtx) {
				merged = mergeVerificationPolicyRaw(merged, projectCtx.verificationPolicyStore.getMergedRaw());
			}
		}

		return resolveVerificationPolicyPure(merged);
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
