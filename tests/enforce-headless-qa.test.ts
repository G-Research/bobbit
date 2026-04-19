/**
 * Reproducing test for the "Enforce headless QA browsers" goal.
 *
 * Asserts configuration invariants that guarantee no visible Chromium window
 * is ever launched during a QA (or any other) agent run:
 *
 *   1. `.claude/.mcp.json` passes `--headless` and `--isolated` to `@playwright/mcp`.
 *   2. `defaults/tool-group-policies.yaml` blocks `mcp__playwright` by default.
 *   3. `defaults/roles/qa-tester.yaml` explicitly blocks `mcp__playwright` too.
 *   4. `defaults/tools/browser/extension.ts` passes `--headless=new` and
 *      `--disable-gpu` to `chromium.launch`.
 *
 * All 4 assertions MUST fail on current master and pass after the fix.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

test("`.claude/.mcp.json` passes --headless and --isolated to @playwright/mcp", () => {
  const p = path.join(repoRoot, ".claude", ".mcp.json");
  const raw = fs.readFileSync(p, "utf8");
  const json = JSON.parse(raw);
  const args: string[] = json?.mcpServers?.playwright?.args ?? [];
  assert.ok(
    args.includes("--headless"),
    `.claude/.mcp.json mcpServers.playwright.args must include "--headless"; got ${JSON.stringify(args)}`,
  );
  assert.ok(
    args.includes("--isolated"),
    `.claude/.mcp.json mcpServers.playwright.args must include "--isolated"; got ${JSON.stringify(args)}`,
  );
});

test("`defaults/tool-group-policies.yaml` blocks mcp__playwright by default", () => {
  const p = path.join(repoRoot, "defaults", "tool-group-policies.yaml");
  const raw = fs.readFileSync(p, "utf8");
  const doc = YAML.parse(raw) ?? {};
  assert.equal(
    doc["mcp__playwright"],
    "never",
    `defaults/tool-group-policies.yaml must set top-level "mcp__playwright: never"; got ${JSON.stringify(doc["mcp__playwright"])}`,
  );
});

test("`defaults/roles/qa-tester.yaml` explicitly blocks mcp__playwright in toolPolicies", () => {
  const p = path.join(repoRoot, "defaults", "roles", "qa-tester.yaml");
  const raw = fs.readFileSync(p, "utf8");
  const doc = YAML.parse(raw) ?? {};
  const policies = doc.toolPolicies ?? {};
  assert.equal(
    policies["mcp__playwright"],
    "never",
    `defaults/roles/qa-tester.yaml toolPolicies must set "mcp__playwright: never"; got ${JSON.stringify(policies["mcp__playwright"])}`,
  );
});

test("`defaults/tools/browser/extension.ts` passes --headless=new and --disable-gpu to chromium.launch", () => {
  const p = path.join(repoRoot, "defaults", "tools", "browser", "extension.ts");
  const raw = fs.readFileSync(p, "utf8");
  // Match chromium.launch({ ... }) possibly spanning multiple lines.
  const launchMatch = raw.match(/chromium\.launch\s*\(\s*\{[\s\S]*?\}\s*\)/);
  assert.ok(launchMatch, "expected a chromium.launch({ ... }) call in browser/extension.ts");
  const body = launchMatch[0];
  assert.ok(
    body.includes("--headless=new"),
    `chromium.launch call must pass "--headless=new" in args; launch block was:\n${body}`,
  );
  assert.ok(
    body.includes("--disable-gpu"),
    `chromium.launch call must pass "--disable-gpu" in args; launch block was:\n${body}`,
  );
});
