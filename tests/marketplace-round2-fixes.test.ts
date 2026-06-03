/**
 * Unit tests for the round-2 server-side marketplace review fixes:
 *  1. git clone option injection — reject `-`-leading URLs, validate scheme + ref, `--` terminators
 *  2. symlink escape — packs containing symlinks under roles/tools/skills are invalid + never copied/hashed
 *  3. uninstall path containment — a tampered installed.json cannot delete files outside the scope root
 *  4. update transactionality + installMode pack/subset semantics
 *  5. subset-install provenance MERGE (union, not replace)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { makeHarness, pack, localSource, tmpDir, SOURCE_A } from "./helpers/marketplace-harness.ts";

const { MarketplaceService } = await import("../src/server/marketplace/service.ts");
const { ProvenanceStore } = await import("../src/server/marketplace/provenance-store.ts");
const { scanPackDir } = await import("../src/server/marketplace/pack-scanner.ts");
const { GitSourceBackend } = await import("../src/server/marketplace/sync-service.ts");
const { validateGitUrl, validateGitRef } = await import("../src/server/marketplace/source-registry.ts");
const { ENTITY_HANDLERS, findSymlink } = await import("../src/server/marketplace/entity-handlers.ts");

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

/** Create a symlink, returning false (so the caller can skip) if the platform forbids it. */
function trySymlink(target: string, linkPath: string): boolean {
	try {
		fs.symlinkSync(target, linkPath);
		return true;
	} catch {
		return false;
	}
}

// ── Fix 1: git clone option injection ───────────────────────────────────────

describe("marketplace fix: git url/ref validation rejects option injection", () => {
	it("validateGitUrl rejects a `-`-leading url and disallowed schemes", () => {
		assert.throws(() => validateGitUrl("-oProxyCommand=touch /tmp/pwn"), /must not start with/i);
		assert.throws(() => validateGitUrl("ext::sh -c whoami"), /scheme must be one of/i);
	});

	it("validateGitUrl accepts well-known schemes and scp-like syntax", () => {
		for (const ok of [
			"https://github.com/acme/packs.git",
			"ssh://git@github.com/acme/packs.git",
			"git://github.com/acme/packs.git",
			"file:///srv/packs",
			"git@github.com:acme/packs.git",
		]) {
			assert.doesNotThrow(() => validateGitUrl(ok), `expected ${ok} to be accepted`);
		}
	});

	it("validateGitRef rejects a `-`-leading ref and unsafe characters", () => {
		assert.throws(() => validateGitRef("-x"), /must not start with/i);
		assert.throws(() => validateGitRef("a b"), /must match/i);
		assert.throws(() => validateGitRef("a;b"), /must match/i);
		assert.doesNotThrow(() => validateGitRef("release/1.2.x"));
	});

	it("addSource rejects a `-`-leading git url, a bad scheme, and a `-`-leading ref", () => {
		const { service } = makeService();
		assert.throws(() => service.addSource({ kind: "git", url: "-oProxyCommand=evil" }), /must not start with/i);
		assert.throws(() => service.addSource({ kind: "git", url: "ext::sh -c whoami" }), /scheme must be one of/i);
		assert.throws(() => service.addSource({ kind: "git", url: "https://h/r.git", ref: "-x" }), /ref must not start/i);
		const ok = service.addSource({ kind: "git", url: "https://github.com/acme/packs.git", ref: "main" });
		assert.ok(ok.id);
	});

	it("GitSourceBackend.sync refuses a `-`-leading url/ref without invoking git", async () => {
		const backend = new GitSourceBackend();
		const base = {
			id: "g1", kind: "git" as const, url: "-oProxyCommand=evil", ref: null,
			path: null, label: null, addedAt: 0, lastSyncedAt: null, lastSyncCommit: null, lastSyncError: null,
		};
		const res = await backend.sync(base, tmpDir("bobbit-market-clone-"));
		assert.match(res.error ?? "", /must not start with/i);
		assert.equal(res.commit, null);

		const badRef = { ...base, url: "https://github.com/acme/packs.git", ref: "-x" };
		const res2 = await backend.sync(badRef, tmpDir("bobbit-market-clone2-"));
		assert.match(res2.error ?? "", /ref must not start/i);
	});
});

// ── Fix 2: symlink escape in pack payloads ──────────────────────────────────

describe("marketplace fix: symlink payloads are rejected, never copied or hashed", () => {
	function writeSecret(root: string): string {
		const secret = path.join(root, "secret.txt");
		fs.writeFileSync(secret, "TOPSECRET-HOST-FILE");
		return secret;
	}

	it("a role that is a symlink makes the pack invalid (top-level symlink)", () => {
		const root = tmpDir("bobbit-market-symrole-");
		const secret = writeSecret(root);
		const packDir = path.join(root, "evil-pack");
		fs.mkdirSync(path.join(packDir, "roles"), { recursive: true });
		if (!trySymlink(secret, path.join(packDir, "roles", "leak.yaml"))) return; // platform forbids symlinks
		fs.writeFileSync(
			path.join(packDir, "pack.yaml"),
			`apiVersion: 1\nid: evil-pack\nname: Evil\ndescription: d\nversion: "1"\ncontents:\n  roles:\n    - leak\n`,
		);

		const scanned = scanPackDir("src-x", packDir);
		assert.equal(scanned.valid, false);
		assert.match(scanned.error ?? "", /symlink/i);

		// Install refuses an invalid pack — nothing is copied.
		const h = makeHarness();
		assert.throws(
			() => h.service.install({ scope: "system", projectId: null, source: localSource(), pack: scanned, entities: null, conflict: "fail" }),
			/invalid/i,
		);
		assert.ok(!fs.existsSync(path.join(h.systemConfigDir, "roles", "leak.yaml")));
	});

	it("a symlink nested inside a tool group dir makes the pack invalid (recursive detection)", () => {
		const root = tmpDir("bobbit-market-symtool-");
		const secret = writeSecret(root);
		const packDir = path.join(root, "evil-pack");
		const toolDir = path.join(packDir, "tools", "research");
		fs.mkdirSync(toolDir, { recursive: true });
		fs.writeFileSync(path.join(toolDir, "web_dig.yaml"), "name: web_dig\n");
		if (!trySymlink(secret, path.join(toolDir, "leak.ts"))) return; // platform forbids symlinks
		fs.writeFileSync(
			path.join(packDir, "pack.yaml"),
			`apiVersion: 1\nid: evil-pack\nname: Evil\ndescription: d\nversion: "1"\ncontents:\n  tools:\n    - research\n`,
		);

		const scanned = scanPackDir("src-x", packDir);
		assert.equal(scanned.valid, false);
		assert.match(scanned.error ?? "", /symlink/i);

		// findSymlink surfaces the offending node.
		assert.ok(findSymlink(toolDir));
	});
});

// ── Fix 3: uninstall path containment ───────────────────────────────────────

describe("marketplace fix: uninstall path containment", () => {
	it("a tampered installed.json cannot delete files outside the scope root", () => {
		const { service, systemConfigDir } = makeService();
		const src = service.addSource({ kind: "local", path: SOURCE_A });
		service.installPack({ sourceId: src.id, packId: "roles-only-pack", scope: "system", projectId: null, entities: null, conflict: "fail" });

		// Plant a sentinel OUTSIDE the scope and inject it into the provenance file.
		const outside = tmpDir("bobbit-market-outside-");
		const sentinel = path.join(outside, "keep.txt");
		fs.writeFileSync(sentinel, "DO-NOT-DELETE");
		const file = path.join(systemConfigDir, "marketplace", "installed.json");
		const data = JSON.parse(fs.readFileSync(file, "utf-8"));
		data.installs[0].entities[0].installedPaths.push(sentinel);
		fs.writeFileSync(file, JSON.stringify(data, null, 2));

		service.uninstallPack({ sourceId: src.id, packId: "roles-only-pack", scope: "system", projectId: null });

		assert.ok(fs.existsSync(sentinel), "an out-of-scope path must never be deleted");
		assert.ok(!fs.existsSync(path.join(systemConfigDir, "roles", "analyst.yaml")), "the in-scope role is still removed");
	});

	it("ProvenanceStore drops malformed records on load", () => {
		const dir = tmpDir("bobbit-market-prov-");
		const file = path.join(dir, "marketplace", "installed.json");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const valid = {
			scope: "system", projectId: null, sourceId: "s", packId: "p", packName: "P", packVersion: "1",
			sourceKind: "local", sourceUrl: null, sourceCommit: null, sourceContentHash: null,
			installedAt: 0, installMode: "pack", entities: [{ type: "role", name: "r", installedPaths: ["/x/r.yaml"] }],
		};
		fs.writeFileSync(file, JSON.stringify({
			version: 1,
			installs: [
				{ sourceId: 123 },                                   // bad: sourceId not a string
				{ sourceId: "a", packId: "b", scope: "weird", entities: [] }, // bad: scope
				{ sourceId: "a", packId: "b", scope: "system", entities: [{ type: "nope", name: "x", installedPaths: [] }] }, // bad: entity type
				valid,
			],
		}, null, 2));

		const store = new ProvenanceStore(dir);
		const all = store.list();
		assert.equal(all.length, 1);
		assert.equal(all[0].packId, "p");
	});

	it("a legacy record without installMode defaults to \"pack\" on load", () => {
		const dir = tmpDir("bobbit-market-prov2-");
		const file = path.join(dir, "marketplace", "installed.json");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({
			version: 1,
			installs: [{
				scope: "system", projectId: null, sourceId: "s", packId: "p", packName: "P", packVersion: "1",
				sourceKind: "local", sourceUrl: null, sourceCommit: null, sourceContentHash: null,
				installedAt: 0, entities: [{ type: "role", name: "r", installedPaths: ["/x/r.yaml"] }],
			}],
		}, null, 2));
		const store = new ProvenanceStore(dir);
		assert.equal(store.list()[0].installMode, "pack");
	});
});

// ── Fix 4: update transactionality + pack/subset semantics ───────────────────

describe("marketplace fix: update semantics + transactionality", () => {
	it("whole-pack update installs an upstream-added entity", () => {
		const h = makeHarness();
		// Initial whole-pack install of a pack that (at the time) declares only the role.
		const initial = pack("research-pack");
		initial.entities = initial.entities.filter((e) => e.type === "role");
		h.service.install({ scope: "project", projectId: "p1", source: localSource(), pack: initial, entities: null, conflict: "fail" });
		let rec = h.projectProvenance().find("src-a", "research-pack")!;
		assert.equal(rec.installMode, "pack");
		assert.deepEqual(rec.entities.map((e) => e.type), ["role"]);

		// Upstream now declares all three entities. A whole-pack update adds them.
		h.service.update({ scope: "project", projectId: "p1", source: localSource(), pack: pack("research-pack") });
		rec = h.projectProvenance().find("src-a", "research-pack")!;
		assert.deepEqual(rec.entities.map((e) => e.type).sort(), ["role", "skill", "tool"]);
		assert.ok(fs.existsSync(path.join(h.projectConfigDir, "tools", "research", "web_dig.yaml")));
		assert.ok(fs.existsSync(path.join(h.projectConfigDir, "skills", "deep-research", "SKILL.md")));
	});

	it("subset update does NOT auto-add a newly-declared entity", () => {
		const h = makeHarness();
		h.service.install({
			scope: "project", projectId: "p1", source: localSource(), pack: pack("research-pack"),
			entities: [{ type: "role", name: "researcher" }], conflict: "fail",
		});
		assert.equal(h.projectProvenance().find("src-a", "research-pack")!.installMode, "subset");

		h.service.update({ scope: "project", projectId: "p1", source: localSource(), pack: pack("research-pack") });
		const rec = h.projectProvenance().find("src-a", "research-pack")!;
		assert.deepEqual(rec.entities.map((e) => e.type), ["role"]);
		assert.ok(!fs.existsSync(path.join(h.projectConfigDir, "tools", "research")));
		assert.ok(!fs.existsSync(path.join(h.projectConfigDir, "skills", "deep-research")));
	});

	it("a mid-update failure restores the prior state intact (no orphaned deletes, no leftover backups)", () => {
		const h = makeHarness();
		// Install role + skill (whole-pack of a pack that, at the time, omits the tool).
		const initial = pack("research-pack");
		initial.entities = initial.entities.filter((e) => e.type !== "tool");
		h.service.install({ scope: "project", projectId: "p1", source: localSource(), pack: initial, entities: null, conflict: "fail" });

		// Mark the on-disk role so we can prove it was RESTORED (not freshly re-copied).
		const roleDest = path.join(h.projectConfigDir, "roles", "researcher.yaml");
		fs.appendFileSync(roleDest, "\n# SENTINEL-KEEP\n");

		// Force the tool copy to fail: plant a FILE where the tools group dir must be created.
		fs.writeFileSync(path.join(h.projectConfigDir, "tools"), "not a dir");

		// Whole-pack update now declares the tool too → role refresh succeeds, tool copy fails.
		assert.throws(() => h.service.update({
			scope: "project", projectId: "p1", source: localSource(), pack: pack("research-pack"),
		}));

		// Role restored to the exact pre-update bytes (sentinel survives).
		assert.match(fs.readFileSync(roleDest, "utf-8"), /SENTINEL-KEEP/);
		// Skill untouched.
		assert.ok(fs.existsSync(path.join(h.projectConfigDir, "skills", "deep-research", "SKILL.md")));
		// Provenance unchanged: still role + skill, mode pack.
		const rec = h.projectProvenance().find("src-a", "research-pack")!;
		assert.deepEqual(rec.entities.map((e) => e.type).sort(), ["role", "skill"]);
		assert.equal(rec.installMode, "pack");
		// No leftover backup files.
		const leftovers = fs.readdirSync(path.join(h.projectConfigDir, "roles")).filter((f) => f.includes(".mp-bak-"));
		assert.deepEqual(leftovers, []);
	});
});

// ── Fix 5: subset-install provenance merge ──────────────────────────────────

describe("marketplace fix: subset-install provenance merge", () => {
	it("installing entity A then entity B keeps BOTH; pack uninstall removes BOTH", () => {
		const h = makeHarness();
		h.service.install({
			scope: "project", projectId: "p1", source: localSource(), pack: pack("research-pack"),
			entities: [{ type: "role", name: "researcher" }], conflict: "fail",
		});
		h.service.install({
			scope: "project", projectId: "p1", source: localSource(), pack: pack("research-pack"),
			entities: [{ type: "tool", name: "research" }], conflict: "fail",
		});

		const rec = h.projectProvenance().find("src-a", "research-pack")!;
		assert.deepEqual(
			rec.entities.map((e) => `${e.type}/${e.name}`).sort(),
			["role/researcher", "tool/research"],
		);
		assert.equal(rec.installMode, "subset"); // skill still missing → not whole-pack

		h.service.uninstall({ scope: "project", projectId: "p1", sourceId: "src-a", packId: "research-pack" });
		assert.ok(!fs.existsSync(path.join(h.projectConfigDir, "roles", "researcher.yaml")));
		assert.ok(!fs.existsSync(path.join(h.projectConfigDir, "tools", "research")));
	});

	it("subset installs that together cover all declared entities flip installMode to \"pack\"", () => {
		const h = makeHarness();
		for (const ref of [
			{ type: "role" as const, name: "researcher" },
			{ type: "tool" as const, name: "research" },
			{ type: "skill" as const, name: "deep-research" },
		]) {
			h.service.install({
				scope: "project", projectId: "p1", source: localSource(), pack: pack("research-pack"),
				entities: [ref], conflict: "fail",
			});
		}
		const rec = h.projectProvenance().find("src-a", "research-pack")!;
		assert.equal(rec.entities.length, 3);
		assert.equal(rec.installMode, "pack");
	});
});
