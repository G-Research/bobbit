/**
 * Pure argv → sub-phase selection for scripts/run-unit.mjs (TEST-01).
 *
 * `npm run test:unit` has TWO sub-phases (see scripts/run-unit.mjs header):
 *   - node:test logic suite      — tests/*.test.ts + tests/contract/*.test.ts
 *   - Playwright browser fixtures — tests/*.spec.ts (excluding tests/e2e/**
 *     and tests/manual-integration/**, mirroring tests/playwright.config.ts)
 *
 * This module answers, given raw CLI argv, which sub-phase(s) should run and
 * with which arguments — WITHOUT spawning anything — so it can be unit
 * tested directly (see tests/test-unit-args.test.ts) instead of only via a
 * slow end-to-end invocation of the runner itself.
 *
 * Contract:
 *   - No args            → both phases run their full default glob/suite,
 *                           byte-identical to the pre-filter behavior.
 *   - One or more paths   → each path is classified into exactly one phase;
 *                           a phase with no matching args is SKIPPED
 *                           entirely (not run with an empty/no-op filter).
 *   - An unrecognized path → `{ error }` is returned; the caller must fail
 *                           loudly (non-zero exit), never silently skip.
 */
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { NODE_UNIT_GLOBS } from "./test-phase-config.mjs";

const toPosix = (p) => p.replace(/\\/g, "/");

// Minimal glob→RegExp translator. NODE_UNIT_GLOBS (test-phase-config.mjs)
// only ever uses single "*" wildcards with no "**", so this stays
// intentionally small — extend it alongside NODE_UNIT_GLOBS if that changes.
function globToRegExp(glob) {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
	return new RegExp(`^${escaped}$`);
}
const NODE_UNIT_RES = NODE_UNIT_GLOBS.map(globToRegExp);

// Mirrors tests/playwright.config.ts (testDir ".", testMatch "**/*.spec.ts",
// testIgnore ["e2e/**", "manual-integration/**"]) — the unit browser-fixture
// phase's membership. Keep in sync if that config's testIgnore changes.
const BROWSER_UNIT_IGNORE_PREFIXES = ["tests/e2e/", "tests/manual-integration/"];

/** Classify one repo-root-relative, posix-separated path into its sub-phase. */
function classifyRepoRelPath(repoRel) {
	if (repoRel.endsWith(".test.ts")) {
		if (NODE_UNIT_RES.some((re) => re.test(repoRel))) return { phase: "node" };
		return {
			error:
				`${repoRel} is a *.test.ts file but is not part of the unit node phase ` +
				`(node phase globs: ${NODE_UNIT_GLOBS.join(", ")}). ` +
				`If it lives under tests/e2e/ or tests/manual-integration/, run it via ` +
				`npm run test:e2e or npm run test:manual instead.`,
		};
	}
	if (repoRel.endsWith(".spec.ts")) {
		if (repoRel.startsWith("tests/") && !BROWSER_UNIT_IGNORE_PREFIXES.some((p) => repoRel.startsWith(p))) {
			return { phase: "browser" };
		}
		return {
			error:
				`${repoRel} is a *.spec.ts file but is not part of the unit browser-fixture phase ` +
				`(excluded: tests/e2e/**, tests/manual-integration/**). Run it via ` +
				`npm run test:e2e or npm run test:manual instead.`,
		};
	}
	return {
		error: `${repoRel} is neither a *.test.ts (node phase) nor *.spec.ts (browser phase) file — cannot route it to a unit sub-phase.`,
	};
}

/**
 * Resolve raw argv (as given to `npm run test:unit --`) into per-sub-phase
 * test-runner args.
 *
 * Returns one of:
 *   { nodeTestArgs, browserTestArgs } — each either an array of args to pass
 *     to that runner, or `null` meaning "skip this phase entirely".
 *   { error } — argv contained a path that couldn't be routed; both phases
 *     must be skipped and the caller should exit non-zero with this message.
 */
export function resolveUnitSelection(argv, { cwd = process.cwd(), projectRoot }) {
	if (argv.length === 0) {
		return { nodeTestArgs: [...NODE_UNIT_GLOBS], browserTestArgs: [] };
	}

	const nodeTestArgs = [];
	const browserTestArgs = [];
	for (const raw of argv) {
		const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
		if (!existsSync(abs)) {
			return { error: `${raw} does not exist (resolved to ${abs}).` };
		}
		const repoRel = toPosix(relative(projectRoot, abs));
		const result = classifyRepoRelPath(repoRel);
		if (result.error) return { error: result.error };
		if (result.phase === "node") nodeTestArgs.push(repoRel);
		else browserTestArgs.push(repoRel);
	}

	return {
		nodeTestArgs: nodeTestArgs.length > 0 ? nodeTestArgs : null,
		browserTestArgs: browserTestArgs.length > 0 ? browserTestArgs : null,
	};
}
