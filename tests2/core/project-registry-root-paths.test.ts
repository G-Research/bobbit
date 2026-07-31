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
  for (const fixtureDir of fixtureDirs.splice(0)) fs.rmSync(fixtureDir, { recursive: true, force: true });
});

function registryWithRoot(id: string, rootPath: string, pathIdentity?: ProjectPathIdentity): ProjectRegistry {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-registry-root-paths-"));
  fixtureDirs.push(stateDir);
  const project: RegisteredProject = { id, name: id, rootPath, createdAt: 1, colorLight: "#fff", colorDark: "#000" };
  fs.writeFileSync(path.join(stateDir, "projects.json"), JSON.stringify([project]));
  return new ProjectRegistry(stateDir, { pathIdentity });
}

function missing(candidate: string): Error {
  return Object.assign(new Error(`missing fixture path: ${candidate}`), { code: "ENOENT" });
}

test("ProjectRegistry.findByCwd matches POSIX, drive, and UNC roots on every host", () => {
  vi.spyOn(fs, "realpathSync").mockImplementation(() => { throw new Error("fixture paths do not exist on this host"); });

  const posix = registryWithRoot("posix-root", "/workspace/project");
  assert.equal(posix.findByCwd("/workspace/project")?.id, "posix-root");
  assert.equal(posix.findByCwd("//workspace/project/src")?.id, process.platform === "win32" ? undefined : "posix-root");

  const foreignWindowsIdentity = createProjectPathIdentity({ isNativePathApi: () => false });
  const drive = registryWithRoot("drive-root", "C:\\Workspace\\Project", foreignWindowsIdentity);
  assert.equal(drive.findByCwd("c:/workspace/project/src")?.id, "drive-root");
  assert.equal(drive.getByPath("c:/workspace/project")?.id, "drive-root");

  const unc = registryWithRoot("unc-root", "\\\\server\\share\\Workspace", foreignWindowsIdentity);
  assert.equal(unc.findByCwd("\\\\server\\share\\workspace\\project")?.id, "unc-root");
  assert.equal(unc.getByPath("\\\\SERVER\\SHARE\\workspace")?.id, "unc-root");
});

test("ProjectRegistry identifies APFS-style aliases when realpath preserves caller casing", () => {
  const prefix = "/case-preserving-apfs";
  const root = `${prefix}/Projects/Bobbit`;
  const alias = `${prefix.toUpperCase()}/projects/bObBiT`;
  const identity = createProjectPathIdentity({
    isNativePathApi: dialect => dialect === "posix",
    realpathSync: candidate => {
      const resolved = path.posix.resolve(candidate);
      if (resolved.toLowerCase().startsWith(prefix)) return resolved;
      throw missing(candidate);
    },
    lstatSync: candidate => ({ dev: 1, ino: path.posix.resolve(candidate).toLowerCase().length }),
    createCaseProbe: parent => path.posix.join(parent, ".BobbitProbe"),
    removeCaseProbe: () => {},
    caseSemanticsFingerprint: parent => `stable:${parent.toLowerCase()}`,
  });
  const registry = registryWithRoot("case-preserving", root, identity);

  assert.equal(canonicalProjectPath(root, {
    isNativePathApi: dialect => dialect === "posix",
    realpathSync: candidate => path.posix.resolve(candidate),
    lstatSync: candidate => ({ dev: 1, ino: path.posix.resolve(candidate).toLowerCase().length }),
    createCaseProbe: parent => path.posix.join(parent, ".BobbitProbe"),
    removeCaseProbe: () => {},
  }), "/case-preserving-apfs/projects/bobbit");
  assert.equal(registry.getByPath(alias)?.id, "case-preserving");
  assert.equal(registry.findByCwd(`${alias}/SRC`)?.id, "case-preserving");
  assert.equal(registry.registerProvisional("case alias", alias).id, "case-preserving");
});

test("ProjectRegistry preserves case-distinct paths on a sensitive volume", () => {
  const root = "/case-sensitive-volume/Projects/Bobbit";
  const alias = "/case-sensitive-volume/Projects/bobbit";
  const identity = createProjectPathIdentity({
    isNativePathApi: dialect => dialect === "posix",
    realpathSync: candidate => path.posix.resolve(candidate) === root ? root : (() => { throw missing(candidate); })(),
    isCaseInsensitiveAt: () => false,
  });
  const registry = registryWithRoot("case-sensitive", root, identity);

  assert.equal(registry.getByPath(alias), undefined);
  assert.equal(registry.registerProvisional("case-distinct", alias).provisional, true);
});

test("ProjectRegistry uses one owned probe without caching its evidence", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "project-registry-native-case-"));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-registry-native-case-state-"));
  fixtureDirs.push(fixtureRoot, stateDir);
  const root = path.join(fixtureRoot, "PlannedProject");
  const alias = path.join(fixtureRoot, "plannedproject");

  fs.mkdirSync(root);
  const caseInsensitive = fs.existsSync(alias);
  fs.rmSync(root, { recursive: true, force: true });

  const registry = new ProjectRegistry(stateDir);
  const first = registry.registerProvisional("upper", root);
  const second = registry.registerProvisional("lower", alias);
  assert.deepEqual(fs.readdirSync(fixtureRoot), [], "owned case probes must be removed after lookup");

  if (caseInsensitive) {
    assert.equal(second.id, first.id, "empty-parent aliases must deduplicate on an insensitive volume");
    assert.equal(registry.list().length, 1);
  } else {
    assert.notEqual(second.id, first.id, "sensitive-volume aliases must remain distinct");
    assert.equal(registry.list().length, 2);
  }

  fs.mkdirSync(root);
  assert.equal(registry.getByPath(alias)?.id, caseInsensitive ? first.id : second.id, "materializing the path must not change its project owner");
});

test("ProjectRegistry treats case-paired entries as sensitive without a directory scan", () => {
  const parent = "/case-sensitive-with-pair";
  const upper = path.posix.join(parent, "Alpha");
  const lower = path.posix.join(parent, "alpha");
  let probes = 0;
  const identity = createProjectPathIdentity({
    isNativePathApi: dialect => dialect === "posix",
    realpathSync: candidate => path.posix.resolve(candidate),
    lstatSync: candidate => ({ dev: 1, ino: path.posix.basename(candidate) === "Alpha" ? 1 : 2 }),
    createCaseProbe: probeParent => {
      probes += 1;
      return path.posix.join(probeParent, ".BobbitProbe");
    },
    removeCaseProbe: () => {},
    caseSemanticsFingerprint: parentPath => `stable:${parentPath}`,
  });
  const registry = registryWithRoot("upper", upper, identity);

  assert.equal(registry.getByPath(lower), undefined);
  assert.notEqual(registry.registerProvisional("lower", lower).id, "upper");
  assert.equal(probes, 0, "known case-paired entries are resolved by their two lstat identities");
});

test("ProjectRegistry uses bounded work while keeping owned probe evidence uncached", () => {
  const parent = "/large-directory";
  let probes = 0;
  let realpaths = 0;
  const identity = createProjectPathIdentity({
    isNativePathApi: dialect => dialect === "posix",
    realpathSync: candidate => {
      realpaths += 1;
      const resolved = path.posix.resolve(candidate);
      if (resolved === parent || path.posix.dirname(resolved) === parent && /^\.bobbitprobe/i.test(path.posix.basename(resolved))) return resolved;
      throw missing(candidate);
    },
    lstatSync: () => ({ dev: 1, ino: 1 }),
    createCaseProbe: probeParent => {
      probes += 1;
      return path.posix.join(probeParent, ".BobbitProbe");
    },
    removeCaseProbe: () => {},
    caseSemanticsFingerprint: parentPath => `stable:${parentPath}`,
  });

  assert.equal(identity(`${parent}/Child`), `${parent}/child`);
  assert.equal(identity(`${parent}/CHILD`), `${parent}/child`);
  assert.equal(probes, 2, "each lookup must classify owned probe evidence afresh");
  assert.ok(realpaths <= 12, `expected constant filesystem work, got ${realpaths} realpath calls`);
});

test("ProjectRegistry preserves spelling when a directory incarnation changes during an owned probe", () => {
  const parent = "/probe-publication-race";
  const cache = new Map();
  let incarnation = 1;
  const identity = createProjectPathIdentity({
    isNativePathApi: dialect => dialect === "posix",
    isCaseInsensitiveAt: directory => directory === "/" ? false : undefined,
    realpathSync: candidate => {
      const resolved = path.posix.resolve(candidate);
      if (resolved === parent || path.posix.dirname(resolved) === parent && /^\.bobbitprobe/i.test(path.posix.basename(resolved))) return resolved;
      throw missing(candidate);
    },
    lstatSync: candidate => path.posix.resolve(candidate) === parent
      ? { dev: 1, ino: incarnation }
      : { dev: 1, ino: 1 },
    createCaseProbe: probeParent => {
      incarnation = 2;
      return path.posix.join(probeParent, ".BobbitProbe");
    },
    removeCaseProbe: () => {},
    caseSemanticsCache: cache,
    caseSemanticsFingerprint: parentPath => `incarnation-${incarnation}:${parentPath}`,
  });

  assert.equal(
    identity(`${parent}/Child`),
    `${parent}/Child`,
    "probe evidence from a replaced directory must not fold the requested spelling",
  );
  assert.equal(cache.size, 0, "probe evidence must not be published under the replacement fingerprint");
});

test("ProjectRegistry invalidates cached probe evidence when the directory changes", () => {
  const parent = "/fingerprinted-case";
  let revision = 1;
  const identity = createProjectPathIdentity({
    isNativePathApi: dialect => dialect === "posix",
    realpathSync: candidate => {
      const resolved = path.posix.resolve(candidate);
      if (resolved === parent) return resolved;
      if (revision === 1 && path.posix.dirname(resolved) === parent) return resolved;
      throw missing(candidate);
    },
    lstatSync: () => ({ dev: 1, ino: 1 }),
    createCaseProbe: probeParent => path.posix.join(probeParent, ".BobbitProbe"),
    removeCaseProbe: () => {},
    caseSemanticsFingerprint: parentPath => `revision-${revision}:${parentPath}`,
  });

  assert.equal(identity(`${parent}/Child`), `${parent}/child`);
  revision = 2;
  assert.equal(identity(`${parent}/CHILD`), `${parent}/CHILD`, "new directory evidence must replace the cached alias decision");
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
  assert.throws(() => registry.register("Headquarters bypass", nativeAlias, { acceptCanonical: true }), /Headquarters|immutable/i);
  assert.throws(() => registry.registerProvisional("Headquarters bypass", nativeAlias), /Headquarters|immutable/i);

  const normal = registry.register("normal", normalRoot, { acceptCanonical: true });
  const normalAlias = process.platform === "win32" ? normalRoot : `/${normalRoot}`;
  assert.equal(registry.getByPath(normalAlias)?.id, normal.id);
  assert.throws(() => registry.register("duplicate bypass", normalAlias, { acceptCanonical: true }), /already registered/i);
  assert.equal(registry.registerProvisional("duplicate bypass", normalAlias).id, normal.id);
});
