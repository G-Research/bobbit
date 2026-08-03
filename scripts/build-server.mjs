#!/usr/bin/env node
/**
 * Incremental server emitter with a build-only cache.  `tsconfig.server.json`
 * remains the sole owner of compiler policy; this script owns only recovery and
 * lifecycle of the build-emission profile.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  return parsed;
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

function expectedOutputs(parsed) {
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
  return { outputDir, outputs };
}

function outputToStatePath(path) {
  return relative(ROOT, path);
}

function statePathToOutput(path, outputDir) {
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path)) return undefined;
  const absolute = resolve(ROOT, path);
  return outputPathIsSafe(absolute, outputDir) ? absolute : undefined;
}

// Cache state is untrusted: lexical containment is insufficient because an
// existing parent may be a POSIX symlink or Windows junction/reparse point.
// Resolving the parent immediately before use makes the actual deletion target
// stay under both repository and configured-output physical roots.
function physicalOutputParent(path, outputDir) {
  try {
    const physicalRoot = realpathSync.native(ROOT);
    const physicalOutputDir = realpathSync.native(outputDir);
    const physicalParent = realpathSync.native(dirname(path));
    if (!isInside(physicalRoot, physicalOutputDir)
      || (physicalParent !== physicalOutputDir && !isInside(physicalOutputDir, physicalParent)))
      return undefined;
    return physicalParent;
  } catch {
    return undefined;
  }
}

function outputPathIsPhysicallySafe(path, outputDir) {
  // A missing output is expected during source removal. Walk to its existing
  // parent so a newly planted linked ancestor cannot be treated as recoverable.
  let parent = dirname(path);
  while (true) {
    if (physicalOutputParent(join(parent, basename(path)), outputDir) !== undefined) return true;
    if (existsSync(parent)) return false;
    const next = dirname(parent);
    if (next === parent) return false;
    parent = next;
  }
}

function readBuildInfoFingerprint() {
  try {
    if (!existsSync(BUILD_INFO) || statSync(BUILD_INFO).size === 0) return undefined;
    const bytes = readFileSync(BUILD_INFO);
    const value = JSON.parse(bytes.toString("utf8"));
    if (value === null || typeof value !== "object") return undefined;
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    return undefined;
  }
}

function readState(outputDir) {
  try {
    if (!existsSync(STATE_PATH) || statSync(STATE_PATH).size === 0) return { recoverable: false, valid: false, outputs: [] };
    const state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    if (state === null || typeof state !== "object" || state.schemaVersion !== STATE_SCHEMA_VERSION || !Array.isArray(state.outputs))
      return { recoverable: false, valid: false, outputs: [] };
    const outputs = state.outputs.map(path => statePathToOutput(path, outputDir));
    if (outputs.some(path => path === undefined)
      || new Set(outputs).size !== outputs.length
      || outputs.some(path => !outputPathIsPhysicallySafe(path, outputDir)))
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
    if (!existsSync(output)) return false;
  }
  return true;
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
  const parsed = readCompilerConfig();
  const { outputDir, outputs: currentOutputs } = expectedOutputs(parsed);
  const fingerprint = fingerprintInputs();
  const previous = readState(outputDir);
  const buildInfoFingerprint = readBuildInfoFingerprint();
  const cacheIsUsable = buildInfoFingerprint !== undefined
    && previous.valid
    && previous.fingerprint === fingerprint
    && previous.buildInfoFingerprint === buildInfoFingerprint
    && outputsExist(currentOutputs)
    && [...currentOutputs].every(output => outputPathIsPhysicallySafe(output, outputDir))
    && outputsExist(previous.outputs);

  mkdirSync(PROFILE_DIR, { recursive: true });
  if (!cacheIsUsable) clearBuildInfo();

  const result = await runCompiler();
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  if (result.code !== 0) {
    process.exitCode = result.code ?? 1;
    return;
  }

  if (!outputsExist(currentOutputs)) {
    outputError("compiler succeeded without all expected artifacts; profile will cold-recover on the next build");
    process.exitCode = 1;
    return;
  }

  if (![...currentOutputs].every(output => outputPathIsPhysicallySafe(output, outputDir))) {
    clearBuildInfo();
    outputError("compiler output is outside the physical dist tree; profile will cold-recover on the next build");
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
    if (currentOutputs.has(output) || outputIsCopiedTree(output, outputDir) || !existsSync(output)) continue;
    const physicalParent = physicalOutputParent(output, outputDir);
    if (physicalParent === undefined) {
      clearBuildInfo();
      outputError("refusing to remove a stale output outside the physical dist tree; profile will cold-recover on the next build");
      process.exitCode = 1;
      return;
    }
    rmSync(join(physicalParent, basename(output)), { force: true });
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
  outputError(error?.stack ?? String(error));
  process.exitCode = 1;
});
