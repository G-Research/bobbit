/**
 * Field-level role resolution (model/thinkingLevel/promptTemplate) walking
 * project → ancestor chain → server → builtin.
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
	return fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-cascade-fields-"));
}

function writeBuiltinRole(dir: string, name: string, fields: Record<string, unknown>) {
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

function mkRole(name: string, fields: Record<string, unknown>): any {
	return {
		name,
		label: name,
		accessory: "none",
		promptTemplate: "",
		createdAt: 0,
		updatedAt: 0,
		...fields,
	};
}

function buildServerStores(serverRoleStore: any) {
	return {
		getRoles: () => serverRoleStore.getAllLocal(),
		getTools: () => [],
		getToolGroupPolicies: () => ({}),
	};
}

describe("ConfigCascade — field-level role resolution", () => {
	it("project sets only `model` → `thinkingLevel` falls through to server", () => {
		const builtinsDir = mkTemp();
		writeBuiltinRole(builtinsDir, "coder", { model: "anthropic/haiku", thinkingLevel: "low", promptTemplate: "builtin-tmpl" });

		const serverDir = mkTemp();
		const serverRoleStore = new RoleStore(serverDir);
		serverRoleStore.put(mkRole("coder", { model: "anthropic/sonnet", thinkingLevel: "medium", promptTemplate: "server-tmpl" }));

		const projectDir = mkTemp();
		const projectRoleStore = new RoleStore(projectDir);
		projectRoleStore.put(mkRole("coder", { model: "anthropic/opus" }));
		// no thinkingLevel/promptTemplate at project layer

		const builtins = new BuiltinConfigProvider(builtinsDir);
		const fakePcm = { getOrCreate: (id: string) => id === "p1" ? { roleStore: projectRoleStore } : undefined } as any;
		const cascade = new ConfigCascade(builtins, buildServerStores(serverRoleStore), fakePcm);

		assert.equal(cascade.resolveRoleModel("coder", "p1"), "anthropic/opus");
		assert.equal(cascade.resolveRoleThinkingLevel("coder", "p1"), "medium");
		assert.equal(cascade.resolveRolePromptTemplate("coder", "p1"), "server-tmpl");
	});

	it("ancestor project supplies a field when current project has no override", () => {
		const builtinsDir = mkTemp();
		writeBuiltinRole(builtinsDir, "coder", { model: "anthropic/haiku", thinkingLevel: "low" });

		const serverDir = mkTemp();
		const serverRoleStore = new RoleStore(serverDir);

		const parentDir = mkTemp();
		const parentRoleStore = new RoleStore(parentDir);
		parentRoleStore.put(mkRole("coder", { model: "anthropic/opus", thinkingLevel: "high" }));

		const childDir = mkTemp();
		const childRoleStore = new RoleStore(childDir);
		// no role at child layer

		const builtins = new BuiltinConfigProvider(builtinsDir);
		const fakePcm = {
			getOrCreate: (id: string) => {
				if (id === "child") return { roleStore: childRoleStore };
				if (id === "parent") return { roleStore: parentRoleStore };
				return undefined;
			},
		} as any;
		const registry = {
			getAncestors: (id: string) => id === "child" ? [{ id: "parent" }] : [],
		};
		const cascade = new ConfigCascade(builtins, buildServerStores(serverRoleStore), fakePcm, registry);

		assert.equal(cascade.resolveRoleModel("coder", "child"), "anthropic/opus");
		assert.equal(cascade.resolveRoleThinkingLevel("coder", "child"), "high");
	});

	it("two-level chain: grandparent promptTemplate wins when parent and child don't override", () => {
		const builtinsDir = mkTemp();
		writeBuiltinRole(builtinsDir, "coder", {});
		const serverDir = mkTemp();
		const serverRoleStore = new RoleStore(serverDir);

		const gpDir = mkTemp();
		const gpStore = new RoleStore(gpDir);
		gpStore.put(mkRole("coder", { promptTemplate: "from-grandparent" }));

		const pDir = mkTemp();
		const pStore = new RoleStore(pDir);

		const cDir = mkTemp();
		const cStore = new RoleStore(cDir);

		const builtins = new BuiltinConfigProvider(builtinsDir);
		const fakePcm = {
			getOrCreate: (id: string) => {
				if (id === "c") return { roleStore: cStore };
				if (id === "p") return { roleStore: pStore };
				if (id === "gp") return { roleStore: gpStore };
				return undefined;
			},
		} as any;
		const registry = {
			getAncestors: (id: string) => {
				if (id === "c") return [{ id: "p" }, { id: "gp" }];
				if (id === "p") return [{ id: "gp" }];
				return [];
			},
		};
		const cascade = new ConfigCascade(builtins, buildServerStores(serverRoleStore), fakePcm, registry);

		assert.equal(cascade.resolveRolePromptTemplate("coder", "c"), "from-grandparent");
	});

	it("falls through to builtin when nothing in chain or server has the field", () => {
		const builtinsDir = mkTemp();
		writeBuiltinRole(builtinsDir, "coder", { model: "anthropic/builtin-model" });
		const serverDir = mkTemp();
		const serverRoleStore = new RoleStore(serverDir);
		const builtins = new BuiltinConfigProvider(builtinsDir);
		const cascade = new ConfigCascade(
			builtins,
			buildServerStores(serverRoleStore),
			{ getOrCreate: () => undefined } as any,
		);
		assert.equal(cascade.resolveRoleModel("coder"), "anthropic/builtin-model");
		assert.equal(cascade.resolveRoleThinkingLevel("coder"), undefined);
	});

});
