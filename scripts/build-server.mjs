#!/usr/bin/env node
/**
 * Incremental server emitter with a build-only cache.  `tsconfig.server.json`
 * remains the sole owner of compiler policy; this script owns only recovery and
 * lifecycle of the build-emission profile.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_DIR = join(ROOT, ".profiles");
const BUILD_INFO = join(ROOT, ".profiles/build-server.tsbuildinfo");
const STATE_PATH = join(ROOT, ".profiles/build-server-state.json");
const CONFIG_PATH = join(ROOT, "tsconfig.server.json");
const STATE_SCHEMA_VERSION = 1;
const TEST_FAULT_ENV = "BOBBIT_BUILD_SERVER_TEST_FAULT_AFTER_TSC";
const require = createRequire(import.meta.url);
const ts = require(join(ROOT, "node_modules", "typescript", "lib", "typescript.js"));

function outputError(message) {
  process.stderr.write(`build-server: ${message}\n`);
}

function formatDiagnostics(diagnostics) {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: fileName => fileName,
    getCurrentDirectory: () => ROOT,
    getNewLine: () => "\n",
  });
}

function readCompilerConfig() {
  const config = ts.readConfigFile(CONFIG_PATH, ts.sys.readFile);
  if (config.error) throw new Error(formatDiagnostics([config.error]));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT, undefined, CONFIG_PATH);
  if (parsed.errors.length) throw new Error(formatDiagnostics(parsed.errors));
  return { parsed, configuredIncludes: config.config.include };
}

function fingerprintInputs() {
  const hash = createHash("sha256");
  for (const name of ["tsconfig.server.json", "package.json", "package-lock.json"]) {
    const bytes = readFileSync(join(ROOT, name));
    hash.update(name);
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function isInside(parent, path) {
  const pathRelative = relative(parent, path);
  return pathRelative !== "" && !pathRelative.startsWith(`..${sep}`) && pathRelative !== ".." && !isAbsolute(pathRelative);
}

function outputPathIsSafe(path, outputDir) {
  return isInside(ROOT, path) && isInside(outputDir, path);
}

function outputIsCopiedTree(path, outputDir) {
  const parts = relative(outputDir, path).split(sep);
  return parts[0] === "server" && (parts[1] === "defaults" || parts[1] === "builtin-packs");
}

function configuredOutputRoots(parsed, configuredIncludes, outputDir) {
  const sourceRoot = resolve(parsed.options.rootDir ?? ROOT);
  const roots = new Set();
  for (const include of configuredIncludes ?? []) {
    if (typeof include !== "string") continue;
    const wildcardAt = include.search(/[?*[]/);
    // A glob's fixed prefix is the configured source root. For a single
    // explicitly named source, its parent is the root that can retain output
    // when that source is later deleted.
    const sourceDirectory = resolve(ROOT, wildcardAt === -1 ? dirname(include) : include.slice(0, wildcardAt) || ".");
    const sourceRelative = relative(sourceRoot, sourceDirectory);
    if (sourceRelative.startsWith(`..${sep}`) || sourceRelative === ".." || isAbsolute(sourceRelative)) continue;
    const outputRoot = sourceRelative === "" ? outputDir : resolve(outputDir, sourceRelative);
    if (outputRoot === outputDir || outputPathIsSafe(outputRoot, outputDir)) roots.add(outputRoot);
  }
  // Configs without explicit include entries still need a manifest-free
  // recovery root. The canonical server config has stable include roots above.
  if (roots.size === 0) roots.add(outputDir);
  return roots;
}

function expectedOutputs(parsed, configuredIncludes) {
  const outputDir = resolve(parsed.options.outDir ?? join(ROOT, "dist"));
  const outputs = new Set();
  for (const fileName of parsed.fileNames) {
    // Declaration input files do not themselves create JavaScript/declaration
    // artifacts. The parsed config, rather than a duplicate glob, owns this list.
    if (fileName.endsWith(".d.ts")) continue;
    for (const output of ts.getOutputFileNames(parsed, fileName, false)) {
      const absolute = resolve(ROOT, output);
      if (!outputPathIsSafe(absolute, outputDir))
        throw new Error(`compiler output is outside the configured outDir: ${absolute}`);
      outputs.add(absolute);
    }
  }
  return { outputDir, outputs, resetRoots: configuredOutputRoots(parsed, configuredIncludes, outputDir) };
}

function outputToStatePath(path) {
  return relative(ROOT, path);
}

function statePathToOutput(path, outputDir) {
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path)) return undefined;
  const absolute = resolve(ROOT, path);
  return outputPathIsSafe(absolute, outputDir) ? absolute : undefined;
}

function lstatOrUndefined(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

// `readlinkSync` identifies POSIX links and Windows junctions directly. It is
// deliberately used with lstat: output paths are untrusted until every existing
// component has been proved to be an ordinary directory or file.
function isReparsePoint(path, stat) {
  if (stat.isSymbolicLink()) return true;
  try {
    readlinkSync(path);
    return true;
  } catch (error) {
    if (error?.code === "EINVAL" || error?.code === "UNKNOWN") return false;
    throw error;
  }
}

function assertOutputPathHasNoReparsePoint(path, outputDir) {
  if (!outputPathIsSafe(path, outputDir))
    throw new Error(`output is outside the configured outDir: ${path}`);

  let current = outputDir;
  const components = relative(outputDir, path).split(sep);
  for (let index = -1; index < components.length; index += 1) {
    if (index >= 0) current = join(current, components[index]);
    const stat = lstatOrUndefined(current);
    if (stat === undefined) return;
    if (isReparsePoint(current, stat))
      throw new Error(`refusing linked output-tree path before compiler invocation: ${current}`);
    if (index < components.length - 1 && !stat.isDirectory())
      throw new Error(`output parent is not a directory: ${current}`);
  }
}

function outputPathHasNoReparsePoint(path, outputDir) {
  try {
    assertOutputPathHasNoReparsePoint(path, outputDir);
    return true;
  } catch {
    return false;
  }
}

function assertOutputTreeHasNoReparsePoints(outputDir, outputs) {
  // Check the root even when there are no source outputs, then inspect every
  // expected output (including an existing output file) before tsc can write.
  assertOutputPathHasNoReparsePoint(join(outputDir, ".build-server-probe"), outputDir);
  for (const output of outputs) assertOutputPathHasNoReparsePoint(output, outputDir);
}

function readBuildInfoFingerprint() {
  try {
    // Read once: an existence/size probe followed by a second read has a
    // check/use race and accepts an attacker-swapped profile.
    const bytes = readFileSync(BUILD_INFO);
    if (bytes.length === 0) return undefined;
    const value = JSON.parse(bytes.toString("utf8"));
    if (value === null || typeof value !== "object") return undefined;
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    return undefined;
  }
}

function readState(outputDir) {
  try {
    // As above, parse the one buffer we read rather than existence/stat probes.
    const bytes = readFileSync(STATE_PATH);
    if (bytes.length === 0) return { recoverable: false, valid: false, outputs: [] };
    const state = JSON.parse(bytes.toString("utf8"));
    if (state === null || typeof state !== "object" || state.schemaVersion !== STATE_SCHEMA_VERSION || !Array.isArray(state.outputs))
      return { recoverable: false, valid: false, outputs: [] };
    const outputs = state.outputs.map(path => statePathToOutput(path, outputDir));
    if (outputs.some(path => path === undefined)
      || new Set(outputs).size !== outputs.length
      || outputs.some(path => !outputPathHasNoReparsePoint(path, outputDir)))
      return { recoverable: false, valid: false, outputs: [] };
    return {
      recoverable: true,
      valid: state.complete === true
        && typeof state.inputFingerprint === "string"
        && typeof state.buildInfoFingerprint === "string",
      fingerprint: state.inputFingerprint,
      buildInfoFingerprint: state.buildInfoFingerprint,
      outputs,
    };
  } catch {
    return { recoverable: false, valid: false, outputs: [] };
  }
}

function outputsExist(outputs) {
  for (const output of outputs) {
    if (lstatOrUndefined(output) === undefined) return false;
  }
  return true;
}

function removeReparsePoint(path) {
  // Re-lstat immediately before removal: a link can be swapped after a caller
  // inspected it. Never recursively remove a replacement directory or file.
  const stat = lstatOrUndefined(path);
  if (stat === undefined || !isReparsePoint(path, stat)) return;
  // Windows reports junctions as directories, but rmdir removes the junction
  // itself rather than traversing its target.
  if (process.platform === "win32" && stat.isDirectory()) rmdirSync(path);
  else unlinkSync(path);
}

function isEmissionArtifact(path) {
  return /\.(?:js|js\.map|d\.ts|d\.ts\.map)$/.test(path);
}

function resetEmittedOutputTree(path, outputDir, currentOutputs) {
  const stat = lstatOrUndefined(path);
  if (stat === undefined) return;
  if (isReparsePoint(path, stat)) {
    removeReparsePoint(path);
    return;
  }
  if (!stat.isDirectory()) {
    // Current outputs are overwritten by the forced cold emit. Keeping them
    // retains their mode until tsc opens the same file (notably cli.js before
    // the package command's chmod tail), while unknown old artifacts vanish.
    if (!currentOutputs.has(path) && isEmissionArtifact(path)) unlinkSync(path);
    return;
  }
  // The package command owns these copied trees after this wrapper finishes.
  // Do not disturb them during cache recovery, including when run directly.
  if (outputIsCopiedTree(path, outputDir)) return;
  for (const entry of readdirSync(path)) resetEmittedOutputTree(join(path, entry), outputDir, currentOutputs);
}

function resetOutputTree(outputDir, outputs, resetRoots) {
  const stat = lstatOrUndefined(outputDir);
  if (stat === undefined) return;
  if (isReparsePoint(outputDir, stat) || !stat.isDirectory())
    throw new Error(`refusing to reset a non-directory or linked output root: ${outputDir}`);

  // A malformed sidecar cannot name sources that were completely removed. Use
  // the stable configured include roots, not only the present output manifest,
  // so stale TypeScript artifacts under an emptied source root are retired.
  for (const root of resetRoots) resetEmittedOutputTree(root, outputDir, outputs);
}

function writeStateAtomically(state) {
  mkdirSync(PROFILE_DIR, { recursive: true });
  const temporary = join(PROFILE_DIR, `.build-server-state-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(temporary, STATE_PATH);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function clearBuildInfo() {
  rmSync(BUILD_INFO, { force: true });
}

function runCompiler() {
  const compiler = join(ROOT, "node_modules", "typescript", "bin", "tsc");
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [compiler, "-p", "tsconfig.server.json", "--incremental", "--tsBuildInfoFile", ".profiles/build-server.tsbuildinfo"], {
      cwd: ROOT,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveResult({ code, signal }));
  });
}

async function main() {
  const { parsed, configuredIncludes } = readCompilerConfig();
  const { outputDir, outputs: currentOutputs, resetRoots } = expectedOutputs(parsed, configuredIncludes);
  // This must precede cache writes and tsc: TypeScript would otherwise follow
  // a linked dist root or an expected-output parent while creating artifacts.
  assertOutputTreeHasNoReparsePoints(outputDir, currentOutputs);

  const fingerprint = fingerprintInputs();
  const previous = readState(outputDir);
  const buildInfoFingerprint = readBuildInfoFingerprint();
  const cacheIsUsable = buildInfoFingerprint !== undefined
    && previous.valid
    && previous.fingerprint === fingerprint
    && previous.buildInfoFingerprint === buildInfoFingerprint
    && outputsExist(currentOutputs)
    && outputsExist(previous.outputs);

  mkdirSync(PROFILE_DIR, { recursive: true });
  if (!cacheIsUsable) {
    clearBuildInfo();
    // An incomplete but structurally valid sidecar has an output inventory, so
    // retain it for stale-output reconciliation after the cold emit. With no
    // trustworthy inventory, quarantine the old tree before tsc; otherwise a
    // deleted or renamed source can leave artifacts the compiler no longer sees.
    if (!previous.recoverable) resetOutputTree(outputDir, currentOutputs, resetRoots);
  }

  const result = await runCompiler();
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  if (result.code !== 0) {
    process.exitCode = result.code ?? 1;
    return;
  }

  try {
    assertOutputTreeHasNoReparsePoints(outputDir, currentOutputs);
  } catch (error) {
    clearBuildInfo();
    outputError(`${error?.message ?? String(error)}; profile will cold-recover on the next build`);
    process.exitCode = 1;
    return;
  }
  if (!outputsExist(currentOutputs)) {
    outputError("compiler succeeded without all expected artifacts; profile will cold-recover on the next build");
    process.exitCode = 1;
    return;
  }

  const emittedBuildInfoFingerprint = readBuildInfoFingerprint();
  if (emittedBuildInfoFingerprint === undefined) {
    outputError("compiler succeeded without a valid build profile; profile will cold-recover on the next build");
    process.exitCode = 1;
    return;
  }

  // Narrow, opt-in fault injection for the cache contract's interruption case.
  // The successful sidecar remains byte-for-byte untouched, while clearing the
  // buildinfo makes the following ordinary build cold-recover safely.
  if (process.env[TEST_FAULT_ENV] === "1") {
    clearBuildInfo();
    outputError(`${TEST_FAULT_ENV}: simulated interruption after tsc`);
    process.exitCode = 75;
    return;
  }

  for (const output of previous.outputs) {
    if (currentOutputs.has(output) || outputIsCopiedTree(output, outputDir) || lstatOrUndefined(output) === undefined) continue;
    try {
      assertOutputPathHasNoReparsePoint(output, outputDir);
    } catch (error) {
      clearBuildInfo();
      outputError(`${error?.message ?? String(error)}; profile will cold-recover on the next build`);
      process.exitCode = 1;
      return;
    }
    rmSync(output, { force: true });
  }

  writeStateAtomically({
    schemaVersion: STATE_SCHEMA_VERSION,
    complete: true,
    inputFingerprint: fingerprint,
    buildInfoFingerprint: emittedBuildInfoFingerprint,
    outputs: [...currentOutputs].sort().map(outputToStatePath),
  });
}

main().catch(error => {
  outputError(error?.message ?? String(error));
  process.exitCode = 1;
});
