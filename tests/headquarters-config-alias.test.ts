import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HEADQUARTERS_PROJECT_ID = "headquarters";
const HEADQUARTERS_PROJECT_NAME = "Headquarters";

function mkTemp(label: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `bobbit-hq-${label}-`));
}

function minimalProject(id: string, name: string, rootPath: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		name,
		rootPath,
		createdAt: Date.now(),
		colorLight: "#000000",
		colorDark: "#ffffff",
		...extra,
	} as any;
}

function tool(name: string, description: string) {
	return { name, description, group: "custom", hasRenderer: false } as any;
}

describe("Headquarters storage and config aliasing", () => {
	it("ProjectContext stores Headquarters under the server BOBBIT_DIR instead of <root>/.bobbit", async () => {
		const serverRoot = mkTemp("server-root");
		const redirectedBobbitDir = mkTemp("redirected-bobbit");
		fs.mkdirSync(path.join(redirectedBobbitDir, "state"), { recursive: true });
		fs.mkdirSync(path.join(redirectedBobbitDir, "config"), { recursive: true });
		process.env.BOBBIT_DIR = redirectedBobbitDir;

		const { setProjectRoot, bobbitDir, bobbitStateDir, bobbitConfigDir } = await import("../src/server/bobbit-dir.ts");
		const { ProjectContext } = await import("../src/server/agent/project-context.ts");
		setProjectRoot(serverRoot);

		const ctx = new ProjectContext(minimalProject(HEADQUARTERS_PROJECT_ID, HEADQUARTERS_PROJECT_NAME, serverRoot, { kind: "headquarters" }));

		assert.equal(path.resolve(ctx.bobbitDir), path.resolve(bobbitDir()));
		assert.equal(path.resolve(ctx.stateDir), path.resolve(bobbitStateDir()));
		assert.equal(path.resolve(ctx.configDir), path.resolve(bobbitConfigDir()));
		assert.notEqual(path.resolve(ctx.stateDir), path.resolve(path.join(serverRoot, ".bobbit", "state")));
		assert.notEqual(path.resolve(ctx.configDir), path.resolve(path.join(serverRoot, ".bobbit", "config")));
	});

	it("ConfigCascade treats projectId=headquarters as server scope for roles, tools, and tool policies", async () => {
		const { ConfigCascade } = await import("../src/server/agent/config-cascade.ts");

		const serverRole = {
			name: "hq-role",
			label: "Server HQ Role",
			promptTemplate: "server prompt",
			accessory: "none",
			model: "server/model",
			thinkingLevel: "medium",
			createdAt: 0,
			updatedAt: 0,
		} as any;
		const projectRole = {
			...serverRole,
			label: "Project Shadow Role",
			promptTemplate: "project prompt",
			model: "project/model",
			thinkingLevel: "high",
		} as any;

		const serverTool = tool("hq-tool", "server tool");
		const projectTool = tool("hq-tool", "project shadow tool");
		const hqWorkflow = { id: "hq-flow", name: "HQ Flow", gates: [{ id: "plan", name: "Plan" }] } as any;

		const builtins = {
			getRoles: () => [],
			getTools: () => [],
			getToolGroupPolicies: () => ({}),
		} as any;
		const serverStores = {
			getRoles: () => [serverRole],
			getTools: () => [serverTool],
			getToolGroupPolicies: () => ({ shell: "ask" as const }),
		} as any;
		let projectContextReads = 0;
		const fakePcm = {
			getOrCreate: (id: string) => {
				if (id !== HEADQUARTERS_PROJECT_ID) return undefined;
				projectContextReads++;
				return {
					roleStore: {
						getAllLocal: () => [projectRole],
						getLocal: () => projectRole,
					},
					toolManager: { getLocalTools: () => [projectTool] },
					toolGroupPolicyStore: { getAll: () => ({ shell: "never" as const }) },
					workflowStore: { getAllLocal: () => [hqWorkflow] },
				};
			},
		} as any;

		const cascade = new ConfigCascade(builtins, serverStores, fakePcm);

		const role = cascade.resolveRoles(HEADQUARTERS_PROJECT_ID).find((entry: any) => entry.item.name === "hq-role");
		assert.ok(role);
		assert.equal(role!.origin, "server");
		assert.equal(role!.item.promptTemplate, "server prompt");
		assert.equal(cascade.resolveRoleModel("hq-role", HEADQUARTERS_PROJECT_ID), "server/model");
		assert.equal(cascade.resolveRoleThinkingLevel("hq-role", HEADQUARTERS_PROJECT_ID), "medium");
		assert.equal(cascade.resolveRolePromptTemplate("hq-role", HEADQUARTERS_PROJECT_ID), "server prompt");

		const resolvedTool = cascade.resolveTools(HEADQUARTERS_PROJECT_ID).find((entry: any) => entry.item.name === "hq-tool");
		assert.ok(resolvedTool);
		assert.equal(resolvedTool!.origin, "server");
		assert.equal(resolvedTool!.item.description, "server tool");

		const policies = cascade.resolveToolGroupPolicies(HEADQUARTERS_PROJECT_ID);
		assert.equal(policies.shell.origin, "server");
		assert.equal(policies.shell.policy, "ask");

		assert.equal(cascade.resolveWorkflows().length, 0, "server scope still has no workflows");
		const workflows = cascade.resolveWorkflows(HEADQUARTERS_PROJECT_ID);
		assert.equal(workflows.length, 1, "Headquarters workflow lookup remains project-scoped");
		assert.equal(workflows[0].origin, "project");
		assert.equal(workflows[0].item.id, "hq-flow");
		assert.ok(projectContextReads > 0, "workflow exception should still read the Headquarters project context");
	});
});

describe("ProjectRegistry Headquarters ordering", () => {
	it("ensureHeadquartersProject creates stable Headquarters and excludes it from user reorder", async () => {
		const { ProjectRegistry, SYSTEM_PROJECT_ID } = await import("../src/server/agent/project-registry.ts");
		const stateDir = mkTemp("registry-state");
		const configDir = mkTemp("registry-config");
		const serverRoot = mkTemp("registry-root");
		const systemRoot = path.join(stateDir, "system-project");
		fs.mkdirSync(systemRoot, { recursive: true });

		const registry = new ProjectRegistry(stateDir);
		registry.registerSystemProject(systemRoot);
		(registry as any).ensureHeadquartersProject(serverRoot, { stateDir, configDir });

		const hq = registry.get(HEADQUARTERS_PROJECT_ID) as any;
		assert.ok(hq, "Headquarters should be registered by stable id");
		assert.equal(hq.name, HEADQUARTERS_PROJECT_NAME);
		assert.equal(hq.kind, "headquarters");
		assert.equal(path.resolve(hq.rootPath), path.resolve(serverRoot));
		assert.notEqual(hq.hidden, true);
		assert.notEqual(hq.provisional, true);
		assert.equal(hq.position, undefined, "Headquarters is anchored, not user-positioned");

		const a = registry.register("A", mkTemp("registry-a"), { acceptCanonical: true });
		const b = registry.register("B", mkTemp("registry-b"), { acceptCanonical: true });
		const reordered = registry.setVisibleOrder([b.id, a.id]);
		assert.deepEqual(reordered.map(project => project.id), [HEADQUARTERS_PROJECT_ID, b.id, a.id]);
		assert.deepEqual(
			registry.list().filter(project => !project.hidden && project.id !== SYSTEM_PROJECT_ID).map(project => project.id),
			[HEADQUARTERS_PROJECT_ID, b.id, a.id],
		);
		assert.throws(
			() => registry.setVisibleOrder([HEADQUARTERS_PROJECT_ID, b.id, a.id]),
			/error|invalid_project_order/i,
			"Headquarters must not be accepted in client-supplied reorder payloads",
		);
	});
});
