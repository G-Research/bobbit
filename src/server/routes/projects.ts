/**
 * Project CRUD + structured/rescan/promote/qa-testing-config + detect/scan/browse-directory.
 * Extracted from server.ts (commit: split server.ts).
 *
 * The big POST /api/projects and PUT /api/projects/:id/config handlers
 * remain in server.ts for now — they are deeply tangled with project-context
 * lifecycle, components/workflows validation, and worktree-pool initialisation.
 * Migrating them is tracked as follow-up work.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveScalarConfig } from "../agent/config-resolver.js";
import { LEGACY_QA_TOP_LEVEL_KEYS } from "../agent/project-config-store.js";
import {
	mergeSecretsIntoTokens,
	redactSandboxSecrets,
	redactSandboxSecretsResolved,
} from "../agent/sandbox-secrets.js";
import type { Route } from "./types.js";

export const projectsRoutes: Route[] = [
	{
		method: "POST",
		pattern: "/api/projects/detect",
		handler: async ({ readBody, json }) => {
			const body = await readBody();
			if (!body || typeof body.path !== "string") {
				json({ error: "Missing path" }, 400);
				return;
			}
			const dirPath = path.resolve(body.path);
			const exists = fs.existsSync(dirPath);
			let hasBobbit = false;
			let isEmpty = true;
			let hasPackageJson = false;
			let hasCargoToml = false;
			let hasGoMod = false;
			let name = path.basename(dirPath);

			if (exists) {
				try {
					const stat = fs.statSync(dirPath);
					if (stat.isDirectory()) {
						const entries = fs.readdirSync(dirPath);
						isEmpty = entries.length === 0;
						hasBobbit = entries.includes(".bobbit");
						hasPackageJson = entries.includes("package.json");
						hasCargoToml = entries.includes("Cargo.toml");
						hasGoMod = entries.includes("go.mod");

						if (hasPackageJson) {
							try {
								const pkg = JSON.parse(fs.readFileSync(path.join(dirPath, "package.json"), "utf-8"));
								if (typeof pkg.name === "string" && pkg.name) {
									name = pkg.name;
								}
							} catch {
								// fall back to directory basename
							}
						}
					} else {
						json({ error: "Path is not a directory" }, 400);
						return;
					}
				} catch {
					json({ exists: false, hasBobbit: false, isEmpty: true, hasPackageJson: false, hasCargoToml: false, hasGoMod: false, name });
					return;
				}
			}

			json({ exists, hasBobbit, isEmpty, hasPackageJson, hasCargoToml, hasGoMod, name });
		},
	},
	{
		method: "POST",
		pattern: "/api/projects/scan",
		handler: async ({ url, readBody, json, jsonError }) => {
			const body = await readBody().catch(() => ({}));
			const rawPath = url.searchParams.get("path") ?? (body && typeof body.path === "string" ? body.path : "");
			if (!rawPath) { json({ error: "Missing path" }, 400); return; }
			const dirPath = path.resolve(rawPath);
			if (!fs.existsSync(dirPath)) { json({ error: "Path not found" }, 404); return; }
			try {
				const { scanRepos } = await import("../agent/repo-scan.js");
				const { scanMonorepo } = await import("../agent/monorepo-scan.js");
				const repos = await scanRepos(dirPath);
				const monorepo = scanMonorepo(dirPath);
				json({ repos, monorepo });
			} catch (err: any) {
				jsonError(500, err);
			}
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/projects\/([^/]+)\/structured$/,
		handler: ({ deps, params, json }) => {
			const ctx = deps.projectContextManager.getOrCreate(params[1]);
			if (!ctx) { json({ error: "Project not found" }, 404); return; }
			const components = ctx.projectConfigStore.getComponents();
			const workflows = ctx.projectConfigStore.getWorkflows() ?? {};
			const worktreeRoot = ctx.projectConfigStore.get("worktree_root") ?? "";
			json({ components, workflows, worktree_root: worktreeRoot });
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/projects\/([^/]+)\/rescan-repos$/,
		handler: async ({ deps, params, json, jsonError }) => {
			const project = deps.projectRegistry.get(params[1]);
			if (!project) { json({ error: "Project not found" }, 404); return; }
			try {
				const { scanRepos } = await import("../agent/repo-scan.js");
				const { scanMonorepo } = await import("../agent/monorepo-scan.js");
				const repos = await scanRepos(project.rootPath);
				const monorepo = scanMonorepo(project.rootPath);
				json({ repos, monorepo, rootPath: project.rootPath });
			} catch (err: any) {
				jsonError(500, err);
			}
		},
	},
	{
		method: "GET",
		pattern: "/api/browse-directory",
		handler: ({ deps, url, json }) => {
			const rawPath = url.searchParams.get("path");
			const dirPath = rawPath ? path.resolve(rawPath) : deps.config.defaultCwd;

			if (!fs.existsSync(dirPath)) {
				json({ error: "Directory not found" }, 404);
				return;
			}

			try {
				const stat = fs.statSync(dirPath);
				if (!stat.isDirectory()) {
					json({ error: "Path is not a directory" }, 400);
					return;
				}
			} catch {
				json({ error: "Cannot access path" }, 400);
				return;
			}

			const entries: Array<{ name: string; path: string }> = [];
			try {
				const items = fs.readdirSync(dirPath);
				for (const item of items) {
					if (item.startsWith(".") || item === "node_modules") continue;
					const fullPath = path.join(dirPath, item);
					try {
						const stat = fs.lstatSync(fullPath);
						if (stat.isDirectory() && !stat.isSymbolicLink()) {
							entries.push({ name: item, path: fullPath });
						}
					} catch {
						// skip
					}
				}
			} catch {
				json({ error: "Cannot read directory" }, 500);
				return;
			}

			entries.sort((a, b) => a.name.localeCompare(b.name));

			const parsed = path.parse(dirPath);
			const parent = parsed.root === dirPath ? null : path.dirname(dirPath);

			json({ current: dirPath, parent, entries });
		},
	},
	{
		method: "GET",
		pattern: "/api/projects",
		handler: ({ deps, json }) => {
			json(deps.projectRegistry.list().filter(p => !p.hidden));
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/projects\/([^/]+)$/,
		handler: ({ deps, params, json }) => {
			const project = deps.projectRegistry.get(params[1]);
			if (!project) { json({ error: "Project not found" }, 404); return; }
			json(project);
		},
	},
	{
		method: "PUT",
		pattern: /^\/api\/projects\/([^/]+)$/,
		handler: async ({ deps, params, readBody, json, jsonError }) => {
			const body = await readBody();
			const updates: { name?: string; color?: string; rootPath?: string; palette?: string; colorLight?: string; colorDark?: string } = {};
			if (typeof body?.name === "string") updates.name = body.name;
			if (typeof body?.color === "string") updates.color = body.color;
			if (typeof body?.rootPath === "string") updates.rootPath = body.rootPath;
			if (typeof body?.palette === "string" || body?.palette === null || body?.palette === "") updates.palette = body.palette ?? "";
			if (typeof body?.colorLight === "string") updates.colorLight = body.colorLight;
			if (typeof body?.colorDark === "string") updates.colorDark = body.colorDark;
			try {
				const updated = deps.projectRegistry.update(params[1], updates);
				json(updated);
			} catch (err: any) {
				jsonError(400, err);
			}
		},
	},
	{
		method: "DELETE",
		pattern: /^\/api\/projects\/([^/]+)$/,
		handler: async ({ deps, params, url, json, jsonError }) => {
			const projectId = params[1];
			const project = deps.projectRegistry.get(projectId);
			const forceDelete = process.env.BOBBIT_E2E === "1" && url.searchParams.get("force") === "1";
			const visibleCount = deps.projectRegistry.list().filter(p => !p.hidden).length;
			if (project && !project.hidden && visibleCount === 1 && !forceDelete) {
				json({ error: "Cannot delete the last remaining project — add another project first" }, 400);
				return;
			}
			try {
				await deps.sessionManager.removeWorktreePool(projectId);
				const liveSessions = deps.sessionManager.listSessions().filter(s => s.projectId === projectId);
				for (const s of liveSessions) {
					try { await deps.sessionManager.terminateSession(s.id); } catch {}
				}
				deps.projectContextManager.remove(projectId);
				if (project?.provisional) {
					deps.projectRegistry.removeProvisional(projectId);
				} else {
					deps.projectRegistry.remove(projectId);
				}
				json({ ok: true });
			} catch (err: any) {
				jsonError(400, err);
			}
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/projects\/([^/]+)\/promote$/,
		handler: async ({ deps, params, readBody, json, jsonError }) => {
			const projectId = params[1];
			try {
				const body = await readBody();
				const name = typeof body?.name === "string" ? body.name : undefined;
				const promoted = deps.projectRegistry.promote(projectId, { name });
				json(promoted);
			} catch (err: any) {
				jsonError(400, err);
			}
		},
	},
	// GET /api/projects/:id/config[/(defaults|resolved)]  — split into 3 routes
	// with anchored regexes so each suffix dispatches independently.
	{
		method: "GET",
		pattern: /^\/api\/projects\/([^/]+)\/config\/defaults$/,
		handler: ({ deps, params, json }) => {
			const ctx = deps.projectContextManager.getOrCreate(params[1]);
			if (!ctx) { json({ error: "Project not found" }, 404); return; }
			json(ctx.projectConfigStore.getDefaults());
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/projects\/([^/]+)\/config\/resolved$/,
		handler: ({ deps, params, json }) => {
			const ctx = deps.projectContextManager.getOrCreate(params[1]);
			if (!ctx) { json({ error: "Project not found" }, 404); return; }
			const defaults = ctx.projectConfigStore.getDefaults();
			const result: Record<string, { value: unknown; source: string }> = {};
			for (const key of Object.keys(defaults)) {
				result[key] = resolveScalarConfig(key, ctx.projectConfigStore, deps.projectConfigStore, null, defaults);
			}
			const rawConfig = ctx.projectConfigStore.getAll();
			for (const key of Object.keys(rawConfig)) {
				if (!(key in result)) {
					result[key] = { value: rawConfig[key], source: "project" };
				}
			}
			const serverRaw = deps.projectConfigStore.getAll();
			for (const key of Object.keys(serverRaw)) {
				if (!(key in result)) {
					result[key] = { value: serverRaw[key], source: "server" };
				}
			}
			const migratedSource = (key: string): string => {
				return (rawConfig[key] !== undefined && rawConfig[key] !== "") ? "project"
					: (serverRaw[key] !== undefined && serverRaw[key] !== "") ? "server"
					: "default";
			};
			result.config_directories = { value: ctx.projectConfigStore.getConfigDirectories(), source: migratedSource("config_directories") };
			result.sandbox_tokens = { value: ctx.projectConfigStore.getSandboxTokens(), source: migratedSource("sandbox_tokens") };
			for (const k of LEGACY_QA_TOP_LEVEL_KEYS) delete result[k];
			if (Array.isArray(result.sandbox_tokens.value)) {
				const tempConfig: Record<string, unknown> = { sandbox_tokens: result.sandbox_tokens.value };
				mergeSecretsIntoTokens(tempConfig, ctx.secretsStore);
				result.sandbox_tokens = { value: tempConfig.sandbox_tokens, source: result.sandbox_tokens.source };
			}
			json(redactSandboxSecretsResolved(result));
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/projects\/([^/]+)\/config$/,
		handler: ({ deps, params, json }) => {
			const ctx = deps.projectContextManager.getOrCreate(params[1]);
			if (!ctx) { json({ error: "Project not found" }, 404); return; }
			const flat = ctx.projectConfigStore.getAll();
			const config: Record<string, unknown> = { ...flat };
			config.config_directories = ctx.projectConfigStore.getConfigDirectories();
			config.sandbox_tokens = ctx.projectConfigStore.getSandboxTokens();
			for (const k of LEGACY_QA_TOP_LEVEL_KEYS) delete config[k];
			mergeSecretsIntoTokens(config, ctx.secretsStore);
			json(redactSandboxSecrets(config));
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/projects\/([^/]+)\/qa-testing-config$/,
		handler: ({ deps, params, json }) => {
			const ctx = deps.projectContextManager.getOrCreate(params[1]);
			if (!ctx) { json({ error: "Project not found" }, 404); return; }
			json({ configured: ctx.projectConfigStore.isQaConfiguredOnAnyComponent() });
		},
	},
];
