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
	environmentValue,
	sanitizeTestEnvironment,
	setEnvironmentValue,
} from "../testing-v2/environment-policy.mjs";
import { isDocumentationOnly } from "./classification.mjs";
import { IMPACT_RULES, REPOSITORY_SCAN_RULES } from "./impact-rules.mjs";
export { isDocumentationOnly } from "./classification.mjs";

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

function safeDeclaredPath(value) {
	const path = normalizeRepoPath(value);
	if (!path || path === ".." || path.startsWith("../") || path.includes("/../") || /^[A-Za-z]:\//.test(path)) return undefined;
	return path;
}

function declaredPathFromIssue(issue) {
	const match = /(?:production owner is missing|unit canary is missing or not unit-owned|unit consumer is missing or not unit-owned|repository input is missing|unresolved-read audit consumer is missing or not unit-owned|dynamic-executable audit consumer is missing or not Vitest-owned): (.+)$/u.exec(issue);
	return match ? safeDeclaredPath(match[1]) : undefined;
}

function auditConsumerFromIssue(issue) {
	const missing = /(?:unresolved-read audit consumer is missing or not unit-owned|dynamic-executable audit consumer is missing or not Vitest-owned): (.+)$/u.exec(issue);
	if (missing) return safeDeclaredPath(missing[1]);
	const prefixed = /^(tests2\/[^:]+\.test\.ts):/u.exec(issue);
	return prefixed ? safeDeclaredPath(prefixed[1]) : undefined;
}

function validationSnapshot(validation) {
	if (!validation) return { issues: [] };
	return {
		...(Array.isArray(validation.inputs) ? { inputs: sortedPaths(validation.inputs) } : {}),
		...(Array.isArray(validation.pairs) ? { pairs: validation.pairs.map((pair) => ({ ...pair })) } : {}),
		...(validation.auditedConsumers ? { auditedConsumers: sortedPaths(validation.auditedConsumers) } : {}),
		...(validation.actual ? { observedConsumers: sortedPaths(validation.actual.keys()) } : {}),
		issues: [...(validation.issues ?? [])].map(String),
	};
}

/**
 * Audit current selector declarations against an exact historical checkout.
 * Missing future declarations are retained but ignored. Drift on a live unit
 * test is quarantined into every non-doc bounded plan; all other live inventory,
 * ownership, or graph defects require RUN-ALL.
 */
export function historicalCompatibilityReport(graph, {
	repoRoot = graph?.repoRoot,
	unitInventory = graph?.testFiles ?? [],
	graphIssues = [],
} = {}) {
	const unit = sortedPaths(unitInventory);
	const unitSet = new Set(unit);
	const root = resolve(repoRoot ?? REPO_ROOT);
	const existsInRevision = (path) => Boolean(path) && existsSync(join(root, ...path.split("/")));
	const validationEntries = [
		["impact", graph?.meta?.impactValidation],
		["scan", graph?.meta?.repositoryScanValidation],
		["indirect", graph?.meta?.indirectRepositoryReadValidation],
		["unresolved-reader", graph?.meta?.unresolvedRepositoryReadAudit],
		["dynamic-operation", graph?.meta?.dynamicExecutableConsumerAudit],
	];
	const validations = Object.fromEntries(validationEntries.map(([name, validation]) => [name, validationSnapshot(validation)]));
	const issues = [];
	const record = (source, issue, disposition, extra = {}) => issues.push({ source, issue, disposition, ...extra });

	const absentAggregateDeclarations = (source, issue) => {
		if (source === "impact") {
			const match = /^([^:]+): no authoritative unit canary exists$/u.exec(issue);
			const rule = match && IMPACT_RULES.find((candidate) => candidate.id === match[1]);
			if (rule?.canaries?.length && rule.canaries.every((path) => !existsInRevision(path))) return sortedPaths(rule.canaries);
		}
		if (source === "scan") {
			const match = /^([^:]+): computed repository scan(?: root)? is empty(?:: (.+))?$/u.exec(issue);
			const rule = match && REPOSITORY_SCAN_RULES.find((candidate) => candidate.id === match[1]);
			const declared = match?.[2] ? [match[2]] : rule?.roots;
			if (declared?.length && declared.every((path) => !existsInRevision(path))) return sortedPaths(declared);
		}
		return undefined;
	};

	for (const [source, validation] of validationEntries) {
		for (const issueValue of validation?.issues ?? []) {
			const issue = String(issueValue);
			const missingDeclaration = declaredPathFromIssue(issue);
			if (missingDeclaration && !existsInRevision(missingDeclaration)) {
				record(source, issue, "ignored-absent-declaration", { paths: [missingDeclaration] });
				continue;
			}
			const absentDeclarations = absentAggregateDeclarations(source, issue);
			if (absentDeclarations) {
				record(source, issue, "ignored-absent-declaration", { paths: absentDeclarations });
				continue;
			}
			if (source === "unresolved-reader" || source === "dynamic-operation") {
				const consumer = auditConsumerFromIssue(issue);
				if (consumer && unitSet.has(consumer)) {
					record(source, issue, "quarantine", { test: consumer });
					continue;
				}
				if (consumer && !existsInRevision(consumer)) {
					record(source, issue, "ignored-absent-declaration", { paths: [consumer] });
					continue;
				}
				record(source, issue, "run-all", {
					reason: consumer
						? `live audit consumer is not revision unit-owned: ${consumer}`
						: "unclassifiable live audit issue",
				});
				continue;
			}
			record(source, issue, "run-all", { reason: "unclassifiable live inventory or ownership issue" });
		}
	}

	const graphUnit = sortedPaths(graph?.testFiles ?? []);
	if (graph && JSON.stringify(graphUnit) !== JSON.stringify(unit)) {
		const graphSet = new Set(graphUnit);
		const mapSet = new Set(unit);
		record("ownership", "revision graph inventory differs from the historical tests-map inventory", "run-all", {
			reason: "revision unit ownership mismatch",
			missingFromGraph: unit.filter((path) => !graphSet.has(path)),
			unexpectedInGraph: graphUnit.filter((path) => !mapSet.has(path)),
		});
	}
	for (const issue of graphIssues) {
		record("graph", String(issue), "run-all", { reason: "historical graph construction failed" });
	}

	const quarantinedTests = sortedPaths(issues.filter((issue) => issue.disposition === "quarantine").map((issue) => issue.test));
	const ignoredIssues = issues.filter((issue) => issue.disposition === "ignored-absent-declaration");
	const quarantineIssues = issues.filter((issue) => issue.disposition === "quarantine");
	const escalationIssues = issues.filter((issue) => issue.disposition === "run-all");
	return {
		contract: "current selector declarations over exact revision files; absent future declarations ignored, live audit drift quarantined, all other live issues RUN-ALL",
		validations,
		issues,
		ignoredIssues,
		quarantineIssues,
		quarantinedTests,
		escalated: escalationIssues.length > 0,
		escalationIssues,
	};
}

/** Apply the historical compatibility disposition without weakening RUN-ALL. */
export function applyHistoricalCompatibility(plan, compatibility, unitInventory, {
	documentationOnly = false,
} = {}) {
	const unit = sortedPaths(unitInventory);
	const baseSelected = sortedPaths(plan.selected);
	const quarantinedTests = [...(compatibility?.quarantinedTests ?? [])];
	const baseSelectedSet = new Set(baseSelected);
	const compatibilityAddedTests = quarantinedTests.filter((test) => !baseSelectedSet.has(test));
	const next = {
		...plan,
		selected: baseSelected,
		browserAffected: sortedPaths(plan.browserAffected ?? []),
		reasons: [...(plan.reasons ?? [])],
		unmapped: sortedPaths(plan.unmapped ?? []),
		compatibilityBaseSelectedCount: baseSelected.length,
		compatibilityQuarantinedTests: quarantinedTests,
		compatibilityAddedTests,
		compatibilityEscalated: Boolean(compatibility?.escalated),
	};
	if (compatibility?.escalated) {
		const first = compatibility.escalationIssues[0];
		return {
			...next,
			kind: "run-all",
			cachePolicy: "bypass",
			selected: unit,
			reasons: [...next.reasons, `historical compatibility escalation (${compatibility.escalationIssues.length}): ${first?.issue ?? "unknown graph issue"}`],
		};
	}
	if (next.kind === "bounded" && !documentationOnly && compatibility?.quarantinedTests?.length) {
		next.selected = sortedPaths([...next.selected, ...compatibility.quarantinedTests]);
		next.reasons.push(`historical compatibility quarantine: ${compatibility.quarantinedTests.length} live revision test(s), ${compatibilityAddedTests.length} added to this plan`);
	}
	return next;
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
	const selectedPaths = sortedPaths(selected);
	const scope = selectedPaths.length === 0
		? "empty static closure"
		: selectedPaths.length === unitSet.size
			? "full unit closure"
			: "bounded static closure";
	return {
		executable: false,
		label: `graph-only diagnostic (${scope}; broad triggers ignored; never executed)`,
		selected: selectedPaths,
	};
}

/**
 * Lazily obtain a clean failure baseline only when the changed full run named
 * failures. A non-zero baseline without named failing-test evidence is a
 * harness crash, not evidence that may be subtracted.
 */
export async function attributeFullRunFailures({
	fullRunFailures = [],
	runBaseline,
	label = "clean failure baseline",
} = {}) {
	const failures = sortedPaths(fullRunFailures);
	if (failures.length === 0) {
		return {
			baselineRan: false,
			fullRunFailures: failures,
			baselineRunFailures: [],
			attributedFullRunFailures: [],
			baseline: undefined,
		};
	}
	if (typeof runBaseline !== "function") {
		throw new Error(`${label}: changed full-run failures require clean baseline evidence`);
	}
	const baseline = await runBaseline();
	if (!baseline || typeof baseline.code !== "number" || !baseline.evidence
		|| !Array.isArray(baseline.evidence.observed) || !Array.isArray(baseline.evidence.failures)) {
		throw new Error(`${label}: missing complete Vitest baseline evidence`);
	}
	const hasRevisionInventory = baseline.unitInventory !== undefined;
	const baselineEvidence = validateVitestEvidence({
		evidence: baseline.evidence,
		exitCode: baseline.code,
		unitInventory: hasRevisionInventory ? baseline.unitInventory : baseline.evidence.observed,
		mode: hasRevisionInventory ? "full" : "native",
		label: `${label}: baseline full unit run`,
	});
	if (!hasRevisionInventory && baselineEvidence.observed.length === 0) {
		throw new Error(`${label}: baseline full unit run observed no test files`);
	}
	const baselineFailures = baselineEvidence.failures;
	const baselineSet = new Set(baselineFailures);
	return {
		baselineRan: true,
		fullRunFailures: failures,
		baselineRunFailures: baselineFailures,
		attributedFullRunFailures: failures.filter((path) => !baselineSet.has(path)),
		baseline,
	};
}

/**
 * The safety oracle. Required evidence is the union of directly changed
 * map-owned unit tests, Vitest --changed observations, and failures newly
 * present relative to the clean full-suite baseline.
 */
export function compareSelectionEvidence({
	selected = [],
	directChangedUnit = [],
	nativeChangedObserved = [],
	fullRunFailures = [],
	baselineRunFailures = [],
} = {}) {
	const selectedSet = new Set(sortedPaths(selected));
	const direct = sortedPaths(directChangedUnit);
	const native = sortedPaths(nativeChangedObserved);
	const failures = sortedPaths(fullRunFailures);
	const baselineFailures = sortedPaths(baselineRunFailures);
	const baselineSet = new Set(baselineFailures);
	const attributedFailures = failures.filter((path) => !baselineSet.has(path));
	const required = sortedPaths([...direct, ...native, ...attributedFailures]);
	const underSelected = required.filter((path) => !selectedSet.has(path));
	const requiredSet = new Set(required);
	const overSelected = sortedPaths(selectedSet).filter((path) => !requiredSet.has(path));
	return {
		selected: sortedPaths(selectedSet),
		directChangedUnit: direct,
		nativeChangedObserved: native,
		fullRunFailures: failures,
		baselineRunFailures: baselineFailures,
		attributedFullRunFailures: attributedFailures,
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
	for (const [index, result] of report.testResults.entries()) {
		if (!result || typeof result.name !== "string" || !result.name.trim()) {
			throw new Error(`Vitest JSON testResults[${index}] is missing a file name`);
		}
		if (result.assertionResults !== undefined && !Array.isArray(result.assertionResults)) {
			throw new Error(`Vitest JSON testResults[${index}] has invalid assertionResults`);
		}
		const path = reportPath(result.name, repoRoot);
		// Every reported file is observed, including files whose tests were skipped.
		observed.add(path);
		const assertionFailed = (result.assertionResults ?? []).some((item) => item?.status === "failed");
		if (result.status === "failed" || assertionFailed) failures.add(path);
	}
	return { observed: sortedPaths(observed), failures: sortedPaths(failures) };
}

function formatEvidencePaths(paths) {
	return paths.length > 0 ? paths.join(", ") : "(none)";
}

/**
 * Validate parsed Vitest JSON evidence against its process exit code and the
 * authoritative unit inventory loaded from the same checked-out revision.
 * Full runs must observe exactly that inventory. Native --changed runs may
 * observe a subset, but may never name files outside the revision inventory.
 */
export function validateVitestEvidence({
	evidence,
	exitCode,
	unitInventory,
	mode,
	label = "Vitest run",
} = {}) {
	if (mode !== "full" && mode !== "native") {
		throw new Error(`${label}: evidence mode must be "full" or "native"`);
	}
	if (!Number.isInteger(exitCode)) {
		throw new Error(`${label}: missing numeric process exit code`);
	}
	if (!evidence || !Array.isArray(evidence.observed) || !Array.isArray(evidence.failures)) {
		throw new Error(`${label}: missing parsed Vitest JSON evidence`);
	}
	if (!unitInventory || typeof unitInventory === "string"
		|| typeof unitInventory[Symbol.iterator] !== "function") {
		throw new Error(`${label}: missing authoritative revision unit inventory`);
	}

	const expected = sortedPaths(unitInventory);
	const observed = sortedPaths(evidence.observed);
	const failures = sortedPaths(evidence.failures);
	const expectedSet = new Set(expected);
	const observedSet = new Set(observed);
	const missing = mode === "full" ? expected.filter((path) => !observedSet.has(path)) : [];
	const unexpected = observed.filter((path) => !expectedSet.has(path));
	const unobservedFailures = failures.filter((path) => !observedSet.has(path));

	if (unobservedFailures.length > 0) {
		throw new Error(`${label}: report names failing files that it did not observe: ${formatEvidencePaths(unobservedFailures)}`);
	}
	if (missing.length > 0 || unexpected.length > 0) {
		throw new Error([
			`${label}: Vitest JSON inventory mismatch`,
			`missing (${missing.length}): ${formatEvidencePaths(missing)}`,
			`unexpected (${unexpected.length}): ${formatEvidencePaths(unexpected)}`,
		].join("\n"));
	}
	if (exitCode !== 0 && failures.length === 0) {
		throw new Error(`${label} exited ${exitCode} without named failing-test evidence (crashed or incomplete)`);
	}
	if (exitCode === 0 && failures.length > 0) {
		throw new Error(`${label} report names failures despite exit code 0: ${formatEvidencePaths(failures)}`);
	}

	return {
		observed,
		failures,
		validation: {
			mode,
			exitCode,
			expectedCount: expected.length,
			observedCount: observed.length,
			missing,
			unexpected,
		},
	};
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

function validatedRunEvidence({ label, result, reportPath, repoRoot, unitInventory, mode }) {
	if (!existsSync(reportPath)) {
		const detail = (result.stderr || result.stdout).trim().slice(-2000);
		throw new Error(`${label} exited ${result.code} without JSON evidence${detail ? `:\n${detail}` : ""}`);
	}
	return validateVitestEvidence({
		evidence: readVitestReport(reportPath, repoRoot),
		exitCode: result.code,
		unitInventory,
		mode,
		label,
	});
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
		contract: "each plan is built from its exact checked-out revision graph and historical unit inventory; selected is a superset of direct changed unit tests, validated Vitest --changed observations, and changed-run failures absent from an exact-revision full-suite baseline; every full report must equal its revision unit inventory",
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
		if (row.plan.provenance) {
			lines.push(`plan provenance: revision=${row.plan.provenance.revision}; root=${row.plan.provenance.repoRoot}; unit-total=${row.plan.provenance.unitTotal}; test-map=${row.plan.provenance.testMap}; tombstones=${formatEvidencePaths(row.plan.provenance.tombstones ?? [])}`);
		}
		if (row.compatibility) {
			lines.push(`historical compatibility: issues=${row.compatibility.issues.length}; ignored-absent=${row.compatibility.ignoredIssues.length}; quarantined=${row.compatibility.quarantinedTests.length}; escalated=${row.compatibility.escalated}`);
			lines.push(`compatibility quarantined tests (${row.compatibility.quarantinedTests.length}): ${formatEvidencePaths(row.compatibility.quarantinedTests)}`);
			lines.push(`compatibility plan additions (${row.plan.compatibilityAddedTests?.length ?? 0}): ${formatEvidencePaths(row.plan.compatibilityAddedTests ?? [])}`);
			for (const issue of row.compatibility.escalationIssues) {
				lines.push(`compatibility escalation [${issue.source}]: ${issue.issue}`);
			}
		}
		if (row.graphOnlyDiagnostic) {
			lines.push(`non-executable graph-only diagnostic: selected=${row.graphOnlyDiagnostic.selected.length}; ${row.graphOnlyDiagnostic.label}`);
		}
		lines.push(`native command: ${row.commands.nativeChanged}`);
		lines.push(`full command: ${row.commands.fullUnit}`);
		if (row.failureBaseline?.ran) {
			lines.push(`failure baseline: ${row.failureBaseline.revision}`);
			lines.push(`baseline checkout command: ${row.commands.baselineCheckout}`);
			lines.push(`baseline install command: ${row.commands.baselineInstall}`);
			lines.push(`baseline full command: ${row.commands.baselineFullUnit}`);
		} else {
			lines.push("failure baseline: not run (changed full run named no failures)");
		}
		lines.push(`exit codes: native=${row.exitCodes?.nativeChanged ?? "(unknown)"}, full=${row.exitCodes?.fullUnit ?? "(unknown)"}, baseline-checkout=${row.exitCodes?.baselineCheckout ?? "(not run)"}, baseline-install=${row.exitCodes?.baselineInstall ?? "(not run)"}, baseline-full=${row.exitCodes?.baselineFullUnit ?? "(not run)"}`);
		lines.push(`native observed (${row.evidence.nativeChangedObserved.length}): ${row.evidence.nativeChangedObserved.join(", ") || "(none)"}`);
		const fullObserved = row.evidence.fullRunObserved ?? [];
		lines.push(`full observed (${fullObserved.length}): ${fullObserved.join(", ") || "(not recorded)"}`);
		lines.push(`full failures (${row.evidence.fullRunFailures.length}): ${row.evidence.fullRunFailures.join(", ") || "(none)"}`);
		const baselineObserved = row.evidence.baselineRunObserved ?? [];
		const baselineFailures = row.evidence.baselineRunFailures ?? [];
		const attributedFailures = row.evidence.attributedFullRunFailures ?? row.evidence.fullRunFailures;
		lines.push(`baseline observed (${baselineObserved.length}): ${baselineObserved.join(", ") || (row.failureBaseline?.ran ? "(none)" : "(not run)")}`);
		lines.push(`baseline failures (${baselineFailures.length}): ${baselineFailures.join(", ") || "(none)"}`);
		for (const [name, validation] of Object.entries(row.evidence.validations ?? {})) {
			if (!validation) continue;
			lines.push(`${name} evidence validation: mode=${validation.mode}; expected=${validation.expectedCount}; observed=${validation.observedCount}; missing=${formatEvidencePaths(validation.missing)}; unexpected=${formatEvidencePaths(validation.unexpected)}`);
		}
		lines.push(`attributed failures (${attributedFailures.length}): ${attributedFailures.join(", ") || "(none)"}`);
		lines.push(`required (${row.evidence.required.length}): ${row.evidence.required.join(", ") || "(none)"}`);
		lines.push(`under-selected (${row.evidence.underSelected.length}): ${row.evidence.underSelected.join(", ") || "(none)"}`);
		lines.push(`over-selected (${row.evidence.overSelected.length}): ${row.evidence.overSelected.join(", ") || "(none)"}`);
		lines.push(`timings ms: selection=${row.timings.selectionMs}, install=${row.timings.installMs}, native=${row.timings.nativeChangedMs}, full=${row.timings.fullUnitMs}, baseline-checkout=${row.timings.baselineCheckoutMs ?? "(not run)"}, baseline-install=${row.timings.baselineInstallMs ?? "(not run)"}, baseline-full=${row.timings.baselineFullUnitMs ?? "(not run)"}`);
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

/**
 * Resolve npm to a directly executable program. Windows cannot pass a .cmd
 * shim to execFile without a shell (`spawn EINVAL`), so invoke npm's JS entry
 * with the current Node executable instead. Arguments remain an argv array.
 */
export function npmInvocation(args, {
	platform = process.platform,
	env = process.env,
	nodeExecutable = process.execPath,
	fileExists = existsSync,
} = {}) {
	const npmExecPath = environmentValue(env, "npm_execpath", platform);
	if (npmExecPath && fileExists(npmExecPath)) {
		return { file: nodeExecutable, args: [npmExecPath, ...args] };
	}
	if (platform === "win32") {
		const npmCli = join(dirname(nodeExecutable), "node_modules", "npm", "bin", "npm-cli.js");
		if (fileExists(npmCli)) return { file: nodeExecutable, args: [npmCli, ...args] };
		throw new Error("Cannot locate npm for shell-free Windows execution. Run this qualification through `npm run test:affected:correctness`.");
	}
	return { file: "npm", args };
}

function runExecFile(file, args, options = {}) {
	return new Promise((resolveResult) => {
		const started = Date.now();
		execFile(file, args, {
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			windowsHide: true,
			...options,
			shell: false,
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

/** Exact old sides that must be admitted while constructing a revision graph. */
export function tombstonesForChanges(changes) {
	return sortedPaths(changes.flatMap((change) => {
		const status = String(change.status ?? "M").toUpperCase();
		if (status.startsWith("R") && change.oldPath) return [change.oldPath];
		if (status.startsWith("D")) return [change.path];
		return [];
	}));
}

async function revisionExecutionMapLoader(repoRoot, revision) {
	const moduleUrl = pathToFileURL(join(repoRoot, "scripts", "testing-v2", "test-map-execution.mjs"));
	moduleUrl.searchParams.set("revision", String(revision));
	const module = await import(moduleUrl.href);
	if (typeof module.loadVitestExecutionMap !== "function") {
		throw new TypeError(`Historical execution-map module has no loadVitestExecutionMap(): ${moduleUrl.pathname}`);
	}
	return module.loadVitestExecutionMap;
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

export async function computeHistoricalPlan({
	graph,
	affectedTests,
	changes,
	unitInventory,
	compatibility,
	documentationOnly = false,
	provenance,
}) {
	const started = Date.now();
	const raw = await invokeAffected(affectedTests, graph, changes);
	let plan = normalizeSelectionPlan(raw, unitInventory);
	if (compatibility) {
		plan = applyHistoricalCompatibility(plan, compatibility, unitInventory, { documentationOnly });
	}
	if (provenance) plan = { ...plan, provenance };
	return {
		plan,
		graphOnlyDiagnostic: graphOnlyDiagnostic(graph, changes, unitInventory),
		selectionMs: Date.now() - started,
	};
}

/**
 * Build an exact-revision executable plan. Only revision-loader or graph-build
 * incompatibility is deliberately converted to RUN-ALL. Once a graph exists,
 * classification, compatibility, and selector failures must escape so the
 * qualification cannot certify a fabricated plan.
 */
export async function orchestrateHistoricalSelection({
	buildGraph,
	affectedTests,
	changes,
	unitInventory,
	repoRoot,
	revision,
	tombstones = [],
	provenance,
	executionMapLoaderFactory = revisionExecutionMapLoader,
	documentationClassifier = isDocumentationOnly,
	compatibilityReporter = historicalCompatibilityReport,
}) {
	const selectionStarted = Date.now();
	let graph;
	let graphIssue;
	let graphUnavailable = false;
	try {
		const executionMapLoader = await executionMapLoaderFactory(repoRoot, revision);
		graph = buildGraph({
			repoRoot,
			executionMapLoader,
			tombstones,
			strictImpactInventory: false,
		});
	} catch (error) {
		graphUnavailable = true;
		graphIssue = error instanceof Error ? error.stack ?? error.message : String(error);
	}

	if (graphUnavailable) {
		const compatibility = compatibilityReporter(undefined, {
			repoRoot,
			unitInventory,
			graphIssues: [graphIssue],
		});
		const rawPlan = normalizeSelectionPlan({
			kind: "run-all",
			cachePolicy: "bypass",
			affected: unitInventory,
			reasons: ["historical revision graph unavailable"],
		}, unitInventory);
		return {
			graph: undefined,
			documentationOnly: false,
			compatibility,
			computed: {
				plan: {
					...applyHistoricalCompatibility(rawPlan, compatibility, unitInventory),
					...(provenance ? { provenance } : {}),
				},
				graphOnlyDiagnostic: undefined,
				selectionMs: Date.now() - selectionStarted,
			},
		};
	}

	const documentationOnly = documentationClassifier(graph, changes);
	const compatibility = compatibilityReporter(graph, {
		repoRoot,
		unitInventory,
	});
	const computed = await computeHistoricalPlan({
		graph,
		affectedTests,
		changes,
		unitInventory,
		compatibility,
		documentationOnly,
		provenance,
	});
	computed.selectionMs = Date.now() - selectionStarted;
	return { graph, documentationOnly, compatibility, computed };
}

function assertExpectedPlan(sample, plan, diagnostic, unitTotal) {
	if (sample.expectedPlan && sample.expectedPlan !== plan.kind) {
		throw new Error(`${sample.id}: expected ${sample.expectedPlan}, got ${plan.kind}`);
	}
	if (sample.expectedPlan === "bounded" && (plan.selected.length === 0 || plan.selected.length >= unitTotal)) {
		throw new Error(`${sample.id}: bounded sample must select a nonzero strict subset, got ${plan.selected.length}/${unitTotal}`);
	}
	if (sample.requireGraphOnlyDiagnostic && (!diagnostic || diagnostic.selected.length === 0)) {
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
	return `Usage: node scripts/affected/correctness-vs-main.mjs [options]\n\nOptions:\n  --sample PATH      Fixed immutable sample manifest\n  --only ID,ID       Run a subset of manifest sample ids\n  --report PATH      Also write the complete audit JSON\n  --help             Show this help\n\nThis command is expensive: every sample runs npm ci, Vitest --changed, and the full retry-free unit suite. A clean full-suite baseline is run lazily when the changed full run names failures.`;
}

async function runFailureBaseline({ sample, parent, worktree, sampleRoot, reports, profiles }) {
	const revision = sample.syntheticChanges?.length ? sample.commit : parent;
	const checkoutArgs = ["checkout", "--detach", "--force", revision];
	const checkout = await checked("git", checkoutArgs, { cwd: worktree, timeout: 120_000 });
	const revisionMap = JSON.parse(readFileSync(join(worktree, "tests2", "tests-map.json"), "utf8"));
	const revisionUnit = unitInventoryFromMap(revisionMap);
	rmSync(profiles, { recursive: true, force: true });

	const installEnv = createQualificationEnvironment(ensureOwnedDirectory(sampleRoot, "baseline-install"));
	const installInvocation = npmInvocation(["ci", "--include=optional", "--no-audit", "--no-fund"], { env: installEnv });
	const install = await checked(installInvocation.file, installInvocation.args, {
		cwd: worktree,
		env: installEnv,
		timeout: 15 * 60_000,
	});

	const report = join(reports, "baseline-full-unit.json");
	const args = ["run", "test:unit", "--", "--retry=0", "--reporter=json", `--outputFile=${report}`];
	const env = createQualificationEnvironment(ensureOwnedDirectory(sampleRoot, "baseline-full-unit"));
	const invocation = npmInvocation(args, { env });
	const full = await runExecFile(invocation.file, invocation.args, {
		cwd: worktree,
		env,
		timeout: 20 * 60_000,
	});
	const evidence = validatedRunEvidence({
		label: `${sample.id}: baseline full unit run at ${revision}`,
		result: full,
		reportPath: report,
		repoRoot: worktree,
		unitInventory: revisionUnit,
		mode: "full",
	});
	return {
		code: full.code,
		evidence,
		unitInventory: revisionUnit,
		revision,
		commands: {
			checkout: commandString("git", checkoutArgs),
			install: commandString(installInvocation.file, installInvocation.args),
			fullUnit: commandString(invocation.file, invocation.args),
		},
		exitCodes: { checkout: checkout.code, install: install.code, fullUnit: full.code },
		timings: {
			checkoutMs: checkout.durationMs,
			installMs: install.durationMs,
			fullUnitMs: full.durationMs,
		},
	};
}

async function qualifySample({ sample, buildGraph, affectedTests, worktree, root }) {
	const { parent, changes } = await changesForSample(sample);
	const subject = await gitText(["show", "-s", "--format=%s", sample.commit]);
	await checked("git", ["checkout", "--detach", "--force", sample.commit], { cwd: worktree, timeout: 120_000 });
	applySyntheticChanges(sample, worktree, changes);
	const profiles = join(worktree, ".profiles");
	if (!ownedChild(root, profiles)) throw new Error(`Refusing to clean non-owned sample path: ${profiles}`);
	rmSync(profiles, { recursive: true, force: true });
	const sampleRoot = ensureOwnedDirectory(root, "runs", sample.id);
	const installEnv = createQualificationEnvironment(ensureOwnedDirectory(sampleRoot, "install"));
	const installInvocation = npmInvocation(["ci", "--include=optional", "--no-audit", "--no-fund"], { env: installEnv });
	const install = await checked(installInvocation.file, installInvocation.args, {
		cwd: worktree,
		env: installEnv,
		timeout: 15 * 60_000,
	});
	const map = JSON.parse(readFileSync(join(worktree, "tests2", "tests-map.json"), "utf8"));
	const historicalUnit = unitInventoryFromMap(map);
	const tombstones = tombstonesForChanges(changes);
	const provenance = {
		revision: sample.commit,
		repoRoot: resolve(worktree),
		testMap: "tests2/tests-map.json",
		unitTotal: historicalUnit.length,
		tombstones,
		selectorSource: "current affected selector over exact checked-out revision files",
		executionMapSource: "revision-local scripts/testing-v2/test-map-execution.mjs",
	};
	const {
		documentationOnly,
		compatibility,
		computed,
	} = await orchestrateHistoricalSelection({
		buildGraph,
		affectedTests,
		changes,
		unitInventory: historicalUnit,
		repoRoot: worktree,
		revision: sample.commit,
		tombstones,
		provenance,
	});
	assertExpectedPlan(sample, computed.plan, computed.graphOnlyDiagnostic, historicalUnit.length);

	const reports = ensureOwnedDirectory(sampleRoot, "reports");
	const nativeReport = join(reports, "native-changed.json");
	const fullReport = join(reports, "full-unit.json");
	const nativeArgs = ["run", "test:unit", "--", "--retry=0", "--changed", parent, "--reporter=json", `--outputFile=${nativeReport}`];
	const fullArgs = ["run", "test:unit", "--", "--retry=0", "--reporter=json", `--outputFile=${fullReport}`];
	const nativeEnv = createQualificationEnvironment(ensureOwnedDirectory(sampleRoot, "native-changed"));
	const fullEnv = createQualificationEnvironment(ensureOwnedDirectory(sampleRoot, "full-unit"));
	const nativeInvocation = npmInvocation(nativeArgs, { env: nativeEnv });
	const fullInvocation = npmInvocation(fullArgs, { env: fullEnv });
	const native = await runExecFile(nativeInvocation.file, nativeInvocation.args, { cwd: worktree, env: nativeEnv, timeout: 15 * 60_000 });
	const nativeEvidence = validatedRunEvidence({
		label: `${sample.id}: native --changed run at ${sample.commit}`,
		result: native,
		reportPath: nativeReport,
		repoRoot: worktree,
		unitInventory: historicalUnit,
		mode: "native",
	});
	const full = await runExecFile(fullInvocation.file, fullInvocation.args, { cwd: worktree, env: fullEnv, timeout: 20 * 60_000 });
	const fullEvidence = validatedRunEvidence({
		label: `${sample.id}: changed full unit run at ${sample.commit}`,
		result: full,
		reportPath: fullReport,
		repoRoot: worktree,
		unitInventory: historicalUnit,
		mode: "full",
	});
	const attribution = await attributeFullRunFailures({
		fullRunFailures: fullEvidence.failures,
		label: `${sample.id}: clean failure baseline`,
		runBaseline: () => runFailureBaseline({ sample, parent, worktree, sampleRoot, reports, profiles }),
	});
	const evidence = {
		...compareSelectionEvidence({
			selected: computed.plan.selected,
			directChangedUnit: directlyChangedUnitTests(changes, historicalUnit),
			nativeChangedObserved: nativeEvidence.observed,
			fullRunFailures: attribution.fullRunFailures,
			baselineRunFailures: attribution.baselineRunFailures,
		}),
		fullRunObserved: fullEvidence.observed,
		baselineRunObserved: attribution.baseline?.evidence.observed ?? [],
		validations: {
			native: nativeEvidence.validation,
			full: fullEvidence.validation,
			baseline: attribution.baseline?.evidence.validation ?? null,
		},
	};
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
		compatibility,
		graphOnlyDiagnostic: computed.plan.kind === "run-all" || sample.requireGraphOnlyDiagnostic
			? computed.graphOnlyDiagnostic
			: undefined,
		failureBaseline: {
			ran: attribution.baselineRan,
			revision: attribution.baseline?.revision ?? null,
		},
		commands: {
			nativeChanged: commandString(nativeInvocation.file, nativeInvocation.args),
			fullUnit: commandString(fullInvocation.file, fullInvocation.args),
			baselineCheckout: attribution.baseline?.commands.checkout ?? null,
			baselineInstall: attribution.baseline?.commands.install ?? null,
			baselineFullUnit: attribution.baseline?.commands.fullUnit ?? null,
		},
		exitCodes: {
			nativeChanged: native.code,
			fullUnit: full.code,
			baselineCheckout: attribution.baseline?.exitCodes.checkout ?? null,
			baselineInstall: attribution.baseline?.exitCodes.install ?? null,
			baselineFullUnit: attribution.baseline?.exitCodes.fullUnit ?? null,
		},
		timings: {
			selectionMs: computed.selectionMs,
			installMs: install.durationMs,
			nativeChangedMs: native.durationMs,
			fullUnitMs: full.durationMs,
			baselineCheckoutMs: attribution.baseline?.timings.checkoutMs ?? null,
			baselineInstallMs: attribution.baseline?.timings.installMs ?? null,
			baselineFullUnitMs: attribution.baseline?.timings.fullUnitMs ?? null,
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
				const row = await qualifySample({ sample, buildGraph, affectedTests, worktree, root });
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
