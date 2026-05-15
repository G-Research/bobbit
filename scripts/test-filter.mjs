#!/usr/bin/env node
/**
 * Filters Playwright JSON reporter output to a compact summary.
 * Pipe test output in, get only what matters out.
 *
 * Usage:
 *   npx playwright test --reporter=json 2>/dev/null | node scripts/test-filter.mjs [OPTIONS]
 *
 * Options:
 *   --failures   Show only summary line + failure details (default)
 *   --verbose    Also list every test with pass/fail status
 *   --full       Pass through raw JSON (no filtering)
 *
 * Exit code matches: 0 if all passed, 1 if any failed.
 *
 * Examples:
 *   npx playwright test --config playwright-e2e.config.ts --reporter=json 2>/dev/null | node scripts/test-filter.mjs
 *   npx playwright test --config playwright-e2e.config.ts --reporter=json 2>/dev/null | node scripts/test-filter.mjs --verbose
 */
import process from "node:process";

const mode = process.argv[2] || "--failures";

if (mode === "--help" || mode === "-h") {
  console.log(`Usage: <playwright --reporter=json> 2>/dev/null | node scripts/test-filter.mjs [--failures|--verbose|--full]`);
  process.exit(0);
}

// Read all stdin
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const raw = Buffer.concat(chunks).toString();

if (mode === "--full") {
  process.stdout.write(raw);
  process.exit(0);
}

/**
 * Extract a balanced JSON object starting at `startIdx`, returning the
 * substring through the matching closing brace. String-literal aware so
 * `{` / `}` inside JSON strings don't perturb the depth counter. Returns
 * `null` if no balanced object can be extracted (truncated input, etc.).
 */
function extractBalancedObject(s, startIdx) {
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = startIdx; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (c === "\\") { escape = true; continue; }
      if (c === "\"") inStr = false;
      continue;
    }
    if (c === "\"") { inStr = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(startIdx, i + 1);
    }
  }
  return null;
}

let report;
try {
  report = JSON.parse(raw);
} catch {
  // Not clean JSON — Playwright workers and any imported `node:test` modules
  // can interleave their own TAP/spec output into stdout before/around the
  // JSON reporter's payload. Try several start points (the distinctive
  // `\n{\n  "config":` marker, every line-leading `{`, then any `{`), and
  // for each one (a) parse the tail directly, then (b) extract a balanced
  // object, then (c) walk closing-brace positions backwards. Step (b) is
  // what handles trailing junk that itself contains `}` — a previous
  // single `lastIndexOf("}")` recovery would latch onto the junk brace.
  const candidates = [];
  const markerIdx = raw.indexOf("\n{\n  \"config\":");
  if (markerIdx >= 0) candidates.push(markerIdx + 1);
  // Every line that starts with `{` is a plausible JSON object start. This
  // catches the Playwright payload even if its pretty-print indent ever
  // changes (e.g. tabs vs spaces).
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "{" && (i === 0 || raw[i - 1] === "\n")) candidates.push(i);
  }
  // Last resort: any `{`.
  const firstBrace = raw.indexOf("{");
  if (firstBrace >= 0) candidates.push(firstBrace);

  let recovered = null;
  const tried = new Set();
  outer: for (const start of candidates) {
    if (tried.has(start)) continue;
    tried.add(start);
    const tail = raw.slice(start);
    // (a) Parse the whole tail — wins when there's no trailing junk.
    try { recovered = JSON.parse(tail); break; } catch { /* keep trying */ }
    // (b) Balanced-brace extraction — robust against trailing junk that
    // itself contains `{` or `}`, because we count depth instead of
    // searching for a literal brace.
    const balanced = extractBalancedObject(tail, 0);
    if (balanced !== null) {
      try { recovered = JSON.parse(balanced); break; } catch { /* keep trying */ }
    }
    // (c) Fallback: walk every closing brace backwards. Tail-slice parses
    // can still succeed when balanced extraction is defeated by an
    // unterminated string literal in noise (depth never returns to 0).
    let searchEnd = tail.length;
    while (searchEnd > 0) {
      const lastBrace = tail.lastIndexOf("}", searchEnd - 1);
      if (lastBrace <= 0) break;
      try { recovered = JSON.parse(tail.slice(0, lastBrace + 1)); break outer; }
      catch { /* keep walking */ }
      searchEnd = lastBrace;
    }
  }
  if (recovered) {
    report = recovered;
  } else {
    // Pass through raw (probably line reporter output) and exit 1
    process.stdout.write(raw);
    process.exit(1);
  }
}

const stats = report.stats || {};
// Playwright's stats.expected counts only first-try passes; flaky tests
// (passed on retry) are reported separately. Roll flaky into `passed` so the
// summary and exit code match the final outcome the developer sees.
const flaky = stats.flaky || 0;
const passed = (stats.expected || 0) + flaky;
const failed = stats.unexpected || 0;
const skipped = stats.skipped || 0;
const total = passed + failed + skipped;
const ms = stats.duration || 0;
const duration = ms > 60000 ? `${(ms / 60000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`;

// Collect all tests with their results
const tests = [];
function walkSuite(suite, ancestors) {
  const path = suite.title ? [...ancestors, suite.title] : ancestors;
  for (const spec of suite.specs || []) {
    for (const test of spec.tests || []) {
      const lastResult = test.results?.[test.results.length - 1];
      // test.status is "expected" | "unexpected" | "skipped" | "flaky"
      // Treat "flaky" as passing — by definition Playwright only marks a test
      // flaky after a retry succeeded, so the final outcome is pass. Reporting
      // these as failures blocks downstream gates for infrastructure flakes
      // (Windows transform-cache EPERM, etc.) that the retry already recovered
      // from.
      const ok = test.status === "expected" || test.status === "flaky";
      const skip = test.status === "skipped";
      tests.push({
        title: [...path, spec.title].filter(Boolean).join(" > "),
        ok,
        skip,
        status: test.status,
        duration: lastResult?.duration || 0,
        error: lastResult?.errors?.[0] || lastResult?.error,
        file: spec.file || suite.file || "",
        line: spec.line,
      });
    }
  }
  for (const child of suite.suites || []) walkSuite(child, path);
}
for (const suite of report.suites || []) walkSuite(suite, []);

// Summary line
const status = failed > 0 ? "FAILED" : "PASSED";
let summary = `${status}: ${passed}/${total} passed`;
if (skipped > 0) summary += `, ${skipped} skipped`;
if (failed > 0) summary += `, ${failed} failed`;
if (flaky > 0) summary += `, ${flaky} flaky (recovered on retry)`;
summary += ` (${duration})`;
console.log(summary);

// --verbose: list every test
if (mode === "--verbose") {
  console.log("");
  for (const t of tests) {
    const icon = t.ok ? "OK" : t.skip ? "SKIP" : "FAIL";
    const d = t.duration > 1000 ? `${(t.duration / 1000).toFixed(1)}s` : `${t.duration}ms`;
    console.log(`  [${icon}] ${t.title} (${d})`);
  }
  console.log("");
}

// Failure details (shown in both --failures and --verbose)
const failures = tests.filter(t => !t.ok && !t.skip);
if (failures.length > 0) {
  if (mode !== "--verbose") console.log("");
  for (let i = 0; i < failures.length; i++) {
    const f = failures[i];
    console.log(`--- Failure ${i + 1}: ${f.title} ---`);
    console.log(`File: ${f.file}${f.line ? `:${f.line}` : ""}`);
    if (f.error?.message) {
      const msg = f.error.message.split("\n").slice(0, 8).join("\n");
      console.log(msg);
    }
    if (f.error?.snippet) {
      console.log(f.error.snippet.slice(0, 400));
    }
    console.log("");
  }
}

// Set exitCode instead of calling process.exit() — process.exit() can
// cause issues with unflushed stdout in piped contexts on Windows/Git Bash.
process.exitCode = failed > 0 ? 1 : 0;
