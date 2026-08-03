#!/usr/bin/env node
// Sound affected + cached Vitest runner.
//
//   node scripts/affected/run.mjs [--base <ref>] [--changed a,b]
//       [--dry] [--json] [--no-cache] [--all]
//
// Browser selections are advisory. This command executes only the graph's
// authoritative unit inventory. RUN-ALL plans never consult cached verdicts.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { buildGraph, affectedTests, REPO_ROOT } from "./graph.mjs";
import { loadCache, partition, record, runnerFingerprint, saveCache } from "./cache.mjs";

function arg(name, fallback = "") {
	const index = process.argv.indexOf(name);
	return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const has = (name) => process.argv.includes(name);
const DRY = has("--dry");
const JSON_OUTPUT = has("--json");
const NO_CACHE = has("--no-cache");
const ALL = has("--all");

function git(args, description = `git ${args.join(" ")}`) {
	try {
		return execFileSync("git", args, {
			cwd: REPO_ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch (error) {
		const detail = error?.stderr?.toString().trim() || error?.message || "unknown Git error";
		throw new Error(`${description} failed: ${detail}`);
	}
}

function tryGit(args) {
	try {
		return execFileSync("git", args, {
			cwd: REPO_ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return "";
	}
}

function normalizeRepoPath(input) {
	const normalized = String(input).trim().replace(/\\/g, "/").replace(/^\.\//u, "");
	if (!normalized
		|| normalized.startsWith("/")
		|| /^[A-Za-z]:\//u.test(normalized)
		|| normalized.split("/").some((part) => part === ".." || part === "")) {
		throw new Error(`changed path is not repository-relative: ${JSON.stringify(input)}`);
	}
	return normalized;
}

function resolveBase() {
	const explicit = arg("--base");
	if (explicit) return { ref: explicit, explicit: true };

	const symref = tryGit(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
	if (symref) {
		const ref = symref.replace(/^refs\/remotes\//u, "");
		if (tryGit(["rev-parse", "--verify", "--quiet", ref])) return { ref, explicit: false };
	}
	const shown = tryGit(["remote", "show", "origin"]).match(/HEAD branch:\s*(\S+)/u);
	if (shown && tryGit(["rev-parse", "--verify", "--quiet", `origin/${shown[1]}`])) {
		return { ref: `origin/${shown[1]}`, explicit: false };
	}
	if (tryGit(["rev-parse", "--verify", "--quiet", "HEAD^"])) return { ref: "HEAD^", explicit: false };
	throw new Error("cannot resolve a comparison base; pass --base <ref>");
}

function mergeBase(ref) {
	const base = git(["merge-base", ref, "HEAD"], `resolve merge-base for ${ref}`);
	if (!base) throw new Error(`resolve merge-base for ${ref} returned no commit`);
	return base;
}

function gitBytesAt(commit, path) {
	try {
		return execFileSync("git", ["show", `${commit}:${path}`], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return undefined;
	}
}

function workingBytes(path) {
	try {
		return readFileSync(join(REPO_ROOT, path), "utf8");
	} catch {
		return undefined;
	}
}

function parseNameStatus(raw) {
	const fields = raw.split("\0");
	if (fields.at(-1) === "") fields.pop();
	const records = [];
	for (let index = 0; index < fields.length;) {
		const statusText = fields[index++];
		if (!statusText) continue;
		const status = statusText[0];
		if (status === "R" || status === "C") {
			if (index + 1 >= fields.length) throw new Error(`malformed git name-status record: ${statusText}`);
			const oldPath = normalizeRepoPath(fields[index++]);
			const path = normalizeRepoPath(fields[index++]);
			records.push({ path, oldPath, status });
		} else {
			if (index >= fields.length) throw new Error(`malformed git name-status record: ${statusText}`);
			records.push({ path: normalizeRepoPath(fields[index++]), status });
		}
	}
	return records;
}

function recordsFromGit(baseCommit) {
	let raw;
	try {
		raw = execFileSync("git", ["diff", "--name-status", "-z", "--find-renames", baseCommit, "--"], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		const detail = error?.stderr?.toString().trim() || error?.message || "unknown Git error";
		throw new Error(`diff from ${baseCommit} failed: ${detail}`);
	}
	const records = parseNameStatus(raw);

	let untrackedRaw;
	try {
		untrackedRaw = execFileSync("git", ["ls-files", "-z", "--others", "--exclude-standard"], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		const detail = error?.stderr?.toString().trim() || error?.message || "unknown Git error";
		throw new Error(`list untracked files failed: ${detail}`);
	}
	for (const value of untrackedRaw.split("\0").filter(Boolean)) {
		const path = normalizeRepoPath(value);
		if (!records.some((record) => record.path === path)) records.push({ path, status: "A" });
	}

	return records.map((record) => ({
		...record,
		before: record.status === "A" ? undefined : gitBytesAt(baseCommit, record.oldPath ?? record.path),
		after: record.status === "D" ? undefined : workingBytes(record.path),
	}));
}

function explicitRecords(changed, baseCommit) {
	return changed.map((value) => {
		const path = normalizeRepoPath(value);
		const before = baseCommit ? gitBytesAt(baseCommit, path) : undefined;
		const after = workingBytes(path);
		const status = before === undefined ? (after === undefined ? "M" : "A") : (after === undefined ? "D" : "M");
		return { path, status, before, after };
	});
}

function normalizePlan(rawPlan, graph) {
	if (!rawPlan || !["skip-all", "bounded", "run-all"].includes(rawPlan.kind)) {
		throw new Error(`affectedTests returned an invalid plan kind: ${JSON.stringify(rawPlan?.kind)}`);
	}
	const expectedPolicy = rawPlan.kind === "run-all" ? "bypass" : "eligible";
	if (rawPlan.cachePolicy !== expectedPolicy) {
		throw new Error(`${rawPlan.kind} plan must use cachePolicy=${expectedPolicy}`);
	}
	const reasons = Array.isArray(rawPlan.reasons)
		? rawPlan.reasons.map(String)
		: rawPlan.reason ? [String(rawPlan.reason)] : [];
	const browserAffected = new Set(rawPlan.browserAffected ?? []);
	const authoritative = new Set(graph.testFiles);
	const affected = rawPlan.kind === "run-all"
		? authoritative
		: new Set([...new Set(rawPlan.affected ?? [])].filter((test) => authoritative.has(test)));
	return {
		...rawPlan,
		kind: rawPlan.kind,
		cachePolicy: expectedPolicy,
		affected,
		browserAffected,
		reasons,
		unmapped: [...new Set(rawPlan.unmapped ?? [])],
	};
}

function publicChanges(records) {
	return records.map(({ path, oldPath, status }) => ({ path, ...(oldPath ? { oldPath } : {}), status }));
}

function reasonText(plan) {
	return plan.reasons.join("; ") || "none";
}

function summaryLine(plan, counts) {
	if (plan.kind === "skip-all") return `SKIP-ALL reason=${reasonText(plan)}, selected=0, run=0`;
	if (plan.kind === "run-all") {
		return `RUN-ALL reason=${reasonText(plan)}, selected=${counts.selected}, cache=bypassed, run=${counts.run}`;
	}
	if (counts.selected > 0 && counts.run === 0 && counts.cacheHit === counts.selected) {
		return `CACHE-HIT-ALL selected=${counts.selected}, cache-hit=${counts.cacheHit}, run=0`;
	}
	return `BOUNDED selected=${counts.selected}, cache-hit=${counts.cacheHit}, run=${counts.run}`;
}

function emitHumanPrelude(base, records) {
	if (JSON_OUTPUT) return;
	if (base) console.log(`base=${base}  changed files=${records.length}`);
	else console.log(`changed (explicit)=${records.length}`);
	if (records.length) {
		console.log(records.map((change) =>
			`  ${change.status} ${change.oldPath ? `${change.oldPath} -> ` : ""}${change.path}`).join("\n"));
	}
}

function emitResult(result) {
	if (JSON_OUTPUT) console.log(JSON.stringify(result));
	else {
		console.log(`\n${result.summary}`);
		if (result.browserAffected.length) {
			console.log(`affected browser specs=${result.browserAffected.length} (advisory; run via Playwright tier)`);
		}
		if (DRY) console.log(`\n[dry] would run:\n${result.toRun.map((test) => `  ${test}`).join("\n") || "  (nothing)"}`);
	}
}

function reportVerdicts(reportFile, toRun) {
	const passed = new Set();
	const failed = new Set();
	try {
		const report = JSON.parse(readFileSync(reportFile, "utf8"));
		for (const fileResult of report.testResults ?? []) {
			const absolute = isAbsolute(fileResult.name) ? fileResult.name : resolve(REPO_ROOT, fileResult.name);
			const path = relative(REPO_ROOT, absolute).replace(/\\/g, "/");
			if (!toRun.has(path)) continue;
			(fileResult.status === "passed" ? passed : failed).add(path);
		}
	} catch {
		// Missing/malformed reports are handled conservatively by the caller.
	} finally {
		rmSync(reportFile, { force: true });
	}
	return { passed, failed };
}

function makeResult({ base, records, plan, total, hits, toRun, outcome, wallMs }) {
	const counts = { total, selected: plan.affected.size, cacheHit: hits.size, run: toRun.length };
	return {
		kind: plan.kind,
		cachePolicy: plan.cachePolicy,
		reasons: plan.reasons,
		unmapped: plan.unmapped,
		base: base ?? null,
		changed: publicChanges(records),
		affected: [...plan.affected].sort(),
		browserAffected: [...plan.browserAffected].sort(),
		cacheHits: [...hits].sort(),
		toRun: [...toRun].sort(),
		counts,
		outcome,
		wallMs,
		summary: summaryLine(plan, counts),
	};
}

function main() {
	const startedAt = Date.now();
	const graph = buildGraph();
	const total = graph.testFiles.length;
	let records = [];
	let base;
	let rawPlan;
	const changedOverride = arg("--changed");

	if (ALL) {
		rawPlan = {
			kind: "run-all",
			cachePolicy: "bypass",
			affected: new Set(graph.testFiles),
			browserAffected: new Set(),
			reasons: ["explicit --all"],
		};
	} else if (changedOverride) {
		const requested = changedOverride.split(",").map((value) => value.trim()).filter(Boolean);
		const explicitBase = arg("--base");
		base = explicitBase ? mergeBase(explicitBase) : undefined;
		records = explicitRecords(requested, base);
		rawPlan = affectedTests(graph, records);
		emitHumanPrelude(undefined, records);
	} else {
		const resolved = resolveBase();
		base = mergeBase(resolved.ref);
		records = recordsFromGit(base);
		rawPlan = affectedTests(graph, records);
		emitHumanPrelude(`${resolved.ref} (${base})`, records);
	}

	const plan = normalizePlan(rawPlan, graph);
	if (plan.kind === "skip-all") {
		const result = makeResult({ base, records, plan, total, hits: new Set(), toRun: [], outcome: "skip-all", wallMs: Date.now() - startedAt });
		emitResult(result);
		return 0;
	}

	let cache = {};
	let fingerprint;
	let hits = new Set();
	let misses = new Set(plan.affected);
	if (plan.kind === "bounded" && !NO_CACHE) {
		fingerprint = runnerFingerprint();
		cache = loadCache();
		({ hits, misses } = partition(cache, fingerprint, graph, plan.affected));
	}
	// RUN-ALL deliberately reaches neither loadCache() nor partition().
	const toRun = [...misses].sort();
	const planned = makeResult({
		base,
		records,
		plan,
		total,
		hits,
		toRun,
		outcome: DRY ? "dry" : toRun.length === 0 ? "cache-hit-all" : "planned",
		wallMs: Date.now() - startedAt,
	});
	if (DRY || toRun.length === 0) {
		emitResult(planned);
		return 0;
	}

	if (!JSON_OUTPUT) console.log(`\nrunning ${toRun.length} vitest file(s)...`);
	const vitestBin = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
	if (!existsSync(vitestBin)) throw new Error(`Vitest executable not found: ${vitestBin}`);
	const reportFile = join(REPO_ROOT, ".profiles", "test-cache", `run-${process.pid}.json`);
	mkdirSync(dirname(reportFile), { recursive: true });
	const childStdio = JSON_OUTPUT ? ["inherit", 2, 2] : "inherit";
	const run = spawnSync(
		process.execPath,
		[
			vitestBin,
			"run",
			"--config", "vitest.config.ts",
			"--silent=passed-only",
			"--reporter=default",
			"--reporter=json",
			"--outputFile", reportFile,
			...toRun,
		],
		{ cwd: REPO_ROOT, stdio: childStdio },
	);
	const { passed, failed } = reportVerdicts(reportFile, new Set(toRun));
	const exitStatus = Number.isInteger(run.status) ? run.status : 1;

	if (!NO_CACHE) {
		// A bypassed RUN-ALL starts a fresh bucket without reading prior records.
		if (!fingerprint) fingerprint = runnerFingerprint();
		const observed = new Set([...passed, ...failed]);
		const passing = observed.size > 0 ? passed : exitStatus === 0 ? new Set(toRun) : new Set();
		const invalid = new Set(toRun.filter((test) => !passing.has(test)));
		record(cache, fingerprint, graph, invalid, "fail");
		record(cache, fingerprint, graph, passing, "pass");
		if (passing.size > 0 || invalid.size > 0) saveCache(cache);
	}

	const result = makeResult({
		base,
		records,
		plan,
		total,
		hits,
		toRun,
		outcome: exitStatus === 0 ? "pass" : "fail",
		wallMs: Date.now() - startedAt,
	});
	emitResult(result);
	if (!JSON_OUTPUT && exitStatus !== 0) {
		console.log(`${passed.size} passing file(s) cached; ${toRun.length - passed.size} file(s) left uncached.`);
	}
	return exitStatus;
}

try {
	process.exitCode = main();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	if (JSON_OUTPUT) console.log(JSON.stringify({ outcome: "error", error: message }));
	else console.error(`affected-test runner error: ${message}`);
	process.exitCode = 2;
}
