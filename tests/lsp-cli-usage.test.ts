/**
 * Source-pin for scripts/lsp-cli.mjs — the LSP bridge subagents use via Bash
 * (the interactive `LSP` tool isn't available to them; see
 * .claude/skills/orient/SKILL.md).
 *
 * Deliberately does NOT spawn `typescript-language-server` or exercise a real
 * query: that requires the TS project to load (~30s+ under load) and would
 * make this test slow and, under machine load, flaky. Instead this pins the
 * cheap, fast-to-verify contract:
 *   - the script exists and parses as valid ESM (`node --check`),
 *   - `--help` (one fast process spawn, no LSP server involved) exits 0 and
 *     documents all five subcommands.
 *
 * If a future change breaks the actual LSP handshake/query logic, that's a
 * job for a manual/e2e smoke test, not this unit test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, accessSync, constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TESTS_DIR, "..");
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/lsp-cli.mjs");

test("scripts/lsp-cli.mjs exists and is executable-shaped", () => {
	assert.ok(existsSync(SCRIPT_PATH), `expected ${SCRIPT_PATH} to exist`);
	accessSync(SCRIPT_PATH, constants.X_OK);
});

test("scripts/lsp-cli.mjs parses as valid ESM (node --check)", () => {
	// Syntax-only check — does not execute the module or spawn any process.
	execFileSync(process.execPath, ["--check", SCRIPT_PATH], { encoding: "utf8" });
});

test("scripts/lsp-cli.mjs --help documents all subcommands", () => {
	const out = execFileSync(process.execPath, [SCRIPT_PATH, "--help"], { encoding: "utf8" });
	for (const subcommand of ["symbols", "workspace", "refs", "def", "hover"]) {
		assert.ok(out.includes(subcommand), `--help output missing subcommand "${subcommand}"`);
	}
});

test("scripts/lsp-cli.mjs rejects an unknown subcommand without spawning the LSP server", () => {
	assert.throws(() => {
		execFileSync(process.execPath, [SCRIPT_PATH, "bogus-subcommand"], { encoding: "utf8", stdio: "pipe" });
	});
});
