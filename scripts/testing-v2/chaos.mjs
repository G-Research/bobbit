#!/usr/bin/env node
/**
 * Chaos comparison proof runner — Test Suite v2.
 *
 * Applies each mutant from tests2/chaos/mutants.json to a clean ephemeral
 * git worktree, runs the targeted legacy + v2 tests, and records caught/missed.
 *
 * Usage:
 *   node scripts/testing-v2/chaos.mjs [--id M01] [--ids M01,M02,...] [--all]
 *   node scripts/testing-v2/chaos.mjs --dry-run    # list mutants, don't run
 *
 * Outputs:
 *   .profiles/chaos/comparison-report.json   full per-mutant matrix
 *   docs/testing-v2/chaos-report.md          committed summary
 *
 * Design decisions (see docs/testing-v2/design.md §6):
 *   - One ephemeral git worktree per mutant (isolated, clean after removal)
 *   - Mutation via string-search/replace (more reliable than unified diffs on Windows)
 *   - node_modules junction from primary repo so the ephemeral worktree can
 *     run tests without a full npm install
 *   - Targeted test runs (seconds per mutant) — never full-suite per mutant
 *   - Null mutant guards harness integrity: both suites must pass
 *   - Full-suite sample for ≥5 random non-null mutants (per spec R8)
 *
 * Mutant result coding:
 *   caught   = targeted test EXIT-CODE ≠ 0  (test detects the injected bug)
 *   missed   = targeted test EXIT-CODE = 0  (test does NOT detect the bug)
 *   invalid  = patch failed to apply (file not found / pattern not matched)
 *   error    = runner infrastructure error (test crashed, worktree error, …)
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Paths ────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// Determine primary repo root: in a worktree, .git is a FILE pointing to the
// real git dir. Walk up until we find a .git DIRECTORY (= primary worktree).
function findPrimaryRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const gitPath = path.join(dir, ".git");
    try {
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory()) return dir; // primary worktree
    } catch { /* skip */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir; // fallback: treat as primary
}

// In a linked worktree, REPO_ROOT is the worktree root; read the .git file to
// find the gitdir, then derive the primary worktree path.
function findPrimaryFromWorktreeGit(repoRoot) {
  const gitFile = path.join(repoRoot, ".git");
  try {
    const stat = fs.statSync(gitFile);
    if (stat.isFile()) {
      // Content: "gitdir: /path/to/.git/worktrees/name"
      const content = fs.readFileSync(gitFile, "utf-8").trim();
      const match = content.match(/^gitdir:\s*(.+)$/);
      if (match) {
        // /path/to/.git/worktrees/<name>  → strip /worktrees/<name> → primary .git dir → parent
        const gitDir = path.resolve(repoRoot, match[1].trim());
        const worktreesIdx = gitDir.lastIndexOf(path.sep + "worktrees" + path.sep);
        if (worktreesIdx !== -1) {
          const primaryGit = gitDir.slice(0, worktreesIdx);
          return path.dirname(primaryGit);
        }
      }
    }
  } catch { /* ignore */ }
  return repoRoot;
}

const PRIMARY_REPO = findPrimaryFromWorktreeGit(REPO_ROOT);

// Locate a node_modules that actually contains the tier-1 toolchain. In-container
// the primary repo's node_modules is complete; on a Windows host the deps may be
// installed per-worktree instead, so fall back to this worktree and sibling
// worktrees. Requires `vitest/vitest.mjs` (the cross-platform JS entry — the
// `.bin/vitest` shim is a POSIX script that `node` cannot execute on Windows).
function hasVitest(nm) {
  try { return fs.existsSync(path.join(nm, "vitest", "vitest.mjs")); } catch { return false; }
}
function resolveToolchainNodeModules() {
  const candidates = [
    path.join(PRIMARY_REPO, "node_modules"),
    path.join(REPO_ROOT, "node_modules"),
  ];
  // Sibling worktrees (…-wt/<branch>/node_modules) and sibling repos.
  for (const base of [path.dirname(REPO_ROOT), path.dirname(PRIMARY_REPO)]) {
    try {
      for (const name of fs.readdirSync(base)) {
        candidates.push(path.join(base, name, "node_modules"));
      }
    } catch { /* ignore */ }
  }
  for (const nm of candidates) {
    if (hasVitest(nm)) return nm;
  }
  return path.join(PRIMARY_REPO, "node_modules"); // last resort (may be incomplete)
}

const PRIMARY_NODE_MODULES = resolveToolchainNodeModules();
// Cross-platform JS entry points (invoked as `node <entry>`), resolved once from
// the toolchain node_modules. `.bin` shims are avoided — they break on Windows.
const VITEST_ENTRY = path.join(PRIMARY_NODE_MODULES, "vitest", "vitest.mjs");
function resolveTsxEntry() {
  for (const rel of [["tsx", "dist", "cli.mjs"], ["tsx", "dist", "cli.js"]]) {
    const p = path.join(PRIMARY_NODE_MODULES, ...rel);
    if (fs.existsSync(p)) return p;
  }
  return null; // tsx not installed here — legacy tier cannot run
}
const TSX_ENTRY = resolveTsxEntry();
const MUTANTS_FILE = path.join(REPO_ROOT, "tests2", "chaos", "mutants.json");
const REPORT_JSON = path.join(REPO_ROOT, ".profiles", "chaos", "comparison-report.json");
const REPORT_MD = path.join(REPO_ROOT, "docs", "testing-v2", "chaos-report.md");

// ── CLI parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let targetIds = null; // null = all
let dryRun = false;
let sampleSize = 5;          // spec R8: ≥5 random mutants get a FULL v2 run
let fullSampleForce = false; // opt-in for targeted (--ids) dev runs
let fullSampleDisable = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--all") { targetIds = null; }
  else if (args[i] === "--dry-run") { dryRun = true; }
  else if (args[i] === "--id" && args[i + 1]) { targetIds = [args[++i]]; }
  else if (args[i] === "--ids" && args[i + 1]) { targetIds = args[++i].split(","); }
  else if (args[i] === "--sample" && args[i + 1]) { sampleSize = Math.max(1, parseInt(args[++i], 10) || 5); }
  else if (args[i] === "--full-sample") { fullSampleForce = true; }
  else if (args[i] === "--no-sample") { fullSampleDisable = true; }
}

// Deterministic (seeded) PRNG so the full-v2 sample selection is reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededSample(items, n, seed = 0xC0FFEE) {
  const rnd = mulberry32(seed);
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, Math.min(n, arr.length));
}

// ── Load mutants ──────────────────────────────────────────────────────────────

const ALL_MUTANTS = JSON.parse(fs.readFileSync(MUTANTS_FILE, "utf-8"));
const mutants = targetIds
  ? ALL_MUTANTS.filter(m => targetIds.includes(m.id))
  : ALL_MUTANTS;

if (dryRun) {
  console.log(`Mutants (${mutants.length}):`);
  for (const m of mutants) {
    const label = m.nullMutant ? " [null]" : "";
    console.log(`  ${m.id}${label}  [${m.area}]  ${m.file}`);
    if (m.expectedLegacyCatchers.length) {
      console.log(`    legacy: ${m.expectedLegacyCatchers.join(", ")}`);
    } else {
      console.log(`    legacy: (none — new v2 coverage)`);
    }
    console.log(`    v2:     ${m.expectedV2Catchers.join(", ") || "(none)"}`);
  }
  process.exit(0);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function applyMutation(filePath, search, replace) {
  const content = fs.readFileSync(filePath, "utf-8");
  // Normalise: the JSON stores \n / \t, which are already escaped correctly.
  // Use string replacement (not regex) to handle special characters safely.
  if (!content.includes(search)) {
    return null; // pattern not found
  }
  // Replace only the FIRST occurrence to limit blast radius.
  const idx = content.indexOf(search);
  const patched = content.slice(0, idx) + replace + content.slice(idx + search.length);
  fs.writeFileSync(filePath, patched, "utf-8");
  return content; // original — caller must restore
}

function ensureNodeModulesJunction(worktreePath) {
  const link = path.join(worktreePath, "node_modules");
  if (fs.existsSync(link)) return; // already present or already a junction
  if (!fs.existsSync(PRIMARY_NODE_MODULES)) {
    console.warn(`[chaos] Warning: primary node_modules not found at ${PRIMARY_NODE_MODULES}`);
    return;
  }
  try {
    // On Windows use 'junction' for directories; on POSIX use 'dir' symlink.
    const type = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(PRIMARY_NODE_MODULES, link, type);
  } catch (err) {
    console.warn(`[chaos] Warning: failed to create node_modules junction: ${err.message}`);
  }
}

function runCommand(file, cliArgs, cwd, timeoutMs = 120_000) {
  const result = spawnSync(file, cliArgs, {
    cwd,
    encoding: "utf-8",
    timeout: timeoutMs,
    shell: process.platform === "win32",
    env: {
      ...process.env,
      // Suppress noise from test infra
      BOBBIT_CHAOS_MUTANT: "1",
      // Avoid ledger side-effects from chaos runs
      BOBBIT_V2_CHAOS: "1",
      // Don't try to start a gateway in targeted unit tests
      BOBBIT_SKIP_AIGW_DISCOVERY: "1",
    },
  });
  return result;
}

// ── Test-name attribution parsers ─────────────────────────────────────────────

/**
 * Parse node:test TAP output for the specific FAILING test case names.
 * Lines look like `not ok 1 - <name>` (optionally indented for subtests).
 * `# SKIP` / `# TODO` directives are not real failures — ignore them.
 */
function parseTapFailures(stdout) {
  const names = [];
  for (const raw of (stdout || "").split(/\r?\n/)) {
    const m = /^\s*not ok \d+ - (.+?)\s*$/.exec(raw);
    if (!m) continue;
    let name = m[1];
    if (/#\s*(SKIP|TODO)\b/i.test(name)) continue;
    // Strip a trailing `# ...` directive/duration comment if present.
    name = name.replace(/\s+#\s.*$/, "").trim();
    if (name) names.push(name);
  }
  return [...new Set(names)];
}

/**
 * Parse a Vitest JSON report (jest-compatible shape) for the specific FAILING
 * test cases. Returns `{ tests: ["<relFile> > <suite> > <title>"], files: [relFile] }`.
 * `relTo` roots the reported absolute file paths back to repo-relative form.
 */
function parseVitestJsonFailures(reportPath, relTo) {
  const out = { tests: [], files: [] };
  let data;
  try { data = JSON.parse(fs.readFileSync(reportPath, "utf-8")); } catch { return out; }
  const fileSet = new Set();
  const testSet = new Set();
  for (const tr of data.testResults || []) {
    let rel = tr.name || "";
    try { rel = path.relative(relTo, tr.name).split(path.sep).join("/"); } catch { /* keep abs */ }
    for (const ar of tr.assertionResults || []) {
      if (ar.status !== "failed") continue;
      fileSet.add(rel);
      const suite = (ar.ancestorTitles || []).join(" > ");
      const label = suite ? `${rel} > ${suite} > ${ar.title}` : `${rel} > ${ar.title}`;
      testSet.add(label);
    }
  }
  out.tests = [...testSet];
  out.files = [...fileSet];
  return out;
}

/**
 * Run a single targeted test file.
 * Returns { exitCode, stdout, stderr, timedOut, failingTests, failingFiles }.
 */
function runTargetedTest(worktreePath, testFile, tier) {
  if (!testFile) return null;
  const absFile = path.join(worktreePath, testFile);
  if (!fs.existsSync(absFile)) {
    return { exitCode: -1, stdout: "", stderr: `Test file not found: ${testFile}`, timedOut: false, failingTests: [], failingFiles: [] };
  }

  if (tier === "legacy") {
    // Legacy node:test suite — uses the tsx loader (cross-platform JS entry).
    if (!TSX_ENTRY) {
      return { exitCode: -1, stdout: "", stderr: "tsx not installed in the toolchain node_modules — legacy tier cannot run here (run in the in-container tier-1 environment)", timedOut: false, failingTests: [], failingFiles: [] };
    }
    const cssStub = path.join(worktreePath, "tests", "helpers", "css-stub-loader.mjs");
    const importArgs = fs.existsSync(cssStub) ? ["--import", "./tests/helpers/css-stub-loader.mjs"] : [];
    const cliArgs = [TSX_ENTRY, ...importArgs, "--test", "--test-force-exit", testFile];
    const result = runCommand("node", cliArgs, worktreePath);
    const stdout = result.stdout || "";
    return {
      exitCode: result.status ?? (result.error ? 1 : 0),
      stdout,
      stderr: result.stderr || "",
      timedOut: result.signal === "SIGTERM",
      failingTests: parseTapFailures(stdout),
      failingFiles: [testFile],
    };
  }

  if (tier === "v2") {
    // Vitest tier-1 (core / dom / integration). Emit a JSON report so we can
    // attribute the kill to the specific failing test case (not just exit code).
    const configPath = path.join(worktreePath, "vitest.config.ts");
    const reportPath = path.join(worktreePath, `.chaos-vitest-${Date.now()}.json`);
    const cliArgs = [VITEST_ENTRY, "run", "--config", configPath,
      "--reporter=json", `--outputFile=${reportPath}`, testFile];
    // Generous timeout: the FIRST vitest run in a fresh worktree pays a cold
    // SSR-transform tax on the src graph (tens of seconds) before the shared
    // node_modules/.vite cache warms up.
    const result = runCommand("node", cliArgs, worktreePath, 300_000);
    const parsed = parseVitestJsonFailures(reportPath, worktreePath);
    try { fs.rmSync(reportPath, { force: true }); } catch { /* ignore */ }
    return {
      exitCode: result.status ?? (result.error ? 1 : 0),
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      timedOut: result.signal === "SIGTERM",
      failingTests: parsed.tests,
      failingFiles: parsed.files,
    };
  }

  return { exitCode: -1, stdout: "", stderr: `Unknown tier: ${tier}`, timedOut: false, failingTests: [], failingFiles: [] };
}

/**
 * Run the FULL v2 tier-1 suite (all core + dom tests, NOT just the targeted
 * file) against an already-mutated worktree and report which test cases fail.
 * This is spec R8's over-narrow-targeting guard: a kill by a NON-listed test
 * still counts and updates the corpus entry's expectedV2Catchers.
 *
 * Scope: the `v2-core`, `v2-core-isolated`, and `v2-dom` projects. The
 * `v2-integration` project boots a real gateway per fork and is excluded here
 * for cost — its coverage is exercised by the per-file targeted integration
 * runs. Running every core+dom test (hundreds of files) is unambiguously the
 * "full suite, not just the targeted file" the sample check requires.
 */
function runFullV2Suite(worktreePath) {
  const configPath = path.join(worktreePath, "vitest.config.ts");
  const reportPath = path.join(worktreePath, `.chaos-fullv2-${Date.now()}.json`);
  const cliArgs = [VITEST_ENTRY, "run", "--config", configPath,
    "--project", "v2-core", "--project", "v2-core-isolated", "--project", "v2-dom",
    "--reporter=json", `--outputFile=${reportPath}`];
  const result = runCommand("node", cliArgs, worktreePath, 360_000);
  const parsed = parseVitestJsonFailures(reportPath, worktreePath);
  try { fs.rmSync(reportPath, { force: true }); } catch { /* ignore */ }
  return {
    exitCode: result.status ?? (result.error ? 1 : 0),
    timedOut: result.signal === "SIGTERM",
    failingTests: parsed.tests,
    failingFiles: parsed.files,
    stderr: (result.stderr || "").slice(-500),
  };
}

// ── Worktree management ───────────────────────────────────────────────────────

function createEphemeralWorktree(label) {
  const tmpDir = path.join(os.tmpdir(), `bobbit-chaos-${label}-${Date.now()}`);
  try {
    execFileSync("git", ["worktree", "add", "--detach", tmpDir, "HEAD"],
      { cwd: REPO_ROOT, stdio: "pipe" });
    return tmpDir;
  } catch (err) {
    throw new Error(`git worktree add failed: ${err.stderr || err.message}`);
  }
}

function removeEphemeralWorktree(worktreePath) {
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktreePath],
      { cwd: REPO_ROOT, stdio: "pipe" });
  } catch {
    // Best-effort cleanup — rm if git worktree remove fails
    try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── Run one mutant ────────────────────────────────────────────────────────────

async function runMutant(mutant) {
  const start = Date.now();
  console.log(`\n[chaos] Running ${mutant.id} [${mutant.area}]...`);
  console.log(`  file: ${mutant.file}`);

  // 1. Create ephemeral worktree
  let worktreePath;
  try {
    worktreePath = createEphemeralWorktree(mutant.id.replace(/[^a-z0-9]/gi, "-"));
  } catch (err) {
    console.error(`  WORKTREE ERROR: ${err.message}`);
    return buildResult(mutant, "error", "error", `worktree: ${err.message}`, Date.now() - start);
  }

  try {
    // 2. Ensure node_modules is accessible
    ensureNodeModulesJunction(worktreePath);

    // 3. Apply the mutation
    const targetFile = path.join(worktreePath, mutant.file);
    if (!fs.existsSync(targetFile)) {
      return buildResult(mutant, "invalid", "invalid",
        `File not found: ${mutant.file}`, Date.now() - start);
    }

    const original = applyMutation(targetFile, mutant.search, mutant.replace);
    if (original === null) {
      return buildResult(mutant, "invalid", "invalid",
        `Search pattern not found in ${mutant.file}`, Date.now() - start);
    }
    console.log(`  mutation applied ✓`);

    // 4. Clean-tree assertion — ensure only the expected file changed
    const diffResult = spawnSync("git", ["diff", "--name-only"],
      { cwd: worktreePath, encoding: "utf-8" });
    const changedFiles = (diffResult.stdout || "").trim().split("\n").filter(Boolean);
    if (changedFiles.length > 1 || (changedFiles.length === 1 && changedFiles[0] !== mutant.file)) {
      console.warn(`  WARNING: unexpected files changed: ${changedFiles.join(", ")}`);
    }

    // 5. Run legacy test
    let legacyResult = "skipped";
    let legacyDetail = "no legacy catcher";
    let legacyDurationMs = 0;
    let legacyCatchTests = [];
    if (mutant.expectedLegacyCatchers.length > 0) {
      const legacyFile = mutant.expectedLegacyCatchers[0];
      console.log(`  legacy: ${legacyFile}`);
      const t0 = Date.now();
      const r = runTargetedTest(worktreePath, legacyFile, "legacy");
      legacyDurationMs = Date.now() - t0;
      if (r && r.failingTests) legacyCatchTests = r.failingTests;
      if (r === null) {
        legacyResult = "skipped";
        legacyDetail = "no catcher";
      } else if (r.exitCode === -1) {
        legacyResult = "error";
        legacyDetail = r.stderr.slice(0, 300);
      } else if (r.timedOut) {
        legacyResult = "error"; legacyDetail = "timed out";
      } else if (r.exitCode === 0) {
        legacyResult = "missed"; legacyDetail = `exit 0 — mutant MISSED (${legacyDurationMs}ms)`;
      } else if (legacyCatchTests.length > 0) {
        // Real kill: process failed AND we can name the failing test case.
        legacyResult = "caught";
        legacyDetail = `exit ${r.exitCode} — killed by "${legacyCatchTests[0]}" (${legacyDurationMs}ms)`;
      } else {
        // Non-zero exit with NO parsed TAP failure ⇒ the runner never actually
        // ran the tests (startup/import crash). Not a kill — inconclusive.
        legacyResult = "error";
        legacyDetail = `exit ${r.exitCode} but NO attributed test failure — harness/startup error (${legacyDurationMs}ms)`;
      }
      console.log(`  legacy: ${legacyResult}  (${legacyDurationMs}ms)`);
    } else {
      console.log(`  legacy: skipped (no catcher — new v2 coverage)`);
    }

    // 6. Run v2 test
    let v2Result = "skipped";
    let v2Detail = "no v2 catcher";
    let v2DurationMs = 0;
    let v2CatchTests = [];
    if (mutant.expectedV2Catchers.length > 0) {
      const v2File = mutant.expectedV2Catchers[0];
      console.log(`  v2:     ${v2File}`);
      const t0 = Date.now();
      const r = runTargetedTest(worktreePath, v2File, "v2");
      v2DurationMs = Date.now() - t0;
      if (r && r.failingTests) v2CatchTests = r.failingTests;
      if (r === null) {
        v2Result = "skipped";
        v2Detail = "no catcher";
      } else if (r.exitCode === -1) {
        v2Result = "error";
        v2Detail = r.stderr.slice(0, 300);
      } else if (r.timedOut) {
        v2Result = "error"; v2Detail = "timed out";
      } else if (r.exitCode === 0) {
        v2Result = "missed"; v2Detail = `exit 0 — mutant MISSED (${v2DurationMs}ms)`;
      } else if (v2CatchTests.length > 0) {
        // Real kill: non-zero exit AND an attributed failing test case.
        v2Result = "caught";
        v2Detail = `exit ${r.exitCode} — killed by "${v2CatchTests[0]}" (${v2DurationMs}ms)`;
      } else {
        // Non-zero exit but the Vitest JSON report named no failing test ⇒ the
        // suite never ran (config/startup crash). Not a kill — inconclusive.
        v2Result = "error";
        v2Detail = `exit ${r.exitCode} but NO attributed test failure — harness/startup error (${v2DurationMs}ms)`;
      }
      console.log(`  v2:     ${v2Result}  (${v2DurationMs}ms)`);
    } else {
      console.log(`  v2:     skipped (no catcher)`);
    }

    // 7. Null-mutant check: both suites must PASS (exit 0)
    if (mutant.nullMutant) {
      const nullOk = (legacyResult === "missed" || legacyResult === "skipped" || legacyResult === "error") &&
                     (v2Result === "missed" || v2Result === "skipped" || v2Result === "error");
      if (!nullOk) {
        console.error(`  ❌ NULL MUTANT INTEGRITY FAILURE — suites failed on a no-op patch!`);
        console.error(`     legacy=${legacyResult}  v2=${v2Result}`);
      } else {
        console.log(`  ✓ null mutant harness check passed`);
      }
    }

    // Attribution honesty: a kill with no named failing test is UNATTRIBUTED.
    if (v2Result === "caught" && v2CatchTests.length === 0) {
      console.warn(`  ⚠️ v2 kill is UNATTRIBUTED (exit≠0 but no failing test name parsed)`);
    } else if (v2Result === "caught") {
      console.log(`  v2 killed by: ${v2CatchTests[0]}${v2CatchTests.length > 1 ? ` (+${v2CatchTests.length - 1})` : ""}`);
    }

    return buildResult(mutant, legacyResult, v2Result,
      `legacy: ${legacyDetail} | v2: ${v2Detail}`, Date.now() - start,
      { legacyCatchTests, v2CatchTests });

  } finally {
    // Always remove the ephemeral worktree
    removeEphemeralWorktree(worktreePath);
  }
}

function buildResult(mutant, legacyResult, v2Result, detail, durationMs, attribution = {}) {
  return {
    id: mutant.id,
    area: mutant.area,
    file: mutant.file,
    description: mutant.description,
    nullMutant: mutant.nullMutant || false,
    legacyResult,
    v2Result,
    legacyCatchers: mutant.expectedLegacyCatchers,
    v2Catchers: mutant.expectedV2Catchers,
    // Test-name-level kill attribution (spec: unattributed kills are a FAIL).
    legacyCatchTests: attribution.legacyCatchTests || [],
    v2CatchTests: attribution.v2CatchTests || [],
    detail,
    durationMs,
    timestamp: new Date().toISOString(),
  };
}

// ── Full-v2 sample check (spec R8) ──────────────────────────────────────

/**
 * For one sampled mutant: fresh worktree → apply mutation → run the FULL v2
 * tier-1 suite → confirm it is still killed and by which test(s). Returns a
 * record; when a NON-listed test file caught the mutant, `newCatchers` lists
 * the additions so the caller can update the corpus entry.
 */
async function runFullV2SampleOne(mutant) {
  const start = Date.now();
  let worktreePath;
  try {
    worktreePath = createEphemeralWorktree(`fullv2-${mutant.id.replace(/[^a-z0-9]/gi, "-")}`);
  } catch (err) {
    return { id: mutant.id, area: mutant.area, killed: false, error: `worktree: ${err.message}`, durationMs: Date.now() - start };
  }
  try {
    ensureNodeModulesJunction(worktreePath);
    const targetFile = path.join(worktreePath, mutant.file);
    if (!fs.existsSync(targetFile)) {
      return { id: mutant.id, area: mutant.area, killed: false, error: `file not found: ${mutant.file}`, durationMs: Date.now() - start };
    }
    const original = applyMutation(targetFile, mutant.search, mutant.replace);
    if (original === null) {
      return { id: mutant.id, area: mutant.area, killed: false, error: `pattern not found`, durationMs: Date.now() - start };
    }
    console.log(`\n[chaos] full-v2 sample: ${mutant.id} [${mutant.area}] — running full core+dom tier…`);
    const r = runFullV2Suite(worktreePath);
    // A real kill must name a failing test — a bare non-zero exit with no
    // attributed failure is a harness/startup error, not a kill.
    const killed = !r.timedOut && r.failingTests.length > 0;
    const listed = new Set(mutant.expectedV2Catchers || []);
    const newCatchers = r.failingFiles.filter(f => !listed.has(f));
    console.log(`  full-v2: ${killed ? "KILLED" : "SURVIVED"} by ${r.failingFiles.length} file(s)` +
      (newCatchers.length ? ` (+${newCatchers.length} non-listed)` : "") + `  (${((Date.now() - start) / 1000).toFixed(1)}s)`);
    return {
      id: mutant.id,
      area: mutant.area,
      killed,
      timedOut: r.timedOut,
      exitCode: r.exitCode,
      failingFiles: r.failingFiles,
      failingTests: r.failingTests.slice(0, 8),
      failingTestCount: r.failingTests.length,
      newCatchers,
      durationMs: Date.now() - start,
    };
  } finally {
    removeEphemeralWorktree(worktreePath);
  }
}

// ── Report generation ──────────────────────────────────────────────────────────

function generateMarkdownReport(results, runMeta) {
  const lines = [
    "# Chaos Comparison Proof — Test Suite v2",
    "",
    `Generated: ${runMeta.date}  |  Run duration: ${(runMeta.totalDurationMs / 1000).toFixed(1)}s`,
    "",
    "## Summary",
    "",
  ];

  const contentMutants = results.filter(r => !r.nullMutant);
  const nullMutants = results.filter(r => r.nullMutant);

  const legacyCaught = contentMutants.filter(r => r.legacyResult === "caught").length;
  const v2Caught = contentMutants.filter(r => r.v2Result === "caught").length;
  const legacySkipped = contentMutants.filter(r => r.legacyResult === "skipped").length;
  const v2Skipped = contentMutants.filter(r => r.v2Result === "skipped").length;
  const legacyMissed = contentMutants.filter(r => r.legacyResult === "missed").length;
  const v2Missed = contentMutants.filter(r => r.v2Result === "missed").length;
  const legacyInvalid = contentMutants.filter(r => r.legacyResult === "invalid" || r.legacyResult === "error").length;
  const v2Invalid = contentMutants.filter(r => r.v2Result === "invalid" || r.v2Result === "error").length;

  const total = contentMutants.length;
  const legacyKillable = contentMutants.filter(r => r.legacyCatchers.length > 0).length;
  const v2Killable = contentMutants.filter(r => r.v2Catchers.length > 0).length;
  const legacyKillRate = legacyKillable > 0 ? ((legacyCaught / legacyKillable) * 100).toFixed(1) : "N/A";
  const v2KillRate = v2Killable > 0 ? ((v2Caught / v2Killable) * 100).toFixed(1) : "N/A";

  lines.push(`| Metric | Legacy suite | V2 suite |`);
  lines.push(`|--------|-------------|---------|`);
  lines.push(`| Total content mutants | ${total} | ${total} |`);
  lines.push(`| With targeted catchers | ${legacyKillable} | ${v2Killable} |`);
  lines.push(`| Caught (exit ≠ 0) | ${legacyCaught} | ${v2Caught} |`);
  lines.push(`| Missed (exit = 0) | ${legacyMissed} | ${v2Missed} |`);
  lines.push(`| Skipped (no catcher) | ${legacySkipped} | ${v2Skipped} |`);
  lines.push(`| Error/invalid | ${legacyInvalid} | ${v2Invalid} |`);
  lines.push(`| **Kill rate (of killable)** | **${legacyKillRate}%** | **${v2KillRate}%** |`);
  lines.push("");

  // Null mutant check
  const nullOk = nullMutants.every(r =>
    (r.legacyResult === "missed" || r.legacyResult === "skipped") &&
    (r.v2Result === "missed" || r.v2Result === "skipped")
  );
  lines.push(`**Null mutant harness check:** ${nullOk ? "✅ PASSED" : "❌ FAILED"}`);
  lines.push("");

  // Acceptance criteria
  lines.push("## Acceptance Criteria");
  lines.push("");

  const v2CatchesAllLegacyCaught = contentMutants.every(r => {
    if (r.legacyResult !== "caught") return true; // legacy didn't catch — not a requirement
    return r.v2Result === "caught";
  });
  lines.push(`- **v2 catches every legacy-caught mutant:** ${v2CatchesAllLegacyCaught ? "✅ PASS" : "❌ FAIL"}`);

  const v2KillRateNum = v2Killable > 0 ? v2Caught / v2Killable : 1;
  const legacyKillRateNum = legacyKillable > 0 ? legacyCaught / legacyKillable : 0;
  const v2KillRateGeq = v2KillRateNum >= legacyKillRateNum;
  lines.push(`- **v2 kill rate ≥ legacy overall:** ${v2KillRateGeq ? "✅ PASS" : "❌ FAIL"} (v2 ${(v2KillRateNum*100).toFixed(1)}% vs legacy ${(legacyKillRateNum*100).toFixed(1)}%)`);

  const bothMissed = contentMutants.filter(r =>
    r.legacyResult === "missed" && r.v2Result === "missed"
  );
  if (bothMissed.length > 0) {
    lines.push(`- **Both-missed gaps (need new tests or justification):** ❌ ${bothMissed.length} mutant(s):`);
    for (const r of bothMissed) {
      lines.push(`  - ${r.id}: ${r.description}`);
    }
  } else {
    lines.push(`- **Both-missed gaps:** ✅ None`);
  }

  // Test-name-level attribution: every v2 kill must name a failing test case.
  const v2Kills = contentMutants.filter(r => r.v2Result === "caught");
  const unattributed = v2Kills.filter(r => !(r.v2CatchTests && r.v2CatchTests.length > 0));
  if (unattributed.length > 0) {
    lines.push(`- **All v2 kills attributed to a specific test case:** ❌ ${unattributed.length} unattributed:`);
    for (const r of unattributed) lines.push(`  - ${r.id}`);
  } else {
    lines.push(`- **All v2 kills attributed to a specific test case:** ✅ PASS (${v2Kills.length}/${v2Kills.length})`);
  }

  // Full-v2 sample (spec R8).
  const sample = runMeta.fullV2Sample || [];
  if (sample.length > 0) {
    const killed = sample.filter(s => s.killed).length;
    const ok = killed === sample.length && sample.length >= Math.min(5, v2Kills.length);
    lines.push(`- **Full-v2 sample re-kill (≥5 mutants, non-narrow targeting):** ${ok ? "✅ PASS" : "❌ FAIL"} (${killed}/${sample.length} re-killed by the full core+dom tier)`);
  } else {
    lines.push(`- **Full-v2 sample re-kill:** — not run this invocation (run with \`--all\` or \`--full-sample\`)`);
  }
  lines.push("");

  // Per-area summary
  lines.push("## Per-area Kill Rates");
  lines.push("");
  lines.push("| Area | Mutants | Legacy caught | V2 caught |");
  lines.push("|------|---------|---------------|-----------|");

  const areas = [...new Set(contentMutants.map(r => r.area))];
  for (const area of areas) {
    const areaResults = contentMutants.filter(r => r.area === area);
    const lc = areaResults.filter(r => r.legacyResult === "caught").length;
    const vc = areaResults.filter(r => r.v2Result === "caught").length;
    lines.push(`| ${area} | ${areaResults.length} | ${lc} | ${vc} |`);
  }
  lines.push("");

  // Full matrix (with test-name-level kill attribution)
  lines.push("## Full Mutant Matrix");
  lines.push("");
  lines.push("| ID | Area | File | Legacy | V2 | Killed by (v2 test case) | Duration |");
  lines.push("|----|------|------|--------|-----|--------------------------|----------|");
  for (const r of results) {
    const nullTag = r.nullMutant ? " *(null)*" : "";
    const legacyIcon = { caught: "🔴", missed: "⚪", skipped: "—", error: "⚠️", invalid: "⛔" }[r.legacyResult] || "?";
    const v2Icon = { caught: "🔴", missed: "⚪", skipped: "—", error: "⚠️", invalid: "⛔" }[r.v2Result] || "?";
    let killedBy = "—";
    if (r.v2Result === "caught") {
      const t = (r.v2CatchTests && r.v2CatchTests[0]) || "";
      killedBy = t ? `\`${t.replace(/\|/g, "\\|")}\`${r.v2CatchTests.length > 1 ? ` (+${r.v2CatchTests.length - 1})` : ""}` : "⚠️ unattributed";
    }
    lines.push(`| ${r.id}${nullTag} | ${r.area} | \`${r.file}\` | ${legacyIcon} ${r.legacyResult} | ${v2Icon} ${r.v2Result} | ${killedBy} | ${(r.durationMs/1000).toFixed(1)}s |`);
  }
  lines.push("");
  lines.push("**Icon key:** 🔴 caught (test fails on mutant) | ⚪ missed | — skipped (no targeted catcher) | ⚠️ error | ⛔ invalid (patch failed)");
  lines.push("");

  // Full-v2 sample detail (spec R8).
  if (sample.length > 0) {
    lines.push("## Full-v2 Sample (spec R8 — over-narrow-targeting guard)");
    lines.push("");
    lines.push("Each sampled mutant is re-run against the FULL v2 core+dom tier (every test, not just the targeted file). A kill by a non-listed test still counts and back-fills `expectedV2Catchers`.");
    lines.push("");
    lines.push("| Mutant | Area | Re-killed by full tier | Failing test files | New (non-listed) catchers | Duration |");
    lines.push("|--------|------|------------------------|--------------------|---------------------------|----------|");
    for (const s of sample) {
      const status = s.error ? `⚠️ ${s.error}` : (s.killed ? "✅ yes" : "❌ SURVIVED");
      const files = (s.failingFiles || []).map(f => `\`${f}\``).join("<br>") || "—";
      const news = (s.newCatchers || []).map(f => `\`${f}\``).join("<br>") || "—";
      lines.push(`| ${s.id} | ${s.area} | ${status} | ${files} | ${news} | ${((s.durationMs||0)/1000).toFixed(1)}s |`);
    }
    lines.push("");
  }

  // Coverage gap notes
  const newV2Coverage = contentMutants.filter(r => r.legacyResult === "skipped" && r.v2Result === "caught");
  if (newV2Coverage.length > 0) {
    lines.push("## New V2 Coverage (not in legacy)");
    lines.push("");
    lines.push("These mutants are caught by v2 but have no legacy targeted catcher, demonstrating new coverage:");
    lines.push("");
    for (const r of newV2Coverage) {
      lines.push(`- **${r.id}** (${r.area}): ${r.description}`);
    }
    lines.push("");
  }

  // Methodology
  lines.push("## Methodology");
  lines.push("");
  lines.push("- Each mutant is a single search/replace change to a `src/` or `tests2/harness/` file");
  lines.push("- Applied in an ephemeral git worktree (`git worktree add --detach`), never leaking to the branch");
  lines.push("- Targeted test runs (one file each for legacy and v2) — not full-suite × mutant");
  lines.push("- `caught` = test file exits non-0; `missed` = test file exits 0 (bug not detected)");
  lines.push("- Null mutant: no-op patch; both suites must EXIT 0 (guards against a broken harness)");
  lines.push("- **Test-name attribution:** the specific failing test case is parsed from the runner output (Vitest JSON report for v2, TAP `not ok` lines for legacy) — an unattributed kill is a FAIL criterion");
  lines.push("- **Full-v2 sample (R8):** ≥5 random killed mutants are additionally re-run against the entire core+dom tier; a kill by a non-listed test still counts and back-fills `expectedV2Catchers`");
  lines.push("");
  lines.push(`*Run by: ${runMeta.runner || "chaos.mjs"}  |  Corpus: tests2/chaos/mutants.json*`);

  return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const totalStart = Date.now();
  console.log(`\n╔═══════════════════════════════════════════════════╗`);
  console.log(`║         Bobbit Chaos Comparison Proof             ║`);
  console.log(`╚═══════════════════════════════════════════════════╝`);
  console.log(`Repo root:    ${REPO_ROOT}`);
  console.log(`Primary repo: ${PRIMARY_REPO}`);
  console.log(`Mutants:      ${mutants.length} (of ${ALL_MUTANTS.length} total)`);
  console.log(`toolchain nm: ${PRIMARY_NODE_MODULES}`);
  console.log(`vitest entry: ${fs.existsSync(VITEST_ENTRY) ? "✓ " + VITEST_ENTRY : "✗ MISSING"}`);
  console.log(`tsx entry:    ${TSX_ENTRY ? "✓ " + TSX_ENTRY : "✗ not installed — legacy tier will report 'error'"}`);

  // Preflight: ensure the v2 toolchain (vitest) is resolvable.
  if (!fs.existsSync(VITEST_ENTRY)) {
    console.error("\n[chaos] ERROR: Could not locate vitest/vitest.mjs in any candidate node_modules.");
    console.error("  Run this in the tier-1 toolchain environment (in-container) or a worktree with a full `npm ci`.");
    process.exit(1);
  }
  if (!TSX_ENTRY) {
    console.warn("\n[chaos] WARNING: tsx is not installed here — the LEGACY tier cannot run, so the");
    console.warn("  legacy-vs-v2 comparison will be incomplete. Run the full campaign in-container.");
  }

  fs.mkdirSync(path.dirname(REPORT_JSON), { recursive: true });
  fs.mkdirSync(path.dirname(REPORT_MD), { recursive: true });

  const results = [];
  for (const mutant of mutants) {
    const result = await runMutant(mutant);
    results.push(result);

    // Stream partial results after each mutant
    const partial = {
      meta: { date: new Date().toISOString(), partial: true },
      results,
    };
    fs.writeFileSync(REPORT_JSON, JSON.stringify(partial, null, 2), "utf-8");
  }

  // ── Full-v2 sample check (spec R8) ─────────────────────────────────────
  // Runs the FULL core+dom tier for ≥5 random killed mutants to prove the
  // targeted catcher selection is not over-narrow; a kill by a non-listed test
  // still counts and back-fills that mutant's expectedV2Catchers.
  const runSample = !fullSampleDisable && (targetIds === null || fullSampleForce);
  let fullV2Sample = [];
  let corpusUpdated = false;
  if (runSample) {
    const eligible = results.filter(r => !r.nullMutant && r.v2Result === "caught");
    if (eligible.length === 0) {
      console.log("\n[chaos] full-v2 sample: skipped (no v2-caught mutants to sample)");
    } else {
      const chosenIds = new Set(seededSample(eligible.map(r => r.id), sampleSize).map(String));
      const chosen = ALL_MUTANTS.filter(m => chosenIds.has(m.id));
      console.log(`\n[chaos] full-v2 sample: ${chosen.length} mutant(s) → ${chosen.map(m => m.id).join(", ")}`);
      for (const mutant of chosen) {
        const rec = await runFullV2SampleOne(mutant);
        fullV2Sample.push(rec);
        // Back-fill expectedV2Catchers with any non-listed catcher file.
        if (rec.newCatchers && rec.newCatchers.length > 0) {
          const set = new Set(mutant.expectedV2Catchers || []);
          for (const f of rec.newCatchers) set.add(f);
          mutant.expectedV2Catchers = [...set];
          corpusUpdated = true;
          console.log(`  ↳ corpus: expectedV2Catchers of ${mutant.id} += [${rec.newCatchers.join(", ")}]`);
        }
      }
      if (corpusUpdated) {
        fs.writeFileSync(MUTANTS_FILE, JSON.stringify(ALL_MUTANTS, null, 2) + "\n", "utf-8");
        console.log(`[chaos] corpus updated with newly-discovered catchers: ${MUTANTS_FILE}`);
      }
    }
  }

  const totalDurationMs = Date.now() - totalStart;
  const sampleKilled = fullV2Sample.filter(s => s.killed).length;
  const runMeta = {
    date: new Date().toISOString(),
    totalDurationMs,
    mutantCount: mutants.length,
    runner: "chaos.mjs",
    partial: false,
    fullV2Sample,
    fullV2SampleSummary: {
      requested: sampleSize,
      run: fullV2Sample.length,
      killed: sampleKilled,
      survived: fullV2Sample.length - sampleKilled,
      corpusUpdated,
    },
  };

  // Final JSON report
  const report = { meta: runMeta, results };
  fs.writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2), "utf-8");
  console.log(`\nReport: ${REPORT_JSON}`);

  // Markdown summary
  const md = generateMarkdownReport(results, runMeta);
  fs.writeFileSync(REPORT_MD, md, "utf-8");
  console.log(`Report: ${REPORT_MD}`);

  // Print summary
  const contentMutants = results.filter(r => !r.nullMutant);
  const v2Caught = contentMutants.filter(r => r.v2Result === "caught").length;
  const v2Killable = contentMutants.filter(r => r.v2Catchers.length > 0).length;
  const legacyCaught = contentMutants.filter(r => r.legacyResult === "caught").length;
  const legacyKillable = contentMutants.filter(r => r.legacyCatchers.length > 0).length;
  const invalid = results.filter(r => r.legacyResult === "invalid" || r.v2Result === "invalid").length;
  const errors = results.filter(r => r.legacyResult === "error" || r.v2Result === "error").length;

  console.log(`\n╔═══ RESULTS ════════════════════════════════════════╗`);
  console.log(`║ Content mutants: ${contentMutants.length.toString().padEnd(33)}║`);
  console.log(`║ Legacy kill rate: ${v2Killable > 0 ? (legacyCaught + "/" + legacyKillable) : "N/A"}${" ".repeat(31 - String(legacyKillable > 0 ? legacyCaught + "/" + legacyKillable : "N/A").length)}║`);
  console.log(`║ V2 kill rate:    ${v2Killable > 0 ? (v2Caught + "/" + v2Killable) : "N/A"}${" ".repeat(32 - String(v2Killable > 0 ? v2Caught + "/" + v2Killable : "N/A").length)}║`);
  if (invalid) console.log(`║ Invalid patches: ${invalid}${" ".repeat(32 - String(invalid).length)}║`);
  if (errors) console.log(`║ Errors:          ${errors}${" ".repeat(32 - String(errors).length)}║`);
  console.log(`║ Duration: ${(totalDurationMs / 1000).toFixed(1)}s${" ".repeat(37 - (totalDurationMs / 1000).toFixed(1).length)}║`);
  console.log(`╚═══════════════════════════════════════════════════╝`);

  // Exit non-0 if any null mutant failed (both suites must pass/skip)
  const nullFailed = results.some(r => r.nullMutant && (
    !(r.legacyResult === "missed" || r.legacyResult === "skipped") ||
    !(r.v2Result === "missed" || r.v2Result === "skipped")
  ));
  if (nullFailed) {
    console.error("\n❌ NULL MUTANT INTEGRITY CHECK FAILED — harness may be broken");
    process.exit(1);
  }

  // Success even if some mutants are missed — the report documents them
  console.log("\n✓ chaos.mjs complete");
}

main().catch(err => {
  console.error("[chaos] Fatal error:", err);
  process.exit(1);
});
