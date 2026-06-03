/**
 * Unit tests for the marketplace install pipeline (§6): file operations,
 * skill custom-dir registration, subset install, and cascade resolution of
 * an installed role.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { makeHarness, pack, localSource } from "./helpers/marketplace-harness.ts";
import { parseCustomDirectories } from "../src/server/agent/config-directories.ts";

const { RoleStore } = await import("../src/server/agent/role-store.ts");
const { ConfigCascade } = await import("../src/server/agent/config-cascade.ts");
const { BuiltinConfigProvider } = await import("../src/server/agent/builtin-config.ts");

describe("marketplace install — file operations", () => {
	it("whole-pack install copies role yaml, tool group dir (recursive), and skill dir to project scope", () => {
		const h = makeHarness();
		const outcome = h.service.install({
			scope: "project", projectId: "p1", source: localSource(), pack: pack("research-pack"), entities: null, conflict: "fail",
		});
		assert.equal(outcome.results.filter((r) => r.status === "installed").length, 3);

		// Role file
		assert.ok(fs.existsSync(path.join(h.projectConfigDir, "roles", "researcher.yaml")));
		// Tool group dir incl. extension.ts + _shared/
		assert.ok(fs.existsSync(path.join(h.projectConfigDir, "tools", "research", "web_dig.yaml")));
		assert.ok(fs.existsSync(path.join(h.projectConfigDir, "tools", "research", "extension.ts")));
		assert.ok(fs.existsSync(path.join(h.projectConfigDir, "tools", "research", "_shared", "http.ts")));
		// Skill dir incl. nested references/
		assert.ok(fs.existsSync(path.join(h.projectConfigDir, "skills", "deep-research", "SKILL.md")));
		assert.ok(fs.existsSync(path.join(h.projectConfigDir, "skills", "deep-research", "references", "methodology.md")));
	});

	it("project-scope skill install registers an absolute custom skills dir in project config", () => {
		const h = makeHarness();
		h.service.install({
			scope: "project", projectId: "p1", source: localSource(), pack: pack("research-pack"), entities: null, conflict: "fail",
		});
		const dirs = parseCustomDirectories(h.projectConfigStore);
		const skillsDir = path.join(h.projectConfigDir, "skills");
		const entry = dirs.find((d) => path.resolve(d.path) === path.resolve(skillsDir));
		assert.ok(entry, "custom skills dir should be registered");
		assert.ok(path.isAbsolute(entry!.path), "registered path must be absolute");
		assert.ok(entry!.types.includes("skills"));
	});

	it("system-scope skill install lands in the system skills dir without custom-dir registration", () => {
		const h = makeHarness();
		h.service.install({
			scope: "system", projectId: null, source: localSource(), pack: pack("research-pack"), entities: null, conflict: "fail",
		});
		assert.ok(fs.existsSync(path.join(h.systemSkillsDir, "deep-research", "SKILL.md")));
	});

	it("subset install copies only the requested entities", () => {
		const h = makeHarness();
		const outcome = h.service.install({
			scope: "project", projectId: "p1", source: localSource(), pack: pack("research-pack"),
			entities: [{ type: "role", name: "researcher" }], conflict: "fail",
		});
		assert.equal(outcome.results.length, 1);
		assert.ok(fs.existsSync(path.join(h.projectConfigDir, "roles", "researcher.yaml")));
		assert.ok(!fs.existsSync(path.join(h.projectConfigDir, "tools", "research")));
		assert.ok(!fs.existsSync(path.join(h.projectConfigDir, "skills", "deep-research")));
	});

	it("installed role at system scope resolves through ConfigCascade with origin 'server'", () => {
		const h = makeHarness();
		h.service.install({
			scope: "system", projectId: null, source: localSource(), pack: pack("roles-only-pack"), entities: null, conflict: "fail",
		});
		const serverRoleStore = new RoleStore(h.systemConfigDir);
		const cascade = new ConfigCascade(
			new BuiltinConfigProvider(),
			{
				getRoles: () => serverRoleStore.getAllLocal(),
				getTools: () => [],
				getToolGroupPolicies: () => ({}),
			},
			{ getOrCreate: () => null } as any,
		);
		const resolved = cascade.resolveRoles(undefined);
		const analyst = resolved.find((r) => r.item.name === "analyst");
		assert.ok(analyst, "installed role should resolve through the cascade");
		assert.equal(analyst!.origin, "server");
	});
});
