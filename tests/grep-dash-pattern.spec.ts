/**
 * Reproducing test for the grep `--` pattern bug (documentation gap).
 *
 * The grep tool in pi-coding-agent passes patterns directly to ripgrep
 * without a `--` end-of-options separator (grep.js: `args.push(pattern, searchPath)`).
 * When the pattern starts with `--` (e.g. `--extension`), rg interprets it as a flag.
 *
 * Since the bug is in a dependency we can't patch, the fix is documentation:
 * tool YAML docs must warn agents about this and tell them to use bash with `--`.
 *
 * This test fails until the documentation fix is applied, then passes.
 */
import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Scan tool YAML files from .bobbit/config/tools/<group>/*.yaml and return all tools as {name, docs} objects */
function loadToolDefs(): Array<{ name: string; docs?: string }> {
	const toolsDir = resolve(__dirname, "..", ".bobbit", "config", "tools");
	const tools: Array<{ name: string; docs?: string }> = [];
	for (const group of readdirSync(toolsDir, { withFileTypes: true })) {
		if (!group.isDirectory()) continue;
		const groupPath = join(toolsDir, group.name);
		for (const file of readdirSync(groupPath)) {
			if (!file.endsWith(".yaml")) continue;
			const raw = readFileSync(join(groupPath, file), "utf-8");
			const data = parse(raw);
			if (data?.name) tools.push({ name: data.name, docs: data.docs });
		}
	}
	return tools;
}

test("grep tool docs warn about --prefixed patterns", () => {
	const tools = loadToolDefs();
	const grep = tools.find((t) => t.name === "grep");
	expect(grep, "grep entry must exist in tool YAMLs").toBeTruthy();
	expect(grep!.docs, "grep docs must exist").toBeTruthy();

	const docs = grep!.docs!;
	// Must warn about patterns starting with --
	expect(docs).toContain("--");
	expect(docs.toLowerCase()).toContain("pattern");
	// Must mention the bash workaround with -- separator
	expect(docs).toMatch(/rg\s+--/);

});

test("bash tool docs warn about rg -- separator for dash-prefixed patterns", () => {
	const tools = loadToolDefs();
	const bash = tools.find((t) => t.name === "bash");
	expect(bash, "bash entry must exist in tool YAMLs").toBeTruthy();
	expect(bash!.docs, "bash docs must exist").toBeTruthy();

	const docs = bash!.docs!;
	// Must mention rg/grep gotcha about -- separator
	expect(docs).toMatch(/--/);
	expect(docs.toLowerCase()).toContain("pattern");
});
