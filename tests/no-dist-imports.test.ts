import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const TESTS_DIR = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SELF = "no-dist-imports.test.ts";
const EXCLUDED_DIRS = new Set(["e2e", "fullstack", "manual-integration"]);
const PATTERN = /from\s+["']\.\.\/(\.\.\/)?dist\//;

function collect(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) {
			if (EXCLUDED_DIRS.has(name)) continue;
			collect(full, out);
			continue;
		}
		if (!st.isFile()) continue;
		if (!/\.(test|spec)\.ts$/.test(name)) continue;
		if (name === SELF) continue;
		out.push(full);
	}
	return out;
}

test("no test file imports from ../dist/", () => {
	const files = collect(TESTS_DIR);
	const offenders: string[] = [];
	for (const f of files) {
		const src = readFileSync(f, "utf8");
		if (PATTERN.test(src)) offenders.push(f);
	}
	assert.deepEqual(offenders, [], `Test files importing from ../dist/:\n${offenders.join("\n")}`);
});
