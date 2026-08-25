import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  CREDENTIAL_ENV_EXACT_NAMES,
  CREDENTIAL_ENV_PATTERN,
  CREDENTIAL_ENV_PREFIXES,
  deleteEnvironmentValue,
  environmentValue,
  isAmbientBobbitRuntimeEnvKey,
  isAmbientTestEnvironmentKey,
  isCredentialEnvKey,
  sanitizeTestEnvironment,
  setEnvironmentValue,
} from "../../../../scripts/testing-v2/environment-policy.mjs";

export {
  CREDENTIAL_ENV_EXACT_NAMES,
  CREDENTIAL_ENV_PATTERN,
  CREDENTIAL_ENV_PREFIXES,
  isAmbientBobbitRuntimeEnvKey,
  isCredentialEnvKey,
};

/** Environment key inherited by every worker participating in one test run. */
export const RUN_ROOT_ENV = "BOBBIT_V2_RUN_ROOT";
/** Set only by the coordinator that made RUN_ROOT_ENV; workers must never clean it. */
export const RUN_ROOT_OWNER_ENV = "BOBBIT_V2_RUN_ROOT_OWNER_PID";
export const PLAYWRIGHT_BROWSERS_PATH_ENV = "PLAYWRIGHT_BROWSERS_PATH";
export const MACHINE_LEDGER_DIRNAME = "bobbit-test-v2-ledger";

const RUN_OWNED_ENV_NAMES = [
  RUN_ROOT_ENV,
  RUN_ROOT_OWNER_ENV,
  "BOBBIT_V2_LEDGER_DIR",
  "TMPDIR",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "BOBBIT_DIR",
  "BOBBIT_PI_DIR",
  "BOBBIT_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
  "BOBBIT_SECRETS_DIR",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_STATE_HOME",
  "XDG_CONFIG_HOME",
] as const;

/** True when an inherited value must not participate in the unit runtime. */
export const isUnitAmbientEnvKey = isAmbientTestEnvironmentKey;

/** Copy an environment while deleting host credentials and Bobbit discovery inputs. */
export const sanitizeUnitEnvironment = sanitizeTestEnvironment;

export interface PathContainmentApi {
  resolve(...paths: string[]): string;
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
}

function canonicalDirectory(directory: string): string {
  mkdirSync(directory, { recursive: true });
  try {
    return realpathSync(directory);
  } catch {
    return path.resolve(directory);
  }
}

/**
 * Whether candidate is strictly below root. An absolute relative result is an
 * escape on Windows (different drive or UNC path), even though it does not
 * begin with `..`; reject it before any destructive operation.
 */
export function isOwnedRunChild(
  root: string,
  candidate: string,
  pathApi: PathContainmentApi = path,
): boolean {
  const canonicalRoot = pathApi.resolve(root);
  const canonicalCandidate = pathApi.resolve(candidate);
  const rel = pathApi.relative(canonicalRoot, canonicalCandidate);
  return (
    rel !== "" &&
    !pathApi.isAbsolute(rel) &&
    rel !== ".." &&
    !rel.startsWith(`..${path.sep}`) &&
    !rel.startsWith("../") &&
    !rel.startsWith("..\\")
  );
}

let runRoot: string | undefined;
let runRootOwnedByThisProcess = false;
let cleanupRegistered = false;
let runRootCleaned = false;

function registerOwnerCleanup(): void {
  if (cleanupRegistered || !runRootOwnedByThisProcess) return;
  cleanupRegistered = true;
  process.once("exit", () => {
    cleanupOwnedRunRoot();
  });
}

/** Return the canonical, per-coordinator root. Child workers reuse its env value. */
export function getRunRoot(): string {
  if (runRoot) return runRoot;
  const inherited = environmentValue(process.env, RUN_ROOT_ENV);
  if (inherited) return (runRoot = canonicalDirectory(inherited));
  const base = canonicalDirectory(tmpdir());
  runRoot = canonicalDirectory(mkdtempSync(path.join(base, "bobbit-v2-run-")));
  runRootOwnedByThisProcess = true;
  setEnvironmentValue(process.env, RUN_ROOT_ENV, runRoot);
  setEnvironmentValue(process.env, RUN_ROOT_OWNER_ENV, String(process.pid));
  registerOwnerCleanup();
  return runRoot;
}

/** True only in the coordinator process that allocated this run root. */
export function isRunRootOwner(): boolean {
  getRunRoot();
  return runRootOwnedByThisProcess;
}

/**
 * Delete a run root only when this process allocated it. Workers inherit the
 * root but have no ownership flag, so their exit can never race sibling tests.
 * Reporters finish before the coordinator exits; durable summaries belong in
 * their explicitly managed report paths, not in disposable worker artifacts.
 */
export function cleanupOwnedRunRoot(): boolean {
  if (!runRootOwnedByThisProcess || !runRoot || runRootCleaned) return false;
  runRootCleaned = true;
  try {
    rmSync(runRoot, { recursive: true, force: true });
    return true;
  } catch {
    runRootCleaned = false;
    return false;
  }
}

/** Allocate a unique directory owned by this run; only such children may be removed. */
export function createRunChild(prefix: string): string {
  if (
    !prefix ||
    prefix === "." ||
    prefix === ".." ||
    path.isAbsolute(prefix) ||
    prefix.includes("/") ||
    prefix.includes("\\") ||
    prefix !== path.basename(prefix)
  ) {
    throw new Error(`invalid run child prefix: ${prefix}`);
  }
  return canonicalDirectory(mkdtempSync(path.join(getRunRoot(), `${prefix}-`)));
}

/**
 * Create a deterministic artifact directory inside this run's unique root.
 * Unlike createRunChild(), artifact names are deliberately stable: the unique
 * run root prevents simultaneous coordinators from sharing it.
 */
export function createRunArtifactDirectory(name: string): string {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name !== path.basename(name)
  ) {
    throw new Error(`invalid run artifact directory name: ${name}`);
  }
  const root = getRunRoot();
  const artifactDir = path.resolve(root, name);
  if (!isOwnedRunChild(root, artifactDir))
    throw new Error(
      `refusing to create non-owned test artifact path: ${artifactDir}`,
    );
  return canonicalDirectory(artifactDir);
}

export function removeOwnedRunChild(candidate: string): void {
  const root = getRunRoot();
  if (!isOwnedRunChild(root, candidate))
    throw new Error(`refusing to remove non-owned test path: ${candidate}`);
  rmSync(candidate, { recursive: true, force: true });
}

/** The Playwright browser registry derived from an unredirected user environment. */
export function resolvePlaywrightBrowserRegistry(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const configuredRegistry = environmentValue(
    env,
    PLAYWRIGHT_BROWSERS_PATH_ENV,
    platform,
  );
  if (configuredRegistry) return configuredRegistry;
  const home = environmentValue(env, "HOME", platform) || environmentValue(env, "USERPROFILE", platform);
  if (!home)
    throw new Error(
      "cannot resolve Playwright browser registry without HOME or USERPROFILE",
    );
  if (platform === "linux")
    return path.join(
      environmentValue(env, "XDG_CACHE_HOME", platform) || path.join(home, ".cache"),
      "ms-playwright",
    );
  if (platform === "darwin")
    return path.join(home, "Library", "Caches", "ms-playwright");
  if (platform === "win32")
    return path.join(
      environmentValue(env, "LOCALAPPDATA", platform) || path.join(home, "AppData", "Local"),
      "ms-playwright",
    );
  throw new Error(
    `unsupported platform for Playwright browser registry: ${platform}`,
  );
}

/** Preserve the browser registry before HOME is redirected to the run root. */
export function capturePlaywrightBrowserRegistry(): string {
  const registry = resolvePlaywrightBrowserRegistry();
  setEnvironmentValue(process.env, PLAYWRIGHT_BROWSERS_PATH_ENV, registry);
  return registry;
}

/** Preserve the intentionally machine-global concurrency ledger before TMPDIR changes. */
export function captureMachineLedgerDirectory(): string {
  const explicit = environmentValue(process.env, "BOBBIT_V2_LEDGER_DIR")?.trim();
  const directory = explicit
    ? path.resolve(explicit)
    : path.join(canonicalDirectory(tmpdir()), MACHINE_LEDGER_DIRNAME);
  return canonicalDirectory(directory);
}

function runOwnedEnvironment(
  root: string,
  ledgerDirectory: string,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const home = canonicalDirectory(path.join(root, "home"));
  const temp = canonicalDirectory(path.join(root, "tmp"));
  const values: Record<(typeof RUN_OWNED_ENV_NAMES)[number], string> = {
    [RUN_ROOT_ENV]: root,
    [RUN_ROOT_OWNER_ENV]:
      environmentValue(process.env, RUN_ROOT_OWNER_ENV) || String(process.pid),
    BOBBIT_V2_LEDGER_DIR: ledgerDirectory,
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    HOME: home,
    USERPROFILE: home,
    BOBBIT_DIR: canonicalDirectory(path.join(root, "bobbit")),
    BOBBIT_PI_DIR: canonicalDirectory(path.join(root, "bobbit")),
    BOBBIT_AGENT_DIR: canonicalDirectory(path.join(root, "agent")),
    PI_CODING_AGENT_DIR: canonicalDirectory(path.join(root, "agent")),
    BOBBIT_SECRETS_DIR: canonicalDirectory(path.join(root, "secrets")),
    APPDATA: canonicalDirectory(path.join(root, "appdata", "roaming")),
    LOCALAPPDATA: canonicalDirectory(path.join(root, "appdata", "local")),
    XDG_STATE_HOME: canonicalDirectory(path.join(root, "xdg", "state")),
    XDG_CONFIG_HOME: canonicalDirectory(path.join(root, "xdg", "config")),
  };
  for (const [key, value] of Object.entries(values))
    setEnvironmentValue(env, key, value, platform);
  return env;
}

/**
 * Build a unit-owned child environment without inheriting ambient Bobbit
 * configuration. Explicit fixture overrides are applied after sanitization;
 * run roots and ledger metadata always remain canonical.
 */
export function createRunChildEnvironment(
  overrides: NodeJS.ProcessEnv = {},
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const root = getRunRoot();
  const env = sanitizeUnitEnvironment(source, platform);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) deleteEnvironmentValue(env, key, platform);
    else setEnvironmentValue(env, key, value, platform);
  }
  const owned = runOwnedEnvironment(
    root,
    captureMachineLedgerDirectory(),
    platform,
  );
  for (const [key, value] of Object.entries(owned))
    setEnvironmentValue(env, key, value!, platform);
  return env;
}

/** Redirect user-discovery roots and remove ambient host runtime inputs before imports. */
export function installRunIsolation(): string {
  // The registry is an intentional, non-Bobbit machine dependency. Capture it
  // before HOME / LOCALAPPDATA move into the disposable run root.
  if (
    !environmentValue(process.env, PLAYWRIGHT_BROWSERS_PATH_ENV) &&
    (environmentValue(process.env, "HOME") || environmentValue(process.env, "USERPROFILE"))
  )
    capturePlaywrightBrowserRegistry();
  const root = getRunRoot();
  const isolated = createRunChildEnvironment();
  for (const key of Object.keys(process.env)) delete process.env[key];
  for (const [key, value] of Object.entries(isolated)) {
    if (value !== undefined) setEnvironmentValue(process.env, key, value);
  }
  return root;
}

/** Snapshot/delete credentials and ambient runtime settings for focused fixture setup. */
export function isolateCredentialEnv(): () => void {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(process.env)) {
    if (isUnitAmbientEnvKey(key)) {
      saved.set(key, process.env[key]);
      deleteEnvironmentValue(process.env, key);
    }
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) deleteEnvironmentValue(process.env, key);
      else setEnvironmentValue(process.env, key, value);
    }
  };
}

export function isOwnedRunPath(candidate: string): boolean {
  const root = getRunRoot();
  return (
    existsSync(root) &&
    (path.resolve(candidate) === root || isOwnedRunChild(root, candidate))
  );
}
