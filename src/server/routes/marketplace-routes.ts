// src/server/routes/marketplace-routes.ts
//
// STR-01 cohort 2 (marketplace family): the `/api/marketplace/*` prefix
// (sources, browse, install/update/uninstall, pack-order, pack-activation,
// mcp-operation toggles, purge-runtime) plus the lexically-adjacent
// `GET /api/packs/conflicts` — migrated out of handleApiRoute's legacy
// if/else chain into the core route registry (src/server/routes/route-table.ts).
// See docs/design/route-registry.md.
//
// Unlike cohort 1 (projects — many small, independent handlers), this family
// was ALREADY behind one wrapping `if (url.pathname.startsWith("/api/marketplace/")
// || url.pathname === "/api/packs/conflicts")` guard in the legacy chain, with
// ~15 route-local closures (parseScope, resolveScopeTarget, buildActivationCatalogue,
// etc.) shared across its ~12 nested exact-match sub-routes, and a shared
// trailing `{ error: "not found" }` 404 for any /api/marketplace/* path that
// matches none of them. Splitting that into ~12 independent `table.register()`
// handlers would mean threading the same ~15 closures through every one of
// them, or duplicating them — worse than the alternative the design doc calls
// out for exactly this shape: register the WHOLE guard as a `/*` prefix (one
// per HTTP method, since the legacy guard tested `req.method` internally per
// sub-route rather than gating on it upfront) with a single handler that
// preserves every nested exact `if (url.pathname === ...)` check — and the
// shared 404 fallback — verbatim, byte-for-byte the same logic as the block it
// replaces. `/api/packs/conflicts` is registered as its own exact route
// (distinct literal path, but shares the same "marketplace not available" 500
// guard and closure scope in the original code, so it points at the same
// handler).
//
// Free variables that used to be handleApiRoute's own params/closures (json,
// jsonError, readBody, sessionManager, marketplaceInstaller, ...) are
// destructured from `ctx` under IDENTICAL names, so the body below needed ZERO
// further edits beyond that destructure — see core-route-ctx.ts for why some
// of these are passed through by reference rather than imported directly.
// Zero behavior change: same auth (handled upstream of handleApiRoute,
// untouched), same validation, same status codes, same error shapes,
// including the shared trailing 404.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import type { RouteTable } from "./route-table.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import { isValidSourceId, type MarketplaceSource } from "../agent/marketplace-source-store.js";
import { MarketplaceError, readPackEntityDescriptions, type InstallScope, type PackOrderStore, type PackEntityDescriptions, type BrowsePack } from "../agent/marketplace-install.js";
import { builtinFirstPartyPackEntries, resolveBuiltinPacksDir } from "../agent/builtin-packs.js";
import { loadPackContributions, packIdFromRoot, providerConfigStoreKey } from "../agent/pack-contributions.js";
import { scopeMarketPackEntries } from "../agent/pack-list.js";
import { normalizeConfigProjectId } from "../agent/config-cascade.js";
import { parseMcpToolName } from "../mcp/mcp-meta.js";
import type { McpToolRouteSnapshot, ResolvedMcpContribution } from "../mcp/mcp-manager.js";
import { getPackStore } from "../extension-host/pack-store.js";
import type { ProjectConfigStore, PackOrderScope } from "../agent/project-config-store.js";
import { buildConflictsFor, type ConflictWire, type PackScope, type PackEntry } from "../agent/pack-types.js";
import { PackRuntimeNotFoundError, PackRuntimeBadRequestError, encodePackRuntimeId, readRuntimeStartPolicy } from "../runtimes/index.js";
import { discoverSlashSkillsResolved } from "../skills/slash-skills.js";
import { headquartersDir } from "../bobbit-dir.js";

// GET/POST/PUT/DELETE/PATCH /api/marketplace/* and GET /api/packs/conflicts.
// See the file header for why this is one handler rather than one per route.
async function handleMarketplaceRequest(ctx: CoreRouteCtx): Promise<void> {
	const {
		req, res, url, json, jsonError, readBody,
		sessionManager, projectContextManager, projectConfigStore, configCascade,
		marketplaceInstaller, marketplaceSourceStore, packRuntimeSupervisor,
		invalidateResolverCaches, reloadMcpAfterMarketplaceMutation,
		resolveProjectConfigStore, resolveSkillDiscoveryCwd, skillMarketContext,
		safeString, readYamlMapping, readConcretePackToolsFromGroups,
		getDefaultDisabledInfo, readForceEnabledPacks, writeForceEnabledPacks,
		loadPiExtensionContributionsFromRuntime, piExtensionDiagnostic, normalisePiExtensionCatalogueRefs,
		activationMcpContributionId, operationMetadataForMcpContribution,
		resolveRuntimeStartPlan, providerCarriesDeploymentMode,
	} = ctx;

	if (!marketplaceInstaller || !marketplaceSourceStore) { json({ error: "marketplace not available" }, 500); return; }
	const installer = marketplaceInstaller;
	const sourceStore = marketplaceSourceStore;

	// ── Built-in first-party source (built-in-first-party-packs §4.4, §6.4) ──
	// The built-in source is synthetic + non-persisted: it is composed only here
	// and points at the shipped first-party packs resolved in place.
	const BUILTIN_SOURCE_ID = "builtin";
	const builtinSource = { id: BUILTIN_SOURCE_ID, url: "builtin:", builtin: true, addedAt: new Date(0).toISOString() };
	// A pack name is "built-in" iff a shipped first-party pack declares it.
	const isBuiltinPackName = (name: string): boolean =>
		builtinFirstPartyPackEntries(resolveBuiltinPacksDir()).some((e) => e.manifest?.name === name);
	// True iff a real user install of `(scope, packName)` exists in the ledger.
	const hasUserInstall = (scope: InstallScope, packName: string, projectId?: string): boolean =>
		installer.listInstalled(allContexts(normalizeConfigProjectId(projectId))).some((p) => p.scope === scope && p.packName === packName);

	const sourceDisplayName = (source: Pick<MarketplaceSource, "id" | "displayName" | "type"> & { builtin?: boolean }): string =>
		source.builtin ? "Built-in" : source.displayName ?? source.id;
	const sourceTypeForBrowse = (source: Pick<MarketplaceSource, "type"> & { builtin?: boolean }): "builtin" | "pack" | "mcp-gateway" | "mcp-registry" =>
		source.builtin ? "builtin" : (source.type ?? "pack");
	const browseRowWithSource = (pack: BrowsePack, source: Pick<MarketplaceSource, "id" | "displayName" | "type"> & { builtin?: boolean }): BrowsePack => {
		const type = sourceTypeForBrowse(source);
		return {
			...pack,
			source: { id: source.id, name: sourceDisplayName(source), type: type === "mcp-registry" ? "pack" : type, ...(source.builtin ? { builtin: true } : {}) },
			browseKey: `${source.id}:${pack.dirName}`,
		};
	};

	const MARKET_SCOPES = new Set(["global-user", "server", "project"]);
	const parseScope = (raw: unknown): InstallScope | null =>
		typeof raw === "string" && MARKET_SCOPES.has(raw) ? (raw as InstallScope) : null;

	type ScopeTarget = { scope: InstallScope; projectBase?: string; store: PackOrderStore };
	const resolveScopeTarget = (
		scope: InstallScope,
		projectId: string | undefined,
	): { ok: true; target: ScopeTarget } | { ok: false; status: number; error: string } => {
		const effectiveProjectId = normalizeConfigProjectId(projectId);
		if (scope === "project") {
			if (!projectId) return { ok: false, status: 400, error: "projectId required for project scope" };
			if (!effectiveProjectId) return { ok: true, target: { scope: "server", store: projectConfigStore } };
			const ctx = projectContextManager.getOrCreate(effectiveProjectId);
			if (!ctx) return { ok: false, status: 404, error: "Project not found" };
			return { ok: true, target: { scope, projectBase: ctx.project.rootPath, store: ctx.projectConfigStore } };
		}
		return { ok: true, target: { scope, store: projectConfigStore } };
	};

	const errStatus = (code: string, notInstalled = 409): number => {
		switch (code) {
			case "unknown_source": return 404;
			case "unknown_pack": return 404;
			case "invalid_pack": return 422;
			case "already_installed": return 409;
			case "not_installed": return notInstalled;
			case "unsafe_name": return 400;
			case "git_failed": return 502;
			default: return 400;
		}
	};
	const handleMarketErr = (err: unknown, notInstalled = 409): void => {
		if (err instanceof MarketplaceError) { json({ error: err.message }, errStatus(err.code, notInstalled)); return; }
		if (err instanceof Error && err.name === "McpGatewayError") { json({ error: err.message }, /fetch failed|HTTP|timed out/i.test(err.message) ? 502 : 422); return; }
		jsonError(500, err);
	};

	// All scope contexts present for cross-scope listing. Each carries its
	// scope's `pack_order` so `listInstalled` returns rows in precedence order
	// (finding #2) — the UI relies on that order to build reorder payloads.
	const allContexts = (projectId?: string): Array<{ scope: InstallScope; projectBase?: string; packOrder?: string[] }> => {
		const effectiveProjectId = normalizeConfigProjectId(projectId);
		const ctxs: Array<{ scope: InstallScope; projectBase?: string; packOrder?: string[] }> = [
			{ scope: "server", packOrder: projectConfigStore.getPackOrder("server") },
			{ scope: "global-user", packOrder: projectConfigStore.getPackOrder("global-user") },
		];
		if (effectiveProjectId) {
			const ctx = projectContextManager.getOrCreate(effectiveProjectId);
			if (ctx) ctxs.push({ scope: "project", projectBase: ctx.project.rootPath, packOrder: ctx.projectConfigStore.getPackOrder("project") });
		}
		return ctxs;
	};

	// ── Managed-runtime activation/consent wiring (P3) ─────────
	// Resolve a pack's SERVER-DERIVED packId + its runtime contributions + the
	// effective deployment config carried by its providers, so the supervisor
	// (start/stop/down) can be addressed by {packId, runtimeId}. Mirrors
	// buildActivationCatalogue's on-disk entry resolution (works for built-in
	// first-party packs too). Returns null when the pack is not resolvable.
	const resolvePackRuntimeContext = (
		scope: InstallScope,
		projectBase: string | undefined,
		store: PackOrderStore,
		packName: string,
	): { packId: string; runtimes: Array<{ id: string; listName: string; manifest: Record<string, unknown> }>; deploymentConfig: Record<string, unknown>; hasDeploymentSurface: boolean } | null => {
		const base = scope === "server" ? headquartersDir() : scope === "global-user" ? os.homedir() : projectBase;
		if (base === undefined) return null;
		const entries = scopeMarketPackEntries(scope as PackScope, base, store.getPackOrder(scope));
		let entry = entries.find((e) => e.manifest?.name === packName);
		if ((!entry || !entry.manifest) && scope === "server") {
			entry = builtinFirstPartyPackEntries(resolveBuiltinPacksDir()).find((e) => e.manifest?.name === packName);
		}
		if (!entry || !entry.manifest) return null;
		const packId = packIdFromRoot(entry.path);
		if (!packId) return null;
		let contribs;
		try { contribs = loadPackContributions(entry.path, entry.manifest); }
		catch { return { packId, runtimes: [], deploymentConfig: {}, hasDeploymentSurface: false }; }
		// Effective deployment config = each provider's FLAT schema defaults
		// (ProviderContribution.config) overlaid with its persisted store config.
		// Hindsight's `memory` provider carries the deployment mode/dataDir/etc.
		const deploymentConfig: Record<string, unknown> = {};
		let hasDeploymentSurface = false;
		for (const p of contribs.providers) {
			const merged: Record<string, unknown> = { ...(p.config ?? {}) };
			const persisted = getPackStore().getSync<Record<string, unknown>>(packId, providerConfigStoreKey(p.id));
			if (persisted && typeof persisted === "object") Object.assign(merged, persisted);
			Object.assign(deploymentConfig, merged);
			if (providerCarriesDeploymentMode(p, merged)) hasDeploymentSurface = true;
		}
		// `hasDeploymentSurface` = the pack exposes a provider whose config ACTUALLY
		// carries the deployment mode (external/managed/…). A runtime-only pack with NO
		// provider — OR a pack whose only provider has no deployment mode — has no
		// external/managed concept, so its `on-enable` runtime starts in the runtime's
		// default mode rather than being suppressed by the external-default start plan
		// (mirrors the REST start path's no-surface fallback so activation and
		// `/api/pack-runtimes/:id/start` never diverge).
		// A runtime's activation ref (`listName`) is its manifest id — pack-contributions
		// enforces `runtime.id === contents.runtimes[] entry`, so the two are identical
		// (the reference's separate `listName` field collapsed into `id` here).
		return { packId, runtimes: contribs.runtimes.map((r) => ({ id: r.id, listName: r.id, manifest: r.manifest })), deploymentConfig, hasDeploymentSurface };
	};

	// ── All-source Browse ─────────────────────────────────────
	// GET /api/marketplace/browse?projectId=<optional>
	if (url.pathname === "/api/marketplace/browse" && req.method === "GET") {
		type BrowseSourceState = {
			sourceId: string;
			sourceName: string;
			sourceType: "builtin" | "pack" | "mcp-gateway" | "mcp-registry";
			builtin?: boolean;
			status: "ok" | "loading" | "error" | "unsupported";
			error?: string;
			lastSyncedAt?: string;
		};
		const sources: BrowseSourceState[] = [];
		const packs: BrowsePack[] = [];
		const builtinPacks = builtinFirstPartyPackEntries(resolveBuiltinPacksDir()).map((e): BrowsePack => ({
			...e.manifest!,
			dirName: e.manifest!.name,
			hasTools: e.manifest!.contents.tools.length > 0,
			builtin: true,
			provided: true,
		} as BrowsePack));
		sources.push({ sourceId: builtinSource.id, sourceName: sourceDisplayName(builtinSource), sourceType: "builtin", builtin: true, status: "ok" });
		packs.push(...builtinPacks.map((pack) => browseRowWithSource(pack, builtinSource)));

		for (const source of sourceStore.list()) {
			const sourceType = sourceTypeForBrowse(source);
			const state: BrowseSourceState = {
				sourceId: source.id,
				sourceName: sourceDisplayName(source),
				sourceType,
				status: "ok",
				...(source.lastSyncedAt ? { lastSyncedAt: source.lastSyncedAt } : {}),
			};
			if (sourceType === "mcp-registry") {
				sources.push({ ...state, status: "unsupported", error: source.unsupportedReason ?? "source type is unsupported" });
				continue;
			}
			try {
				const rows = await installer.browseSourcePacks(source.id);
				const refreshed = sourceStore.get(source.id) ?? source;
				sources.push({ ...state, ...(refreshed.lastSyncedAt ? { lastSyncedAt: refreshed.lastSyncedAt } : {}) });
				packs.push(...rows.map((pack) => browseRowWithSource(pack, refreshed)));
			} catch (err) {
				sources.push({ ...state, status: "error", error: err instanceof Error ? err.message : String(err) });
			}
		}
		json({ sources, packs });
		return;
	}

	// ── Sources ───────────────────────────────────────────────
	// GET /api/marketplace/sources
	if (url.pathname === "/api/marketplace/sources" && req.method === "GET") {
		// Prepend the synthetic, non-removable built-in source (§4.4).
		json({ sources: [builtinSource, ...sourceStore.list()] });
		return;
	}
	// POST /api/marketplace/sources { url, ref?, type? }
	if (url.pathname === "/api/marketplace/sources" && req.method === "POST") {
		const body = await readBody(req);
		const srcUrl = body && typeof (body as any).url === "string" ? (body as any).url.trim() : "";
		if (!srcUrl) { json({ error: "url is required" }, 400); return; }
		if (sourceStore.getByUrl(srcUrl)) { json({ error: `source already registered: ${srcUrl}` }, 409); return; }
		let source;
		try {
			source = sourceStore.add({ url: srcUrl, ref: (body as any).ref, type: (body as any).type });
		} catch (err) { jsonError(400, err); return; }
		try {
			await installer.syncMarketplaceSource(source.id);
		} catch (err) {
			// Roll back the registration if the initial sync/fetch fails.
			sourceStore.remove(source.id);
			handleMarketErr(err);
			return;
		}
		json({ source: sourceStore.get(source.id) }, 201);
		return;
	}
	// /api/marketplace/sources/:id[...]
	const sourceMatch = url.pathname.match(/^\/api\/marketplace\/sources\/([^/]+)(\/sync|\/packs)?$/);
	if (sourceMatch) {
		const id = decodeURIComponent(sourceMatch[1]);
		const sub = sourceMatch[2];
		// Built-in source (§4.4): special-cased BEFORE the 404 check because
		// `sourceStore.get("builtin")` is undefined (never persisted).
		if (id === BUILTIN_SOURCE_ID) {
			if (!sub && req.method === "DELETE") {
				json({ error: "the built-in source cannot be removed" }, 403);
				return;
			}
			if (sub === "/sync" && req.method === "POST") {
				// No-op resync: built-in packs ride the app upgrade.
				json({ source: builtinSource });
				return;
			}
			if (sub === "/packs" && req.method === "GET") {
				// Map the shipped first-party packs to the same browse-row shape
				// `installer.browsePacks` returns, flagged builtin + provided.
				const packs = builtinFirstPartyPackEntries(resolveBuiltinPacksDir()).map((e) => ({
					...e.manifest!,
					dirName: e.manifest!.name,
					hasTools: e.manifest!.contents.tools.length > 0,
					builtin: true,
					provided: true,
				}));
				json({ packs });
				return;
			}
			json({ error: "unsupported built-in source operation" }, 405);
			return;
		}
		if (!isValidSourceId(id) || !sourceStore.get(id)) { json({ error: `unknown source: ${id}` }, 404); return; }

		if (!sub && req.method === "DELETE") {
			sourceStore.remove(id);
			try { fs.rmSync(installer.cacheDirFor(id), { recursive: true, force: true }); } catch { /* ignore */ }
			res.writeHead(204); res.end();
			return;
		}
		if (sub === "/sync" && req.method === "POST") {
			try { await installer.syncMarketplaceSource(id); } catch (err) { handleMarketErr(err); return; }
			json({ source: sourceStore.get(id) });
			return;
		}
		if (sub === "/packs" && req.method === "GET") {
			try { json({ packs: await installer.browseSourcePacks(id) }); } catch (err) { handleMarketErr(err); }
			return;
		}
	}

	// ── Install / update / uninstall ──────────────────────────
	// POST /api/marketplace/install { sourceId, dirName, scope, projectId? }
	// `dirName` is the physical source subdir to read; the installed identity
	// is the pack's `manifest.name` (design §1.4). `packName` is accepted as a
	// back-compat alias for `dirName`.
	if (url.pathname === "/api/marketplace/install" && req.method === "POST") {
		const body = (await readBody(req)) as any;
		const scope = parseScope(body?.scope);
		if (!scope) { json({ error: "invalid scope" }, 400); return; }
		const dirName = typeof body?.dirName === "string" ? body.dirName : (typeof body?.packName === "string" ? body.packName : undefined);
		if (typeof body?.sourceId !== "string" || typeof dirName !== "string") { json({ error: "sourceId and dirName are required" }, 400); return; }
		// Built-in packs are resolved in place; they cannot be copy-installed (§4.4).
		if (body.sourceId === BUILTIN_SOURCE_ID) { json({ error: "built-in packs are provided in place and cannot be installed" }, 403); return; }
		const st = resolveScopeTarget(scope, body?.projectId);
		if (!st.ok) { json({ error: st.error }, st.status); return; }
		try {
			const targetScope = st.target.scope;
			const targetProjectId = targetScope === "project" ? normalizeConfigProjectId(body?.projectId) : undefined;
			const installed = await installer.installMarketplacePack({ sourceId: body.sourceId, dirName, scope: targetScope, projectBase: st.target.projectBase, packOrderStore: st.target.store });
			invalidateResolverCaches();
			const mcpReload = installed.manifest.contents.mcp?.length ? await reloadMcpAfterMarketplaceMutation(targetScope, targetProjectId) : undefined;
			json({ installed, ...(mcpReload ? { mcpReload } : {}) }, 201);
		} catch (err) { handleMarketErr(err); }
		return;
	}
	// POST /api/marketplace/update { scope, packName, projectId? }
	if (url.pathname === "/api/marketplace/update" && req.method === "POST") {
		const body = (await readBody(req)) as any;
		const scope = parseScope(body?.scope);
		if (!scope) { json({ error: "invalid scope" }, 400); return; }
		if (typeof body?.packName !== "string") { json({ error: "packName is required" }, 400); return; }
		// Built-in packs update with the app; a server-scope built-in with no
		// ledger entry has nothing to update (§4.4). A genuine user install of
		// the same name proceeds normally below.
		if (scope === "server" && isBuiltinPackName(body.packName) && !hasUserInstall("server", body.packName, body?.projectId)) {
			json({ error: "built-in packs update with the app; nothing to update" }, 403);
			return;
		}
		const st = resolveScopeTarget(scope, body?.projectId);
		if (!st.ok) { json({ error: st.error }, st.status); return; }
		try {
			const targetScope = st.target.scope;
			const targetProjectId = targetScope === "project" ? normalizeConfigProjectId(body?.projectId) : undefined;
			const prior = installer.listInstalled([{ scope: targetScope, projectBase: st.target.projectBase }]).find((p) => p.scope === targetScope && p.packName === body.packName);
			const hadMcp = (prior?.manifest.contents.mcp?.length ?? 0) > 0;
			const installed = await installer.updateMarketplacePack({ packName: body.packName, scope: targetScope, projectBase: st.target.projectBase, packOrderStore: st.target.store });
			invalidateResolverCaches();
			const hasMcp = (installed.manifest.contents.mcp?.length ?? 0) > 0;
			const mcpReload = hadMcp || hasMcp ? await reloadMcpAfterMarketplaceMutation(targetScope, targetProjectId) : undefined;
			json({ installed, ...(mcpReload ? { mcpReload } : {}) });
		} catch (err) { handleMarketErr(err, 409); }
		return;
	}
	// DELETE /api/marketplace/installed { scope, packName, projectId? }
	if (url.pathname === "/api/marketplace/installed" && req.method === "DELETE") {
		const body = (await readBody(req)) as any;
		const scope = parseScope(body?.scope);
		if (!scope) { json({ error: "invalid scope" }, 400); return; }
		if (typeof body?.packName !== "string") { json({ error: "packName is required" }, 400); return; }
		// Built-in packs are not in the install ledger and cannot be uninstalled
		// (§4.4); only enable/disable applies. A genuine user install of the same
		// name (ledger entry present) proceeds normally below.
		if (isBuiltinPackName(body.packName) && !hasUserInstall(scope, body.packName, body?.projectId)) {
			json({ error: "built-in packs cannot be uninstalled" }, 403);
			return;
		}
		const st = resolveScopeTarget(scope, body?.projectId);
		if (!st.ok) { json({ error: st.error }, st.status); return; }
		// P3 — tear down this pack's managed runtimes BEFORE removing it, preserving
		// bind-mounted data (no `-v`, no state removal). A missing Docker install is
		// tolerated (down returns a docker-unavailable STATUS, never throws), so an
		// uninstall on a Docker-less host still proceeds. A REAL teardown failure (down
		// throws) is reported and the uninstall is ABORTED — never silently swallowed.
		if (packRuntimeSupervisor) {
			const teardownFailures: string[] = [];
			try {
				const rtCtx = resolvePackRuntimeContext(st.target.scope, st.target.projectBase, st.target.store, body.packName);
				if (rtCtx && rtCtx.runtimes.length > 0) {
					const projectId = st.target.scope === "project" ? normalizeConfigProjectId(body?.projectId) : undefined;
					// Tear down EVERY runtime contribution unconditionally — do NOT gate on the
					// CURRENT saved deployment mode (resolveRuntimeStartPlan). A pack started in a
					// managed mode and later reconfigured to `external` would otherwise skip
					// teardown and leak its still-running containers. `down` is read-only/minimal
					// and idempotent (it never resolves start-only inputs like
					// HINDSIGHT_API_LLM_API_KEY, reuses an already-rendered .env only when one
					// exists, and maps a missing Docker install to a docker-unavailable STATUS
					// rather than throwing), so calling it for an external-only never-started
					// runtime is a harmless no-op (`compose down` on an absent project exits 0).
					for (const rc of rtCtx.runtimes) {
						try {
							await packRuntimeSupervisor.down(rtCtx.packId, rc.id, { projectId, volumes: false, removeState: false });
						} catch (err) {
							teardownFailures.push(`${rtCtx.packId}:${rc.id}: ${(err as Error)?.message ?? String(err)}`);
						}
					}
				}
			} catch (err) {
				// Resolving the pack's runtime context failed (e.g. the pack is no longer
				// resolvable on disk) — there is nothing to tear down; proceed.
				console.warn(`[pack-runtimes] uninstall runtime teardown skipped: ${(err as Error)?.message ?? err}`);
			}
			if (teardownFailures.length > 0) {
				json({ error: "runtime teardown failed; pack not uninstalled", details: teardownFailures }, 502);
				return;
			}
		}
		try {
			const targetScope = st.target.scope;
			const targetProjectId = targetScope === "project" ? normalizeConfigProjectId(body?.projectId) : undefined;
			const prior = installer.listInstalled([{ scope: targetScope, projectBase: st.target.projectBase }]).find((p) => p.scope === targetScope && p.packName === body.packName);
			installer.uninstallPack({ packName: body.packName, scope: targetScope, projectBase: st.target.projectBase, packOrderStore: st.target.store });
			invalidateResolverCaches();
			if (prior?.manifest.contents.mcp?.length) await reloadMcpAfterMarketplaceMutation(targetScope, targetProjectId);
			res.writeHead(204); res.end();
		} catch (err) { handleMarketErr(err, 404); }
		return;
	}
	// GET /api/marketplace/installed?projectId=
	if (url.pathname === "/api/marketplace/installed" && req.method === "GET") {
		const projectId = url.searchParams.get("projectId") || undefined;
		try {
			// Prepend synthetic built-in pack rows (§6.4): a distinct non-install
			// row kind (no meta/ledger entry) flagged `builtin: true`. A
			// user-installed same-name pack still appears as its own ledger row.
			const builtinRows = builtinFirstPartyPackEntries(resolveBuiltinPacksDir()).map((e) => ({
				scope: "server" as InstallScope,
				packName: e.manifest!.name,
				manifest: e.manifest!,
				meta: e.meta,
				status: "ok" as const,
				builtin: true,
				// Built-in packs ship with the app: no upstream source to check, never
				// "update available" (they update with the app upgrade, §4.2).
				updateAvailable: false,
				sourceStatus: "ok" as const,
				// Default-disabled built-in packs (manifest `defaultDisabled: true`, e.g.
				// Hindsight) surface a stable wire field the Marketplace UI keys on
				// (`defaultDisabled`) and the UI intent alias (`requiresGuidedSetup`) so the
				// guided-setup wizard routes an explicit enable through configuration first.
				defaultDisabled: e.manifest!.defaultDisabled === true,
				requiresGuidedSetup: e.manifest!.defaultDisabled === true,
			}));
			json({ installed: [...builtinRows, ...installer.listInstalled(allContexts(projectId))] });
		} catch (err) { jsonError(500, err); }
		return;
	}

	// ── pack-order (§9.2) ─────────────────────────────────────
	if (url.pathname === "/api/marketplace/pack-order" && req.method === "GET") {
		const scope = parseScope(url.searchParams.get("scope"));
		if (!scope) { json({ error: "invalid scope" }, 400); return; }
		const projectId = url.searchParams.get("projectId") || undefined;
		const st = resolveScopeTarget(scope, projectId);
		if (!st.ok) { json({ error: st.error }, st.status); return; }
		const targetScope = st.target.scope;
		json({ scope: targetScope, order: st.target.store.getPackOrder(targetScope) });
		return;
	}
	if (url.pathname === "/api/marketplace/pack-order" && req.method === "PUT") {
		const body = (await readBody(req)) as any;
		const scope = parseScope(body?.scope);
		if (!scope) { json({ error: "invalid scope" }, 400); return; }
		if (!Array.isArray(body?.order) || !body.order.every((x: unknown) => typeof x === "string")) { json({ error: "order must be a string array" }, 400); return; }
		const st = resolveScopeTarget(scope, body?.projectId);
		if (!st.ok) { json({ error: st.error }, st.status); return; }
		const targetScope = st.target.scope;
		const targetProjectId = targetScope === "project" ? normalizeConfigProjectId(body?.projectId) : undefined;
		// Normalize: drop names not installed at this scope; append on-disk-but-absent
		// packs at lowest priority (front), preserving the requested order otherwise.
		const installedNames = installer.listInstalled([{ scope: targetScope, projectBase: st.target.projectBase }])
			.filter((p) => p.scope === targetScope && p.status !== "corrupt")
			.map((p) => p.packName);
		const installedSet = new Set(installedNames);
		const filtered = (body.order as string[]).filter((n) => installedSet.has(n));
		const missing = installedNames.filter((n) => !filtered.includes(n));
		const normalized = [...missing, ...filtered];
		st.target.store.setPackOrder(targetScope, normalized);
		invalidateResolverCaches();
		const hasMcp = installer.listInstalled([{ scope: targetScope, projectBase: st.target.projectBase }]).some((p) => p.scope === targetScope && (p.manifest.contents.mcp?.length ?? 0) > 0);
		const mcpReload = hasMcp ? await reloadMcpAfterMarketplaceMutation(targetScope, targetProjectId) : undefined;
		json({ scope: targetScope, order: normalized, ...(mcpReload ? { mcpReload } : {}) });
		return;
	}

	// ── pack-activation (pack-schema-v1 §6.7) ──────────────────
	// The `catalogue` is the UNFILTERED authoritative source for the Market UI
	// toggles: read straight from the INSTALLED pack's pack.yaml manifest
	// contents (NOT from the runtime-filtered /api/tools or /api/ext/contributions),
	// so a disabled entity still appears and can be re-enabled. `disabled` is the
	// current pack_activation override; checked = name ∉ disabled[kind].
	type PackActivationMcpOperationEntry = {
		name: string;
		label?: string;
		description?: string;
		toolName?: string;
		policyKey: string;
		selected: boolean;
		disabledByActivation: boolean;
		inputSchema?: unknown;
	};
	const mcpPolicyKey = (serverName: string, subNamespace: string | undefined, operationName?: string): string => {
		const parts = ["mcp", serverName];
		if (subNamespace) parts.push(subNamespace);
		if (operationName) parts.push(operationName);
		return parts.join("__");
	};
	const activationMcpRef = (entry: PackEntry, mcp: ResolvedMcpContribution | { listName: string; serverName: string; subNamespace?: string; config?: any; sourceFile?: string }, metaDetails: Record<string, unknown>): string => {
		return activationMcpContributionId(entry, mcp, metaDetails, sourceStore.getByUrl(String(entry.meta?.sourceUrl ?? ""))?.id);
	};
	const operationsForMcp = (mcp: { listName: string; sourceFile?: string; operationMetadata?: unknown }, metaDetails: Record<string, unknown>): ReturnType<typeof operationMetadataForMcpContribution> => {
		return operationMetadataForMcpContribution(mcp, metaDetails);
	};
	const runtimeOperationsForMcp = (
		mcp: { listName: string; serverName: string; subNamespace?: string },
		contributionId: string,
		routes: McpToolRouteSnapshot[],
	): ReturnType<typeof operationMetadataForMcpContribution> => {
		const out: ReturnType<typeof operationMetadataForMcpContribution> = [];
		const seen = new Set<string>();
		for (const route of routes) {
			const routeContributionId = safeString(route.contributionId);
			const routeListName = safeString(route.listName);
			const routeServerName = safeString(route.serverName ?? route.publicServerName);
			const routeSubNamespace = safeString(route.subNamespace);
			const belongsToContribution = routeContributionId
				? routeContributionId === contributionId
				: routeListName === mcp.listName && routeServerName === mcp.serverName && routeSubNamespace === mcp.subNamespace;
			if (!belongsToContribution) continue;
			const parsed = typeof route.name === "string" ? parseMcpToolName(route.name) : undefined;
			const rawName = safeString(route.mcpToolName);
			const name = parsed?.sub && parsed.sub === mcp.subNamespace && parsed.op ? parsed.op : rawName;
			if (!name || seen.has(name)) continue;
			seen.add(name);
			out.push({
				name,
				...(safeString(route.description) ? { description: safeString(route.description) } : {}),
				...(route.inputSchema !== undefined ? { inputSchema: route.inputSchema } : {}),
			});
		}
		return out;
	};

	const buildActivationCatalogue = (
		scope: InstallScope,
		projectBase: string | undefined,
		store: PackOrderStore,
		packName: string,
		projectId?: string,
	): { roles: string[]; tools: string[]; skills: string[]; entrypoints: Array<{ listName: string; label?: string; kind?: "composer-slash" | "session-menu" | "route"; routeId?: string }>; providers?: string[]; hooks?: string[]; mcp?: Array<string | Record<string, unknown>>; piExtensions?: Array<string | Record<string, unknown>>; runtimes?: string[]; workflows?: string[]; descriptions: PackEntityDescriptions } | null => {
		const base = scope === "server" ? headquartersDir() : scope === "global-user" ? os.homedir() : projectBase;
		if (base === undefined) return null;
		const entries = scopeMarketPackEntries(scope as PackScope, base, store.getPackOrder(scope));
		let entry = entries.find((e) => e.manifest?.name === packName);
		// Built-in first-party packs (§7.4) have NO install-ledger entry but ARE
		// toggleable at server scope — resolve their catalogue from the built-in band.
		if ((!entry || !entry.manifest) && scope === "server") {
			entry = builtinFirstPartyPackEntries(resolveBuiltinPacksDir()).find((e) => e.manifest?.name === packName);
		}
		if (!entry || !entry.manifest) return null;
		const c = entry.manifest.contents;
		const metaDetails = readYamlMapping(path.join(entry.path, ".pack-meta.yaml")) ?? {};
		const activationStore = store as unknown as ProjectConfigStore;
		const currentDisabled = activationStore.getPackActivation?.(scope as PackOrderScope, packName) ?? {};
		const disabledMcpRefs = new Set(currentDisabled.mcp ?? []);
		const disabledMcpOperations = currentDisabled.mcpOperations ?? {};
		const concreteTools = readConcretePackToolsFromGroups(entry.path, c.tools);
		const descriptions = readPackEntityDescriptions(entry.path, entry.manifest);
		if (Object.keys(concreteTools.descriptions).length > 0) {
			descriptions.tools = concreteTools.descriptions;
		} else {
			delete descriptions.tools;
		}
		// Valid entrypoint display metadata from the entrypoint files. Invalid or
		// unsupported entrypoint kinds are omitted so retired launch surfaces do not
		// render as activation toggles.
		const entrypointByListName = new Map<string, { label?: string; kind: "composer-slash" | "session-menu" | "route"; routeId?: string }>();
		const mcpByListName = new Map<string, Record<string, unknown>>();
		const piExtensionByListName = new Map<string, Record<string, unknown>>();
		try {
			const contributions = loadPackContributions(entry.path, entry.manifest);
			for (const ep of contributions.entrypoints) {
				entrypointByListName.set(ep.listName, { label: ep.label, kind: ep.kind, routeId: ep.routeId });
			}
			const mcpManager = scope === "project" ? sessionManager.getMcpManager({ projectId }) : sessionManager.getMcpManager();
			const statuses = mcpManager?.getServerStatuses() ?? [];
			const runtimeRoutes = mcpManager?.getToolRouteSnapshots?.() ?? [];
			for (const mcp of contributions.mcp ?? []) {
				const transport = mcp.config.url ? "http" : "stdio";
				const contributionId = activationMcpRef(entry, mcp, metaDetails);
				const status = statuses.find((s) => s.ownerContributions?.some((c) => c.contributionId === contributionId || (c.listName === mcp.listName && c.origin.packName === entry.manifest!.name && c.origin.scope === entry.scope)))
					?? statuses.find((s) => s.name === mcp.serverName);
				const owner = status?.ownerContributions?.find((c) => c.contributionId === contributionId || (c.listName === mcp.listName && c.origin.packName === entry.manifest!.name && c.origin.scope === entry.scope));
				const overriddenBy = status && !owner
					? (status.origin?.scope === "manual" ? "overridden-by-manual" : "overridden-by-marketplace")
					: undefined;
				const disabledOps = [...new Set(disabledMcpOperations[contributionId] ?? [])];
				const disabledOpsSet = new Set(disabledOps);
				const staticOperationMetadata = operationsForMcp(mcp, metaDetails);
				const operationMetadata = staticOperationMetadata.length > 0
					? staticOperationMetadata
					: runtimeOperationsForMcp(mcp, contributionId, runtimeRoutes);
				const knownOperationNames = new Set(operationMetadata.map((op) => op.name));
				const operations = operationMetadata.map((op): PackActivationMcpOperationEntry => {
					const policyKey = mcpPolicyKey(mcp.serverName, mcp.subNamespace, op.name);
					return {
						name: op.name,
						...(op.label ? { label: op.label } : {}),
						...(op.description ? { description: op.description } : {}),
						...(op.inputSchema !== undefined ? { inputSchema: op.inputSchema } : {}),
						toolName: policyKey,
						policyKey,
						selected: !disabledOpsSet.has(op.name),
						disabledByActivation: disabledOpsSet.has(op.name),
					};
				});
				const staleDisabledOperations = disabledOps.filter((name) => !knownOperationNames.has(name));
				mcpByListName.set(mcp.listName, {
					ref: mcp.listName,
					contributionId,
					listName: mcp.listName,
					serverName: mcp.serverName,
					policyKey: mcpPolicyKey(mcp.serverName, mcp.subNamespace),
					selected: !disabledMcpRefs.has(contributionId) && !disabledMcpRefs.has(mcp.listName),
					...(safeString(metaDetails.sourceId) ? { sourceId: safeString(metaDetails.sourceId) } : {}),
					...(entry.manifest?.name ? { installedPackName: entry.manifest.name } : {}),
					...(safeString(metaDetails.gatewayProviderId) ? { gatewayProviderId: safeString(metaDetails.gatewayProviderId) } : {}),
					...(mcp.subNamespace ? { subNamespace: mcp.subNamespace } : {}),
					...(mcp.label ? { label: mcp.label } : {}),
					...(mcp.description ? { description: mcp.description } : {}),
					transport,
					...(mcp.config.command ? { command: mcp.config.command } : {}),
					...(mcp.config.args ? { args: mcp.config.args } : {}),
					...(mcp.config.cwd ? { cwd: mcp.config.cwd } : {}),
					...(mcp.config.env ? { env: Object.keys(mcp.config.env) } : {}),
					...(mcp.config.url ? { url: mcp.config.url } : {}),
					...(mcp.config.headers ? { headers: Object.keys(mcp.config.headers) } : {}),
					...(status ? { status: status.status, ownerStatus: overriddenBy ?? (owner ? status.status : status.status), toolCount: operations.length > 0 ? operations.filter((op) => op.selected).length : status.toolCount } : {}),
					...(operations.length > 0 ? { operations, selectedOperationCount: operations.filter((op) => op.selected).length, totalOperationCount: operations.length } : { selectedOperationCount: undefined, totalOperationCount: undefined }),
					...(disabledOps.length > 0 ? { disabledOperations: disabledOps } : {}),
					...(staleDisabledOperations.length > 0 ? { staleDisabledOperations } : {}),
					...(overriddenBy ? { ownerStatus: overriddenBy, overriddenBy: status?.origin?.packName ?? status?.origin?.scope } : {}),
					...(status?.error ? { error: status.error } : {}),
				});
				if (mcp.description) {
					descriptions.mcp = { ...(descriptions.mcp ?? {}), [mcp.listName]: mcp.description };
				}
			}
		} catch { /* metadata is optional; listName is the stable key */ }
		try {
			const resolvedPiExtensions = sessionManager.resolveMarketplacePiExtensionContributions(projectId)
				.filter((piExtension) => piExtension.origin.scope === entry.scope && piExtension.origin.packName === entry.manifest!.name);
			const piExtensions = resolvedPiExtensions.length > 0 ? resolvedPiExtensions : loadPiExtensionContributionsFromRuntime(entry.path, entry.manifest);
			const disabledPiExtensions = new Set(((store as unknown as ProjectConfigStore).getPackActivation?.(scope as PackOrderScope, packName).piExtensions) ?? []);
			for (const piExtension of piExtensions) {
				const diagnostic = disabledPiExtensions.has(piExtension.listName)
					? piExtensionDiagnostic("disabled", "disabled_by_activation", `Pi extension "${piExtension.listName}" is disabled for pack "${entry.manifest.name}".`)
					: piExtension.diagnostic;
				piExtensionByListName.set(piExtension.listName, {
					ref: piExtension.listName,
					listName: piExtension.listName,
					...(piExtension.entryRelativePath ? { entryRelativePath: piExtension.entryRelativePath } : {}),
					diagnostic,
					tools: (piExtension.discovery?.tools ?? []).map((tool) => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}) })),
				});
			}
		} catch { /* pi extension metadata is optional; listName is the stable key */ }
		const baseCatalogue = {
			roles: [...c.roles],
			tools: concreteTools.tools,
			skills: [...c.skills],
			entrypoints: (c.entrypoints ?? []).flatMap((listName) => {
				const meta = entrypointByListName.get(listName);
				return meta ? [{ listName, ...meta }] : [];
			}),
			// One-line per-entity descriptions for the activation disclosure (R3).
			// Read from the SAME installed pack dir as the catalogue above — never
			// from the runtime-filtered /api/tools or /api/ext/contributions.
			descriptions,
		};
		if ((entry.manifest.schema ?? 1) < 2) return baseCatalogue;
		// `hooks` and `workflows` are deliberately OMITTED (finding EXT-03): neither
		// is activation-toggleable — `hooks` was removed as a contribution kind
		// entirely, and `workflows` is reserved-but-not-loadable. Echoing them here
		// would resurrect the phantom Market UI toggle the finding fixed.
		return {
			roles: baseCatalogue.roles,
			tools: baseCatalogue.tools,
			skills: baseCatalogue.skills,
			entrypoints: baseCatalogue.entrypoints,
			providers: [...(c.providers ?? [])],
			mcp: (c.mcp ?? []).map((listName) => mcpByListName.get(listName) ?? listName),
			piExtensions: (c.piExtensions ?? []).map((listName) => piExtensionByListName.get(listName) ?? listName),
			runtimes: [...(c.runtimes ?? [])],
			descriptions,
		};
	};
	const mcpContributionLookup = (catalogue: { mcp?: Array<string | Record<string, unknown>> }): Map<string, string> => {
		const out = new Map<string, string>();
		for (const entry of catalogue.mcp ?? []) {
			if (typeof entry === "string") {
				out.set(entry, entry);
				continue;
			}
			const contributionId = safeString(entry.contributionId) ?? safeString(entry.ref) ?? safeString(entry.listName);
			if (!contributionId) continue;
			for (const alias of [entry.contributionId, entry.ref, entry.listName, entry.legacyRef]) {
				const key = safeString(alias);
				if (key) out.set(key, contributionId);
			}
		}
		return out;
	};
	const packActivationRevision = (disabled: unknown): string =>
		`act:${createHash("sha256").update(JSON.stringify(disabled ?? {})).digest("hex").slice(0, 16)}`;
	if (url.pathname === "/api/marketplace/pack-activation" && req.method === "GET") {
		const scope = parseScope(url.searchParams.get("scope"));
		if (!scope) { json({ error: "invalid scope" }, 400); return; }
		const projectId = url.searchParams.get("projectId") || undefined;
		const packName = url.searchParams.get("packName") || "";
		if (!packName) { json({ error: "packName is required" }, 400); return; }
		const st = resolveScopeTarget(scope, projectId);
		if (!st.ok) { json({ error: st.error }, st.status); return; }
		const targetScope = st.target.scope;
		const targetProjectId = targetScope === "project" ? normalizeConfigProjectId(projectId) : undefined;
		const catalogue = buildActivationCatalogue(targetScope, st.target.projectBase, st.target.store, packName, targetProjectId);
		if (!catalogue) { json({ error: "pack not installed at this scope" }, 404); return; }
		const cfgStore = st.target.store as unknown as ProjectConfigStore;
		const disabled = cfgStore.getPackActivation(targetScope as PackOrderScope, packName);
		json({ scope: targetScope, packName, catalogue, disabled, revision: packActivationRevision(disabled) });
		return;
	}
	if (url.pathname === "/api/marketplace/pack-activation" && req.method === "PUT") {
		const body = (await readBody(req)) as any;
		const scope = parseScope(body?.scope);
		if (!scope) { json({ error: "invalid scope" }, 400); return; }
		const packName = typeof body?.packName === "string" ? body.packName : "";
		if (!packName) { json({ error: "packName is required" }, 400); return; }
		const st = resolveScopeTarget(scope, body?.projectId);
		if (!st.ok) { json({ error: st.error }, st.status); return; }
		const targetScope = st.target.scope;
		const targetProjectId = targetScope === "project" ? normalizeConfigProjectId(body?.projectId) : undefined;
		const catalogue = buildActivationCatalogue(targetScope, st.target.projectBase, st.target.store, packName, targetProjectId);
		if (!catalogue) { json({ error: "pack not installed at this scope" }, 404); return; }
		// Normalize the requested disabled refs against the pack's declared
		// catalogue (drop refs for entities the pack does not declare).
		const reqDisabled = (body?.disabled ?? {}) as Record<string, unknown>;
		const catalogueEntrypointNames = new Set(catalogue.entrypoints.map((e) => e.listName));
		const mcpLookup = mcpContributionLookup(catalogue);
		const catalogueMcpContributionIds = new Set(mcpLookup.values());
		const cfgStore = st.target.store as unknown as ProjectConfigStore;
		const beforeActivation = cfgStore.getPackActivation(targetScope as PackOrderScope, packName);
		const cataloguePiExtensionNames = normalisePiExtensionCatalogueRefs(catalogue.piExtensions);
		const normaliseKind = (kind: "roles" | "tools" | "skills" | "entrypoints" | "providers" | "mcp" | "piExtensions" | "runtimes", valid: Set<string>): string[] => {
			const raw = reqDisabled[kind];
			if (!Array.isArray(raw)) return [];
			return raw.filter((x): x is string => typeof x === "string" && valid.has(x));
		};
		const normalizeMcpRefs = (): string[] => {
			const raw = reqDisabled.mcp;
			if (!Array.isArray(raw)) return [];
			return [...new Set(raw.flatMap((x) => typeof x === "string" ? [mcpLookup.get(x) ?? ""] : []).filter((x) => x && catalogueMcpContributionIds.has(x)))];
		};
		const normalizeMcpOperationsForCatalogue = (): Record<string, string[]> | undefined => {
			const raw = reqDisabled.mcpOperations;
			const source = raw === undefined ? beforeActivation.mcpOperations : raw;
			if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
			const out: Record<string, string[]> = {};
			for (const [rawContributionId, rawOps] of Object.entries(source)) {
				const contributionId = mcpLookup.get(rawContributionId) ?? rawContributionId;
				if (!catalogueMcpContributionIds.has(contributionId) || !Array.isArray(rawOps)) continue;
				const ops = [...new Set(rawOps.filter((x): x is string => typeof x === "string" && x.length > 0))];
				if (ops.length > 0) out[contributionId] = ops;
			}
			return Object.keys(out).length > 0 ? out : undefined;
		};
		// `hooks`/`workflows` are deliberately excluded (finding EXT-03): neither is
		// activation-toggleable, so a PUT body carrying either is silently dropped
		// (never persisted, never echoed back) rather than resurrecting the phantom
		// toggle.
		const normalized = {
			roles: normaliseKind("roles", new Set(catalogue.roles)),
			tools: normaliseKind("tools", new Set(catalogue.tools)),
			skills: normaliseKind("skills", new Set(catalogue.skills)),
			entrypoints: normaliseKind("entrypoints", catalogueEntrypointNames),
			providers: normaliseKind("providers", new Set(catalogue.providers ?? [])),
			mcp: normalizeMcpRefs(),
			mcpOperations: normalizeMcpOperationsForCatalogue(),
			piExtensions: normaliseKind("piExtensions", cataloguePiExtensionNames),
			runtimes: normaliseKind("runtimes", new Set(catalogue.runtimes ?? [])),
		};
		// P3 — managed-runtime activation side effects. Enabling a
		// `startPolicy: on-enable` runtime (disabled → enabled) IS the explicit
		// user start action; disabling (enabled → disabled) stops it. The external
		// (non-Docker) deployment mode never starts a container. Toggling any other
		// entity — or a pack with no runtimes — is inert here, so install/update/
		// list/status never start Docker.
		//
		// CRITICAL ordering: the Docker side effects run BEFORE the activation state
		// is persisted, and a side effect that MATTERS (start/stop throwing, or a
		// start that fails to come up) aborts the whole PUT WITHOUT persisting — so
		// Bobbit never records "enabled"/"disabled" while Docker did the opposite. A
		// graceful `docker-unavailable` status is TOLERATED (there is nothing to
		// start/stop on a Docker-less host; the provider is defensive and the toggle
		// is just metadata), so it persists and is reported, not treated as a hard
		// failure. Stop is best-effort: only a thrown stop blocks a disable.
		const prevDisabledRuntimes = new Set(beforeActivation.runtimes ?? []);
		const runtimeStatuses: Array<Record<string, unknown>> = [];
		const sideEffectFailures: string[] = [];
		if (packRuntimeSupervisor && (catalogue.runtimes?.length ?? 0) > 0) {
			const nextDisabledRuntimes = new Set(normalized.runtimes);
			const rtCtx = resolvePackRuntimeContext(targetScope, st.target.projectBase, st.target.store, packName);
			if (rtCtx && rtCtx.runtimes.length > 0) {
				const runtimeProjectId = targetScope === "project" ? targetProjectId : undefined;
				for (const rc of rtCtx.runtimes) {
					// Plan is resolved PER RUNTIME from that runtime's OWN manifest — its
					// declarative `deploymentModes`/`configRemap` (see
					// src/server/runtime/manifest.ts) turns the pack's deployment config
					// into supervisor start args; same source of truth the REST
					// start/restart/capabilities routes use.
					const plan = resolveRuntimeStartPlan(rtCtx.deploymentConfig, rc.manifest);
					// A runtime-only pack with NO provider deployment-config surface has no
					// external/managed concept, so resolveRuntimeStartPlan({}) defaults to
					// external (start:false) and would wrongly suppress its `on-enable` start.
					// Mirror the REST start path's no-surface fallback: enabling such a runtime
					// starts it in the runtime's DEFAULT mode (mode undefined ⇒ supervisor picks
					// the manifest default). When a deployment surface exists, honour plan.start.
					const startWhenEnabled = plan.start || !rtCtx.hasDeploymentSurface;
					const startMode = rtCtx.hasDeploymentSurface ? plan.mode : undefined;
					const ref = rc.listName;
					const wasDisabled = prevDisabledRuntimes.has(ref);
					const nowDisabled = nextDisabledRuntimes.has(ref);
					const policy = readRuntimeStartPolicy(rc.manifest);
					try {
						if (wasDisabled && !nowDisabled) {
							// disabled → enabled: explicit enable. Only `on-enable` runtimes
							// auto-start, and only when the deployment mode is a managed
							// (Docker) mode — external mode avoids the Docker start entirely.
							// A provider-less runtime pack has no such gate (startWhenEnabled).
							if (policy === "on-enable" && startWhenEnabled) {
								const status = await packRuntimeSupervisor.start(rtCtx.packId, rc.id, { projectId: runtimeProjectId, mode: startMode, config: plan.config });
								runtimeStatuses.push({ ...status, id: encodePackRuntimeId(status.packId, status.runtimeId) });
								// A managed enable that does not come up running (and is not a
								// tolerated docker-unavailable) is a real failure: don't persist
								// "enabled" while the container is unhealthy/down.
								if (status.status !== "running" && status.status !== "starting" && status.status !== "docker-unavailable") {
									sideEffectFailures.push(`${rtCtx.packId}:${rc.id} failed to start (${status.status}${status.message ? `: ${status.message}` : ""})`);
								}
							}
						} else if (!wasDisabled && nowDisabled) {
							// enabled → disabled: stop the managed container UNCONDITIONALLY — do NOT
							// gate on the CURRENT saved deployment mode (plan.start). A runtime started
							// in a managed mode and later reconfigured to `external` would otherwise
							// skip the stop and leak its still-running container. `stop` is
							// read-only/minimal and idempotent: it never resolves start-only inputs
							// (e.g. HINDSIGHT_API_LLM_API_KEY), reuses an already-rendered .env only
							// when one exists, and maps a missing Docker install to a
							// docker-unavailable STATUS rather than throwing — so calling it for an
							// external-only never-started runtime is a harmless no-op (`compose stop`
							// on an absent project exits 0) and never 502s the disable.
							const status = await packRuntimeSupervisor.stop(rtCtx.packId, rc.id, { projectId: runtimeProjectId });
							runtimeStatuses.push({ ...status, id: encodePackRuntimeId(status.packId, status.runtimeId) });
						}
					} catch (err) {
						// A thrown start/stop (e.g. compose up/stop exploded) is a hard
						// failure: abort the PUT so persisted state matches Docker reality.
						runtimeStatuses.push({
							id: encodePackRuntimeId(rtCtx.packId, rc.id),
							packId: rtCtx.packId,
							runtimeId: rc.id,
							status: "error",
							message: (err as Error)?.message ?? String(err),
						});
						sideEffectFailures.push(`${rtCtx.packId}:${rc.id}: ${(err as Error)?.message ?? String(err)}`);
					}
				}
			}
		}

		// A side effect that matters failed → do NOT persist (state is unchanged) and
		// surface the failure with the prior activation so the client/UI reverts the
		// toggle instead of believing the change took effect.
		if (sideEffectFailures.length > 0) {
			json({
				scope: targetScope,
				packName,
				catalogue,
				disabled: beforeActivation,
				runtimes: runtimeStatuses,
				error: `runtime activation failed: ${sideEffectFailures.join("; ")}`,
			}, 502);
			return;
		}

		const before = beforeActivation.mcp ?? [];
		const beforeOps = beforeActivation.mcpOperations ?? {};
		cfgStore.setPackActivation(targetScope as PackOrderScope, packName, normalized);
		// Default-disabled built-in packs (e.g. Hindsight): maintain the explicit
		// force-enabled marker so an explicit ENABLE persists. Enabling clears all
		// disabled refs (an empty record — indistinguishable from "never touched",
		// which the default-disabled overlay would otherwise re-disable), so we record
		// the pack name in a marker that the overlay honours. Disabling-all (or any
		// partial disable) drops the marker; the persisted record then wins verbatim.
		// Only server-scope built-in packs are default-disabled, so this is inert for
		// everything else.
		if (targetScope === "server" && getDefaultDisabledInfo(packName, cfgStore) !== null) {
			const nowAllEnabled = [
				normalized.roles, normalized.tools, normalized.skills, normalized.entrypoints,
				normalized.providers, normalized.mcp, normalized.piExtensions, normalized.runtimes,
			].every((refs) => refs.length === 0) && !normalized.mcpOperations;
			const marker = readForceEnabledPacks(cfgStore);
			if (nowAllEnabled) marker.add(packName);
			else marker.delete(packName);
			writeForceEnabledPacks(cfgStore, marker);
		}
		invalidateResolverCaches();
		const mcpChanged = JSON.stringify([...before].sort()) !== JSON.stringify([...normalized.mcp].sort()) || JSON.stringify(beforeOps) !== JSON.stringify(normalized.mcpOperations ?? {});
		const mcpReload = mcpChanged ? await reloadMcpAfterMarketplaceMutation(targetScope, targetProjectId) : undefined;
		const refreshedCatalogue = mcpChanged ? buildActivationCatalogue(targetScope, st.target.projectBase, st.target.store, packName, targetProjectId) ?? catalogue : catalogue;
		const nextDisabled = cfgStore.getPackActivation(targetScope as PackOrderScope, packName);
		json({ scope: targetScope, packName, catalogue: refreshedCatalogue, disabled: nextDisabled, revision: packActivationRevision(nextDisabled), ...(runtimeStatuses.length > 0 ? { runtimes: runtimeStatuses } : {}), ...(mcpReload ? { mcpReload } : {}) });
		return;
	}

	// ── purge a managed runtime (P3 explicit purge) ───────────
	// POST /api/marketplace/purge-runtime { packName, scope, runtimeId, projectId? }
	//   `compose down -v` + remove supervisor-owned runtime state (rendered env,
	//   persisted generated secrets + allocated ports). Bind-mounted DATA is
	//   preserved by the supervisor — only Docker volumes + bookkeeping are removed.
	if (url.pathname === "/api/marketplace/purge-runtime" && req.method === "POST") {
		const body = (await readBody(req)) as any;
		const scope = parseScope(body?.scope);
		if (!scope) { json({ error: "invalid scope" }, 400); return; }
		if (typeof body?.packName !== "string" || !body.packName) { json({ error: "packName is required" }, 400); return; }
		if (typeof body?.runtimeId !== "string" || !body.runtimeId) { json({ error: "runtimeId is required" }, 400); return; }
		if (!packRuntimeSupervisor) { json({ error: "pack runtime supervisor unavailable" }, 503); return; }
		const st = resolveScopeTarget(scope, body?.projectId);
		if (!st.ok) { json({ error: st.error }, st.status); return; }
		const rtCtx = resolvePackRuntimeContext(st.target.scope, st.target.projectBase, st.target.store, body.packName);
		if (!rtCtx) { json({ error: "pack not installed at this scope" }, 404); return; }
		const rc = rtCtx.runtimes.find((r) => r.id === body.runtimeId || r.listName === body.runtimeId);
		if (!rc) { json({ error: `unknown runtime ${body.runtimeId}` }, 404); return; }
		const projectId = st.target.scope === "project" ? normalizeConfigProjectId(body?.projectId) : undefined;
		try {
			const status = await packRuntimeSupervisor.down(rtCtx.packId, rc.id, { projectId, volumes: true, removeState: true });
			json({ ...status, id: encodePackRuntimeId(status.packId, status.runtimeId) });
		} catch (err) {
			if (err instanceof PackRuntimeNotFoundError) { jsonError(404, err); return; }
			if (err instanceof PackRuntimeBadRequestError) { jsonError(400, err); return; }
			jsonError(500, err);
		}
		return;
	}

	if (url.pathname === "/api/marketplace/pack-activation/mcp-operation" && req.method === "PATCH") {
		const body = (await readBody(req)) as any;
		const scope = parseScope(body?.scope);
		if (!scope) { json({ error: "invalid scope" }, 400); return; }
		const contributionId = typeof body?.contributionId === "string" ? body.contributionId : "";
		const operationName = typeof body?.operationName === "string" ? body.operationName : "";
		if (!contributionId || !operationName) { json({ error: "contributionId and operationName are required" }, 400); return; }
		if (typeof body?.disabled !== "boolean") { json({ error: "disabled must be boolean" }, 400); return; }
		const st = resolveScopeTarget(scope, body?.projectId);
		if (!st.ok) { json({ error: st.error }, st.status); return; }
		const targetScope = st.target.scope;
		const targetProjectId = targetScope === "project" ? normalizeConfigProjectId(body?.projectId) : undefined;
		let matchedPackName = "";
		let matchedCatalogue: ReturnType<typeof buildActivationCatalogue> = null;
		let matchedEntry: Record<string, unknown> | undefined;
		for (const installed of installer.listInstalled([{ scope: targetScope, projectBase: st.target.projectBase }])) {
			if (installed.scope !== targetScope || installed.status === "corrupt") continue;
			const catalogue = buildActivationCatalogue(targetScope, st.target.projectBase, st.target.store, installed.packName, targetProjectId);
			if (!catalogue) continue;
			const lookup = mcpContributionLookup(catalogue);
			if (lookup.get(contributionId) === contributionId) {
				matchedPackName = installed.packName;
				matchedCatalogue = catalogue;
				matchedEntry = (catalogue.mcp ?? []).find((entry): entry is Record<string, unknown> => {
					if (typeof entry === "string") return entry === contributionId;
					return mcpContributionLookup({ mcp: [entry] }).get(contributionId) === contributionId;
				}) as Record<string, unknown> | undefined;
				break;
			}
		}
		if (!matchedPackName || !matchedCatalogue) { json({ error: "unknown MCP contribution for scope" }, 404); return; }
		const cfgStore = st.target.store as unknown as ProjectConfigStore;
		const current = cfgStore.getPackActivation(targetScope as PackOrderScope, matchedPackName);
		const currentRevision = packActivationRevision(current);
		if (typeof body?.expectedRevision === "string" && body.expectedRevision !== currentRevision) {
			json({ error: "stale activation revision", code: "STALE_REVISION", scope: targetScope, packName: matchedPackName, contributionId, operationName, disabled: current, catalogue: matchedCatalogue, revision: currentRevision }, 409);
			return;
		}
		const operationRows = Array.isArray(matchedEntry?.operations) ? matchedEntry.operations.filter((op): op is Record<string, unknown> => !!op && typeof op === "object" && !Array.isArray(op)) : [];
		const knownOperationNames = new Set(operationRows.map((op) => safeString(op.name)).filter((name): name is string => !!name));
		const nextOps = { ...(current.mcpOperations ?? {}) };
		const currentOps = new Set(nextOps[contributionId] ?? []);
		if (!knownOperationNames.has(operationName) && !(body.disabled === false && currentOps.has(operationName))) {
			json({ error: `unknown MCP operation for contribution: ${operationName}` }, 400);
			return;
		}
		if (body.disabled) currentOps.add(operationName);
		else currentOps.delete(operationName);
		if (currentOps.size > 0) nextOps[contributionId] = [...currentOps].sort();
		else delete nextOps[contributionId];
		cfgStore.setPackActivation(targetScope as PackOrderScope, matchedPackName, {
			...current,
			mcpOperations: Object.keys(nextOps).length > 0 ? nextOps : undefined,
		});
		invalidateResolverCaches();
		const mcpReload = await reloadMcpAfterMarketplaceMutation(targetScope, targetProjectId);
		const refreshedCatalogue = buildActivationCatalogue(targetScope, st.target.projectBase, st.target.store, matchedPackName, targetProjectId) ?? matchedCatalogue;
		const nextDisabled = cfgStore.getPackActivation(targetScope as PackOrderScope, matchedPackName);
		json({ scope: targetScope, packName: matchedPackName, contributionId, operationName, disabled: nextDisabled, catalogue: refreshedCatalogue, revision: packActivationRevision(nextDisabled), ...(mcpReload ? { mcpReload } : {}) });
		return;
	}

	// ── conflicts (§4 / §9) ───────────────────────────────────
	if (url.pathname === "/api/packs/conflicts" && req.method === "GET") {
		const projectId = url.searchParams.get("projectId") || undefined;
		const conflicts: ConflictWire[] = [
			...buildConflictsFor("roles", configCascade.resolveRolesEntries(projectId)),
			...buildConflictsFor("tools", configCascade.resolveToolsEntries(projectId)),
		];
		const skillCwd = resolveSkillDiscoveryCwd(process.cwd(), projectId ?? null);
		const skillStore = resolveProjectConfigStore(projectId ?? null);
		conflicts.push(...buildConflictsFor("skills", discoverSlashSkillsResolved(skillCwd, skillStore, skillMarketContext(projectId ?? null))));
		json({ conflicts });
		return;
	}

	json({ error: "not found" }, 404);
	return;
}

export function registerMarketplaceRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("GET", "/api/marketplace/*", handleMarketplaceRequest);
	table.register("POST", "/api/marketplace/*", handleMarketplaceRequest);
	table.register("PUT", "/api/marketplace/*", handleMarketplaceRequest);
	table.register("DELETE", "/api/marketplace/*", handleMarketplaceRequest);
	table.register("PATCH", "/api/marketplace/*", handleMarketplaceRequest);
	table.register("GET", "/api/packs/conflicts", handleMarketplaceRequest);
}
