// src/server/agent/tool-contributions.ts
//
// Parse the Extension Host contribution-point manifest out of a tool YAML
// (design docs/design/extension-host.md §2.2/§2.3). The Phase-1 load-bearing keys
// (`renderer`, `actions`) plus the Phase-2 graduated keys (`stores`/`panels`/
// `routes`/`entrypoints`) are all parsed into typed contributions now; the
// reserved-shape fallback machinery is RETAINED (RESERVED_KEYS is currently empty)
// for forward-compat with any FUTURE unknown contribution key — shape-validated
// (array), retained verbatim, and NEVER rejected, so a forward pack authored
// against a later contract still installs + resolves cleanly here.
//
// Parsing is defensive: a malformed contributions block degrades gracefully
// (the tool still loads with no renderer/actions; a console.warn is emitted) —
// never fatal, mirroring the per-tool try/catch in tool-manager.ts::scanToolsDir.

import { PACK_PERMISSION_VALUES, type PackPermission } from "../extension-host/permission-grants.js";

export type { PackPermission };

/** Phase-1 load-bearing contributions parsed from a tool YAML. */
export interface ToolContributions {
	/** Renderer ESM module path, relative to the tool's group dir. Phase-1 load-bearing
	 *  for PACK tools only; for builtins this is display-only metadata (a src/ path). */
	renderer?: string;
	/** Server actions module + optional declared action allowlist. */
	actions?: ToolActionsContribution;
	/** Slice B1 — advisory `stores:` declarations (the runtime backend is keyed by
	 *  the server-derived packId, so this is a declaration/validation aid only). */
	stores?: StoreContribution[];
	/** Slice B4 — typed `panels:` declarations (pack-contributed side panels). Each
	 *  `entry` is a pre-built ESM module path served by the bearer-only panel
	 *  endpoint and lazy-imported by the client `pack-panels.ts` registry. */
	panels?: PanelContribution[];
	/** Slice B3 — server routes module + the declared route-name allowlist the
	 *  pack-level RouteRegistry indexes by (graduated from `reserved`). */
	routes?: RouteContribution;
	/** Slice C1 — typed `entrypoints:` declarations (launcher surfaces + deep-link
	 *  client routes), consumed by the client `pack-entrypoints.ts` registry. */
	entrypoints?: EntrypointContribution[];
	/** Slice C3 (declared-permission model) — the OPT-IN host capabilities a pack's
	 *  server modules may use (`git`/`fs`/`net`). Default empty ⇒ deny-all (the
	 *  confined worker keeps every dangerous import denied + every ambient global
	 *  stripped). The grant is resolved server-side from the winning contribution
	 *  and threaded into the worker; it is NEVER caller-supplied. */
	permissions?: PackPermission[];
	/** Forward-compat: FUTURE unknown contribution keys parsed-for-shape only,
	 *  retained verbatim, NOT acted on (RESERVED_KEYS is currently empty). */
	reserved: ReservedContributions;
}

/** Slice C1 — a single `entrypoints:` entry. Launcher kinds (`composer-slash`/
 *  `git-widget-button`/`command-palette`) carry a `label` + a structured `target`
 *  (panel or route); the `route` kind declares a deep-linkable client route
 *  (`routeId` + `target.panelId` + `paramKeys`). */
export interface EntrypointContribution {
	id: string;
	kind: "composer-slash" | "git-widget-button" | "command-palette" | "route";
	/** Launcher display label (required for launcher kinds; absent for `route`). */
	label?: string;
	/** Deep-link route id (required for `kind:"route"`). */
	routeId?: string;
	/** Structured nav target: `{ panelId }` (panel) or `{ route }` (deep-link). */
	target?: { panelId?: string; route?: string; params?: Record<string, unknown> };
	/** Param names serialized into / parsed from the deep-link hash (`route` kind). */
	paramKeys?: string[];
}

/** Slice B4 — a single `panels:` entry: a pack-contributed side panel. `entry` is
 *  the pre-built ESM module path (relative to the tool's group dir, path-safe). */
export interface PanelContribution {
	id: string;
	title?: string;
	entry: string;
}

/** A single `stores:` entry — an advisory declaration that the tool uses a store. */
export interface StoreContribution {
	id: string;
}

export interface ToolActionsContribution {
	/** Module path relative to the group dir. Default "actions.js". */
	module?: string;
	/** Optional explicit action-name allowlist. When present, the endpoint
	 *  rejects any :action not in this list BEFORE loading the module. */
	names?: string[];
}

/** A `routes:` contribution (Slice B3) — a pack tool's server routes module +
 *  the declared route names. Mirrors {@link ToolActionsContribution}; the
 *  pack-level RouteRegistry indexes a pack's routes by these declared `names`. */
export interface RouteContribution {
	/** Module path relative to the group dir. Default "routes.js". */
	module?: string;
	/** Declared route names. The RouteRegistry maps each → this declaring tool,
	 *  so a route is reachable via `host.callRoute(name)` only when named here. */
	names?: string[];
}

/** FUTURE-contract contribution keys (none currently). Validated for *shape* only
 *  (array), retained verbatim, then ignored. Never rejected. The index signature
 *  keeps the forward-compat fallback machinery generic now that every Phase-2 key
 *  has graduated to a typed parser. */
export interface ReservedContributions {
	[key: string]: unknown[] | undefined;
}

const ACTION_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const ROUTE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const STORE_ID_RE = /^[a-z0-9][a-z0-9_.-]*$/i;
// Slice B4 — panel ids may use dotted namespaces (e.g. `artifacts.viewer`).
const PANEL_ID_RE = /^[a-z0-9][a-z0-9_.-]*$/i;
// Every Phase-2 contribution key has now graduated from reserved-shape-only to a
// typed parser: `stores` (B1), `panels` (B4), `routes` (B3), `entrypoints` (C1).
// RESERVED_KEYS is therefore EMPTY — but the fallback loop below is intentionally
// retained (not deleted) so a FUTURE unknown contribution key can be re-introduced
// here and immediately get the shape-validate/retain-verbatim/never-reject
// treatment without re-deriving the machinery.
const RESERVED_KEYS = [] as const;
const ENTRYPOINT_ID_RE = /^[a-z0-9][a-z0-9_.-]*$/i;
// Deep-link route ids may use dotted namespaces (e.g. `artifacts`), like panel ids.
const ENTRYPOINT_ROUTE_ID_RE = /^[a-z0-9][a-z0-9_.-]*$/i;

/**
 * A path supplied in a tool YAML (`renderer`/`actions.module`) is safe IFF it is a
 * relative path with NO `..` segments and NO leading `/` (reject path traversal at
 * parse time). Backslashes are normalized so a Windows-style `..\` is also caught.
 */
function isSafeRelativePath(p: string): boolean {
	if (typeof p !== "string" || p.length === 0) return false;
	if (p.startsWith("/") || p.startsWith("\\")) return false;
	// Reject Windows drive-absolute (e.g. C:\...).
	if (/^[a-zA-Z]:[\\/]/.test(p)) return false;
	const segments = p.split(/[\\/]+/);
	if (segments.some((s) => s === "..")) return false;
	return true;
}

/**
 * Parse the contribution points from an already-parsed tool YAML object.
 * `data` is the parsed YAML (may be anything); `filePath` is used only for warnings.
 * Always returns a ToolContributions (never throws); invalid pieces are dropped
 * with a console.warn so the tool still loads.
 */
export function parseContributions(data: unknown, filePath: string): ToolContributions {
	const reserved: ReservedContributions = {};
	const result: ToolContributions = { reserved };

	if (!data || typeof data !== "object") return result;
	const obj = data as Record<string, unknown>;

	// ── renderer (Phase-1 load-bearing) ──
	if (obj.renderer !== undefined) {
		if (typeof obj.renderer === "string" && isSafeRelativePath(obj.renderer)) {
			result.renderer = obj.renderer;
		} else {
			console.warn(`[tool-contributions] Ignoring unsafe/invalid 'renderer' in ${filePath}`);
		}
	}

	// ── actions (Phase-1 load-bearing) ──
	if (obj.actions !== undefined) {
		const parsed = parseActions(obj.actions, filePath);
		if (parsed) result.actions = parsed;
	}

	// ── stores (Slice B1 — advisory; tolerant, never rejects) ──
	if (obj.stores !== undefined) {
		const parsed = parseStores(obj.stores, filePath);
		if (parsed.length > 0) result.stores = parsed;
	}

	// ── panels (Slice B4 — typed; tolerant, never rejects) ──
	if (obj.panels !== undefined) {
		const parsed = parsePanels(obj.panels, filePath);
		if (parsed.length > 0) result.panels = parsed;
	}

	// ── routes (Slice B3 — load-bearing; tolerant per-tool, never rejects here —
	//    intra-pack duplicate route names are the ONE hard conflict, rejected later
	//    at RouteRegistry-build time, which alone can see other tools in the pack) ──
	if (obj.routes !== undefined) {
		const parsed = parseRoutes(obj.routes, filePath);
		if (parsed) result.routes = parsed;
	}

	// ── permissions (Slice C3 — declared-permission grants; tolerant, never rejects) ──
	if (obj.permissions !== undefined) {
		const parsed = parsePermissions(obj.permissions, filePath);
		if (parsed.length > 0) result.permissions = parsed;
	}

	// ── entrypoints (Slice C1 — typed; tolerant per-tool, never rejects — a
	//    duplicate routeId across tools/packs is the hard conflict, rejected later
	//    at client registry-build time, which alone can see other tools/packs) ──
	if (obj.entrypoints !== undefined) {
		const parsed = parseEntrypoints(obj.entrypoints, filePath);
		if (parsed.length > 0) result.entrypoints = parsed;
	}

	// ── reserved Phase-2 keys: shape-validate (arrays), retain verbatim, never reject ──
	for (const key of RESERVED_KEYS) {
		if (obj[key] === undefined) continue;
		if (Array.isArray(obj[key])) {
			reserved[key] = obj[key] as unknown[];
		} else {
			console.warn(`[tool-contributions] Reserved key '${key}' is not an array in ${filePath}; ignoring`);
		}
	}

	return result;
}

function parseActions(raw: unknown, filePath: string): ToolActionsContribution | undefined {
	// Allow a bare `actions: true` / `actions: actions.js` shorthand as well as the
	// canonical object form. Anything else degrades to "no actions" with a warning.
	if (raw === true) return { module: "actions.js" };
	if (typeof raw === "string") {
		if (isSafeRelativePath(raw)) return { module: raw };
		console.warn(`[tool-contributions] Ignoring unsafe 'actions' module path in ${filePath}`);
		return undefined;
	}
	if (!raw || typeof raw !== "object") {
		console.warn(`[tool-contributions] Malformed 'actions' block in ${filePath}; ignoring`);
		return undefined;
	}

	const obj = raw as Record<string, unknown>;
	const out: ToolActionsContribution = {};

	if (obj.module !== undefined) {
		if (typeof obj.module === "string" && isSafeRelativePath(obj.module)) {
			out.module = obj.module;
		} else {
			console.warn(`[tool-contributions] Ignoring unsafe/invalid 'actions.module' in ${filePath}`);
		}
	}
	// Default module when actions: is present without an explicit (valid) module.
	if (out.module === undefined) out.module = "actions.js";

	if (obj.names !== undefined) {
		if (Array.isArray(obj.names)) {
			const names = obj.names.filter(
				(n): n is string => typeof n === "string" && ACTION_NAME_RE.test(n),
			);
			if (names.length !== obj.names.length) {
				console.warn(`[tool-contributions] Dropped invalid 'actions.names' entries in ${filePath}`);
			}
			if (names.length > 0) out.names = names;
		} else {
			console.warn(`[tool-contributions] 'actions.names' is not an array in ${filePath}; ignoring`);
		}
	}

	return out;
}

/**
 * Parse the `routes:` contribution (Slice B3) into a typed {@link RouteContribution}.
 * Mirrors {@link parseActions}: accepts the `routes: true` / `routes: routes.js`
 * shorthand and the canonical `{ module, names }` object; same `isSafeRelativePath`
 * path-safety on `module`. Per-tool parsing is TOLERANT (malformed degrades to
 * "no routes" with a warning, never rejects the tool); the ONE hard conflict
 * — two tools in a pack declaring the same route name — can only be seen at
 * RouteRegistry-build time, where it is rejected (route-dispatcher.ts).
 */
export function parseRoutes(raw: unknown, filePath: string): RouteContribution | undefined {
	if (raw === true) return { module: "routes.js" };
	if (typeof raw === "string") {
		if (isSafeRelativePath(raw)) return { module: raw };
		console.warn(`[tool-contributions] Ignoring unsafe 'routes' module path in ${filePath}`);
		return undefined;
	}
	if (!raw || typeof raw !== "object") {
		console.warn(`[tool-contributions] Malformed 'routes' block in ${filePath}; ignoring`);
		return undefined;
	}

	const obj = raw as Record<string, unknown>;
	const out: RouteContribution = {};

	if (obj.module !== undefined) {
		if (typeof obj.module === "string" && isSafeRelativePath(obj.module)) {
			out.module = obj.module;
		} else {
			console.warn(`[tool-contributions] Ignoring unsafe/invalid 'routes.module' in ${filePath}`);
		}
	}
	// Default module when routes: is present without an explicit (valid) module.
	if (out.module === undefined) out.module = "routes.js";

	if (obj.names !== undefined) {
		if (Array.isArray(obj.names)) {
			const names = obj.names.filter(
				(n): n is string => typeof n === "string" && ROUTE_NAME_RE.test(n),
			);
			if (names.length !== obj.names.length) {
				console.warn(`[tool-contributions] Dropped invalid 'routes.names' entries in ${filePath}`);
			}
			if (names.length > 0) out.names = names;
		} else {
			console.warn(`[tool-contributions] 'routes.names' is not an array in ${filePath}; ignoring`);
		}
	}

	return out;
}

/**
 * Parse the `stores:` contribution into typed `StoreContribution[]`. Each entry is
 * either a bare string id (`stores: ["prefs"]`) or an object `{ id }`. Malformed
 * entries are dropped with a warning — the block NEVER rejects the tool (the runtime
 * backend is keyed by the server-derived packId, so this declaration is advisory).
 */
export function parseStores(raw: unknown, filePath: string): StoreContribution[] {
	if (!Array.isArray(raw)) {
		console.warn(`[tool-contributions] 'stores' is not an array in ${filePath}; ignoring`);
		return [];
	}
	const seen = new Set<string>();
	const out: StoreContribution[] = [];
	for (const entry of raw) {
		let id: unknown;
		if (typeof entry === "string") id = entry;
		else if (entry && typeof entry === "object") id = (entry as Record<string, unknown>).id;
		if (typeof id !== "string" || !STORE_ID_RE.test(id)) {
			console.warn(`[tool-contributions] Dropping invalid 'stores' entry in ${filePath}`);
			continue;
		}
		if (seen.has(id)) continue;
		seen.add(id);
		out.push({ id });
	}
	return out;
}

/**
 * Parse the `panels:` contribution into typed `PanelContribution[]` (Slice B4).
 * Each entry is an object `{ id, title?, entry }`; `entry` must be a path-safe
 * relative ESM module path (`isSafeRelativePath` — reject traversal). Malformed
 * entries are dropped with a warning — the block NEVER rejects the tool (mirrors
 * `parseStores`). Duplicate ids keep the first occurrence.
 */
export function parsePanels(raw: unknown, filePath: string): PanelContribution[] {
	if (!Array.isArray(raw)) {
		console.warn(`[tool-contributions] 'panels' is not an array in ${filePath}; ignoring`);
		return [];
	}
	const seen = new Set<string>();
	const out: PanelContribution[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") {
			console.warn(`[tool-contributions] Dropping invalid 'panels' entry in ${filePath}`);
			continue;
		}
		const obj = entry as Record<string, unknown>;
		const id = obj.id;
		const entryPath = obj.entry;
		if (typeof id !== "string" || !PANEL_ID_RE.test(id)) {
			console.warn(`[tool-contributions] Dropping 'panels' entry with invalid id in ${filePath}`);
			continue;
		}
		if (typeof entryPath !== "string" || !isSafeRelativePath(entryPath)) {
			console.warn(`[tool-contributions] Dropping 'panels' entry '${id}' with unsafe/missing entry in ${filePath}`);
			continue;
		}
		if (seen.has(id)) continue;
		seen.add(id);
		const panel: PanelContribution = { id, entry: entryPath };
		if (typeof obj.title === "string" && obj.title.length > 0) panel.title = obj.title;
		out.push(panel);
	}
	return out;
}

/**
 * Parse the `entrypoints:` contribution into typed `EntrypointContribution[]`
 * (Slice C1; design §7 C1.4). Each entry is an object with a `kind` enum:
 *   - launcher kinds (`composer-slash`/`git-widget-button`/`command-palette`)
 *     require a `label` + a structured `target` ({ panelId } OR { route });
 *   - `kind:"route"` requires `routeId` + `target.panelId` + a string-array
 *     `paramKeys` (the deep-link param names).
 * Malformed entries are dropped with a warning — the block NEVER rejects the tool
 * (mirrors `parsePanels`/`parseStores`). Duplicate ids keep the first occurrence.
 * A duplicate `routeId` ACROSS tools/packs is NOT visible here (per-tool parse);
 * it is the one hard conflict rejected at client registry-build (pack-entrypoints).
 */
export function parseEntrypoints(raw: unknown, filePath: string): EntrypointContribution[] {
	if (!Array.isArray(raw)) {
		console.warn(`[tool-contributions] 'entrypoints' is not an array in ${filePath}; ignoring`);
		return [];
	}
	const LAUNCHER_KINDS = new Set(["composer-slash", "git-widget-button", "command-palette"]);
	const seen = new Set<string>();
	const out: EntrypointContribution[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") {
			console.warn(`[tool-contributions] Dropping invalid 'entrypoints' entry in ${filePath}`);
			continue;
		}
		const obj = entry as Record<string, unknown>;
		const id = obj.id;
		const kind = obj.kind;
		if (typeof id !== "string" || !ENTRYPOINT_ID_RE.test(id)) {
			console.warn(`[tool-contributions] Dropping 'entrypoints' entry with invalid id in ${filePath}`);
			continue;
		}
		if (kind !== "route" && !LAUNCHER_KINDS.has(kind as string)) {
			console.warn(`[tool-contributions] Dropping 'entrypoints' entry '${id}' with invalid kind in ${filePath}`);
			continue;
		}
		const rawTarget = (obj.target && typeof obj.target === "object") ? obj.target as Record<string, unknown> : undefined;
		const panelId = rawTarget && typeof rawTarget.panelId === "string" ? rawTarget.panelId : undefined;
		const route = rawTarget && typeof rawTarget.route === "string" ? rawTarget.route : undefined;
		const params = rawTarget && rawTarget.params && typeof rawTarget.params === "object"
			? rawTarget.params as Record<string, unknown>
			: undefined;

		if (kind === "route") {
			const routeId = obj.routeId;
			if (typeof routeId !== "string" || !ENTRYPOINT_ROUTE_ID_RE.test(routeId)) {
				console.warn(`[tool-contributions] Dropping 'route' entrypoint '${id}' with invalid routeId in ${filePath}`);
				continue;
			}
			if (!panelId) {
				console.warn(`[tool-contributions] Dropping 'route' entrypoint '${id}' missing target.panelId in ${filePath}`);
				continue;
			}
			const paramKeys = Array.isArray(obj.paramKeys)
				? obj.paramKeys.filter((k): k is string => typeof k === "string")
				: [];
			if (seen.has(id)) continue;
			seen.add(id);
			out.push({ id, kind: "route", routeId, target: params ? { panelId, params } : { panelId }, paramKeys });
		} else {
			const label = obj.label;
			if (typeof label !== "string" || label.length === 0) {
				console.warn(`[tool-contributions] Dropping launcher entrypoint '${id}' missing label in ${filePath}`);
				continue;
			}
			if (!panelId && !route) {
				console.warn(`[tool-contributions] Dropping launcher entrypoint '${id}' with no structured target in ${filePath}`);
				continue;
			}
			if (seen.has(id)) continue;
			seen.add(id);
			const target: { panelId?: string; route?: string; params?: Record<string, unknown> } = {};
			if (panelId) target.panelId = panelId;
			else if (route) target.route = route;
			if (params) target.params = params;
			out.push({ id, kind: kind as EntrypointContribution["kind"], label, target });
		}
	}
	return out;
}

/**
 * Parse the `permissions:` contribution (Slice C3 — declared-permission model)
 * into a typed `PackPermission[]`. Accepts a string array; entries are lowercased
 * and constrained to the recognized grant subset (`git`/`fs`/`net`). Unknown
 * entries are dropped with a warning — the block NEVER rejects the tool (mirrors
 * `parseStores`). Absent/empty ⇒ deny-all (the confined worker's default).
 *
 * Allowed values:
 *   - `git` — spawn the `git` binary (un-denies `child_process`; real cwd + PATH).
 *   - `fs`  — read/write within the session working dir (un-denies `fs`).
 *   - `net` — outbound network (keeps `fetch`/`WebSocket`; un-denies `net`/`http(s)`).
 */
export function parsePermissions(raw: unknown, filePath: string): PackPermission[] {
	if (!Array.isArray(raw)) {
		console.warn(`[tool-contributions] 'permissions' is not an array in ${filePath}; ignoring`);
		return [];
	}
	const allowed = new Set<string>(PACK_PERMISSION_VALUES);
	const seen = new Set<string>();
	const out: PackPermission[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string") {
			console.warn(`[tool-contributions] Dropping non-string 'permissions' entry in ${filePath}`);
			continue;
		}
		const lower = entry.toLowerCase();
		if (!allowed.has(lower)) {
			console.warn(`[tool-contributions] Dropping unknown 'permissions' value "${entry}" in ${filePath} (allowed: ${[...allowed].join(", ")})`);
			continue;
		}
		if (seen.has(lower)) continue;
		seen.add(lower);
		out.push(lower as PackPermission);
	}
	return out;
}

/**
 * A tool's winning `baseDir` is a market-pack root IFF the path contains a
 * `market-packs` segment (installed packs live under
 * `<scope>/.bobbit/config/market-packs/<name>/tools`). This is the single signal
 * the renderer-kind computation keys off (design §2.5). It is intentionally a
 * structural path-segment check — not a fragile substring match — so a directory
 * literally named e.g. `my-market-packs-notes` does NOT match.
 */
export function isMarketPackBaseDir(baseDir: string | undefined): boolean {
	if (!baseDir) return false;
	const segments = baseDir.split(/[\\/]+/);
	return segments.includes("market-packs");
}

/**
 * Compute the wire `rendererKind` (design §2.5): `"pack"` IFF the winning baseDir is a
 * market-pack root AND the renderer path is a pre-built ESM module (ends in `.js`);
 * otherwise `"builtin"`. A `.ts` renderer (the builtin display-only convention) is
 * always `"builtin"`.
 */
export function computeRendererKind(
	baseDir: string | undefined,
	renderer: string | undefined,
): "builtin" | "pack" {
	if (isMarketPackBaseDir(baseDir) && typeof renderer === "string" && renderer.toLowerCase().endsWith(".js")) {
		return "pack";
	}
	return "builtin";
}
