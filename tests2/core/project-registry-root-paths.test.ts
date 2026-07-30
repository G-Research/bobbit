import { afterEach, test, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  canonicalProjectPath,
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

test("ProjectRegistry identifies case aliases when realpath preserves caller casing", () => {
  // Models APFS behaviour: every case spelling resolves, but realpath returns
  // exactly the spelling it was given. The readdir seam exposes each parent
  // entry, proving which individual components are insensitive without
  // treating a sensitive descendant as insensitive too.
  const prefix = "/case-preserving-apfs";
  const root = `${prefix}/Projects/Bobbit`;
  const alias = `${prefix.toUpperCase()}/projects/bObBiT`;
  const readdirSync = (candidate: string): string[] => {
    const normalized = path.posix.resolve(candidate).toLowerCase();
    if (normalized === "/") return ["case-preserving-apfs"];
    if (normalized.endsWith("/case-preserving-apfs")) return ["Projects"];
    if (normalized.endsWith("/projects")) return ["Bobbit"];
    if (normalized.endsWith("/bobbit")) return ["src"];
    throw new Error(`missing fixture directory: ${candidate}`);
  };
  const identity = createProjectPathIdentity({
    isNativePathApi: dialect => dialect === "posix",
    realpathSync: candidate => {
      const resolved = path.posix.resolve(candidate);
      if (resolved.toLowerCase().startsWith(prefix)) return resolved;
      throw new Error(`missing fixture path: ${candidate}`);
    },
    readdirSync,
  });
  const registry = registryWithRoot("case-preserving", root, identity);

  assert.equal(canonicalProjectPath(root, {
    isNativePathApi: dialect => dialect === "posix",
    realpathSync: candidate => path.posix.resolve(candidate),
    readdirSync,
  }), "/case-preserving-apfs/projects/bobbit");
  assert.equal(registry.getByPath(alias)?.id, "case-preserving");
  assert.equal(registry.findByCwd(`${alias}/SRC`)?.id, "case-preserving");
  assert.equal(registry.registerProvisional("case alias", alias).id, "case-preserving");
});

test("ProjectRegistry preserves case-distinct paths when the native volume is sensitive", () => {
  const root = "/case-sensitive-volume/Projects/Bobbit";
  const alias = "/case-sensitive-volume/Projects/bobbit";
  const identity = createProjectPathIdentity({
    isNativePathApi: dialect => dialect === "posix",
    realpathSync: candidate => {
      if (path.posix.resolve(candidate) === root) return root;
      throw new Error(`missing fixture path: ${candidate}`);
    },
    isCaseInsensitiveAt: () => false,
  });
  const registry = registryWithRoot("case-sensitive", root, identity);

  assert.equal(registry.getByPath(alias), undefined);
  assert.equal(registry.registerProvisional("case-distinct", alias).provisional, true);
});

test("ProjectRegistry identifies native case aliases when the temp volume is insensitive", () => {
  if (process.platform !== "darwin") return;

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "project-registry-native-case-"));
  fixtureDirs.push(fixtureRoot);
  const root = path.join(fixtureRoot, "ProjectIdentity");
  const alias = path.join(fixtureRoot, "projectidentity");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });

  // Case-sensitive APFS volumes are valid macOS configurations. Only assert
  // the alias contract when this particular native fixture proves insensitive.
  try {
    fs.realpathSync(alias);
  } catch {
    return;
  }

  const registry = registryWithRoot("native-case", root);
  assert.equal(registry.getByPath(alias)?.id, "native-case");
  assert.equal(registry.findByCwd(path.join(alias, "src"))?.id, "native-case");
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
