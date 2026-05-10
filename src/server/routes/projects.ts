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
import { LEGACY_QA_TOP_LEVEL_KEYS, validateComponentsConfig } from "../agent/project-config-store.js";
import {
	mergeSecretsIntoTokens,
	mergeSandboxTokensStructured,
	mergeSandboxSecrets,
	redactSandboxSecrets,
	redactSandboxSecretsResolved,
} from "../agent/sandbox-secrets.js";
import { isGitRepo, getRepoRoot } from "../skills/git.js";
import { SymlinkProjectRootError } from "../agent/project-registry.js";
import type { Route } from "./types.js";

export const projectsRoutes: Route[] = [
	{
		method: "POST",
		pattern: "/api/projects",
		handler: async ({ deps, readBody, json, jsonError }) => {
			const { projectRegistry, projectContextManager, sessionManager } = deps;
			const body = await readBody();
			if (typeof body?.name !== "string" || typeof body?.rootPath !== "string") {
				json({ error: "Missing name or rootPath" }, 400);
				return;
			}
			{
				const err = validateComponentsConfig((body as Record<string, unknown>).components);
				if (err) { json({ error: err }, 400); return; }
			}
			try {
				const upsert = body.upsert === true;
				const color = typeof body.color === "string" ? body.color : undefined;
				const palette = typeof body.palette === "string" ? body.palette : undefined;
				const colorLight = typeof body.colorLight === "string" ? body.colorLight : undefined;
				const colorDark = typeof body.colorDark === "string" ? body.colorDark : undefined;

				if (upsert) {
					const existing = projectRegistry.getByPath(body.rootPath);
					if (existing) {
						const ctx = projectContextManager.getOrCreate(existing.id);
						if (ctx) {
							ctx.gateStore.onStatusChange = () => {
								ctx.goalStore.bumpGeneration();
							};
							ctx.goalManager.setPoolResolver(() => sessionManager.getWorktreePool(existing.id));
							ctx.goalManager.setComponentsResolver((pid: string) => {
								const c = projectContextManager.getOrCreate(pid);
								return c ? c.projectConfigStore.getComponents() : [];
							});
							ctx.goalManager.setProjectRootResolver((pid: string) => projectRegistry.get(pid)?.rootPath);
							ctx.goalManager.setWorktreeRootResolver((pid: string) => {
								const c = projectContextManager.getOrCreate(pid);
								return c?.projectConfigStore.get("worktree_root") || undefined;
							});
						}
						json(existing, 200);
						return;
					}
				}

				const acceptCanonical = body.acceptCanonical === true;
				let project;
				try {
					project = projectRegistry.register(body.name, body.rootPath, { color, palette, colorLight, colorDark, acceptCanonical });
				} catch (regErr: any) {
					if (regErr instanceof SymlinkProjectRootError) {
						json({
							error: "Project root is a symlink",
							code: "symlink_root",
							rootPath: regErr.rootPath,
							canonical: regErr.canonical,
						}, 400);
						return;
					}
					throw regErr;
				}
				const newCtx = projectContextManager.getOrCreate(project.id);
				if (newCtx) {
					newCtx.gateStore.onStatusChange = () => {
						newCtx.goalStore.bumpGeneration();
					};
				}

				const createComponents = (body as Record<string, unknown>).components;
				const createWorkflows = (body as Record<string, unknown>).workflows;
				if (newCtx) {
					if (Array.isArray(createComponents) && createComponents.length > 0) {
						if (createWorkflows && typeof createWorkflows === "object" && !Array.isArray(createWorkflows)) {
							try {
								const { validateAllWorkflows } = await import("../agent/workflow-validator.js");
								const errors = validateAllWorkflows(
									createWorkflows as Parameters<typeof validateAllWorkflows>[0],
									createComponents as Parameters<typeof validateAllWorkflows>[1],
								);
								if (errors.length > 0) {
									projectRegistry.remove(project.id);
									json({ error: "Workflow validation failed", details: errors }, 400);
									return;
								}
							} catch { /* best-effort */ }
						}
						const normalized = (createComponents as Array<Record<string, unknown>>).map(c => ({
							name: String(c.name ?? ""),
							repo: typeof c.repo === "string" && c.repo ? c.repo : ".",
							relativePath: typeof c.relative_path === "string" ? c.relative_path : (typeof c.relativePath === "string" ? c.relativePath as string : undefined),
							worktreeSetupCommand: typeof c.worktree_setup_command === "string" ? c.worktree_setup_command : (typeof c.worktreeSetupCommand === "string" ? c.worktreeSetupCommand as string : undefined),
							commands: c.commands && typeof c.commands === "object" && !Array.isArray(c.commands) ? c.commands as Record<string, string> : undefined,
							config: c.config && typeof c.config === "object" && !Array.isArray(c.config) ? c.config as Record<string, string> : undefined,
						}));
						newCtx.projectConfigStore.setComponents(normalized);
						if (createWorkflows && typeof createWorkflows === "object" && !Array.isArray(createWorkflows)) {
							newCtx.projectConfigStore.setWorkflows(createWorkflows as Record<string, import("../agent/project-config-store.js").InlineWorkflowDef>);
						}
					} else {
						if (newCtx.projectConfigStore.getComponents().length === 0) {
							newCtx.projectConfigStore.setComponents([{ name: project.name, repo: "." }]);
						}
					}
				}
				if (!process.env.BOBBIT_SKIP_WORKTREE_POOL) {
					try {
						const components = newCtx?.projectConfigStore.getComponents() ?? [];
						const isMulti = components.some(c => c.repo !== ".");
						let poolReady = false;
						if (isMulti) {
							const seen = new Set<string>();
							poolReady = true;
							for (const c of components) {
								if (c.repo === "." || seen.has(c.repo)) continue;
								seen.add(c.repo);
								if (!(await isGitRepo(path.join(body.rootPath, c.repo)))) { poolReady = false; break; }
							}
						} else {
							poolReady = await isGitRepo(body.rootPath);
						}
						if (poolReady) {
							const poolSize = parseInt(newCtx?.projectConfigStore.get("worktree_pool_size") || "2", 10) || 2;
							const wtRoot = newCtx?.projectConfigStore.get("worktree_root") || undefined;
							const pcs = newCtx?.projectConfigStore;
							const poolRepoPath = isMulti ? body.rootPath : await getRepoRoot(body.rootPath);
							sessionManager.initWorktreePoolForProject(project.id, poolRepoPath, pcs ? () => pcs.getComponents() : undefined, poolSize, wtRoot);
						}
					} catch { /* best-effort */ }
				}
				if (newCtx) {
					newCtx.goalManager.setPoolResolver(() => sessionManager.getWorktreePool(project.id));
					newCtx.goalManager.setComponentsResolver((pid: string) => {
						const c = projectContextManager.getOrCreate(pid);
						return c ? c.projectConfigStore.getComponents() : [];
					});
					newCtx.goalManager.setProjectRootResolver((pid: string) => projectRegistry.get(pid)?.rootPath);
					newCtx.goalManager.setWorktreeRootResolver((pid: string) => {
						const c = projectContextManager.getOrCreate(pid);
						return c?.projectConfigStore.get("worktree_root") || undefined;
					});
				}
				json(project, 201);
			} catch (err: any) {
				jsonError(400, err);
			}
		},
	},
	{
		method: "PUT",
		pattern: /^\/api\/projects\/([^/]+)\/config$/,
		handler: async ({ deps, params, readBody, json }) => {
			const ctx = deps.projectContextManager.getOrCreate(params[1]);
			if (!ctx) { json({ error: "Project not found" }, 404); return; }
			const body = await readBody();
			if (!body || typeof body !== "object") { json({ error: "Missing body" }, 400); return; }

			for (const key of LEGACY_QA_TOP_LEVEL_KEYS) {
				if (key in (body as Record<string, unknown>)) {
					json({ error: `${key} settings have moved to components[].config[]; set components[<name>].config.${key} instead` }, 400);
					return;
				}
			}

			{
				const err = validateComponentsConfig((body as Record<string, unknown>).components);
				if (err) { json({ error: err }, 400); return; }
			}

			let components = (body as Record<string, unknown>).components;
			const workflows = (body as Record<string, unknown>).workflows;
			delete (body as Record<string, unknown>).components;
			delete (body as Record<string, unknown>).workflows;

			if (!Array.isArray(components)) {
				const LEGACY_KEY_MAP: Record<string, string> = {
					build_command: "build",
					test_command: "test",
					typecheck_command: "check",
					test_unit_command: "unit",
					test_e2e_command: "e2e",
				};
				const legacyCmds: Record<string, string> = {};
				for (const [legacyKey, newKey] of Object.entries(LEGACY_KEY_MAP)) {
					const v = (body as Record<string, unknown>)[legacyKey];
					if (typeof v === "string" && v.trim().length > 0) legacyCmds[newKey] = v.trim();
				}
				const legacyHook = (body as Record<string, unknown>).worktree_setup_command;
				const hasAnyLegacy = Object.keys(legacyCmds).length > 0
					|| (typeof legacyHook === "string" && legacyHook.trim().length > 0);
				if (hasAnyLegacy) {
					const existing = ctx.projectConfigStore.getComponents();
					const defaultName = existing[0]?.name || ctx.project.name || "default";
					const defaultRepo = existing[0]?.repo || ".";
					const mergedCommands = { ...(existing[0]?.commands ?? {}), ...legacyCmds };
					const defaultComponent: Record<string, unknown> = {
						name: defaultName,
						repo: defaultRepo,
						commands: mergedCommands,
					};
					if (existing[0]?.relativePath) defaultComponent.relative_path = existing[0].relativePath;
					const hookValue = (typeof legacyHook === "string" && legacyHook.trim().length > 0)
						? legacyHook.trim()
						: existing[0]?.worktreeSetupCommand;
					if (hookValue) defaultComponent.worktree_setup_command = hookValue;
					if (existing[0]?.config && Object.keys(existing[0].config).length > 0) {
						defaultComponent.config = { ...existing[0].config };
					}
					const remaining = existing.slice(1).map(c => {
						const entry: Record<string, unknown> = { name: c.name, repo: c.repo };
						if (c.relativePath) entry.relative_path = c.relativePath;
						if (c.worktreeSetupCommand) entry.worktree_setup_command = c.worktreeSetupCommand;
						if (c.commands) entry.commands = c.commands;
						if (c.config && Object.keys(c.config).length > 0) entry.config = { ...c.config };
						return entry;
					});
					components = [defaultComponent, ...remaining];
				}
			}

			for (const [key] of Object.entries(body)) {
				if (key.includes(".")) {
					json({ error: `Config key "${key}" must not contain dots` }, 400);
					return;
				}
			}

			if (components && workflows && Array.isArray(components) && typeof workflows === "object") {
				try {
					const { validateAllWorkflows } = await import("../agent/workflow-validator.js");
					const errors = validateAllWorkflows(
						workflows as Parameters<typeof validateAllWorkflows>[0],
						components as Parameters<typeof validateAllWorkflows>[1],
					);
					if (errors.length > 0) {
						json({ error: "Workflow validation failed", details: errors }, 400);
						return;
					}
				} catch (err) {
					console.warn("[server] workflow validation skipped:", err);
				}
			}

			const migratedExtracted: Record<string, unknown> = {};
			const MIGRATED_FIELDS = [
				{ key: "config_directories", expect: "array" as const },
				{ key: "sandbox_tokens", expect: "array" as const },
			];
			for (const { key, expect } of MIGRATED_FIELDS) {
				if (!(key in body)) continue;
				const v = (body as Record<string, unknown>)[key];
				if (v === null || v === "") {
					migratedExtracted[key] = null;
					delete (body as Record<string, unknown>)[key];
					continue;
				}
				if (typeof v === "string") {
					json({ error: `Field "${key}" must be sent as a structured ${expect}, not a JSON-encoded string` }, 400);
					return;
				}
				if (expect === "array" && !Array.isArray(v)) {
					json({ error: `Field "${key}" must be an array` }, 400);
					return;
				}
				migratedExtracted[key] = v;
				delete (body as Record<string, unknown>)[key];
			}

			if (Array.isArray(migratedExtracted.sandbox_tokens)) {
				migratedExtracted.sandbox_tokens = mergeSandboxTokensStructured(
					migratedExtracted.sandbox_tokens as Array<{ key: string; enabled?: boolean; value?: string }>,
					ctx.secretsStore,
				);
			}
			mergeSandboxSecrets(body as Record<string, string>, ctx.projectConfigStore, ctx.secretsStore);

			for (const [key, value] of Object.entries(body)) {
				if (value === null || value === "") {
					ctx.projectConfigStore.remove(key);
				} else if (typeof value === "string") {
					ctx.projectConfigStore.set(key, value);
				}
			}

			if ("config_directories" in migratedExtracted) {
				const v = migratedExtracted.config_directories;
				if (v === null) {
					ctx.projectConfigStore.remove("config_directories");
				} else if (Array.isArray(v)) {
					ctx.projectConfigStore.setConfigDirectories(
						v.filter((e: any) => e && typeof e === "object" && typeof e.path === "string").map((e: any) => ({
							path: String(e.path),
							types: Array.isArray(e.types) ? e.types.filter((t: unknown): t is string => typeof t === "string") : [],
						})),
					);
				}
			}
			if ("sandbox_tokens" in migratedExtracted) {
				const v = migratedExtracted.sandbox_tokens;
				if (v === null) {
					ctx.projectConfigStore.remove("sandbox_tokens");
				} else if (Array.isArray(v)) {
					ctx.projectConfigStore.setSandboxTokens(
						v.filter((e: any) => e && typeof e === "object" && typeof e.key === "string").map((e: any) => ({
							key: String(e.key),
							enabled: e.enabled !== false,
						})),
					);
				}
			}

			if (Array.isArray(components)) {
				const normalized = (components as Array<Record<string, unknown>>).map(c => ({
					name: String(c.name ?? ""),
					repo: typeof c.repo === "string" && c.repo ? c.repo : ".",
					relativePath: typeof c.relative_path === "string" ? c.relative_path : (typeof c.relativePath === "string" ? c.relativePath as string : undefined),
					worktreeSetupCommand: typeof c.worktree_setup_command === "string" ? c.worktree_setup_command : (typeof c.worktreeSetupCommand === "string" ? c.worktreeSetupCommand as string : undefined),
					commands: c.commands && typeof c.commands === "object" && !Array.isArray(c.commands) ? c.commands as Record<string, string> : undefined,
					config: c.config && typeof c.config === "object" && !Array.isArray(c.config) ? c.config as Record<string, string> : undefined,
				}));
				ctx.projectConfigStore.setComponents(normalized);
			}
			if (workflows && typeof workflows === "object" && !Array.isArray(workflows)) {
				ctx.projectConfigStore.setWorkflows(workflows as Record<string, import("../agent/project-config-store.js").InlineWorkflowDef>);
			}

			json({ ok: true });
		},
	},
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
