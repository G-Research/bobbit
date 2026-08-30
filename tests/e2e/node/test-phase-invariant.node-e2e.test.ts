/**
 * Phase-invariant guard.
 *
 * Pins the rule that makes the test suite a "no-brainer": every test file under
 * tests/ — except those under tests/manual-integration/** — MUST run in exactly
 * one workflow phase, either `unit` or `e2e`. A file run by no phase (an
 * orphan) silently lets failures slip onto master; a file claimed by two phases
 * wastes wall time and confuses ownership. Both fail this test.
 *
 * Membership is derived from the SAME side-effect-free discovery used by the
 * current runners. Canonical and transitional convention-owned tests come from
 * scripts/testing-v2/test-discovery.mjs; legacy unit paths retain their shared
 * NODE_UNIT_GLOBS and tests/playwright.config.ts checks. Manual integration is
 * the only gate-exempt lane. Discovery rejects duplicate ownership itself.
 *
 * Also pins the runner-convention purity that keeps the two unit runners
 * separable: *.test.ts ⇒ node:test, *.spec.ts ⇒ Playwright. A *.test.ts must
 * never import @playwright/test and a *.spec.ts must never import node:test.
 *
 * See docs/design/test-phase-invariant.md and docs/testing-strategy.md.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createE2EPhaseSelection, createUnitBrowserPhaseSelection, NODE_UNIT_GLOBS } from "../../../scripts/test-phase-config.mjs";
import { runtimeImportedModules } from "../../../scripts/testing/layout-policy.mjs";
import { classifyTestPath, discoverTests } from "../../../scripts/testing-v2/test-discovery.mjs";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = resolve(TESTS_DIR, "..");

// Playwright's built-in default when a project sets neither testMatch nor a
// config-level testMatch. We only have .ts test files, so this subset suffices.
const PLAYWRIGHT_DEFAULT_MATCH = ["**/*.spec.ts", "**/*.test.ts"];

/** Convert a Playwright/minimatch-style glob to an anchored RegExp. */
function globToRegExp(glob: string): RegExp {
	let re = "^";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				i++; // consume the second '*'
				if (glob[i + 1] === "/") {
					i++; // consume the trailing '/'
					re += "(?:.*/)?"; // '**/' ⇒ zero or more path segments
				} else {
					re += ".*"; // bare '**' ⇒ anything, including '/'
				}
			} else {
				re += "[^/]*"; // single '*' ⇒ anything but '/'
			}
		} else if (c === "?") {
			re += "[^/]";
		} else if (".+^${}()|[]\\/".includes(c)) {
			re += "\\" + c;
		} else {
			re += c;
		}
	}
	return new RegExp(re + "$");
}

const toPosix = (p: string) => p.replace(/\\/g, "/");
const asArray = <T,>(v: T | T[] | undefined): T[] =>
	v === undefined ? [] : Array.isArray(v) ? v : [v];

/** Recursively collect every *.test.ts / *.spec.ts under `dir`. */
function collectTestFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) {
			if (name === "node_modules") continue;
			collectTestFiles(full, out);
		} else if (st.isFile() && /\.(test|spec)\.ts$/.test(name)) {
			out.push(full);
		}
	}
	return out;
}

interface ProjectLike {
	testDir?: string;
	testMatch?: string | string[];
	testIgnore?: string | string[];
}

/**
 * Does a Playwright config (resolved relative to `configDir`) run `absFile`?
 * A file is run if ANY of the config's projects matches it (union semantics):
 * matched by a testMatch glob and not excluded by a testIgnore glob, with all
 * globs evaluated against the path relative to that project's testDir.
 */
function configRuns(config: any, configDir: string, absFile: string): boolean {
	const projects: ProjectLike[] = Array.isArray(config?.projects) && config.projects.length > 0
		? config.projects
		: [config]; // configs without projects are themselves a single "project"
	const filePosix = toPosix(absFile);
	for (const project of projects) {
		const testDirAbs = resolve(configDir, project.testDir ?? config.testDir ?? ".");
		const rel = toPosix(relative(testDirAbs, absFile));
		if (rel.startsWith("../")) continue; // file is outside this project's testDir
		const matchGlobs = asArray(project.testMatch ?? config.testMatch).length > 0
			? asArray(project.testMatch ?? config.testMatch)
			: PLAYWRIGHT_DEFAULT_MATCH;
		const ignoreGlobs = asArray(project.testIgnore ?? config.testIgnore);
		const matched = matchGlobs.some((g) => globToRegExp(g).test(rel));
		if (!matched) continue;
		const ignored = ignoreGlobs.some((g) => globToRegExp(g).test(rel));
		if (!ignored) return true;
		void filePosix;
	}
	return false;
}

test("every test file is claimed by exactly one phase (no orphans, no double-claims)", () => {
	const unitConfig = createUnitBrowserPhaseSelection();
	const e2eConfig = { projects: Object.values(createE2EPhaseSelection()) };

	const nodeUnitRes = NODE_UNIT_GLOBS.map((g: string) => globToRegExp(g));
	const discovery = discoverTests({ repoRoot: REPO_ROOT });
	const discoveredPaths = new Set(discovery.all);

	const files = collectTestFiles(TESTS_DIR);
	const problems: string[] = [];

	for (const abs of files) {
		const repoRel = toPosix(relative(REPO_ROOT, abs));
		const buckets: string[] = [];

		if (discoveredPaths.has(repoRel)) {
			// Convention ownership is runner discovery itself, not a second set of
			// path globs. This branch is exclusive so canonical and transitional
			// paths are each claimed exactly once during the dual-root migration.
			const owner = classifyTestPath(repoRel);
			if (owner?.phase === "unit") buckets.push(`unit·${owner.runner}`);
			else if (owner?.phase === "browser") buckets.push("unit·browser");
			else if (owner?.phase === "e2e") buckets.push("e2e");
			else if (owner?.phase === "manual") buckets.push("manual");
		} else {
			if (nodeUnitRes.some((re: RegExp) => re.test(repoRel))) buckets.push("unit·node");
			if (configRuns(unitConfig, TESTS_DIR, abs)) buckets.push("unit·browser");
			if (configRuns(e2eConfig, REPO_ROOT, abs)) buckets.push("e2e");
			if (repoRel.startsWith("tests/manual-integration/")) buckets.push("manual-integration");
		}

		if (buckets.length === 0) {
			problems.push(`ORPHAN: ${repoRel} — runs in no phase. Add it to a unit/e2e config or move it under tests/manual-integration/.`);
		} else if (buckets.length > 1) {
			problems.push(`DOUBLE-CLAIM: ${repoRel} — claimed by [${buckets.join(", ")}]. A file must run in exactly one phase.`);
		}
	}

	assert.equal(
		problems.length,
		0,
		`Phase-invariant violations (${problems.length}):\n${problems.join("\n")}`,
	);
});

test("runner-convention purity: .test.ts ⇒ node:test, .spec.ts ⇒ Playwright", () => {
	const files = collectTestFiles(TESTS_DIR);
	const offenders: string[] = [];
	for (const abs of files) {
		const name = abs.split(/[\\/]/).pop()!;
		const src = readFileSync(abs, "utf8");
		const repoRel = toPosix(relative(REPO_ROOT, abs));
		const imports = new Set(runtimeImportedModules(repoRel, src));
		if (name.endsWith(".test.ts") && imports.has("@playwright/test")) {
			offenders.push(`${repoRel} — a *.test.ts must use node:test, not @playwright/test (rename to *.spec.ts or switch runner).`);
		}
		if (name.endsWith(".spec.ts") && imports.has("node:test")) {
			offenders.push(`${repoRel} — a *.spec.ts must use Playwright, not node:test (rename to *.test.ts or switch runner).`);
		}
	}

	assert.deepEqual(offenders, [], `Runner-convention violations:\n${offenders.join("\n")}`);
});
