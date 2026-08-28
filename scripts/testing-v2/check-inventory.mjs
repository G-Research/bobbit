#!/usr/bin/env node
/**
 * Audit convention-based Test Suite v2 discovery and reject newly introduced
 * test-shaped paths outside supported conventions.
 */
import { execFileSync } from "node:child_process";
import { collectIntroducedPaths } from "./unit-inventory-git.mjs";
import {
	discoverTests,
	validateIntroducedTestPaths,
} from "./test-discovery.mjs";

const valueAfter = (args, flag) => {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
};

function gitText(args) {
	return execFileSync("git", args, {
		encoding: "utf-8",
		maxBuffer: 32 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function gitOutput(args) {
	return execFileSync("git", args, {
		maxBuffer: 32 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

export function auditInventory({ upstream = "origin/main", readGitText = gitText, readGitOutput = gitOutput } = {}) {
	const mergeBase = readGitText(["merge-base", "HEAD", upstream]).trim();
	if (!/^[0-9a-f]{40,64}$/i.test(mergeBase)) {
		throw new Error(`git merge-base returned an invalid revision for ${upstream}: ${JSON.stringify(mergeBase)}`);
	}

	const discovery = discoverTests();
	const introducedPaths = collectIntroducedPaths(readGitOutput, { mergeBase });
	validateIntroducedTestPaths(introducedPaths);

	const duplicatePaths = discovery.all.filter((path, index) => discovery.all.indexOf(path) !== index);
	if (duplicatePaths.length) {
		throw new Error(`Convention discovery assigned multiple lanes to: ${[...new Set(duplicatePaths)].sort().join(", ")}`);
	}

	return Object.freeze({ mergeBase, upstream, introducedPaths: Object.freeze(introducedPaths), discovery });
}

function main() {
	const args = process.argv.slice(2);
	const upstream = valueAfter(args, "--upstream") ?? process.env.BOBBIT_TEST_INVENTORY_UPSTREAM ?? "origin/main";
	try {
		const { discovery, introducedPaths, mergeBase } = auditInventory({ upstream });
		console.log("check-inventory: PASS");
		console.log(`  merge base: ${mergeBase}`);
		console.log(`  introduced paths admitted: ${introducedPaths.length}`);
		console.log(`  unit: ${discovery.unit.length}`);
		console.log(`  browser: ${discovery.browser.length}`);
		console.log(`  e2e: ${Object.values(discovery.e2eGroups).flat().length}`);
		console.log(`  manual: ${discovery.manual.length}`);
		console.log(`  total: ${discovery.all.length} (exactly once)`);
	} catch (error) {
		console.error("check-inventory: FAIL\n");
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

main();
