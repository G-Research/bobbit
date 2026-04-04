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

let report;
try {
  report = JSON.parse(raw);
} catch {
  // Not valid JSON — pass through raw (probably line reporter output)
  process.stdout.write(raw);
  process.exit(1);
}

const stats = report.stats || {};
const passed = stats.expected || 0;
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
      const ok = test.status === "expected";
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

process.exit(failed > 0 ? 1 : 0);
