import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ProjectOrderError,
  ProjectRegistry,
  SYSTEM_PROJECT_ID,
  type RegisteredProject,
} from "../src/server/agent/project-registry.js";

function makeStateDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-project-order-state-")));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function project(id: string, overrides: Partial<RegisteredProject> = {}): RegisteredProject {
  return {
    id,
    name: id,
    rootPath: path.join(os.tmpdir(), `bobbit-project-order-${id}`),
    createdAt: 1_000,
    colorLight: "#fff",
    colorDark: "#000",
    ...overrides,
  };
}

function writeProjects(stateDir: string, projects: RegisteredProject[]): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "projects.json"), JSON.stringify(projects, null, 2), "utf-8");
}

function readProjects(stateDir: string): RegisteredProject[] {
  return JSON.parse(fs.readFileSync(path.join(stateDir, "projects.json"), "utf-8"));
}

function ids(projects: RegisteredProject[]): string[] {
  return projects.map(p => p.id);
}

test("ProjectRegistry order migration assigns visible positions by createdAt and on-disk tie-break", () => {
  const stateDir = makeStateDir();
  try {
    writeProjects(stateDir, [
      project("late", { createdAt: 300 }),
      project("tie-first", { createdAt: 100 }),
      project("early", { createdAt: 50 }),
      project("tie-second", { createdAt: 100 }),
      project("hidden", { createdAt: 1, hidden: true, position: 99 }),
    ]);

    const registry = new ProjectRegistry(stateDir);
    assert.deepEqual(ids(registry.list().filter(p => !p.hidden)), ["early", "tie-first", "tie-second", "late"]);

    const stored = readProjects(stateDir);
    const visible = stored.filter(p => !p.hidden);
    assert.deepEqual(ids(visible), ["early", "tie-first", "tie-second", "late"]);
    assert.deepEqual(visible.map(p => p.position), [0, 1, 2, 3]);
    assert.equal(stored.find(p => p.id === "hidden")?.position, undefined);
  } finally {
    cleanup(stateDir);
  }
});

test("ProjectRegistry.list respects custom positions over createdAt", () => {
  const stateDir = makeStateDir();
  try {
    writeProjects(stateDir, [
      project("oldest", { createdAt: 1, position: 2 }),
      project("newest", { createdAt: 3, position: 0 }),
      project("middle", { createdAt: 2, position: 1 }),
    ]);

    const registry = new ProjectRegistry(stateDir);
    assert.deepEqual(ids(registry.list()), ["newest", "middle", "oldest"]);
  } finally {
    cleanup(stateDir);
  }
});

test("ProjectRegistry.setVisibleOrder persists contiguous positions and reloads in saved order", () => {
  const stateDir = makeStateDir();
  try {
    writeProjects(stateDir, [
      project("a", { createdAt: 1, position: 0 }),
      project("b", { createdAt: 2, position: 1 }),
      project("c", { createdAt: 3, position: 2 }),
    ]);

    const registry = new ProjectRegistry(stateDir);
    const saved = registry.setVisibleOrder(["c", "a", "b"]);
    assert.deepEqual(ids(saved), ["c", "a", "b"]);

    const stored = readProjects(stateDir);
    assert.deepEqual(ids(stored), ["c", "a", "b"]);
    assert.deepEqual(stored.map(p => p.position), [0, 1, 2]);

    const reloaded = new ProjectRegistry(stateDir);
    assert.deepEqual(ids(reloaded.list()), ["c", "a", "b"]);
  } finally {
    cleanup(stateDir);
  }
});

test("ProjectRegistry register and registerProvisional append after a custom order", () => {
  const stateDir = makeStateDir();
  const roots: string[] = [];
  const makeRoot = (name: string) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `bobbit-project-order-${name}-`)));
    roots.push(root);
    return root;
  };
  try {
    writeProjects(stateDir, [
      project("first", { rootPath: makeRoot("first"), createdAt: 1, position: 1 }),
      project("second", { rootPath: makeRoot("second"), createdAt: 2, position: 0 }),
    ]);

    const registry = new ProjectRegistry(stateDir);
    const third = registry.register("third", makeRoot("third"));
    const fourth = registry.registerProvisional("fourth", makeRoot("fourth"));

    assert.equal(third.position, 2);
    assert.equal(fourth.position, 3);
    assert.deepEqual(ids(registry.list()), ["second", "first", third.id, fourth.id]);
  } finally {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    cleanup(stateDir);
  }
});

test("ProjectRegistry remove and removeProvisional preserve relative order and compact positions", () => {
  const stateDir = makeStateDir();
  try {
    writeProjects(stateDir, [
      project("a", { createdAt: 1, position: 0 }),
      project("b", { createdAt: 2, position: 1 }),
      project("c", { createdAt: 3, position: 2, provisional: true }),
      project("d", { createdAt: 4, position: 3 }),
    ]);

    const registry = new ProjectRegistry(stateDir);
    registry.remove("b");
    assert.deepEqual(ids(registry.list()), ["a", "c", "d"]);
    assert.deepEqual(registry.list().map(p => p.position), [0, 1, 2]);

    registry.removeProvisional("c");
    assert.deepEqual(ids(registry.list()), ["a", "d"]);
    assert.deepEqual(registry.list().map(p => p.position), [0, 1]);
  } finally {
    cleanup(stateDir);
  }
});

test("ProjectRegistry setVisibleOrder excludes hidden and system projects from validation", () => {
  const stateDir = makeStateDir();
  try {
    writeProjects(stateDir, [
      project("a", { createdAt: 1, position: 0 }),
      project("b", { createdAt: 2, position: 1 }),
      project("hidden", { createdAt: 3, hidden: true }),
      project(SYSTEM_PROJECT_ID, { name: "System", createdAt: 4, hidden: true }),
    ]);

    const registry = new ProjectRegistry(stateDir);
    assert.deepEqual(ids(registry.setVisibleOrder(["b", "a"])), ["b", "a"]);
    assert.equal(registry.get("hidden")?.position, undefined);
    assert.equal(registry.get(SYSTEM_PROJECT_ID)?.position, undefined);

    assert.throws(
      () => registry.setVisibleOrder(["b", "a", "hidden"]),
      (err: unknown) => err instanceof ProjectOrderError && err.code === "invalid_project_order",
    );
    assert.throws(
      () => registry.setVisibleOrder(["b", "a", SYSTEM_PROJECT_ID]),
      (err: unknown) => err instanceof ProjectOrderError && err.code === "invalid_project_order",
    );
    assert.deepEqual(ids(registry.list().filter(p => !p.hidden)), ["b", "a"]);
  } finally {
    cleanup(stateDir);
  }
});

test("ProjectRegistry setVisibleOrder reports stale complete-order mismatches without mutation", () => {
  const stateDir = makeStateDir();
  try {
    writeProjects(stateDir, [
      project("a", { createdAt: 1, position: 0 }),
      project("b", { createdAt: 2, position: 1 }),
      project("c", { createdAt: 3, position: 2 }),
    ]);

    const registry = new ProjectRegistry(stateDir);
    assert.throws(
      () => registry.setVisibleOrder(["a", "b"]),
      (err: unknown) => err instanceof ProjectOrderError
        && err.code === "stale_project_order"
        && JSON.stringify(err.details.expectedProjectIds) === JSON.stringify(["a", "b", "c"])
        && JSON.stringify(err.details.receivedProjectIds) === JSON.stringify(["a", "b"]),
    );
    assert.deepEqual(ids(registry.list()), ["a", "b", "c"]);
    assert.deepEqual(registry.list().map(p => p.position), [0, 1, 2]);
  } finally {
    cleanup(stateDir);
  }
});
