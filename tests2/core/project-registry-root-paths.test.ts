import { afterEach, test, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createProjectPathIdentity,
  ProjectRegistry,
  type ProjectPathIdentity,
  type RegisteredProject,
} from "../../src/server/agent/project-registry.js";

const fixtureDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const fixtureDir of fixtureDirs.splice(0)) {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

function registryWithRoot(id: string, rootPath: string, pathIdentity?: ProjectPathIdentity): ProjectRegistry {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-registry-root-paths-"));
  fixtureDirs.push(stateDir);
  const project: RegisteredProject = {
    id,
    name: id,
    rootPath,
    createdAt: 1,
    colorLight: "#fff",
    colorDark: "#000",
  };
  fs.writeFileSync(path.join(stateDir, "projects.json"), JSON.stringify([project]));
  return new ProjectRegistry(stateDir, { pathIdentity });
}

test("ProjectRegistry.findByCwd matches POSIX, drive, and UNC filesystem roots on every host", () => {
  // Force the lexical fallback so these path dialects are exercised without
  // depending on a host drive, UNC share, or filesystem layout.
  vi.spyOn(fs, "realpathSync").mockImplementation(() => {
    throw new Error("fixture paths do not exist on this host");
  });

  const posix = registryWithRoot("posix-root", "/workspace/project");
  assert.equal(posix.findByCwd("/workspace/project")?.id, "posix-root");
  assert.equal(
    posix.findByCwd("//workspace/project/src")?.id,
    process.platform === "win32" ? undefined : "posix-root",
    "POSIX double slashes are native aliases, while Windows treats them as UNC",
  );

  // Force these synthetic Windows spellings to remain foreign even on a
  // Windows runner. Their mocked roots do not provide filesystem case proof.
  const foreignWindowsIdentity = createProjectPathIdentity({ isNativePathApi: () => false });
  const drive = registryWithRoot("drive-root", "C:\\Workspace\\Project", foreignWindowsIdentity);
  assert.equal(drive.findByCwd("c:/workspace/project")?.id, "drive-root");
  assert.equal(drive.findByCwd("c:/workspace/project/src")?.id, "drive-root");
  assert.equal(drive.getByPath("c:/workspace/project")?.id, "drive-root");

  // Backslash UNC is an explicit, host-independent Windows path spelling.
  // On POSIX, //server/share is native POSIX syntax instead of a UNC alias.
  const unc = registryWithRoot("unc-root", "\\\\server\\share\\Workspace", foreignWindowsIdentity);
  assert.equal(unc.findByCwd("\\\\SERVER\\SHARE\\workspace")?.id, "unc-root");
  assert.equal(unc.findByCwd("\\\\server\\share\\workspace\\project")?.id, "unc-root");
  assert.equal(unc.getByPath("\\\\SERVER\\SHARE\\workspace")?.id, "unc-root");
});

test("ProjectRegistry rejects native POSIX double-slash aliases for Headquarters and existing projects", () => {
  const serverRoot = fs.mkdtempSync(path.join(os.tmpdir(), "project-registry-double-slash-"));
  fixtureDirs.push(serverRoot);
  const stateDir = path.join(serverRoot, "state");
  const headquartersRoot = path.join(serverRoot, ".bobbit", "headquarters");
  const normalRoot = path.join(serverRoot, "normal-project");
  fs.mkdirSync(headquartersRoot, { recursive: true });
  fs.mkdirSync(normalRoot, { recursive: true });

  const registry = new ProjectRegistry(stateDir);
  registry.ensureHeadquartersProject(headquartersRoot, { stateDir });
  const nativeAlias = process.platform === "win32" ? headquartersRoot : `/${headquartersRoot}`;
  if (process.platform !== "win32") {
    assert.notEqual(nativeAlias, headquartersRoot, "fixture must exercise the POSIX // spelling");
  }

  assert.throws(
    () => registry.register("Headquarters bypass", nativeAlias, { acceptCanonical: true }),
    /Headquarters|immutable/i,
  );
  assert.throws(
    () => registry.registerProvisional("Headquarters bypass", nativeAlias),
    /Headquarters|immutable/i,
  );

  const normal = registry.register("normal", normalRoot, { acceptCanonical: true });
  const normalAlias = process.platform === "win32" ? normalRoot : `/${normalRoot}`;
  assert.equal(registry.getByPath(normalAlias)?.id, normal.id, "canonical identity covers upsert lookup");
  assert.throws(
    () => registry.register("duplicate bypass", normalAlias, { acceptCanonical: true }),
    /already registered/i,
  );
  assert.equal(registry.registerProvisional("duplicate bypass", normalAlias).id, normal.id);
});
