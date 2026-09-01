import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	classifyTestPath as classifyCanonicalTestPath,
	isRunnableTestPath,
	normalizeTestPath,
	validateTestPath,
} from "../testing/layout-policy.mjs";

export { normalizeTestPath };

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");

const OWNERS = Object.freeze({
	core: Object.freeze({ lane: "core", phase: "unit", runner: "vitest", project: "v2-core" }),
	dom: Object.freeze({ lane: "dom", phase: "unit", runner: "vitest", project: "v2-dom" }),
	integration: Object.freeze({ lane: "integration", phase: "unit", runner: "vitest", project: "v2-integration" }),
	isolated: Object.freeze({ lane: "isolated", phase: "unit", runner: "vitest", project: "v2-isolated" }),
	vitestE2E: Object.freeze({ lane: "vitestE2E", phase: "e2e", runner: "vitest", project: "v2-e2e-vitest", e2eGroup: "D" }),
	browser: Object.freeze({ lane: "browser", phase: "browser", runner: "playwright", project: "browser-canonical" }),
	e2eNode: Object.freeze({ lane: "e2eNode", phase: "e2e", runner: "tsx", project: "e2e-node", e2eGroup: "A" }),
	e2eApi: Object.freeze({ lane: "e2eApi", phase: "e2e", runner: "playwright", project: "api-canonical", e2eGroup: "B" }),
	e2eBrowser: Object.freeze({ lane: "e2eBrowser", phase: "e2e", runner: "playwright", project: "browser-canonical", e2eGroup: "C" }),
	manual: Object.freeze({ lane: "manual", phase: "manual", runner: "playwright", project: "manual" }),
});

const CANONICAL_DISCOVERY_LANES = Object.freeze({
	"unit-core": "core",
	"unit-isolated": "isolated",
	dom: "dom",
	"gateway-integration": "integration",
	"browser-fixture": "browser",
	"browser-journey": "browser",
	"node-e2e": "e2eNode",
	"vitest-e2e": "vitestE2E",
	"api-e2e": "e2eApi",
	"browser-e2e": "e2eBrowser",
	manual: "manual",
});

/** Return the sole canonical runner owner for a repository-relative test path. */
export function classifyTestPath(pathValue) {
	const canonical = classifyCanonicalTestPath(normalizeTestPath(pathValue));
	return canonical ? OWNERS[CANONICAL_DISCOVERY_LANES[canonical.semantic]] : null;
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

/** Discover every runnable test from the sole canonical `tests/` conventions. */
export function discoverTests({ repoRoot = REPO_ROOT } = {}) {
	const leaves = {
		core: [],
		dom: [],
		integration: [],
		isolated: [],
		vitestE2E: [],
		browser: [],
		e2eNode: [],
		e2eApi: [],
		e2eBrowser: [],
		manual: [],
	};

	const candidates = collectFiles(repoRoot, "tests");
	const invalid = candidates
		.filter(isRunnableTestPath)
		.flatMap((path) => validateTestPath(path));
	if (invalid.length > 0) {
		throw new Error(`Canonical test discovery rejected invalid runnable paths:\n${invalid
			.map(({ code, path, message }) => `- [${code}] ${path}: ${message}`)
			.join("\n")}`);
	}

	for (const path of candidates) {
		const owner = classifyTestPath(path);
		if (owner) leaves[owner.lane].push(path);
	}

	for (const lane of Object.keys(leaves)) leaves[lane] = frozenSorted(leaves[lane]);
	const allPaths = Object.values(leaves).flat();
	const duplicatePaths = [...new Set(allPaths.filter((path, index) => allPaths.indexOf(path) !== index))].sort();
	if (duplicatePaths.length) {
		throw new Error(`Test discovery assigned multiple lanes to: ${duplicatePaths.join(", ")}`);
	}

	const unit = frozenSorted([...leaves.core, ...leaves.dom, ...leaves.integration, ...leaves.isolated]);
	const vitest = frozenSorted([...unit, ...leaves.vitestE2E]);
	const all = frozenSorted(allPaths);
	const e2eGroups = Object.freeze({
		A: leaves.e2eNode,
		B: leaves.e2eApi,
		C: leaves.e2eBrowser,
		D: leaves.vitestE2E,
	});

	return Object.freeze({
		core: leaves.core,
		dom: leaves.dom,
		integration: leaves.integration,
		isolated: leaves.isolated,
		vitestE2E: leaves.vitestE2E,
		browser: leaves.browser,
		e2eApi: leaves.e2eApi,
		e2eBrowser: leaves.e2eBrowser,
		manual: leaves.manual,
		e2eGroups,
		unit,
		vitest,
		canonical: all,
		all,
	});
}
