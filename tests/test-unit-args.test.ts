/**
 * Pinning test for TEST-01: `npm run test:unit -- <paths...>` affected-only
 * selection (scripts/test-unit-args.mjs, wired into scripts/run-unit.mjs).
 *
 * Exercises the pure `resolveUnitSelection` seam directly rather than
 * spawning the full ~90s unit phase from within itself. Pins:
 *   - zero-arg → full globs for both phases (byte-identical old behavior)
 *   - a single node-phase *.test.ts arg → node phase only, exactly that file
 *   - a single browser-phase *.spec.ts arg → browser phase only, that file
 *   - mixed args → both phases run, each with only its matching files
 *   - a path outside the unit phases (tests/e2e/**) → a clear, non-silent error
 *   - a nonexistent path → a clear, non-silent error
 *
 * Also re-asserts that tests/test-phase-invariant.test.ts's node-unit glob
 * source (NODE_UNIT_GLOBS) is what this module classifies against, so the
 * two can never silently drift apart.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveUnitSelection } from "../scripts/test-unit-args.mjs";
import { NODE_UNIT_GLOBS } from "../scripts/test-phase-config.mjs";

const TESTS_DIR = resolve(fileURLToPath(import.meta.url), "..");
const projectRoot = resolve(TESTS_DIR, "..");

// Real repo files used as fixtures — they must keep existing for these pins
// to mean anything; if renamed, update these constants alongside the rename.
const NODE_PHASE_FILE = "tests/atomic-json.test.ts";
const BROWSER_PHASE_FILE = "tests/abort-and-focus.spec.ts";
const E2E_ONLY_FILE = "tests/e2e/activate-skill.spec.ts";

test("zero args → both phases get the full default glob/suite", () => {
	const result = resolveUnitSelection([], { projectRoot });
	assert.deepEqual(result, { nodeTestArgs: [...NODE_UNIT_GLOBS], browserTestArgs: [] });
});

test("single node-phase *.test.ts arg → node phase only, exactly that file", () => {
	const result = resolveUnitSelection([NODE_PHASE_FILE], { cwd: projectRoot, projectRoot });
	assert.deepEqual(result, { nodeTestArgs: [NODE_PHASE_FILE], browserTestArgs: null });
});

test("single browser-phase *.spec.ts arg → browser phase only, exactly that file", () => {
	const result = resolveUnitSelection([BROWSER_PHASE_FILE], { cwd: projectRoot, projectRoot });
	assert.deepEqual(result, { nodeTestArgs: null, browserTestArgs: [BROWSER_PHASE_FILE] });
});

test("mixed node + browser args → both phases run, each scoped to its own files", () => {
	const result = resolveUnitSelection([NODE_PHASE_FILE, BROWSER_PHASE_FILE], { cwd: projectRoot, projectRoot });
	assert.deepEqual(result, { nodeTestArgs: [NODE_PHASE_FILE], browserTestArgs: [BROWSER_PHASE_FILE] });
});

test("a path relative to an arbitrary cwd resolves the same as repo-root-relative", () => {
	// cwd = tests/, so the file is reached as "atomic-json.test.ts" (no ../).
	const fromSubdir = resolveUnitSelection(["atomic-json.test.ts"], { cwd: TESTS_DIR, projectRoot });
	assert.deepEqual(fromSubdir, { nodeTestArgs: [NODE_PHASE_FILE], browserTestArgs: null });
});

test("a *.spec.ts under tests/e2e/ is neither unit sub-phase → clear error, not silent skip", () => {
	const result = resolveUnitSelection([E2E_ONLY_FILE], { cwd: projectRoot, projectRoot });
	assert.equal(result.nodeTestArgs, undefined);
	assert.equal(result.browserTestArgs, undefined);
	assert.match(result.error, /not part of the unit browser-fixture phase/);
});

test("a nonexistent path → clear error, not silent skip", () => {
	const result = resolveUnitSelection(["tests/does-not-exist.test.ts"], { cwd: projectRoot, projectRoot });
	assert.equal(result.nodeTestArgs, undefined);
	assert.equal(result.browserTestArgs, undefined);
	assert.match(result.error, /does not exist/);
});

test("a path with neither .test.ts nor .spec.ts suffix → clear error, not silent skip", () => {
	const result = resolveUnitSelection(["scripts/run-unit.mjs"], { cwd: projectRoot, projectRoot });
	assert.equal(result.nodeTestArgs, undefined);
	assert.equal(result.browserTestArgs, undefined);
	assert.match(result.error, /neither a \*\.test\.ts.*nor \*\.spec\.ts/);
});
