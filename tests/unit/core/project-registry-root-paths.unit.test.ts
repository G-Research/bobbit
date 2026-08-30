import { afterEach, test, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CASE_EVIDENCE_ENTRY_LIMIT,
  canonicalProjectPath,
  createProjectPathIdentity,
  ProjectRegistry,
  type ProjectPathIdentity,
  type RegisteredProject,
} from "../../../src/server/agent/project-registry.js";

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
  assert.equal(drive.findByCwd("c:/Workspace/Project/src")?.id, "drive-root");
  assert.equal(drive.getByPath("c:/Workspace/Project")?.id, "drive-root");

  const unc = registryWithRoot("unc-root", "\\\\server\\share\\Workspace", foreignWindowsIdentity);
  assert.equal(unc.findByCwd("\\\\SERVER\\SHARE\\Workspace\\project")?.id, "unc-root");
  assert.equal(unc.getByPath("\\\\SERVER\\SHARE\\Workspace")?.id, "unc-root");
});

test("ProjectRegistry preserves foreign Windows descendant case while normalizing roots", () => {
  const foreignWindows = { isNativePathApi: () => false };

  assert.equal(canonicalProjectPath("C:\\Workspace\\Sensitive\\Foo", foreignWindows), "c:/Workspace/Sensitive/Foo");
  assert.equal(canonicalProjectPath("C:\\Workspace\\Sensitive\\foo", foreignWindows), "c:/Workspace/Sensitive/foo");
  assert.notEqual(
    canonicalProjectPath("C:\\Workspace\\Sensitive\\Foo", foreignWindows),
    canonicalProjectPath("C:\\Workspace\\Sensitive\\foo", foreignWindows),
  );
  assert.notEqual(
    canonicalProjectPath("\\\\server\\share\\Sensitive\\Foo", foreignWindows),
    canonicalProjectPath("\\\\SERVER\\SHARE\\Sensitive\\foo", foreignWindows),
  );
});

test("ProjectRegistry.findByCwd respects modeled case-sensitive Windows identity components", () => {
  // `C:\\` is real on Windows runners. Model both the volume and its case
  // evidence so host filesystem semantics cannot fold fixture descendants.
  const modeledWindowsIdentity = (caseInsensitive: boolean) => createProjectPathIdentity({
    isNativePathApi: dialect => dialect === "win32",
    realpathSync: candidate => path.win32.resolve(candidate),
    isCaseInsensitiveAt: () => caseInsensitive,
  });
  const sensitiveIdentity = modeledWindowsIdentity(false);
  const sensitive = registryWithRoot("sensitive-drive", "C:\\Workspace\\Sensitive\\Foo", sensitiveIdentity);
  assert.equal(sensitive.findByCwd("C:\\Workspace\\Sensitive\\Foo\\child")?.id, "sensitive-drive");
  assert.equal(sensitive.findByCwd("C:\\Workspace\\Sensitive\\foo\\child"), undefined);

  const insensitive = registryWithRoot("insensitive-drive", "C:\\Workspace\\Sensitive\\Foo", modeledWindowsIdentity(true));
  assert.equal(insensitive.findByCwd("C:\\Workspace\\Sensitive\\foo\\child")?.id, "insensitive-drive");

  const sensitiveUnc = registryWithRoot("sensitive-unc", "\\\\server\\share\\Sensitive\\Foo", sensitiveIdentity);
  assert.equal(sensitiveUnc.findByCwd("\\\\server\\share\\Sensitive\\Foo\\child")?.id, "sensitive-unc");
  assert.equal(sensitiveUnc.findByCwd("\\\\server\\share\\Sensitive\\foo\\child"), undefined);
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
    lstatSync: candidate => ({ dev: 1, ino: path.posix.resolve(candidate).toLowerCase().length, isDirectory: () => true }),
    createCaseProbe: parent => path.posix.join(parent, ".BobbitProbe"),
    removeCaseProbe: () => {},
    caseSemanticsFingerprint: parent => `stable:${parent.toLowerCase()}`,
  });
  const registry = registryWithRoot("case-preserving", root, identity);

  assert.equal(canonicalProjectPath(root, {
    isNativePathApi: dialect => dialect === "posix",
    realpathSync: candidate => path.posix.resolve(candidate),
    lstatSync: candidate => ({ dev: 1, ino: path.posix.resolve(candidate).toLowerCase().length, isDirectory: () => true }),
    createCaseProbe: parent => path.posix.join(parent, ".BobbitProbe"),
    removeCaseProbe: () => {},
    caseSemanticsFingerprint: parent => `stable:${parent.toLowerCase()}`,
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
    lstatSync: candidate => {
      const name = path.posix.basename(candidate);
      return {
        dev: 1,
        ino: name === "Alpha" ? 1 : name === "alpha" ? 2 : 3,
        isDirectory: () => true,
      };
    },
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

test("ProjectRegistry folds an unwritable nonexistent suffix from bounded read-only evidence", () => {
  const parent = "/read-only-case-evidence";
  const knownEntry = path.posix.join(parent, "KnownEntry");
  let directoryReads = 0;
  let probeAttempts = 0;
  const identity = createProjectPathIdentity({
    isNativePathApi: dialect => dialect === "posix",
    realpathSync: candidate => {
      const resolved = path.posix.resolve(candidate);
      if (resolved === parent || resolved === knownEntry || resolved === path.posix.join(parent, "knownEntry")) return resolved;
      throw missing(candidate);
    },
    lstatSync: candidate => path.posix.resolve(candidate).toLowerCase() === knownEntry.toLowerCase()
      ? { dev: 1, ino: 1, isDirectory: () => true }
      : { dev: 1, ino: 2, isDirectory: () => true },
    caseSemanticsFingerprint: parentPath => `stable:${parentPath}`,
    readDirectoryEntries: (directory, limit) => {
      directoryReads += 1;
      assert.equal(directory, parent);
      assert.equal(limit, CASE_EVIDENCE_ENTRY_LIMIT);
      return ["KnownEntry"];
    },
    createCaseProbe: () => {
      probeAttempts += 1;
      throw Object.assign(new Error("read-only directory"), { code: "EPERM" });
    },
  });

  assert.equal(identity(`${parent}/FutureProject`), `${parent}/futureproject`);
  assert.equal(directoryReads, 1, "a readable parent supplies non-mutating case evidence");
  assert.equal(probeAttempts, 0, "read-only evidence avoids a failed owned probe");
});

test("ProjectRegistry leaves sampled evidence conservative without a stable directory fingerprint", () => {
  const parent = "/unfingerprinted-case-evidence";
  const knownEntry = path.posix.join(parent, "KnownEntry");
  const cache = new Map();
  const identity = createProjectPathIdentity({
    isNativePathApi: dialect => dialect === "posix",
    isCaseInsensitiveAt: directory => directory === "/" ? false : undefined,
    realpathSync: candidate => {
      const resolved = path.posix.resolve(candidate);
      if (resolved === parent || resolved === knownEntry || resolved === path.posix.join(parent, "knownEntry")) return resolved;
      throw missing(candidate);
    },
    lstatSync: candidate => path.posix.resolve(candidate) === parent
      ? { dev: 1, ino: 1, isDirectory: () => true }
      : { dev: 1, ino: 2, isDirectory: () => true },
    readDirectoryEntries: () => ["KnownEntry"],
    createCaseProbe: () => { throw new Error("sample should not need a probe"); },
    caseSemanticsCache: cache,
    caseSemanticsFingerprint: () => undefined,
  });

  assert.equal(identity(`${parent}/FutureProject`), `${parent}/FutureProject`);
  assert.equal(cache.size, 0);
});

test("ProjectRegistry keeps Windows identity stable across sibling fingerprint churn without caching", () => {
  const parent = "C:\\Temp\\churning-case-evidence";
  const knownEntry = path.win32.join(parent, "KnownEntry");
  const cache = new Map();
  let fingerprintReads = 0;
  const isParent = (candidate: string) => path.win32.resolve(candidate).toLowerCase() === parent.toLowerCase();
  const identity = createProjectPathIdentity({
    isNativePathApi: dialect => dialect === "win32",
    isCaseInsensitiveAt: directory => isParent(directory) ? undefined : false,
    realpathSync: candidate => {
      const resolved = path.win32.resolve(candidate);
      if (isParent(resolved)) return parent;
      if (resolved.toLowerCase() === knownEntry.toLowerCase()) return resolved;
      throw missing(candidate);
    },
    lstatSync: candidate => isParent(candidate)
      ? { dev: 7, ino: 11, isDirectory: () => true }
      : { dev: 7, ino: 12, isDirectory: () => true },
    readDirectoryEntries: () => ["KnownEntry"],
    createCaseProbe: () => { throw new Error("sample should not need a probe"); },
    caseSemanticsCache: cache,
    caseSemanticsFingerprint: () => `metadata-revision-${++fingerprintReads}`,
  });

  const mixedCase = identity(`${parent}\\FutureProject`);
  const alternateCase = identity("c:/TEMP/churning-case-evidence/FUTUREPROJECT");
  assert.equal(mixedCase, "c:/Temp/churning-case-evidence/futureproject");
  assert.equal(alternateCase, mixedCase, "fingerprint-only churn must not change the physical cwd identity");
  assert.equal(fingerprintReads, 4, "each lookup must observe its changing before/after fingerprint");
  assert.equal(cache.size, 0, "changing full fingerprints must never populate the case-semantics cache");
});

test("ProjectRegistry rejects zero or replaced directory identities for sampled evidence", () => {
  const parent = "/unstable-case-evidence";
  const knownEntry = path.posix.join(parent, "KnownEntry");
  const createIdentity = (parentStat: () => { dev: number; ino: number }, fingerprint: () => string) => {
    const cache = new Map();
    return {
      cache,
      identity: createProjectPathIdentity({
        isNativePathApi: dialect => dialect === "posix",
        isCaseInsensitiveAt: directory => directory === "/" ? false : undefined,
        realpathSync: candidate => {
          const resolved = path.posix.resolve(candidate);
          if (resolved === parent || resolved === knownEntry || resolved === path.posix.join(parent, "knownEntry")) return resolved;
          throw missing(candidate);
        },
        lstatSync: candidate => path.posix.resolve(candidate) === parent
          ? { ...parentStat(), isDirectory: () => true }
          : { dev: 1, ino: 2, isDirectory: () => true },
        readDirectoryEntries: () => ["KnownEntry"],
        createCaseProbe: () => { throw new Error("sample should not need a probe"); },
        caseSemanticsCache: cache,
        caseSemanticsFingerprint: fingerprint,
      }),
    };
  };

  const zero = createIdentity(() => ({ dev: 1, ino: 0 }), () => "stable");
  assert.equal(zero.identity(`${parent}/FutureProject`), `${parent}/FutureProject`);
  assert.equal(zero.cache.size, 0);

  const zeroDevice = createIdentity(() => ({ dev: 0, ino: 1 }), () => "stable");
  assert.equal(zeroDevice.identity(`${parent}/FutureProject`), `${parent}/FutureProject`);
  assert.equal(zeroDevice.cache.size, 0);

  let identityReads = 0;
  const replaced = createIdentity(
    () => ({ dev: 1, ino: ++identityReads === 1 ? 1 : 2 }),
    () => "stable",
  );
  assert.equal(replaced.identity(`${parent}/FutureProject`), `${parent}/FutureProject`);
  assert.equal(replaced.cache.size, 0);
});

test("ProjectRegistry never treats same-inode file pairs as directory-wide case evidence", () => {
  const parent = "/hard-link-case-evidence";
  const upper = path.posix.join(parent, "Victim");
  const lower = path.posix.join(parent, "victim");
  const knownEntry = path.posix.join(parent, "Alpha");
  let probes = 0;
  const cache = new Map();
  const identity = createProjectPathIdentity({
    isNativePathApi: dialect => dialect === "posix",
    isCaseInsensitiveAt: directory => directory === "/" ? false : undefined,
    realpathSync: candidate => {
      const resolved = path.posix.resolve(candidate);
      if (resolved === parent || resolved === knownEntry || resolved === path.posix.join(parent, "alpha")) return resolved;
      throw missing(candidate);
    },
    lstatSync: candidate => path.posix.resolve(candidate) === parent
      ? { dev: 1, ino: 1, isDirectory: () => true }
      : { dev: 1, ino: 2, isDirectory: () => false },
    readDirectoryEntries: () => ["Alpha"],
    createCaseProbe: probeParent => {
      probes += 1;
      return path.posix.join(probeParent, ".BobbitProbe");
    },
    removeCaseProbe: () => {},
    caseSemanticsCache: cache,
    caseSemanticsFingerprint: parentPath => `stable:${parentPath}`,
  });
  const registry = registryWithRoot("upper", upper, identity);

  assert.equal(registry.getByPath(lower), undefined);
  assert.ok(probes > 0, "inconclusive hard-link evidence must fall back to the owned probe");
  assert.equal(cache.size, 0, "owned probe evidence is never cached");
});

test("ProjectRegistry bounds opendir work before falling back from inconclusive suffix evidence", () => {
  const parent = "/bounded-read-only-evidence";
  let reads = 0;
  let closes = 0;
  let probeAttempts = 0;
  vi.spyOn(fs, "opendirSync").mockImplementation(() => ({
    readSync: () => {
      reads += 1;
      return { name: `000${reads}` };
    },
    closeSync: () => { closes += 1; },
  }) as unknown as fs.Dir);
  const identity = createProjectPathIdentity({
    isNativePathApi: dialect => dialect === "posix",
    realpathSync: candidate => path.posix.resolve(candidate) === parent
      ? parent
      : (() => { throw missing(candidate); })(),
    lstatSync: () => ({ dev: 1, ino: 1 }),
    createCaseProbe: () => {
      probeAttempts += 1;
      throw Object.assign(new Error("read-only directory"), { code: "EPERM" });
    },
  });

  assert.equal(identity(`${parent}/FutureProject`), `${parent}/FutureProject`);
  assert.equal(reads, CASE_EVIDENCE_ENTRY_LIMIT, "opendir must not scan past its fixed evidence budget");
  assert.equal(closes, 1, "the bounded directory handle is always closed");
  assert.equal(probeAttempts, 1, "inconclusive evidence retains the owned-probe fallback");
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
    lstatSync: () => ({ dev: 1, ino: 1, isDirectory: () => true }),
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
      ? { dev: 1, ino: incarnation, isDirectory: () => true }
      : { dev: 1, ino: 1, isDirectory: () => true },
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
    lstatSync: () => ({ dev: 1, ino: 1, isDirectory: () => true }),
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
