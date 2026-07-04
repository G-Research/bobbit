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

function withEnv<T>(updates: Record<string, string | undefined>, fn: () => T): T {
	const old = new Map(Object.keys(updates).map((key) => [key, process.env[key]]));
	try {
		for (const [key, value] of Object.entries(updates)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		return fn();
	} finally {
		for (const [key, value] of old) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	}
}

describe("Headquarters storage and config aliasing", () => {
	it("bobbit-dir helpers split Headquarters from normal same-root project storage", async () => {
		const serverRoot = mkTemp("server-root");
		const { setProjectRoot, headquartersDir, bobbitDir, bobbitStateDir, bobbitConfigDir, normalProjectBobbitDir } = await import("../src/server/bobbit-dir.ts");

		withEnv({ BOBBIT_DIR: undefined, BOBBIT_PI_DIR: undefined }, () => {
			setProjectRoot(serverRoot);
			assert.equal(path.resolve(headquartersDir()), path.resolve(path.join(serverRoot, ".bobbit", "headquarters")));
			assert.equal(path.resolve(bobbitDir()), path.resolve(path.join(serverRoot, ".bobbit", "headquarters")));
			assert.equal(path.resolve(bobbitStateDir()), path.resolve(path.join(serverRoot, ".bobbit", "headquarters", "state")));
			assert.equal(path.resolve(bobbitConfigDir()), path.resolve(path.join(serverRoot, ".bobbit", "headquarters", "config")));
			assert.equal(path.resolve(normalProjectBobbitDir(serverRoot)), path.resolve(path.join(serverRoot, ".bobbit")));
		});
	});

	it("BOBBIT_DIR and BOBBIT_PI_DIR override the Headquarters directory itself", async () => {
		const serverRoot = mkTemp("override-root");
		const custom = mkTemp("custom-hq");
		const legacy = mkTemp("legacy-hq");
		const { setProjectRoot, headquartersDir, bobbitStateDir, bobbitConfigDir } = await import("../src/server/bobbit-dir.ts");
		setProjectRoot(serverRoot);

		withEnv({ BOBBIT_DIR: custom, BOBBIT_PI_DIR: legacy }, () => {
			assert.equal(path.resolve(headquartersDir()), path.resolve(custom));
			assert.equal(path.resolve(bobbitStateDir()), path.resolve(path.join(custom, "state")));
			assert.equal(path.resolve(bobbitConfigDir()), path.resolve(path.join(custom, "config")));
		});

		withEnv({ BOBBIT_DIR: undefined, BOBBIT_PI_DIR: legacy }, () => {
			assert.equal(path.resolve(headquartersDir()), path.resolve(legacy));
			assert.equal(path.resolve(bobbitStateDir()), path.resolve(path.join(legacy, "state")));
			assert.equal(path.resolve(bobbitConfigDir()), path.resolve(path.join(legacy, "config")));
		});
	});

	it("ProjectContext stores Headquarters under Headquarters dir and normal same-root projects under <root>/.bobbit", async () => {
		const serverRoot = mkTemp("context-root");
		const { setProjectRoot, bobbitDir, bobbitStateDir, bobbitConfigDir } = await import("../src/server/bobbit-dir.ts");
		const { ProjectContext } = await import("../src/server/agent/project-context.ts");

		withEnv({ BOBBIT_DIR: undefined, BOBBIT_PI_DIR: undefined }, () => {
			setProjectRoot(serverRoot);
			const headquartersRoot = path.join(serverRoot, ".bobbit", "headquarters");
			const hq = new ProjectContext(minimalProject(HEADQUARTERS_PROJECT_ID, HEADQUARTERS_PROJECT_NAME, headquartersRoot, { kind: "headquarters" }));
			const normal = new ProjectContext(minimalProject("normal", "Normal", serverRoot));

			assert.equal(path.resolve(hq.bobbitDir), path.resolve(bobbitDir()));
			assert.equal(path.resolve(hq.stateDir), path.resolve(bobbitStateDir()));
			assert.equal(path.resolve(hq.configDir), path.resolve(bobbitConfigDir()));
			assert.equal(path.resolve(hq.bobbitDir), path.resolve(headquartersRoot));

			assert.equal(path.resolve(normal.bobbitDir), path.resolve(path.join(serverRoot, ".bobbit")));
			assert.equal(path.resolve(normal.stateDir), path.resolve(path.join(serverRoot, ".bobbit", "state")));
			assert.equal(path.resolve(normal.configDir), path.resolve(path.join(serverRoot, ".bobbit", "config")));
		});
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
		const hqRoot = path.join(serverRoot, ".bobbit", "headquarters");
		const systemRoot = path.join(stateDir, "system-project");
		fs.mkdirSync(systemRoot, { recursive: true });
		fs.mkdirSync(hqRoot, { recursive: true });

		const registry = new ProjectRegistry(stateDir);
		registry.registerSystemProject(systemRoot);
		(registry as any).ensureHeadquartersProject(hqRoot, { stateDir, configDir });

		const hq = registry.get(HEADQUARTERS_PROJECT_ID) as any;
		assert.ok(hq, "Headquarters should be registered by stable id");
		assert.equal(hq.name, HEADQUARTERS_PROJECT_NAME);
		assert.equal(hq.kind, "headquarters");
		assert.equal(path.resolve(hq.rootPath), path.resolve(hqRoot));
		assert.notEqual(hq.hidden, true);
		assert.notEqual(hq.provisional, true);
		assert.equal(hq.position, undefined, "Headquarters is anchored, not user-positioned");

		const sameRootNormal = registry.register("Server Root Normal", serverRoot, { acceptCanonical: true });
		const b = registry.register("B", mkTemp("registry-b"), { acceptCanonical: true });
		const reordered = registry.setVisibleOrder([b.id, sameRootNormal.id]);
		assert.deepEqual(reordered.map(project => project.id), [HEADQUARTERS_PROJECT_ID, b.id, sameRootNormal.id]);
		assert.deepEqual(
			registry.list().filter(project => !project.hidden && project.id !== SYSTEM_PROJECT_ID).map(project => project.id),
			[HEADQUARTERS_PROJECT_ID, b.id, sameRootNormal.id],
		);
		assert.throws(
			() => registry.setVisibleOrder([HEADQUARTERS_PROJECT_ID, b.id, sameRootNormal.id]),
			/error|invalid_project_order/i,
			"Headquarters must not be accepted in client-supplied reorder payloads",
		);
		assert.throws(
			() => registry.register("HQ Dir", hqRoot, { acceptCanonical: true }),
			/Headquarters|immutable/i,
			"normal projects cannot be registered at the physical Headquarters directory",
		);
	});
});
