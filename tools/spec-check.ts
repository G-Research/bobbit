#!/usr/bin/env npx tsx
/**
 * spec_check — Bobbit specification integrity checker.
 *
 * Imports the contract and story registries (populated by importing the
 * spec-contracts and story files), then validates completeness and outputs
 * the spec graph.
 *
 * Usage:
 *   npx tsx tools/spec-check.ts                  # full report
 *   npx tsx tools/spec-check.ts --json            # export graph as JSON
 *   npx tsx tools/spec-check.ts --query editor    # stories touching "editor"
 *   npx tsx tools/spec-check.ts --contract CT-02  # CT-02 coverage detail
 */

// Import registries — these populate on import via defineContract/defineStory calls
import "../tests/e2e/ui/spec-contracts.js";
import "../tests/e2e/ui/story-registry.js";

import {
	getContractRegistry,
	getStoryRegistry,
	exportSpecGraph,
	contractCompleteness,
	storiesForRegion,
	findRelatedStories,
} from "../tests/e2e/ui/spec-framework.js";

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith("--")));
const positionals = args.filter(a => !a.startsWith("--"));

// Colors for terminal output
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function printCompleteness() {
	const results = contractCompleteness();
	const contracts = getContractRegistry();
	const stories = getStoryRegistry();

	let totalVariations = 0;
	let totalCovered = 0;
	let totalContracts = results.length;
	let fullyConvered = 0;

	console.log(bold("\n📋 Contract Completeness Report\n"));

	for (const report of results) {
		const covered = report.variations.filter(v => v.coveredBy !== null).length;
		const total = report.variations.length;
		totalVariations += total;
		totalCovered += covered;

		const pct = total > 0 ? Math.round((covered / total) * 100) : 100;
		const status = pct === 100 ? green("✓") : pct > 0 ? yellow("◐") : red("✗");
		if (pct === 100) fullyConvered++;

		console.log(`${status} ${bold(report.contractId)}: ${report.guarantee}`);
		console.log(`  ${dim(`${covered}/${total} variations (${pct}%)`)}`);

		for (const v of report.variations) {
			if (v.coveredBy) {
				console.log(`    ${green("✓")} ${v.name} → ${v.coveredBy}`);
			} else {
				console.log(`    ${red("✗")} ${v.name} → ${red("NO STORY")}`);
			}
		}
		console.log();
	}

	// Summary
	const overallPct = totalVariations > 0 ? Math.round((totalCovered / totalVariations) * 100) : 100;
	console.log(bold("─".repeat(60)));
	console.log(bold("Summary:"));
	console.log(`  Contracts:  ${fullyConvered}/${totalContracts} fully covered`);
	console.log(`  Variations: ${totalCovered}/${totalVariations} covered (${overallPct}%)`);
	console.log(`  Stories:    ${stories.size} registered`);

	// List uncovered contracts
	const uncovered = results.filter(r => r.coverage === 0);
	if (uncovered.length > 0) {
		console.log(`\n${red("Contracts with NO stories:")}`);
		for (const r of uncovered) {
			console.log(`  ${red("✗")} ${r.contractId}: ${r.guarantee}`);
		}
	}

	// Exit code: fail if any contract has zero coverage
	return uncovered.length === 0;
}

function printQuery(query: string) {
	const regions = storiesForRegion(query);
	if (regions.length > 0) {
		console.log(bold(`\nStories touching region "${query}":\n`));
		for (const id of regions) {
			const story = getStoryRegistry().get(id);
			console.log(`  ${id}: ${story?.title ?? "unknown"}`);
		}
	} else {
		console.log(`\nNo stories found for region "${query}"`);
	}
}

function printContract(contractId: string) {
	const results = contractCompleteness();
	const report = results.find(r => r.contractId === contractId);
	if (!report) {
		console.log(red(`Contract "${contractId}" not found`));
		process.exit(1);
	}

	const covered = report.variations.filter(v => v.coveredBy !== null).length;
	const total = report.variations.length;
	const pct = total > 0 ? Math.round((covered / total) * 100) : 100;

	console.log(bold(`\n${report.contractId}: ${report.guarantee}\n`));
	console.log(`Coverage: ${covered}/${total} (${pct}%)\n`);

	for (const v of report.variations) {
		if (v.coveredBy) {
			console.log(`  ${green("✓")} ${v.name} → ${v.coveredBy}`);
		} else {
			console.log(`  ${red("✗")} ${v.name} → ${red("NO STORY")}`);
		}
	}

	// Show related stories
	const storyIds = report.variations.filter(v => v.coveredBy).map(v => v.coveredBy!);
	if (storyIds.length > 0) {
		const related = findRelatedStories(storyIds[0]);
		const externalRelated = related.filter(r => !storyIds.includes(r.id)).slice(0, 5);
		if (externalRelated.length > 0) {
			console.log(`\n${dim("Related stories from other contracts:")}`);
			for (const r of externalRelated) {
				console.log(`  ${dim(r.id)}: ${dim(r.reason)}`);
			}
		}
	}
}

function printJson() {
	const graph = exportSpecGraph();
	const completeness = contractCompleteness();
	console.log(JSON.stringify({ graph, completeness }, null, 2));
}

// Main
if (flags.has("--json")) {
	printJson();
} else if (flags.has("--query") && positionals.length > 0) {
	printQuery(positionals[0]);
} else if (flags.has("--contract") && positionals.length > 0) {
	printContract(positionals[0]);
} else {
	const ok = printCompleteness();
	process.exit(ok ? 0 : 1);
}
