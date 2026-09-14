import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "../../support/harnesses/integration/gateway/in-process-harness.js";
import { apiFetch } from "../../support/harnesses/integration/gateway/e2e-setup.js";
import {
	createProject,
	isolateMcpRuntime,
} from "../../support/mcp-approval/project-approval-gateway-helpers.js";

test.describe("malformed project MCP diagnostics", () => {
	test("publishes a safe diagnostic row without approval or tool actions", async ({ gateway }) => {
		const isolated = await isolateMcpRuntime(gateway, "malformed-diagnostic");
		try {
			const project = await createProject(gateway, isolated, `mcp-malformed-${randomUUID().slice(0, 8)}`);
			writeFileSync(
				path.join(project.root, ".mcp.json"),
				'{"mcpServers":{"private-server":{"command":"private-command","env":{"TOKEN":"private-secret"}}}',
				"utf8",
			);

			const response = await apiFetch(`/api/mcp-servers?projectId=${encodeURIComponent(project.id)}&ensure=true`);
			expect(response.status).toBe(200);
			const statuses = await response.json() as Array<Record<string, any>>;
			const diagnostic = statuses.find((status) => status.kind === "invalid-configuration" && status.source?.projectId === project.id);

			expect(diagnostic).toMatchObject({
				name: `invalid:${project.id}:project-file:.mcp.json`,
				kind: "invalid-configuration",
				status: "disconnected",
				toolCount: 0,
				tools: [],
				source: {
					sourceId: "project-file:.mcp.json",
					authority: "project",
					projectId: project.id,
					file: ".mcp.json",
				},
				diagnostics: [{
					code: "MCP_CONFIG_PARSE_FAILED",
					message: "Could not parse MCP configuration from .mcp.json.",
				}],
			});
			expect(diagnostic).not.toHaveProperty("approval");
			expect(diagnostic).not.toHaveProperty("reviewConfig");
			expect(diagnostic).not.toHaveProperty("serverPolicyKey");
			expect(diagnostic).not.toHaveProperty("policyKey");
			expect(JSON.stringify(diagnostic)).not.toMatch(/private-(?:server|command|secret)/);
			expect(existsSync(path.join(isolated.approvalDir, "mcp-server-approvals.json"))).toBe(false);
			expect((gateway.sessionManager as any).getMcpManager({ projectId: project.id }).clients.size).toBe(0);
		} finally {
			await isolated.cleanup();
		}
	});
});
