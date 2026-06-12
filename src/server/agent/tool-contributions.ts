// src/server/agent/tool-contributions.ts
//
// Parse the TOOL-SCOPED Extension Host contribution points out of a tool YAML
// (pack-schema-v1-rationalisation §1.3). After the V1 schema rationalisation a
// tool YAML declares ONLY the two contributions that depend on a tool call /
// `toolUseId`:
//
//   - `renderer` — the pre-built ESM renderer module (served + lazy-imported);
//   - `actions`  — the server-actions module + optional name allowlist.
//
// The pack-SCOPED contributions (`panels`, `entrypoints`, `routes`, `stores`)
// have MOVED off the tool YAML to their own pack-level declaration sites
// (`panels/*.yaml`, `entrypoints/*.yaml`, `pack.yaml.routes`; stores are
// implicit). See `pack-contributions.ts`.
//
// MAINTAINER DECISION (pack-schema-v1 §1.3): the old per-tool
// `panels`/`routes`/`stores`/`entrypoints` keys are treated AS IF THEY NEVER
// EXISTED — there is NO detector, NO warning, NO diagnostic for them. They are
// simply unrecognised keys the parser ignores like any other. A pack that still
// ships them gets none of those surfaces (the operative meaning of "invalid" for
// a pre-release break with no dual-read / migration).
//
// Parsing is defensive: a malformed contributions block degrades gracefully (the
// tool still loads with no renderer/actions; a console.warn is emitted) — never
// fatal, mirroring the per-tool try/catch in tool-manager.ts::scanToolsDir.

/** Tool-scoped contributions parsed from a tool YAML (renderer + actions only). */
export interface ToolContributions {
	/** Renderer ESM module path, relative to the tool YAML's dir (contained in
	 *  the pack root, §2). Load-bearing for PACK tools; display-only metadata
	 *  (a src/ path) for builtins. */
	renderer?: string;
	/** Server actions module + optional declared action allowlist. */
	actions?: ToolActionsContribution;
	/** Forward-compat: FUTURE unknown contribution keys parsed-for-shape only,
	 *  retained verbatim, NOT acted on (RESERVED_KEYS is currently empty). */
	reserved: ReservedContributions;
}

export interface ToolActionsContribution {
	/** Module path relative to the tool YAML's dir. Default "actions.js". */
	module?: string;
	/** Optional explicit action-name allowlist. When present, the endpoint
	 *  rejects any :action not in this list BEFORE loading the module. */
	names?: string[];
}

/**
 * A pack-scoped entrypoint shape (launcher / deep-link route). Defined here
 * because the field-validation parser {@link parseEntrypoints} is REUSED by the
 * pack-level loader (`pack-contributions.ts`), which augments it with
 * `listName` / `sourceFile` / `packRoot`. Launcher kinds
 * (`composer-slash`/`git-widget-button`/`command-palette`) carry a `label` + a
 * structured `target` (panel or route); the `route` kind declares a
 * deep-linkable client route (`routeId` + `target.panelId` + `paramKeys`).
 */
export interface EntrypointContribution {
	id: string;
	kind: "composer-slash" | "git-widget-button" | "command-palette" | "route";
	label?: string;
	routeId?: string;
	target?: { panelId?: string; route?: string; params?: Record<string, unknown> };
	paramKeys?: string[];
}

/** FUTURE-contract contribution keys (none currently). Validated for *shape* only
 *  (array), retained verbatim, then ignored. Never rejected. */
export interface ReservedContributions {
	[key: string]: unknown[] | undefined;
}

const ACTION_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const RESERVED_KEYS = [] as const;
const ENTRYPOINT_ID_RE = /^[a-z0-9][a-z0-9_.-]*$/i;
// Deep-link route ids may use dotted namespaces (e.g. `artifacts`), like panel ids.
const ENTRYPOINT_ROUTE_ID_RE = /^[a-z0-9][a-z0-9_.-]*$/i;

/**
 * A path supplied in a pack YAML is safe IFF it is a RELATIVE path with no
 * absolute / drive-absolute / leading-separator form and no null byte.
 *
 * `..` segments are now ALLOWED (pack-schema-v1 §2.1): shared modules live in a
 * sibling `lib/` dir, so a tool YAML legitimately references `../../lib/X.js`.
 * The escape protection moves to the realpath containment check at serve/import
 * time, which is enforced against the PACK ROOT and is strictly stronger
 * (symlink-aware). Parse time only rejects forms that can never be contained:
 * absolute paths, Windows drive-absolute, a leading `/`/`\`, and null bytes.
 */
export function isSafeRelativePath(p: string): boolean {
	if (typeof p !== "string" || p.length === 0) return false;
	if (p.includes("\0")) return false;
	if (p.startsWith("/") || p.startsWith("\\")) return false;
	// Reject Windows drive-absolute (e.g. C:\... / C:/...).
	if (/^[a-zA-Z]:[\\/]/.test(p)) return false;
	return true;
}

/**
 * Parse the TOOL-SCOPED contribution points from an already-parsed tool YAML.
 * `data` is the parsed YAML (may be anything); `filePath` is used only for
 * warnings. Always returns a ToolContributions (never throws); invalid pieces
 * are dropped with a console.warn so the tool still loads.
 *
 * ONLY `renderer` + `actions` are read. Any other key (including the old
 * pack-scoped `panels`/`routes`/`stores`/`entrypoints`) is ignored exactly like
 * an unknown key — see the MAINTAINER DECISION in the module header.
 */
export function parseContributions(data: unknown, filePath: string): ToolContributions {
	const reserved: ReservedContributions = {};
	const result: ToolContributions = { reserved };

	if (!data || typeof data !== "object") return result;
	const obj = data as Record<string, unknown>;

	// ── renderer (tool-scoped, load-bearing) ──
	if (obj.renderer !== undefined) {
		if (typeof obj.renderer === "string" && isSafeRelativePath(obj.renderer)) {
			result.renderer = obj.renderer;
		} else {
			console.warn(`[tool-contributions] Ignoring unsafe/invalid 'renderer' in ${filePath}`);
		}
	}

	// ── actions (tool-scoped, load-bearing) ──
	if (obj.actions !== undefined) {
		const parsed = parseActions(obj.actions, filePath);
		if (parsed) result.actions = parsed;
	}

	// ── reserved FUTURE keys: shape-validate (arrays), retain verbatim, never reject ──
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
 * Parse an array of entrypoint declarations into typed `EntrypointContribution[]`
 * (pack-schema-v1 §1.5). Launcher kinds require a `label` + a structured `target`
 * ({ panelId } OR { route }); `kind:"route"` requires `routeId` + `target.panelId`
 * + a string-array `paramKeys`. Malformed entries are dropped with a warning —
 * NEVER rejects. Duplicate ids keep the first occurrence (intra-source); the
 * hard duplicate-id conflict ACROSS files is detected by the pack-level loader.
 *
 * REUSED by `pack-contributions.ts` (wrapping each single-file object as `[obj]`)
 * so the field-validation logic lives in one place.
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
		const action = rawTarget && typeof rawTarget.action === "string" ? rawTarget.action : undefined;
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
			// A spawn launcher (`action:"spawn"`) carries ALL of { action, route, panelId }:
			// the client calls `route` to spawn the child, then opens `panelId` in the
			// returned child session. Both are required — drop with a warning if either
			// is missing. Non-spawn launchers keep the legacy shape (panelId wins, else route).
			if (action === "spawn") {
				if (!route || !panelId) {
					console.warn(`[tool-contributions] Dropping spawn launcher entrypoint '${id}' missing target.route or target.panelId in ${filePath}`);
					continue;
				}
			}
			if (seen.has(id)) continue;
			seen.add(id);
			const target: { action?: string; panelId?: string; route?: string; params?: Record<string, unknown> } = {};
			if (action === "spawn") {
				target.action = "spawn";
				target.route = route;
				target.panelId = panelId;
			} else if (panelId) {
				target.panelId = panelId;
			} else if (route) {
				target.route = route;
			}
			if (params) target.params = params;
			out.push({ id, kind: kind as EntrypointContribution["kind"], label, target });
		}
	}
	return out;
}

/**
 * A tool's winning `baseDir` is a market-pack root IFF the path contains a
 * `market-packs` segment (installed packs live under
 * `<scope>/.bobbit/config/market-packs/<name>/tools`). Structural path-segment
 * check (not a fragile substring match), so `my-market-packs-notes` does NOT match.
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
