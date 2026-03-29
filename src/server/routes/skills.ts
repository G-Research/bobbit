import http from "node:http";
import type { AppContext } from "../app-context.js";
import { discoverSlashSkills, getSkillDirectories } from "../skills/slash-skills.js";
import { json } from "./utils.js";

export async function handle(
	ctx: AppContext,
	url: URL,
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<boolean> {
	// GET /api/slash-skills — discover .claude/skills/ SKILL.md files for autocomplete
	if (url.pathname === "/api/slash-skills" && req.method === "GET") {
		const cwd = url.searchParams.get("cwd") || process.cwd();
		const skills = discoverSlashSkills(cwd, ctx.projectConfigStore);
		json(res, { skills: skills.map((s) => ({ name: s.name, description: s.description, argumentHint: s.argumentHint, source: s.source })) });
		return true;
	}

	// GET /api/slash-skills/details — full slash skill details including content and file paths
	if (url.pathname === "/api/slash-skills/details" && req.method === "GET") {
		const cwd = url.searchParams.get("cwd") || process.cwd();
		const skills = discoverSlashSkills(cwd, ctx.projectConfigStore);
		const directories = getSkillDirectories(cwd, ctx.projectConfigStore);
		json(res, { skills: skills.map((s) => ({ name: s.name, description: s.description, source: s.source, filePath: s.filePath, content: s.content })), directories });
		return true;
	}

	return false;
}
