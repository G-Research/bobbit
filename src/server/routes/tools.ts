/**
 * Tools CRUD + customize/override + tool-group-policies.
 * Extracted from server.ts (commit: split server.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bobbitConfigDir } from "../bobbit-dir.js";
import { copyDirRecursive } from "../agent/tool-manager.js";
import type { Route } from "./types.js";

/** Find which group subdirectory contains a tool by scanning YAML files. */
function findToolGroupDir(toolName: string, toolsDir: string): string | null {
	try {
		const entries = fs.readdirSync(toolsDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const groupPath = path.join(toolsDir, entry.name);
			try {
				const files = fs.readdirSync(groupPath);
				for (const file of files) {
					if (!file.endsWith(".yaml")) continue;
					try {
						const raw = fs.readFileSync(path.join(groupPath, file), "utf-8");
						if (raw.includes(`name: ${toolName}`) || raw.includes(`name: "${toolName}"`)) {
							const lines = raw.split("\n");
							for (const line of lines) {
								const m = line.match(/^name:\s*"?([^"\n]+)"?\s*$/);
								if (m && m[1].trim() === toolName) return entry.name;
							}
						}
					} catch { /* skip unreadable */ }
				}
			} catch { /* skip */ }
		}
	} catch { /* dir doesn't exist */ }
	return null;
}

const VALID_POLICIES = ['allow', 'ask', 'never', 'always-allow', 'ask-once', 'always-ask', 'never-ask'];

// Path to the bundled defaults/ dir at runtime — relative to this compiled file.
const builtinToolsDir = () => path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "defaults", "tools");

export const toolsRoutes: Route[] = [
	{
		method: "GET",
		pattern: "/api/tools",
		handler: ({ deps, url, json }) => {
			const projectId = url.searchParams.get("projectId") || undefined;
			const resolved = deps.configCascade.resolveTools(projectId);
			const tools: Array<Record<string, unknown>> = resolved.map(r => ({ ...r.item, origin: r.origin, ...(r.overrides ? { overrides: r.overrides } : {}) }));
			if (deps.toolManager) {
				const resolvedNames = new Set(resolved.map(r => r.item.name));
				for (const t of deps.toolManager.getAvailableTools()) {
					if (!resolvedNames.has(t.name)) {
						tools.push({ ...t, origin: "mcp" });
					}
				}
			}
			json({ tools });
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/tools\/([^/]+)\/customize$/,
		handler: ({ deps, params, url, json }) => {
			const name = decodeURIComponent(params[1]);
			const scope = url.searchParams.get("scope") || "server";
			const projectId = url.searchParams.get("projectId") || undefined;

			const resolved = deps.configCascade.resolveTools(projectId);
			const source = resolved.find(r => r.item.name === name);
			if (!source) { json({ error: "Tool not found" }, 404); return; }

			const builtinDir = builtinToolsDir();
			const serverToolsDir = path.join(bobbitConfigDir(), "tools");

			let groupDir: string | null = null;
			let sourceToolsDir: string;
			if (source.origin === "builtin") {
				sourceToolsDir = builtinDir;
				groupDir = findToolGroupDir(name, builtinDir);
			} else if (source.origin === "project" && projectId) {
				const ctx = deps.projectContextManager.getOrCreate(projectId);
				sourceToolsDir = ctx ? path.join(ctx.configDir, "tools") : serverToolsDir;
				groupDir = findToolGroupDir(name, sourceToolsDir);
			} else {
				sourceToolsDir = serverToolsDir;
				groupDir = findToolGroupDir(name, serverToolsDir);
			}
			if (!groupDir) groupDir = findToolGroupDir(name, builtinDir) || findToolGroupDir(name, serverToolsDir);
			if (!groupDir) { json({ error: "Could not determine tool group directory" }, 400); return; }

			let targetToolsDir: string;
			if (scope === "project" && projectId) {
				const ctx = deps.projectContextManager.getOrCreate(projectId);
				if (!ctx) { json({ error: "Project not found" }, 404); return; }
				targetToolsDir = path.join(ctx.configDir, "tools");
			} else {
				targetToolsDir = serverToolsDir;
			}

			let actualSourceDir = sourceToolsDir;
			if (!fs.existsSync(path.join(actualSourceDir, groupDir))) {
				if (fs.existsSync(path.join(builtinDir, groupDir))) actualSourceDir = builtinDir;
				else if (fs.existsSync(path.join(serverToolsDir, groupDir))) actualSourceDir = serverToolsDir;
			}

			const srcDir = path.join(actualSourceDir, groupDir);
			const destDir = path.join(targetToolsDir, groupDir);

			if (!fs.existsSync(srcDir)) { json({ error: "Source tool group not found" }, 404); return; }

			copyDirRecursive(srcDir, destDir);

			json({ ok: true, groupDir }, 201);
		},
	},
	{
		method: "DELETE",
		pattern: /^\/api\/tools\/([^/]+)\/override$/,
		handler: ({ deps, params, url, json }) => {
			const name = decodeURIComponent(params[1]);
			const scope = url.searchParams.get("scope") || "server";
			const projectId = url.searchParams.get("projectId") || undefined;

			let targetToolsDir: string;
			if (scope === "project" && projectId) {
				const ctx = deps.projectContextManager.getOrCreate(projectId);
				if (!ctx) { json({ error: "Project not found" }, 404); return; }
				targetToolsDir = path.join(ctx.configDir, "tools");
			} else {
				targetToolsDir = path.join(bobbitConfigDir(), "tools");
			}

			let groupDir = findToolGroupDir(name, targetToolsDir);
			if (!groupDir) groupDir = findToolGroupDir(name, builtinToolsDir());
			if (!groupDir) { json({ error: "Could not determine tool group directory" }, 400); return; }

			const dirToRemove = path.join(targetToolsDir, groupDir);
			if (fs.existsSync(dirToRemove)) {
				fs.rmSync(dirToRemove, { recursive: true, force: true });
			}

			json({ ok: true });
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/tools\/([^/]+)$/,
		handler: ({ deps, params, json }) => {
			const name = decodeURIComponent(params[1]);
			const tool = deps.toolManager.getToolByName(name);
			if (!tool) { json({ error: "Tool not found" }, 404); return; }
			json(tool);
		},
	},
	{
		method: "PUT",
		pattern: /^\/api\/tools\/([^/]+)$/,
		handler: async ({ deps, params, readBody, json }) => {
			const name = decodeURIComponent(params[1]);
			const body = await readBody();
			if (!body) { json({ error: "Missing body" }, 400); return; }
			const ok = deps.toolManager.updateToolMetadata(name, {
				description: body.description,
				group: body.group,
				docs: body.docs,
				detail_docs: body.detail_docs,
				grantPolicy: body.grantPolicy,
			});
			if (!ok) { json({ error: "Tool not found" }, 404); return; }
			json({ ok: true });
		},
	},
	{
		method: "GET",
		pattern: "/api/tool-group-policies",
		handler: ({ deps, url, json }) => {
			const projectId = url.searchParams.get("projectId") || undefined;
			json(deps.configCascade.resolveToolGroupPolicies(projectId));
		},
	},
	{
		method: "PUT",
		pattern: /^\/api\/tool-group-policies\/(.+)$/,
		handler: async ({ deps, params, readBody, json }) => {
			const group = decodeURIComponent(params[1]);
			const body = await readBody();
			if (!body) { json({ error: "Missing body" }, 400); return; }
			if (body.policy && !VALID_POLICIES.includes(body.policy)) {
				json({ error: `Invalid policy. Must be one of: allow, ask, never` }, 400);
				return;
			}
			deps.groupPolicyStore.setGroupPolicy(group, body.policy || null);
			json({ ok: true });
		},
	},
];
