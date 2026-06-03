/**
 * Unit tests for the round-5 server-side marketplace fixes:
 *  1. update() refreshes ONLY tracked entities for BOTH pack and subset installs
 *     (no auto-add of newly-declared entities; install intent preserved).
 *  2. PackSummary / PackDetail expose `newEntitiesAvailable` (declared entities
 *     not in the install record).
 *  3. Drift detection via per-entity contentHash — edited files report
 *     `drifted`; legacy records without a hash fall back to existence-only.
 *  4. URL credential redaction also strips query-string / fragment tokens.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { makeHarness, pack, localSource, tmpDir, SOURCE_A } from "./helpers/marketplace-harness.ts";

const { MarketplaceService } = await import("../src/server/marketplace/service.ts");
const { redactGitUrl } = await import("../src/server/marketplace/source-registry.ts");

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

const findPack = (service: InstanceType<typeof MarketplaceService>, packId: string) =>
	service.listPacks("system", null).find((p) => p.packId === packId)!;

// ── Fix 1: update refreshes only tracked entities (pack AND subset) ──────────

describe("marketplace fix: update refreshes only tracked entities", () => {
	it("a whole-pack install whose tracked set is partial does NOT auto-add the rest on update", () => {
		const h = makeHarness();
		// Whole-pack install of a pack that, at the time, declared only the role.
		const initial = pack("research-pack");
		initial.entities = initial.entities.filter((e) => e.type === "role");
		h.service.install({ scope: "project", projectId: "p1", source: localSource(), pack: initial, entities: null, conflict: "fail" });

		// Upstream now declares role + tool + skill. Update refreshes the role only.
		h.service.update({ scope: "project", projectId: "p1", source: localSource(), pack: pack("research-pack") });
		const rec = h.projectProvenance().find("src-a", "research-pack")!;
		assert.deepEqual(rec.entities.map((e) => e.type), ["role"]);
		assert.equal(rec.installMode, "pack", "install intent preserved");
		assert.ok(!fs.existsSync(path.join(h.projectConfigDir, "tools", "research")));
		assert.ok(!fs.existsSync(path.join(h.projectConfigDir, "skills", "deep-research")));
	});

	it("update drops a tracked entity the pack no longer declares (no orphans)", () => {
		const h = makeHarness();
		h.service.install({ scope: "project", projectId: "p1", source: localSource(), pack: pack("research-pack"), entities: null, conflict: "fail" });

		// Upstream drops the tool + skill.
		const trimmed = pack("research-pack");
		trimmed.entities = trimmed.entities.filter((e) => e.type === "role");
		h.service.update({ scope: "project", projectId: "p1", source: localSource(), pack: trimmed });

		const rec = h.projectProvenance().find("src-a", "research-pack")!;
		assert.deepEqual(rec.entities.map((e) => e.type), ["role"]);
		assert.ok(fs.existsSync(path.join(h.projectConfigDir, "roles", "researcher.yaml")));
		assert.ok(!fs.existsSync(path.join(h.projectConfigDir, "tools", "research")));
		assert.ok(!fs.existsSync(path.join(h.projectConfigDir, "skills", "deep-research")));
	});
});

// ── Fix 2: newEntitiesAvailable ─────────────────────────────────────────────

describe("marketplace fix: newEntitiesAvailable", () => {
	it("is 0 when the pack is not installed", () => {
		const { service } = makeService();
		const src = service.addSource({ kind: "local", path: SOURCE_A });
		assert.equal(findPack(service, "research-pack").newEntitiesAvailable, 0);
		assert.equal(service.getPackDetail(src.id, "research-pack", "system", null)!.newEntitiesAvailable, 0);
	});

	it("counts declared entities missing from a subset install (summary + detail)", () => {
		const { service } = makeService();
		const src = service.addSource({ kind: "local", path: SOURCE_A });
		service.installPack({
			sourceId: src.id, packId: "research-pack", scope: "system", projectId: null,
			entities: [{ type: "role", name: "researcher" }], conflict: "fail",
		});
		assert.equal(findPack(service, "research-pack").newEntitiesAvailable, 2); // tool + skill
		assert.equal(service.getPackDetail(src.id, "research-pack", "system", null)!.newEntitiesAvailable, 2);
	});

	it("is 0 after a whole-pack install (everything tracked)", () => {
		const { service } = makeService();
		const src = service.addSource({ kind: "local", path: SOURCE_A });
		service.installPack({ sourceId: src.id, packId: "research-pack", scope: "system", projectId: null, entities: null, conflict: "fail" });
		assert.equal(findPack(service, "research-pack").newEntitiesAvailable, 0);
	});
});

// ── Fix 3: drift detection via per-entity contentHash ───────────────────────

describe("marketplace fix: drift detection via contentHash", () => {
	it("reports drifted when an installed file is edited locally", () => {
		const { service, systemConfigDir } = makeService();
		const src = service.addSource({ kind: "local", path: SOURCE_A });
		service.installPack({ sourceId: src.id, packId: "roles-only-pack", scope: "system", projectId: null, entities: null, conflict: "fail" });
		assert.equal(findPack(service, "roles-only-pack").installStatus, "installed");

		fs.appendFileSync(path.join(systemConfigDir, "roles", "analyst.yaml"), "\n# locally edited\n");
		assert.equal(findPack(service, "roles-only-pack").installStatus, "drifted");
		assert.equal(service.getPackDetail(src.id, "roles-only-pack", "system", null)!.installStatus, "drifted");
	});

	it("reports drifted when an installed file is missing", () => {
		const { service, systemConfigDir } = makeService();
		const src = service.addSource({ kind: "local", path: SOURCE_A });
		service.installPack({ sourceId: src.id, packId: "roles-only-pack", scope: "system", projectId: null, entities: null, conflict: "fail" });

		fs.rmSync(path.join(systemConfigDir, "roles", "analyst.yaml"), { force: true });
		assert.equal(findPack(service, "roles-only-pack").installStatus, "drifted");
	});

	it("legacy records without contentHash fall back to existence-only (edits not flagged)", () => {
		const { service, systemConfigDir } = makeService();
		const src = service.addSource({ kind: "local", path: SOURCE_A });
		service.installPack({ sourceId: src.id, packId: "roles-only-pack", scope: "system", projectId: null, entities: null, conflict: "fail" });

		// Simulate a record written before the contentHash field existed.
		const file = path.join(systemConfigDir, "marketplace", "installed.json");
		const data = JSON.parse(fs.readFileSync(file, "utf-8"));
		for (const inst of data.installs) for (const e of inst.entities) delete e.contentHash;
		fs.writeFileSync(file, JSON.stringify(data, null, 2));

		fs.appendFileSync(path.join(systemConfigDir, "roles", "analyst.yaml"), "\n# edited\n");
		assert.equal(findPack(service, "roles-only-pack").installStatus, "installed");
	});

	it("records a per-entity contentHash at install time", () => {
		const { service, systemConfigDir } = makeService();
		service.addSource({ kind: "local", path: SOURCE_A });
		service.installPack({ sourceId: service.listSources()[0].id, packId: "research-pack", scope: "system", projectId: null, entities: null, conflict: "fail" });
		const data = JSON.parse(fs.readFileSync(path.join(systemConfigDir, "marketplace", "installed.json"), "utf-8"));
		assert.ok(data.installs[0].entities.every((e: { contentHash?: string }) => typeof e.contentHash === "string" && e.contentHash.length > 0));
	});
});

// ── Fix 4: query-string / fragment credential redaction ─────────────────────

describe("marketplace fix: redactGitUrl strips query-string + fragment tokens", () => {
	it("strips userinfo, sensitive query params, and a token-bearing fragment", () => {
		assert.equal(redactGitUrl("https://user:ghp_x@github.com/acme/packs.git"), "https://github.com/acme/packs.git");
		assert.equal(redactGitUrl("https://github.com/acme/packs.git?token=ghp_secret"), "https://github.com/acme/packs.git");
		assert.equal(redactGitUrl("https://github.com/acme/packs.git?access_token=abc&ref=main"), "https://github.com/acme/packs.git?ref=main");
		assert.equal(redactGitUrl("https://github.com/acme/packs.git#access_token=abc"), "https://github.com/acme/packs.git");
	});

	it("leaves credential-free URLs and non-URL forms unchanged", () => {
		assert.equal(redactGitUrl("https://github.com/acme/packs.git"), "https://github.com/acme/packs.git");
		assert.equal(redactGitUrl("https://github.com/acme/packs.git?ref=v1#readme"), "https://github.com/acme/packs.git?ref=v1#readme");
		assert.equal(redactGitUrl("git@github.com:acme/packs.git"), "git@github.com:acme/packs.git");
	});

	it("addSource / listSources never surface a query-string token (storage keeps it for auth)", () => {
		const { service, stateDir } = makeService();
		const added = service.addSource({ kind: "git", url: "https://github.com/acme/packs.git?token=ghp_secret", label: "packs" });
		assert.ok(!added.url!.includes("ghp_secret"));
		assert.equal(service.listSources()[0].url, "https://github.com/acme/packs.git");

		const raw = fs.readFileSync(path.join(stateDir, "marketplace", "sources.json"), "utf-8");
		assert.ok(raw.includes("ghp_secret"), "storage retains the credential for auth");
	});
});
