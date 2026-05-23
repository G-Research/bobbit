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

process.env.NODE_DISABLE_COMPILE_CACHE = "1";
delete process.env.NODE_COMPILE_CACHE;

const root = process.env.BOBBIT_E2E_PWTEST_CACHE_ROOT;
if (root) {
  const workerId = process.env.TEST_WORKER_INDEX || process.env.PW_TEST_WORKER_INDEX || process.env.TEST_PARALLEL_INDEX;
  const role = workerId ? `worker-${sanitizeSegment(workerId)}` : "runner";
  const cacheDir = path.join(root, `${role}-${process.pid}`);
  process.env.PWTEST_CACHE_DIR = cacheDir;
  process.env.BOBBIT_E2E_PWTEST_CACHE_DIR = root;
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch {}
}
