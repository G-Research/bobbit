import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
/**
 * Migrated from tests/grep-dash-pattern.spec.ts (v2-dom tier).
 *
 * Documentation-gap regression: the grep tool passes patterns straight to
 * ripgrep without a `--` end-of-options separator, so a pattern starting with
 * `--` is misinterpreted as a flag. The fix is documentation — the tool YAML
 * docs must warn agents and point them at the bash `rg --` workaround. This is a
 * pure filesystem/YAML assertion (no DOM); it reads the canonical tool defs the
 * same way the legacy spec did.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse } from "yaml";

/** Scan tool YAML files from defaults/tools/ (canonical builtins) or .bobbit/config/tools/ (fallback) */
function loadToolDefs(): Array<{ name: string; docs?: string }> {
	const root = process.cwd();
	const defaultsDir = resolve(root, "defaults", "tools");
	const configDir = resolve(root, ".bobbit", "config", "tools");
	const toolsDir = readdirSync(defaultsDir, { withFileTypes: true }).some(e => e.isDirectory()) ? defaultsDir : configDir;
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

describe("grep/bash dash-pattern documentation gap", () => {
	it("grep tool docs warn about --prefixed patterns", () => {
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

	it("bash tool docs warn about rg -- separator for dash-prefixed patterns", () => {
		const tools = loadToolDefs();
		const bash = tools.find((t) => t.name === "bash");
		expect(bash, "bash entry must exist in tool YAMLs").toBeTruthy();
		expect(bash!.docs, "bash docs must exist").toBeTruthy();

		const docs = bash!.docs!;
		// Must mention rg/grep gotcha about -- separator
		expect(docs).toMatch(/--/);
		expect(docs.toLowerCase()).toContain("pattern");
	});
});
