/**
 * Unit tests for marketplace provenance (§7): record shape + location,
 * symmetric uninstall, custom-skill-dir deregistration, and update refresh.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { makeHarness, pack, localSource, MemConfigStore } from "./helpers/marketplace-harness.ts";
import { parseCustomDirectories } from "../src/server/agent/config-directories.ts";
import type { ScannedPack } from "../src/server/marketplace/types.ts";

describe("marketplace provenance", () => {
	it("install writes a record with exact installedPaths at the project provenance file", () => {
		const h = makeHarness();
		h.service.install({
			scope: "project", projectId: "p1", source: localSource(), pack: pack("research-pack"), entities: null, conflict: "fail",
		});
		const file = path.join(h.projectConfigDir, "marketplace", "installed.json");
		assert.ok(fs.existsSync(file));
		const record = h.projectProvenance().find("src-a", "research-pack")!;
		assert.equal(record.scope, "project");
		assert.equal(record.projectId, "p1");
		assert.equal(record.packVersion, "1.2.0");
		assert.equal(record.sourceKind, "local");
		assert.ok(record.sourceContentHash, "local source records a content hash");
		const role = record.entities.find((e) => e.type === "role")!;
		assert.deepEqual(role.installedPaths, [path.join(h.projectConfigDir, "roles", "researcher.yaml")]);
		const skill = record.entities.find((e) => e.type === "skill")!;
		assert.equal(skill.customDirRegistered, path.resolve(path.join(h.projectConfigDir, "skills")));
	});

	it("system-scope install writes provenance under the system config dir", () => {
		const h = makeHarness();
		h.service.install({
			scope: "system", projectId: null, source: localSource(), pack: pack("roles-only-pack"), entities: null, conflict: "fail",
		});
		assert.ok(fs.existsSync(path.join(h.systemConfigDir, "marketplace", "installed.json")));
		assert.ok(h.systemProvenance().find("src-a", "roles-only-pack"));
	});

	it("uninstall removes exactly the installed paths, the record, and an emptied custom skill dir", () => {
		const h = makeHarness();
		h.service.install({
			scope: "project", projectId: "p1", source: localSource(), pack: pack("research-pack"), entities: null, conflict: "fail",
		});
		const skillsDir = path.join(h.projectConfigDir, "skills");
		assert.ok(parseCustomDirectories(h.projectConfigStore).some((d) => path.resolve(d.path) === path.resolve(skillsDir)));

		h.service.uninstall({ scope: "project", projectId: "p1", sourceId: "src-a", packId: "research-pack" });

		assert.ok(!fs.existsSync(path.join(h.projectConfigDir, "roles", "researcher.yaml")));
		assert.ok(!fs.existsSync(path.join(h.projectConfigDir, "tools", "research")));
		assert.ok(!fs.existsSync(path.join(h.projectConfigDir, "skills", "deep-research")));
		assert.equal(h.projectProvenance().find("src-a", "research-pack"), undefined);
		// Custom skill dir deregistered now that it is empty.
		assert.ok(!parseCustomDirectories(h.projectConfigStore).some((d) => path.resolve(d.path) === path.resolve(skillsDir)));
	});

	it("update re-copies recorded entities, refreshes version, and drops entities no longer declared", () => {
		const h = makeHarness();
		h.service.install({
			scope: "project", projectId: "p1", source: localSource(), pack: pack("research-pack"), entities: null, conflict: "fail",
		});

		// Simulate an upstream change: the pack now declares only the role
		// (tool + skill dropped) and bumps its version.
		const updated: ScannedPack = pack("research-pack");
		updated.manifest!.version = "2.0.0";
		updated.entities = updated.entities.filter((e) => e.type === "role");

		// InstallService.update() refreshes recorded entities against the new
		// pack (no real sync needed — MarketplaceService layers the sync on top).
		h.service.update({ scope: "project", projectId: "p1", source: localSource(), pack: updated });

		const record = h.projectProvenance().find("src-a", "research-pack")!;
		assert.equal(record.packVersion, "2.0.0");
		assert.deepEqual(record.entities.map((e) => e.type), ["role"]);
		// Orphaned entities removed from disk.
		assert.ok(fs.existsSync(path.join(h.projectConfigDir, "roles", "researcher.yaml")));
		assert.ok(!fs.existsSync(path.join(h.projectConfigDir, "tools", "research")));
		assert.ok(!fs.existsSync(path.join(h.projectConfigDir, "skills", "deep-research")));
	});

	it("MemConfigStore round-trips config_directories JSON", () => {
		const store = new MemConfigStore();
		store.set("config_directories", JSON.stringify([{ path: "/abs/skills", types: ["skills"] }]));
		assert.deepEqual(parseCustomDirectories(store).map((d) => d.path), [path.resolve("/abs/skills")]);
	});
});
