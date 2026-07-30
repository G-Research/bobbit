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
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const cacheBootstrap = resolve(__dirname, "playwright-e2e-cache-bootstrap.cjs");

function canonicalDirectory(directory) {
  mkdirSync(directory, { recursive: true });
  try { return realpathSync(directory); } catch { return resolve(directory); }
}

/** Allocate the one canonical root owned by this legacy E2E coordinator. */
export function createE2ERunPaths(tempDirectory = tmpdir()) {
  const root = realpathSync(mkdtempSync(join(canonicalDirectory(tempDirectory), "bobbit-v2-run-")));
  const runId = basename(root);
  return {
    root,
    runId,
    cacheRoot: join(root, "pwtest-transform-cache"),
    homeDir: join(root, "home"),
    bobbitDir: join(root, "bobbit"),
    agentDir: join(root, "agent"),
    secretsDir: join(root, "e2e-server-secrets"),
    appDataDir: join(root, "appdata"),
    xdgDir: join(root, "xdg"),
    tempDir: join(root, "tmp"),
  };
}

// Keep this in sync with tests2/harness/run-isolation.ts. The legacy E2E
// wrapper must neutralize host credentials before Playwright loads any server
// or discovery module, rather than relying on individual test fixtures.
const CREDENTIAL_EXACT_NAMES = new Set([
  "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "OPENAI_CODEX_AUTH",
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_CLOUD_ACCESS_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT_ID", "GOOGLE_GENAI_USE_GCA",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_REGION",
  "AWS_DEFAULT_REGION", "AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "AWS_BEDROCK_SKIP_AUTH", "NPM_TOKEN",
  "GITHUB_TOKEN", "GH_TOKEN", "AIGW_OPENCODE_TOKEN",
]);
const CREDENTIAL_PREFIXES = [
  "CLAUDE_CODE_", "ANTHROPIC_", "OPENAI_", "OPENROUTER_", "GEMINI_", "GOOGLE_", "AWS_",
  "AIGW_", "OPENCODE_", "GITHUB_", "GH_", "AZURE_", "COHERE_", "MISTRAL_", "GROQ_",
  "TOGETHER_", "DEEPSEEK_", "XAI_",
];

export function isE2ECredentialEnvKey(key, platform = process.platform) {
  // Windows environment variable names are case-insensitive. The spread below
  // intentionally creates a plain object, so normalize here rather than relying
  // on process.env's Windows-specific property lookup.
  const normalized = platform === "win32" ? key.toUpperCase() : key;
  return CREDENTIAL_EXACT_NAMES.has(normalized)
    || CREDENTIAL_PREFIXES.some(prefix => normalized.startsWith(prefix))
    || /^BOBBIT_.*(?:KEY|TOKEN|SECRET|CREDENTIALS?)$/.test(normalized);
}

/** Read an environment key with Windows' case-insensitive name semantics. */
function environmentValue(env, name, platform) {
  if (env[name]) return env[name];
  if (platform !== "win32") return undefined;
  const matchingKey = Object.keys(env).find(key => key.toUpperCase() === name);
  return matchingKey ? env[matchingKey] : undefined;
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
export function createIsolatedE2EEnvironment(paths, inheritedEnv = process.env, platform = process.platform) {
  const env = { ...inheritedEnv };
  // Browser binaries are a Playwright runtime dependency, not Bobbit config.
  // Preserve their host registry before replacing all user discovery roots.
  const browserRegistry = resolvePlaywrightBrowserRegistry(env, platform);

  for (const key of Object.keys(env)) {
    if (isE2ECredentialEnvKey(key, platform)) delete env[key];
  }
  // A copied Windows process environment is a plain object, so remove any
  // inherited spelling before adding the canonical temp keys below. Otherwise
  // `Temp` and `TEMP` can both reach a spawned worker with ambiguous results.
  if (platform === "win32") {
    for (const key of Object.keys(env)) {
      if (["TMPDIR", "TEMP", "TMP"].includes(key.toUpperCase())) delete env[key];
    }
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
    APPDATA: join(paths.appDataDir, "roaming"),
    LOCALAPPDATA: join(paths.appDataDir, "local"),
    XDG_STATE_HOME: join(paths.xdgDir, "state"),
    XDG_CONFIG_HOME: join(paths.xdgDir, "config"),
    XDG_CACHE_HOME: join(paths.xdgDir, "cache"),
  };
  for (const directory of Object.values(owned)) mkdirSync(directory, { recursive: true });
  Object.assign(env, owned, { PLAYWRIGHT_BROWSERS_PATH: browserRegistry });
  if (resolveChildTmpdir(env, platform) !== paths.tempDir) {
    throw new Error("isolated E2E environment did not confine the child temp directory");
  }
  return env;
}

function cacheRootOverride() {
  // Explicit cache overrides remain supported for local debugging, but the
  // normal path is always an owned child of the coordinator's run root.
  return process.env.BOBBIT_E2E_PWTEST_CACHE_ROOT?.trim()
    || process.env.BOBBIT_PWTEST_CACHE_ROOT?.trim()
    || "";
}

export function runPlaywrightE2E(forwardedArgs = process.argv.slice(2)) {
const paths = createE2ERunPaths();
const explicitCache = process.env.PWTEST_CACHE_DIR?.trim();
const cacheRoot = explicitCache ? resolve(explicitCache) : join(resolve(cacheRootOverride() || paths.root), "pwtest-transform-cache");
const cacheDir = explicitCache || cacheRoot;
mkdirSync(cacheDir, { recursive: true });

const env = createIsolatedE2EEnvironment(paths);
// The TypeScript fixtures consume this root through getRunRoot(). Workers only
// inherit it; this wrapper is the sole cleanup owner after Playwright settles.
env.BOBBIT_V2_RUN_ROOT = paths.root;
env.BOBBIT_V2_RUN_ROOT_OWNER_PID = String(process.pid);
env.BOBBIT_E2E_RUN_ID = paths.runId;
env.BOBBIT_E2E_TMP_ROOT = paths.root;
env.BOBBIT_E2E_PWTEST_CACHE_ROOT = cacheRoot;
env.BOBBIT_E2E_PWTEST_RUN_CACHE_ROOT = cacheRoot;
env.PWTEST_CACHE_DIR = join(cacheDir, `runner-${process.pid}`);
env.BOBBIT_E2E_PWTEST_CACHE_DIR = cacheRoot;
env.BOBBIT_E2E_PWTEST_CACHE_OWNED = "1";
env.NODE_ENV = "test";
env.BOBBIT_TEST_NO_EXTERNAL = env.BOBBIT_TEST_NO_EXTERNAL || "1";
env.BOBBIT_TEST_NO_REMOTE = env.BOBBIT_TEST_NO_REMOTE || "1";
env.NODE_DISABLE_COMPILE_CACHE = "1";
delete env.NODE_COMPILE_CACHE;
env.NODE_OPTIONS = [`--require=${cacheBootstrap}`, env.NODE_OPTIONS].filter(Boolean).join(" ");

if (env.BOBBIT_DEBUG_PWTEST_CACHE === "1") {
  console.error(`[e2e] BOBBIT_V2_RUN_ROOT=${paths.root}`);
  console.error(`[e2e] BOBBIT_E2E_PWTEST_RUN_CACHE_ROOT=${cacheRoot}`);
}

function playwrightInvocation() {
  const localCli = join(projectRoot, "node_modules", "playwright", "cli.js");
  if (existsSync(localCli)) return { command: process.execPath, args: [localCli], shell: false };
  return {
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["playwright"],
    shell: process.platform === "win32",
  };
}

const invocation = playwrightInvocation();
const result = spawnSync(invocation.command, [...invocation.args, "test", "--config", "playwright-e2e.config.ts", ...forwardedArgs], {
  cwd: projectRoot,
  env,
  stdio: "inherit",
  shell: invocation.shell,
});

if (result.status === 0 && !result.signal && process.env.BOBBIT_KEEP_PWTEST_CACHE !== "1") {
  try {
    // Never sweep a shared temp parent: this coordinator owns exactly paths.root.
    rmSync(paths.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    console.error(`[e2e] could not remove successful run root: ${paths.root}`);
  }
} else {
  console.error(`[e2e] retained failure diagnostics: ${paths.root}`);
}

if (result.error) throw result.error;
if (result.signal) {
  process.kill(process.pid, result.signal);
  return 1;
}
return result.status ?? 1;
}

const invokedAsScript = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) process.exit(runPlaywrightE2E());
