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

function isStrictChild(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== ""
    && !path.isAbsolute(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !relative.startsWith("../")
    && !relative.startsWith("..\\");
}

function requestedRunCacheRoot(env, pid) {
  const existing = env.BOBBIT_E2E_PWTEST_RUN_CACHE_ROOT?.trim();
  if (existing) return path.resolve(existing);

  // If callers set PWTEST_CACHE_DIR directly, treat it as authoritative and do
  // not turn it into a per-process subdirectory behind their back.
  if (env.PWTEST_CACHE_DIR?.trim()) return "";

  const baseRoot = env.BOBBIT_E2E_PWTEST_CACHE_ROOT?.trim()
    || env.BOBBIT_PWTEST_CACHE_ROOT?.trim()
    || "";
  if (!baseRoot) return "";

  const runId = sanitizeSegment(
    env.BOBBIT_E2E_RUN_ID?.trim()
      || `direct-${new Date().toISOString().replace(/[:.]/g, "-")}-${pid}`,
  );
  return path.join(path.resolve(baseRoot), "pwtest-transform-cache", runId);
}

function isWorkerProcess(env) {
  return env.TEST_WORKER_INDEX !== undefined
    || env.PW_TEST_WORKER_INDEX !== undefined
    || env.TEST_PARALLEL_INDEX !== undefined;
}

function validParallelIndex(value) {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value);
}

/** Resolve a cache slot without mutating the supplied environment. */
function resolveCacheSlot(env = process.env, pid = process.pid) {
  let root = requestedRunCacheRoot(env, pid);
  if (!root) return null;

  const serialRequested = env.BOBBIT_V2_E2E_SERIAL_CACHE === "1"
    && env.BOBBIT_E2E_PWTEST_CACHE_OWNED === "1";
  if (serialRequested) {
    const runRoot = env.BOBBIT_V2_RUN_ROOT?.trim();
    // The stable-slot mode is internal and run-local. An inherited or hostile
    // cache root outside the owned coordinator root must never become shared.
    if (runRoot && !isStrictChild(runRoot, root)) {
      root = path.join(path.resolve(runRoot), "pwtest-transform-cache");
    }
    if (runRoot && isStrictChild(runRoot, root)) {
      if (!isWorkerProcess(env)) return { root, cacheDir: path.join(root, "runner") };
      if (validParallelIndex(env.TEST_PARALLEL_INDEX)) {
        return { root, cacheDir: path.join(root, `worker-${env.TEST_PARALLEL_INDEX}`) };
      }
      // A worker without Playwright's canonical parallel index cannot safely
      // share a stable slot. Retain the legacy PID-isolated fallback.
    }
  }

  // Flag-off behaviour remains the legacy per-process layout.
  const workerId = env.TEST_WORKER_INDEX || env.PW_TEST_WORKER_INDEX || env.TEST_PARALLEL_INDEX;
  const role = workerId ? `worker-${sanitizeSegment(workerId)}` : "runner";
  return { root, cacheDir: path.join(root, `${role}-${pid}`) };
}

function configureTransformCache(env = process.env, pid = process.pid) {
  env.NODE_DISABLE_COMPILE_CACHE = "1";
  delete env.NODE_COMPILE_CACHE;

  // Preserve the legacy ownership marker when this preload derives a new run
  // cache from the caller's base-root override.
  const derivesOwnedRoot = !env.BOBBIT_E2E_PWTEST_RUN_CACHE_ROOT?.trim()
    && !env.PWTEST_CACHE_DIR?.trim()
    && Boolean(env.BOBBIT_E2E_PWTEST_CACHE_ROOT?.trim() || env.BOBBIT_PWTEST_CACHE_ROOT?.trim());
  const slot = resolveCacheSlot(env, pid);
  if (!slot) return null;
  env.BOBBIT_E2E_PWTEST_RUN_CACHE_ROOT = slot.root;
  if (derivesOwnedRoot) env.BOBBIT_E2E_PWTEST_CACHE_OWNED = "1";
  env.PWTEST_CACHE_DIR = slot.cacheDir;
  env.BOBBIT_E2E_PWTEST_CACHE_DIR = slot.root;
  try { fs.mkdirSync(slot.cacheDir, { recursive: true }); } catch {}
  return slot;
}

module.exports = { configureTransformCache, resolveCacheSlot };
configureTransformCache();
