/**
 * Unit tests for the server-side marketplace review fixes:
 *  1. path-traversal validation (scanner + handlers)
 *  2. overwrite-install backup/restore (no data loss on mid-install failure)
 *  3. updatePack aborts on sync error (no stale re-copy / provenance rewrite)
 *  4. skill uninstall preserves other config-dir types on the same path
 *  5. credential redaction in source DTOs
 *  6. flat drill-down contract from getPackDetail / the packs route
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeHarness, pack, localSource, tmpDir, SOURCE_A } from "./helpers/marketplace-harness.ts";
import {
	parseCustomDirectories,
	saveCustomDirectories,
} from "../src/server/agent/config-directories.ts";

const { scanPackDir } = await import("../src/server/marketplace/pack-scanner.ts");
const { MarketplaceService } = await import("../src/server/marketplace/service.ts");
const { redactSourceUrl } = await import("../src/server/marketplace/source-registry.ts");
const { ProvenanceStore } = await import("../src/server/marketplace/provenance-store.ts");

// ── Fix 1: path traversal ──────────────────────────────────────────────────

describe("marketplace fix: path-traversal validation", () => {
	function writeEvilPack(root: string, badName: string): string {
		const packDir = path.join(root, "evil-pack");
		fs.mkdirSync(path.join(packDir, "roles"), { recursive: true });
		// A legit sibling role so the pack would otherwise be valid.
		fs.writeFileSync(path.join(packDir, "roles", "ok.yaml"), "name: ok\n");
		fs.writeFileSync(
			path.join(packDir, "pack.yaml"),
			`apiVersion: 1\nid: evil-pack\nname: Evil\ndescription: d\nversion: "1"\ncontents:\n  roles:\n    - ok\n    - ${JSON.stringify(badName)}\n`,
		);
		return packDir;
	}

	it("marks a pack invalid when an entity name escapes its directory", () => {
		const root = tmpDir("bobbit-market-evil-");
		const scanned = scanPackDir("src-x", writeEvilPack(root, "../evil"));
		assert.equal(scanned.valid, false);
		assert.match(scanned.error ?? "", /invalid entity name/i);
		// The escaping name never becomes a resolved entity.
		assert.ok(!scanned.entities.some((e) => e.name.includes("..")));
	});

	it("rejects names with path separators and absolute paths", () => {
		const root = tmpDir("bobbit-market-evil2-");
		for (const bad of ["a/b", "/etc/passwd", "..", ".hidden", "C:evil"]) {
			const scanned = scanPackDir("src-x", writeEvilPack(root, bad));
			assert.equal(scanned.valid, false, `expected ${bad} to be rejected`);
		}
	});

	it("install refuses an invalid (escaping) pack and writes nothing outside scope", () => {
		const root = tmpDir("bobbit-market-evil3-");
		const scanned = scanPackDir("src-x", writeEvilPack(root, "../evil"));
		const h = makeHarness();
		assert.throws(
			() => h.service.install({ scope: "system", projectId: null, source: localSource(), pack: scanned, entities: null, conflict: "fail" }),
			/invalid/i,
		);
		// No file escaped to the parent of the pack dir.
		assert.ok(!fs.existsSync(path.join(root, "evil.yaml")));
	});
});

// ── Fix 2: overwrite-install backup/restore ─────────────────────────────────

describe("marketplace fix: overwrite-install is transactional (no data loss)", () => {
	it("restores a clobbered entity when a later entity install fails", () => {
		const h = makeHarness();
		// Pre-existing role with sentinel content at the install scope.
		fs.mkdirSync(path.join(h.projectConfigDir, "roles"), { recursive: true });
		const roleDest = path.join(h.projectConfigDir, "roles", "researcher.yaml");
		fs.writeFileSync(roleDest, "name: researcher\n# ORIGINAL-DO-NOT-LOSE\n");
		// Plant a FILE at <configDir>/tools so the tool copy (second target) fails.
		fs.writeFileSync(path.join(h.projectConfigDir, "tools"), "not a dir");

		assert.throws(() => h.service.install({
			scope: "project", projectId: "p1", source: localSource(), pack: pack("research-pack"),
			// role first (conflicts → overwrite path), tool second (fails mid-install).
			entities: [{ type: "role", name: "researcher" }, { type: "tool", name: "research" }],
			conflict: "overwrite",
		}));

		// The pre-existing role must be intact — restored from backup.
		assert.ok(fs.existsSync(roleDest), "clobbered role must be restored");
		assert.match(fs.readFileSync(roleDest, "utf-8"), /ORIGINAL-DO-NOT-LOSE/);
		// No provenance persisted for the failed install.
		assert.equal(h.projectProvenance().find("src-a", "research-pack"), undefined);
		// No leftover backup files.
		const leftovers = fs.readdirSync(path.join(h.projectConfigDir, "roles")).filter((f) => f.includes(".mp-bak-"));
		assert.deepEqual(leftovers, []);
	});

	it("overwrite success replaces content and leaves no backup files", () => {
		const h = makeHarness();
		fs.mkdirSync(path.join(h.projectConfigDir, "roles"), { recursive: true });
		const roleDest = path.join(h.projectConfigDir, "roles", "researcher.yaml");
		fs.writeFileSync(roleDest, "name: researcher\n# stale\n");

		h.service.install({
			scope: "project", projectId: "p1", source: localSource(), pack: pack("research-pack"),
			entities: [{ type: "role", name: "researcher" }], conflict: "overwrite",
		});
		assert.ok(!fs.readFileSync(roleDest, "utf-8").includes("# stale"));
		const leftovers = fs.readdirSync(path.join(h.projectConfigDir, "roles")).filter((f) => f.includes(".mp-bak-"));
		assert.deepEqual(leftovers, []);
	});
});

// ── Fix 4: skill uninstall preserves other config-dir types ─────────────────

describe("marketplace fix: skill uninstall preserves other config-dir types", () => {
	it("removes only the skills registration, keeping a co-registered type", () => {
		const h = makeHarness();
		h.service.install({
			scope: "project", projectId: "p1", source: localSource(), pack: pack("research-pack"),
			entities: [{ type: "skill", name: "deep-research" }], conflict: "fail",
		});
		const skillsDir = path.join(h.projectConfigDir, "skills");

		// Co-register another type (mcp) on the same dir path.
		const dirs = parseCustomDirectories(h.projectConfigStore);
		const entry = dirs.find((d) => path.resolve(d.path) === path.resolve(skillsDir))!;
		assert.ok(entry, "skills dir should be registered after install");
		entry.types = [...entry.types, "mcp"];
		saveCustomDirectories(h.projectConfigStore, dirs);

		h.service.uninstall({ scope: "project", projectId: "p1", sourceId: "src-a", packId: "research-pack" });

		const after = parseCustomDirectories(h.projectConfigStore);
		const e2 = after.find((d) => path.resolve(d.path) === path.resolve(skillsDir));
		assert.ok(e2, "dir entry must survive because mcp is still registered");
		assert.deepEqual(e2!.types, ["mcp"]);
		assert.ok(!e2!.types.includes("skills"));
	});

	it("drops the dir entry entirely when skills was its only type", () => {
		const h = makeHarness();
		h.service.install({
			scope: "project", projectId: "p1", source: localSource(), pack: pack("research-pack"),
			entities: [{ type: "skill", name: "deep-research" }], conflict: "fail",
		});
		const skillsDir = path.join(h.projectConfigDir, "skills");

		h.service.uninstall({ scope: "project", projectId: "p1", sourceId: "src-a", packId: "research-pack" });

		const after = parseCustomDirectories(h.projectConfigStore);
		assert.ok(!after.some((d) => path.resolve(d.path) === path.resolve(skillsDir)));
	});
});

// ── Service-level fixes (3, 5, 6) ───────────────────────────────────────────

function makeService() {
	const stateDir = tmpDir("bobbit-market-state-");
	const systemConfigDir = tmpDir("bobbit-market-syscfg-");
	const systemSkillsDir = tmpDir("bobbit-market-sysskills-");
	const service = new MarketplaceService({
		stateDir,
		systemConfigDir,
		systemSkillsDir,
		resolveProject: () => null,
	});
	return { service, stateDir, systemConfigDir, systemSkillsDir };
}

describe("marketplace fix: credential redaction in source DTOs", () => {
	it("redactSourceUrl strips embedded credentials and leaves storage untouched", () => {
		const rec = redactSourceUrl({
			id: "x", kind: "git", url: "https://user:ghp_secret@github.com/acme/packs.git",
			ref: null, path: null, label: null, addedAt: 0,
			lastSyncedAt: null, lastSyncCommit: null, lastSyncError: null,
		});
		assert.equal(rec.url, "https://github.com/acme/packs.git");
	});

	it("addSource and listSources never return a token in the url DTO", () => {
		const { service, stateDir } = makeService();
		const added = service.addSource({ kind: "git", url: "https://user:ghp_secret@github.com/acme/packs.git" });
		assert.ok(!added.url!.includes("ghp_secret"));
		assert.equal(added.url, "https://github.com/acme/packs.git");

		const listed = service.listSources();
		assert.equal(listed.length, 1);
		assert.ok(!listed[0].url!.includes("ghp_secret"));

		// Storage retains the credential-bearing URL so the git backend can auth.
		const raw = fs.readFileSync(path.join(stateDir, "marketplace", "sources.json"), "utf-8");
		assert.ok(raw.includes("ghp_secret"), "storage should keep credentials for auth");
	});
});

describe("marketplace fix: updatePack aborts on sync error", () => {
	it("does not re-copy or rewrite provenance when the sync fails", async () => {
		const { service, systemConfigDir } = makeService();
		const src = service.addSource({ kind: "local", path: SOURCE_A });

		// Install first so a provenance record exists.
		service.installPack({ sourceId: src.id, packId: "roles-only-pack", scope: "system", projectId: null, entities: null, conflict: "fail" });
		const before = new ProvenanceStore(systemConfigDir).find(src.id, "roles-only-pack");
		assert.ok(before);

		// Force the next sync to fail.
		(service.sync as any).sync = async () => ({ root: "", commit: null, contentHash: null, error: "boom: network unreachable" });

		await assert.rejects(
			() => service.updatePack({ sourceId: src.id, packId: "roles-only-pack", scope: "system", projectId: null }),
			/failed to sync/i,
		);

		// Provenance is unchanged (not rewritten with a null/stale commit).
		const after = new ProvenanceStore(systemConfigDir).find(src.id, "roles-only-pack");
		assert.deepEqual(after, before);
	});
});

describe("marketplace fix: flat drill-down contract", () => {
	it("getPackDetail returns the flat shape with per-entity installed flags", () => {
		const { service } = makeService();
		const src = service.addSource({ kind: "local", path: SOURCE_A });

		const detail = service.getPackDetail(src.id, "research-pack", "system", null);
		assert.ok(detail);
		// Flat: no nested summary/pack/installedEntities keys.
		assert.equal((detail as any).summary, undefined);
		assert.equal((detail as any).pack, undefined);
		assert.equal((detail as any).installedEntities, undefined);

		assert.equal(detail!.sourceId, src.id);
		assert.equal(detail!.packId, "research-pack");
		assert.equal(detail!.name, "Research Pack");
		assert.equal(detail!.version, "1.2.0");
		assert.equal(detail!.author, "jane@example.com");
		assert.equal(detail!.license, "MIT");
		assert.equal(detail!.hasTools, true);
		assert.equal(detail!.valid, true);
		assert.equal(detail!.error, null);
		assert.equal(detail!.installStatus, "not-installed");
		assert.ok(Array.isArray(detail!.entities));
		assert.ok(detail!.entities.every((e) => e.installed === false));

		// After installing one entity, only that one flips to installed.
		service.installPack({ sourceId: src.id, packId: "research-pack", scope: "system", projectId: null, entities: [{ type: "role", name: "researcher" }], conflict: "fail" });
		const after = service.getPackDetail(src.id, "research-pack", "system", null)!;
		const role = after.entities.find((e) => e.type === "role" && e.name === "researcher")!;
		assert.equal(role.installed, true);
		const tool = after.entities.find((e) => e.type === "tool")!;
		assert.equal(tool.installed, false);
	});

	it("nulls optional manifest fields a pack omits", () => {
		const { service } = makeService();
		const src = service.addSource({ kind: "local", path: SOURCE_A });
		const detail = service.getPackDetail(src.id, "roles-only-pack", "system", null)!;
		assert.equal(detail.author, null);
		assert.equal(detail.homepage, null);
		assert.equal(detail.license, null);
		assert.equal(detail.minBobbit, null);
	});
});
