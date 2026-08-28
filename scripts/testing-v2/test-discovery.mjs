import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");
const MAX_ISOLATED_TESTS = 14;

const TEST_SOURCE_PATTERN = /\.(?:test|spec)\.ts$/;
const MANAGED_UNIT_ROOTS = "tests2/core, tests2/dom, or tests2/integration";

const OWNERS = Object.freeze({
	core: Object.freeze({ lane: "core", phase: "unit", runner: "vitest", project: "v2-core" }),
	dom: Object.freeze({ lane: "dom", phase: "unit", runner: "vitest", project: "v2-dom" }),
	integration: Object.freeze({ lane: "integration", phase: "unit", runner: "vitest", project: "v2-integration" }),
	isolated: Object.freeze({ lane: "isolated", phase: "unit", runner: "vitest", project: "v2-isolated" }),
	vitestE2E: Object.freeze({ lane: "vitestE2E", phase: "e2e", runner: "vitest", project: "v2-e2e-vitest", e2eGroup: "D" }),
	browser: Object.freeze({ lane: "browser", phase: "browser", runner: "playwright", project: "browser-v2" }),
	browserE2E: Object.freeze({ lane: "browserE2E", phase: "e2e", runner: "playwright", project: "browser-v2-e2e", e2eGroup: "C" }),
	e2eNode: Object.freeze({ lane: "e2eNode", phase: "e2e", runner: "tsx", project: "e2e-node", e2eGroup: "A" }),
	e2ePlaywright: Object.freeze({ lane: "e2ePlaywright", phase: "e2e", runner: "playwright", project: "e2e-playwright", e2eGroup: "B" }),
	manual: Object.freeze({ lane: "manual", phase: "manual", runner: "playwright", project: "manual-integration" }),
});

export function normalizeTestPath(value) {
	return String(value).replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
}

function isTestSource(path) {
	return TEST_SOURCE_PATTERN.test(path);
}

function placementError(path, remedy) {
	return new Error(`Unsupported test placement ${JSON.stringify(path)}. ${remedy}`);
}

function assertSafeRelativePath(path) {
	if (/^(?:\/|[A-Za-z]:)/.test(path) || path.split("/").includes("..")) {
		throw placementError(path, "Use a repository-relative path without '..' traversal.");
	}
}

/**
 * Classify one repository-relative test path. Non-test sources and retained
 * historical tests outside active conventions return null.
 */
export function classifyTestPath(pathValue) {
	const path = normalizeTestPath(pathValue);
	assertSafeRelativePath(path);
	if (!isTestSource(path)) return null;

	const basename = path.slice(path.lastIndexOf("/") + 1);
	const hasIsolatedMarker = basename.includes(".isolated.");
	const hasE2EMarker = basename.includes(".e2e.");
	if (hasIsolatedMarker && hasE2EMarker) {
		throw placementError(path, "Use exactly one semantic suffix: '*.isolated.test.ts' or '*.e2e.test.ts'.");
	}

	if (/^tests2\/(?:core|integration)\/.+\.isolated\.test\.ts$/.test(path)) return OWNERS.isolated;
	if (/^tests2\/(?:core|integration)\/.+\.e2e\.test\.ts$/.test(path)) return OWNERS.vitestE2E;
	if (/^tests2\/core\/.+\.test\.ts$/.test(path)) return OWNERS.core;
	if (/^tests2\/dom\/.+\.test\.ts$/.test(path)) {
		if (hasIsolatedMarker || hasE2EMarker) {
			throw placementError(path, "Semantic Vitest tests belong in tests2/core or tests2/integration with '*.isolated.test.ts' or '*.e2e.test.ts'.");
		}
		return OWNERS.dom;
	}
	if (/^tests2\/integration\/.+\.test\.ts$/.test(path)) return OWNERS.integration;
	if (/^tests2\/browser\/e2e\/.+\.spec\.ts$/.test(path)) return OWNERS.browserE2E;
	if (/^tests2\/browser\/.+\.spec\.ts$/.test(path)) return OWNERS.browser;
	if (/^tests\/[^/]+\.e2e\.test\.ts$/.test(path)) return OWNERS.e2eNode;
	if (/^tests\/e2e\/.+\.e2e\.spec\.ts$/.test(path)) return OWNERS.e2ePlaywright;
	if (/^tests\/manual-integration\/.+\.(?:test|spec)\.ts$/.test(path)) return OWNERS.manual;

	if (/^tests2\/(?:core|dom|integration)(?:\/|$)/.test(path)) {
		throw placementError(path, "Vitest tests here must use '*.test.ts'; Playwright '*.spec.ts' journeys belong in tests2/browser.");
	}
	if (/^tests2\/browser(?:\/|$)/.test(path)) {
		throw placementError(path, `Browser journeys must use '*.spec.ts'; API/Vitest '*.test.ts' tests belong in ${MANAGED_UNIT_ROOTS}.`);
	}
	if (path.startsWith("tests2/")) {
		throw placementError(path, "Use tests2/core|dom|integration/**/*.test.ts or tests2/browser/**/*.spec.ts.");
	}

	// The retained legacy tree is intentionally inactive. Admission validation
	// rejects newly introduced test-shaped paths that reach this branch.
	return null;
}

function collectFiles(repoRoot, relativeRoot) {
	const absoluteRoot = join(repoRoot, ...relativeRoot.split("/"));
	const files = [];
	const visit = (directory) => {
		let entries;
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch (error) {
			if (error && typeof error === "object" && error.code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
			const absolutePath = join(directory, entry.name);
			if (entry.isDirectory()) visit(absolutePath);
			else if (entry.isFile()) files.push(normalizeTestPath(relative(repoRoot, absolutePath)));
		}
	};
	visit(absoluteRoot);
	return files;
}

function frozenSorted(values) {
	return Object.freeze([...values].sort());
}

/** Discover every active test from filesystem conventions without caching. */
export function discoverTests({ repoRoot = REPO_ROOT } = {}) {
	const leaves = {
		core: [],
		dom: [],
		integration: [],
		isolated: [],
		vitestE2E: [],
		browser: [],
		browserE2E: [],
		e2eNode: [],
		e2ePlaywright: [],
		manual: [],
	};

	const candidates = [
		...collectFiles(repoRoot, "tests2/core"),
		...collectFiles(repoRoot, "tests2/dom"),
		...collectFiles(repoRoot, "tests2/integration"),
		...collectFiles(repoRoot, "tests2/browser"),
		...collectFiles(repoRoot, "tests"),
	];
	for (const path of candidates) {
		const owner = classifyTestPath(path);
		if (owner) leaves[owner.lane].push(path);
	}

	if (leaves.isolated.length > MAX_ISOLATED_TESTS) {
		throw new Error(`Isolated Vitest discovery found ${leaves.isolated.length} files; maximum is ${MAX_ISOLATED_TESTS}.`);
	}

	for (const lane of Object.keys(leaves)) leaves[lane] = frozenSorted(leaves[lane]);
	const leafArrays = Object.values(leaves);
	const allPaths = leafArrays.flat();
	const duplicatePaths = [...new Set(allPaths.filter((path, index) => allPaths.indexOf(path) !== index))].sort();
	if (duplicatePaths.length) {
		throw new Error(`Test discovery assigned multiple lanes to: ${duplicatePaths.join(", ")}`);
	}

	const unit = frozenSorted([...leaves.core, ...leaves.dom, ...leaves.integration, ...leaves.isolated]);
	const vitest = frozenSorted([...unit, ...leaves.vitestE2E]);
	const all = frozenSorted(allPaths);
	const e2eGroups = Object.freeze({
		A: leaves.e2eNode,
		B: leaves.e2ePlaywright,
		C: leaves.browserE2E,
		D: leaves.vitestE2E,
	});

	return Object.freeze({
		core: leaves.core,
		dom: leaves.dom,
		integration: leaves.integration,
		isolated: leaves.isolated,
		vitestE2E: leaves.vitestE2E,
		browser: leaves.browser,
		browserE2E: leaves.browserE2E,
		manual: leaves.manual,
		e2eGroups,
		unit,
		vitest,
		all,
	});
}

/** Validate Git-introduced paths without changing execution discovery. */
export function validateIntroducedTestPaths(paths) {
	const errors = [];
	const uniquePaths = [...new Set([...paths].map(normalizeTestPath))].sort();
	for (const path of uniquePaths) {
		if (!isTestSource(path)) continue;
		try {
			if (classifyTestPath(path)) continue;
			let remedy = "Use tests2/core|dom|integration/**/*.test.ts, top-level tests/*.e2e.test.ts, tests/e2e/**/*.e2e.spec.ts, tests2/browser/**/*.spec.ts, or tests/manual-integration/**/*.{test,spec}.ts.";
			if (/^tests\/e2e\/.+\.spec\.ts$/.test(path)) remedy = "Use the '*.e2e.spec.ts' suffix for tests/e2e Playwright ownership.";
			errors.push(`${path}: ${remedy}`);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (errors.length) throw new Error(`Invalid introduced test paths:\n- ${errors.join("\n- ")}`);
}
