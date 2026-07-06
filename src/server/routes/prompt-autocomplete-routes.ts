// src/server/routes/prompt-autocomplete-routes.ts
//
// STR-01 cohort 26: prompt autocomplete/read-only discovery routes migrated
// out of handleApiRoute's legacy if/else chain into the core route registry.
// See docs/design/route-registry.md.
//
// Mechanical extraction — handler bodies below preserve the legacy behavior,
// with only handleApiRoute locals destructured from ctx.
//
// LEGACY FALL-THROUGH PARITY: no unhandled-method shim needed. Every legacy
// block here gated on path and method in the same `if` condition. A method
// mismatch skipped the block and fell through to the terminal 404; RouteTable's
// method-scoped matching preserves that by leaving other methods unregistered.

import { resolveProjectForRequest, validateExecutionCwd, type CwdOwnershipSource } from "../agent/resolve-project.js";
import { enumerateFiles } from "../skills/file-enumeration.js";
import { discoverSlashSkills, getSkillDirectories } from "../skills/slash-skills.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

// GET /api/slash-skills — discover .claude/skills/ SKILL.md files for autocomplete
async function handleSlashSkills(ctx: CoreRouteCtx): Promise<void> {
	const { json, projectRegistry, resolveProjectConfigStore, resolveSkillDiscoveryCwd, skillMarketContext, url, writeProjectResolutionError } = ctx;
	const rawCwd = url.searchParams.get("cwd") || process.cwd();
	const projectId = url.searchParams.get("projectId") || undefined;
	const resolvedProject = resolveProjectForRequest(projectRegistry, { projectId });
	if (!resolvedProject.ok) { writeProjectResolutionError(resolvedProject); return; }
	const resolvedStore = resolveProjectConfigStore(resolvedProject.projectId);
	// For sandboxed sessions the cwd is a container-internal path (e.g. /workspace-wt/...).
	// Skill files live on the host, so resolve the project rootPath for discovery.
	const cwd = resolveSkillDiscoveryCwd(rawCwd, resolvedProject.projectId);
	const skills = discoverSlashSkills(cwd, resolvedStore, skillMarketContext(resolvedProject.projectId));
	json({ skills: skills.map((s) => ({ name: s.name, description: s.description, argumentHint: s.argumentHint, source: s.source, originPackId: s.originPackId ?? null, originPackName: s.originPackName ?? null })) });
	return;
}

// GET /api/file-mentions — bounded file enumeration for @-mention autocomplete.
// Includes gitignored/untracked files; excludes .git/node_modules/etc. (no .gitignore consulted).
async function handleFileMentions(ctx: CoreRouteCtx): Promise<void> {
	const {
		json,
		projectContextManager,
		projectRegistry,
		sessionManager,
		url,
		writeCwdValidationError,
		writeProjectResolutionError,
	} = ctx;
	const rawCwd = url.searchParams.get("cwd") || undefined;
	const sessionId = url.searchParams.get("sessionId") || undefined;
	const rawProjectId = url.searchParams.get("projectId") || undefined;
	const q = url.searchParams.get("q") || undefined;
	const limitRaw = url.searchParams.get("limit");
	const limitParsed = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
	const limit = limitParsed !== undefined && Number.isFinite(limitParsed) ? limitParsed : undefined;

	let resolvedProjectId: string;
	let cwd: string;
	let cwdSource: CwdOwnershipSource;
	if (sessionId) {
		const session = sessionManager.getSession(sessionId);
		const persisted = session
			? undefined
			: (sessionManager.getPersistedSession(sessionId) ?? projectContextManager.getContextForSession(sessionId)?.sessionStore.get(sessionId));
		if (!session && !persisted) {
			json({ error: `Session "${sessionId}" not found` }, 404);
			return;
		}
		const sessionProjectId = session?.projectId ?? persisted?.projectId;
		if (!sessionProjectId) {
			json({ error: "Session missing projectId", code: "PROJECT_ID_REQUIRED" }, 403);
			return;
		}
		if (rawProjectId && rawProjectId !== sessionProjectId) {
			json({ error: "projectId does not match session projectId", code: "PROJECT_SCOPE_MISMATCH" }, 422);
			return;
		}
		const resolvedProject = resolveProjectForRequest(projectRegistry, { projectId: sessionProjectId });
		if (!resolvedProject.ok) { writeProjectResolutionError(resolvedProject); return; }
		resolvedProjectId = resolvedProject.projectId;
		// Enumerate the session's HOST worktree, NOT the project root. The
		// project-root redirect (resolveSkillDiscoveryCwd) is correct for SKILL
		// discovery but wrong here: file mentions must see the goal/session
		// worktree's branch-local, untracked and gitignored files. worktreePath
		// is the host path; for sandboxed sessions cwd is a container path so
		// worktreePath is required.
		cwd = session?.worktreePath || persisted?.worktreePath || session?.cwd || persisted?.cwd || rawCwd || resolvedProject.project.rootPath;
		cwdSource = { kind: "session", sessionId };
	} else {
		const resolvedProject = resolveProjectForRequest(projectRegistry, { projectId: rawProjectId });
		if (!resolvedProject.ok) { writeProjectResolutionError(resolvedProject); return; }
		resolvedProjectId = resolvedProject.projectId;
		cwd = rawCwd || resolvedProject.project.rootPath;
		cwdSource = { kind: "user-input" };
	}

	const cwdValidation = validateExecutionCwd(projectRegistry, projectContextManager, resolvedProjectId, cwd, cwdSource);
	if (!cwdValidation.ok) { writeCwdValidationError(cwdValidation); return; }
	const files = await enumerateFiles(cwd, { query: q, limit });
	json({ files: files.map((p) => ({ path: p })) });
	return;
}

// GET /api/slash-skills/details — full slash skill details including content and file paths
async function handleSlashSkillDetails(ctx: CoreRouteCtx): Promise<void> {
	const { json, projectRegistry, resolveProjectConfigStore, resolveSkillDiscoveryCwd, skillMarketContext, url, writeProjectResolutionError } = ctx;
	const rawCwd = url.searchParams.get("cwd") || process.cwd();
	const projectId = url.searchParams.get("projectId") || undefined;
	const resolvedProject = resolveProjectForRequest(projectRegistry, { projectId });
	if (!resolvedProject.ok) { writeProjectResolutionError(resolvedProject); return; }
	const resolvedStore = resolveProjectConfigStore(resolvedProject.projectId);
	const cwd = resolveSkillDiscoveryCwd(rawCwd, resolvedProject.projectId);
	const skills = discoverSlashSkills(cwd, resolvedStore, skillMarketContext(resolvedProject.projectId));
	const directories = getSkillDirectories(cwd, resolvedStore);
	json({ skills: skills.map((s) => ({ name: s.name, description: s.description, source: s.source, filePath: s.filePath, content: s.content, originPackId: s.originPackId ?? null, originPackName: s.originPackName ?? null })), directories });
	return;
}

export function registerPromptAutocompleteRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("GET", "/api/slash-skills", handleSlashSkills);
	table.register("GET", "/api/file-mentions", handleFileMentions);
	table.register("GET", "/api/slash-skills/details", handleSlashSkillDetails);
}
