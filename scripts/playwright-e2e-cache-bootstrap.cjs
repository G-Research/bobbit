/*
 * Preload for Playwright E2E runs.
 *
 * This file is injected via NODE_OPTIONS by scripts/run-playwright-e2e.mjs, so
 * it executes before Playwright imports its transform-cache module in the main
 * runner and in every worker process. Keep it CommonJS: --require runs before
 * the package's ESM loader setup.
 */
const fs = require("node:fs");
const path = require("node:path");

function sanitizeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "process";
}

function cacheRootOverride() {
  // Canonical external override. BOBBIT_PWTEST_CACHE_ROOT is a legacy alias.
  return process.env.BOBBIT_E2E_PWTEST_CACHE_ROOT?.trim()
    || process.env.BOBBIT_PWTEST_CACHE_ROOT?.trim()
    || "";
}

function runCacheRoot() {
  const existing = process.env.BOBBIT_E2E_PWTEST_RUN_CACHE_ROOT?.trim();
  if (existing) return path.resolve(existing);

  // If callers set PWTEST_CACHE_DIR directly, treat it as authoritative and do
  // not turn it into a per-process subdirectory behind their back.
  if (process.env.PWTEST_CACHE_DIR?.trim()) return "";

  const baseRoot = cacheRootOverride();
  if (!baseRoot) return "";

  const runId = sanitizeSegment(
    process.env.BOBBIT_E2E_RUN_ID?.trim()
      || `direct-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`,
  );
  const root = path.join(path.resolve(baseRoot), "pwtest-transform-cache", runId);
  process.env.BOBBIT_E2E_PWTEST_RUN_CACHE_ROOT = root;
  process.env.BOBBIT_E2E_PWTEST_CACHE_OWNED = "1";
  return root;
}

process.env.NODE_DISABLE_COMPILE_CACHE = "1";
delete process.env.NODE_COMPILE_CACHE;

const root = runCacheRoot();
if (root) {
  const workerId = process.env.TEST_WORKER_INDEX || process.env.PW_TEST_WORKER_INDEX || process.env.TEST_PARALLEL_INDEX;
  const role = workerId ? `worker-${sanitizeSegment(workerId)}` : "runner";
  const cacheDir = path.join(root, `${role}-${process.pid}`);
  process.env.PWTEST_CACHE_DIR = cacheDir;
  process.env.BOBBIT_E2E_PWTEST_CACHE_DIR = root;
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch {}
}
