#!/usr/bin/env node
/**
 * Real compiler contract for independent persistent check and server-emission caches.
 *
 * This deliberately is not a tier-1 test: it starts real TypeScript compiler
 * processes and builds an isolated archive of committed HEAD. It requires a
 * clean checkout for that repository-fidelity path and never changes it. Run
 * it explicitly with:
 *
 *   node scripts/testing-v2/check-cache-contract.mjs
 *
 * `--fixture-only` is useful while developing this runner before the package
 * script which it validates has landed.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const TYPESCRIPT = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const CACHE_NAMES = ["check-server.tsbuildinfo", "check-web.tsbuildinfo", "check-tests2.tsbuildinfo"];
const BUILD_CACHE = "build-server.tsbuildinfo";
const BUILD_STATE = "build-server-state.json";
const BUILD_PROFILES = [BUILD_CACHE, BUILD_STATE];
const EXPECTED_CHECK = "shx mkdir -p .profiles && tsc -p tsconfig.server.json --noEmit --incremental --tsBuildInfoFile .profiles/check-server.tsbuildinfo && tsc -p tsconfig.web.json --noEmit --incremental --tsBuildInfoFile .profiles/check-web.tsbuildinfo && tsc -p tsconfig.tests2.json --noEmit --incremental --tsBuildInfoFile .profiles/check-tests2.tsbuildinfo";
const EXPECTED_BUILD_SERVER = "node scripts/build-server.mjs && shx chmod +x dist/server/cli.js && shx rm -rf dist/server/defaults && node scripts/copy-defaults.mjs && shx rm -rf dist/server/builtin-packs && node scripts/copy-builtin-packs.mjs";
const EXPECTED_BUILD = "npm run build:packs && npm run build:server && npm run build:ui";
const EXPECTED_CLEAN = "shx rm -rf dist .profiles/build-server.tsbuildinfo .profiles/build-server-state.json";
const TEST_FAULT_ENV = "BOBBIT_BUILD_SERVER_TEST_FAULT_AFTER_TSC";
const LINKED_OUTPUT_DIAGNOSTIC = "refusing linked output-tree path before compiler invocation";
const fixtureOnly = process.argv.slice(2).includes("--fixture-only");
// On Windows, prefer System32\tar.exe (bsdtar) over msys/Git Bash GNU tar.
// GNU tar can interpret native drive paths as remote hosts; bsdtar accepts them.
const TAR_BIN = process.platform === "win32" && existsSync("C:\\Windows\\System32\\tar.exe")
  ? "C:\\Windows\\System32\\tar.exe"
  : "tar";
let root;

function fail(message) {
  throw new Error(`[check-cache-contract] ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function run(command, args, cwd, { expect = 0, label = command, env = {} } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
  if (result.error) fail(`${label} could not start: ${result.error.message}`);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (expect === 0 && result.status !== 0)
    fail(`${label} failed (exit ${result.status}):\n${output}`);
  if (expect === "nonzero" && result.status === 0)
    fail(`${label} unexpectedly succeeded`);
  return { ...result, output };
}

function runNpm(args, cwd, options) {
  // Node cannot directly spawn a .cmd shim in some MSYS/Git Bash environments.
  // cmd.exe is available on every supported Windows installation and handles it.
  if (process.platform === "win32") {
    const cmd = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
    return run(cmd, ["/d", "/s", "/c", `${NPM} ${args.join(" ")}`], cwd, options);
  }
  return run(NPM, args, cwd, options);
}

function write(rootDir, name, contents) {
  const path = join(rootDir, ...name.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function remove(path) {
  rmSync(path, { recursive: true, force: true, maxRetries: 3 });
}

function checkArgs(config, cache) {
  return [TYPESCRIPT, "-p", config, "--noEmit", "--incremental", "--tsBuildInfoFile", join(".profiles", cache)];
}

function checkOne(fixture, name) {
  return run(process.execPath, checkArgs(`tsconfig.${name}.json`, `check-${name}.tsbuildinfo`), fixture, { label: `${name} check` });
}

/** The direct-argv equivalent of the package script's `&&` chain. */
function checkAll(fixture) {
  for (const name of ["server", "web", "tests2"]) checkOne(fixture, name);
}

/** Run the same left-to-right chain but return its first failure for assertions. */
function checkAllResult(fixture) {
  for (const name of ["server", "web", "tests2"]) {
    const result = run(process.execPath, checkArgs(`tsconfig.${name}.json`, `check-${name}.tsbuildinfo`), fixture, { expect: "any", label: `${name} sequential check` });
    if (result.status !== 0) return result;
  }
  return { status: 0, output: "" };
}

function expectFailure(action, marker) {
  const result = action();
  assert(result.status !== 0, `${marker}: compiler unexpectedly succeeded`);
  assert(result.output.includes(marker), `${marker}: expected diagnostic was absent:\n${result.output}`);
}

function profilePaths(fixture) {
  return CACHE_NAMES.map(name => join(fixture, ".profiles", name));
}

function assertCaches(fixture) {
  const profiles = join(fixture, ".profiles");
  assert(existsSync(profiles), "check did not create .profiles");
  const names = readdirSync(profiles).sort();
  assert(JSON.stringify(names) === JSON.stringify([...CACHE_NAMES].sort()), `expected exactly three cache identities, found ${names.join(", ")}`);
  for (const path of profilePaths(fixture)) {
    assert(statSync(path).size > 0, `cache is empty: ${relative(fixture, path)}`);
    try { JSON.parse(readFileSync(path, "utf8")); } catch { fail(`cache is not valid JSON: ${relative(fixture, path)}`); }
  }
}

function assertNoSourceEmit(fixture) {
  const unexpected = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".profiles") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:js|d\.ts|js\.map|d\.ts\.map)$/.test(entry.name)) unexpected.push(relative(fixture, path));
    }
  };
  walk(fixture);
  assert(unexpected.length === 0, `no-emit check produced source artifacts: ${unexpected.join(", ")}`);
}

function seedFixture(fixture) {
  remove(fixture);
  mkdirSync(fixture, { recursive: true });
  write(fixture, "node_modules/fixture-dependency/package.json", '{"name":"fixture-dependency","types":"index.d.ts"}\n');
  write(fixture, "node_modules/fixture-dependency/index.d.ts", "export interface DependencyShape { value: string }\n");
  write(fixture, "shared/value.ts", "export interface SharedValue { label: string }\nexport const shared: SharedValue = { label: 'ok' };\n");
  write(fixture, "server/imported.ts", "export const imported = 'available';\n");
  write(fixture, "server/index.ts", "import { imported } from './imported.js';\nimport { shared, type SharedValue } from '../shared/value.js';\nimport type { DependencyShape } from 'fixture-dependency';\nconst serverValue: SharedValue = { label: 'ok' };\nconst dependencyValue: DependencyShape = { value: imported };\nvoid shared; void serverValue; void dependencyValue;\n");
  write(fixture, "web/index.ts", "import { shared, type SharedValue } from '../shared/value.js';\nconst webValue: SharedValue = { label: 'ok' };\nvoid shared; void webValue;\n");
  write(fixture, "tests2/index.ts", "import { shared, type SharedValue } from '../shared/value.js';\nconst testsValue: SharedValue = { label: 'ok' };\nvoid shared; void testsValue;\n");
  write(fixture, "tests2/config-marker.ts", "const configMarker: string = null;\nvoid configMarker;\n");
  const config = (module, include, strict = true) => JSON.stringify({ compilerOptions: { target: "ES2022", module, moduleResolution: module === "Node16" ? "Node16" : "bundler", strict, skipLibCheck: true, noEmit: true }, include }, null, 2) + "\n";
  write(fixture, "tsconfig.server.json", config("Node16", ["server/**/*.ts", "shared/**/*.ts"]));
  write(fixture, "tsconfig.web.json", config("ES2022", ["web/**/*.ts", "shared/**/*.ts"]));
  // Start non-strict so changing this config makes config-marker newly invalid.
  write(fixture, "tsconfig.tests2.json", config("ES2022", ["tests2/**/*.ts", "shared/**/*.ts"], false));
}

function warmFixture(fixture) {
  seedFixture(fixture);
  checkAll(fixture);
  assertCaches(fixture);
  assertNoSourceEmit(fixture);
  checkAll(fixture);
}

function append(path, contents) {
  writeFileSync(path, `${readFileSync(path, "utf8")}${contents}`);
}

function runCompilerFixture(fixture) {
  warmFixture(fixture);

  // A server failure must prevent web/tests2 checks from running, exactly as && does.
  append(join(fixture, "server/index.ts"), "\ntype serverChainMarker = { readonly marker: 'server' }; const serverChainValue: serverChainMarker = 1;\n");
  append(join(fixture, "web/index.ts"), "\ntype webShouldNotRunMarker = { readonly marker: 'web' }; const webShouldNotRunValue: webShouldNotRunMarker = 1;\n");
  const stopped = checkAllResult(fixture);
  assert(stopped.output.includes("serverChainMarker"), `server fail-fast marker absent:\n${stopped.output}`);
  assert(!stopped.output.includes("webShouldNotRunMarker"), "server failure did not stop before web check");

  for (const [name, marker] of [["server", "serverWarmMarker"], ["web", "webWarmMarker"], ["tests2", "tests2WarmMarker"]]) {
    warmFixture(fixture);
    const dir = name === "tests2" ? "tests2" : name;
    append(join(fixture, dir, "index.ts"), `\ntype ${marker} = { readonly marker: '${marker}' }; const ${marker}Value: ${marker} = 1;\n`);
    expectFailure(() => run(process.execPath, checkArgs(`tsconfig.${name}.json`, `check-${name}.tsbuildinfo`), fixture, { expect: "nonzero", label: `${name} post-warm error` }), marker);
  }

  // A cache must not freeze the include glob: newly added sources are checked too.
  for (const name of ["server", "web", "tests2"]) {
    warmFixture(fixture);
    const file = `${name}/warm-new-file.ts`;
    write(fixture, file, `const newFile: number = '${name}';\nvoid newFile;\n`);
    expectFailure(() => run(process.execPath, checkArgs(`tsconfig.${name}.json`, `check-${name}.tsbuildinfo`), fixture, { expect: "nonzero", label: `${name} warm new-file check` }), file);
  }

  warmFixture(fixture);
  remove(join(fixture, "server", "imported.ts"));
  expectFailure(() => run(process.execPath, checkArgs("tsconfig.server.json", "check-server.tsbuildinfo"), fixture, { expect: "nonzero", label: "deleted import check" }), "Cannot find module './imported.js'");

  warmFixture(fixture);
  write(fixture, "node_modules/fixture-dependency/index.d.ts", "export interface DependencyShape { value: number }\n");
  expectFailure(() => run(process.execPath, checkArgs("tsconfig.server.json", "check-server.tsbuildinfo"), fixture, { expect: "nonzero", label: "dependency change check" }), "server/index.ts");

  warmFixture(fixture);
  write(fixture, "shared/value.ts", "export interface SharedValue { label: number }\nexport const shared: SharedValue = { label: 1 };\n");
  for (const name of ["server", "web", "tests2"]) {
    expectFailure(() => run(process.execPath, checkArgs(`tsconfig.${name}.json`, `check-${name}.tsbuildinfo`), fixture, { expect: "nonzero", label: `${name} shared type check` }), `${name === "tests2" ? "tests2" : name}/index.ts`);
  }

  warmFixture(fixture);
  const testsConfig = JSON.parse(readFileSync(join(fixture, "tsconfig.tests2.json"), "utf8"));
  testsConfig.compilerOptions.strict = true;
  writeFileSync(join(fixture, "tsconfig.tests2.json"), `${JSON.stringify(testsConfig, null, 2)}\n`);
  expectFailure(() => run(process.execPath, checkArgs("tsconfig.tests2.json", "check-tests2.tsbuildinfo"), fixture, { expect: "nonzero", label: "config change check" }), "config-marker.ts");

  for (const cache of CACHE_NAMES) {
    const name = cache.slice("check-".length, -".tsbuildinfo".length);
    const marker = `corrupt${name[0].toUpperCase()}${name.slice(1)}CacheMarker`;
    for (const corruption of ["", "not valid build info"]) {
      warmFixture(fixture);
      writeFileSync(join(fixture, ".profiles", cache), corruption);
      checkAll(fixture);
      assertCaches(fixture);
      append(join(fixture, name, "index.ts"), `\ntype ${marker} = { readonly marker: 'corrupt' }; const corruptCacheValue: ${marker} = 1;\n`);
      expectFailure(() => run(process.execPath, checkArgs(`tsconfig.${name}.json`, cache), fixture, { expect: "nonzero", label: `corrupt ${cache} recovery check` }), marker);
    }
  }
}

function normalized(value) {
  return value.trim().replace(/\s+/g, " ");
}

function assertCleanCheckout() {
  const status = run("git", ["status", "--porcelain=v1", "--untracked-files=all"], REPO_ROOT, { label: "git status" });
  assert(status.output === "", `full contract requires a clean checkout because its HEAD archive excludes pending changes; commit or stash them, or run with --fixture-only.\nDirty entries:\n${status.output}`);
}

function assertStaticContract(repo) {
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  assert(normalized(pkg.scripts?.check ?? "") === EXPECTED_CHECK, "package.json check must be the approved canonical sequential cache command");
  assert(normalized(pkg.scripts?.["build:server"] ?? "") === EXPECTED_BUILD_SERVER, "build:server must preserve the approved wrapper/copy command chain exactly");
  assert(normalized(pkg.scripts?.build ?? "") === EXPECTED_BUILD, "npm run build must preserve build:packs, build:server, build:ui ordering");
  assert(normalized(pkg.scripts?.clean ?? "") === EXPECTED_CLEAN, "npm clean must remove dist and only the independent build profiles");
  const build = pkg.scripts?.["build:server"] ?? "";
  assert(!/(?:check-(?:server|web|tests2)\.tsbuildinfo)/.test(build), "build:server must never consume check cache identities");
  assert(existsSync(join(repo, "scripts", "build-server.mjs")), "build:server wrapper is missing");
  const wrapper = readFileSync(join(repo, "scripts", "build-server.mjs"), "utf8");
  for (const name of BUILD_PROFILES)
    assert(wrapper.includes(`.profiles/${name}`), `build wrapper must own .profiles/${name}`);
  for (const name of CACHE_NAMES)
    assert(!wrapper.includes(name), `build wrapper must not mention check cache ${name}`);
  const serverConfig = readFileSync(join(repo, "tsconfig.server.json"), "utf8");
  assert(!/(?:incremental|tsBuildInfoFile|check-(?:server|web|tests2)\.tsbuildinfo|build-server\.tsbuildinfo)/.test(serverConfig), "canonical tsconfig.server.json must not own incremental cache settings");
}

function archiveHead(destination) {
  mkdirSync(destination, { recursive: true });
  // Keep archive bytes as a Buffer; decoding a tar or routing it through a shell
  // would corrupt it.  The generous bound covers the source archive, never deps.
  const binary = spawnSync("git", ["archive", "--format=tar", "HEAD"], { cwd: REPO_ROOT, windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
  if (binary.error || binary.status !== 0) fail(`git archive HEAD failed: ${binary.error?.message ?? binary.stderr?.toString()}`);
  const extracted = spawnSync(TAR_BIN, ["-xf", "-", "-C", destination], { input: binary.stdout, encoding: "utf8", windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
  if (extracted.error || extracted.status !== 0) fail(`tar archive extraction failed: ${extracted.error?.message ?? extracted.stderr}`);
}

function linkDependencies(repo) {
  const source = join(REPO_ROOT, "node_modules");
  const target = join(repo, "node_modules");
  assert(existsSync(source), "repository-local node_modules is required for this contract");
  symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
}

// Remove only a reparse point, never its target. Windows reports directory
// junctions as directories rather than symbolic links, so use non-recursive
// rmdir there. Refusing a real entry prevents recursive cleanup from reaching
// the shared dependency tree.
function unlinkReparsePoint(path) {
  const stat = lstatSync(path);
  if (process.platform === "win32" && stat.isDirectory() && !stat.isSymbolicLink()) {
    rmdirSync(path);
  } else if (stat.isSymbolicLink()) {
    unlinkSync(path);
  } else {
    fail(`refusing to reparse-unlink a real entry: ${path}`);
  }
}

function unlinkDependencyView(repo) {
  const target = join(repo, "node_modules");
  try { unlinkReparsePoint(target); }
  catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  assert(!existsSync(target), "fixture node_modules reparse point survived unlink; refusing recursive cleanup");
}

function sourceOutputs(repo) {
  const sourceRoots = [join(repo, "src", "server"), join(repo, "src", "shared")];
  const outputs = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        const stem = relative(join(repo, "src"), path).slice(0, -3);
        outputs.push(...[`${stem}.js`, `${stem}.d.ts`, `${stem}.js.map`, `${stem}.d.ts.map`]);
      }
    }
  };
  sourceRoots.forEach(walk);
  return outputs;
}

function assertBuildArtifacts(repo) {
  for (const output of sourceOutputs(repo))
    assert(existsSync(join(repo, "dist", output)), `build omitted emitted counterpart: dist/${output}`);
  const cli = join(repo, "dist", "server", "cli.js");
  // Windows does not expose POSIX executable mode bits for copied archive files.
  if (process.platform !== "win32")
    assert((statSync(cli).mode & 0o111) !== 0, "dist/server/cli.js is not executable");
  assert(existsSync(join(repo, "dist", "server", "defaults")), "build did not copy defaults");
  for (const pack of ["pr-walkthrough", "terminal"])
    assert(existsSync(join(repo, "dist", "server", "builtin-packs", "market-packs", pack)), `build did not copy builtin pack: ${pack}`);
}

function buildProfilePath(repo, name) {
  return join(repo, ".profiles", name);
}

function assertBuildProfiles(repo) {
  for (const name of BUILD_PROFILES) {
    const path = buildProfilePath(repo, name);
    assert(existsSync(path) && statSync(path).size > 0, `build did not publish ${relative(repo, path)}`);
  }
  try { JSON.parse(readFileSync(buildProfilePath(repo, BUILD_STATE), "utf8")); }
  catch { fail("build state sidecar is not valid JSON after a successful build"); }
}

function snapshot(paths) {
  return new Map(paths.map(path => [path, readFileSync(path)]));
}

function assertSnapshotUnchanged(before, label) {
  for (const [path, bytes] of before)
    assert(existsSync(path) && readFileSync(path).equals(bytes), `${label} changed ${path}`);
}

function treeManifest(root) {
  const entries = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        // Read metadata and content from one descriptor so a pathname swap cannot
        // make the parity comparison combine facts from different files.
        const fd = openSync(path, "r");
        try {
          const stat = fstatSync(fd);
          entries.push({
            path: relative(root, path).replaceAll("\\", "/"),
            sha256: createHash("sha256").update(readFileSync(fd)).digest("hex"),
            mode: stat.mode & 0o777,
          });
        } finally {
          closeSync(fd);
        }
      }
    }
  };
  walk(root);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function distManifest(repo) {
  return treeManifest(join(repo, "dist"));
}

function runLegacyBuild(repo) {
  run(process.execPath, [TYPESCRIPT, "-p", "tsconfig.server.json"], repo, { label: "legacy non-incremental server emit" });
  const cli = join(repo, "dist", "server", "cli.js");
  assert(existsSync(cli), "legacy emit did not create dist/server/cli.js");
  chmodSync(cli, statSync(cli).mode | 0o111);
  remove(join(repo, "dist", "server", "defaults"));
  run(process.execPath, ["scripts/copy-defaults.mjs"], repo, { label: "legacy copy defaults" });
  remove(join(repo, "dist", "server", "builtin-packs"));
  run(process.execPath, ["scripts/copy-builtin-packs.mjs"], repo, { label: "legacy copy builtin packs" });
}

function runBuild(repo, label = "build:server", options = {}) {
  return runNpm(["run", "build:server"], repo, { label, ...options });
}

function runEmitter(repo, options = {}) {
  return run(process.execPath, ["scripts/build-server.mjs"], repo, { label: "build-server wrapper", ...options });
}

function assertNoOutputs(repo, outputs, label) {
  for (const output of outputs)
    assert(!existsSync(join(repo, "dist", output)), `${label}: retained stale dist/${output}`);
}

function contractSourceOutputs(name) {
  return [`server/${name}.js`, `server/${name}.js.map`, `server/${name}.d.ts`, `server/${name}.d.ts.map`];
}

function assertInputFingerprintInvalidation(repo) {
  const inputs = ["tsconfig.server.json", "package.json", "package-lock.json"];
  let previousState = readFileSync(buildProfilePath(repo, BUILD_STATE), "utf8");
  const originals = new Map(inputs.map(name => [name, readFileSync(join(repo, name), "utf8")]));
  try {
    for (const name of inputs) {
      append(join(repo, name), "\n");
      runEmitter(repo);
      const currentState = readFileSync(buildProfilePath(repo, BUILD_STATE), "utf8");
      assert(currentState !== previousState, `${name} change did not invalidate the build state fingerprint`);
      previousState = currentState;
    }
    writeFileSync(join(repo, "src", "server", "cache-contract-input-diagnostic.ts"), "type InputFingerprintDiagnostic = MissingInputFingerprintDiagnostic;\n");
    expectFailure(() => runEmitter(repo, { expect: "nonzero", label: "input fingerprint diagnostic" }), "MissingInputFingerprintDiagnostic");
  } finally {
    remove(join(repo, "src", "server", "cache-contract-input-diagnostic.ts"));
    for (const [name, contents] of originals) writeFileSync(join(repo, name), contents);
  }
  runEmitter(repo);
}

function assertCorruptProfileRecovery(repo) {
  for (const [name, corruption] of [[BUILD_CACHE, ""], [BUILD_CACHE, "not build info"], [BUILD_STATE, ""], [BUILD_STATE, "not JSON"]]) {
    writeFileSync(buildProfilePath(repo, name), corruption);
    // A missing emitted artifact makes recovery observable rather than allowing an
    // old output tree to mask a compiler invocation.
    remove(join(repo, "dist", "server", "cli.js"));
    runBuild(repo, `recovery from ${name || "empty"}`);
    assertBuildArtifacts(repo);
    assertBuildProfiles(repo);
  }
}

function assertMissingOrCorruptStateRetiresStaleOutputs(repo) {
  for (const [stateLabel, invalidateState] of [
    ["missing", () => remove(buildProfilePath(repo, BUILD_STATE))],
    ["corrupt", () => writeFileSync(buildProfilePath(repo, BUILD_STATE), "not JSON")],
  ]) {
    for (const mutation of ["deletion", "rename"]) {
      const oldName = `cache-contract-${stateLabel}-state-${mutation}`;
      const newName = `${oldName}-renamed`;
      const oldSource = join(repo, "src", "server", `${oldName}.ts`);
      const newSource = join(repo, "src", "server", `${newName}.ts`);
      try {
        writeFileSync(oldSource, `export const ${oldName.replaceAll("-", "_")} = true;\n`);
        runBuild(repo, `warm state before ${stateLabel} state ${mutation}`);
        for (const output of contractSourceOutputs(oldName))
          assert(existsSync(join(repo, "dist", output)), `${stateLabel} state ${mutation}: warm build omitted ${output}`);

        if (mutation === "deletion") remove(oldSource);
        else renameSync(oldSource, newSource);
        invalidateState();
        runBuild(repo, `recover ${stateLabel} state after source ${mutation}`);

        assertNoOutputs(repo, contractSourceOutputs(oldName), `${stateLabel} state source ${mutation}`);
        if (mutation === "rename") {
          for (const output of contractSourceOutputs(newName))
            assert(existsSync(join(repo, "dist", output)), `${stateLabel} state rename omitted ${output}`);
        }
        assertBuildProfiles(repo);
      } finally {
        remove(oldSource);
        remove(newSource);
      }
      runBuild(repo, `cleanup ${stateLabel} state ${mutation}`);
      assertNoOutputs(repo, [...contractSourceOutputs(oldName), ...contractSourceOutputs(newName)], `${stateLabel} state ${mutation} cleanup`);
    }
  }
}

// Canonicalize only the existing parent so the linked final entry remains the
// path being asserted. This bridges macOS's /var → /private/var alias without
// resolving the symlink/junction fixture into its external target.
function canonicalLinkedPath(linkedPath) {
  return join(realpathSync(dirname(linkedPath)), basename(linkedPath));
}

function assertLinkedOutputTreeIsRejectedBeforeEmit(repo) {
  for (const { label, linkedPath, sentinelPath, target, linkType } of [
    {
      label: "dist symlink or junction",
      linkedPath: join(repo, "dist"),
      sentinelPath: "server/cli.js",
      target: external => external,
      linkType: process.platform === "win32" ? "junction" : "dir",
    },
    {
      label: "expected-output parent symlink or junction",
      linkedPath: join(repo, "dist", "server"),
      sentinelPath: "cli.js",
      target: external => external,
      linkType: process.platform === "win32" ? "junction" : "dir",
    },
    {
      label: "expected-output leaf symlink",
      linkedPath: join(repo, "dist", "server", "cli.js"),
      sentinelPath: "cli.js",
      target: (_external, sentinel) => sentinel,
      linkType: "file",
    },
  ]) {
    const external = join(dirname(repo), `cache-contract-external-emit-${label.replaceAll(/[^a-z]+/gi, "-")}`);
    const sentinel = join(external, ...sentinelPath.split("/"));
    const sentinelBytes = Buffer.from(`external ${label} sentinel must not be overwritten\n`);
    remove(external);
    mkdirSync(dirname(sentinel), { recursive: true });
    writeFileSync(sentinel, sentinelBytes);
    const before = treeManifest(external);
    try {
      // Replacing an actual output tree entry is safe only in this disposable
      // archive. The reparse point below must be rejected before tsc can write.
      remove(linkedPath);
      symlinkSync(target(external, sentinel), linkedPath, linkType);
      const linkStat = lstatSync(linkedPath);
      assert(linkStat.isSymbolicLink() || (process.platform === "win32" && linkType === "junction" && linkStat.isDirectory()), `${label}: failed to create reparse-point fixture`);

      const result = runEmitter(repo, { expect: "nonzero", label: `${label} pre-emit rejection` });
      assert(result.status !== 0, `${label}: wrapper unexpectedly permitted TypeScript emission`);
      const canonicalLinkedPathname = canonicalLinkedPath(linkedPath);
      assert(result.output.includes(`${LINKED_OUTPUT_DIAGNOSTIC}: ${canonicalLinkedPathname}`), `${label}: expected linked-output diagnostic for ${canonicalLinkedPathname} was absent:\n${result.output}`);
      assert(readFileSync(sentinel).equals(sentinelBytes), `${label}: TypeScript overwrote the external sentinel`);
      assert(JSON.stringify(treeManifest(external)) === JSON.stringify(before), `${label}: TypeScript created or changed external outputs`);
    } finally {
      // `rm -rf` follows Windows junctions on some platforms; unlink only the
      // reparse point and then remove the known external fixture separately.
      try { unlinkReparsePoint(linkedPath); }
      catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      remove(external);
    }
    runBuild(repo, `recover after ${label}`);
    assertBuildArtifacts(repo);
  }
}

function assertMissingOrCorruptStateRetiresEmptyIncludeRoot(repo) {
  const rootName = "cache-contract-isolated-root";
  const sourceRoot = join(repo, "src", rootName);
  const source = join(sourceRoot, "last-source.ts");
  const outputs = [
    `${rootName}/last-source.js`,
    `${rootName}/last-source.js.map`,
    `${rootName}/last-source.d.ts`,
    `${rootName}/last-source.d.ts.map`,
  ];
  const configPath = join(repo, "tsconfig.server.json");
  const originalConfig = readFileSync(configPath, "utf8");
  try {
    const config = JSON.parse(originalConfig);
    config.include = [...config.include, `src/${rootName}/**/*.ts`];
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    for (const [stateLabel, invalidateState] of [
      ["missing", () => remove(buildProfilePath(repo, BUILD_STATE))],
      ["corrupt", () => writeFileSync(buildProfilePath(repo, BUILD_STATE), "not JSON")],
    ]) {
      mkdirSync(sourceRoot, { recursive: true });
      writeFileSync(source, "export const isolatedRootLastSource = true;\n");
      runBuild(repo, `warm isolated include root before ${stateLabel} state`);
      for (const output of outputs)
        assert(existsSync(join(repo, "dist", output)), `${stateLabel} isolated include root: warm build omitted dist/${output}`);

      remove(source);
      invalidateState();
      runBuild(repo, `recover ${stateLabel} state after emptying isolated include root`);
      assertNoOutputs(repo, outputs, `${stateLabel} state empty isolated include root`);
      assertBuildProfiles(repo);
    }
  } finally {
    remove(sourceRoot);
    writeFileSync(configPath, originalConfig);
  }
  runBuild(repo, "cleanup after empty isolated include root");
  assertNoOutputs(repo, outputs, "empty isolated include root cleanup");
}

function assertPoisonedStateCannotEscapeDist(repo) {
  const external = join(dirname(repo), "cache-contract-external-sentinel");
  const linkedParent = join(repo, "dist", "cache-contract-state-escape");
  const sentinel = join(external, "stale-output.js");
  const sentinelBytes = Buffer.from("cache-contract external sentinel must survive\n");
  const poisonedOutput = relative(repo, join(linkedParent, "stale-output.js"));

  remove(external);
  mkdirSync(external, { recursive: true });
  writeFileSync(sentinel, sentinelBytes);
  try {
    // The sidecar path is lexically within dist, but its existing parent is a
    // symlink (or junction) to a location outside the isolated repository.
    symlinkSync(external, linkedParent, process.platform === "win32" ? "junction" : "dir");
    const linkStat = lstatSync(linkedParent);
    assert(linkStat.isSymbolicLink() || (process.platform === "win32" && linkStat.isDirectory()), "failed to create the dist reparse-point fixture");

    // Preserve every required sidecar field and a matching buildinfo fingerprint
    // so this is structurally valid poisoned state, not malformed-state recovery.
    const state = JSON.parse(readFileSync(buildProfilePath(repo, BUILD_STATE), "utf8"));
    assert(Array.isArray(state.outputs), "successful build state lacks an outputs array");
    assert(!state.outputs.includes(poisonedOutput), "poisoned output unexpectedly overlaps normal state");
    state.outputs.push(poisonedOutput);
    writeFileSync(buildProfilePath(repo, BUILD_STATE), `${JSON.stringify(state, null, 2)}\n`);

    runEmitter(repo, { label: "poisoned symlink state recovery" });
    assert(readFileSync(sentinel).equals(sentinelBytes), "poisoned state deletion escaped dist through a reparse point");
    assertBuildArtifacts(repo);
    assertBuildProfiles(repo);
    const recovered = JSON.parse(readFileSync(buildProfilePath(repo, BUILD_STATE), "utf8"));
    assert(!recovered.outputs.includes(poisonedOutput), "unsafe state was retained instead of cold-recovering");
  } finally {
    // Never recursively remove a link/junction: its target is deliberately
    // outside the fixture and contains the sentinel asserted above.
    try { unlinkReparsePoint(linkedParent); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    remove(external);
  }
}

function assertMutationRecovery(repo) {
  const added = "cache-contract-added";
  const renamed = "cache-contract-renamed";
  const addedPath = join(repo, "src", "server", `${added}.ts`);
  const renamedPath = join(repo, "src", "server", `${renamed}.ts`);
  try {
    writeFileSync(addedPath, "export const cacheContractAdded = 'added';\n");
    runBuild(repo, "build with added source");
    for (const output of contractSourceOutputs(added)) assert(existsSync(join(repo, "dist", output)), `new source omitted dist/${output}`);

    remove(addedPath);
    runBuild(repo, "build after source deletion");
    assertNoOutputs(repo, contractSourceOutputs(added), "source deletion");

    writeFileSync(addedPath, "export const cacheContractRenamed = 'rename';\n");
    runBuild(repo, "build before source rename");
    renameSync(addedPath, renamedPath);
    runBuild(repo, "build after source rename");
    assertNoOutputs(repo, contractSourceOutputs(added), "source rename");
    for (const output of contractSourceOutputs(renamed)) assert(existsSync(join(repo, "dist", output)), `renamed source omitted dist/${output}`);

    writeFileSync(join(repo, "src", "shared", "cache-contract-shared.ts"), "export interface CacheContractShared { value: string }\nexport const cacheContractShared: CacheContractShared = { value: 'ok' };\n");
    writeFileSync(join(repo, "src", "server", "cache-contract-importer.ts"), "import { cacheContractShared } from '../shared/cache-contract-shared.js';\nconst cacheContractString: string = cacheContractShared.value;\nvoid cacheContractString;\n");
    runBuild(repo, "build shared import baseline");
    writeFileSync(join(repo, "src", "shared", "cache-contract-shared.ts"), "export interface CacheContractShared { value: number }\nexport const cacheContractShared: CacheContractShared = { value: 1 };\n");
    remove(join(repo, "dist", "server", "defaults"));
    remove(join(repo, "dist", "server", "builtin-packs"));
    expectFailure(() => runBuild(repo, "changed shared import diagnostic", { expect: "nonzero" }), "cache-contract-importer.ts");
    assert(!existsSync(join(repo, "dist", "server", "defaults")), "failed compiler invocation ran copy-defaults");
    assert(!existsSync(join(repo, "dist", "server", "builtin-packs")), "failed compiler invocation ran copy-builtin-packs");
  } finally {
    remove(addedPath);
    remove(renamedPath);
    remove(join(repo, "src", "shared", "cache-contract-shared.ts"));
    remove(join(repo, "src", "server", "cache-contract-importer.ts"));
  }
  runBuild(repo, "build after source mutation cleanup");
  assertNoOutputs(repo, [...contractSourceOutputs(added), ...contractSourceOutputs(renamed), ...contractSourceOutputs("cache-contract-importer"), "shared/cache-contract-shared.js", "shared/cache-contract-shared.js.map", "shared/cache-contract-shared.d.ts", "shared/cache-contract-shared.d.ts.map"], "mutation cleanup");
}

function assertInterruptionRecovery(repo) {
  const stateBefore = readFileSync(buildProfilePath(repo, BUILD_STATE));
  const source = join(repo, "src", "server", "cache-contract-interrupted.ts");
  try {
    writeFileSync(source, "export const interruptedBuild = true;\n");
    const interrupted = runEmitter(repo, { expect: "nonzero", label: "post-tsc interruption", env: { [TEST_FAULT_ENV]: "1" } });
    assert(interrupted.output.includes(TEST_FAULT_ENV), `interruption fault did not identify ${TEST_FAULT_ENV}:\n${interrupted.output}`);
    assert(readFileSync(buildProfilePath(repo, BUILD_STATE)).equals(stateBefore), "interrupted build published a successful state sidecar");
    runBuild(repo, "recovery after post-tsc interruption");
    assertBuildProfiles(repo);
    for (const output of contractSourceOutputs("cache-contract-interrupted")) assert(existsSync(join(repo, "dist", output)), `interruption recovery omitted ${output}`);
  } finally {
    remove(source);
  }
  runBuild(repo, "cleanup after interruption recovery");
  assertNoOutputs(repo, contractSourceOutputs("cache-contract-interrupted"), "interruption cleanup");
}

function runRepositoryFidelity(repo) {
  assertStaticContract(repo);
  // The tests2 graph intentionally resolves generated server declarations.
  runBuild(repo, "repository prerequisite build:server");
  remove(join(repo, ".profiles"));
  runNpm(["run", "check"], repo, { label: "repository cold check" });
  for (const cache of CACHE_NAMES) assert(statSync(join(repo, ".profiles", cache)).size > 0, `repository check missed ${cache}`);
  // Keep this initial snapshot to prove the cold check has populated all three
  // identities before the independent build flow is exercised.
  const checkBeforeBuild = snapshot(profilePaths(repo));
  assert(checkBeforeBuild.size === CACHE_NAMES.length, "cold check did not produce all independent cache identities");

  // Legacy and cached flows must publish precisely the same shipped dist tree.
  remove(join(repo, "dist"));
  remove(join(repo, ".profiles"));
  runLegacyBuild(repo);
  const legacyManifest = distManifest(repo);
  const legacyCliMode = statSync(join(repo, "dist", "server", "cli.js")).mode & 0o111;
  remove(join(repo, "dist"));
  remove(join(repo, ".profiles"));
  runBuild(repo, "cold cached build");
  assertBuildArtifacts(repo);
  assertBuildProfiles(repo);
  assert(JSON.stringify(distManifest(repo)) === JSON.stringify(legacyManifest), "cached build changed the legacy dist path/byte/mode manifest");
  assert((statSync(join(repo, "dist", "server", "cli.js")).mode & 0o111) === legacyCliMode, "cached build changed CLI executable mode");
  runBuild(repo, "warm cached build");
  assertBuildArtifacts(repo);

  remove(join(repo, "dist"));
  runBuild(repo, "warm build after dist deletion");
  assertBuildArtifacts(repo);

  assertMutationRecovery(repo);
  assertInputFingerprintInvalidation(repo);
  assertCorruptProfileRecovery(repo);
  assertMissingOrCorruptStateRetiresStaleOutputs(repo);
  assertMissingOrCorruptStateRetiresEmptyIncludeRoot(repo);
  assertLinkedOutputTreeIsRejectedBeforeEmit(repo);
  assertPoisonedStateCannotEscapeDist(repo);
  assertInterruptionRecovery(repo);

  // Check and build caches remain byte-for-byte independent when interleaved.
  remove(join(repo, ".profiles"));
  runNpm(["run", "check"], repo, { label: "interleaving initial check" });
  const checksBefore = snapshot(profilePaths(repo));
  runBuild(repo, "build interleaved after check");
  assertSnapshotUnchanged(checksBefore, "build cache flow");
  const buildBefore = snapshot(BUILD_PROFILES.map(name => buildProfilePath(repo, name)));
  runNpm(["run", "check"], repo, { label: "check interleaved after build" });
  assertSnapshotUnchanged(buildBefore, "check cache flow");

  runNpm(["run", "clean"], repo, { label: "npm clean build profile cleanup" });
  assert(!existsSync(join(repo, "dist")), "npm clean retained dist");
  for (const name of BUILD_PROFILES) assert(!existsSync(buildProfilePath(repo, name)), `npm clean retained ${name}`);
  assertSnapshotUnchanged(checksBefore, "npm clean");
}

try {
  assert(existsSync(TYPESCRIPT), `repository-local TypeScript executable is missing: ${TYPESCRIPT}`);
  if (!fixtureOnly) assertCleanCheckout();
  root = mkdtempSync(join(tmpdir(), "bobbit-check-cache-contract-"));
  const compilerFixture = join(root, "compiler-fixture");
  runCompilerFixture(compilerFixture);
  if (!fixtureOnly) {
    // Validate the actual candidate before spending time on the copy/build seam.
    assertStaticContract(REPO_ROOT);
    const repoFixture = join(root, "repository-fixture");
    archiveHead(repoFixture);
    linkDependencies(repoFixture);
    try { runRepositoryFidelity(repoFixture); }
    finally { unlinkDependencyView(repoFixture); }
  }
  remove(root);
  root = undefined;
  console.log("[check-cache-contract] passed");
} catch (error) {
  console.error(error?.stack ?? error);
  if (root) console.error(`[check-cache-contract] retained failing fixture: ${root}`);
  process.exitCode = 1;
}
