/**
 * Phase-invariant guard.
 *
 * Pins the rule that makes the test suite a "no-brainer": every test file under
 * tests/ — except those under tests/manual-integration/** — MUST run in exactly
 * one workflow phase, either `unit` or `e2e`. A file run by no phase (an
 * orphan) silently lets failures slip onto master; a file claimed by two phases
 * wastes wall time and confuses ownership. Both fail this test.
 *
 * The four membership buckets, derived from the SAME sources the runners use so
 * the guard can never drift from reality:
 *   1. unit · node     — scripts/test-phase-config.mjs NODE_UNIT_GLOBS, run by
 *                        scripts/run-unit.mjs (`tsx --test`).
 *   2. unit · browser  — tests/playwright.config.ts (file:// browser fixtures),
 *                        run by scripts/run-unit.mjs (`playwright test`).
 *   3. e2e             — playwright-e2e.config.ts (union across its projects),
 *                        run by the e2e gate.
 *   4. manual-integration — the path tests/manual-integration/**. This is the
 *                        ONLY gate-exempt path. The guard NEVER consults
 *                        playwright-manual.config.ts: a spec that some other
 *                        config happens to collect but that does not physically
 *                        live under tests/manual-integration/ is treated as an
 *                        orphan, by design (no "fourth bucket" loophole).
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { NODE_UNIT_GLOBS } from "../scripts/test-phase-config.mjs";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TESTS_DIR, "..");
const SELF = "test-phase-invariant.test.ts";

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

async function importDefault(absPath: string): Promise<any> {
	// Bound any import-time side effects (e.g. the e2e config's cache bootstrap)
	// to a throwaway temp cache dir so importing for introspection is inert.
	if (!process.env.PWTEST_CACHE_DIR) {
		process.env.PWTEST_CACHE_DIR = join(REPO_ROOT, "node_modules", ".cache", "phase-invariant-pwtest");
	}
	const mod = await import(pathToFileURL(absPath).href);
	return mod.default ?? mod;
}

test("every test file is claimed by exactly one phase (no orphans, no double-claims)", async () => {
	const unitConfigPath = join(TESTS_DIR, "playwright.config.ts");
	const e2eConfigPath = join(REPO_ROOT, "playwright-e2e.config.ts");
	const unitConfig = await importDefault(unitConfigPath);
	const e2eConfig = await importDefault(e2eConfigPath);

	const nodeUnitRes = NODE_UNIT_GLOBS.map((g: string) => globToRegExp(g));

	const files = collectTestFiles(TESTS_DIR);
	const problems: string[] = [];

	for (const abs of files) {
		const repoRel = toPosix(relative(REPO_ROOT, abs));
		const buckets: string[] = [];

		if (nodeUnitRes.some((re) => re.test(repoRel))) buckets.push("unit·node");
		if (configRuns(unitConfig, TESTS_DIR, abs)) buckets.push("unit·browser");
		if (configRuns(e2eConfig, REPO_ROOT, abs)) buckets.push("e2e");
		if (repoRel.startsWith("tests/manual-integration/")) buckets.push("manual-integration");

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
	// Detect a static import / require of a module specifier. Built without a
	// literal `from "<spec>"` sequence so this guard never flags its own source.
	const importsModule = (src: string, spec: string): boolean => {
		const q = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(`(?:from|require\\(\\s*)\\s*["']${q}["']`).test(src);
	};

	const offenders: string[] = [];
	for (const abs of files) {
		const name = abs.split(/[\\/]/).pop()!;
		if (name === SELF) continue; // self uses node:test (it is a .test.ts) — exempt from the scan to avoid pattern self-match
		const src = readFileSync(abs, "utf8");
		const repoRel = toPosix(relative(REPO_ROOT, abs));
		if (name.endsWith(".test.ts") && importsModule(src, "@playwright/test")) {
			offenders.push(`${repoRel} — a *.test.ts must use node:test, not @playwright/test (rename to *.spec.ts or switch runner).`);
		}
		if (name.endsWith(".spec.ts") && importsModule(src, "node:test")) {
			offenders.push(`${repoRel} — a *.spec.ts must use Playwright, not node:test (rename to *.test.ts or switch runner).`);
		}
	}

	assert.deepEqual(offenders, [], `Runner-convention violations:\n${offenders.join("\n")}`);
});
