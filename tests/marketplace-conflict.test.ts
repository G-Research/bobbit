/**
 * Unit tests for marketplace conflict handling (§6.5):
 * fail / overwrite / skip modes, same-scope-only semantics, and rollback.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { makeHarness, pack, localSource } from "./helpers/marketplace-harness.ts";
import { ConflictError } from "../src/server/marketplace/install-service.ts";

function installResearch(h: ReturnType<typeof makeHarness>, conflict: "fail" | "overwrite" | "skip") {
	return h.service.install({
		scope: "project", projectId: "p1", source: localSource(), pack: pack("research-pack"), entities: null, conflict,
	});
}

describe("marketplace conflict handling", () => {
	it("fail mode aborts transactionally when a destination already exists", () => {
		const h = makeHarness();
		// Pre-create the role destination at the same scope.
		fs.mkdirSync(path.join(h.projectConfigDir, "roles"), { recursive: true });
		fs.writeFileSync(path.join(h.projectConfigDir, "roles", "researcher.yaml"), "name: researcher\n");

		assert.throws(() => installResearch(h, "fail"), (err: unknown) => {
			assert.ok(err instanceof ConflictError);
			assert.deepEqual(err.conflicts.map((c) => `${c.type}/${c.name}`), ["role/researcher"]);
			return true;
		});
		// Nothing else was written (transactional abort).
		assert.ok(!fs.existsSync(path.join(h.projectConfigDir, "tools", "research")));
		assert.ok(!fs.existsSync(path.join(h.projectConfigDir, "skills", "deep-research")));
		// No provenance record persisted.
		assert.equal(h.projectProvenance().find("src-a", "research-pack"), undefined);
	});

	it("overwrite mode replaces the existing entity", () => {
		const h = makeHarness();
		fs.mkdirSync(path.join(h.projectConfigDir, "roles"), { recursive: true });
		const dest = path.join(h.projectConfigDir, "roles", "researcher.yaml");
		fs.writeFileSync(dest, "name: researcher\n# stale\n");

		const outcome = installResearch(h, "overwrite");
		assert.equal(outcome.results.filter((r) => r.status === "installed").length, 3);
		assert.ok(!fs.readFileSync(dest, "utf-8").includes("# stale"));
	});

	it("skip mode installs only the non-conflicting entities", () => {
		const h = makeHarness();
		fs.mkdirSync(path.join(h.projectConfigDir, "roles"), { recursive: true });
		fs.writeFileSync(path.join(h.projectConfigDir, "roles", "researcher.yaml"), "name: researcher\n");

		const outcome = installResearch(h, "skip");
		assert.deepEqual(outcome.skipped.map((s) => `${s.type}/${s.name}`), ["role/researcher"]);
		// Non-conflicting entities still installed.
		assert.ok(fs.existsSync(path.join(h.projectConfigDir, "tools", "research")));
		assert.ok(fs.existsSync(path.join(h.projectConfigDir, "skills", "deep-research")));
	});

	it("a same-name entity at a different (system) scope is not a conflict", () => {
		const h = makeHarness();
		// Install at system scope first.
		h.service.install({
			scope: "system", projectId: null, source: localSource(), pack: pack("roles-only-pack"), entities: null, conflict: "fail",
		});
		// Installing at project scope must NOT be a conflict (cascade shadow).
		assert.doesNotThrow(() => h.service.install({
			scope: "project", projectId: "p1", source: localSource(), pack: pack("roles-only-pack"), entities: null, conflict: "fail",
		}));
		assert.ok(fs.existsSync(path.join(h.projectConfigDir, "roles", "analyst.yaml")));
	});

	it("a whole-pack install that SKIPS a conflict is recorded as \"subset\", not \"pack\"", () => {
		const h = makeHarness();
		// A pre-existing, hand-authored role at the same scope.
		fs.mkdirSync(path.join(h.projectConfigDir, "roles"), { recursive: true });
		const roleDest = path.join(h.projectConfigDir, "roles", "researcher.yaml");
		fs.writeFileSync(roleDest, "name: researcher\n# hand-authored\n");

		installResearch(h, "skip");

		const rec = h.projectProvenance().find("src-a", "research-pack")!;
		// installMode derives from COVERAGE, not the whole-pack request shape:
		// the skipped role is absent, so the record does not cover all declared.
		assert.equal(rec.installMode, "subset");
		assert.ok(!rec.entities.some((e) => `${e.type}/${e.name}` === "role/researcher"), "skipped entity is not in the record");
		assert.deepEqual(rec.entities.map((e) => `${e.type}/${e.name}`).sort(), ["skill/deep-research", "tool/research"]);
	});

	it("update() after a skip-install does NOT clobber the user's skipped entity", () => {
		const h = makeHarness();
		fs.mkdirSync(path.join(h.projectConfigDir, "roles"), { recursive: true });
		const roleDest = path.join(h.projectConfigDir, "roles", "researcher.yaml");
		fs.writeFileSync(roleDest, "name: researcher\n# SENTINEL-USER\n");

		installResearch(h, "skip");
		// Because the record is "subset", a whole-pack update must touch only the
		// tracked (installed) entities — never the user's deliberately-kept role.
		h.service.update({ scope: "project", projectId: "p1", source: localSource(), pack: pack("research-pack") });

		assert.match(fs.readFileSync(roleDest, "utf-8"), /SENTINEL-USER/, "user's role untouched by update");
		const rec = h.projectProvenance().find("src-a", "research-pack")!;
		assert.equal(rec.installMode, "subset");
		assert.ok(!rec.entities.some((e) => `${e.type}/${e.name}` === "role/researcher"), "skipped entity still not tracked after update");
	});

	it("a whole-pack install with no conflicts (and overwrite) records \"pack\" (regression guard)", () => {
		// No conflicts → covers all declared → "pack".
		const clean = makeHarness();
		installResearch(clean, "fail");
		assert.equal(clean.projectProvenance().find("src-a", "research-pack")!.installMode, "pack");

		// Overwrite of a conflicting entity still covers all declared → "pack".
		const h = makeHarness();
		fs.mkdirSync(path.join(h.projectConfigDir, "roles"), { recursive: true });
		fs.writeFileSync(path.join(h.projectConfigDir, "roles", "researcher.yaml"), "name: researcher\n# stale\n");
		installResearch(h, "overwrite");
		assert.equal(h.projectProvenance().find("src-a", "research-pack")!.installMode, "pack");
	});

	it("rolls back partial writes when a copy fails mid-transaction", () => {
		const h = makeHarness();
		// Plant a FILE at <configDir>/tools so creating the tools/research group
		// dir throws (ENOTDIR) — the tool entity copies second, after the role.
		fs.writeFileSync(path.join(h.projectConfigDir, "tools"), "not a dir");

		assert.throws(() => h.service.install({
			scope: "project", projectId: "p1", source: localSource(),
			// Order role before tool so the role copies first, then the tool fails.
			pack: pack("research-pack"),
			entities: [{ type: "role", name: "researcher" }, { type: "tool", name: "research" }],
			conflict: "fail",
		}));
		// The role that copied first must have been rolled back.
		assert.ok(!fs.existsSync(path.join(h.projectConfigDir, "roles", "researcher.yaml")));
	});
});
