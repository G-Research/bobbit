// Ported from tests/project-registry-provisional-dedupe.test.ts (straggler-coverage
// -triage GENUINE-LOSS: registerProvisional reuse/immutability). Faithful port —
// same assertions, vitest.
import { afterAll, beforeAll, test, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createFsFromVolume, Volume } from "memfs";

import {
  canonicalProjectPath,
  createProjectPathIdentity,
  HEADQUARTERS_PROJECT_ID,
  ProjectRegistry,
  SpecialProjectMutationError,
  SYSTEM_PROJECT_ID,
} from "../../../src/server/agent/project-registry.js";

const memoryFs = createFsFromVolume(new Volume()) as unknown as typeof fs;
const fsSpies: Array<{ mockRestore(): void }> = [];
let fixtureSequence = 0;

beforeAll(() => {
  for (const name of [
    "accessSync", "existsSync", "mkdirSync", "readFileSync", "readdirSync",
    "realpathSync", "renameSync", "rmSync", "rmdirSync", "statSync",
    "statfsSync", "writeFileSync",
  ] as const) {
    fsSpies.push(vi.spyOn(fs, name).mockImplementation(memoryFs[name].bind(memoryFs) as never));
  }
});

afterAll(() => fsSpies.forEach(spy => spy.mockRestore()));

function makeTmpDir(label: string): string {
  const dir = path.resolve("/memfs/project-registry-provisional", `${label}${fixtureSequence++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readStoredProjects(stateDir: string): Array<{ id: string; rootPath: string; provisional?: boolean; hidden?: boolean }> {
  return JSON.parse(fs.readFileSync(path.join(stateDir, "projects.json"), "utf-8"));
}

test("canonicalProjectPath folds nonexistent suffixes only after an owned insensitive probe", () => {
  const pathApi = path.posix;
  const ancestor = pathApi.join(pathApi.sep, "identity", "Ancestor");
  const probe = pathApi.join(ancestor, ".BobbitProbe");
  const missing = (candidate: string): never => { throw Object.assign(new Error(`not found: ${candidate}`), { code: "ENOENT" }); };
  const nativePosixVolume = { isNativePathApi: (dialect: "posix" | "win32") => dialect === "posix" };

  assert.equal(
    canonicalProjectPath(pathApi.join(ancestor, "FutureProject"), {
      ...nativePosixVolume,
      realpathSync: candidate => candidate === ancestor || candidate === pathApi.join(pathApi.dirname(ancestor), "ancestor") || candidate.toLowerCase() === probe.toLowerCase() ? candidate : missing(candidate),
      lstatSync: () => ({ dev: 1, ino: 1, isDirectory: () => true }),
      createCaseProbe: () => probe,
      removeCaseProbe: () => {},
      caseSemanticsFingerprint: parent => `stable:${parent}`,
    }),
    pathApi.join("/identity", "ancestor", "futureproject"),
    "a same-entry alternate probe proves folding of future segments is safe",
  );
  assert.equal(
    canonicalProjectPath(pathApi.join(ancestor, "FutureProject"), {
      ...nativePosixVolume,
      realpathSync: candidate => candidate === ancestor || candidate === probe ? candidate : missing(candidate),
      lstatSync: () => ({ dev: 1, ino: 1 }),
      createCaseProbe: () => probe,
      removeCaseProbe: () => {},
    }),
    pathApi.join(ancestor, "FutureProject"),
    "a missing alternate retains the requested suffix spelling",
  );
});

test("canonicalProjectPath preserves native Windows spelling on an injected sensitive volume", () => {
  const ancestor = "C:\\Workspace\\Ancestor";
  const nativeSensitiveWindows = {
    realpathSync: (candidate: string): string => {
      if (candidate === ancestor) return ancestor;
      throw new Error(`not found: ${candidate}`);
    },
    isCaseInsensitiveAt: () => false,
    isNativePathApi: (pathApi: "posix" | "win32") => pathApi === "win32",
  };

  const upper = canonicalProjectPath(`${ancestor}\\FutureProject`, nativeSensitiveWindows);
  const lower = canonicalProjectPath(`${ancestor}\\futureproject`, nativeSensitiveWindows);

  assert.equal(upper, "c:/Workspace/Ancestor/FutureProject");
  assert.equal(lower, "c:/Workspace/Ancestor/futureproject");
  assert.notEqual(upper, lower, "case-distinct native Windows paths retain distinct identities");
});

test("canonicalProjectPath folds native Windows spelling on an injected insensitive volume", () => {
  const ancestor = "C:\\Workspace\\Ancestor";
  const nativeInsensitiveWindows = {
    realpathSync: (candidate: string): string => {
      if (candidate === ancestor) return ancestor;
      throw new Error(`not found: ${candidate}`);
    },
    isCaseInsensitiveAt: () => true,
    isNativePathApi: (pathApi: "posix" | "win32") => pathApi === "win32",
  };

  assert.equal(
    canonicalProjectPath(`${ancestor}\\FutureProject`, nativeInsensitiveWindows),
    "c:/workspace/ancestor/futureproject",
  );
  assert.equal(
    canonicalProjectPath(`${ancestor}\\futureproject`, nativeInsensitiveWindows),
    "c:/workspace/ancestor/futureproject",
  );
});

test("canonicalProjectPath preserves a suffix below a case-sensitive NTFS child of an insensitive parent", () => {
  const sensitiveChild = "C:\\Workspace\\SensitiveChild";
  const knownEntry = `${sensitiveChild}\\KnownEntry`;
  const nativeWindows = {
    realpathSync: (candidate: string): string => {
      // The parent directory is insensitive, so the child's name resolves in
      // either case. Entries inside SensitiveChild remain case-sensitive.
      if (candidate === sensitiveChild || candidate === "C:\\Workspace\\sensitiveChild" || candidate === knownEntry) {
        return sensitiveChild;
      }
      throw new Error(`not found: ${candidate}`);
    },
    lstatSync: (candidate: string) => ({ dev: 1, ino: candidate === sensitiveChild ? 1 : 2 }),
    isNativePathApi: (pathApi: "posix" | "win32") => pathApi === "win32",
  };

  assert.equal(
    canonicalProjectPath(`${sensitiveChild}\\FutureProject`, nativeWindows),
    "c:/Workspace/SensitiveChild/FutureProject",
    "the child directory's entry semantics, not its lookup from the parent, govern its nonexistent suffix",
  );
});

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

test("ProjectRegistry path identity folds provisional and Headquarters aliases only on an injected insensitive filesystem", () => {
  const serverRoot = makeTmpDir("bobbit-provisional-case-insensitive-server-");
  const stateDir = makeTmpDir("bobbit-provisional-case-insensitive-state-");
  const headquartersRoot = path.join(serverRoot, ".bobbit", "headquarters");
  const insensitiveIdentity = createProjectPathIdentity({ isCaseInsensitiveAt: () => true });
  try {
    fs.mkdirSync(headquartersRoot, { recursive: true });
    const registry = new ProjectRegistry(stateDir, { pathIdentity: insensitiveIdentity });
    registry.ensureHeadquartersProject(headquartersRoot, { stateDir });

    assert.throws(
      () => registry.registerProvisional("case alias", path.join(serverRoot, ".bobbit", "HEADQUARTERS")),
      (err: unknown) => err instanceof SpecialProjectMutationError && err.code === "HEADQUARTERS_IMMUTABLE",
    );

    const first = registry.registerProvisional("first", path.join(serverRoot, "PlannedProject"));
    const duplicate = registry.registerProvisional("duplicate", path.join(serverRoot, "plannedproject"));
    assert.equal(duplicate.id, first.id, "case-only nonexistent suffix aliases share one provisional project");
  } finally {
    fs.rmSync(serverRoot, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("ProjectRegistry preserves distinct nonexistent suffixes on an injected sensitive filesystem", () => {
  const serverRoot = makeTmpDir("bobbit-provisional-case-sensitive-server-");
  const stateDir = makeTmpDir("bobbit-provisional-case-sensitive-state-");
  const headquartersRoot = path.join(serverRoot, ".bobbit", "headquarters");
  const sensitiveIdentity = createProjectPathIdentity({ isCaseInsensitiveAt: () => false });
  try {
    fs.mkdirSync(headquartersRoot, { recursive: true });
    const registry = new ProjectRegistry(stateDir, { pathIdentity: sensitiveIdentity });
    registry.ensureHeadquartersProject(headquartersRoot, { stateDir });

    const caseDistinctHeadquarters = registry.registerProvisional(
      "case-distinct path",
      path.join(serverRoot, ".bobbit", "HEADQUARTERS"),
    );
    assert.equal(caseDistinctHeadquarters.provisional, true);

    const upper = registry.registerProvisional("upper", path.join(serverRoot, "PlannedProject"));
    const lower = registry.registerProvisional("lower", path.join(serverRoot, "plannedproject"));
    assert.notEqual(lower.id, upper.id, "case-sensitive suffixes must not be folded together");
  } finally {
    fs.rmSync(serverRoot, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
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
