/**
 * Unit test for ConfigCascade three-layer resolution of Role.model and
 * Role.thinkingLevel: project > server > builtin.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { ConfigCascade, normalizeConfigProjectId } = await import("../src/server/agent/config-cascade.ts");
const { BuiltinConfigProvider } = await import("../src/server/agent/builtin-config.ts");
const { RoleStore } = await import("../src/server/agent/role-store.ts");
const { HEADQUARTERS_PROJECT_ID } = await import("../src/server/agent/project-registry.ts");

function mkTemp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-cascade-test-"));
}

function writeRoleYaml(dir: string, name: string, fields: Record<string, unknown>) {
	const rolesDir = path.join(dir, "roles");
	fs.mkdirSync(rolesDir, { recursive: true });
	const lines = [
		`name: ${name}`,
		`label: ${fields.label ?? name}`,
		`accessory: ${fields.accessory ?? "none"}`,
		...(fields.model ? [`model: ${fields.model}`] : []),
		...(fields.thinkingLevel ? [`thinkingLevel: ${fields.thinkingLevel}`] : []),
		"createdAt: 0",
		"updatedAt: 0",
		`promptTemplate: ${fields.promptTemplate ?? "p"}`,
	];
	fs.writeFileSync(path.join(rolesDir, `${name}.yaml`), lines.join("\n"));
}

describe("ConfigCascade — Role.model and Role.thinkingLevel three-layer resolution", () => {
	it("project overrides server overrides builtin for both fields", () => {
		// Builtin layer: needs roles/<name>.yaml under <builtinsDir>
		const builtinsDir = mkTemp();
		writeRoleYaml(builtinsDir, "coder", {
			model: "anthropic/claude-haiku",
			thinkingLevel: "low",
		});

		// Server layer: standalone server stores
		const serverDir = mkTemp();
		const serverRoleStore = new RoleStore(serverDir);
		serverRoleStore.put({
			name: "coder",
			label: "Coder",
			promptTemplate: "p",
			accessory: "none",
			model: "anthropic/claude-sonnet",
			thinkingLevel: "medium",
			createdAt: 0,
			updatedAt: 0,
		});

		// Project layer: per-project store
		const projectDir = mkTemp();
		const projectRoleStore = new RoleStore(projectDir);
		projectRoleStore.put({
			name: "coder",
			label: "Coder",
			promptTemplate: "p",
			accessory: "none",
			model: "anthropic/claude-opus-4",
			thinkingLevel: "high",
			createdAt: 0,
			updatedAt: 0,
		});

		const builtins = new BuiltinConfigProvider(builtinsDir);

		const serverStores = {
			getRoles: () => serverRoleStore.getAllLocal(),
			getPersonalities: () => [],
			getWorkflows: () => [],
			getTools: () => [],
			getToolGroupPolicies: () => ({}),
		};

		// Mock ProjectContextManager — only needs getOrCreate(projectId) to return a ctx with roleStore.
		const fakePcm = {
			getOrCreate: (id: string) => id === "proj1" ? { roleStore: projectRoleStore } : undefined,
		} as any;

		const cascade = new ConfigCascade(builtins, serverStores, fakePcm);

		// No project: server wins over builtin
		const sysRoles = cascade.resolveRoles();
		const sysCoder = sysRoles.find(r => r.item.name === "coder");
		assert.ok(sysCoder);
		assert.equal(sysCoder!.origin, "server");
		assert.equal(sysCoder!.item.model, "anthropic/claude-sonnet");
		assert.equal(sysCoder!.item.thinkingLevel, "medium");

		// With project: project wins over server
		const projRoles = cascade.resolveRoles("proj1");
		const projCoder = projRoles.find(r => r.item.name === "coder");
		assert.ok(projCoder);
		assert.equal(projCoder!.origin, "project");
		assert.equal(projCoder!.item.model, "anthropic/claude-opus-4");
		assert.equal(projCoder!.item.thinkingLevel, "high");
	});

	it("falls through to builtin when neither server nor project define the role", () => {
		const builtinsDir = mkTemp();
		writeRoleYaml(builtinsDir, "tester", {
			model: "anthropic/claude-haiku",
			thinkingLevel: "off",
		});
		const builtins = new BuiltinConfigProvider(builtinsDir);

		const serverStores = {
			getRoles: () => [],
			getPersonalities: () => [],
			getWorkflows: () => [],
			getTools: () => [],
			getToolGroupPolicies: () => ({}),
		};
		const fakePcm = { getOrCreate: () => undefined } as any;

		const cascade = new ConfigCascade(builtins, serverStores, fakePcm);
		const roles = cascade.resolveRoles();
		const tester = roles.find(r => r.item.name === "tester");
		assert.ok(tester);
		assert.equal(tester!.origin, "builtin");
		assert.equal(tester!.item.model, "anthropic/claude-haiku");
		assert.equal(tester!.item.thinkingLevel, "off");
	});
});

describe("ConfigCascade — Headquarters server-scope alias", () => {
	it("normalizes Headquarters to server scope for non-workflow config only", () => {
		assert.equal(normalizeConfigProjectId(HEADQUARTERS_PROJECT_ID), undefined);
		assert.equal(normalizeConfigProjectId("proj1"), "proj1");

		const builtins = new BuiltinConfigProvider(mkTemp());
		const serverRole = {
			name: "coder",
			label: "Coder",
			promptTemplate: "server prompt",
			accessory: "none",
			model: "server/model",
			thinkingLevel: "medium",
			createdAt: 0,
			updatedAt: 0,
		};
		const projectRole = {
			...serverRole,
			promptTemplate: "project prompt",
			model: "project/model",
			thinkingLevel: "high",
		};
		const serverTool = { name: "shared_tool", description: "server" };
		const projectTool = { name: "shared_tool", description: "project" };
		const serverPolicy = { default: "allow" };
		const projectPolicy = { default: "deny" };
		const hqWorkflow = { id: "hq-flow", name: "HQ Flow", gates: [] };
		const calls: string[] = [];
		const fakePcm = {
			getOrCreate: (id: string) => {
				calls.push(id);
				if (id !== HEADQUARTERS_PROJECT_ID) return undefined;
				return {
					roleStore: {
						getAllLocal: () => [projectRole],
						getLocal: (name: string) => name === "coder" ? projectRole : undefined,
					},
					toolManager: { getLocalTools: () => [projectTool] },
					toolGroupPolicyStore: { getAll: () => ({ Shell: projectPolicy }) },
					workflowStore: { getAllLocal: () => [hqWorkflow] },
				};
			},
		} as any;
		const cascade = new ConfigCascade(builtins, {
			getRoles: () => [serverRole],
			getTools: () => [serverTool as any],
			getToolGroupPolicies: () => ({ Shell: serverPolicy as any }),
		}, fakePcm);

		const roles = cascade.resolveRoles(HEADQUARTERS_PROJECT_ID);
		assert.equal(roles.find(r => r.item.name === "coder")?.origin, "server");
		assert.equal(roles.find(r => r.item.name === "coder")?.item.promptTemplate, "server prompt");
		assert.equal(cascade.resolveRoleModel("coder", HEADQUARTERS_PROJECT_ID), "server/model");
		assert.equal(cascade.resolveRoleThinkingLevel("coder", HEADQUARTERS_PROJECT_ID), "medium");
		assert.equal(cascade.resolveRolePromptTemplate("coder", HEADQUARTERS_PROJECT_ID), "server prompt");
		assert.equal(cascade.resolveTools(HEADQUARTERS_PROJECT_ID).find(t => t.item.name === "shared_tool")?.origin, "server");
		assert.equal(cascade.resolveToolGroupPolicies(HEADQUARTERS_PROJECT_ID).Shell.origin, "server");
		assert.deepEqual(calls, [], "non-workflow Headquarters config must not load the project context");

		const workflows = cascade.resolveWorkflows(HEADQUARTERS_PROJECT_ID);
		assert.deepEqual(workflows.map(w => [w.item.id, w.origin]), [["hq-flow", "project"]]);
		assert.deepEqual(calls, [HEADQUARTERS_PROJECT_ID], "workflow resolution remains project-scoped for Headquarters");
	});

	it("normalizes Headquarters before market-pack and activation lookups", () => {
		const builtins = new BuiltinConfigProvider(mkTemp());
		const cascade = new ConfigCascade(builtins, {
			getRoles: () => [],
			getTools: () => [],
			getToolGroupPolicies: () => ({}),
		}, { getOrCreate: () => undefined } as any, undefined, undefined, mkTemp(), mkTemp());
		const marketCalls: Array<[string, string | undefined]> = [];
		const activationCalls: Array<[string, string | undefined, string]> = [];
		cascade.setMarketPackProvider({
			marketEntries(scope, projectId) {
				marketCalls.push([scope, projectId]);
				if (scope !== "server") return [];
				return [{
					id: "market:server:sample",
					kind: "market",
					scope: "server",
					path: mkTemp(),
					readOnly: true,
					layout: "defaults-tree",
					manifest: {
						name: "sample",
						description: "sample",
						version: "1.0.0",
						contents: { roles: [], tools: ["market_tool"], skills: [], entrypoints: [] },
					},
					preloaded: { tools: [{ name: "market_tool", item: { name: "market_tool", description: "market" } }] },
				} as any];
			},
		});
		cascade.setPackActivationProvider({
			disabled(scope, projectId, packName) {
				activationCalls.push([scope, projectId, packName]);
				return {};
			},
		});

		assert.equal(cascade.resolveTools(HEADQUARTERS_PROJECT_ID).find(t => t.item.name === "market_tool")?.origin, "server");
		assert.deepEqual(marketCalls, [["server", undefined], ["global-user", undefined]]);
		assert.deepEqual(activationCalls, [["server", undefined, "sample"]]);
	});
});
