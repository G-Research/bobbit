import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { makeTmpDir } from "./helpers/tmp.ts";
import {
  HEADQUARTERS_PROJECT_ID,
  ProjectRegistry,
  SpecialProjectMutationError,
  SYSTEM_PROJECT_ID,
} from "../src/server/agent/project-registry.js";

function readStoredProjects(stateDir: string): Array<{ id: string; rootPath: string; provisional?: boolean; hidden?: boolean }> {
  return JSON.parse(fs.readFileSync(path.join(stateDir, "projects.json"), "utf-8"));
}

test("ProjectRegistry.registerProvisional reuses an existing normal project at the same canonical root", () => {
  const stateDir = makeTmpDir("bobbit-provisional-dedupe-state-");
  const root = makeTmpDir("bobbit-provisional-dedupe-root-");
  try {
    const registry = new ProjectRegistry(stateDir);
    const normal = registry.register("normal", root);

    const reused = registry.registerProvisional("assistant", root);

    assert.equal(reused.id, normal.id);
    assert.equal(reused.provisional, undefined);
    assert.deepEqual(registry.list().map(project => project.id), [normal.id]);
    assert.equal(readStoredProjects(stateDir).length, 1);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ProjectRegistry.registerProvisional reuses an existing provisional project at the same canonical root", () => {
  const stateDir = makeTmpDir("bobbit-provisional-reuse-state-");
  const root = makeTmpDir("bobbit-provisional-reuse-root-");
  try {
    const registry = new ProjectRegistry(stateDir);
    const first = registry.registerProvisional("first", root);

    const second = registry.registerProvisional("second", root);

    assert.equal(second.id, first.id);
    assert.equal(second.provisional, true);
    assert.equal(registry.list().length, 1);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ProjectRegistry.registerProvisional reuses the normal server-run-dir project beside Headquarters", () => {
  const serverRoot = makeTmpDir("bobbit-provisional-same-root-server-");
  const headquartersRoot = path.join(serverRoot, ".bobbit", "headquarters");
  const stateDir = path.join(headquartersRoot, "state");
  const configDir = path.join(headquartersRoot, "config");
  try {
    fs.mkdirSync(configDir, { recursive: true });
    const registry = new ProjectRegistry(stateDir);
    const headquarters = registry.ensureHeadquartersProject(headquartersRoot, { stateDir, configDir });
    const normal = registry.register("server-root-normal", serverRoot, { acceptCanonical: true });

    const reused = registry.registerProvisional("project assistant", serverRoot);

    assert.equal(headquarters.id, HEADQUARTERS_PROJECT_ID);
    assert.equal(reused.id, normal.id);
    assert.equal(reused.provisional, undefined);
    assert.deepEqual(
      registry.list().filter(project => !project.hidden).map(project => project.id),
      [HEADQUARTERS_PROJECT_ID, normal.id],
    );
    assert.equal(readStoredProjects(stateDir).filter(project => path.resolve(project.rootPath) === path.resolve(serverRoot)).length, 1);
  } finally {
    fs.rmSync(serverRoot, { recursive: true, force: true });
  }
});

test("ProjectRegistry.registerProvisional keeps Headquarters immutable and hidden system anchors non-blocking", () => {
  const serverRoot = makeTmpDir("bobbit-provisional-special-server-");
  const stateDir = makeTmpDir("bobbit-provisional-special-state-");
  const headquartersRoot = path.join(serverRoot, ".bobbit", "headquarters");
  const systemRoot = path.join(serverRoot, "system-anchor");
  try {
    fs.mkdirSync(headquartersRoot, { recursive: true });
    fs.mkdirSync(systemRoot, { recursive: true });
    const registry = new ProjectRegistry(stateDir);
    registry.ensureHeadquartersProject(headquartersRoot, { stateDir, configDir: path.join(headquartersRoot, "config") });
    registry.registerSystemProject(systemRoot);

    assert.throws(
      () => registry.registerProvisional("bad", headquartersRoot),
      (err: unknown) => err instanceof SpecialProjectMutationError && err.code === "HEADQUARTERS_IMMUTABLE",
    );

    const provisional = registry.registerProvisional("system-adjacent", systemRoot);
    assert.notEqual(provisional.id, SYSTEM_PROJECT_ID);
    assert.equal(provisional.provisional, true);
    assert.equal(registry.get(SYSTEM_PROJECT_ID)?.hidden, true);
  } finally {
    fs.rmSync(serverRoot, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
