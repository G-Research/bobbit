#!/usr/bin/env node
/**
 * Guard: forbid NEW hardcoded sleeps in E2E test specs.
 *
 * Why: 78 existing sleeps (`waitForTimeout`, `setTimeout(resolve, …)`,
 * `new Promise(r => setTimeout(r, …))`) in tests/e2e/ are the largest single
 * source of E2E flakiness — they replace event-driven waits with wall-clock
 * gambling. We can't fix all of them in one session, but we MUST stop the
 * bleeding: every new sleep makes the suite worse.
 *
 * Strategy:
 *   - Maintain a frozen baseline of allowed offenders (file → count) in
 *     `no-new-sleeps.baseline.json`.
 *   - On every run, count sleeps per file and compare. If any file exceeds
 *     its baseline, fail. If any file drops below, encourage the author to
 *     update the baseline (but do not fail).
 *   - New files (not in the baseline) are forbidden any sleeps from day 1.
 *
 * Allow-list: harness files (e2e-setup.ts, gateway-harness.ts,
 * in-process-harness*.ts, e2e-{global-setup,teardown,coverage-teardown}.ts)
 * are intentionally exempt — they implement the polling/backoff helpers that
 * tests should use *instead* of inline sleeps.
 *
 * Usage:
 *   node tests/e2e/test-utils/no-new-sleeps.mjs           # check
 *   node tests/e2e/test-utils/no-new-sleeps.mjs --update  # refresh baseline (lower-only)
 *   node tests/e2e/test-utils/no-new-sleeps.mjs --reset   # rebaseline from current state
 *
 * Run automatically from playwright globalSetup so it's part of every
 * `npm run test:e2e` invocation.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const E2E_ROOT = join(REPO_ROOT, "tests", "e2e");
const BASELINE_PATH = join(__dirname, "no-new-sleeps.baseline.json");

const ALLOW_LIST = new Set([
	"e2e-setup.ts",
	"gateway-harness.ts",
	"in-process-harness.ts",
	"in-process-harness-realpush.ts",
	"in-process-mock-bridge.mjs",
	"e2e-global-setup.ts",
	"e2e-teardown.ts",
	"e2e-coverage-teardown.ts",
	"mock-agent-core.mjs",
	"mock-agent.mjs",
	"port-test-helper.mjs",
]);

// Patterns that count as a "sleep". Each pattern must match exactly one
// occurrence per source location. We intentionally do NOT match
// `setTimeout(() => rej(...), n)` (timeout guards) or `setTimeout` used
// as a deadline inside polling helpers — those are correct.
const SLEEP_PATTERNS = [
	// page.waitForTimeout(n)
	/\bwaitForTimeout\s*\(/g,
	// new Promise(r => setTimeout(r, n))  /  new Promise((r) => setTimeout(r, n))
	/new Promise\s*\(\s*\(?[a-zA-Z_$][\w$]*\)?\s*=>\s*setTimeout\s*\(/g,
	// await sleep(n) / await delay(n)
	/\bawait\s+(?:sleep|delay)\s*\(/g,
];

function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "test-utils" || entry.name === "node_modules") continue;
			out.push(...walk(full));
		} else if (/\.(ts|mjs|js)$/.test(entry.name)) {
			out.push(full);
		}
	}
	return out;
}

function countSleeps(file) {
	const src = readFileSync(file, "utf8");
	let n = 0;
	for (const re of SLEEP_PATTERNS) {
		re.lastIndex = 0;
		const matches = src.match(re);
		if (matches) n += matches.length;
	}
	return n;
}

function isAllowListed(file) {
	const rel = relative(E2E_ROOT, file).replace(/\\/g, "/");
	const base = rel.split("/").pop();
	return ALLOW_LIST.has(base);
}

function buildCurrentMap() {
	const files = walk(E2E_ROOT);
	const map = {};
	for (const f of files) {
		if (isAllowListed(f)) continue;
		const n = countSleeps(f);
		if (n > 0) {
			const rel = relative(E2E_ROOT, f).replace(/\\/g, "/");
			map[rel] = n;
		}
	}
	return map;
}

function loadBaseline() {
	if (!existsSync(BASELINE_PATH)) return {};
	return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

function saveBaseline(map) {
	const sorted = Object.fromEntries(
		Object.entries(map).sort(([a], [b]) => a.localeCompare(b)),
	);
	writeFileSync(BASELINE_PATH, JSON.stringify(sorted, null, "\t") + "\n");
}

function main() {
	const arg = process.argv[2];
	const current = buildCurrentMap();

	if (arg === "--reset") {
		saveBaseline(current);
		const total = Object.values(current).reduce((a, b) => a + b, 0);
		console.log(`[no-new-sleeps] baseline reset: ${Object.keys(current).length} files, ${total} occurrences`);
		return;
	}

	const baseline = loadBaseline();
	const violations = [];
	const reductions = [];

	for (const [file, count] of Object.entries(current)) {
		const allowed = baseline[file] ?? 0;
		if (count > allowed) {
			violations.push({ file, allowed, actual: count });
		} else if (count < allowed) {
			reductions.push({ file, allowed, actual: count });
		}
	}

	// Removed-from-baseline files: count must stay 0
	for (const file of Object.keys(baseline)) {
		if (!(file in current)) reductions.push({ file, allowed: baseline[file], actual: 0 });
	}

	if (arg === "--update") {
		// Lower-only update: ratchet baseline down to current actual counts,
		// but never up. New offenders are still rejected.
		if (violations.length > 0) {
			console.error(`[no-new-sleeps] cannot --update while violations exist:`);
			for (const v of violations) {
				console.error(`  ${v.file}: ${v.actual} > baseline ${v.allowed}`);
			}
			process.exit(1);
		}
		const next = {};
		for (const [file, count] of Object.entries(current)) {
			next[file] = count;
		}
		saveBaseline(next);
		const total = Object.values(next).reduce((a, b) => a + b, 0);
		console.log(`[no-new-sleeps] baseline ratcheted: ${Object.keys(next).length} files, ${total} occurrences`);
		return;
	}

	if (reductions.length > 0) {
		console.log(`[no-new-sleeps] ${reductions.length} file(s) below baseline — run with --update to ratchet:`);
		for (const r of reductions) {
			console.log(`  ${r.file}: ${r.actual} (baseline ${r.allowed})`);
		}
	}

	if (violations.length > 0) {
		console.error(`\n[no-new-sleeps] FAIL: ${violations.length} file(s) added new sleeps:`);
		for (const v of violations) {
			console.error(`  ${v.file}: ${v.actual} > baseline ${v.allowed} (added ${v.actual - v.allowed})`);
		}
		console.error(`\nReplace hardcoded sleeps with event-driven waits from tests/e2e/e2e-setup.ts:`);
		console.error(`  - waitForGateStatus / waitForSessionStatus / waitForWsEvent`);
		console.error(`  - statusPredicate / queueLenPredicate / agentEndPredicate`);
		console.error(`  - page.waitForFunction(...) for browser tests`);
		console.error(`If a hook is genuinely missing, add one to the harness; do not inline-sleep.`);
		process.exit(1);
	}

	const total = Object.values(current).reduce((a, b) => a + b, 0);
	console.log(`[no-new-sleeps] OK — ${Object.keys(current).length} files / ${total} sleeps within baseline`);
}

main();
