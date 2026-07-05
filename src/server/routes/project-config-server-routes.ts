// src/server/routes/project-config-server-routes.ts
//
// STR-01 cohort 4: the SERVER-scope `/api/project-config` trio —
// GET /api/project-config, GET /api/project-config/defaults,
// PUT /api/project-config — migrated out of handleApiRoute's legacy
// if/else chain into the core route registry. See
// docs/design/route-registry.md.
//
// This is a DIFFERENT family from cohort 2's per-project config
// (src/server/routes/project-config-routes.ts, the
// `/api/projects/:id/config(...)` family): these three routes operate on the
// SERVER/default-scope `ProjectConfigStore` (handleApiRoute's own
// `projectConfigStore` param, threaded through as `ctx.projectConfigStore` —
// the same field cohort 3/marketplace already added), not a per-project one.
// Cohort 2 deliberately left this trio out because its PUT handler was
// lexically adjacent to the marketplace block being migrated in a parallel
// cohort branch at the time; that's merged now, so it's no longer a
// conflict risk.
//
// Mechanical extraction — every handler body below is byte-for-byte the same
// logic as the `if (url.pathname === "/api/project-config" && ...)` blocks
// they replaced. Each of the three blocks gated on `url.pathname === ... &&
// req.method === ...` TOGETHER (the cohort-1 shape, not cohort-2's
// path-first/method-inside shape), so an unmatched method on these literal
// paths always fell straight through to the rest of the chain both before
// and after this migration — no legacy-fall-through-parity shim is needed
// here (contrast cohort 2's project-config-routes.ts and this cohort's own
// pack-runtimes-routes.ts, both of which needed shims).
// Zero behavior change: same auth (handled upstream of handleApiRoute,
// untouched), same validation, same status codes, same error shapes.

import type { RouteTable } from "./route-table.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";

// GET /api/project-config — return project settings
async function handleServerProjectConfigGet(ctx: CoreRouteCtx): Promise<void> {
	ctx.json(ctx.projectConfigStore.getWithDefaults());
}

// GET /api/project-config/defaults — return just the defaults
async function handleServerProjectConfigDefaults(ctx: CoreRouteCtx): Promise<void> {
	ctx.json(ctx.projectConfigStore.getDefaults());
}

// PUT /api/project-config — update server-scope project config fields
async function handleServerProjectConfigPut(ctx: CoreRouteCtx): Promise<void> {
	const { json, readBody, req, projectConfigStore, legacyQaTopLevelKeys } = ctx;
	const body = await readBody(req);
	if (!body || typeof body !== "object") { json({ error: "Missing body" }, 400); return; }
	const bodyMap = body as Record<string, unknown>;

	// Reject legacy top-level qa_* keys — they have moved into
	// `components[<name>].config`.
	for (const key of legacyQaTopLevelKeys) {
		if (key in bodyMap) {
			json({ error: `${key} settings have moved to components[].config[]; set components[<name>].config.${key} instead` }, 400);
			return;
		}
	}

	// Native-YAML migrated fields: must be sent as structured types.
	const MIGRATED_FIELDS = [
		{ key: "config_directories", expect: "array" as const },
		{ key: "sandbox_tokens", expect: "array" as const },
	];
	const migratedExtracted: Record<string, unknown> = {};
	for (const { key, expect } of MIGRATED_FIELDS) {
		if (!(key in bodyMap)) continue;
		const v = bodyMap[key];
		if (v === null || v === "") { migratedExtracted[key] = null; delete bodyMap[key]; continue; }
		if (typeof v === "string") {
			json({ error: `Field "${key}" must be sent as a structured ${expect}, not a JSON-encoded string` }, 400);
			return;
		}
		if (expect === "array" && !Array.isArray(v)) { json({ error: `Field "${key}" must be an array` }, 400); return; }
		migratedExtracted[key] = v;
		delete bodyMap[key];
	}

	for (const [key, value] of Object.entries(bodyMap)) {
		if (key.includes(".")) {
			json({ error: `Config key "${key}" must not contain dots` }, 400);
			return;
		}
		if (value === null || value === "") {
			projectConfigStore.remove(key);
		} else if (typeof value === "string") {
			projectConfigStore.set(key, value);
		}
	}

	// Apply migrated structured fields via typed setters.
	if ("config_directories" in migratedExtracted) {
		const v = migratedExtracted.config_directories;
		if (v === null) projectConfigStore.remove("config_directories");
		else if (Array.isArray(v)) {
			projectConfigStore.setConfigDirectories(
				v.filter((e: any) => e && typeof e === "object" && typeof e.path === "string").map((e: any) => ({
					path: String(e.path),
					types: Array.isArray(e.types) ? e.types.filter((t: unknown): t is string => typeof t === "string") : [],
				})),
			);
		}
	}
	if ("sandbox_tokens" in migratedExtracted) {
		const v = migratedExtracted.sandbox_tokens;
		if (v === null) projectConfigStore.remove("sandbox_tokens");
		else if (Array.isArray(v)) {
			projectConfigStore.setSandboxTokens(
				v.filter((e: any) => e && typeof e === "object" && typeof e.key === "string").map((e: any) => ({
					key: String(e.key), enabled: e.enabled !== false,
				})),
			);
		}
	}

	json({ ok: true });
}

export function registerServerProjectConfigRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("GET", "/api/project-config", handleServerProjectConfigGet);
	table.register("GET", "/api/project-config/defaults", handleServerProjectConfigDefaults);
	table.register("PUT", "/api/project-config", handleServerProjectConfigPut);
}
