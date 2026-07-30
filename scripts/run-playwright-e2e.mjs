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
import { tmpdir } from "node:os";
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
    secretsDir: join(root, "e2e-server-secrets"),
  };
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

const env = { ...process.env };
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
env.BOBBIT_SECRETS_DIR = env.BOBBIT_SECRETS_DIR || paths.secretsDir;
mkdirSync(env.BOBBIT_SECRETS_DIR, { recursive: true });
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
