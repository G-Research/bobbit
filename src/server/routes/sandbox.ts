/**
 * Sandbox-related routes: pool, status, image build, host tokens.
 * Extracted from server.ts (commit: split server.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { checkDockerAvailability, buildSandboxImage, isBuildingImage } from "../agent/sandbox-status.js";
import { detectHostTokens } from "../agent/host-tokens.js";
import type { Route } from "./types.js";

export const sandboxRoutes: Route[] = [
	{
		method: "GET",
		pattern: "/api/sandbox-pool",
		handler: ({ deps, json }) => {
			if (deps.sandboxManager) {
				const stats = deps.sandboxManager.getStats();
				json({ ...stats, type: "sandbox" });
			} else {
				json({ enabled: false });
			}
		},
	},
	{
		method: "GET",
		pattern: "/api/worktree-pool",
		handler: ({ deps, url, json }) => {
			const projectId = url.searchParams.get("projectId");
			if (projectId) {
				const pool = deps.sessionManager.getWorktreePool(projectId);
				json(pool ? pool.getStatus() : { enabled: false, ready: 0, target: 0, filling: false });
			} else {
				const pools: Record<string, any> = {};
				for (const [pid, pool] of deps.sessionManager.getAllWorktreePools()) {
					pools[pid] = pool.getStatus();
				}
				json({ pools });
			}
		},
	},
	{
		method: "GET",
		pattern: "/api/sandbox-status",
		handler: async ({ deps, json }) => {
			const sandboxConfig = deps.projectConfigStore.get("sandbox") || "none";
			const imageName = deps.projectConfigStore.get("sandbox_image") || "bobbit-agent";
			const configured = sandboxConfig === "docker";
			const status = await checkDockerAvailability(configured ? imageName : undefined);
			json({ ...status, configured });
		},
	},
	{
		method: "POST",
		pattern: "/api/sandbox-image/build",
		handler: async ({ deps, json, jsonError }) => {
			const imageName = deps.projectConfigStore.get("sandbox_image") || "bobbit-agent";
			if (!fs.existsSync(path.join(deps.config.defaultCwd, "docker", "Dockerfile"))) {
				jsonError(404, new Error("Dockerfile not found at docker/Dockerfile"));
				return;
			}
			if (isBuildingImage()) {
				jsonError(409, new Error("Build already in progress"));
				return;
			}
			const result = await buildSandboxImage(imageName, deps.config.defaultCwd);
			if (result.success) {
				json({ success: true });
			} else {
				jsonError(500, new Error(result.error), { success: false });
			}
		},
	},
	{
		method: "GET",
		pattern: "/api/sandbox/host-tokens",
		handler: ({ deps, json }) => {
			const tokens = detectHostTokens(deps.preferencesStore);
			json(tokens);
		},
	},
	{
		method: "GET",
		pattern: "/api/connection-info",
		handler: async ({ deps, json }) => {
			const interfaces = await import("node:os").then((os) => os.networkInterfaces());
			const addresses: { ip: string; name: string }[] = [];
			for (const [name, addrs] of Object.entries(interfaces)) {
				if (!addrs) continue;
				for (const addr of addrs) {
					if (addr.family === "IPv4" && !addr.internal) {
						addresses.push({ ip: addr.address, name });
					}
				}
			}
			json({ addresses, port: deps.config.port });
		},
	},
];
