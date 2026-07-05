// src/server/routes/projects-routes.ts
//
// STR-01 cohort 1: the `/api/projects*` CRUD + preflight/detect/scan/promote/
// base-ref-detect route family, migrated out of handleApiRoute's legacy
// if/else chain into the core route registry (src/server/routes/route-table.ts).
// See docs/design/route-registry.md.
//
// Mechanical extraction — every handler body below is byte-for-byte the same
// logic as the `if (url.pathname === ... )` block it replaced in server.ts,
// with only the following mechanical substitutions:
//   - `url.pathname.match(...)[1]` (etc.) → the registry's named `params.id`
//     (the route pattern itself, e.g. "/api/projects/:id/promote", now
//     states the capture explicitly instead of a hand-written regex).
//   - free variables that used to be handleApiRoute's own params/closures
//     (json, jsonError, readBody, sessionManager, projectRegistry, ...) are
//     destructured from `ctx` (see core-route-ctx.ts for why some of these
//     are passed through by reference rather than imported directly).
// Zero behavior change: same auth (handled upstream of handleApiRoute,
// untouched), same validation, same status codes, same error shapes.
//
// NOT migrated in this cohort (still in the legacy chain): the huge
// GET/PUT /api/projects/:id/config(/defaults|/resolved) handler (own review
// unit — far larger and riskier than the rest of this family) and the
// unrelated /api/create-directory, /api/browse-directory, and
// /api/projects/:id/qa-testing-config routes that are lexically interleaved
// with this family in server.ts but are not part of it.

import fs from "node:fs";
import path from "node:path";
import type { RouteTable } from "./route-table.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import { runPreflight } from "../agent/project-preflight.js";
import { archiveProjectBobbitDir, ArchiveError, GATEWAY_OWNED_FILES } from "../agent/bobbit-archive.js";
import { SymlinkProjectRootError, PreflightFailedError, ProjectOrderError, HEADQUARTERS_PROJECT_ID, assertNormalMutableProject } from "../agent/project-registry.js";
import { getRepoRoot, isGitRepo, detectBaseRefFromRemote, resolveBaseRef, parseBaseRef } from "../skills/git.js";
import { getProjectRoot, bobbitDir } from "../bobbit-dir.js";

/**
 * Resolve the repo path `base-ref/detect` should inspect: the primary
 * (first non-"." `repo`) component for a multi-repo project, or the git
 * toplevel of `rootPath` for a single-repo project. Returns null when
 * unresolvable (caller falls back to the stored value only). Used ONLY by
 * `GET /api/projects/:id/base-ref/detect` — moved here verbatim (previously
 * a private module-level helper in server.ts) since it has no other caller.
 */
async function resolveBaseRefDetectRepoPath(rootPath: string, comps: Array<{ repo: string }>): Promise<string | null> {
	const isMultiRepo = comps.some(c => c.repo !== ".");
	const primaryRepoPath = isMultiRepo
		? path.join(rootPath, comps.find(c => c.repo !== ".")?.repo ?? ".")
		: rootPath;
	if (!(await isGitRepo(primaryRepoPath).catch(() => false))) return null;
	return isMultiRepo ? primaryRepoPath : await getRepoRoot(primaryRepoPath);
}

// GET /api/projects/preflight?path=<absolute>
// Returns a structured PreflightReport — always 200 when path is
// supplied; the failures are *the* response. 400 only for missing /
// bad-shape input.
async function handleProjectsPreflight(ctx: CoreRouteCtx): Promise<void> {
	const { url, json, jsonError, projectRegistry, projectContextManager } = ctx;
	const rawPath = url.searchParams.get("path");
	if (!rawPath || typeof rawPath !== "string") {
		json({ error: "Missing path query parameter" }, 400);
		return;
	}
	try {
		const report = runPreflight(rawPath, {
			registeredProjects: projectRegistry.list(),
			gatewayProjectRoot: getProjectRoot(),
			worktreeRootFor: (p) => {
				const c = projectContextManager.getOrCreate(p.id);
				return c?.projectConfigStore.get("worktree_root") || undefined;
			},
		});
		if (ctx.isHeadquartersOwnedPath(rawPath)) {
			for (const check of report.checks) {
				if (check.remediation?.kind === "archive-bobbit") delete check.remediation;
				if (check.id === "bobbit.existing") {
					check.title = "Server .bobbit/ belongs to Headquarters";
					check.detail = "Headquarters already represents this server workspace. Its .bobbit/ state is gateway-owned and cannot be archived from Add Project.";
				}
				if (check.id === "bobbit.gateway-owned") {
					check.title = "Headquarters workspace";
					check.detail = "Headquarters already represents the running gateway's server workspace.";
				}
			}
		}
		json(report);
	} catch (err: any) {
		jsonError(500, err);
	}
}

// POST /api/projects/archive-bobbit
// Body: { rootPath }. Moves existing project-scoped .bobbit/ content
// aside into .bobbit-archive-NNN/ — never touching the
// GATEWAY_OWNED_FILES allowlist. Does NOT mutate the registry; the
// client re-runs /preflight afterwards.
async function handleProjectsArchiveBobbit(ctx: CoreRouteCtx): Promise<void> {
	const { req, json, jsonError, readBody } = ctx;
	const body = await readBody(req);
	if (!body || typeof body.rootPath !== "string") {
		json({ error: "Missing rootPath" }, 400);
		return;
	}
	if (!path.isAbsolute(body.rootPath)) {
		json({ error: "rootPath must be absolute" }, 400);
		return;
	}
	if (!fs.existsSync(body.rootPath)) {
		json({ error: "rootPath does not exist" }, 400);
		return;
	}
	if (ctx.isHeadquartersOwnedPath(body.rootPath)) {
		json({
			error: "Headquarters owns the server .bobbit state. Hide Headquarters from project lists in Settings instead of archiving it.",
			code: "HEADQUARTERS_IMMUTABLE",
		}, 403);
		return;
	}
	// Compute gateway-owned via the same logic as the preflight check.
	const sameAsGateway = path.resolve(body.rootPath) === path.resolve(getProjectRoot());
	const hasGwUrl = fs.existsSync(path.join(body.rootPath, ".bobbit", "state", "gateway-url"));
	const hasWatchdog = fs.existsSync(path.join(body.rootPath, ".bobbit", "state", "watchdog.json"));
	const gatewayOwned = sameAsGateway || hasGwUrl || hasWatchdog;
	// Preserve the Headquarters/server workspace directory when it lives
	// inside this project's `.bobbit/`. The default is `.bobbit/headquarters`,
	// but a `BOBBIT_DIR`/`BOBBIT_PI_DIR` override (e.g. `.bobbit/custom-hq`)
	// moves it — archiving a normal same-root project's `.bobbit` must never
	// move or delete server/HQ state, so preserve the ACTUAL directory by its
	// real relative segment, not just the literal `headquarters/` name.
	const rootBobbitDir = path.join(body.rootPath, ".bobbit");
	const preserveEntries: string[] = [];
	if (fs.existsSync(path.join(rootBobbitDir, "headquarters"))) preserveEntries.push("headquarters/");
	try {
		const realRootBobbit = fs.realpathSync(rootBobbitDir);
		const actualHqDir = bobbitDir();
		if (fs.existsSync(actualHqDir)) {
			const rel = path.relative(realRootBobbit, fs.realpathSync(actualHqDir));
			if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
				const entry = rel.replace(/\\/g, "/") + "/";
				if (!preserveEntries.includes(entry)) preserveEntries.push(entry);
			}
		}
	} catch { /* .bobbit or HQ dir missing — fall back to default headquarters/ preservation */ }
	const allowlistEntries = [
		...(gatewayOwned ? GATEWAY_OWNED_FILES : []),
		...preserveEntries,
	];
	const allowlist = allowlistEntries.length > 0 ? allowlistEntries : undefined;
	try {
		const result = archiveProjectBobbitDir(body.rootPath, { gatewayOwned, ...(allowlist ? { allowlist } : {}) });
		json(result);
	} catch (err: any) {
		if (err instanceof ArchiveError) {
			const status = err.code === "empty-bobbit-dir" || err.code === "no-bobbit-dir" ? 409 : 400;
			json({ error: err.message, code: err.code }, status);
			return;
		}
		jsonError(500, err);
	}
}

// POST /api/projects/detect
async function handleProjectsDetect(ctx: CoreRouteCtx): Promise<void> {
	const { req, json, readBody } = ctx;
	const body = await readBody(req);
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
				// Source of truth: a configured project is one with .bobbit/config/project.yaml.
				// Mere presence of an empty .bobbit/ (e.g. post-archive shape, ghost dirs) must NOT
				// route the add-project flow to auto-import. See goal: Post-archive → assistant.
				hasBobbit = fs.existsSync(path.join(dirPath, ".bobbit", "config", "project.yaml"));
				hasPackageJson = entries.includes("package.json");
				hasCargoToml = entries.includes("Cargo.toml");
				hasGoMod = entries.includes("go.mod");

				// Try to read name from package.json
				if (hasPackageJson) {
					try {
						const pkg = JSON.parse(fs.readFileSync(path.join(dirPath, "package.json"), "utf-8"));
						if (typeof pkg.name === "string" && pkg.name) {
							name = pkg.name;
						}
					} catch {
						// Ignore parse errors — fall back to directory basename
					}
				}
			} else {
				// Path exists but is not a directory
				json({ error: "Path is not a directory" }, 400);
				return;
			}
		} catch {
			// stat failed — treat as non-existent
			json({ exists: false, hasBobbit: false, isEmpty: true, hasPackageJson: false, hasCargoToml: false, hasGoMod: false, name });
			return;
		}
	}

	json({ exists, hasBobbit, isEmpty, hasPackageJson, hasCargoToml, hasGoMod, name });
}

// POST /api/projects/scan?path=...  → run repo-scan on a folder.
// Returns { repos: DetectedRepo[] }. Used by the Add-Project flow and
// Settings → "Re-scan repos". Phase 4b — see docs/design/multi-repo-components.md §8.1.
async function handleProjectsScan(ctx: CoreRouteCtx): Promise<void> {
	const { req, url, json, jsonError, readBody } = ctx;
	const body = await readBody(req).catch(() => ({}));
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
}

// GET /api/projects/:id/structured  → returns { components, workflows,
// worktree_root } in their structured (non-string) shape. Used by the
// Settings → Components tab so the UI doesn't have to parse YAML.
// Phase 4b.
async function handleProjectStructured(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, projectContextManager } = ctx;
	const c = projectContextManager.getOrCreate(params.id);
	if (!c) { json({ error: "Project not found" }, 404); return; }
	const components = c.projectConfigStore.getComponents();
	const workflows = c.projectConfigStore.getWorkflows() ?? {};
	const worktreeRoot = c.projectConfigStore.get("worktree_root") ?? "";
	json({ components, workflows, worktree_root: worktreeRoot });
}

// POST /api/projects/:id/rescan-repos  → re-run repo-scan on the
// project's rootPath; returns the same shape as /api/projects/scan.
// Settings "Re-scan repos" button. Phase 4b.
async function handleProjectRescanRepos(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, jsonError, projectRegistry } = ctx;
	const project = projectRegistry.get(params.id);
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
}

// GET /api/projects
async function handleProjectsList(ctx: CoreRouteCtx): Promise<void> {
	ctx.json(ctx.listProjectsForApi());
}

// POST /api/projects
async function handleProjectsCreate(ctx: CoreRouteCtx): Promise<void> {
	const { req, json, jsonError, readBody, projectRegistry, projectContextManager, sessionManager } = ctx;
	const body = await readBody(req);
	if (typeof body?.name !== "string" || typeof body?.rootPath !== "string") {
		json({ error: "Missing name or rootPath" }, 400);
		return;
	}
	// Validate components[].config eagerly (mirrors propose_project tool).
	{
		const err = ctx.validateComponentsConfig((body as Record<string, unknown>).components);
		if (err) { json({ error: err }, 400); return; }
	}
	try {
		const upsert = body.upsert === true;
		const color = typeof body.color === "string" ? body.color : undefined;
		const palette = typeof body.palette === "string" ? body.palette : undefined;
		const colorLight = typeof body.colorLight === "string" ? body.colorLight : undefined;
		const colorDark = typeof body.colorDark === "string" ? body.colorDark : undefined;

		if (ctx.isHeadquartersOwnedPath(body.rootPath)) {
			const hq = ctx.headquartersProject();
			if (hq && upsert) {
				const c = projectContextManager.getOrCreate(hq.id);
				if (c) {
					c.gateStore.onStatusChange = () => {
						c.goalStore.bumpGeneration();
					};
					ctx.wireGoalManagerResolvers(c, { sessionManager, projectContextManager, projectRegistry });
				}
				json(hq, 200);
				return;
			}
			json({
				error: "Headquarters already represents the server workspace. Hide it from project lists in Settings instead of adding it again.",
				code: "HEADQUARTERS_ALREADY_EXISTS",
				projectId: HEADQUARTERS_PROJECT_ID,
			}, 409);
			return;
		}

		// Upsert: if a project already exists at this path, return it
		if (upsert) {
			const existing = projectRegistry.getByPath(body.rootPath);
			if (existing) {
				// Ensure context is initialized
				const c = projectContextManager.getOrCreate(existing.id);
				if (c) {
					c.gateStore.onStatusChange = () => {
						c.goalStore.bumpGeneration();
					};
					ctx.wireGoalManagerResolvers(c, { sessionManager, projectContextManager, projectRegistry });
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
			if (regErr instanceof PreflightFailedError) {
				json({
					error: regErr.message,
					code: "preflight_failed",
					report: regErr.report,
				}, 400);
				return;
			}
			throw regErr;
		}
		// Initialize project context for the new project
		const newCtx = projectContextManager.getOrCreate(project.id);
		if (newCtx) {
			newCtx.gateStore.onStatusChange = () => {
				newCtx.goalStore.bumpGeneration();
			};
		}

		// Multi-repo: accept optional components / workflows in the create body.
		// Single-repo without components → fill default `[{name: <project name>, repo: "."}]`.
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
				// Default single-repo component named after the project.
				if (newCtx.projectConfigStore.getComponents().length === 0) {
					newCtx.projectConfigStore.setComponents([{ name: project.name, repo: "." }]);
				}
			}
			// No default-workflow seeding. Workflows must be designed by the
			// project assistant; a project may legitimately have zero workflows.
		}
		// Pin base_ref from the live remote so new projects never have a blank,
		// silently-resolved base. Best-effort: failures leave it blank (today's
		// behaviour). See docs/design/base-ref.md (add-time pinning).
		//
		// MUST run BEFORE worktree-pool init below: the pool's baseRefResolver
		// reads `base_ref` on each _fill()/startFilling(), so pinning the
		// concrete value first prevents early pool entries from being created
		// off the old `origin/HEAD` fallback.
		try {
			const cfg = newCtx?.projectConfigStore;
			if (cfg && !(cfg.get("base_ref") || "").trim()) {
				const comps = cfg.getComponents();
				const isMultiRepo = comps.some(c => c.repo !== ".");
				const primaryRepoPath = isMultiRepo
					? path.join(body.rootPath, comps.find(c => c.repo !== ".")?.repo ?? ".")
					: await getRepoRoot(body.rootPath);
				const detected = await detectBaseRefFromRemote(primaryRepoPath);
				// Only pin when the detected ref is grammar-valid AND present in
				// every component repo — otherwise a manual save would reject it
				// and it could break worktree creation for the lacking component.
				if (
					detected
					&& ctx.isValidBaseRefBranchGrammar(detected)
					&& (await ctx.detectedRefExistsInAllComponents(body.rootPath, comps, detected))
				) {
					cfg.set("base_ref", detected);
				}
			}
		} catch { /* best-effort — leave base_ref blank */ }
		// Initialize worktree pool if the new project is a git repo.
		// Respect BOBBIT_SKIP_WORKTREE_POOL for E2E/CI.
		if (!process.env.BOBBIT_SKIP_WORKTREE_POOL) {
			try {
				// Multi-repo: rootPath is a container dir, individual repos sit
				// under <rootPath>/<repo>/. We treat that case as "git-ready" if
				// every declared repo subdir is a git repo.
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
					// Single-repo: resolve nested rootPath to the actual git toplevel so
					// pool entries land under <gitRoot>-wt/, not <projectDir>-wt/.
					const poolRepoPath = isMulti ? body.rootPath : await getRepoRoot(body.rootPath);
					sessionManager.initWorktreePoolForProject(project.id, poolRepoPath, pcs ? () => pcs.getComponents() : undefined, poolSize, wtRoot, pcs ? () => pcs.get("base_ref") : undefined, pcs ? () => pcs.get("worktree_setup_timeout_ms") || undefined : undefined, project.rootPath);
				}
			} catch { /* best-effort */ }
		}
		// Wire the goal-manager pool resolver for the new project (Phase 3 — goals via pool).
		if (newCtx) {
			ctx.wireGoalManagerResolvers(newCtx, { sessionManager, projectContextManager, projectRegistry });
		}
		json(project, 201);
	} catch (err: any) {
		jsonError(400, err);
	}
}

// PUT /api/projects/order
async function handleProjectsOrder(ctx: CoreRouteCtx): Promise<void> {
	const { req, json, jsonError, readBody, projectRegistry, broadcastToAll } = ctx;
	const body = await readBody(req);
	try {
		projectRegistry.setVisibleOrder(body?.projectIds);
		const projects = ctx.listProjectsForApi();
		broadcastToAll({ type: "projects_changed", projects });
		json({ projects });
	} catch (err: any) {
		if (err instanceof ProjectOrderError || err?.code === "invalid_project_order" || err?.code === "stale_project_order") {
			const code = err?.code === "stale_project_order" ? "stale_project_order" : "invalid_project_order";
			const payload: Record<string, unknown> = {
				error: err?.message || "Invalid project order",
				code,
			};
			if (Array.isArray(err?.details?.expectedProjectIds)) payload.expectedProjectIds = err.details.expectedProjectIds;
			if (Array.isArray(err?.details?.receivedProjectIds)) payload.receivedProjectIds = err.details.receivedProjectIds;
			json(payload, code === "stale_project_order" ? 409 : 400);
		} else {
			jsonError(400, err);
		}
	}
}

// GET /api/projects/:id
async function handleProjectGet(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, projectRegistry } = ctx;
	const project = projectRegistry.get(params.id);
	if (!project) { json({ error: "Project not found" }, 404); return; }
	json(project);
}

// PUT /api/projects/:id
async function handleProjectUpdate(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { req, json, jsonError, readBody, projectRegistry } = ctx;
	const body = await readBody(req);
	const updates: { name?: string; color?: string; rootPath?: string; palette?: string; colorLight?: string; colorDark?: string } = {};
	if (typeof body?.name === "string") updates.name = body.name;
	if (typeof body?.color === "string") updates.color = body.color;
	if (typeof body?.rootPath === "string") updates.rootPath = body.rootPath;
	if (typeof body?.palette === "string" || body?.palette === null || body?.palette === "") updates.palette = body.palette ?? "";
	if (typeof body?.colorLight === "string") updates.colorLight = body.colorLight;
	if (typeof body?.colorDark === "string") updates.colorDark = body.colorDark;
	if (updates.rootPath && ctx.isHeadquartersOwnedPath(updates.rootPath)) {
		json({
			error: "Headquarters already represents the server workspace. Select Headquarters instead of moving another project to it.",
			code: "HEADQUARTERS_ALREADY_EXISTS",
			projectId: HEADQUARTERS_PROJECT_ID,
		}, 409);
		return;
	}
	try {
		const updated = projectRegistry.update(params.id, updates);
		json(updated);
	} catch (err: any) {
		if (ctx.writeSpecialProjectMutationError(err)) return;
		jsonError(400, err);
	}
}

// DELETE /api/projects/:id
//
// Any project may be removed, including the last visible one. When zero
// non-hidden projects remain the UI falls back to the existing
// zero-project first-run state (see GR-09 / splash-no-projects spec).
async function handleProjectDelete(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, jsonError, projectRegistry, projectContextManager, sessionManager } = ctx;
	const projectId = params.id;
	const project = projectRegistry.get(projectId);
	try {
		if (project) assertNormalMutableProject(project, "removed");
		// Drain the project's worktree pool before removing
		await sessionManager.removeWorktreePool(projectId);
		// Terminate all live sessions belonging to the removed project
		const liveSessions = sessionManager.listSessions().filter(s => s.projectId === projectId);
		for (const s of liveSessions) {
			try { await sessionManager.terminateSession(s.id); } catch {}
		}
		await sessionManager.cleanupScopedMcpManagersForProject(projectId, project?.rootPath);
		projectContextManager.remove(projectId);
		if (project?.provisional) {
			projectRegistry.removeProvisional(projectId);
		} else {
			projectRegistry.remove(projectId);
		}
		json({ ok: true });
	} catch (err: any) {
		if (ctx.writeSpecialProjectMutationError(err)) return;
		jsonError(400, err);
	}
}

// POST /api/projects/:id/promote
async function handleProjectPromote(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { req, json, jsonError, readBody, projectRegistry, projectContextManager } = ctx;
	const projectId = params.id;
	try {
		const body = await readBody(req);
		const name = typeof body?.name === "string" ? body.name : undefined;
		const promoted = projectRegistry.promote(projectId, { name });
		// Pin base_ref from the live remote (best-effort) now that the
		// promoted project's rootPath is a real git repo. Mirrors the
		// add-time pin in POST /api/projects. See docs/design/base-ref.md.
		try {
			const c = projectContextManager.getOrCreate(projectId);
			const rootPath = projectRegistry.get(projectId)?.rootPath;
			const cfg = c?.projectConfigStore;
			if (cfg && rootPath && !(cfg.get("base_ref") || "").trim()) {
				const comps = cfg.getComponents();
				const isMultiRepo = comps.some(c2 => c2.repo !== ".");
				const primaryRepoPath = isMultiRepo
					? path.join(rootPath, comps.find(c2 => c2.repo !== ".")?.repo ?? ".")
					: await getRepoRoot(rootPath);
				const detected = await detectBaseRefFromRemote(primaryRepoPath);
				// Pin only if the detected ref exists in every component repo
				// (mirrors save-time validation). See POST /api/projects above.
				if (
					detected
					&& ctx.isValidBaseRefBranchGrammar(detected)
					&& (await ctx.detectedRefExistsInAllComponents(rootPath, comps, detected))
				) {
					cfg.set("base_ref", detected);
				}
			}
		} catch { /* best-effort — leave base_ref blank */ }
		json(promoted);
	} catch (err: any) {
		if (ctx.writeSpecialProjectMutationError(err)) return;
		jsonError(400, err);
	}
}

// GET /api/projects/:id/base-ref/detect — read-only resolver helper.
// Returns { resolved, detected }:
//   resolved = what worktrees actually branch off right now
//              (resolveBaseRef(primaryRepoPath, storedValue).ref)
//   detected = live `git ls-remote --symref origin HEAD` result, but ONLY
//              when it is saveable (passes the same grammar + cross-component
//              existence checks add-time pinning applies); otherwise null
//              (offline / no remote / not saveable). Guarantees any non-null
//              `detected` the UI fills can be saved without rejection.
// Scoped to the project's pool/primary repo (same selection as add-time
// pinning). No mutation. See docs/design/base-ref.md.
async function handleProjectBaseRefDetect(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, jsonError, projectContextManager, projectRegistry } = ctx;
	const c = projectContextManager.getOrCreate(params.id);
	const rootPath = projectRegistry.get(params.id)?.rootPath;
	if (!c || !rootPath) { json({ error: "Project not found" }, 404); return; }
	try {
		const cfg = c.projectConfigStore;
		const comps = cfg.getComponents();
		const primaryRepoPath = await resolveBaseRefDetectRepoPath(rootPath, comps);
		if (!primaryRepoPath) {
			const parsed = parseBaseRef(cfg.get("base_ref") || "");
			json({ resolved: parsed.ref || "", detected: null });
			return;
		}
		const resolved = (await resolveBaseRef(primaryRepoPath, cfg.get("base_ref"))).ref;
		// `detected` must be SAVEABLE — null it out unless it passes the same
		// checks add-time pinning applies (grammar + cross-component existence).
		// The Settings "Detect from remote" button fills this value, so a
		// non-saveable value here would be rejected by the normal Save path.
		let detected = await detectBaseRefFromRemote(primaryRepoPath);
		if (
			detected
			&& (!ctx.isValidBaseRefBranchGrammar(detected)
				|| !(await ctx.detectedRefExistsInAllComponents(rootPath, comps, detected)))
		) {
			detected = null;
		}
		json({ resolved, detected });
	} catch (err: any) {
		jsonError(400, err);
	}
}

// Collection-level / other-verb literal segments under /api/projects/ that
// must never be swallowed by the generic /api/projects/:id handlers below
// (mirrors the legacy `projectGetMatch` regex's negative lookahead —
// `/^\/api\/projects\/(?!(?:preflight|archive-bobbit|detect|scan|order)$)([^/]+)$/`
// — see tests/project-route-specificity.test.ts). Each of these already has
// its own exact registration for the method it's actually used with; this
// exclusion only matters for the OTHER methods on those same literal paths,
// which must fall through to the legacy chain's generic 404 exactly as
// before, not be swallowed by :id (e.g. `projectRegistry.get("order")`).
const RESERVED_PROJECTS_SEGMENTS = ["preflight", "archive-bobbit", "detect", "scan", "order"];

export function registerProjectRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("GET", "/api/projects/preflight", handleProjectsPreflight);
	table.register("POST", "/api/projects/archive-bobbit", handleProjectsArchiveBobbit);
	table.register("POST", "/api/projects/detect", handleProjectsDetect);
	table.register("POST", "/api/projects/scan", handleProjectsScan);
	table.register("GET", "/api/projects/:id/structured", handleProjectStructured);
	table.register("POST", "/api/projects/:id/rescan-repos", handleProjectRescanRepos);
	table.register("GET", "/api/projects", handleProjectsList);
	table.register("POST", "/api/projects", handleProjectsCreate);
	table.register("PUT", "/api/projects/order", handleProjectsOrder);
	const idOpts = { excludeParamValues: { id: RESERVED_PROJECTS_SEGMENTS } };
	table.register("GET", "/api/projects/:id", handleProjectGet, idOpts);
	table.register("PUT", "/api/projects/:id", handleProjectUpdate, idOpts);
	table.register("DELETE", "/api/projects/:id", handleProjectDelete, idOpts);
	table.register("POST", "/api/projects/:id/promote", handleProjectPromote);
	table.register("GET", "/api/projects/:id/base-ref/detect", handleProjectBaseRefDetect);
}
