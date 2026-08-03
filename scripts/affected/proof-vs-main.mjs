#!/usr/bin/env node
// PROOF: run affected-selection against real recent commits on origin/main.
// For each commit, take the files it actually changed and compute how many
// Vitest test files the affected-runner would select vs the full suite.
//
//   node scripts/affected/proof-vs-main.mjs [N=14]
import { execFileSync } from "node:child_process";
import { buildGraph, affectedTests, REPO_ROOT } from "./graph.mjs";

const N = Number(process.argv[2] || 14);
const graph = buildGraph();
const total = graph.testFiles.length;

function git(args) {
	return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}
const shas = git(["log", "origin/main", "--format=%h\u0001%s", `-${N}`]).split("\n");

console.log(`\nFull Vitest suite: ${total} test files.  Baseline = run all ${total} every change.\n`);
console.log(pad("PR / commit", 46), pad("changed", 8), pad("run", 6), "speedup vs full");
console.log("-".repeat(88));

let sumAff = 0, counted = 0;
for (const line of shas) {
	const [sha, subj] = line.split("\u0001");
	const changed = git(["show", "--name-only", "--format=", sha])
		.split("\n").map((s) => s.trim()).filter(Boolean).map((p) => p.replace(/\\/g, "/"));
	const codeChanged = changed.filter((p) => p.startsWith("src/") || p.startsWith("tests2/") || p.startsWith("defaults/"));
	const { affected, runAll, reason } = affectedTests(graph, changed);
	const n = runAll ? total : affected.size;
	const speedup = affected.size === 0 && !runAll ? "skip-all" : `${(total / Math.max(n, 1)).toFixed(1)}x`;
	const note = runAll ? `RUN-ALL (${reason})` : `${((n / total) * 100).toFixed(1)}% of suite`;
	console.log(pad(`${sha} ${subj}`.slice(0, 45), 46), pad(String(codeChanged.length), 8), pad(String(n), 6), `${speedup.padEnd(10)} ${note}`);
	if (!runAll) { sumAff += n; counted++; }
}
console.log("-".repeat(88));
const mean = counted ? Math.round(sumAff / counted) : 0;
console.log(`\nAcross ${counted} non-run-all commits: mean affected ${mean} files (${((mean / total) * 100).toFixed(1)}%).`);
console.log(`Docs/config-only → skip-all. UI-only → ~${Math.round(0.14 * total)}-file DOM floor. Server → boot floor.`);
console.log(`RUN-ALL entries expose over-broad triggers (package.json/test-map) to refine; 1-file entries expose`);
console.log(`non-code (role/pack YAML) blind spots to model. Both are the next-step targets, not real 1000x wins.\n`);

function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length); }
