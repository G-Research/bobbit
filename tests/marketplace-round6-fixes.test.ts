/**
 * Unit tests for the round-6 server-side marketplace review fixes:
 *  1. update() REMOVES the provenance record (not an empty upsert) when no
 *     tracked entity remains declared; computeInstallStatus treats an
 *     empty-entities record as not-installed.
 *  2. doCopy cleans up the partially-written failing entity's dest on a
 *     mid-copy error (no half-written entity left behind).
 *  3. parseInstallScope rejects an invalid/misspelled scope and a project
 *     scope without a projectId.
 *  4. scanSource rejects duplicate pack ids within one source (every colliding
 *     pack is marked invalid).
 *  5. the default git source label is derived from the REDACTED url (a token in
 *     the url never leaks into the surfaced label).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { makeHarness, localSource, tmpDir } from "./helpers/marketplace-harness.ts";

const { computeInstallStatus } = await import("../src/server/marketplace/provenance-store.ts");
const { scanPackDir, scanSource } = await import("../src/server/marketplace/pack-scanner.ts");
const { parseInstallScope } = await import("../src/server/marketplace/service.ts");
const { SourceRegistry } = await import("../src/server/marketplace/source-registry.ts");
import type { ProvenanceRecord, SourceRecord } from "../src/server/marketplace/types.ts";

/** Write a minimal single-role pack into a fresh temp dir; returns the pack dir. */
function writeRolePack(packId: string, roleName: string): string {
	const dir = path.join(tmpDir("bobbit-market-pack-"), packId);
	fs.mkdirSync(path.join(dir, "roles"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, "pack.yaml"),
		`apiVersion: 1\nid: ${packId}\nname: ${packId}\ndescription: test\nversion: 1.0.0\ncontents:\n  roles:\n    - ${roleName}\n`,
	);
	fs.writeFileSync(path.join(dir, "roles", `${roleName}.yaml`), `name: ${roleName}\nprompt: hi\n`);
	return dir;
}

/** Rewrite a role pack in place to declare a different role. */
function rewriteRolePack(dir: string, packId: string, roleName: string): void {
	fs.writeFileSync(
		path.join(dir, "pack.yaml"),
		`apiVersion: 1\nid: ${packId}\nname: ${packId}\ndescription: test\nversion: 2.0.0\ncontents:\n  roles:\n    - ${roleName}\n`,
	);
	fs.writeFileSync(path.join(dir, "roles", `${roleName}.yaml`), `name: ${roleName}\nprompt: hi\n`);
}

function trySymlink(target: string, linkPath: string): boolean {
	try { fs.symlinkSync(target, linkPath); return true; } catch { return false; }
}

// ── Fix 1: update removes the record when nothing tracked remains ────────────

describe("marketplace fix: update removes record with no tracked entities", () => {
	it("removes the provenance record (not an empty upsert) when the pack replaces its only entity", () => {
		const h = makeHarness();
		const src = localSource();
		const dir = writeRolePack("mp", "r1");

		h.service.install({ scope: "system", projectId: null, source: src, pack: scanPackDir(src.id, dir), entities: null, conflict: "fail" });
		assert.ok(h.systemProvenance().find(src.id, "mp"), "installed record present");
		assert.ok(fs.existsSync(path.join(h.systemConfigDir, "roles", "r1.yaml")));

		// Upstream replaces r1 with r2 — none of the TRACKED entities (r1) remain.
		rewriteRolePack(dir, "mp", "r2");
		const outcome = h.service.update({ scope: "system", projectId: null, source: src, pack: scanPackDir(src.id, dir) });

		assert.equal(outcome.record, null, "outcome reports no record");
		assert.equal(h.systemProvenance().find(src.id, "mp"), undefined, "record removed, not empty-upserted");
		assert.ok(!fs.existsSync(path.join(h.systemConfigDir, "roles", "r1.yaml")), "orphaned r1 removed");
		// r2 is newly-declared — update never auto-adds it.
		assert.ok(!fs.existsSync(path.join(h.systemConfigDir, "roles", "r2.yaml")));
	});

	it("computeInstallStatus treats an empty-entities record as not-installed", () => {
		const src: SourceRecord = localSource();
		const emptyRecord = { sourceId: src.id, packId: "mp", entities: [] } as unknown as ProvenanceRecord;
		assert.equal(computeInstallStatus(src, emptyRecord, null), "not-installed");
		assert.equal(computeInstallStatus(src, undefined, null), "not-installed");
	});
});

// ── Fix 2: doCopy cleans up the partial dest of a mid-copy failure ───────────

describe("marketplace fix: doCopy cleans up partially-written failing entity", () => {
	it("removes the failing tool group's dest dir when copy throws mid-write", (t) => {
		const h = makeHarness();
		const src = localSource();
		// A valid tool pack scanned BEFORE we inject a symlink, so install proceeds
		// then fails inside copyNoSymlinks, leaving a partial dest to clean up.
		const dir = path.join(tmpDir("bobbit-market-pack-"), "tp");
		const toolDir = path.join(dir, "tools", "mytool");
		fs.mkdirSync(toolDir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "pack.yaml"),
			"apiVersion: 1\nid: tp\nname: tp\ndescription: test\nversion: 1.0.0\ncontents:\n  tools:\n    - mytool\n",
		);
		fs.writeFileSync(path.join(toolDir, "a.yaml"), "name: mytool\ndescription: x\n");

		const scanned = scanPackDir(src.id, dir);
		assert.ok(scanned.valid, "pack scans valid before symlink injection");

		// Inject a symlink AFTER scan so install's copyNoSymlinks throws mid-copy.
		if (!trySymlink(path.join(dir, "pack.yaml"), path.join(toolDir, "z-link.yaml"))) {
			t.skip("platform forbids symlink creation");
			return;
		}

		const dest = path.join(h.systemConfigDir, "tools", "mytool");
		assert.throws(
			() => h.service.install({ scope: "system", projectId: null, source: src, pack: scanned, entities: null, conflict: "fail" }),
			/symlink/i,
		);
		assert.ok(!fs.existsSync(dest), "partially-written tool dest cleaned up after failure");
		assert.equal(h.systemProvenance().find(src.id, "tp"), undefined, "no provenance recorded for failed install");
	});
});

// ── Fix 3: scope validation ─────────────────────────────────────────────────

describe("marketplace fix: parseInstallScope rejects invalid scope", () => {
	it("defaults a missing/empty scope to system", () => {
		assert.deepEqual(parseInstallScope(undefined, undefined), { scope: "system", projectId: null });
		assert.deepEqual(parseInstallScope("", null), { scope: "system", projectId: null });
	});

	it("rejects a misspelled scope", () => {
		const r = parseInstallScope("systom", null);
		assert.ok("error" in r && /scope must be/i.test(r.error));
	});

	it("rejects project scope without a projectId", () => {
		const r = parseInstallScope("project", null);
		assert.ok("error" in r && /requires projectId/i.test(r.error));
		const r2 = parseInstallScope("project", "  ");
		assert.ok("error" in r2 && /requires projectId/i.test(r2.error));
	});

	it("accepts a well-formed project scope and ignores projectId for system", () => {
		assert.deepEqual(parseInstallScope("project", "p1"), { scope: "project", projectId: "p1" });
		assert.deepEqual(parseInstallScope("system", "p1"), { scope: "system", projectId: null });
	});
});

// ── Fix 4: duplicate pack ids within one source ──────────────────────────────

describe("marketplace fix: scanSource rejects duplicate pack ids", () => {
	it("marks every pack in a colliding id group invalid", () => {
		const root = tmpDir("bobbit-market-src-");
		for (const subdir of ["alpha", "beta"]) {
			const dir = path.join(root, subdir);
			fs.mkdirSync(path.join(dir, "roles"), { recursive: true });
			fs.writeFileSync(
				path.join(dir, "pack.yaml"),
				`apiVersion: 1\nid: dup\nname: ${subdir}\ndescription: test\nversion: 1.0.0\ncontents:\n  roles:\n    - r\n`,
			);
			fs.writeFileSync(path.join(dir, "roles", "r.yaml"), "name: r\nprompt: hi\n");
		}
		// A non-colliding pack stays valid.
		const okDir = path.join(root, "gamma");
		fs.mkdirSync(path.join(okDir, "roles"), { recursive: true });
		fs.writeFileSync(
			path.join(okDir, "pack.yaml"),
			"apiVersion: 1\nid: solo\nname: gamma\ndescription: test\nversion: 1.0.0\ncontents:\n  roles:\n    - r\n",
		);
		fs.writeFileSync(path.join(okDir, "roles", "r.yaml"), "name: r\nprompt: hi\n");

		const packs = scanSource("src-x", root);
		const dups = packs.filter((p) => p.packId === "dup");
		assert.equal(dups.length, 2);
		for (const p of dups) {
			assert.equal(p.valid, false);
			assert.match(p.error ?? "", /duplicate pack id/i);
		}
		assert.equal(packs.find((p) => p.packId === "solo")!.valid, true);
	});
});

// ── Fix 5: default git label derived from the redacted url ───────────────────

describe("marketplace fix: default git label is derived from the redacted url", () => {
	it("does not leak a userinfo token into the default label", () => {
		const reg = new SourceRegistry(tmpDir("bobbit-market-state-"));
		const rec = reg.add({ kind: "git", url: "https://user:ghp_secret@github.com/acme/my-packs.git" });
		assert.equal(rec.label, "my-packs");
		assert.ok(!rec.label!.includes("ghp_secret"));
	});

	it("does not leak a query-string token into the default label", () => {
		const reg = new SourceRegistry(tmpDir("bobbit-market-state-"));
		const rec = reg.add({ kind: "git", url: "https://github.com/acme/my-packs.git?token=ghp_secret" });
		assert.equal(rec.label, "my-packs");
		assert.ok(!rec.label!.includes("ghp_secret"));
	});
});
