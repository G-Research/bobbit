import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	TEST_LAYOUT,
	classifyTestPath,
	isRunnableTestPath,
	patternsFor,
	validateTestInventory,
} from "../../../scripts/testing/layout-policy.mjs";
import { classifyCanonicalE2E } from "../../../scripts/testing-v2/run-e2e-v2.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const TESTS_ROOT = join(REPO_ROOT, "tests");

interface Convention {
	semantic: string;
	lane: string;
	runner: string;
	directory: string;
	suffix: string;
	pattern: string;
}

function repoPath(path: string): string {
	return relative(REPO_ROOT, path).replace(/\\/g, "/");
}

function collectFiles(directory: string, output: string[] = []): string[] {
	if (!existsSync(directory)) return output;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) collectFiles(path, output);
		else if (entry.isFile()) output.push(repoPath(path));
	}
	return output;
}

function sorted(values: Iterable<string>): string[] {
	return [...values].sort();
}

function readRepoFile(path: string): string {
	return readFileSync(join(REPO_ROOT, ...path.split("/")), "utf8");
}

function ownedPaths(files: readonly string[], owner: string): string[] {
	const ownerPatterns = new Set(patternsFor(owner));
	return files.filter((path) => {
		const classification = classifyTestPath(path);
		return classification !== null && ownerPatterns.has(classification.pattern);
	}).sort();
}

function assertPairwiseDisjoint(namedSets: Readonly<Record<string, readonly string[]>>): void {
	const claims = new Map<string, string[]>();
	for (const [name, paths] of Object.entries(namedSets)) {
		for (const path of paths) {
			const owners = claims.get(path) ?? [];
			owners.push(name);
			claims.set(path, owners);
		}
	}
	const overlaps = [...claims]
		.filter(([, owners]) => owners.length > 1)
		.map(([path, owners]) => `${path}: ${owners.join(", ")}`);
	assert.deepEqual(overlaps, [], `Lane discovery must be pairwise disjoint:\n${overlaps.join("\n")}`);
}

const runnableFiles = collectFiles(TESTS_ROOT).filter(isRunnableTestPath).sort();
const conventions = TEST_LAYOUT as readonly Convention[];

test("the canonical policy is the only owner of every runnable test", () => {
	assert.ok(Object.isFrozen(TEST_LAYOUT), "the convention table must be immutable");
	for (const convention of conventions) {
		assert.ok(Object.isFrozen(convention), `${convention.semantic} convention must be immutable`);
		assert.deepEqual(
			Object.keys(convention).sort(),
			["directory", "lane", "pattern", "runner", "semantic", "suffix"],
			`${convention.semantic} must contain a convention, never a per-file registry record`,
		);
	}

	const diagnostics = validateTestInventory(runnableFiles, (path: string) => readRepoFile(path));
	assert.deepEqual(
		diagnostics,
		[],
		`Canonical test ownership violations:\n${diagnostics.map(({ path, message }: { path: string; message: string }) => `${path}: ${message}`).join("\n")}`,
	);

	const unowned = runnableFiles.filter((path) => classifyTestPath(path) === null);
	assert.deepEqual(unowned, [], `Every runnable test must have exactly one semantic owner:\n${unowned.join("\n")}`);
	assert.equal(
		new Set(conventions.map(({ pattern }) => pattern)).size,
		conventions.length,
		"each semantic owner must have one unique discovery pattern",
	);
});

test("unit, browser, E2E, and manual inventories are complete and pairwise disjoint", () => {
	const lanes = Object.fromEntries(
		["unit", "browser", "e2e", "manual"].map((lane) => [lane, ownedPaths(runnableFiles, lane)]),
	) as Record<string, string[]>;

	assertPairwiseDisjoint(lanes);
	assert.deepEqual(
		sorted(Object.values(lanes).flat()),
		runnableFiles,
		"the complete lane union must equal the canonical runnable inventory",
	);

	const supportRunnables = collectFiles(join(TESTS_ROOT, "support")).filter(isRunnableTestPath);
	assert.deepEqual(supportRunnables, [], "tests/support is non-runnable and cannot own a lane test");
});

test("runner discovery keeps browser, API E2E, browser-fidelity E2E, and manual tests disjoint", () => {
	const normalBrowser = [
		...ownedPaths(runnableFiles, "browser-fixture"),
		...ownedPaths(runnableFiles, "browser-journey"),
	].sort();
	assert.deepEqual(normalBrowser, ownedPaths(runnableFiles, "browser"));

	const e2eGroups = classifyCanonicalE2E();
	assert.deepEqual(e2eGroups.A, ownedPaths(runnableFiles, "node-e2e"));
	assert.deepEqual(e2eGroups.B, ownedPaths(runnableFiles, "api-e2e"));
	assert.deepEqual(e2eGroups.C, ownedPaths(runnableFiles, "browser-e2e"));
	assert.deepEqual(e2eGroups.D, ownedPaths(runnableFiles, "vitest-e2e"));
	assertPairwiseDisjoint({ normalBrowser, ...e2eGroups, manual: ownedPaths(runnableFiles, "manual") });

	for (const path of normalBrowser) assert.equal(classifyTestPath(path)?.lane, "browser");
	for (const path of e2eGroups.B) assert.equal(classifyTestPath(path)?.semantic, "api-e2e");
	for (const path of e2eGroups.C) assert.equal(classifyTestPath(path)?.semantic, "browser-e2e");
	for (const path of ownedPaths(runnableFiles, "manual")) assert.equal(classifyTestPath(path)?.lane, "manual");

	const vitestConfig = readRepoFile("vitest.config.ts");
	for (const pattern of [...patternsFor("unit"), ...patternsFor("vitest-e2e")]) {
		assert.ok(vitestConfig.includes(JSON.stringify(pattern)), `Vitest config must discover ${pattern}`);
	}

	const browserConfig = readRepoFile("playwright-v2.config.ts");
	assert.match(browserConfig, /testDir:\s*"\.\/tests\/browser"/);
	assert.match(browserConfig, /"fixtures\/\*\*\/\*\.fixture\.spec\.ts"/);
	assert.match(browserConfig, /"journeys\/\*\*\/\*\.journey\.spec\.ts"/);
	assert.doesNotMatch(browserConfig, /\.api-e2e\.spec\.ts|\.browser-e2e\.spec\.ts|\.manual\.spec\.ts/);

	const e2eConfig = readRepoFile("playwright-e2e.config.ts");
	assert.match(e2eConfig, /testDir:\s*"\.\/tests\/e2e\/api"[\s\S]*?testMatch:\s*\["\*\*\/\*\.api-e2e\.spec\.ts"\]/);
	assert.match(e2eConfig, /testDir:\s*"\.\/tests\/e2e\/browser"[\s\S]*?testMatch:\s*\["\*\*\/\*\.browser-e2e\.spec\.ts"\]/);
	assert.doesNotMatch(e2eConfig, /\.fixture\.spec\.ts|\.journey\.spec\.ts|\.manual\.spec\.ts/);

	const manualConfig = readRepoFile("playwright-manual.config.ts");
	assert.match(manualConfig, /testDir:\s*"\.\/tests\/manual"/);
	assert.match(manualConfig, /testMatch:\s*\["\*\*\/\*\.manual\.spec\.ts"\]/);
	assert.doesNotMatch(manualConfig, /\.fixture\.spec\.ts|\.journey\.spec\.ts|\.api-e2e\.spec\.ts|\.browser-e2e\.spec\.ts/);

	for (const source of [vitestConfig, browserConfig, e2eConfig, manualConfig, readRepoFile("scripts/testing-v2/run-e2e-v2.mjs")]) {
		assert.doesNotMatch(source, /tests-map|affected-test/i, "runner discovery must not depend on a registry or impact graph");
	}
});

test("public and CI lane commands run complete deterministic owners without a registry", () => {
	const packageJson = JSON.parse(readRepoFile("package.json")) as { scripts: Record<string, string> };
	const scripts = packageJson.scripts;
	assert.equal(scripts["test:unit"], "npm run test:v2:core --");
	assert.equal(scripts["test:v2:core"], "npm run test:layout && vitest run --config vitest.config.ts --silent=passed-only");
	assert.equal(scripts["test:browser"], "npm run test:v2:browser --");
	assert.equal(scripts["test:v2:browser"], "npm run test:layout && node scripts/testing-v2/run-browser-v2.mjs");
	assert.equal(scripts["test:e2e"], "npm run test:e2e:v2");
	assert.equal(scripts["test:e2e:v2"], "npm run test:layout && node scripts/testing-v2/ensure-dist.mjs && node scripts/testing-v2/run-e2e-v2.mjs");
	assert.equal(scripts["test:manual"], "npm run test:layout && npm run build && npx playwright test --config playwright-manual.config.ts");
	assert.equal(scripts.test, "npm run test:unit && npm run test:browser && npm run test:e2e");

	const authoritativeCommands = [
		scripts["test:v2:core"],
		scripts["test:v2:browser"],
		scripts["test:e2e:v2"],
		scripts["test:manual"],
		scripts.test,
	].join("\n");
	assert.doesNotMatch(authoritativeCommands, /tests-map|test:affected|--changed|--related/i);

	const projectConfig = readRepoFile(".bobbit/config/project.yaml");
	assert.match(projectConfig, /^\s*unit:\s+npm run test:unit\s*$/m);
	assert.match(projectConfig, /^\s*browser:\s+npm run test:browser\s*$/m);
	assert.match(projectConfig, /^\s*e2e:\s+npm run test:e2e\s*$/m);

	const buildUnitWorkflow = readRepoFile(".github/workflows/build-unit-gate.yml");
	assert.match(buildUnitWorkflow, /^\s*run:\s+npm run test:layout\s*$/m);
	assert.match(buildUnitWorkflow, /^\s*run:\s+npm run test:unit\s*$/m);
	assert.doesNotMatch(buildUnitWorkflow, /test:affected|--changed|tests-map/i);
});
