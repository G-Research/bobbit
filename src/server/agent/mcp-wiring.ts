/**
 * MCP client wiring — cohort 2 of the SessionManager decomposition
 * (docs/design/session-manager-decomposition.md, cluster D). Extracted
 * verbatim (mechanical move, no behavior change) from session-manager.ts:
 * owns the default + scoped `McpManager` instances and every lookup/
 * create/connect/reload/disconnect method around them, so this logic can be
 * exercised in unit tests without dragging in the rest of SessionManager's
 * dependency graph (sessions, RpcBridge, sandbox, search) — same stated
 * purpose session-status.ts's and archived-worktree-manager.ts's own header
 * comments give for their extractions.
 *
 * Cross-cluster dependencies (session-scope lookup, live-cwd-in-use check,
 * already-injected read-only collaborators) are threaded through
 * `McpWiringDeps` as data/callbacks rather than imported directly, per
 * docs/design/route-registry.md's "ctx is data, not imports" rule and
 * archived-worktree-manager.ts's precedent. `toolManager`, `projectConfigStore`,
 * and `projectContextManager` are constructor-time-only (SessionManager never
 * reassigns them after its own constructor runs, confirmed live) so they are
 * captured by value, not a getter — see design doc §4.2 and §5's ArchivedWorktreeDeps.
 *
 * DOC DRIFT vs. docs/design/session-manager-decomposition.md §1.2/§3 cluster D:
 * the design doc's line range (2224-2562, pre-cohort-1 numbering) and prose
 * ("marketplace/pi-extension wiring (2436-2474)") loosely bundled two
 * unrelated, textually-interleaved clusters into "cluster D" that do NOT
 * touch `mcpManager`/`scopedMcpManagers` at all: (1) the worktree-pool
 * methods (`initWorktreePoolForProject` etc., touch `worktreePools`/
 * `sessions`) and (2) the pi-extension-diagnostics methods
 * (`setMarketplacePiExtensionResolver`, `resolveMarketplacePiExtensionArgs`,
 * `overlayPiExtensionRuntimeDiagnostics`, etc., touch
 * `marketplacePiExtensionResolver`/`piExtensionRuntimeDiagnostics`). Re-verified
 * against the live file per this cohort's field-coupling methodology (the
 * doc's own §1 grouping rule: "grouping by what state each method reads or
 * mutates") — neither sub-cluster moved here; both remain in session-manager.ts.
 *
 * TEST-SEAM HAZARD (also doc drift — the design doc's §2.3/hazard-3 only
 * anticipated the `ensureMcpManagerForContext` stub seam in
 * tests/helpers/mcp-stub.ts; live grep found FOUR more monkey-patched
 * members): existing unit tests directly reassign
 * `sessionManager.ensureMcpManagerForContext`, `.ensureMcpManager`,
 * `.createMcpManager`, `.refreshExternalMcpToolRegistrations`, and the raw
 * `.mcpManager` field on a `new SessionManager()` instance (see
 * tests/helpers/mcp-stub.ts, tests/mcp-manager-marketplace-discovery.test.ts,
 * tests/headquarters-server-scope-guards.test.ts,
 * tests/session-manager-ambient-mcp-isolation.test.ts). Before this
 * extraction all of these lived as methods on the SAME `this`, so patching
 * any one was automatically honored by every other method's internal call
 * into it. Splitting the methods across two objects would silently break
 * that: an internal McpWiring-to-McpWiring call would use the REAL
 * implementation even when a test patched the SessionManager-level method.
 * Fix: the four call sites that cross this boundary (`ensureMcpManagerForContext`
 * -> `ensureMcpManager`, `ensureMcpManager` -> `createMcpManager`,
 * `removeScopedMcpManagerByKey`/`reloadMcpAfterMarketplaceMutation`/`initMcp`
 * -> `refreshExternalMcpToolRegistrations`) go through `this.deps.<name>(...)`,
 * which round-trips through SessionManager's own delegating wrapper — the
 * same object tests patch — instead of calling this class's own copy
 * directly. `mcpManager`/`scopedMcpManagers` need no such round-trip: they
 * are DATA, and SessionManager exposes them as get/set accessors backed by
 * this class's real fields, so a raw-field test poke on either side reads
 * back consistently everywhere (see session-manager.ts's `mcpManager`/
 * `scopedMcpManagers` accessors).
 */
import path from "node:path";
import { McpManager, type MarketplaceMcpResolver, type McpReloadResult } from "../mcp/mcp-manager.js";
import type { ToolManager } from "./tool-manager.js";
import type { ProjectConfigStore } from "./project-config-store.js";
import type { ProjectContextManager } from "./project-context-manager.js";
import { bobbitStateDir } from "../bobbit-dir.js";

export interface McpWiringDeps {
	/** Constructor-time-only; SessionManager never reassigns these after its own constructor runs. */
	toolManager: ToolManager | undefined;
	projectConfigStore: ProjectConfigStore | undefined;
	projectContextManager: ProjectContextManager | null;
	/**
	 * `sessions` mutates continuously — narrow snapshot callbacks, never a
	 * live Map reference, mirroring archived-worktree-manager.ts's
	 * `listLiveSessionWorktreeRefs` rule (design doc §4.1).
	 */
	resolveSessionScope(sessionId: string): { projectId?: string; cwd?: string };
	isCwdInUseByLiveSession(cwd: string): boolean;
	/**
	 * Round-trip callbacks back into SessionManager's own delegating wrappers
	 * for the four methods existing unit tests monkey-patch directly (see the
	 * TEST-SEAM HAZARD note above) — NOT a plain re-implementation, this
	 * literally closes over `this.<name>(...)` on the SessionManager
	 * instance so a test's instance-level patch is honored from every
	 * internal call path exactly as it was before this extraction.
	 */
	createMcpManager(cwd: string, opts?: { projectId?: string; scopeKey?: string; includeAdditionalProjects?: boolean }): McpManager;
	ensureMcpManager(scope?: { projectId?: string; cwd?: string; scopeKey?: string }): Promise<McpManager | null>;
	ensureMcpManagerForContext(projectId?: string, cwd?: string): Promise<McpManager | null>;
	refreshExternalMcpToolRegistrations(): void;
}

export class McpWiring {
	/** Default (unscoped) MCP manager. Exposed via session-manager.ts's `mcpManager` get/set accessor. */
	mcpManager: McpManager | null = null;
	/** Project/cwd-scoped MCP managers, keyed by `mcpScopeKey(...)`. Exposed via session-manager.ts's `scopedMcpManagers` get accessor (live Map reference). */
	scopedMcpManagers: Map<string, McpManager> = new Map();
	private marketplaceMcpResolver: MarketplaceMcpResolver | null = null;

	constructor(private readonly deps: McpWiringDeps) {}

	private mcpScopeKey(scope?: { projectId?: string; cwd?: string; scopeKey?: string }): string {
		if (scope?.scopeKey) return scope.scopeKey;
		if (scope?.projectId) return `project:${scope.projectId}`;
		if (scope?.cwd) return `cwd:${path.resolve(scope.cwd)}`;
		return "default";
	}

	getMcpManager(scope?: { projectId?: string; cwd?: string; scopeKey?: string }): McpManager | null {
		const key = this.mcpScopeKey(scope);
		if (key === "default") return this.mcpManager;
		return this.scopedMcpManagers.get(key) ?? null;
	}

	getActiveMcpManagers(): McpManager[] {
		return [
			...(this.mcpManager ? [this.mcpManager] : []),
			...this.scopedMcpManagers.values(),
		];
	}

	refreshExternalMcpToolRegistrations(): void {
		if (!this.deps.toolManager) return;
		const removePrefixes = new Set<string>(["mcp__"]);
		const toolInfos: ReturnType<McpManager["getToolInfos"]> = [];
		for (const mgr of this.getActiveMcpManagers()) {
			const refresh = mgr.getToolRegistrationRefresh();
			for (const prefix of refresh.removePrefixes) removePrefixes.add(prefix);
			toolInfos.push(...refresh.toolInfos);
		}
		for (const prefix of removePrefixes) this.deps.toolManager.removeExternalTools(prefix);
		this.deps.toolManager.registerExternalTools(toolInfos.map(info => ({
			name: info.name,
			description: info.description,
			summary: info.summary ?? info.description,
			group: info.group,
			docs: info.docs,
			provider: { type: 'mcp' as const, server: info.serverName, mcpTool: info.mcpToolName },
		})));
	}

	private async removeScopedMcpManagerByKey(key: string): Promise<boolean> {
		const mgr = this.scopedMcpManagers.get(key);
		if (!mgr) return false;
		this.scopedMcpManagers.delete(key);
		try {
			await mgr.disconnectAll();
		} finally {
			this.deps.refreshExternalMcpToolRegistrations();
		}
		return true;
	}

	async cleanupScopedMcpManagersForProject(projectId: string, rootPath?: string): Promise<void> {
		const targetRoot = rootPath ? path.resolve(rootPath) : undefined;
		const projectScopeKey = this.mcpScopeKey({ projectId });
		const targetCwdScopeKey = targetRoot ? this.mcpScopeKey({ cwd: targetRoot }) : undefined;
		const keys: string[] = [];
		for (const [key, mgr] of this.scopedMcpManagers) {
			const scope = mgr.getDiscoveryScope();
			if (
				key === projectScopeKey
				|| key === targetCwdScopeKey
				|| scope.projectId === projectId
				|| (targetRoot && path.resolve(scope.cwd) === targetRoot)
			) {
				keys.push(key);
			}
		}
		for (const key of keys) await this.removeScopedMcpManagerByKey(key);
	}

	async cleanupScopedMcpManagersForSessionScope(scope: { projectId?: string; cwd?: string }): Promise<void> {
		if (!scope.cwd) return;
		const cwdKey = this.mcpScopeKey({ cwd: scope.cwd });
		if (!this.scopedMcpManagers.has(cwdKey)) return;
		const cwd = path.resolve(scope.cwd);
		const stillInUse = this.deps.isCwdInUseByLiveSession(cwd);
		if (!stillInUse) await this.removeScopedMcpManagerByKey(cwdKey);
	}

	createMcpManager(cwd: string, opts?: { projectId?: string; scopeKey?: string; includeAdditionalProjects?: boolean }): McpManager {
		const projectConfigStore = opts?.projectId && this.deps.projectContextManager
			? (this.deps.projectContextManager.getOrCreate(opts.projectId)?.projectConfigStore ?? this.deps.projectConfigStore)
			: this.deps.projectConfigStore;
		const mgr = new McpManager(cwd, projectConfigStore, bobbitStateDir(), {
			marketplaceResolver: this.marketplaceMcpResolver ?? undefined,
			...(opts?.projectId ? { projectId: opts.projectId } : {}),
			...(opts?.scopeKey ? { scopeKey: opts.scopeKey } : {}),
		});
		if (opts?.includeAdditionalProjects && this.deps.projectContextManager) {
			const additionalProjects = Array.from(this.deps.projectContextManager.all())
				.filter(ctx => ctx.project.rootPath !== cwd)
				.map(ctx => ({ cwd: ctx.project.rootPath, configStore: ctx.projectConfigStore }));
			if (additionalProjects.length > 0) mgr.setAdditionalProjects(additionalProjects);
		}
		return mgr;
	}

	async ensureMcpManager(scope?: { projectId?: string; cwd?: string; scopeKey?: string }): Promise<McpManager | null> {
		const key = this.mcpScopeKey(scope);
		if (key === "default") return this.mcpManager;
		const existing = this.scopedMcpManagers.get(key);
		if (existing) return existing;
		let cwd = scope?.cwd;
		let projectId = scope?.projectId;
		if (projectId && this.deps.projectContextManager) {
			const ctx = this.deps.projectContextManager.getOrCreate(projectId);
			if (!ctx) return null;
			cwd = ctx.project.rootPath;
		}
		if (!cwd) return null;
		const mgr = this.deps.createMcpManager(cwd, { projectId, scopeKey: key });
		this.scopedMcpManagers.set(key, mgr);
		await mgr.connectAll();
		return mgr;
	}

	getMcpManagerForContext(projectId?: string, cwd?: string): McpManager | null {
		if (projectId) return this.getMcpManager({ projectId, cwd });
		return null;
	}

	async ensureMcpManagerForContext(projectId?: string, cwd?: string): Promise<McpManager | null> {
		if (projectId) return this.deps.ensureMcpManager({ projectId, cwd });
		return null;
	}

	private getMcpSessionScope(sessionId: string): { projectId?: string; cwd?: string } {
		return this.deps.resolveSessionScope(sessionId);
	}

	getMcpManagerForSession(sessionId: string): McpManager | null {
		const { projectId, cwd } = this.getMcpSessionScope(sessionId);
		return this.getMcpManagerForContext(projectId, cwd);
	}

	async ensureMcpManagerForSession(sessionId: string): Promise<McpManager | null> {
		const { projectId, cwd } = this.getMcpSessionScope(sessionId);
		return this.deps.ensureMcpManagerForContext(projectId, cwd);
	}

	async resolveMcpManagerForSession(sessionId: string, scopeKey?: string): Promise<McpManager | null> {
		// ensureMcpManagerForSession already round-trips through
		// deps.ensureMcpManagerForContext internally (see above) — plain
		// self-call here is correct, no separate round-trip needed.
		if (!scopeKey) return this.ensureMcpManagerForSession(sessionId);
		const { projectId } = this.getMcpSessionScope(sessionId);
		const projectScopeKey = projectId ? this.mcpScopeKey({ projectId }) : undefined;
		if (projectId && scopeKey === projectScopeKey) return this.getMcpManager({ scopeKey }) ?? await this.deps.ensureMcpManager({ projectId });
		return null;
	}

	private aggregateMcpReloadResults(results: McpReloadResult[]): McpReloadResult | undefined {
		if (results.length === 0) return undefined;
		const connected = results.flatMap(r => r.connected);
		const disconnected = results.flatMap(r => r.disconnected);
		const unchanged = results.flatMap(r => r.unchanged);
		const skippedErrored = results.flatMap(r => r.skippedErrored);
		const failed = results.flatMap(r => r.failed);
		const statuses = results.flatMap(r => r.statuses);
		let status: McpReloadResult["status"] = "ok";
		if (results.some(r => r.status === "pending")) {
			status = "pending";
		} else if (results.every(r => r.status === "error")) {
			status = "error";
		} else if (results.some(r => r.status === "error" || r.status === "partial")) {
			status = "partial";
		}
		return { status, connected, disconnected, unchanged, skippedErrored, failed, statuses };
	}

	async reloadMcpAfterMarketplaceMutation(scope?: "server" | "global-user" | "project", projectId?: string): Promise<McpReloadResult | undefined> {
		const managers = new Set<McpManager>();
		if (scope === "project") {
			const mgr = await this.deps.ensureMcpManager({ projectId });
			if (mgr) managers.add(mgr);
		} else {
			if (this.mcpManager) managers.add(this.mcpManager);
			for (const mgr of this.scopedMcpManagers.values()) managers.add(mgr);
		}
		const results: McpReloadResult[] = [];
		const pendingRefreshes: Promise<unknown>[] = [];
		for (const mgr of managers) {
			try {
				const result = await mgr.reloadDiscoveredServers({ timeoutMs: 30_000, queueIfInFlight: true });
				results.push(result);
				if (result.status === "pending") {
					const pending = mgr.currentReload();
					if (pending) pendingRefreshes.push(pending.catch(() => undefined));
				}
			} catch (err) {
				const scopeKey = mgr.getScopeKey();
				results.push({
					status: "error",
					connected: [],
					disconnected: [],
					unchanged: [],
					skippedErrored: [],
					failed: [{ name: scopeKey, error: err instanceof Error ? err.message : String(err) }],
					statuses: [],
				});
			}
		}
		if (pendingRefreshes.length > 0) {
			void Promise.allSettled(pendingRefreshes).then(() => this.deps.refreshExternalMcpToolRegistrations());
		}
		return this.aggregateMcpReloadResults(results);
	}

	setMarketplaceMcpResolver(resolver: MarketplaceMcpResolver | null | undefined): void {
		this.marketplaceMcpResolver = resolver ?? null;
		this.mcpManager?.setMarketplaceResolver(this.marketplaceMcpResolver);
		for (const mgr of this.scopedMcpManagers.values()) mgr.setMarketplaceResolver(this.marketplaceMcpResolver);
	}

	async initMcp(cwd: string): Promise<void> {
		try {
			const mgr = this.deps.createMcpManager(cwd, { includeAdditionalProjects: true });

			await mgr.connectAll();
			this.mcpManager = mgr;

			if (this.deps.projectContextManager) {
				for (const ctx of this.deps.projectContextManager.all()) {
					const key = this.mcpScopeKey({ projectId: ctx.project.id });
					if (this.scopedMcpManagers.has(key)) continue;
					const scoped = this.deps.createMcpManager(ctx.project.rootPath, { projectId: ctx.project.id, scopeKey: key });
					this.scopedMcpManagers.set(key, scoped);
					await scoped.connectAll();
				}
			}

			// Register MCP tools with ToolManager across default and scoped managers.
			this.deps.refreshExternalMcpToolRegistrations();
			console.log(`[mcp] MCP initialization complete`);
		} catch (err) {
			console.error('[mcp] Failed to initialize MCP:', (err as Error).message);
		}
	}

	/**
	 * Disconnect every MCP server this instance connected (default + scoped)
	 * — called from SessionManager.shutdown(). disconnectServer() swallows
	 * per-server errors, so this is best-effort and never blocks the rest of
	 * shutdown(). The typeof guard tolerates test doubles injected as
	 * `mcpManager` (e.g. tests/headquarters-server-scope-guards.test.ts stubs
	 * a plain object to observe scope-resolution calls) — a double without
	 * disconnectAll has no real child processes to reap.
	 */
	async shutdownDisconnectAll(): Promise<void> {
		const mcpManagers = [...this.scopedMcpManagers.values(), ...(this.mcpManager ? [this.mcpManager] : [])];
		await Promise.all(mcpManagers.map(async (mgr) => {
			if (typeof mgr?.disconnectAll !== "function") return;
			await mgr.disconnectAll().catch((err: unknown) => {
				console.error("[mcp] Failed to disconnect MCP manager during shutdown:", (err as Error).message);
			});
		}));
		this.scopedMcpManagers.clear();
		this.mcpManager = null;
	}
}
