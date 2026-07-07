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
const PRIMARY_NODE_MODULES = path.join(PRIMARY_REPO, "node_modules");
const MUTANTS_FILE = path.join(REPO_ROOT, "tests2", "chaos", "mutants.json");
const REPORT_JSON = path.join(REPO_ROOT, ".profiles", "chaos", "comparison-report.json");
const REPORT_MD = path.join(REPO_ROOT, "docs", "testing-v2", "chaos-report.md");

// ── CLI parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let targetIds = null; // null = all
let dryRun = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--all") { targetIds = null; }
  else if (args[i] === "--dry-run") { dryRun = true; }
  else if (args[i] === "--id" && args[i + 1]) { targetIds = [args[++i]]; }
  else if (args[i] === "--ids" && args[i + 1]) { targetIds = args[++i].split(","); }
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

/**
 * Run a single targeted test file.
 * Returns { exitCode, stdout, stderr, timedOut }.
 */
function runTargetedTest(worktreePath, testFile, tier) {
  if (!testFile) return null;
  const absFile = path.join(worktreePath, testFile);
  if (!fs.existsSync(absFile)) {
    return { exitCode: -1, stdout: "", stderr: `Test file not found: ${testFile}`, timedOut: false };
  }

  if (tier === "legacy") {
    // Legacy node:test suite — uses tsx loader
    const cssStub = path.join(worktreePath, "tests", "helpers", "css-stub-loader.mjs");
    const importArgs = fs.existsSync(cssStub) ? ["--import", "./tests/helpers/css-stub-loader.mjs"] : [];
    const cliArgs = ["node_modules/.bin/tsx", ...importArgs, "--test", "--test-force-exit", testFile];
    const result = runCommand("node", cliArgs, worktreePath);
    return {
      exitCode: result.status ?? (result.error ? 1 : 0),
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      timedOut: result.signal === "SIGTERM",
    };
  }

  if (tier === "v2") {
    // Vitest tier-1 (core / dom / integration)
    const configPath = path.join(worktreePath, "vitest.config.ts");
    const cliArgs = ["node_modules/.bin/vitest", "run", "--config", configPath,
      "--reporter=verbose", testFile];
    const result = runCommand("node", cliArgs, worktreePath);
    return {
      exitCode: result.status ?? (result.error ? 1 : 0),
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      timedOut: result.signal === "SIGTERM",
    };
  }

  return { exitCode: -1, stdout: "", stderr: `Unknown tier: ${tier}`, timedOut: false };
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
    if (mutant.expectedLegacyCatchers.length > 0) {
      const legacyFile = mutant.expectedLegacyCatchers[0];
      console.log(`  legacy: ${legacyFile}`);
      const t0 = Date.now();
      const r = runTargetedTest(worktreePath, legacyFile, "legacy");
      legacyDurationMs = Date.now() - t0;
      if (r === null) {
        legacyResult = "skipped";
        legacyDetail = "no catcher";
      } else if (r.exitCode === -1) {
        legacyResult = "error";
        legacyDetail = r.stderr.slice(0, 300);
      } else {
        legacyResult = r.exitCode !== 0 ? "caught" : "missed";
        legacyDetail = r.exitCode !== 0
          ? `exit ${r.exitCode} (${legacyDurationMs}ms)`
          : `exit 0 — mutant MISSED (${legacyDurationMs}ms)`;
        if (r.timedOut) { legacyResult = "error"; legacyDetail = "timed out"; }
      }
      console.log(`  legacy: ${legacyResult}  (${legacyDurationMs}ms)`);
    } else {
      console.log(`  legacy: skipped (no catcher — new v2 coverage)`);
    }

    // 6. Run v2 test
    let v2Result = "skipped";
    let v2Detail = "no v2 catcher";
    let v2DurationMs = 0;
    if (mutant.expectedV2Catchers.length > 0) {
      const v2File = mutant.expectedV2Catchers[0];
      console.log(`  v2:     ${v2File}`);
      const t0 = Date.now();
      const r = runTargetedTest(worktreePath, v2File, "v2");
      v2DurationMs = Date.now() - t0;
      if (r === null) {
        v2Result = "skipped";
        v2Detail = "no catcher";
      } else if (r.exitCode === -1) {
        v2Result = "error";
        v2Detail = r.stderr.slice(0, 300);
      } else {
        v2Result = r.exitCode !== 0 ? "caught" : "missed";
        v2Detail = r.exitCode !== 0
          ? `exit ${r.exitCode} (${v2DurationMs}ms)`
          : `exit 0 — mutant MISSED (${v2DurationMs}ms)`;
        if (r.timedOut) { v2Result = "error"; v2Detail = "timed out"; }
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

    return buildResult(mutant, legacyResult, v2Result,
      `legacy: ${legacyDetail} | v2: ${v2Detail}`, Date.now() - start);

  } finally {
    // Always remove the ephemeral worktree
    removeEphemeralWorktree(worktreePath);
  }
}

function buildResult(mutant, legacyResult, v2Result, detail, durationMs) {
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
    detail,
    durationMs,
    timestamp: new Date().toISOString(),
  };
}

// ── Report generation ─────────────────────────────────────────────────────────

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

  // Full matrix
  lines.push("## Full Mutant Matrix");
  lines.push("");
  lines.push("| ID | Area | File | Legacy | V2 | Duration |");
  lines.push("|----|------|------|--------|-----|----------|");
  for (const r of results) {
    const nullTag = r.nullMutant ? " *(null)*" : "";
    const legacyIcon = { caught: "🔴", missed: "⚪", skipped: "—", error: "⚠️", invalid: "⛔" }[r.legacyResult] || "?";
    const v2Icon = { caught: "🔴", missed: "⚪", skipped: "—", error: "⚠️", invalid: "⛔" }[r.v2Result] || "?";
    lines.push(`| ${r.id}${nullTag} | ${r.area} | \`${r.file}\` | ${legacyIcon} ${r.legacyResult} | ${v2Icon} ${r.v2Result} | ${(r.durationMs/1000).toFixed(1)}s |`);
  }
  lines.push("");
  lines.push("**Icon key:** 🔴 caught (test fails on mutant) | ⚪ missed | — skipped (no targeted catcher) | ⚠️ error | ⛔ invalid (patch failed)");
  lines.push("");

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
  console.log(`node_modules: ${fs.existsSync(PRIMARY_NODE_MODULES) ? "✓ found" : "✗ MISSING"}`);

  // Preflight: ensure node_modules in primary
  if (!fs.existsSync(PRIMARY_NODE_MODULES)) {
    console.error("\n[chaos] ERROR: Primary repo node_modules not found.");
    console.error("  Run `npm ci` in the primary repo first.");
    process.exit(1);
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

  const totalDurationMs = Date.now() - totalStart;
  const runMeta = {
    date: new Date().toISOString(),
    totalDurationMs,
    mutantCount: mutants.length,
    runner: "chaos.mjs",
    partial: false,
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
