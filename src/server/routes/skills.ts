/**
 * Slash skills discovery routes.
 * Extracted from server.ts (commit: split server.ts).
 */
import { discoverSlashSkills, getSkillDirectories } from "../skills/slash-skills.js";
import { resolveProjectConfigStore, resolveSkillDiscoveryCwd } from "./cross-project.js";
import type { Route } from "./types.js";

export const skillsRoutes: Route[] = [
	{
		method: "GET",
		pattern: "/api/slash-skills",
		handler: ({ deps, url, json }) => {
			const rawCwd = url.searchParams.get("cwd") || process.cwd();
			const projectId = url.searchParams.get("projectId");
			const resolvedStore = resolveProjectConfigStore(deps, projectId);
			const cwd = resolveSkillDiscoveryCwd(deps, rawCwd, projectId);
			const skills = discoverSlashSkills(cwd, resolvedStore);
			json({ skills: skills.map((s) => ({ name: s.name, description: s.description, argumentHint: s.argumentHint, source: s.source })) });
		},
	},
	{
		method: "GET",
		pattern: "/api/slash-skills/details",
		handler: ({ deps, url, json }) => {
			const rawCwd = url.searchParams.get("cwd") || process.cwd();
			const projectId = url.searchParams.get("projectId");
			const resolvedStore = resolveProjectConfigStore(deps, projectId);
			const cwd = resolveSkillDiscoveryCwd(deps, rawCwd, projectId);
			const skills = discoverSlashSkills(cwd, resolvedStore);
			const directories = getSkillDirectories(cwd, resolvedStore);
			json({ skills: skills.map((s) => ({ name: s.name, description: s.description, source: s.source, filePath: s.filePath, content: s.content })), directories });
		},
	},
];
