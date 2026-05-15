/**
 * Regression: `scripts/test-filter.mjs` must extract the Playwright JSON
 * payload from stdout even when `node:test` (imported by some `*.spec.ts`
 * files) interleaves TAP / spec output around it.
 *
 * Symptom prior to fix: a single early `{` in TAP test names (e.g.
 * `lsp_definition({symbolName:'add'})`) defeated the naive
 * `raw.indexOf('{')` recovery path, the filter dumped the raw JSON and
 * exited 1, and the verifier's "Unit tests" gate step failed even though
 * Playwright itself had passed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const filterPath = path.resolve(here, "..", "scripts", "test-filter.mjs");

function runFilter(stdin: string, args: string[] = []): { stdout: string; stderr: string; code: number } {
	const r = spawnSync(process.execPath, [filterPath, ...args], {
		input: stdin,
		encoding: "utf8",
	});
	return { stdout: r.stdout || "", stderr: r.stderr || "", code: r.status ?? -1 };
}

function makeReport(opts: { expected: number; unexpected?: number; skipped?: number; flaky?: number; duration?: number }) {
	return {
		config: { configFile: "tests/playwright.config.ts" },
		suites: [],
		errors: [],
		stats: {
			startTime: "2026-05-15T00:00:00.000Z",
			duration: opts.duration ?? 1234,
			expected: opts.expected,
			skipped: opts.skipped ?? 0,
			unexpected: opts.unexpected ?? 0,
			flaky: opts.flaky ?? 0,
		},
	};
}

test("clean Playwright JSON parses and prints PASSED summary", () => {
	const raw = JSON.stringify(makeReport({ expected: 10 }));
	const { stdout, code } = runFilter(raw);
	assert.equal(code, 0);
	assert.match(stdout, /^PASSED: 10\/10 passed/m);
});

test("JSON preceded by node:test TAP-with-brace noise is recovered", () => {
	// Real-world contamination: a test title that contains a `{` character,
	// followed later by Playwright's actual JSON payload. Pre-fix, the
	// recovery latched onto the brace inside the test name and failed.
	const noise =
		"\u25b6 spawnLspChild \u2014 sandbox guard\n" +
		"  \u2714 lsp_definition({symbolName:'add'}) matches explicit coords (1.0ms)\n" +
		"  \u2714 lsp_references({symbolName:'add'}) returns call-site list (1.0ms)\n";
	const json = JSON.stringify(makeReport({ expected: 5, skipped: 1 }), null, 2);
	const raw = noise + "\n" + json + "\n";
	const { stdout, code } = runFilter(raw);
	assert.equal(code, 0, `filter exited ${code}; stdout=${stdout.slice(0, 200)}`);
	assert.match(stdout, /PASSED: 5\/6 passed, 1 skipped/);
});

test("JSON with trailing TAP/junk after the closing brace is recovered", () => {
	const json = JSON.stringify(makeReport({ expected: 3 }), null, 2);
	const raw = json + "\nstray TAP line that should be ignored\n";
	const { stdout, code } = runFilter(raw);
	assert.equal(code, 0);
	assert.match(stdout, /PASSED: 3\/3 passed/);
});

test("JSON with trailing junk containing braces is recovered (balanced extraction)", () => {
	// Regression for the low-severity test-filter bug: trimming to the
	// final `}` in `raw` is wrong when trailing TAP / debug output itself
	// contains `}` characters. The balanced-brace extractor must lock
	// onto the END of the JSON payload, not the last `}` in the buffer.
	const json = JSON.stringify(makeReport({ expected: 7 }), null, 2);
	const noise =
		"\n" +
		"\u2714 test passed with template literal `${value}` (1ms)\n" +
		"# subtest: assert.deepEqual({a:1, b:{c:2}}, ...) succeeded\n" +
		"debug: closing brace } at end of error trace\n" +
		"another stray } floating in the noise\n";
	const raw = json + noise;
	const { stdout, code } = runFilter(raw);
	assert.equal(code, 0, `filter exited ${code}; stdout=${stdout.slice(0, 200)}`);
	assert.match(stdout, /PASSED: 7\/7 passed/);
});

test("JSON preceded AND followed by brace-containing noise is recovered", () => {
	// Hardest case: brace noise on both sides of the JSON. Pre-fix, the
	// recovery latched onto a leading `{` (from the noise) and the last
	// `}` (also from the noise), JSON.parse failed, and the filter
	// degraded to passthrough+exit-1.
	const leading =
		"\u25b6 some test name with { in it (10ms)\n" +
		"# yaml-ish: { foo: 1 }\n";
	const json = JSON.stringify(makeReport({ expected: 2 }), null, 2);
	const trailing = "\n# epilogue with } characters } sprinkled }\n";
	const raw = leading + json + trailing;
	const { stdout, code } = runFilter(raw);
	assert.equal(code, 0, `filter exited ${code}; stdout=${stdout.slice(0, 200)}`);
	assert.match(stdout, /PASSED: 2\/2 passed/);
});

test("unrecoverable garbage exits non-zero", () => {
	const { code } = runFilter("not json at all and no braces here\n");
	assert.equal(code, 1);
});

test("--full passes input through unchanged", () => {
	const raw = "anything at all { broken } here";
	const { stdout, code } = runFilter(raw, ["--full"]);
	assert.equal(code, 0);
	assert.equal(stdout, raw);
});
