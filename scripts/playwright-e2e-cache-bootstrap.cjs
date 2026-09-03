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

function serialCacheRequested(env) {
  return env.BOBBIT_V2_E2E_SERIAL_CACHE === "1"
    && env.BOBBIT_E2E_PWTEST_CACHE_OWNED === "1";
}

/** Resolve a cache slot without mutating the supplied environment. */
function resolveCacheSlot(env = process.env, pid = process.pid) {
  let root = requestedRunCacheRoot(env, pid);
  if (!root) return null;

  if (serialCacheRequested(env)) {
    const runRoot = env.BOBBIT_V2_RUN_ROOT?.trim();
    // Playwright assigns TEST_WORKER_INDEX/TEST_PARALLEL_INDEX inside WorkerMain,
    // after this Node preload has run and after its transform cache has loaded.
    // A PID slot therefore isolates every concurrently writable process while
    // still leaving completed phase-B slots available for the serial handoff.
    if (runRoot && !isStrictChild(runRoot, root)) {
      root = path.join(path.resolve(runRoot), "pwtest-transform-cache");
    }
    if (runRoot && isStrictChild(runRoot, root)) {
      return { root, cacheDir: path.join(root, `process-${sanitizeSegment(pid)}`) };
    }
  }

  // Flag-off behaviour remains the legacy per-process layout.
  const workerId = env.TEST_WORKER_INDEX || env.PW_TEST_WORKER_INDEX || env.TEST_PARALLEL_INDEX;
  const role = workerId ? `worker-${sanitizeSegment(workerId)}` : "runner";
  return { root, cacheDir: path.join(root, `${role}-${pid}`) };
}

function isPlaywrightTransformProcess(argv) {
  const entry = path.resolve(String(argv?.[1] || ""));
  return entry.endsWith(path.join("playwright", "cli.js"))
    || entry.endsWith(path.join("playwright", "lib", "worker", "workerProcessEntry.js"))
    || entry.endsWith(path.join("playwright", "lib", "loader", "loaderProcessEntry.js"));
}

function seedSerialCache(env, cacheDir, argv) {
  if (!serialCacheRequested(env) || !isPlaywrightTransformProcess(argv)) return false;
  const runRoot = env.BOBBIT_V2_RUN_ROOT?.trim();
  const requestedSeed = env.BOBBIT_V2_E2E_SERIAL_CACHE_SEED?.trim();
  if (!runRoot || !requestedSeed) return false;
  try {
    const seed = fs.realpathSync(requestedSeed);
    const ownedRoot = fs.realpathSync(runRoot);
    if (!isStrictChild(ownedRoot, seed) || path.resolve(seed) === path.resolve(cacheDir)) return false;
    // The snapshot is immutable after B exits. Each C process copies it into
    // its own PID slot, and existing content-addressed entries always win.
    fs.cpSync(seed, cacheDir, { recursive: true, force: false, errorOnExist: false });
    return true;
  } catch {
    // Cache reuse is optional; containment, lookup, or copy failure is a cold
    // unique cache, never a test failure or a reason to share a writable slot.
    return false;
  }
}

function configureTransformCache(env = process.env, pid = process.pid, argv = process.argv) {
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
  const seeded = seedSerialCache(env, slot.cacheDir, argv);
  if (env.BOBBIT_DEBUG_PWTEST_CACHE === "1") {
    console.error(`[e2e-cache] pid=${pid} cache=${slot.cacheDir} seed=${seeded ? "warm" : "cold"}`);
  }
  return slot;
}

module.exports = { configureTransformCache, resolveCacheSlot };
configureTransformCache();
