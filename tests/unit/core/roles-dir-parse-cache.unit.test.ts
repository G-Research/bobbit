/**
 * Pinning tests for the role-directory parse cache.
 *
 * `parseRolesDir` sits on the streaming hot path (every Pi event resolves the
 * session author's role through the config cascade → `RoleLoader.load`). It
 * must NOT re-read + YAML-parse every role file per call, but it must still
 * observe on-disk edits without an explicit invalidation.
 *
 * Caching is proven without spying on `fs` (ESM namespace exports are not
 * spy-able here): the returned array identity is stable across calls until the
 * directory content changes or the central invalidator runs.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { invalidateRolesDirParseCache, parseRolesDir } from "../../../src/server/agent/builtin-config.ts";

let tmpRoot: string;
let rolesDir: string;

function writeRole(name: string, label = name): void {
	fs.writeFileSync(path.join(rolesDir, `${name}.yaml`), `name: ${name}\nlabel: ${label}\npromptTemplate: hi\n`, "utf-8");
}

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roles-dir-cache-"));
	rolesDir = path.join(tmpRoot, "roles");
	fs.mkdirSync(rolesDir, { recursive: true });
	invalidateRolesDirParseCache();
});

afterEach(() => {
	invalidateRolesDirParseCache();
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("repeat calls on an unchanged directory return the same parsed array", () => {
	writeRole("coder", "Coder");
	const first = parseRolesDir(rolesDir);
	expect(first.map(r => r.name)).toEqual(["coder"]);
	for (let i = 0; i < 50; i++) expect(parseRolesDir(rolesDir)).toBe(first);
});

test("an edited role file is observed on the next call without explicit invalidation", () => {
	writeRole("coder", "Coder");
	const first = parseRolesDir(rolesDir);
	expect(first[0]?.label).toBe("Coder");
	writeRole("coder", "Coder v2");
	const second = parseRolesDir(rolesDir);
	expect(second).not.toBe(first);
	expect(second[0]?.label).toBe("Coder v2");
});

test("added and removed role files change the result", () => {
	writeRole("coder");
	expect(parseRolesDir(rolesDir).map(r => r.name)).toEqual(["coder"]);
	writeRole("reviewer");
	expect(parseRolesDir(rolesDir).map(r => r.name).sort()).toEqual(["coder", "reviewer"]);
	fs.rmSync(path.join(rolesDir, "coder.yaml"));
	expect(parseRolesDir(rolesDir).map(r => r.name)).toEqual(["reviewer"]);
});

test("invalidateRolesDirParseCache forces a fresh parse", () => {
	writeRole("coder");
	const first = parseRolesDir(rolesDir);
	invalidateRolesDirParseCache();
	const second = parseRolesDir(rolesDir);
	expect(second).not.toBe(first);
	expect(second).toEqual(first);
});

test("a missing directory returns an empty array and is not cached", () => {
	const missing = path.join(tmpRoot, "nope");
	expect(parseRolesDir(missing)).toEqual([]);
	fs.mkdirSync(missing);
	fs.writeFileSync(path.join(missing, "late.yaml"), "name: late\n", "utf-8");
	expect(parseRolesDir(missing).map(r => r.name)).toEqual(["late"]);
});
