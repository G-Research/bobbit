import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ProjectRegistry, SymlinkProjectRootError } from "../src/server/agent/project-registry.js";

/** Make a fresh isolated state dir for each test. */
function makeStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-symlink-state-"));
}

/** Make `target` (a real directory) and `link` (a symlink to it). Returns
 *  null if creating the symlink is not permitted (e.g. Windows non-admin). */
function setupSymlinkPair(): { target: string; link: string; cleanup: () => void } | null {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-symlink-"));
  const target = path.join(tmp, "canonical");
  const link = path.join(tmp, "via-symlink");
  fs.mkdirSync(target, { recursive: true });
  // Create a sub-folder under canonical so findByCwd has something to descend into.
  fs.mkdirSync(path.join(target, "sub"), { recursive: true });
  try {
    fs.symlinkSync(target, link, "dir");
  } catch {
    fs.rmSync(tmp, { recursive: true, force: true });
    return null;
  }
  return {
    target: fs.realpathSync(target),
    link,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

test("register-symlink-throws: registering with a symlink path throws SymlinkProjectRootError", (t) => {
  const pair = setupSymlinkPair();
  if (!pair) { t.skip("symlink creation not permitted (likely Windows non-admin)"); return; }
  try {
    const reg = new ProjectRegistry(makeStateDir());
    let caught: unknown;
    try {
      reg.register("p", pair.link);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof SymlinkProjectRootError, "expected SymlinkProjectRootError");
    const e = caught as SymlinkProjectRootError;
    assert.equal(e.code, "symlink_root");
    assert.equal(path.resolve(e.canonical), path.resolve(pair.target));
  } finally {
    pair.cleanup();
  }
});

test("register-symlink-accept-canonical: acceptCanonical=true stores canonical path", (t) => {
  const pair = setupSymlinkPair();
  if (!pair) { t.skip("symlink creation not permitted"); return; }
  try {
    const reg = new ProjectRegistry(makeStateDir());
    const proj = reg.register("p", pair.link, { acceptCanonical: true });
    assert.equal(path.resolve(proj.rootPath), path.resolve(pair.target));
  } finally {
    pair.cleanup();
  }
});

test("findByCwd-via-symlink: cwd reached through symlink resolves to canonically-registered project", (t) => {
  const pair = setupSymlinkPair();
  if (!pair) { t.skip("symlink creation not permitted"); return; }
  try {
    const reg = new ProjectRegistry(makeStateDir());
    const proj = reg.register("p", pair.target);
    const cwdViaSymlink = path.join(pair.link, "sub");
    const found = reg.findByCwd(cwdViaSymlink);
    assert.ok(found, "expected findByCwd to resolve through the symlink");
    assert.equal(found!.id, proj.id);
  } finally {
    pair.cleanup();
  }
});

test("findByCwd-canonical-still-works: no regression for canonical-path lookups", (t) => {
  const pair = setupSymlinkPair();
  if (!pair) { t.skip("symlink creation not permitted"); return; }
  try {
    const reg = new ProjectRegistry(makeStateDir());
    const proj = reg.register("p", pair.target);
    const found = reg.findByCwd(path.join(pair.target, "sub"));
    assert.ok(found);
    assert.equal(found!.id, proj.id);
  } finally {
    pair.cleanup();
  }
});
