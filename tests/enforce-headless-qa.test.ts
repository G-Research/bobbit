/**
 * Reproducing test for the "Enforce headless QA browsers" goal.
 *
 * Asserts configuration invariants that guarantee no visible Chromium window
 * is ever launched during a QA (or any other) agent run.
 *
 * Under MCP/builtin policy parity, the YAML group-level `mcp__playwright: never`
 * denial was removed (MCP groups default to `allow` like every other tool group).
 * The headless guarantee now relies on three surviving layers:
 *
 *   1. `.claude/.mcp.json` passes `--headless` and `--isolated` to `@playwright/mcp`.
 *   2. `defaults/tool-group-policies.yaml` contains NO builtin mcp__* denials
 *      (regression guard against re-introducing them).
 *   3. `defaults/roles/qa-tester.yaml` explicitly blocks `mcp__playwright` at the role layer.
 *   4. `defaults/tools/browser/extension.ts` passes `--headless=new` and
 *      `--disable-gpu` to `chromium.launch`.
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

test("`defaults/tool-group-policies.yaml` contains no builtin mcp__* denials (parity with built-in tool groups)", () => {
  const p = path.join(repoRoot, "defaults", "tool-group-policies.yaml");
  const raw = fs.readFileSync(p, "utf8");
  const doc = YAML.parse(raw) ?? {};
  const mcpKeys = Object.keys(doc).filter((k) => k.startsWith("mcp__"));
  assert.deepEqual(
    mcpKeys,
    [],
    `defaults/tool-group-policies.yaml must NOT contain any top-level mcp__* keys (MCP groups default to "allow" like every other tool group); found: ${JSON.stringify(mcpKeys)}`,
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
