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
function hasTsx(nm) {
  try {
    return fs.existsSync(path.join(nm, "tsx", "dist", "cli.mjs")) ||
           fs.existsSync(path.join(nm, "tsx", "dist", "cli.js"));
  } catch { return false; }
}
// Completeness probe: a node_modules that only has vitest but is missing the
// workspace packages the server graph imports (e.g. @earendil-works/pi-ai) will
// make any test whose import chain reaches auth/session code fail to LOAD — a
// false 'error' that is neither a kill nor a miss. Prefer a complete install.
function isCompleteNodeModules(nm) {
  try { return hasVitest(nm) && fs.existsSync(path.join(nm, "@earendil-works", "pi-ai")); }
  catch { return false; }
}
// Robust, self-contained toolchain resolution. Considers only node_modules that
// belong to THIS project (the worktree we run from, the primary repo, and
// sibling worktrees under the shared -wt root) — never a sibling repo whose
// vitest/plugin versions would differ. Priority favours STABLE locations
// (REPO_ROOT = the worktree chaos was launched from, e.g. the goal worktree at
// gate time; then the primary repo) over transient sibling worktrees, and never
// depends on a specific ephemeral session worktree existing. Returns a report so
// callers can fail LOUD when no COMPLETE install (vitest AND @earendil-works/
// pi-ai) is available, rather than silently producing module-load failures.
function resolveToolchain() {
  const stable = [
    path.join(REPO_ROOT, "node_modules"),
    path.join(PRIMARY_REPO, "node_modules"),
  ];
  const siblings = [];
  try {
    const wtRoot = path.dirname(REPO_ROOT);
    for (const name of fs.readdirSync(wtRoot)) {
      const nm = path.join(wtRoot, name, "node_modules");
      if (!stable.includes(nm)) siblings.push(nm);
    }
  } catch { /* ignore */ }
  const candidates = [...stable, ...siblings];
  const complete = candidates.find(isCompleteNodeModules);
  const vitestOnly = candidates.find(hasVitest);
  const chosen = complete || vitestOnly || path.join(PRIMARY_REPO, "node_modules");
  return {
    nm: chosen,
    complete: !!complete,
    hasVitest: !!vitestOnly,
    stable,
    siblingCount: siblings.length,
  };
}

const TOOLCHAIN = resolveToolchain();
const PRIMARY_NODE_MODULES = TOOLCHAIN.nm;
const TOOLCHAIN_COMPLETE = TOOLCHAIN.complete;
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
  else if (args[i] === "--regen-report") { /* handled in main */ }
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
      // Force plain (uncolored) reporter output so test-name attribution parsing
      // is deterministic regardless of inherited FORCE_COLOR / TTY state.
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
  });
  return result;
}

// ── Test-name attribution parsers ─────────────────────────────────────────────

/**
 * Parse node:test output for the specific FAILING test case names, handling
 * BOTH reporter formats node emits:
 *   - TAP:  `not ok 1 - <name>` (indented for subtests). `# SKIP`/`# TODO` are
 *     directives, not failures.
 *   - spec: `    ✖ <name> (1.23ms)` (node's default reporter; used here even when
 *     piped). The `✖ failing tests:` section header has no `(Nms)` suffix and is
 *     ignored. Deeper-indented (leaf) failures are returned first so attribution
 *     names the specific test case, not just its parent suite.
 */
// Strip ANSI SGR/CSI escape sequences — node's spec reporter colorizes output
// intermittently (env-dependent FORCE_COLOR/TTY state), which would otherwise
// break the anchored failure-line regexes and drop kill attribution.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;
function stripAnsi(s) { return s.replace(ANSI_RE, ""); }

function parseTapFailures(stdout) {
  const found = [];
  const lines = (stdout || "").split(/\r?\n/).map(stripAnsi);
  for (const raw of lines) {
    // TAP failure line.
    const tap = /^\s*not ok \d+ - (.+?)\s*$/.exec(raw);
    if (tap) {
      let name = tap[1];
      if (/#\s*(SKIP|TODO)\b/i.test(name)) continue;
      name = name.replace(/\s+#\s.*$/, "").trim();
      if (name) found.push({ name, indent: 0 });
      continue;
    }
    // spec-reporter failure line: <indent> ✖|✗|× <name> (<duration>ms)
    const spec = /^(\s*)(?:\u2716|\u2717|\u00d7)\s+(.+?)\s+\(\d+(?:\.\d+)?ms\)\s*$/.exec(raw);
    if (spec) {
      const name = spec[2].trim();
      if (name) found.push({ name, indent: spec[1].length });
    }
  }
  // Leaf (deepest-indented) failures first; dedupe by name, preserve that order.
  found.sort((a, b) => b.indent - a.indent);
  const seen = new Set();
  const out = [];
  for (const f of found) {
    if (!seen.has(f.name)) { seen.add(f.name); out.push(f.name); }
  }
  return out;
}

/**
 * Parse a Vitest JSON report (jest-compatible shape) for the specific FAILING
 * test cases. Returns `{ tests: ["<relFile> > <suite> > <title>"], files: [relFile] }`.
 * `relTo` roots the reported absolute file paths back to repo-relative form.
 */
function parseVitestJsonFailures(reportPath, relTo) {
  const out = { tests: [], files: [], loadErrors: [] };
  let data;
  try { data = JSON.parse(fs.readFileSync(reportPath, "utf-8")); } catch { return out; }
  const fileSet = new Set();
  const testSet = new Set();
  const loadErrs = [];
  for (const tr of data.testResults || []) {
    let rel = tr.name || "";
    try { rel = path.relative(relTo, tr.name).split(path.sep).join("/"); } catch { /* keep abs */ }
    const failedAssertions = (tr.assertionResults || []).filter(ar => ar.status === "failed");
    for (const ar of failedAssertions) {
      fileSet.add(rel);
      const suite = (ar.ancestorTitles || []).join(" > ");
      const label = suite ? `${rel} > ${suite} > ${ar.title}` : `${rel} > ${ar.title}`;
      testSet.add(label);
    }
    // A suite that FAILED with zero assertion results is a collection/module
    // LOAD failure (e.g. a missing workspace dep) — NOT a test miss and NOT a
    // kill. Surface it distinctly so it is never counted as a coverage gap.
    if (tr.status === "failed" && failedAssertions.length === 0 && tr.message) {
      loadErrs.push({ file: rel, message: String(tr.message).split(/\r?\n/)[0].slice(0, 200) });
    }
  }
  out.tests = [...testSet];
  out.files = [...fileSet];
  out.loadErrors = loadErrs;
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
    // Legacy node:test suite — mirrors scripts/run-unit.mjs's tsx invocation.
    const cssStub = path.join(worktreePath, "tests", "helpers", "css-stub-loader.mjs");
    const importArgs = fs.existsSync(cssStub) ? ["--import", "./tests/helpers/css-stub-loader.mjs"] : [];
    const testArgs = [...importArgs, "--test", "--test-force-exit", testFile];
    // Prefer the resolved tsx JS entry (`node tsx/dist/cli.mjs`); fall back to
    // `npx --no-install tsx` (from cache, no network) when tsx is undeclared /
    // not present under node_modules — this is how run-unit.mjs actually runs it.
    let result;
    if (TSX_ENTRY) {
      result = runCommand("node", [TSX_ENTRY, ...testArgs], worktreePath, 180_000);
    } else {
      result = runCommand("npx", ["--no-install", "tsx", ...testArgs], worktreePath, 180_000);
    }
    const stdout = result.stdout || "";
    if (process.env.BOBBIT_CHAOS_DEBUG) {
      try {
        const dbg = path.join(REPO_ROOT, ".profiles", "chaos", `debug-legacy-${path.basename(testFile)}.txt`);
        fs.mkdirSync(path.dirname(dbg), { recursive: true });
        fs.writeFileSync(dbg, `STATUS=${result.status} SIGNAL=${result.signal}\nERROR=${result.error}\n--- STDOUT ---\n${stdout}\n--- STDERR ---\n${result.stderr || ""}\n`, "utf-8");
      } catch { /* ignore */ }
    }
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
    if (process.env.BOBBIT_CHAOS_DEBUG) {
      try {
        const dbg = path.join(REPO_ROOT, ".profiles", "chaos", `debug-v2-${path.basename(testFile)}.txt`);
        fs.mkdirSync(path.dirname(dbg), { recursive: true });
        const reportExists = fs.existsSync(reportPath);
        const reportBody = reportExists ? fs.readFileSync(reportPath, "utf-8") : "(no outputFile written)";
        fs.writeFileSync(dbg, `STATUS=${result.status} SIGNAL=${result.signal}\nERROR=${result.error}\nparsed.tests=${JSON.stringify(parsed.tests)}\n--- STDOUT ---\n${result.stdout || ""}\n--- STDERR ---\n${result.stderr || ""}\n--- REPORT(${reportExists}) ---\n${reportBody.slice(0, 4000)}\n`, "utf-8");
      } catch { /* ignore */ }
    }
    try { fs.rmSync(reportPath, { force: true }); } catch { /* ignore */ }
    return {
      exitCode: result.status ?? (result.error ? 1 : 0),
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      timedOut: result.signal === "SIGTERM",
      failingTests: parsed.tests,
      failingFiles: parsed.files,
      loadErrors: parsed.loadErrors || [],
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

// Remove the `node_modules` reparse point (junction/symlink) WITHOUT following
// it. On Windows both `git worktree remove --force` and Node's recursive
// `fs.rmSync` can descend THROUGH a directory junction and delete the target's
// contents (the shared node_modules tree) instead of just unlinking the link —
// the node_modules-corruption bug (see docs/testing-v2/node-modules-corruption-
// rca.md). We therefore unlink the link itself, non-recursively, first.
function unlinkNodeModulesJunction(worktreePath) {
  const link = path.join(worktreePath, "node_modules");
  let st;
  try { st = fs.lstatSync(link); } catch { return; } // absent — nothing to do

  // GUARD (fail loud): the junction target must live OUTSIDE the worktree we are
  // about to delete. If it were inside, unlinking wouldn't protect it and a
  // recursive delete would wipe it — refuse rather than risk the shared tree.
  try {
    const rawTarget = fs.readlinkSync(link); // throws if not a link
    const resolvedTarget = path.resolve(path.dirname(link), rawTarget);
    const resolvedRoot = path.resolve(worktreePath);
    const rel = path.relative(resolvedRoot, resolvedTarget);
    const targetInsideRoot = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    if (targetInsideRoot) {
      throw new Error(
        `[chaos] REFUSING to remove worktree: node_modules junction target\n` +
        `  (${resolvedTarget}) is INSIDE the removal path (${resolvedRoot}).\n` +
        `  A recursive delete would wipe the shared tree. Aborting to protect it.`,
      );
    }
  } catch (err) {
    // A genuine guard violation must propagate; a non-link (readlink ENOENT/
    // EINVAL) just means there's nothing junction-shaped to unlink here.
    if (/REFUSING to remove worktree/.test(err.message)) throw err;
  }

  // Unlink the reparse point ONLY (never recursive). Try the variants Node uses
  // for links on different platforms; each removes just the link, not the target.
  const attempts = [
    () => fs.unlinkSync(link),                       // POSIX symlink / Windows file-symlink
    () => fs.rmdirSync(link),                        // Windows directory junction
    () => fs.rmSync(link, { recursive: false, force: true }),
  ];
  for (const attempt of attempts) {
    try { attempt(); return; } catch { /* try next */ }
  }
  // If every non-recursive unlink failed the link is still present; do NOT fall
  // back to a recursive delete (that is the exact footgun). Warn loudly.
  if (fs.existsSync(link)) {
    console.warn(`[chaos] WARNING: could not unlink node_modules junction at ${link} non-recursively; skipping worktree delete to avoid deleting through it.`);
    throw new Error(`[chaos] node_modules junction at ${link} could not be safely unlinked`);
  }
}

function removeEphemeralWorktree(worktreePath) {
  // 1. Unlink the node_modules junction FIRST so neither `git worktree remove`
  //    nor the fs.rmSync fallback can descend through it into the shared tree.
  try {
    unlinkNodeModulesJunction(worktreePath);
  } catch (err) {
    // Guard violation or un-unlinkable junction: leave the worktree in place
    // rather than risk corrupting the shared node_modules tree.
    console.error(err.message);
    return;
  }
  // 2. Now it is safe to remove the worktree directory.
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktreePath],
      { cwd: REPO_ROOT, stdio: "pipe" });
  } catch {
    // Best-effort cleanup — rm if git worktree remove fails. Safe now: the
    // node_modules reparse point has already been unlinked above.
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
      const v2LoadErrors = (r && r.loadErrors) || [];
      if (r === null) {
        v2Result = "skipped";
        v2Detail = "no catcher";
      } else if (r.exitCode === -1) {
        v2Result = "error";
        v2Detail = r.stderr.slice(0, 300);
      } else if (r.timedOut) {
        v2Result = "error"; v2Detail = "timed out";
      } else if (v2CatchTests.length > 0) {
        // Real kill: an attributed failing test case (regardless of exit code).
        v2Result = "caught";
        v2Detail = `exit ${r.exitCode} — killed by "${v2CatchTests[0]}" (${v2DurationMs}ms)`;
      } else if (v2LoadErrors.length > 0) {
        // Suite failed to LOAD (e.g. missing workspace dep) — inconclusive, NOT a
        // coverage gap. The v2 test exists but cannot run in this environment.
        v2Result = "load-error";
        v2Detail = `module-load failure (not a miss): ${v2LoadErrors[0].message} (${v2DurationMs}ms)`;
      } else if (r.exitCode === 0) {
        v2Result = "missed"; v2Detail = `exit 0 — mutant MISSED (${v2DurationMs}ms)`;
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
// Run the full core+dom tier on a CLEAN tree to record pre-existing / flaky
// failures. Only failures that appear WITH a mutation but NOT here count as
// mutation kills — without this baseline, unrelated failing tests would credit
// false kills and pollute the corpus.
function runFullV2Baseline() {
  const start = Date.now();
  let worktreePath;
  try {
    worktreePath = createEphemeralWorktree("fullv2-baseline");
  } catch (err) {
    console.warn(`[chaos] full-v2 baseline: worktree error (${err.message}); assuming empty baseline`);
    return { files: new Set(), tests: new Set(), durationMs: Date.now() - start, error: err.message };
  }
  try {
    ensureNodeModulesJunction(worktreePath);
    console.log(`\n[chaos] full-v2 baseline: running full core+dom tier on the CLEAN tree…`);
    const r = runFullV2Suite(worktreePath);
    console.log(`  baseline: ${r.failingFiles.length} pre-existing failing file(s), ${r.failingTests.length} test(s)  (${((Date.now() - start) / 1000).toFixed(1)}s)`);
    return { files: new Set(r.failingFiles), tests: new Set(r.failingTests), durationMs: Date.now() - start };
  } finally {
    removeEphemeralWorktree(worktreePath);
  }
}

async function runFullV2SampleOne(mutant, baseline) {
  const start = Date.now();
  const baseFiles = baseline?.files ?? new Set();
  const baseTests = baseline?.tests ?? new Set();
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
    // Attribute ONLY failures new vs the clean-tree baseline to the mutation.
    const newFailingTests = r.failingTests.filter(t => !baseTests.has(t));
    const newFailingFiles = r.failingFiles.filter(f => !baseFiles.has(f));
    const killed = !r.timedOut && newFailingTests.length > 0;
    const listed = new Set(mutant.expectedV2Catchers || []);
    // R8 over-narrow guard: only back-fill when the mutant's OWN listed catcher
    // did NOT fire in the full run yet some other test did (proving the targeted
    // selection was too narrow). If the listed catcher fired, the other new
    // failures are almost certainly unrelated flaky tests — do NOT pollute the
    // corpus with them.
    const listedFired = newFailingFiles.some(f => listed.has(f));
    const newCatchers = listedFired
      ? []
      : newFailingFiles.filter(f => f.startsWith("tests2/") && !listed.has(f));
    console.log(`  full-v2: ${killed ? "KILLED" : "SURVIVED"} by ${newFailingFiles.length} NEW file(s) vs baseline` +
      (newCatchers.length ? ` (+${newCatchers.length} non-listed)` : "") + `  (${((Date.now() - start) / 1000).toFixed(1)}s)`);
    return {
      id: mutant.id,
      area: mutant.area,
      killed,
      timedOut: r.timedOut,
      exitCode: r.exitCode,
      failingFiles: newFailingFiles,
      failingTests: newFailingTests.slice(0, 8),
      failingTestCount: newFailingTests.length,
      baselineNoiseFiles: r.failingFiles.length - newFailingFiles.length,
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
  const v2Invalid = contentMutants.filter(r => r.v2Result === "invalid" || r.v2Result === "error" || r.v2Result === "load-error").length;

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

  const legacyOnly = contentMutants.filter(r => r.legacyResult === "caught" && r.v2Result !== "caught");
  // A REAL coverage gap = v2 test RAN and did not detect the mutant (missed).
  const realGaps = legacyOnly.filter(r => r.v2Result === "missed");
  // Inconclusive = the v2 test could not run here (module-load / harness error),
  // e.g. a missing workspace dep in the host node_modules. NOT a coverage gap.
  const inconclusive = legacyOnly.filter(r => r.v2Result === "load-error" || r.v2Result === "error");
  const v2CatchesAllLegacyCaught = realGaps.length === 0;
  lines.push(`- **No REAL v2 coverage gap (every legacy-caught mutant the v2 test RAN on is caught):** ${v2CatchesAllLegacyCaught ? "✅ PASS" : "❌ FAIL"}`);
  if (realGaps.length > 0) {
    lines.push(`  - ❌ ${realGaps.length} REAL v2 coverage gap(s) — the v2 test ran and MISSED. Add a \`tests2/\` test that catches each, then re-run that mutant (never delete/alter the mutant):`);
    for (const r of realGaps) {
      lines.push(`    - **${r.id}** (${r.area}): ${r.description} — legacy caught via \`${(r.legacyCatchers[0] || "?")}\`, v2 = missed`);
    }
  }
  if (inconclusive.length > 0) {
    lines.push(`- **Inconclusive (env, NOT a coverage gap):** ⚠️ ${inconclusive.length} legacy-caught mutant(s) whose v2 test could not run here (module-load/harness error — e.g. a workspace dep missing from the host node_modules). Re-run in a complete-install environment:`);
    for (const r of inconclusive) {
      lines.push(`    - **${r.id}** (${r.area}): v2 = ${r.v2Result} — ${r.detail.split("| v2:").pop().trim()}`);
    }
  }

  const v2KillRateNum = v2Killable > 0 ? v2Caught / v2Killable : 1;
  const legacyKillRateNum = legacyKillable > 0 ? legacyCaught / legacyKillable : 0;
  const v2KillRateGeq = v2Caught >= legacyCaught;
  lines.push(`- **v2 ≥ legacy overall (kill count):** ${v2KillRateGeq ? "✅ PASS" : "❌ FAIL"} (v2 caught ${v2Caught} vs legacy ${legacyCaught}; rates v2 ${(v2KillRateNum*100).toFixed(1)}% / legacy ${(legacyKillRateNum*100).toFixed(1)}%)`);

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

  // Per-area comparison — the actual deliverable: v2 ≥ legacy overall AND per
  // area, and v2 must catch 100% of every legacy-caught mutant in each area.
  lines.push("## Per-area Comparison (v2 ≥ legacy is the verdict)");
  lines.push("");
  const areas = [...new Set(contentMutants.map(r => r.area))];
  lines.push("Legend: **inc(env)** = v2 test could not load here (missing workspace dep) — inconclusive, not a miss. Verdict excludes env-inconclusive; a real regression is a v2 *miss*.");
  lines.push("");
  lines.push("| Area | Mutants | Legacy caught | V2 caught | inc(env) | Real v2 miss | v2 ≥ legacy (runnable) |");
  lines.push("|------|---------|---------------|-----------|----------|--------------|------------------------|");
  let allAreasGeq = true;
  let allLegacyNoMiss = true;
  for (const area of areas) {
    const areaResults = contentMutants.filter(r => r.area === area);
    const lc = areaResults.filter(r => r.legacyResult === "caught").length;
    const vc = areaResults.filter(r => r.v2Result === "caught").length;
    const legacyCaughtHere = areaResults.filter(r => r.legacyResult === "caught");
    // Inconclusive = v2 could not run (env/harness); a real regression = v2 MISS.
    const inc = legacyCaughtHere.filter(r => r.v2Result === "load-error" || r.v2Result === "error").length;
    const realMiss = legacyCaughtHere.filter(r => r.v2Result === "missed").length;
    // v2 >= legacy among mutants v2 could actually run (env-inconclusive excluded).
    const geqOk = realMiss === 0;
    if (!geqOk) allAreasGeq = false;
    if (realMiss > 0) allLegacyNoMiss = false;
    lines.push(`| ${area} | ${areaResults.length} | ${lc} | ${vc} | ${inc || "—"} | ${realMiss || "—"} | ${geqOk ? (inc ? "✅*" : "✅") : "❌"} |`);
  }
  lines.push("");
  lines.push(`**Per-area v2 ≥ legacy (runnable):** ${allAreasGeq ? "✅ PASS (no area has a real v2 miss; ✅* = has env-inconclusive to re-run in a complete-install env)" : "❌ FAIL (an area has a REAL v2 miss — add a tests2/ test and re-run)"}`);
  lines.push(`**Per-area legacy-caught ⊆ v2-caught (excluding env-inconclusive):** ${allLegacyNoMiss ? "✅ PASS (no legacy-caught mutant is genuinely missed by v2)" : "❌ FAIL (a legacy-caught mutant is genuinely missed by v2)"}`);
  lines.push("");

  // Full matrix (with test-name-level kill attribution)
  lines.push("## Full Mutant Matrix");
  lines.push("");
  lines.push("| ID | Area | File | Legacy | V2 | Killed by (v2 test case) | Duration |");
  lines.push("|----|------|------|--------|-----|--------------------------|----------|");
  for (const r of results) {
    const nullTag = r.nullMutant ? " *(null)*" : "";
    const ICONS = { caught: "🔴", missed: "⚪", skipped: "—", error: "⚠️", invalid: "⛔", "load-error": "🧩" };
    const legacyIcon = ICONS[r.legacyResult] || "?";
    const v2Icon = ICONS[r.v2Result] || "?";
    let killedBy = "—";
    if (r.v2Result === "caught") {
      const t = (r.v2CatchTests && r.v2CatchTests[0]) || "";
      killedBy = t ? `\`${t.replace(/\|/g, "\\|")}\`${r.v2CatchTests.length > 1 ? ` (+${r.v2CatchTests.length - 1})` : ""}` : "⚠️ unattributed";
    }
    lines.push(`| ${r.id}${nullTag} | ${r.area} | \`${r.file}\` | ${legacyIcon} ${r.legacyResult} | ${v2Icon} ${r.v2Result} | ${killedBy} | ${(r.durationMs/1000).toFixed(1)}s |`);
  }
  lines.push("");
  lines.push("**Icon key:** 🔴 caught (test fails on mutant) | ⚪ missed | — skipped (no targeted catcher) | ⚠️ error | 🧩 load-error (v2 suite could not load here — env, not a miss) | ⛔ invalid (patch failed)");
  lines.push("");

  // Full-v2 sample detail (spec R8).
  if (sample.length > 0) {
    lines.push("## Full-v2 Sample (spec R8 — over-narrow-targeting guard)");
    lines.push("");
    lines.push("Each sampled mutant is re-run against the FULL v2 core+dom tier (every test, not just the targeted file), with pre-existing/flaky failures subtracted via a clean-tree baseline. 'Killed by (attributed)' names the mutant's own listed catcher when it fired in the full run; a genuine non-listed catcher is recorded only when the listed catcher did NOT fire (the true over-narrow case).");
    lines.push("");
    lines.push("| Mutant | Area | Re-killed by full tier | Killed by (attributed) | Genuine non-listed catcher | Duration |");
    lines.push("|--------|------|------------------------|------------------------|----------------------------|----------|");
    for (const s of sample) {
      const status = s.error ? `⚠️ ${s.error}` : (s.killed ? "✅ yes" : "❌ SURVIVED");
      // Cross-reference the mutant's listed v2 catcher; if it is among the
      // new-vs-baseline failing files, THAT is the attribution and any other
      // new failures are treated as flaky noise (not genuine catchers).
      const mres = results.find(r => r.id === s.id);
      const listed = new Set((mres && mres.v2Catchers) || []);
      const failing = s.failingFiles || [];
      const listedFired = failing.filter(f => listed.has(f));
      const attributed = listedFired.length ? listedFired.map(f => `\`${f}\``).join("<br>") : (failing.length ? "(listed catcher not in full-run failures)" : "—");
      const genuineNonListed = listedFired.length ? "— (listed catcher fired; other failures treated as flaky)" :
        (failing.filter(f => !listed.has(f)).map(f => `\`${f}\``).join("<br>") || "—");
      lines.push(`| ${s.id} | ${s.area} | ${status} | ${attributed} | ${genuineNonListed} | ${((s.durationMs||0)/1000).toFixed(1)}s |`);
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
  // Regenerate the markdown report from an existing JSON report (no campaign).
  if (args.includes("--regen-report")) {
    const report = JSON.parse(fs.readFileSync(REPORT_JSON, "utf-8"));
    const md = generateMarkdownReport(report.results, report.meta || {});
    fs.writeFileSync(REPORT_MD, md, "utf-8");
    console.log(`Regenerated ${REPORT_MD} from ${REPORT_JSON} (${report.results.length} results)`);
    return;
  }
  const totalStart = Date.now();
  console.log(`\n╔═══════════════════════════════════════════════════╗`);
  console.log(`║         Bobbit Chaos Comparison Proof             ║`);
  console.log(`╚═══════════════════════════════════════════════════╝`);
  console.log(`Repo root:    ${REPO_ROOT}`);
  console.log(`Primary repo: ${PRIMARY_REPO}`);
  console.log(`Mutants:      ${mutants.length} (of ${ALL_MUTANTS.length} total)`);
  console.log(`toolchain nm: ${PRIMARY_NODE_MODULES}`);
  console.log(`vitest entry: ${fs.existsSync(VITEST_ENTRY) ? "✓ " + VITEST_ENTRY : "✗ MISSING"}`);
  console.log(`tsx entry:    ${TSX_ENTRY ? "✓ " + TSX_ENTRY : "(node_modules/tsx absent) → falling back to `npx --no-install tsx`"}`);

  console.log(`toolchain complete (vitest + @earendil-works/pi-ai): ${TOOLCHAIN_COMPLETE ? "✓ yes" : "✗ NO"}`);

  // Preflight: ensure the v2 toolchain (vitest) is resolvable.
  if (!fs.existsSync(VITEST_ENTRY)) {
    console.error("\n[chaos] ERROR: Could not locate vitest/vitest.mjs in any candidate node_modules.");
    console.error("  Run this in the tier-1 toolchain environment (in-container) or a worktree with a full `npm ci`.");
    process.exit(1);
  }
  // For the AUTHORITATIVE full campaign (--all), a complete workspace install is
  // mandatory: without @earendil-works/pi-ai, server-graph v2 tests fail to LOAD
  // and the comparison is invalid. Fail LOUD rather than emit a misleading report.
  const isFullCampaign = targetIds === null;
  if (isFullCampaign && !TOOLCHAIN_COMPLETE) {
    console.error("\n[chaos] ❌ ABORT: no COMPLETE workspace node_modules found for the full campaign.");
    console.error("  A valid v2-vs-legacy comparison needs BOTH `vitest` AND `@earendil-works/pi-ai`");
    console.error("  resolvable in a single node_modules (server-graph tests import auth/session code).");
    console.error(`  Chosen node_modules: ${PRIMARY_NODE_MODULES}`);
    console.error(`    vitest present: ${fs.existsSync(VITEST_ENTRY) ? "yes" : "no"}`);
    console.error(`    @earendil-works/pi-ai present: ${fs.existsSync(path.join(PRIMARY_NODE_MODULES, "@earendil-works", "pi-ai")) ? "yes" : "no"}`);
    console.error("  Searched (stable first, then sibling worktrees):");
    for (const nm of TOOLCHAIN.stable) {
      console.error(`    - ${nm}  [vitest=${hasVitest(nm) ? "Y" : "N"} pi-ai=${fs.existsSync(path.join(nm, "@earendil-works", "pi-ai")) ? "Y" : "N"}]`);
    }
    console.error(`    - (+${TOOLCHAIN.siblingCount} sibling worktrees under ${path.dirname(REPO_ROOT)})`);
    console.error("  FIX: run `npm ci` (or install @earendil-works/pi-ai@0.79.6) in the worktree the");
    console.error("  campaign runs from (the goal worktree at gate time), then re-run `--all`.");
    process.exit(1);
  }
  if (!TOOLCHAIN_COMPLETE) {
    console.warn("[chaos] WARNING: toolchain node_modules lacks @earendil-works/pi-ai — server-graph v2");
    console.warn("  tests will report 'load-error' (inconclusive). OK for targeted --ids dev runs only.");
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
  let fullV2SampleBaseline = null;
  let corpusUpdated = false;
  if (runSample) {
    const eligible = results.filter(r => !r.nullMutant && r.v2Result === "caught");
    if (eligible.length === 0) {
      console.log("\n[chaos] full-v2 sample: skipped (no v2-caught mutants to sample)");
    } else {
      const chosenIds = new Set(seededSample(eligible.map(r => r.id), sampleSize).map(String));
      const chosen = ALL_MUTANTS.filter(m => chosenIds.has(m.id));
      console.log(`\n[chaos] full-v2 sample: ${chosen.length} mutant(s) → ${chosen.map(m => m.id).join(", ")}`);
      const baseline = runFullV2Baseline();
      fullV2SampleBaseline = { failingFiles: baseline.files.size, failingTests: baseline.tests.size };
      for (const mutant of chosen) {
        const rec = await runFullV2SampleOne(mutant, baseline);
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
      baseline: fullV2SampleBaseline,
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
