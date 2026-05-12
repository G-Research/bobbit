/**
 * Tests for hierarchical project parent linkage:
 *   - getAncestors walk
 *   - cycle guard on update()
 *   - self-reference rejection
 *   - rejection when target is missing / hidden / provisional
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ProjectRegistry } from "../src/server/agent/project-registry.js";

function makeStateDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-parent-state-"));
}

function makeProjectRoot(name: string): string {
	// Use realpath so the path matches its canonical form on macOS (/var → /private/var).
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `bobbit-parent-root-${name}-`)));
}

test("getAncestors walks parent chain in closest-first order", () => {
	const reg = new ProjectRegistry(makeStateDir());
	const a = reg.register("a", makeProjectRoot("a"));
	const b = reg.register("b", makeProjectRoot("b"));
	const c = reg.register("c", makeProjectRoot("c"));

	reg.update(b.id, { parentProjectId: a.id });
	reg.update(c.id, { parentProjectId: b.id });

	const ancestors = reg.getAncestors(c.id);
	assert.deepEqual(ancestors.map(p => p.id), [b.id, a.id]);

	// Root has no ancestors.
	assert.deepEqual(reg.getAncestors(a.id), []);
});

test("getAncestors returns empty for unknown project id", () => {
	const reg = new ProjectRegistry(makeStateDir());
	assert.deepEqual(reg.getAncestors("does-not-exist"), []);
});

test("update rejects self-reference", () => {
	const reg = new ProjectRegistry(makeStateDir());
	const a = reg.register("a", makeProjectRoot("self"));
	assert.throws(() => reg.update(a.id, { parentProjectId: a.id }), /self/i);
});

test("update rejects cycle creation (A→B, then B→A)", () => {
	const reg = new ProjectRegistry(makeStateDir());
	const a = reg.register("a", makeProjectRoot("cyca"));
	const b = reg.register("b", makeProjectRoot("cycb"));
	reg.update(a.id, { parentProjectId: b.id });
	assert.throws(() => reg.update(b.id, { parentProjectId: a.id }), /cycle/i);
});

test("update rejects parentProjectId pointing at missing project", () => {
	const reg = new ProjectRegistry(makeStateDir());
	const a = reg.register("a", makeProjectRoot("misA"));
	assert.throws(() => reg.update(a.id, { parentProjectId: "ghost" }), /unknown/i);
});

test("update rejects parentProjectId pointing at a hidden project", () => {
	const stateDir = makeStateDir();
	const reg = new ProjectRegistry(stateDir);
	const system = reg.registerSystemProject(makeProjectRoot("sys"));
	const a = reg.register("a", makeProjectRoot("hideA"));
	assert.throws(() => reg.update(a.id, { parentProjectId: system.id }), /hidden/i);
});

test("update rejects parentProjectId pointing at a provisional project", () => {
	const reg = new ProjectRegistry(makeStateDir());
	const prov = reg.registerProvisional("prov", makeProjectRoot("prov"));
	const a = reg.register("a", makeProjectRoot("provA"));
	assert.throws(() => reg.update(a.id, { parentProjectId: prov.id }), /provisional/i);
});

test("update accepts null or '' to clear parentProjectId", () => {
	const reg = new ProjectRegistry(makeStateDir());
	const a = reg.register("a", makeProjectRoot("clrA"));
	const b = reg.register("b", makeProjectRoot("clrB"));
	reg.update(b.id, { parentProjectId: a.id });
	assert.equal(reg.get(b.id)?.parentProjectId, a.id);

	reg.update(b.id, { parentProjectId: null });
	assert.equal(reg.get(b.id)?.parentProjectId, undefined);

	reg.update(b.id, { parentProjectId: a.id });
	reg.update(b.id, { parentProjectId: "" });
	assert.equal(reg.get(b.id)?.parentProjectId, undefined);
});

test("parentProjectId survives save / load cycle", () => {
	const stateDir = makeStateDir();
	const reg = new ProjectRegistry(stateDir);
	const a = reg.register("a", makeProjectRoot("psA"));
	const b = reg.register("b", makeProjectRoot("psB"));
	reg.update(b.id, { parentProjectId: a.id });

	const reg2 = new ProjectRegistry(stateDir);
	assert.equal(reg2.get(b.id)?.parentProjectId, a.id);
});
