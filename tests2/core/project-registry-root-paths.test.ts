import { afterEach, test, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ProjectRegistry, type RegisteredProject } from "../../src/server/agent/project-registry.js";

const stateDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const stateDir of stateDirs.splice(0)) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

function registryWithRoot(id: string, rootPath: string): ProjectRegistry {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-registry-root-paths-"));
  stateDirs.push(stateDir);
  const project: RegisteredProject = {
    id,
    name: id,
    rootPath,
    createdAt: 1,
    colorLight: "#fff",
    colorDark: "#000",
  };
  fs.writeFileSync(path.join(stateDir, "projects.json"), JSON.stringify([project]));
  return new ProjectRegistry(stateDir);
}

test("ProjectRegistry.findByCwd matches POSIX, drive, and UNC filesystem roots on every host", () => {
  // Force the lexical fallback so these path dialects are exercised without
  // depending on a host drive, UNC share, or filesystem layout.
  vi.spyOn(fs, "realpathSync").mockImplementation(() => {
    throw new Error("fixture paths do not exist on this host");
  });

  const posix = registryWithRoot("posix-root", "/");
  assert.equal(posix.findByCwd("/")?.id, "posix-root");
  assert.equal(posix.findByCwd("/workspace/project")?.id, "posix-root");

  const drive = registryWithRoot("drive-root", "C:\\");
  assert.equal(drive.findByCwd("c:/")?.id, "drive-root");
  assert.equal(drive.findByCwd("c:/workspace/project")?.id, "drive-root");

  const unc = registryWithRoot("unc-root", "\\\\server\\share\\");
  assert.equal(unc.findByCwd("//SERVER/SHARE/")?.id, "unc-root");
  assert.equal(unc.findByCwd("//server/share/workspace/project")?.id, "unc-root");
});
