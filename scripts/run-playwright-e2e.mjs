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
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const cacheBootstrap = resolve(__dirname, "playwright-e2e-cache-bootstrap.cjs");

function sanitizeSegment(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "run";
}

function e2eTempRoot() {
  if (existsSync("/.dockerenv")) return "/tmp";
  if (process.platform === "win32") return process.env.BOBBIT_E2E_TMP_ROOT || "C:\\bobbit-e2e";
  return join(tmpdir(), "bobbit-e2e");
}

function cacheRootOverride() {
  // Canonical external override. BOBBIT_PWTEST_CACHE_ROOT is a legacy alias
  // kept for local scripts that predate the E2E-prefixed name.
  return process.env.BOBBIT_E2E_PWTEST_CACHE_ROOT?.trim()
    || process.env.BOBBIT_PWTEST_CACHE_ROOT?.trim()
    || "";
}

function makeRunCacheDir() {
  const explicit = process.env.PWTEST_CACHE_DIR?.trim();
  if (explicit) return { cacheDir: resolve(explicit), baseRoot: undefined, owned: false };

  const runId = sanitizeSegment(
    process.env.BOBBIT_E2E_RUN_ID?.trim()
      || `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`,
  );
  const baseRoot = resolve(cacheRootOverride() || e2eTempRoot());
  return { cacheDir: join(baseRoot, "pwtest-transform-cache", runId), baseRoot, owned: true };
}

const { cacheDir, baseRoot, owned: ownsCacheDir } = makeRunCacheDir();
mkdirSync(cacheDir, { recursive: true });

const env = { ...process.env };
if (baseRoot) env.BOBBIT_E2E_PWTEST_CACHE_ROOT = baseRoot;
env.BOBBIT_E2E_PWTEST_RUN_CACHE_ROOT = cacheDir;
env.PWTEST_CACHE_DIR = join(cacheDir, `runner-${process.pid}`);
env.BOBBIT_E2E_PWTEST_CACHE_DIR = cacheDir;
if (ownsCacheDir) env.BOBBIT_E2E_PWTEST_CACHE_OWNED = "1";
else delete env.BOBBIT_E2E_PWTEST_CACHE_OWNED;
env.NODE_DISABLE_COMPILE_CACHE = "1";
delete env.NODE_COMPILE_CACHE;
env.NODE_OPTIONS = [`--require=${cacheBootstrap}`, env.NODE_OPTIONS].filter(Boolean).join(" ");

if (env.BOBBIT_DEBUG_PWTEST_CACHE === "1") {
  console.error(`[e2e] BOBBIT_E2E_PWTEST_RUN_CACHE_ROOT=${cacheDir}`);
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
const result = spawnSync(invocation.command, [...invocation.args, "test", "--config", "playwright-e2e.config.ts", ...process.argv.slice(2)], {
  cwd: projectRoot,
  env,
  stdio: "inherit",
  shell: invocation.shell,
});

if (ownsCacheDir && process.env.BOBBIT_KEEP_PWTEST_CACHE !== "1") {
  try {
    rmSync(cacheDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Best-effort cleanup only; stale run-scoped caches are harmless.
  }
}

if (result.error) throw result.error;
if (result.signal) {
  process.kill(process.pid, result.signal);
  process.exit(1);
}
process.exit(result.status ?? 1);
