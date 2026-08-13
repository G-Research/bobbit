#!/usr/bin/env node
// Sound affected + cached Vitest runner.
//
//   node scripts/affected/run.mjs [--base <ref>] [--changed a,b]
//       [--dry] [--json] [--no-cache] [--all]
//
// Browser selections are advisory. This command executes only the graph's
// authoritative unit inventory. RUN-ALL plans never consult cached verdicts.

import { executeAffectedRun, planAffectedRun } from "./runner.mjs";

function arg(name, fallback = "") {
	const index = process.argv.indexOf(name);
	return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const has = (name) => process.argv.includes(name);
const options = {
	base: arg("--base") || undefined,
	changed: arg("--changed"),
	dry: has("--dry"),
	json: has("--json"),
	noCache: has("--no-cache"),
	all: has("--all"),
};

function emitHumanPrelude(plan) {
	if (options.json || options.all) return;
	if (plan.comparisonLabel) console.log(`base=${plan.comparisonLabel}  changed files=${plan.records.length}`);
	else console.log(`changed (explicit)=${plan.records.length}`);
	if (plan.records.length) {
		console.log(plan.records.map((change) =>
			`  ${change.status} ${change.oldPath ? `${change.oldPath} -> ` : ""}${change.path}`).join("\n"));
	}
}

function emitResult(result) {
	if (options.json) console.log(JSON.stringify(result));
	else {
		console.log(`\n${result.summary}`);
		if (result.browserAffected.length) {
			console.log(`affected browser specs=${result.browserAffected.length} (advisory; run via Playwright tier)`);
		}
		if (options.dry) console.log(`\n[dry] would run:\n${result.toRun.map((test) => `  ${test}`).join("\n") || "  (nothing)"}`);
	}
}

function main() {
	const plan = planAffectedRun(options);
	emitHumanPrelude(plan);
	if (!options.json && !options.dry && plan.kind !== "skip-all" && plan.toRun.length > 0) {
		console.log(`\nrunning ${plan.toRun.length} vitest file(s)...`);
	}
	const result = executeAffectedRun(plan, options);
	emitResult(result);
	if (!options.json && result.outcome === "fail") {
		const passing = result.certifiedPassing?.size ?? 0;
		console.log(`${passing} passing file(s) cached; ${result.toRun.length - passing} file(s) left uncached.`);
	}
	return result.outcome === "fail" ? 1 : 0;
}

try {
	process.exitCode = main();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	if (options.json) console.log(JSON.stringify({ outcome: "error", error: message }));
	else console.error(`affected-test runner error: ${message}`);
	process.exitCode = 2;
}
