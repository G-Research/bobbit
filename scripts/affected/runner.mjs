// Import-safe affected Vitest planner and executor.
//
// Git change collection and Vitest execution are deliberately separate narrow
// dependencies. Unit policy tests can inject them and exercise the complete
// planner/cache flow without crossing a process boundary.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { buildGraph, affectedTests, REPO_ROOT } from "./graph.mjs";
import { loadCache, partition, record, runnerFingerprint, saveCache, snapshotTestHashes } from "./cache.mjs";

function git(repoRoot, args, description = `git ${args.join(" ")}`) {
	try {
		return execFileSync("git", args, {
			cwd: repoRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch (error) {
		const detail = error?.stderr?.toString().trim() || error?.message || "unknown Git error";
		throw new Error(`${description} failed: ${detail}`);
	}
}

function tryGit(repoRoot, args) {
	try {
		return execFileSync("git", args, {
			cwd: repoRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return "";
	}
}

function normalizeRepoPath(input) {
	if (typeof input !== "string") {
		throw new Error(`changed path is not repository-relative: ${JSON.stringify(input)}`);
	}
	const normalized = input.trim().replace(/\\/g, "/").replace(/^\.\//u, "");
	if (!normalized
		|| normalized.startsWith("/")
		|| /^[A-Za-z]:\//u.test(normalized)
		|| normalized.split("/").some((part) => part === ".." || part === "")) {
		throw new Error(`changed path is not repository-relative: ${JSON.stringify(input)}`);
	}
	return normalized;
}

function resolveBase(repoRoot, explicitBase) {
	if (explicitBase) return { ref: explicitBase, explicit: true };

	const symref = tryGit(repoRoot, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
	if (symref) {
		const ref = symref.replace(/^refs\/remotes\//u, "");
		if (tryGit(repoRoot, ["rev-parse", "--verify", "--quiet", ref])) return { ref, explicit: false };
	}
	const shown = tryGit(repoRoot, ["remote", "show", "origin"]).match(/HEAD branch:\s*(\S+)/u);
	if (shown && tryGit(repoRoot, ["rev-parse", "--verify", "--quiet", `origin/${shown[1]}`])) {
		return { ref: `origin/${shown[1]}`, explicit: false };
	}
	if (tryGit(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD^"])) return { ref: "HEAD^", explicit: false };
	throw new Error("cannot resolve a comparison base; pass --base <ref>");
}

function mergeBase(repoRoot, ref) {
	const base = git(repoRoot, ["merge-base", ref, "HEAD"], `resolve merge-base for ${ref}`);
	if (!base) throw new Error(`resolve merge-base for ${ref} returned no commit`);
	return base;
}

function gitBytesAt(repoRoot, commit, path) {
	try {
		return execFileSync("git", ["show", `${commit}:${path}`], {
			cwd: repoRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return undefined;
	}
}

function workingBytes(repoRoot, path) {
	try {
		return readFileSync(join(repoRoot, path), "utf8");
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

function recordsFromGit(repoRoot, baseCommit) {
	let raw;
	try {
		raw = execFileSync("git", ["diff", "--name-status", "-z", "--find-renames", baseCommit, "--"], {
			cwd: repoRoot,
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
			cwd: repoRoot,
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
		before: record.status === "A" ? undefined : gitBytesAt(repoRoot, baseCommit, record.oldPath ?? record.path),
		after: record.status === "D" ? undefined : workingBytes(repoRoot, record.path),
	}));
}

function explicitRecords(repoRoot, changed, baseCommit) {
	return changed.map((value) => {
		const path = normalizeRepoPath(value);
		const before = baseCommit ? gitBytesAt(repoRoot, baseCommit, path) : undefined;
		const after = workingBytes(repoRoot, path);
		const status = before === undefined ? (after === undefined ? "M" : "A") : (after === undefined ? "D" : "M");
		return { path, status, before, after };
	});
}

function defaultCollectChanges({ repoRoot, base: explicitBase, changed }) {
	if (changed.length > 0) {
		const base = explicitBase ? mergeBase(repoRoot, explicitBase) : undefined;
		return { records: explicitRecords(repoRoot, changed, base), base };
	}
	const resolved = resolveBase(repoRoot, explicitBase);
	const base = mergeBase(repoRoot, resolved.ref);
	return {
		records: recordsFromGit(repoRoot, base),
		base,
		comparisonLabel: `${resolved.ref} (${base})`,
	};
}

function normalizeRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`change record must be an object: ${JSON.stringify(value)}`);
	}
	const status = typeof value.status === "string"
		? value.status.trim().charAt(0).toUpperCase()
		: "";
	if (!/^[ACDMRTUXB]$/u.test(status)) {
		throw new Error(`change record has an invalid status: ${JSON.stringify(value.status)}`);
	}
	const path = normalizeRepoPath(value.path);
	const oldPath = value.oldPath === undefined ? undefined : normalizeRepoPath(value.oldPath);
	if ((status === "R" || status === "C") && !oldPath) {
		throw new Error(`${status} change record requires oldPath: ${path}`);
	}
	for (const key of ["before", "after"]) {
		if (value[key] !== undefined && typeof value[key] !== "string") {
			throw new TypeError(`change record ${key} must be a string or undefined: ${path}`);
		}
	}
	return {
		path,
		...(oldPath ? { oldPath } : {}),
		status,
		before: value.before,
		after: value.after,
	};
}

function tombstonesFromRecords(records) {
	const tombstones = new Map();
	for (const record of records) {
		const removedPath = record.status === "R"
			? record.oldPath
			: record.status === "D" ? record.path : undefined;
		if (removedPath) tombstones.set(removedPath.toLowerCase(), removedPath);
	}
	return new Set(tombstones.values());
}

function normalizeSelection(rawPlan, graph) {
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
	const selected = new Set(rawPlan.affected ?? []);
	const unknown = [...selected].filter((test) => !authoritative.has(test));
	if (unknown.length > 0) {
		throw new Error(`affectedTests selected paths outside the authoritative unit inventory: ${unknown.join(", ")}`);
	}
	const affected = rawPlan.kind === "run-all" ? authoritative : selected;
	return {
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

function resultFromPlan(plan, outcome, wallMs) {
	return {
		kind: plan.kind,
		cachePolicy: plan.cachePolicy,
		reasons: plan.reasons,
		unmapped: plan.unmapped,
		base: plan.base ?? null,
		changed: publicChanges(plan.records),
		affected: [...plan.affected].sort(),
		browserAffected: [...plan.browserAffected].sort(),
		cacheHits: [...plan.cacheHits].sort(),
		toRun: [...plan.toRun].sort(),
		counts: plan.counts,
		outcome,
		wallMs,
		summary: summaryLine(plan, plan.counts),
	};
}

function commandBatches(files, platform) {
	if (platform !== "win32") return files.length > 0 ? [files] : [];
	// CreateProcess has a 32,767-character command-line ceiling. Leave room for
	// the executable/config/reporter flags and quote expansion on Windows.
	const limit = 24_000;
	const batches = [];
	let batch = [];
	let size = 0;
	for (const file of files) {
		const next = file.length + 3;
		if (batch.length > 0 && size + next > limit) {
			batches.push(batch);
			batch = [];
			size = 0;
		}
		batch.push(file);
		size += next;
	}
	if (batch.length > 0) batches.push(batch);
	return batches;
}

function defaultExecuteTests({ files, reportFile, repoRoot, jsonOutput }) {
	const vitestBin = join(repoRoot, "node_modules", "vitest", "vitest.mjs");
	if (!existsSync(vitestBin)) throw new Error(`Vitest executable not found: ${vitestBin}`);
	mkdirSync(dirname(reportFile), { recursive: true });
	const childStdio = jsonOutput ? ["inherit", 2, 2] : "inherit";
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
			...files,
		],
		{ cwd: repoRoot, stdio: childStdio },
	);
	let report;
	try {
		report = readFileSync(reportFile, "utf8");
	} catch {
		// The caller treats a missing report as having no explicit verdicts.
	} finally {
		rmSync(reportFile, { force: true });
	}
	return { status: run.status, report };
}

function reportVerdicts(reportValue, toRun, repoRoot) {
	const passed = new Set();
	const failed = new Set();
	try {
		const report = typeof reportValue === "string" ? JSON.parse(reportValue) : reportValue;
		if (!report || !Array.isArray(report.testResults)) return { passed, failed };
		for (const fileResult of report.testResults) {
			if (!fileResult || typeof fileResult.name !== "string") continue;
			const absolute = isAbsolute(fileResult.name) ? fileResult.name : resolve(repoRoot, fileResult.name);
			const path = relative(repoRoot, absolute).replace(/\\/g, "/");
			if (!toRun.has(path)) continue;
			if (fileResult.status === "passed") {
				if (!failed.has(path)) passed.add(path);
			} else {
				passed.delete(path);
				failed.add(path);
			}
		}
	} catch {
		// Missing and malformed reports never imply a PASS verdict.
	}
	return { passed, failed };
}

function cacheOptions(options, repoRoot) {
	return {
		repoRoot,
		...(options.cacheDir ? { cacheDir: options.cacheDir } : {}),
		...(options.cacheFile ? { cacheFile: options.cacheFile } : {}),
	};
}

/**
 * Build a normalized affected plan without executing tests.
 *
 * Supported dependency overrides mirror the existing graph/cache functions;
 * policy tests normally need only collectChanges and, when using a tiny graph,
 * buildGraph/affectedTests.
 */
export function planAffectedRun(options = {}, deps = {}) {
	const startedAt = (deps.now ?? Date.now)();
	const repoRoot = resolve(options.repoRoot ?? REPO_ROOT);
	const all = options.all === true;
	const noCache = options.noCache === true;
	const changed = Array.isArray(options.changed)
		? options.changed.map(String).map((value) => value.trim()).filter(Boolean)
		: typeof options.changed === "string"
			? options.changed.split(",").map((value) => value.trim()).filter(Boolean)
			: [];

	let collected = { records: [], base: undefined, comparisonLabel: undefined };
	if (!all) {
		const collectChanges = deps.collectChanges ?? defaultCollectChanges;
		const value = collectChanges({ repoRoot, base: options.base, changed });
		collected = Array.isArray(value) ? { records: value } : value;
		if (!collected || !Array.isArray(collected.records)) {
			throw new TypeError("collectChanges must return an array or { records, base?, comparisonLabel? }");
		}
	}
	const records = collected.records.map(normalizeRecord);
	const makeGraph = deps.buildGraph ?? buildGraph;
	const graph = makeGraph({ repoRoot, tombstones: tombstonesFromRecords(records) });
	if (!graph || !Array.isArray(graph.testFiles) || !(graph.testDeps instanceof Map)) {
		throw new TypeError("buildGraph returned an invalid affected graph");
	}
	let rawPlan;
	if (all) {
		rawPlan = {
			kind: "run-all",
			cachePolicy: "bypass",
			affected: new Set(graph.testFiles),
			browserAffected: new Set(),
			reasons: ["explicit --all"],
			unmapped: [],
		};
	} else {
		const selectTests = deps.affectedTests ?? affectedTests;
		rawPlan = selectTests(graph, records);
	}
	const selection = normalizeSelection(rawPlan, graph);
	const cacheConfig = cacheOptions(options, repoRoot);
	let cache = {};
	let fingerprint;
	let cacheHits = new Set();
	let misses = new Set(selection.affected);
	if (selection.kind === "bounded" && !noCache) {
		const getFingerprint = deps.runnerFingerprint ?? runnerFingerprint;
		const readCache = deps.loadCache ?? loadCache;
		const splitCache = deps.partition ?? partition;
		fingerprint = getFingerprint(cacheConfig);
		cache = readCache(cacheConfig);
		const split = splitCache(cache, fingerprint, graph, selection.affected, cacheConfig);
		if (!(split?.hits instanceof Set) || !(split?.misses instanceof Set)) {
			throw new TypeError("partition must return { hits: Set, misses: Set }");
		}
		cacheHits = split.hits;
		misses = split.misses;
		for (const test of selection.affected) {
			const memberships = Number(cacheHits.has(test)) + Number(misses.has(test));
			if (memberships !== 1) throw new Error(`cache partition did not classify selected test exactly once: ${test}`);
		}
		for (const test of [...cacheHits, ...misses]) {
			if (!selection.affected.has(test)) throw new Error(`cache partition returned an unselected test: ${test}`);
		}
	}
	// RUN-ALL deliberately reaches neither loadCache() nor partition().
	const toRun = [...misses].sort();
	const counts = {
		total: graph.testFiles.length,
		selected: selection.affected.size,
		cacheHit: cacheHits.size,
		run: toRun.length,
	};
	return {
		...selection,
		repoRoot,
		startedAt,
		base: collected.base,
		comparisonLabel: collected.comparisonLabel,
		records,
		graph,
		cache,
		fingerprint,
		cacheConfig,
		cacheHits,
		toRun,
		counts,
		noCache,
	};
}

/** Execute a planned run and return the CLI's stable machine-readable result. */
export function executeAffectedRun(plan, options = {}, deps = {}) {
	if (!plan || !["skip-all", "bounded", "run-all"].includes(plan.kind) || !Array.isArray(plan.toRun)) {
		throw new TypeError("executeAffectedRun requires a plan from planAffectedRun");
	}
	const now = deps.now ?? Date.now;
	const elapsed = () => Math.max(0, now() - plan.startedAt);
	if (plan.kind === "skip-all") return resultFromPlan(plan, "skip-all", elapsed());
	if (options.dry === true) return resultFromPlan(plan, "dry", elapsed());
	if (plan.toRun.length === 0) return resultFromPlan(plan, "cache-hit-all", elapsed());

	const noCache = plan.noCache;
	const getFingerprint = deps.runnerFingerprint ?? runnerFingerprint;
	const snapshotHashes = deps.snapshotTestHashes ?? snapshotTestHashes;
	const updateCache = deps.record ?? record;
	const writeCache = deps.saveCache ?? saveCache;
	const executeTests = deps.executeTests ?? defaultExecuteTests;
	// Certify exactly the bytes present immediately before execution. RUN-ALL
	// still does not read prior verdicts; this snapshot validates fresh ones.
	const preRunFingerprint = noCache ? undefined : getFingerprint(plan.cacheConfig);
	const preRunHashes = noCache ? new Map() : snapshotHashes(plan.graph, plan.toRun, plan.cacheConfig);
	const reportRoot = options.reportRoot ?? join(plan.repoRoot, ".profiles", "test-cache");
	const passed = new Set();
	const failed = new Set();
	let exitStatus = 0;
	const batches = commandBatches(plan.toRun, options.platform ?? process.platform);
	for (const [index, files] of batches.entries()) {
		const reportFile = join(reportRoot, `run-${process.pid}-${plan.startedAt}-${index}.json`);
		const execution = executeTests({
			files: [...files],
			index,
			reportFile,
			repoRoot: plan.repoRoot,
			jsonOutput: options.json === true,
		});
		const processPassed = execution && Number.isInteger(execution.status) && execution.status === 0;
		if (!processPassed) exitStatus = 1;
		const verdicts = reportVerdicts(execution?.report, new Set(files), plan.repoRoot);
		// A failed process with no named failure is contradictory/ambiguous. Do
		// not certify its claimed PASS entries; named failures are required to
		// establish which siblings actually completed successfully.
		if (processPassed || verdicts.failed.size > 0) {
			for (const test of verdicts.passed) {
				if (!failed.has(test)) passed.add(test);
			}
		}
		for (const test of verdicts.failed) {
			passed.delete(test);
			failed.add(test);
		}
	}
	if (failed.size > 0) exitStatus = 1;

	let certifiedPassing = new Set();
	if (!noCache) {
		const postRunFingerprint = getFingerprint(plan.cacheConfig);
		const postRunHashes = snapshotHashes(plan.graph, plan.toRun, plan.cacheConfig);
		const planningFingerprintStable = plan.kind === "run-all" || plan.fingerprint === preRunFingerprint;
		if (planningFingerprintStable && postRunFingerprint === preRunFingerprint) {
			certifiedPassing = new Set([...passed].filter((test) => {
				const before = preRunHashes.get(test);
				return typeof before === "string" && postRunHashes.get(test) === before;
			}));
		}
		const invalid = new Set(plan.toRun.filter((test) => !certifiedPassing.has(test)));
		// A bypassed RUN-ALL starts a fresh bucket without reading prior records.
		// record() consumes only pre-run hashes validated above.
		updateCache(plan.cache, preRunFingerprint, invalid, "fail");
		updateCache(plan.cache, preRunFingerprint, certifiedPassing, "pass", preRunHashes);
		if (certifiedPassing.size > 0 || invalid.size > 0) writeCache(plan.cache, plan.cacheConfig);
	}

	const result = resultFromPlan(plan, exitStatus === 0 ? "pass" : "fail", elapsed());
	// Preserve the public JSON schema while retaining the human CLI diagnostic.
	Object.defineProperty(result, "certifiedPassing", { value: certifiedPassing, enumerable: false });
	return result;
}
