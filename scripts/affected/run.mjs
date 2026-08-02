#!/usr/bin/env node
// Affected + cached Vitest runner (MVP).
//
//   node scripts/affected/run.mjs [--base <ref>] [--dry] [--no-cache] [--all]
//
// Selects the Vitest tests reachable from the working changes (vs merge-base
// with the base ref), drops the ones whose dependency closure is unchanged
// since their last PASS, and runs only the remainder. On success it records the
// new verdicts. Browser (*.spec.ts) affected files are reported but not run
// here (Playwright tier).
//
// Flags:
//   --base <ref>  base ref for the diff (default: the remote's primary branch,
//                 derived from origin/HEAD — never assume main/master)
//   --dry         print the plan and exit without running
//   --no-cache    ignore + do not update the result cache
//   --all         ignore git; consider every test (baseline / cache warm)
//   --changed a,b explicit changed-file list (bypass git; for CI / simulation)

import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { buildGraph, affectedTests, REPO_ROOT } from "./graph.mjs";
import { loadCache, saveCache, partition, record, runnerFingerprint } from "./cache.mjs";

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(name);
const DRY = has("--dry");
const NO_CACHE = has("--no-cache");
const ALL = has("--all");

function git(args) {
	try {
		return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
	} catch {
		return "";
	}
}

function resolveBase() {
	const explicit = arg("--base", "");
	if (explicit) return explicit;
	// Derive the primary branch from the remote's own HEAD — never assume
	// main/master. `git symbolic-ref refs/remotes/origin/HEAD` is the source of
	// truth (falls back to `git remote show` when the symref is unset).
	const symref = git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]); // e.g. refs/remotes/origin/main
	if (symref) {
		const ref = symref.replace(/^refs\/remotes\//, "");
		if (git(["rev-parse", "--verify", "--quiet", ref])) return ref;
	}
	const shown = git(["remote", "show", "origin"]).match(/HEAD branch:\s*(\S+)/);
	if (shown && git(["rev-parse", "--verify", "--quiet", `origin/${shown[1]}`])) return `origin/${shown[1]}`;
	return "HEAD~1";
}

function changedFiles(base) {
	const mb = git(["merge-base", base, "HEAD"]) || base;
	const committed = git(["diff", "--name-only", `${mb}...HEAD`]);
	const unstaged = git(["diff", "--name-only"]);
	const staged = git(["diff", "--name-only", "--cached"]);
	const untracked = git(["ls-files", "--others", "--exclude-standard"]);
	const set = new Set(
		[committed, unstaged, staged, untracked]
			.join("\n")
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean),
	);
	return [...set];
}

const t0 = Date.now();
const graph = buildGraph();
const total = graph.testFiles.length;

let changed = [];
let plan;
const changedOverride = arg("--changed", "");
if (ALL) {
	plan = { affected: new Set(graph.testFiles), runAll: true, reason: "--all" };
} else if (changedOverride) {
	changed = changedOverride.split(",").map((s) => s.trim()).filter(Boolean);
	plan = affectedTests(graph, changed);
	console.log(`changed (explicit)=${changed.length}`);
	console.log(changed.map((c) => `  ~ ${c}`).join("\n"));
} else {
	const base = resolveBase();
	changed = changedFiles(base);
	plan = affectedTests(graph, changed);
	console.log(`base=${base}  changed files=${changed.length}`);
	if (changed.length) console.log(changed.map((c) => `  ~ ${c}`).join("\n"));
}

const affected = [...plan.affected];
const vitestAffected = affected.filter((t) => t.endsWith(".test.ts"));
const browserAffected = affected.filter((t) => t.endsWith(".spec.ts"));

const fp = runnerFingerprint();
const cache = NO_CACHE ? {} : loadCache();
const { hits, misses } = NO_CACHE
	? { hits: new Set(), misses: new Set(vitestAffected) }
	: partition(cache, fp, graph, vitestAffected);

const toRun = [...misses];

console.log(`\n=== affected-test plan ===`);
if (plan.runAll) console.log(`runAll: ${plan.reason}`);
console.log(`suite total (vitest):     ${total}`);
console.log(`affected (vitest):        ${vitestAffected.length}  (${pct(vitestAffected.length, total)})`);
console.log(`  cache hits (skipped):   ${hits.size}`);
console.log(`  to run:                 ${toRun.length}  (${pct(toRun.length, total)})`);
if (browserAffected.length) console.log(`affected browser specs:   ${browserAffected.length} (run via Playwright tier)`);

if (DRY) {
	console.log(`\n[dry] would run:\n${toRun.map((t) => "  " + t).join("\n") || "  (nothing)"}`);
	process.exit(0);
}

if (toRun.length === 0) {
	console.log(`\nNothing to run — all affected tests are cache hits. (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
	process.exit(0);
}

console.log(`\nrunning ${toRun.length} vitest file(s)...\n`);
const vitestBin = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
const res = spawnSync(
	process.execPath,
	[vitestBin, "run", "--config", "vitest.config.ts", "--silent=passed-only", ...toRun],
	{ cwd: REPO_ROOT, stdio: "inherit" },
);

const wall = ((Date.now() - t0) / 1000).toFixed(1);
if (res.status === 0) {
	if (!NO_CACHE) {
		record(cache, fp, graph, misses, "pass");
		saveCache(cache);
	}
	console.log(`\nPASS — ran ${toRun.length}/${total} (${pct(toRun.length, total)}) in ${wall}s; ${hits.size} cache hits skipped.`);
	process.exit(0);
} else {
	console.log(`\nFAIL — ran ${toRun.length}/${total} in ${wall}s (verdicts not cached).`);
	process.exit(res.status || 1);
}

function pct(a, b) {
	return `${((a / b) * 100).toFixed(1)}%`;
}
