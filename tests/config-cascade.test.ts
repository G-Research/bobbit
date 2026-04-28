/**
 * Unit test for ConfigCascade three-layer resolution of Role.model and
 * Role.thinkingLevel: project > server > builtin.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { ConfigCascade } = await import("../src/server/agent/config-cascade.ts");
const { BuiltinConfigProvider } = await import("../src/server/agent/builtin-config.ts");
const { RoleStore } = await import("../src/server/agent/role-store.ts");

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
