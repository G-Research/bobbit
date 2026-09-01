#!/usr/bin/env node
/**
 * Real compiler contract for the persistent `npm run check` caches.
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
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const TYPESCRIPT = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const CACHE_NAMES = ["check-server.tsbuildinfo", "check-web.tsbuildinfo", "check-tests.tsbuildinfo"];
const EXPECTED_CHECK = "npm run test:layout && shx mkdir -p .profiles && tsc -p tsconfig.server.json --noEmit --incremental --tsBuildInfoFile .profiles/check-server.tsbuildinfo && tsc -p tsconfig.web.json --noEmit --incremental --tsBuildInfoFile .profiles/check-web.tsbuildinfo && tsc -p tsconfig.tests.json --noEmit --incremental --tsBuildInfoFile .profiles/check-tests.tsbuildinfo";
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

function run(command, args, cwd, { expect = 0, label = command } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1" },
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
  for (const name of ["server", "web", "tests"]) checkOne(fixture, name);
}

/** Run the same left-to-right chain but return its first failure for assertions. */
function checkAllResult(fixture) {
  for (const name of ["server", "web", "tests"]) {
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
  write(fixture, "tests/index.ts", "import { shared, type SharedValue } from '../shared/value.js';\nconst testsValue: SharedValue = { label: 'ok' };\nvoid shared; void testsValue;\n");
  write(fixture, "tests/config-marker.ts", "const configMarker: string = null;\nvoid configMarker;\n");
  const config = (module, include, strict = true) => JSON.stringify({ compilerOptions: { target: "ES2022", module, moduleResolution: module === "Node16" ? "Node16" : "bundler", strict, skipLibCheck: true, noEmit: true }, include }, null, 2) + "\n";
  write(fixture, "tsconfig.server.json", config("Node16", ["server/**/*.ts", "shared/**/*.ts"]));
  write(fixture, "tsconfig.web.json", config("ES2022", ["web/**/*.ts", "shared/**/*.ts"]));
  // Start non-strict so changing this config makes config-marker newly invalid.
  write(fixture, "tsconfig.tests.json", config("ES2022", ["tests/**/*.ts", "shared/**/*.ts"], false));
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

  // A server failure must prevent web/tests checks from running, exactly as && does.
  append(join(fixture, "server/index.ts"), "\ntype serverChainMarker = { readonly marker: 'server' }; const serverChainValue: serverChainMarker = 1;\n");
  append(join(fixture, "web/index.ts"), "\ntype webShouldNotRunMarker = { readonly marker: 'web' }; const webShouldNotRunValue: webShouldNotRunMarker = 1;\n");
  const stopped = checkAllResult(fixture);
  assert(stopped.output.includes("serverChainMarker"), `server fail-fast marker absent:\n${stopped.output}`);
  assert(!stopped.output.includes("webShouldNotRunMarker"), "server failure did not stop before web check");

  for (const [name, marker] of [["server", "serverWarmMarker"], ["web", "webWarmMarker"], ["tests", "testsWarmMarker"]]) {
    warmFixture(fixture);
    const dir = name === "tests" ? "tests" : name;
    append(join(fixture, dir, "index.ts"), `\ntype ${marker} = { readonly marker: '${marker}' }; const ${marker}Value: ${marker} = 1;\n`);
    expectFailure(() => run(process.execPath, checkArgs(`tsconfig.${name}.json`, `check-${name}.tsbuildinfo`), fixture, { expect: "nonzero", label: `${name} post-warm error` }), marker);
  }

  // A cache must not freeze the include glob: newly added sources are checked too.
  for (const name of ["server", "web", "tests"]) {
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
  for (const name of ["server", "web", "tests"]) {
    expectFailure(() => run(process.execPath, checkArgs(`tsconfig.${name}.json`, `check-${name}.tsbuildinfo`), fixture, { expect: "nonzero", label: `${name} shared type check` }), `${name === "tests" ? "tests" : name}/index.ts`);
  }

  warmFixture(fixture);
  const testsConfig = JSON.parse(readFileSync(join(fixture, "tsconfig.tests.json"), "utf8"));
  testsConfig.compilerOptions.strict = true;
  writeFileSync(join(fixture, "tsconfig.tests.json"), `${JSON.stringify(testsConfig, null, 2)}\n`);
  expectFailure(() => run(process.execPath, checkArgs("tsconfig.tests.json", "check-tests.tsbuildinfo"), fixture, { expect: "nonzero", label: "config change check" }), "config-marker.ts");

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
  const build = pkg.scripts?.["build:server"] ?? "";
  assert(!/(?:\.profiles|check-(?:server|web|tests)\.tsbuildinfo|--incremental|--tsBuildInfoFile)/.test(build), "build:server must not consume check caches or incremental settings");
  const serverConfig = readFileSync(join(repo, "tsconfig.server.json"), "utf8");
  assert(!/(?:incremental|tsBuildInfoFile|check-(?:server|web|tests)\.tsbuildinfo)/.test(serverConfig), "canonical tsconfig.server.json must not own check cache settings");
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

function runRepositoryFidelity(repo) {
  assertStaticContract(repo);
  // The tests graph intentionally resolves generated server declarations.
  runNpm(["run", "build:server"], repo, { label: "repository prerequisite build:server" });
  remove(join(repo, ".profiles"));
  runNpm(["run", "check"], repo, { label: "repository cold check" });
  for (const cache of CACHE_NAMES) assert(statSync(join(repo, ".profiles", cache)).size > 0, `repository check missed ${cache}`);
  runNpm(["run", "check"], repo, { label: "repository warm check" });
  runNpm(["run", "build:server"], repo, { label: "repository build after warm check" });
  assertBuildArtifacts(repo);
  remove(join(repo, "dist"));
  runNpm(["run", "build:server"], repo, { label: "repository rebuild after dist deletion" });
  assertBuildArtifacts(repo);
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
