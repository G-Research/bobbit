#!/usr/bin/env node
/**
 * Expensive, retry-free qualification of affected-test selection against fixed
 * origin/main revisions. This is deliberately separate from test:unit: every
 * sample installs its historical dependency tree, runs Vitest's independent
 * --changed mode, and then runs the complete unit suite.
 *
 *   node scripts/affected/correctness-vs-main.mjs
 *   node scripts/affected/correctness-vs-main.mjs --only pr-1071,pr-1072
 *   node scripts/affected/correctness-vs-main.mjs --report <owned-or-explicit-path>
 */
import { execFile } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	sanitizeTestEnvironment,
	setEnvironmentValue,
} from "../testing-v2/environment-policy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");
export const DEFAULT_SAMPLE_PATH = join(HERE, "correctness-sample.json");
const RUN_PREFIX = "bobbit-affected-correctness-";

export function normalizeRepoPath(value) {
	return String(value ?? "")
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.replace(/^\/+/, "");
}

function sortedPaths(values) {
	return [...new Set([...values].map(normalizeRepoPath).filter(Boolean))].sort();
}

function toSet(value) {
	if (value instanceof Set) return value;
	if (Array.isArray(value)) return new Set(value);
	if (value && typeof value[Symbol.iterator] === "function") return new Set(value);
	return new Set();
}

export function isDocumentationOnly(changes) {
	const paths = changes.flatMap((change) => [change.oldPath, change.path]).filter(Boolean).map(normalizeRepoPath);
	return paths.length > 0 && paths.every((path) =>
		path === "README.md"
		|| path === "CHANGELOG.md"
		|| path.startsWith("docs/"),
	);
}

/**
 * Adapt both the MVP { runAll, affected } result and the sound tri-state plan.
 * The returned selected set is always restricted to the authoritative unit
 * inventory; a RUN-ALL is expanded to that complete inventory and bypasses
 * cache reads regardless of the input shape.
 */
export function normalizeSelectionPlan(rawPlan, unitInventory) {
	const allUnit = sortedPaths(unitInventory);
	const unitSet = new Set(allUnit);
	const rawAffected = sortedPaths(toSet(rawPlan?.affected));
	let kind = rawPlan?.kind;
	if (!kind) kind = rawPlan?.runAll ? "run-all" : rawAffected.length > 0 ? "bounded" : "skip-all";
	if (!new Set(["skip-all", "bounded", "run-all"]).has(kind)) {
		throw new Error(`Unknown affected selection kind: ${String(kind)}`);
	}
	const selected = kind === "run-all"
		? allUnit
		: kind === "skip-all"
			? []
			: rawAffected.filter((path) => unitSet.has(path));
	if (kind === "run-all" && rawPlan?.cachePolicy && rawPlan.cachePolicy !== "bypass") {
		throw new Error("RUN-ALL selection must bypass result-cache reads");
	}
	const cachePolicy = kind === "run-all" ? "bypass" : rawPlan?.cachePolicy ?? "eligible";
	const reasons = rawPlan?.reasons
		? typeof rawPlan.reasons === "string" ? [rawPlan.reasons] : [...rawPlan.reasons].map(String)
		: rawPlan?.reason ? [String(rawPlan.reason)] : [];
	return {
		kind,
		cachePolicy,
		selected,
		browserAffected: sortedPaths(toSet(rawPlan?.browserAffected)),
		reasons,
		unmapped: sortedPaths(toSet(rawPlan?.unmapped)),
	};
}

/** Compute the diagnostic static graph closure with all broad rules ignored. */
export function graphOnlyDiagnostic(graph, changes, unitInventory) {
	const unitSet = new Set(sortedPaths(unitInventory));
	const selected = new Set();
	for (const change of changes) {
		for (const path of [change.oldPath, change.path].filter(Boolean).map(normalizeRepoPath)) {
			if (unitSet.has(path)) selected.add(path);
			for (const test of graph.srcToTests?.get(path) ?? []) {
				const normalized = normalizeRepoPath(test);
				if (unitSet.has(normalized)) selected.add(normalized);
			}
		}
	}
	return {
		executable: false,
		label: "graph-only diagnostic (broad triggers ignored; never executed)",
		selected: sortedPaths(selected),
	};
}

/**
 * The safety oracle. Required evidence is the union of directly changed
 * map-owned unit tests, Vitest --changed observations, and full-run failures.
 */
export function compareSelectionEvidence({
	selected = [],
	directChangedUnit = [],
	nativeChangedObserved = [],
	fullRunFailures = [],
} = {}) {
	const selectedSet = new Set(sortedPaths(selected));
	const direct = sortedPaths(directChangedUnit);
	const native = sortedPaths(nativeChangedObserved);
	const failures = sortedPaths(fullRunFailures);
	const required = sortedPaths([...direct, ...native, ...failures]);
	const underSelected = required.filter((path) => !selectedSet.has(path));
	const requiredSet = new Set(required);
	const overSelected = sortedPaths(selectedSet).filter((path) => !requiredSet.has(path));
	return {
		selected: sortedPaths(selectedSet),
		directChangedUnit: direct,
		nativeChangedObserved: native,
		fullRunFailures: failures,
		required,
		underSelected,
		overSelected,
		safe: underSelected.length === 0,
	};
}

function reportPath(name, repoRoot) {
	const value = String(name ?? "");
	if (!value) return "";
	if (!isAbsolute(value)) return normalizeRepoPath(value);
	const rel = relative(repoRoot, value);
	if (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)) return normalizeRepoPath(rel);
	return normalizeRepoPath(value);
}

export function parseVitestReport(report, repoRoot) {
	if (!report || !Array.isArray(report.testResults)) {
		throw new Error("Vitest JSON evidence is missing testResults");
	}
	const observed = new Set();
	const failures = new Set();
	for (const result of report.testResults) {
		const path = reportPath(result?.name, repoRoot);
		if (!path) continue;
		observed.add(path);
		const assertionFailed = (result.assertionResults ?? []).some((item) => item?.status === "failed");
		if (result.status === "failed" || assertionFailed) failures.add(path);
	}
	return { observed: sortedPaths(observed), failures: sortedPaths(failures) };
}

export function readVitestReport(path, repoRoot) {
	if (!existsSync(path)) throw new Error(`Vitest JSON report not found: ${path}`);
	let report;
	try {
		report = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Vitest JSON report is unreadable: ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return parseVitestReport(report, repoRoot);
}

export function summarizeQualification(rows) {
	const bounded = rows.filter((row) => row.plan?.kind === "bounded" && row.plan.selected.length > 0);
	const suspiciousZero = rows.filter((row) =>
		row.plan?.selected?.length === 0
		&& !row.documentationOnly,
	).map((row) => row.id);
	const underSelected = rows.flatMap((row) =>
		(row.evidence?.underSelected ?? []).map((path) => ({ id: row.id, path })),
	);
	return {
		total: rows.length,
		categories: {
			"skip-all": rows.filter((row) => row.plan?.kind === "skip-all").length,
			bounded: rows.filter((row) => row.plan?.kind === "bounded").length,
			"run-all": rows.filter((row) => row.plan?.kind === "run-all").length,
		},
		boundedAverageSelected: bounded.length
			? Math.round(bounded.reduce((sum, row) => sum + row.plan.selected.length, 0) / bounded.length)
			: null,
		boundedAverageSelectionMs: bounded.length
			? Math.round(bounded.reduce((sum, row) => sum + Number(row.timings?.selectionMs ?? 0), 0) / bounded.length)
			: null,
		boundedAverageSampleCount: bounded.length,
		suspiciousZero,
		underSelected,
		safe: suspiciousZero.length === 0 && underSelected.length === 0,
	};
}

export function buildAuditReport(rows, metadata = {}) {
	const summary = summarizeQualification(rows);
	return {
		schemaVersion: 1,
		generatedAt: metadata.generatedAt ?? new Date().toISOString(),
		repository: metadata.repository ?? REPO_ROOT,
		sampleManifest: metadata.sampleManifest ?? DEFAULT_SAMPLE_PATH,
		contract: "selected is a superset of direct changed unit tests, Vitest --changed observations, and full-run failures",
		cachePolicy: "qualification disables affected-result cache use; historical installs and Vitest state are invocation-local",
		rows,
		summary,
	};
}

export function renderAuditReport(report) {
	const lines = [
		"Affected correctness qualification",
		`contract: ${report.contract}`,
		`sample manifest: ${report.sampleManifest}`,
		"",
	];
	for (const row of report.rows) {
		lines.push(`== ${row.id}: ${row.commit} ${row.subject}`);
		lines.push(`parent: ${row.parent}${row.synthetic ? " (synthetic working-tree scenario)" : ""}`);
		lines.push(`changed inputs (${row.changedInputs.length}): ${row.changedInputs.map((item) => item.oldPath ? `${item.oldPath} -> ${item.path}` : item.path).join(", ") || "(none)"}`);
		lines.push(`executable plan: ${row.plan.kind}; cache=${row.plan.cachePolicy}; selected=${row.plan.selected.length}; reasons=${row.plan.reasons.join("; ") || "(none)"}`);
		if (row.graphOnlyDiagnostic) {
			lines.push(`non-executable graph-only diagnostic: selected=${row.graphOnlyDiagnostic.selected.length}; ${row.graphOnlyDiagnostic.label}`);
		}
		lines.push(`native command: ${row.commands.nativeChanged}`);
		lines.push(`full command: ${row.commands.fullUnit}`);
		lines.push(`native observed (${row.evidence.nativeChangedObserved.length}): ${row.evidence.nativeChangedObserved.join(", ") || "(none)"}`);
		lines.push(`full failures (${row.evidence.fullRunFailures.length}): ${row.evidence.fullRunFailures.join(", ") || "(none)"}`);
		lines.push(`required (${row.evidence.required.length}): ${row.evidence.required.join(", ") || "(none)"}`);
		lines.push(`under-selected (${row.evidence.underSelected.length}): ${row.evidence.underSelected.join(", ") || "(none)"}`);
		lines.push(`over-selected (${row.evidence.overSelected.length}): ${row.evidence.overSelected.join(", ") || "(none)"}`);
		lines.push(`timings ms: selection=${row.timings.selectionMs}, install=${row.timings.installMs}, native=${row.timings.nativeChangedMs}, full=${row.timings.fullUnitMs}`);
		lines.push("");
	}
	lines.push(`summary: ${JSON.stringify(report.summary)}`);
	return lines.join("\n");
}

function ownedChild(root, candidate) {
	const rel = relative(resolve(root), resolve(candidate));
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function ensureOwnedDirectory(root, ...parts) {
	const directory = resolve(root, ...parts);
	if (!ownedChild(root, directory)) throw new Error(`Refusing non-owned qualification path: ${directory}`);
	mkdirSync(directory, { recursive: true });
	return directory;
}

/** Build a credential-neutral child environment rooted entirely in one run. */
export function createQualificationEnvironment(root, source = process.env, platform = process.platform) {
	const canonicalRoot = realpathSync(root);
	const env = sanitizeTestEnvironment(source, platform);
	const roots = {
		home: ensureOwnedDirectory(canonicalRoot, "home"),
		temp: ensureOwnedDirectory(canonicalRoot, "tmp"),
		bobbit: ensureOwnedDirectory(canonicalRoot, "bobbit"),
		agent: ensureOwnedDirectory(canonicalRoot, "agent"),
		secrets: ensureOwnedDirectory(canonicalRoot, "secrets"),
		cache: ensureOwnedDirectory(canonicalRoot, "cache"),
		appdata: ensureOwnedDirectory(canonicalRoot, "appdata"),
	};
	const values = {
		HOME: roots.home,
		USERPROFILE: roots.home,
		TMPDIR: roots.temp,
		TEMP: roots.temp,
		TMP: roots.temp,
		BOBBIT_DIR: roots.bobbit,
		BOBBIT_PI_DIR: roots.bobbit,
		BOBBIT_AGENT_DIR: roots.agent,
		PI_CODING_AGENT_DIR: roots.agent,
		BOBBIT_SECRETS_DIR: roots.secrets,
		BOBBIT_V2_RUN_ROOT: canonicalRoot,
		BOBBIT_V2_RUN_ROOT_OWNER_PID: String(process.pid),
		XDG_CACHE_HOME: roots.cache,
		XDG_CONFIG_HOME: ensureOwnedDirectory(canonicalRoot, "xdg-config"),
		XDG_STATE_HOME: ensureOwnedDirectory(canonicalRoot, "xdg-state"),
		APPDATA: ensureOwnedDirectory(roots.appdata, "roaming"),
		LOCALAPPDATA: ensureOwnedDirectory(roots.appdata, "local"),
		npm_config_cache: ensureOwnedDirectory(roots.cache, "npm"),
		NODE_DISABLE_COMPILE_CACHE: "1",
		BOBBIT_V2_RETRY_FREE: "1",
	};
	for (const [key, value] of Object.entries(values)) setEnvironmentValue(env, key, value, platform);
	return env;
}

/**
 * Fast-testable exact cleanup owner. The callback may create only descendants
 * of the returned root; the same exact root is removed after success or error.
 */
export async function withOwnedQualificationRoot(action, {
	parent = tmpdir(),
	prefix = RUN_PREFIX,
	makeRoot = (base) => mkdtempSync(base),
	removeRoot = (root) => rmSync(root, { recursive: true, force: true }),
} = {}) {
	const canonicalParent = realpathSync(parent);
	const root = realpathSync(makeRoot(join(canonicalParent, prefix)));
	if (!ownedChild(canonicalParent, root)) throw new Error(`Qualification root escaped its owner: ${root}`);
	try {
		return await action(root);
	} finally {
		removeRoot(root);
	}
}

function runExecFile(file, args, options = {}) {
	return new Promise((resolveResult) => {
		const started = Date.now();
		execFile(file, args, {
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			windowsHide: true,
			...options,
		}, (error, stdout = "", stderr = "") => {
			const numericCode = typeof error?.code === "number" ? error.code : error ? 1 : 0;
			resolveResult({
				code: numericCode,
				error,
				stdout: String(stdout),
				stderr: String(stderr),
				durationMs: Date.now() - started,
			});
		});
	});
}

async function checked(file, args, options = {}) {
	const result = await runExecFile(file, args, options);
	if (result.code !== 0) {
		const detail = `${result.stdout}\n${result.stderr}`.trim().slice(-4000);
		throw new Error(`${file} ${args.join(" ")} failed (${result.code})${detail ? `:\n${detail}` : ""}`);
	}
	return result;
}

function commandString(file, args) {
	return [file, ...args].map((part) => JSON.stringify(String(part))).join(" ");
}

function parseNameStatus(text) {
	const changes = [];
	for (const line of String(text).split(/\r?\n/).filter(Boolean)) {
		const fields = line.split("\t");
		const rawStatus = fields[0] ?? "";
		const status = rawStatus[0] ?? "M";
		if ((status === "R" || status === "C") && fields.length >= 3) {
			changes.push({ status, oldPath: normalizeRepoPath(fields[1]), path: normalizeRepoPath(fields[2]) });
		} else if (fields[1]) {
			changes.push({ status, path: normalizeRepoPath(fields[1]) });
		}
	}
	return changes;
}

async function gitText(args, cwd = REPO_ROOT, allowFailure = false) {
	const result = await runExecFile("git", args, { cwd });
	if (!allowFailure && result.code !== 0) {
		throw new Error(`git ${args.join(" ")} failed (${result.code}): ${(result.stderr || result.stdout).trim()}`);
	}
	return result.code === 0 ? result.stdout.trim() : undefined;
}

async function contentAt(revision, path) {
	if (!revision || !path) return undefined;
	return gitText(["show", `${revision}:${normalizeRepoPath(path)}`], REPO_ROOT, true);
}

export async function changesForCommit(commit) {
	const parent = await gitText(["rev-parse", `${commit}^`]);
	const text = await gitText(["diff", "--name-status", "-M", parent, commit]);
	const changes = parseNameStatus(text);
	for (const change of changes) {
		change.before = change.status === "A" ? undefined : await contentAt(parent, change.oldPath ?? change.path);
		change.after = change.status === "D" ? undefined : await contentAt(commit, change.path);
	}
	return { parent, changes };
}

export async function changesForSample(sample) {
	if (!sample.syntheticChanges?.length) return changesForCommit(sample.commit);
	const changes = [];
	for (const fixture of sample.syntheticChanges) {
		const path = normalizeRepoPath(fixture.path);
		const before = await contentAt(sample.commit, path);
		if (before === undefined) throw new Error(`${sample.id}: synthetic input does not exist at ${sample.commit}: ${path}`);
		changes.push({ status: "M", path, before, after: `${before}${fixture.append ?? "\n"}` });
	}
	return { parent: sample.commit, changes };
}

function applySyntheticChanges(sample, worktree, changes) {
	if (!sample.syntheticChanges?.length) return;
	for (const change of changes) {
		const target = resolve(worktree, change.path);
		if (!ownedChild(worktree, target)) throw new Error(`${sample.id}: synthetic path escaped its worktree: ${change.path}`);
		writeFileSync(target, change.after, "utf8");
	}
}

export function unitInventoryFromMap(map) {
	const records = [
		...(map.entries ?? []).filter((entry) => entry.v2Path).map((entry) => ({ path: entry.v2Path, execution: entry.execution })),
		...(map.v2Native ?? []).map((entry) => ({ path: entry.path, execution: entry.execution })),
	];
	return sortedPaths(records
		.filter((record) => record.execution?.runner === "vitest" && record.execution?.tier === "unit")
		.map((record) => record.path));
}

export function directlyChangedUnitTests(changes, unitInventory) {
	const unitSet = new Set(sortedPaths(unitInventory));
	return sortedPaths(changes.flatMap((change) => [change.oldPath, change.path]).filter((path) => unitSet.has(normalizeRepoPath(path))));
}

async function invokeAffected(affectedTests, graph, changes) {
	try {
		return affectedTests(graph, changes);
	} catch (error) {
		// The preserved MVP accepts path strings. Keep this narrow compatibility
		// bridge until graph.mjs consumes normalized change records after merge.
		if (!(error instanceof TypeError) || !/replace|object|string/i.test(error.message)) throw error;
		return affectedTests(graph, changes.flatMap((change) => [change.oldPath, change.path]).filter(Boolean));
	}
}

export async function computeHistoricalPlan({ graph, affectedTests, changes, unitInventory }) {
	const started = Date.now();
	const raw = await invokeAffected(affectedTests, graph, changes);
	return {
		plan: normalizeSelectionPlan(raw, unitInventory),
		graphOnlyDiagnostic: graphOnlyDiagnostic(graph, changes, unitInventory),
		selectionMs: Date.now() - started,
	};
}

function assertExpectedPlan(sample, plan, diagnostic, unitTotal) {
	if (sample.expectedPlan && sample.expectedPlan !== plan.kind) {
		throw new Error(`${sample.id}: expected ${sample.expectedPlan}, got ${plan.kind}`);
	}
	if (sample.expectedPlan === "bounded" && (plan.selected.length === 0 || plan.selected.length >= unitTotal)) {
		throw new Error(`${sample.id}: bounded sample must select a nonzero strict subset, got ${plan.selected.length}/${unitTotal}`);
	}
	if (sample.requireGraphOnlyDiagnostic && diagnostic.selected.length === 0) {
		throw new Error(`${sample.id}: required graph-only diagnostic is empty`);
	}
}

function loadSampleManifest(path = DEFAULT_SAMPLE_PATH) {
	const parsed = JSON.parse(readFileSync(path, "utf8"));
	if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.samples) || parsed.samples.length === 0) {
		throw new Error(`Invalid affected correctness sample manifest: ${path}`);
	}
	const ids = new Set();
	for (const sample of parsed.samples) {
		if (!sample.id || ids.has(sample.id)) throw new Error(`Duplicate or missing sample id: ${sample.id}`);
		ids.add(sample.id);
		if (!/^[0-9a-f]{40}$/.test(sample.commit)) throw new Error(`${sample.id}: commit must be an immutable 40-character SHA`);
		if (!new Set(["skip-all", "bounded", "run-all"]).has(sample.expectedPlan)) throw new Error(`${sample.id}: invalid expectedPlan`);
	}
	return parsed;
}

function parseArgs(argv) {
	const options = { samplePath: DEFAULT_SAMPLE_PATH, reportPath: undefined, only: undefined };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--sample" && argv[i + 1]) options.samplePath = resolve(argv[++i]);
		else if (argv[i] === "--report" && argv[i + 1]) options.reportPath = resolve(argv[++i]);
		else if (argv[i] === "--only" && argv[i + 1]) options.only = new Set(argv[++i].split(",").filter(Boolean));
		else if (argv[i] === "--help" || argv[i] === "-h") options.help = true;
		else throw new Error(`Unknown argument: ${argv[i]}`);
	}
	return options;
}

function help() {
	return `Usage: node scripts/affected/correctness-vs-main.mjs [options]\n\nOptions:\n  --sample PATH      Fixed immutable sample manifest\n  --only ID,ID       Run a subset of manifest sample ids\n  --report PATH      Also write the complete audit JSON\n  --help             Show this help\n\nThis command is expensive: every sample runs npm ci, Vitest --changed, and the full retry-free unit suite.`;
}

async function qualifySample({ sample, graph, affectedTests, worktree, root }) {
	const { parent, changes } = await changesForSample(sample);
	const subject = await gitText(["show", "-s", "--format=%s", sample.commit]);
	await checked("git", ["checkout", "--detach", "--force", sample.commit], { cwd: worktree, timeout: 120_000 });
	applySyntheticChanges(sample, worktree, changes);
	const profiles = join(worktree, ".profiles");
	if (!ownedChild(root, profiles)) throw new Error(`Refusing to clean non-owned sample path: ${profiles}`);
	rmSync(profiles, { recursive: true, force: true });
	const sampleRoot = ensureOwnedDirectory(root, "runs", sample.id);
	const installEnv = createQualificationEnvironment(ensureOwnedDirectory(sampleRoot, "install"));
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const install = await checked(npm, ["ci", "--no-audit", "--no-fund"], {
		cwd: worktree,
		env: installEnv,
		timeout: 15 * 60_000,
	});
	const map = JSON.parse(readFileSync(join(worktree, "tests2", "tests-map.json"), "utf8"));
	const historicalUnit = unitInventoryFromMap(map);
	const currentUnit = unitInventoryFromMap(JSON.parse(readFileSync(join(REPO_ROOT, "tests2", "tests-map.json"), "utf8")));
	const computed = await computeHistoricalPlan({ graph, affectedTests, changes, unitInventory: currentUnit });
	assertExpectedPlan(sample, computed.plan, computed.graphOnlyDiagnostic, currentUnit.length);

	const reports = ensureOwnedDirectory(sampleRoot, "reports");
	const nativeReport = join(reports, "native-changed.json");
	const fullReport = join(reports, "full-unit.json");
	const nativeArgs = ["run", "test:unit", "--", "--retry=0", "--changed", parent, "--reporter=json", `--outputFile=${nativeReport}`];
	const fullArgs = ["run", "test:unit", "--", "--retry=0", "--reporter=json", `--outputFile=${fullReport}`];
	const nativeEnv = createQualificationEnvironment(ensureOwnedDirectory(sampleRoot, "native-changed"));
	const fullEnv = createQualificationEnvironment(ensureOwnedDirectory(sampleRoot, "full-unit"));
	const native = await runExecFile(npm, nativeArgs, { cwd: worktree, env: nativeEnv, timeout: 15 * 60_000 });
	if (native.code !== 0 && !existsSync(nativeReport)) {
		throw new Error(`${sample.id}: native --changed run failed without JSON evidence: ${(native.stderr || native.stdout).trim().slice(-2000)}`);
	}
	const full = await runExecFile(npm, fullArgs, { cwd: worktree, env: fullEnv, timeout: 20 * 60_000 });
	if (full.code !== 0 && !existsSync(fullReport)) {
		throw new Error(`${sample.id}: full unit run failed without JSON evidence: ${(full.stderr || full.stdout).trim().slice(-2000)}`);
	}
	const nativeEvidence = readVitestReport(nativeReport, worktree);
	const fullEvidence = readVitestReport(fullReport, worktree);
	const evidence = compareSelectionEvidence({
		selected: computed.plan.selected,
		directChangedUnit: directlyChangedUnitTests(changes, historicalUnit),
		nativeChangedObserved: nativeEvidence.observed,
		fullRunFailures: fullEvidence.failures,
	});
	const documentationOnly = isDocumentationOnly(changes);
	if (!documentationOnly && computed.plan.selected.length === 0) {
		throw new Error(`${sample.id}: non-documentation change selected zero tests`);
	}
	return {
		id: sample.id,
		category: sample.category,
		commit: sample.commit,
		parent,
		subject,
		synthetic: Boolean(sample.syntheticChanges?.length),
		documentationOnly,
		changedInputs: changes.map(({ status, path, oldPath }) => ({ status, path, ...(oldPath ? { oldPath } : {}) })),
		plan: computed.plan,
		graphOnlyDiagnostic: computed.plan.kind === "run-all" || sample.requireGraphOnlyDiagnostic
			? computed.graphOnlyDiagnostic
			: undefined,
		commands: {
			nativeChanged: commandString(npm, nativeArgs),
			fullUnit: commandString(npm, fullArgs),
		},
		exitCodes: { nativeChanged: native.code, fullUnit: full.code },
		timings: {
			selectionMs: computed.selectionMs,
			installMs: install.durationMs,
			nativeChangedMs: native.durationMs,
			fullUnitMs: full.durationMs,
		},
		evidence,
	};
}

export async function runCorrectnessQualification({
	samplePath = DEFAULT_SAMPLE_PATH,
	reportPath,
	only,
} = {}) {
	const manifest = loadSampleManifest(samplePath);
	const samples = only ? manifest.samples.filter((sample) => only.has(sample.id)) : manifest.samples;
	if (samples.length === 0) throw new Error("No affected correctness samples selected");
	for (const sample of samples) {
		await checked("git", ["merge-base", "--is-ancestor", sample.commit, "origin/main"], { cwd: REPO_ROOT, timeout: 60_000 });
	}
	const [{ buildGraph, affectedTests }] = await Promise.all([import("./graph.mjs")]);
	const graph = buildGraph();
	const rows = [];
	let worktree;
	const report = await withOwnedQualificationRoot(async (root) => {
		worktree = join(root, "worktree");
		await checked("git", ["worktree", "add", "--detach", worktree, samples[0].commit], {
			cwd: REPO_ROOT,
			timeout: 120_000,
		});
		try {
			for (const sample of samples) {
				const row = await qualifySample({ sample, graph, affectedTests, worktree, root });
				rows.push(row);
				console.log(renderAuditReport(buildAuditReport([row], {
					generatedAt: new Date().toISOString(),
					repository: REPO_ROOT,
					sampleManifest: samplePath,
				})));
			}
		} finally {
			const removed = await runExecFile("git", ["worktree", "remove", "--force", worktree], { cwd: REPO_ROOT, timeout: 120_000 });
			if (removed.code !== 0) {
				// The exact worktree is still below the invocation root. Removing that
				// root in the outer finally is safe; prune only stale Git metadata.
				await runExecFile("git", ["worktree", "prune"], { cwd: REPO_ROOT, timeout: 120_000 });
			}
		}
		return buildAuditReport(rows, {
			generatedAt: new Date().toISOString(),
			repository: REPO_ROOT,
			sampleManifest: samplePath,
		});
	});
	if (reportPath) {
		mkdirSync(dirname(reportPath), { recursive: true });
		writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
	}
	console.log(renderAuditReport(report));
	if (!report.summary.safe) {
		const problems = [
			...report.summary.suspiciousZero.map((id) => `${id}: non-doc zero selection`),
			...report.summary.underSelected.map(({ id, path }) => `${id}: missing ${path}`),
		];
		throw new Error(`Affected correctness qualification failed:\n- ${problems.join("\n- ")}`);
	}
	return report;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log(help());
		return;
	}
	await runCorrectnessQualification(options);
}

const isMain = process.argv[1]
	&& pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.stack ?? error.message : String(error));
		process.exitCode = 1;
	});
}
