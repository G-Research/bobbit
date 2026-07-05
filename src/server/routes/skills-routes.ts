// src/server/routes/skills-routes.ts
//
// F26 (propose_skill half) — the only skill-creation write path today; the
// Skills page (skills-page.ts) is read-only. Registered directly against the
// core route registry (mirrors workflows-routes.ts / roles-routes.ts) rather
// than added to handleApiRoute's legacy if/else chain, since it is new code
// on a codebase mid-migration to the route-registry pattern (STR-01/STR-05,
// docs/design/route-registry.md).
//
// POST /api/skills (scope-aware: body.projectId → write into that project's
// user-pack dir; Headquarters/omitted aliases server scope) writes
// skills/:name/SKILL.md via skill-write.ts, then busts the slash-skills
// discovery cache so the new skill resolves immediately.

import { bobbitConfigDir } from "../bobbit-dir.js";
import { invalidateSlashSkillsCache } from "../skills/slash-skills.js";
import { writeSkillFile } from "../skills/skill-write.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

async function handleSkillsCreate(ctx: CoreRouteCtx): Promise<void> {
	const { req, json, jsonError, readBody, resolveRequiredConfigProjectScope, writeConfigProjectScopeError } = ctx;
	const body = await readBody(req);
	try {
		const resolvedScope = resolveRequiredConfigProjectScope(body?.projectId, { aliasSystem: true });
		if (!resolvedScope.ok) { writeConfigProjectScopeError(resolvedScope); return; }
		// No effectiveProjectId (Headquarters/system scope) ⇒ Headquarters'
		// own config dir, mirroring resolveRoleMutationTarget's server-scope
		// branch in roles-routes.ts.
		const configDir = resolvedScope.effectiveProjectId
			? (resolvedScope.context?.configDir ?? bobbitConfigDir())
			: bobbitConfigDir();
		const allowedTools = typeof body?.tools === "string"
			? body.tools.split(",").map((t: string) => t.trim()).filter(Boolean)
			: undefined;
		const { filePath } = await writeSkillFile(configDir, {
			name: body?.name,
			description: body?.description,
			content: body?.content,
			argumentHint: typeof body?.argumentHint === "string" ? body.argumentHint : undefined,
			allowedTools,
		});
		invalidateSlashSkillsCache();
		json({ name: body?.name, description: body?.description, filePath }, 201);
	} catch (err: any) {
		jsonError(400, err);
	}
}

export function registerSkillsRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("POST", "/api/skills", handleSkillsCreate);
}
