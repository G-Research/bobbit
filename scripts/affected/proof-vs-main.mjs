#!/usr/bin/env node
/**
 * Fast historical selection proof. This computes plans only; the expensive,
 * independent Vitest --changed and full-suite evidence lives in
 * correctness-vs-main.mjs.
 *
 *   node scripts/affected/proof-vs-main.mjs [N=14] [--json <path>]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildGraph, affectedTests, REPO_ROOT } from "./graph.mjs";
import {
	DEFAULT_SAMPLE_PATH,
	changesForCommit,
	changesForSample,
	computeHistoricalPlan,
	isDocumentationOnly,
	summarizeQualification,
	unitInventoryFromMap,
} from "./correctness-vs-main.mjs";

function parseArgs(argv) {
	let count = 14;
	let jsonPath;
	for (let i = 0; i < argv.length; i++) {
		if (/^\d+$/.test(argv[i])) count = Number(argv[i]);
		else if (argv[i] === "--json" && argv[i + 1]) jsonPath = resolve(argv[++i]);
		else if (argv[i] === "--help" || argv[i] === "-h") return { help: true, count };
		else throw new Error(`Unknown argument: ${argv[i]}`);
	}
	if (!Number.isSafeInteger(count) || count < 1 || count > 500) throw new Error(`Invalid commit count: ${count}`);
	return { count, jsonPath };
}

function git(args) {
	return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function pad(value, width) {
	const text = String(value);
	return text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);
}

function percent(value, total) {
	return total ? `${((value / total) * 100).toFixed(1)}%` : "0.0%";
}

export async function runProof({ count = 14, jsonPath } = {}) {
	const graph = buildGraph();
	const unitInventory = unitInventoryFromMap(JSON.parse(readFileSync(resolve(REPO_ROOT, "tests2", "tests-map.json"), "utf8")));
	const total = unitInventory.length;
	const commits = git(["log", "origin/main", "--format=%H%x01%s", `-${count}`])
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [commit, subject] = line.split("\u0001");
			return { commit, subject };
		});
	const pinnedManifest = JSON.parse(readFileSync(DEFAULT_SAMPLE_PATH, "utf8"));
	for (const sample of pinnedManifest.samples ?? []) {
		const existing = !sample.syntheticChanges?.length && commits.find((item) => item.commit === sample.commit);
		if (existing) existing.sample = sample;
		else commits.push({
			commit: sample.commit,
			subject: git(["show", "-s", "--format=%s", sample.commit]),
			sample,
		});
	}
	const rows = [];
	const violations = [];

	console.log(`\nAuthoritative unit suite: ${total} test files. Baseline = run all ${total} every change.`);
	console.log(`Selection-only proof over ${count} recent commits plus the fixed acceptance sample; run correctness-vs-main.mjs for independent execution evidence.\n`);
	console.log(
		pad("commit / subject", 48),
		pad("inputs", 8),
		pad("mode", 11),
		pad("selected", 10),
		pad("cache", 10),
		"diagnostic / note",
	);
	console.log("-".repeat(118));

	for (const item of commits) {
		const { parent, changes } = item.sample
			? await changesForSample(item.sample)
			: await changesForCommit(item.commit);
		const computed = await computeHistoricalPlan({ graph, affectedTests, changes, unitInventory });
		const documentationOnly = isDocumentationOnly(graph, changes);
		const row = {
			id: item.sample?.id ?? item.commit.slice(0, 10),
			commit: item.commit,
			parent,
			subject: item.subject,
			synthetic: Boolean(item.sample?.syntheticChanges?.length),
			documentationOnly,
			changedInputs: changes.map(({ status, path, oldPath }) => ({ status, path, ...(oldPath ? { oldPath } : {}) })),
			plan: computed.plan,
			graphOnlyDiagnostic: computed.plan.kind === "run-all" ? computed.graphOnlyDiagnostic : undefined,
			timings: { selectionMs: computed.selectionMs },
		};
		rows.push(row);

		let note;
		if (computed.plan.kind === "run-all") {
			note = `executable RUN-ALL; non-executable graph-only=${computed.graphOnlyDiagnostic.selected.length}`;
		} else if (computed.plan.kind === "skip-all") {
			note = documentationOnly ? "documented SKIP-ALL" : "SUSPICIOUS non-doc zero";
		} else {
			note = `${percent(computed.plan.selected.length, total)} of suite`;
		}
		console.log(
			pad(`${item.commit.slice(0, 9)}${item.sample ? ` [${item.sample.id}]` : ""} ${item.subject}`, 48),
			pad(String(changes.length), 8),
			pad(computed.plan.kind.toUpperCase(), 11),
			pad(String(computed.plan.selected.length), 10),
			pad(computed.plan.cachePolicy, 10),
			note,
		);

		if (computed.plan.kind === "bounded" && computed.plan.selected.length >= total) {
			violations.push(`${row.id} is labelled bounded but does not select a strict subset`);
		}
		if (item.sample?.expectedPlan && item.sample.expectedPlan !== computed.plan.kind) {
			violations.push(`${item.sample.id} expected ${item.sample.expectedPlan}, got ${computed.plan.kind}`);
		}
		if (item.sample?.requireGraphOnlyDiagnostic && computed.graphOnlyDiagnostic.selected.length === 0) {
			violations.push(`${item.sample.id} requires a non-empty, non-executable graph-only diagnostic`);
		}
	}

	console.log("-".repeat(118));
	const summary = summarizeQualification(rows);
	console.log(`\nCategories: skip-all=${summary.categories["skip-all"]}, bounded=${summary.categories.bounded}, run-all=${summary.categories["run-all"]}.`);
	console.log(`Bounded average only (${summary.boundedAverageSampleCount} rows; SKIP-ALL/RUN-ALL/zero excluded): ${summary.boundedAverageSelected ?? "n/a"} files.`);
	console.log("RUN-ALL counts above are executable plans with cache bypass. Graph-only counts are diagnostic and are never presented as the plan.");
	if (summary.suspiciousZero.length) {
		for (const id of summary.suspiciousZero) violations.push(`${id} is a non-documentation blind zero`);
	}

	const output = {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		origin: "origin/main",
		unitTotal: total,
		rows,
		summary,
		violations: [...new Set(violations)],
	};
	if (jsonPath) {
		mkdirSync(dirname(jsonPath), { recursive: true });
		writeFileSync(jsonPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
		console.log(`Audit JSON: ${jsonPath}`);
	}
	if (output.violations.length) {
		throw new Error(`Affected selection proof failed:\n- ${output.violations.join("\n- ")}`);
	}
	return output;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log("Usage: node scripts/affected/proof-vs-main.mjs [N=14] [--json PATH]");
		return;
	}
	await runProof(options);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exitCode = 1;
});
