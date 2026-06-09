// src/server/agent/tool-contributions.ts
//
// Parse the Extension Host contribution-point manifest out of a tool YAML
// (design docs/design/extension-host.md §2.2/§2.3). Two keys are Phase-1
// load-bearing (`renderer`, `actions`); the rest (`panels`/`entrypoints`/
// `routes`/`stores`) are parsed-and-RESERVED — validated for shape only,
// retained verbatim, and NEVER rejected, so a Phase-2 pack authored today
// installs + resolves cleanly on a Phase-1 server.
//
// Parsing is defensive: a malformed contributions block degrades gracefully
// (the tool still loads with no renderer/actions; a console.warn is emitted) —
// never fatal, mirroring the per-tool try/catch in tool-manager.ts::scanToolsDir.

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
	/** Phase-2 keys still parsed-for-shape only, retained verbatim, NOT acted on. */
	reserved: ReservedContributions;
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

/** Phase-2 contribution keys. Validated for *shape* only, then ignored. Never rejected. */
export interface ReservedContributions {
	panels?: unknown[];
	entrypoints?: unknown[];
	routes?: unknown[];
}

const ACTION_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const STORE_ID_RE = /^[a-z0-9][a-z0-9_.-]*$/i;
const RESERVED_KEYS = ["panels", "entrypoints", "routes"] as const;

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
