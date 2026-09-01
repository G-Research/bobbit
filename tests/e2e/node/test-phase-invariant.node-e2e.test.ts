/**
 * Pins canonical exactly-once phase ownership. Every runnable file under tests/
 * belongs to one semantic convention; tests/support is imported-only and cannot
 * contain runnable suffixes. Discovery and phase ownership share one classifier.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeImportedModules } from "../../../scripts/testing/layout-policy.mjs";
import { classifyTestPath, discoverTests } from "../../../scripts/testing-v2/test-discovery.mjs";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = resolve(TESTS_DIR, "..");
const toPosix = (path: string) => path.replace(/\\/g, "/");

function collectTestFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const stats = statSync(full);
		if (stats.isDirectory()) {
			if (name !== "node_modules") collectTestFiles(full, out);
		} else if (stats.isFile() && /\.(test|spec)\.ts$/.test(name)) {
			out.push(full);
		}
	}
	return out;
}

test("every runnable test has exactly one canonical phase owner", () => {
	const discovery = discoverTests({ repoRoot: REPO_ROOT });
	const files = collectTestFiles(TESTS_DIR).map((path) => toPosix(relative(REPO_ROOT, path))).sort();
	const problems: string[] = [];

	for (const path of files) {
		const owner = classifyTestPath(path);
		if (!owner) problems.push(`ORPHAN: ${path} — move it to a canonical semantic destination with npm run test:new -- <semantic> <name>.`);
	}
	if (new Set(discovery.all).size !== discovery.all.length) problems.push("DOUBLE-CLAIM: canonical discovery returned a duplicate path.");
	if (JSON.stringify(files) !== JSON.stringify(discovery.all)) {
		problems.push("DISCOVERY-MISMATCH: canonical discovery does not equal the complete runnable tests/ inventory.");
	}

	assert.deepEqual(problems, [], `Phase-invariant violations:\n${problems.join("\n")}`);
});

test("runner-convention purity: .test.ts ⇒ node:test, .spec.ts ⇒ Playwright", () => {
	const offenders: string[] = [];
	for (const absolutePath of collectTestFiles(TESTS_DIR)) {
		const name = absolutePath.split(/[\\/]/).pop()!;
		const repoPath = toPosix(relative(REPO_ROOT, absolutePath));
		const imports = new Set(runtimeImportedModules(repoPath, readFileSync(absolutePath, "utf8")));
		if (name.endsWith(".test.ts") && imports.has("@playwright/test")) {
			offenders.push(`${repoPath} — a *.test.ts must use node:test, not @playwright/test.`);
		}
		if (name.endsWith(".spec.ts") && imports.has("node:test")) {
			offenders.push(`${repoPath} — a *.spec.ts must use Playwright, not node:test.`);
		}
	}
	assert.deepEqual(offenders, [], `Runner-convention violations:\n${offenders.join("\n")}`);
});
