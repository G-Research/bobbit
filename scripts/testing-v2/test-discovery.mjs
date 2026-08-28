import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	TEST_LAYOUT,
	classifyTestPath as classifyCanonicalTestPath,
	classifyTransitionalTestPath,
	normalizeTestPath,
} from "../testing/layout-policy.mjs";

export { normalizeTestPath };

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");
const MAX_ISOLATED_TESTS = 14;

const TEST_SOURCE_PATTERN = /\.(?:test|spec)\.ts$/;

const OWNERS = Object.freeze({
	core: Object.freeze({ lane: "core", phase: "unit", runner: "vitest", project: "v2-core" }),
	dom: Object.freeze({ lane: "dom", phase: "unit", runner: "vitest", project: "v2-dom" }),
	integration: Object.freeze({ lane: "integration", phase: "unit", runner: "vitest", project: "v2-integration" }),
	isolated: Object.freeze({ lane: "isolated", phase: "unit", runner: "vitest", project: "v2-isolated" }),
	vitestE2E: Object.freeze({ lane: "vitestE2E", phase: "e2e", runner: "vitest", project: "v2-e2e-vitest", e2eGroup: "D" }),
	browser: Object.freeze({ lane: "browser", phase: "browser", runner: "playwright", project: "browser-v2" }),
	browserCanonical: Object.freeze({ lane: "browser", phase: "browser", runner: "playwright", project: "browser-canonical" }),
	browserE2E: Object.freeze({ lane: "browserE2E", phase: "e2e", runner: "playwright", project: "browser-v2-e2e", e2eGroup: "C" }),
	e2eNode: Object.freeze({ lane: "e2eNode", phase: "e2e", runner: "tsx", project: "e2e-node", e2eGroup: "A" }),
	e2ePlaywright: Object.freeze({ lane: "e2ePlaywright", phase: "e2e", runner: "playwright", project: "e2e-playwright", e2eGroup: "B" }),
	manual: Object.freeze({ lane: "manual", phase: "manual", runner: "playwright", project: "manual-integration" }),
	manualCanonical: Object.freeze({ lane: "manual", phase: "manual", runner: "playwright", project: "manual" }),
	e2eApi: Object.freeze({ lane: "e2eApi", phase: "e2e", runner: "playwright", project: "api-canonical", e2eGroup: "B" }),
	e2eBrowser: Object.freeze({ lane: "e2eBrowser", phase: "e2e", runner: "playwright", project: "browser-canonical", e2eGroup: "B" }),
});

const CANONICAL_DISCOVERY_LANES = Object.freeze({
	"unit-core": "core",
	"unit-isolated": "isolated",
	dom: "dom",
	"gateway-integration": "integration",
	"browser-fixture": "browserCanonical",
	"browser-journey": "browserCanonical",
	"node-e2e": "e2eNode",
	"vitest-e2e": "vitestE2E",
	"api-e2e": "e2eApi",
	"browser-e2e": "e2eBrowser",
	manual: "manualCanonical",
});

function isTestSource(path) {
	return TEST_SOURCE_PATTERN.test(path);
}

/** Classify canonical paths first, then the explicitly transitional policy. */
export function classifyTestPath(pathValue) {
	const path = normalizeTestPath(pathValue);
	const canonical = classifyCanonicalTestPath(path);
	if (canonical) return OWNERS[CANONICAL_DISCOVERY_LANES[canonical.semantic]];
	const transitionalLane = classifyTransitionalTestPath(path);
	return transitionalLane ? OWNERS[transitionalLane] : null;
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
		e2eApi: [],
		e2eBrowser: [],
	};

	const canonicalPaths = [];
	const transitionalPaths = [];
	const candidates = [
		...collectFiles(repoRoot, "tests2/core"),
		...collectFiles(repoRoot, "tests2/dom"),
		...collectFiles(repoRoot, "tests2/integration"),
		...collectFiles(repoRoot, "tests2/browser"),
		...collectFiles(repoRoot, "tests"),
	];
	for (const path of candidates) {
		const owner = classifyTestPath(path);
		if (!owner) continue;
		leaves[owner.lane].push(path);
		if (classifyCanonicalTestPath(path)) canonicalPaths.push(path);
		else transitionalPaths.push(path);
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
	const canonical = frozenSorted(canonicalPaths);
	const transitional = frozenSorted(transitionalPaths);
	if (canonical.length + transitional.length !== all.length) {
		throw new Error("Test discovery composition lost canonical or transitional ownership.");
	}
	const e2eGroups = Object.freeze({
		A: leaves.e2eNode,
		B: frozenSorted([...leaves.e2ePlaywright, ...leaves.e2eApi, ...leaves.e2eBrowser]),
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
		e2eApi: leaves.e2eApi,
		e2eBrowser: leaves.e2eBrowser,
		manual: leaves.manual,
		e2eGroups,
		unit,
		vitest,
		canonical,
		transitional,
		all,
	});
}

/** Validate Git-introduced paths against canonical policy without changing discovery. */
export function validateIntroducedTestPaths(paths) {
	const errors = [];
	for (const path of [...new Set([...paths].map(normalizeTestPath))].sort()) {
		if (!isTestSource(path)) continue;
		const canonical = classifyCanonicalTestPath(path);
		if (canonical) continue;
		errors.push(`${path}: create it with npm run test:new -- <semantic> <name>; expected one of ${TEST_LAYOUT.map(({ pattern }) => pattern).join(", ")}.`);
	}
	if (errors.length) throw new Error(`Invalid introduced test paths:\n- ${errors.join("\n- ")}`);
}
