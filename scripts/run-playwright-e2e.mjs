#!/usr/bin/env node
/**
 * Launch the root Playwright E2E suite with runtime cache isolation in place
 * before Playwright's CLI imports its transform/cache modules.
 *
 * Playwright's default Windows transform cache lives at
 * `%TEMP%/playwright-transform-cache` and assumes a single runner invocation.
 * Bobbit agents commonly run overlapping E2E commands from multiple worktrees,
 * so use a fresh run-scoped cache root and a preload that gives the runner and
 * each Playwright worker its own process-local cache directory.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  deleteEnvironmentValue,
  environmentValue,
  GIT_ISOLATION_ENV,
  isAmbientBobbitRuntimeEnvKey,
  isAmbientTestEnvironmentKey,
  isCredentialEnvKey,
  sanitizeTestEnvironment,
  setEnvironmentValue,
} from "./testing-v2/environment-policy.mjs";
import { removeOwnedPath } from "./testing-v2/owned-path-cleanup.mjs";
import {
  PACKED_CONSUMER_DESCRIPTOR_ENV,
  preparePackedConsumerFixture,
} from "./testing-v2/prewarm-packed-consumer-cache.mjs";

export {
  isAmbientBobbitRuntimeEnvKey as isE2EAmbientRuntimeEnvKey,
  isCredentialEnvKey as isE2ECredentialEnvKey,
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const cacheBootstrap = resolve(__dirname, "playwright-e2e-cache-bootstrap.cjs");
const LEDGER_DIRNAME = "bobbit-test-v2-ledger";
const PLAYWRIGHT_CLI = join(projectRoot, "node_modules", "playwright", "cli.js");
const PACKAGED_CONSUMER_SPEC = "tests/e2e/browser/packaged-inline-html-theme.browser-e2e.spec.ts";
const PACKAGED_CONSUMER_PROJECT = "browser-canonical";
const PLAYWRIGHT_OPTIONS_WITH_VALUES = new Set([
  "--browser",
  "-c", "--config",
  "--debug",
  "--global-timeout",
  "-g", "--grep",
  "--grep-invert",
  "-j", "--workers",
  "--max-failures",
  "--only-changed",
  "--output",
  "--project",
  "--repeat-each",
  "--reporter",
  "--retries",
  "--run-agents",
  "--shard",
  "--test-list",
  "--test-list-invert",
  "--timeout",
  "--trace",
  "--tsconfig",
  "--ui-host",
  "--ui-port",
  "-u", "--update-snapshots",
  "--update-source-method",
]);

/** Build a shell-free local Playwright invocation or fail before spawning. */
export function createPlaywrightE2EInvocation(forwardedArgs = [], {
  playwrightCli = PLAYWRIGHT_CLI,
  exists = existsSync,
  execPath = process.execPath,
} = {}) {
  if (!exists(playwrightCli)) {
    throw new Error(`[e2e] Playwright CLI is unavailable at ${playwrightCli}. Install local dependencies with npm ci.`);
  }
  return Object.freeze({
    command: execPath,
    args: Object.freeze([playwrightCli, "test", "--config", "playwright-e2e.config.ts", ...forwardedArgs]),
    shell: false,
  });
}

function canonicalDirectory(directory) {
  mkdirSync(directory, { recursive: true });
  try { return realpathSync(directory); } catch { return resolve(directory); }
}

/**
 * Pick a coordinator base that cannot be removed by an inherited test-run
 * owner. Nested legacy invocations intentionally keep using `tmpdir()`; only
 * top-level browser/E2E coordinators call this escape hatch.
 */
export function coordinatorTempDirectory(tempDirectory = tmpdir(), inheritedEnv = process.env) {
	const base = canonicalDirectory(tempDirectory);
	const inheritedRoot = environmentValue(inheritedEnv, "BOBBIT_V2_RUN_ROOT");
	if (!inheritedRoot) return base;
	try {
		const root = canonicalDirectory(inheritedRoot);
		const rel = relative(root, base);
		const isWithinRoot = rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
		return isWithinRoot ? dirname(root) : base;
	} catch {
		return base;
	}
}

/** Allocate the one canonical root owned by this legacy E2E coordinator. */
export function createE2ERunPaths(tempDirectory = tmpdir()) {
  const root = realpathSync(mkdtempSync(join(canonicalDirectory(tempDirectory), "bobbit-v2-run-")));
  const runId = basename(root);
  return {
    root,
    runId,
    cacheRoot: join(root, "pwtest-transform-cache"),
    v8CacheRoot: join(root, "v8-cache"),
    homeDir: join(root, "home"),
    bobbitDir: join(root, "bobbit"),
    agentDir: join(root, "agent"),
    secretsDir: join(root, "e2e-server-secrets"),
    appDataDir: join(root, "appdata"),
    xdgDir: join(root, "xdg"),
    tempDir: join(root, "tmp"),
    // dist-import-lock creates its lock non-recursively below this legacy
    // os.tmpdir() child, so the coordinator must own and create it up front.
    legacyTempParent: join(root, "tmp", "bobbit-e2e"),
  };
}

// The legacy E2E wrapper must neutralize host credentials before Playwright
// loads any server or discovery module. The policy is shared with the TS
// harness so every coordinator observes the same allow/deny contract.
export function isE2EAmbientEnvKey(key, platform = process.platform) {
  return isAmbientTestEnvironmentKey(key, platform);
}

/**
 * Mirror Node's os.tmpdir() environment selection for an environment that will
 * be passed to a child process. Keeping this pure lets tier-1 verify child
 * confinement without opening a subprocess after its spawn guard is active.
 */
export function resolveChildTmpdir(env, platform = process.platform) {
  const directory = platform === "win32"
    ? environmentValue(env, "TEMP", platform)
      || environmentValue(env, "TMP", platform)
      || `${environmentValue(env, "SystemRoot", platform) || environmentValue(env, "windir", platform)}\\temp`
    : environmentValue(env, "TMPDIR", platform)
      || environmentValue(env, "TMP", platform)
      || environmentValue(env, "TEMP", platform)
      || "/tmp";

  if (platform === "win32") {
    return directory.length > 1 && directory.endsWith("\\") && !directory.endsWith(":\\")
      ? directory.slice(0, -1)
      : directory;
  }
  return directory.length > 1 && directory.endsWith("/") ? directory.slice(0, -1) : directory;
}

/**
 * Capture the machine-global test-concurrency ledger before a coordinator
 * redirects TMPDIR into its disposable run root. An explicit override remains
 * available for ledger self-tests, which must never join the production pool.
 */
export function captureMachineGlobalLedgerDirectory(inheritedEnv = process.env, platform = process.platform) {
  const explicit = environmentValue(inheritedEnv, "BOBBIT_V2_LEDGER_DIR", platform);
  if (explicit) return canonicalDirectory(resolve(explicit));
  const hasExplicitTemp = platform === "win32"
    ? Boolean(environmentValue(inheritedEnv, "TEMP", platform) || environmentValue(inheritedEnv, "TMP", platform))
    : Boolean(environmentValue(inheritedEnv, "TMPDIR", platform) || environmentValue(inheritedEnv, "TMP", platform) || environmentValue(inheritedEnv, "TEMP", platform));
  // If the caller supplied no temp variables, use Node's platform-aware OS
  // temp root rather than guessing /tmp (notably important on macOS).
  const hostTemp = hasExplicitTemp ? resolveChildTmpdir(inheritedEnv, platform) : tmpdir();
  return canonicalDirectory(join(hostTemp, LEDGER_DIRNAME));
}

/** Resolve the installed browser registry before HOME/APPDATA are redirected. */
export function resolvePlaywrightBrowserRegistry(env = process.env, platform = process.platform) {
  const configuredRegistry = environmentValue(env, "PLAYWRIGHT_BROWSERS_PATH", platform);
  if (configuredRegistry) return configuredRegistry;
  const home = environmentValue(env, "HOME", platform) || environmentValue(env, "USERPROFILE", platform) || homedir();
  if (platform === "linux") return join(environmentValue(env, "XDG_CACHE_HOME", platform) || join(home, ".cache"), "ms-playwright");
  if (platform === "darwin") return join(home, "Library", "Caches", "ms-playwright");
  if (platform === "win32") return join(environmentValue(env, "LOCALAPPDATA", platform) || join(home, "AppData", "Local"), "ms-playwright");
  throw new Error(`unsupported platform for Playwright browser registry: ${platform}`);
}

/**
 * Build the child environment for a legacy E2E coordinator. This deliberately
 * does not mutate the wrapper process, which makes direct module use safe and
 * ensures every Playwright worker inherits one owned set of discovery roots.
 */
export function createIsolatedE2EEnvironment(paths, inheritedEnv = process.env, platform = process.platform, fixtureOverrides = {}) {
  // The concurrency ledger is intentionally machine-global. Capture it before
  // replacing TMPDIR below; all other mutable test artifacts remain run-local.
  const ledgerDirectory = captureMachineGlobalLedgerDirectory(inheritedEnv, platform);
  const env = sanitizeTestEnvironment(inheritedEnv, platform);
  // Browser binaries are a Playwright runtime dependency, not Bobbit config.
  // Preserve their host registry before replacing all user discovery roots.
  const browserRegistry = resolvePlaywrightBrowserRegistry(env, platform);

  // Explicit fixture-local discovery values are applied only after host input
  // is scrubbed. Harness-owned roots below always win over fixture overrides.
  for (const [key, value] of Object.entries(fixtureOverrides)) {
    if (value === undefined) deleteEnvironmentValue(env, key, platform);
    else setEnvironmentValue(env, key, value, platform);
  }

  const owned = {
    // Set every temp-dir spelling. Node reads TMPDIR on POSIX and TEMP/TMP on
    // Windows; keeping all three in the owned run root confines every legacy
    // Group B os.tmpdir() fixture and every spawned child process.
    TMPDIR: paths.tempDir,
    TEMP: paths.tempDir,
    TMP: paths.tempDir,
    HOME: paths.homeDir,
    USERPROFILE: paths.homeDir,
    BOBBIT_DIR: paths.bobbitDir,
    BOBBIT_PI_DIR: paths.bobbitDir,
    BOBBIT_AGENT_DIR: paths.agentDir,
    PI_CODING_AGENT_DIR: paths.agentDir,
    BOBBIT_SECRETS_DIR: paths.secretsDir,
    BOBBIT_E2E_V8CACHE_ROOT: paths.v8CacheRoot,
    APPDATA: join(paths.appDataDir, "roaming"),
    LOCALAPPDATA: join(paths.appDataDir, "local"),
    XDG_STATE_HOME: join(paths.xdgDir, "state"),
    XDG_CONFIG_HOME: join(paths.xdgDir, "config"),
    XDG_CACHE_HOME: join(paths.xdgDir, "cache"),
  };
  for (const directory of [...Object.values(owned), paths.cacheRoot, paths.legacyTempParent]) mkdirSync(directory, { recursive: true });
  for (const [key, value] of Object.entries(owned)) setEnvironmentValue(env, key, value, platform);
  // HOME above keeps the host's GLOBAL gitconfig out; /etc/gitconfig is read
  // regardless of HOME, so the system tier needs its own switch (see
  // GIT_ISOLATION_ENV). Without it a host `url.<base>.insteadOf` rewrite makes
  // a fixture's own origin resolve to a host the fixture never wrote.
  for (const [key, value] of Object.entries(GIT_ISOLATION_ENV)) setEnvironmentValue(env, key, value, platform);
  setEnvironmentValue(env, "PLAYWRIGHT_BROWSERS_PATH", browserRegistry, platform);
  setEnvironmentValue(env, "BOBBIT_V2_LEDGER_DIR", ledgerDirectory, platform);
  if (resolveChildTmpdir(env, platform) !== paths.tempDir) {
    throw new Error("isolated E2E environment did not confine the child temp directory");
  }
  return env;
}

function optionValues(args, option) {
  const values = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === option && args[index + 1] !== undefined) values.push(args[index + 1]);
    else if (argument.startsWith(`${option}=`)) values.push(argument.slice(option.length + 1));
  }
  return values;
}

function positionalTestFilters(args) {
  const filters = [];
  let afterOptions = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (afterOptions) {
      filters.push(argument);
      continue;
    }
    if (argument === "--") {
      afterOptions = true;
      continue;
    }
    if (argument.startsWith("-")) {
      const option = argument.split("=", 1)[0];
      if (!argument.includes("=") && PLAYWRIGHT_OPTIONS_WITH_VALUES.has(option)) index++;
      continue;
    }
    filters.push(argument);
  }
  return filters;
}

function wildcardMatches(value, pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function filterMaySelectPackedConsumer(filter) {
  const normalized = filter.replaceAll("\\", "/");
  const basenameFilter = basename(normalized);
  if (normalized === PACKAGED_CONSUMER_SPEC || basenameFilter === basename(PACKAGED_CONSUMER_SPEC)) return true;
  try {
    return new RegExp(normalized).test(PACKAGED_CONSUMER_SPEC);
  } catch {
    return PACKAGED_CONSUMER_SPEC.includes(normalized);
  }
}

/**
 * Resolve the only trusted descriptor location for a coordinator run. A
 * pathname handed through the environment is evidence only: it must equal the
 * fixed location below the already-authoritative fresh run root.
 */
export function resolvePackedConsumerDescriptorPath(
  environment,
  authoritativeRunRoot,
  platform = process.platform,
) {
  if (!authoritativeRunRoot) throw new Error("Packed-consumer descriptor resolution requires the authoritative coordinator run root");
  const expected = join(resolve(authoritativeRunRoot), "prepared-packed-consumer", "descriptor.json");
  const handedOff = environmentValue(environment, PACKED_CONSUMER_DESCRIPTOR_ENV, platform);
  if (handedOff && resolve(handedOff) !== expected) {
    throw new Error(`Packed-consumer descriptor handoff is outside the authoritative coordinator layout: ${handedOff}`);
  }
  return expected;
}

/** Decide whether this direct coordinator can discover the packaged-consumer spec. */
export function directRunnerPackedConsumerDecision(forwardedArgs = []) {
  const selectedProjects = optionValues(forwardedArgs, "--project");
  if (selectedProjects.length > 0 && !selectedProjects.some(project => wildcardMatches(PACKAGED_CONSUMER_PROJECT, project))) {
    return Object.freeze({ prepare: false, reason: "project-excludes-packaged-consumer", descriptorPath: null });
  }

  const filters = positionalTestFilters(forwardedArgs);
  if (filters.length > 0 && !filters.some(filterMaySelectPackedConsumer)) {
    return Object.freeze({ prepare: false, reason: "test-filter-excludes-packaged-consumer", descriptorPath: null });
  }
  return Object.freeze({ prepare: true, reason: filters.length === 0 ? "unfiltered" : "packaged-consumer-selected", descriptorPath: null });
}

/** Prepare once below the direct wrapper's root and publish into its child env. */
export async function prepareDirectRunnerPackedConsumer(
  forwardedArgs,
  environment,
  paths,
  prepare = preparePackedConsumerFixture,
) {
  // The descriptor is coordinator output, never an ambient input. Scrub it
  // again at this boundary so direct helper callers cannot bypass the shared
  // environment sanitizer and suppress preparation with a forged pathname.
  deleteEnvironmentValue(environment, PACKED_CONSUMER_DESCRIPTOR_ENV);
  const decision = directRunnerPackedConsumerDecision(forwardedArgs);
  if (!decision.prepare) return decision;
  const descriptor = await prepare({
    repoRoot: projectRoot,
    runRoot: paths.root,
    baseEnv: environment,
  });
  const descriptorPath = resolvePackedConsumerDescriptorPath(
    { [PACKED_CONSUMER_DESCRIPTOR_ENV]: descriptor.descriptorPath },
    paths.root,
  );
  setEnvironmentValue(environment, PACKED_CONSUMER_DESCRIPTOR_ENV, descriptorPath);
  return Object.freeze({ prepare: true, reason: decision.reason, descriptorPath });
}

export async function runPlaywrightE2E(forwardedArgs = process.argv.slice(2)) {
const invocation = createPlaywrightE2EInvocation(forwardedArgs);
const paths = createE2ERunPaths(coordinatorTempDirectory());
const cacheRoot = paths.cacheRoot;
const cacheDir = cacheRoot;
mkdirSync(cacheDir, { recursive: true });

const env = createIsolatedE2EEnvironment(paths);
// The TypeScript fixtures consume this root through getRunRoot(). Workers only
// inherit it; this wrapper is the sole cleanup owner after Playwright settles.
setEnvironmentValue(env, "BOBBIT_V2_RUN_ROOT", paths.root);
setEnvironmentValue(env, "BOBBIT_V2_RUN_ROOT_OWNER_PID", String(process.pid));
setEnvironmentValue(env, "BOBBIT_E2E_RUN_ID", paths.runId);
setEnvironmentValue(env, "BOBBIT_E2E_TMP_ROOT", paths.legacyTempParent);
setEnvironmentValue(env, "BOBBIT_E2E_PWTEST_CACHE_ROOT", cacheRoot);
setEnvironmentValue(env, "BOBBIT_E2E_PWTEST_RUN_CACHE_ROOT", cacheRoot);
setEnvironmentValue(env, "PWTEST_CACHE_DIR", join(cacheDir, `runner-${process.pid}`));
setEnvironmentValue(env, "BOBBIT_E2E_PWTEST_CACHE_DIR", cacheRoot);
setEnvironmentValue(env, "BOBBIT_E2E_PWTEST_CACHE_OWNED", "1");
setEnvironmentValue(env, "NODE_ENV", "test");
setEnvironmentValue(env, "BOBBIT_TEST_NO_EXTERNAL", environmentValue(env, "BOBBIT_TEST_NO_EXTERNAL") || "1");
setEnvironmentValue(env, "BOBBIT_TEST_NO_REMOTE", environmentValue(env, "BOBBIT_TEST_NO_REMOTE") || "1");
setEnvironmentValue(env, "NODE_DISABLE_COMPILE_CACHE", "1");
deleteEnvironmentValue(env, "NODE_COMPILE_CACHE");
setEnvironmentValue(env, "NODE_OPTIONS", [`--require=${cacheBootstrap}`, environmentValue(env, "NODE_OPTIONS")].filter(Boolean).join(" "));

await prepareDirectRunnerPackedConsumer(forwardedArgs, env, paths);

if (env.BOBBIT_DEBUG_PWTEST_CACHE === "1") {
  console.error(`[e2e] BOBBIT_V2_RUN_ROOT=${paths.root}`);
  console.error(`[e2e] BOBBIT_E2E_PWTEST_RUN_CACHE_ROOT=${cacheRoot}`);
}

const result = spawnSync(invocation.command, invocation.args, {
  cwd: projectRoot,
  env,
  stdio: "inherit",
  shell: false,
});

let cleanupFailed = false;
if (result.status === 0 && !result.signal && process.env.BOBBIT_KEEP_PWTEST_CACHE !== "1") {
  try {
    // Never sweep a shared temp parent: this coordinator owns exactly paths.root.
    await removeOwnedPath(paths.root, {
      ownerRoot: paths.root,
      allowOwnerRoot: true,
      owner: { kind: "coordinator", id: paths.runId },
      lifecycle: {
        playwright: { state: "closed", status: result.status, signal: result.signal },
        reporters: "closed with Playwright process",
      },
    });
  } catch (error) {
    cleanupFailed = true;
    console.error(`[e2e] could not remove successful run root: ${paths.root}\n${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
} else {
  console.error(`[e2e] retained failure diagnostics: ${paths.root}`);
}

if (result.error) throw result.error;
if (result.signal) {
  process.kill(process.pid, result.signal);
  return 1;
}
if (cleanupFailed) return 1;
return result.status ?? 1;
}

const invokedAsScript = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  runPlaywrightE2E().then(
    code => { process.exitCode = code; },
    error => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
