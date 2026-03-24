/**
 * Reproducing test for the grep `--` pattern bug (documentation gap).
 *
 * The grep tool in pi-coding-agent passes patterns directly to ripgrep
 * without a `--` end-of-options separator (grep.js: `args.push(pattern, searchPath)`).
 * When the pattern starts with `--` (e.g. `--extension`), rg interprets it as a flag.
 *
 * Since the bug is in a dependency we can't patch, the fix is documentation:
 * tools.json must warn agents about this and tell them to use bash with `--`.
 *
 * This test fails until the documentation fix is applied, then passes.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const toolsJsonPath = resolve(__dirname, "..", ".bobbit", "config", "tools.json");

test("grep tool docs warn about --prefixed patterns", () => {
	const tools: Array<{ name: string; docs?: string }> = JSON.parse(
		readFileSync(toolsJsonPath, "utf-8"),
	);
	const grep = tools.find((t) => t.name === "grep");
	expect(grep, "grep entry must exist in tools.json").toBeTruthy();
	expect(grep!.docs, "grep docs must exist").toBeTruthy();

	const docs = grep!.docs!.toLowerCase();
	// Must warn about patterns starting with --
	expect(docs).toContain("--");
	expect(docs).toMatch(/pattern.*start.*dash|dash.*prefix|--.*pattern.*flag/i);
	// Must mention the bash workaround with -- separator
	expect(docs).toMatch(/rg\s+--\s+/);
});

test("bash tool docs warn about rg -- separator for dash-prefixed patterns", () => {
	const tools: Array<{ name: string; docs?: string }> = JSON.parse(
		readFileSync(toolsJsonPath, "utf-8"),
	);
	const bash = tools.find((t) => t.name === "bash");
	expect(bash, "bash entry must exist in tools.json").toBeTruthy();
	expect(bash!.docs, "bash docs must exist").toBeTruthy();

	const docs = bash!.docs!;
	// Must mention rg/grep gotcha about -- separator
	expect(docs).toMatch(/rg\s+--\s+/);
	expect(docs.toLowerCase()).toMatch(/dash|--.*pattern|pattern.*--/);
});
