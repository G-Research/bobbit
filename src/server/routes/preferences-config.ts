/**
 * Preferences, project-config, config-directories, config/cwd routes.
 * Extracted from server.ts (commit: split server.ts).
 */
import { LEGACY_QA_TOP_LEVEL_KEYS } from "../agent/project-config-store.js";
import { getAllConfigDirectories, removeBuiltinDirectory, resetConfigDirectories } from "../agent/config-directories.js";
import {
	getSafePreferences,
	broadcastPreferencesChanged,
	resolveProjectConfigStore,
} from "./cross-project.js";
import type { Route } from "./types.js";

export const preferencesConfigRoutes: Route[] = [
	{
		method: "GET",
		pattern: "/api/config/cwd",
		handler: ({ deps, json }) => {
			json({ cwd: deps.config.defaultCwd });
		},
	},
	{
		method: "PUT",
		pattern: "/api/config/cwd",
		handler: async ({ deps, readBody, json, jsonError }) => {
			const body = await readBody();
			if (!body?.cwd || typeof body.cwd !== "string") {
				jsonError(400, new Error("Missing or invalid cwd"));
				return;
			}
			deps.config.defaultCwd = body.cwd;
			deps.preferencesStore.set("defaultCwd", body.cwd);
			json({ cwd: deps.config.defaultCwd });
		},
	},
	{
		method: "GET",
		pattern: "/api/preferences",
		handler: ({ deps, json }) => {
			json(getSafePreferences(deps));
		},
	},
	{
		method: "PUT",
		pattern: "/api/preferences",
		handler: async ({ deps, readBody, json, jsonError }) => {
			const body = await readBody();
			if (!body || typeof body !== "object") { jsonError(400, new Error("Missing body")); return; }
			for (const [key, value] of Object.entries(body)) {
				if (value === null || value === undefined) {
					deps.preferencesStore.remove(key);
				} else {
					deps.preferencesStore.set(key, value);
				}
			}
			json({ ok: true });
			broadcastPreferencesChanged(deps);
		},
	},
	{
		method: "GET",
		pattern: "/api/project-config",
		handler: ({ deps, json }) => {
			json(deps.projectConfigStore.getWithDefaults());
		},
	},
	{
		method: "GET",
		pattern: "/api/project-config/defaults",
		handler: ({ deps, json }) => {
			json(deps.projectConfigStore.getDefaults());
		},
	},
	{
		method: "GET",
		pattern: "/api/config-directories",
		handler: ({ deps, url, json }) => {
			const projectId = url.searchParams.get("projectId");
			const resolvedStore = resolveProjectConfigStore(deps, projectId);
			const resolvedCwd = projectId && deps.projectContextManager
				? deps.projectContextManager.getOrCreate(projectId)?.project.rootPath ?? deps.config.defaultCwd
				: deps.config.defaultCwd;
			json(getAllConfigDirectories(resolvedCwd, resolvedStore));
		},
	},
	{
		method: "DELETE",
		pattern: "/api/config-directories",
		handler: async ({ deps, readBody, json, jsonError }) => {
			const body = await readBody();
			if (!body || typeof body !== "object" || typeof (body as any).path !== "string") {
				jsonError(400, new Error("Missing 'path' in body"));
				return;
			}
			const projectId = (body as any).projectId as string | null ?? null;
			const resolvedStore = resolveProjectConfigStore(deps, projectId);
			removeBuiltinDirectory(resolvedStore, (body as any).path);
			json({ ok: true });
		},
	},
	{
		method: "POST",
		pattern: "/api/config-directories/reset",
		handler: async ({ deps, readBody, json }) => {
			const body = await readBody();
			const projectId = body && typeof body === "object" ? ((body as any).projectId as string | null ?? null) : null;
			const resolvedStore = resolveProjectConfigStore(deps, projectId);
			resetConfigDirectories(resolvedStore);
			json({ ok: true });
		},
	},
	{
		method: "PUT",
		pattern: "/api/project-config",
		handler: async ({ deps, readBody, json, jsonError }) => {
			const { projectConfigStore } = deps;
			const body = await readBody();
			if (!body || typeof body !== "object") { jsonError(400, new Error("Missing body")); return; }
			const bodyMap = body as Record<string, unknown>;

			// Reject legacy top-level qa_* keys — they have moved into
			// `components[<name>].config`.
			for (const key of LEGACY_QA_TOP_LEVEL_KEYS) {
				if (key in bodyMap) {
					jsonError(400, new Error(`${key} settings have moved to components[].config[]; set components[<name>].config.${key} instead`));
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
					jsonError(400, new Error(`Field "${key}" must be sent as a structured ${expect}, not a JSON-encoded string`));
					return;
				}
				if (expect === "array" && !Array.isArray(v)) { jsonError(400, new Error(`Field "${key}" must be an array`)); return; }
				migratedExtracted[key] = v;
				delete bodyMap[key];
			}

			for (const [key, value] of Object.entries(bodyMap)) {
				if (key.includes(".")) {
					jsonError(400, new Error(`Config key "${key}" must not contain dots`));
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
		},
	},
];
