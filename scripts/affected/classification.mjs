// Pure change classification for the affected-test graph. Git collection lives
// in run.mjs; this module accepts normalized strings or rich change records.

const posix = (value) => String(value ?? "")
	.replace(/\\/g, "/")
	.replace(/^\.\//, "")
	.replace(/\/+/g, "/");

export const PACKAGE_EXECUTION_KEYS = Object.freeze([
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
	"peerDependenciesMeta",
	"overrides",
	"resolutions",
	"workspaces",
	"packageManager",
	"type",
	"imports",
	"exports",
	"engines",
	"os",
	"cpu",
	"libc",
]);

export const TEST_MAP_CONTRACT_TESTS = Object.freeze([
	"tests2/core/test-map-execution.test.ts",
	"tests2/core/guard-v2.test.ts",
	"tests2/core/unit-lanes-scheduling.test.ts",
]);

const ROOT_LOCKFILES = new Set([
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lock",
	"bun.lockb",
]);

const GLOBAL_EXECUTION_FILES = new Set([
	"scripts/testing-v2/server-prebundle.mjs",
	"scripts/testing-v2/repo-source-closure.mjs",
	"scripts/testing-v2/server-runtime.mjs",
]);

const AFFECTED_EXECUTION_FILES = new Set([
	"scripts/affected/graph.mjs",
	"scripts/affected/impact-rules.mjs",
	"scripts/affected/classification.mjs",
	"scripts/affected/cache.mjs",
	"scripts/affected/run.mjs",
]);

function stable(value) {
	if (Array.isArray(value)) return value.map(stable);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function parseJsonInput(input, label) {
	if (input === undefined || input === null) throw new Error(`${label} is unavailable`);
	if (typeof input === "string" || Buffer.isBuffer(input)) {
		try {
			return JSON.parse(String(input));
		} catch (error) {
			throw new Error(`${label} is malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (typeof input === "object" && !Array.isArray(input)) return input;
	throw new Error(`${label} must be a JSON object`);
}

function objectValue(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validatePackageExecutionValue(key, value) {
	const objectKeys = new Set([
		"dependencies", "devDependencies", "optionalDependencies", "peerDependencies",
		"peerDependenciesMeta", "overrides", "resolutions", "imports", "engines",
	]);
	if (objectKeys.has(key) && !objectValue(value)) throw new Error(`package.json ${key} must be an object`);
	if ((key === "type" || key === "packageManager") && typeof value !== "string") {
		throw new Error(`package.json ${key} must be a string`);
	}
	if (key === "workspaces" && !Array.isArray(value) && !objectValue(value)) {
		throw new Error("package.json workspaces must be an array or object");
	}
	if (key === "exports" && value !== null && typeof value !== "string" && !Array.isArray(value) && !objectValue(value)) {
		throw new Error("package.json exports has an invalid shape");
	}
	if (["os", "cpu", "libc"].includes(key) && typeof value !== "string" && !Array.isArray(value)) {
		throw new Error(`package.json ${key} must be a string or array`);
	}
}

/** Stable projection of package fields that can alter unit-test execution. */
export function packageExecutionProjection(input) {
	const manifest = parseJsonInput(input, "package.json content");
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
		throw new Error("package.json content must be an object");
	}
	const projection = {};
	for (const key of PACKAGE_EXECUTION_KEYS) {
		if (!Object.hasOwn(manifest, key)) continue;
		validatePackageExecutionValue(key, manifest[key]);
		projection[key] = stable(manifest[key]);
	}
	return projection;
}

export function packageExecutionChanged(before, after) {
	return JSON.stringify(packageExecutionProjection(before)) !== JSON.stringify(packageExecutionProjection(after));
}

export function normalizeChange(change) {
	if (typeof change === "string") return { path: posix(change), status: "M" };
	if (!change || typeof change !== "object" || typeof change.path !== "string") {
		throw new TypeError("affected change must be a repo-relative path or { path, ... } record");
	}
	return {
		...change,
		path: posix(change.path),
		...(change.oldPath ? { oldPath: posix(change.oldPath) } : {}),
		status: String(change.status ?? "M").toUpperCase(),
	};
}

function findDelimitedBlock(source, name, open) {
	const declaration = source.indexOf(name);
	if (declaration < 0) return undefined;
	const equals = source.indexOf("=", declaration + name.length);
	if (equals < 0) return undefined;
	const start = source.indexOf(open, equals + 1);
	if (start < 0) return undefined;
	const close = open === "[" ? "]" : "}";
	let depth = 0;
	let quote = "";
	let escaped = false;
	for (let index = start; index < source.length; index += 1) {
		const char = source[index];
		if (quote) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === quote) quote = "";
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			continue;
		}
		if (char === open) depth += 1;
		else if (char === close && --depth === 0) return { start, end: index + 1, text: source.slice(start, index + 1) };
	}
	return undefined;
}

function replaceBlocks(source, blocks) {
	let result = source.replace(/\r\n/g, "\n");
	const found = [];
	for (const [name, open] of blocks) {
		const block = findDelimitedBlock(result, name, open);
		if (!block) return undefined;
		found.push({ ...block, name });
	}
	for (const block of found.sort((a, b) => b.start - a.start)) {
		result = `${result.slice(0, block.start)}<${block.name}-table>${result.slice(block.end)}`;
	}
	return { source: result, blocks: found };
}

function testPathsInText(value) {
	return new Set([...String(value).matchAll(/["'`](tests2\/(?:core|dom|integration)\/[^"'`]+\.test\.ts)["'`]/g)]
		.map((match) => posix(match[1])));
}

/**
 * Recognize table-only edits to test-map-execution.mjs. Any algorithm edit is
 * deliberately not classified and therefore fails closed to RUN-ALL.
 */
export function classifyExecutionMapSourceChange(before, after) {
	if (typeof before !== "string" || typeof after !== "string") return { recognized: false, paths: new Set() };
	const blocks = [
		["APPROVED_E2E_VITEST_PATHS", "["],
		["ISOLATED_VITEST_FILES", "{"],
	];
	const oldSource = replaceBlocks(before, blocks);
	const newSource = replaceBlocks(after, blocks);
	if (!oldSource || !newSource || oldSource.source !== newSource.source) return { recognized: false, paths: new Set() };
	const paths = new Set();
	for (const block of [...oldSource.blocks, ...newSource.blocks]) {
		for (const path of testPathsInText(block.text)) paths.add(path);
	}
	return { recognized: true, paths };
}

function materializedMapRecords(input) {
	const map = parseJsonInput(input, "tests2/tests-map.json content");
	if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error("tests2/tests-map.json content must be an object");
	const records = new Map();
	for (const item of map.v2Native ?? []) {
		if (typeof item?.path !== "string") continue;
		records.set(posix(item.path), stable({ execution: item.execution, reason: item.reason }));
	}
	for (const item of map.entries ?? []) {
		if (typeof item?.v2Path !== "string") continue;
		records.set(posix(item.v2Path), stable({ execution: item.execution, file: item.file, v2Path: item.v2Path }));
	}
	return records;
}

/** Return old/new materialized paths whose ownership record changed. */
export function changedTestsMapPaths(before, after) {
	const oldRecords = materializedMapRecords(before);
	const newRecords = materializedMapRecords(after);
	const changed = new Set();
	for (const path of new Set([...oldRecords.keys(), ...newRecords.keys()])) {
		if (JSON.stringify(oldRecords.get(path)) !== JSON.stringify(newRecords.get(path))) changed.add(path);
	}
	return changed;
}

export function broadRunAllReason(change) {
	const path = change.path.toLowerCase();
	if (ROOT_LOCKFILES.has(path)) return `lockfile change: ${change.path}`;
	if (/^tsconfig(?:\.[^/]+)?\.json$/i.test(change.path)) return `TypeScript config change: ${change.path}`;
	if (/^vitest\.config\.(?:[cm]?[jt]s)$/i.test(change.path)) return `Vitest config change: ${change.path}`;
	if (AFFECTED_EXECUTION_FILES.has(path)) return `affected runner implementation change: ${change.path}`;
	if (GLOBAL_EXECUTION_FILES.has(path)) return `unit runtime implementation change: ${change.path}`;
	return undefined;
}

export function isKnownDocumentation(pathValue) {
	const path = posix(pathValue);
	return path.startsWith("docs/")
		|| /^README(?:\.[^/]+)?\.md$/i.test(path)
		|| /^(?:CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY)\.md$/i.test(path)
		|| /^(?:LICENSE|NOTICE)(?:\.[^/]+)?$/i.test(path);
}

function canonicalPath(graph, pathValue) {
	const path = posix(pathValue);
	return graph.meta?.pathIndex?.get(path.toLowerCase()) ?? path;
}

function addMappedTests(graph, pathValue, affected, browserAffected) {
	const path = canonicalPath(graph, pathValue);
	let mapped = false;
	if (graph.testDeps.has(path)) {
		affected.add(path);
		mapped = true;
	}
	if (graph.browserDeps?.has(path)) {
		browserAffected.add(path);
		mapped = true;
	}
	for (const test of graph.srcToTests.get(path) ?? []) {
		affected.add(test);
		mapped = true;
	}
	for (const test of graph.srcToBrowser?.get(path) ?? []) {
		browserAffected.add(test);
		mapped = true;
	}
	return mapped;
}

function allUnitPlan(graph, reasons, unmapped = []) {
	const affected = new Set(graph.testFiles);
	return {
		kind: "run-all",
		cachePolicy: "bypass",
		affected,
		browserAffected: new Set(),
		reasons,
		unmapped,
		runAll: true,
		reason: reasons[0],
	};
}

/**
 * Map normalized changes onto an auditable tri-state selection plan. Unknown
 * executable/infrastructure inputs and unresolved deletes fail closed.
 */
export function classifyAffectedTests(graph, changed) {
	const changes = [...changed].map(normalizeChange);
	const affected = new Set();
	const browserAffected = new Set();
	const reasons = [];
	const unmapped = [];
	let sawNonDocumentation = false;

	for (const change of changes) {
		if (!change.path || change.path === "." || change.path.startsWith("../") || change.path.includes("/../")) {
			return allUnitPlan(graph, [`invalid changed path: ${change.path || "(empty)"}`], [change.path]);
		}

		const broadReason = broadRunAllReason(change);
		if (broadReason) return allUnitPlan(graph, [broadReason]);

		if (change.path.toLowerCase() === "package.json") {
			sawNonDocumentation = true;
			try {
				if (packageExecutionChanged(change.before, change.after)) {
					return allUnitPlan(graph, [`package execution projection changed: ${change.path}`]);
				}
			} catch (error) {
				return allUnitPlan(graph, [`package semantic comparison unavailable: ${error instanceof Error ? error.message : String(error)}`]);
			}
			addMappedTests(graph, change.path, affected, browserAffected);
			reasons.push(`package metadata/scripts change: ${change.path}`);
			continue;
		}

		if (change.path.toLowerCase() === "scripts/testing-v2/test-map-execution.mjs") {
			sawNonDocumentation = true;
			const classified = classifyExecutionMapSourceChange(change.before, change.after);
			if (!classified.recognized) return allUnitPlan(graph, [`test execution-map algorithm or semantic base changed: ${change.path}`]);
			for (const path of classified.paths) addMappedTests(graph, path, affected, browserAffected);
			for (const test of TEST_MAP_CONTRACT_TESTS) if (graph.testDeps.has(test)) affected.add(test);
			reasons.push(`test execution ownership table change: ${change.path}`);
			continue;
		}

		if (change.path.toLowerCase() === "tests2/tests-map.json") {
			sawNonDocumentation = true;
			let paths;
			try {
				paths = changedTestsMapPaths(change.before, change.after);
			} catch (error) {
				return allUnitPlan(graph, [`tests-map semantic comparison unavailable: ${error instanceof Error ? error.message : String(error)}`]);
			}
			for (const path of paths) addMappedTests(graph, path, affected, browserAffected);
			for (const test of TEST_MAP_CONTRACT_TESTS) if (graph.testDeps.has(test)) affected.add(test);
			reasons.push(`tests-map ownership change: ${change.path}`);
			continue;
		}

		const mappedNew = addMappedTests(graph, change.path, affected, browserAffected);
		let mappedOld = true;
		if (change.oldPath) mappedOld = addMappedTests(graph, change.oldPath, affected, browserAffected);
		const deleted = /^D/.test(change.status) || /^R/.test(change.status);
		if (/^R/.test(change.status) && change.oldPath && !mappedOld) {
			return allUnitPlan(graph, [`unresolved renamed dependency: ${change.oldPath}`], [change.oldPath]);
		}
		if (mappedNew || (change.oldPath && mappedOld)) {
			sawNonDocumentation = true;
			reasons.push(`dependency change: ${change.path}`);
			continue;
		}

		if (graph.meta?.e2eFiles?.has(canonicalPath(graph, change.path))) {
			sawNonDocumentation = true;
			reasons.push(`E2E-owned test change (outside unit execution): ${change.path}`);
			continue;
		}
		// Legacy tests are not part of the authoritative Vitest inventory. Any
		// unit/browser consumer import was already claimed by the graph above; an
		// otherwise standalone legacy test cannot alter the unit execution plan.
		if (graph.meta?.legacyTestFiles?.has(canonicalPath(graph, change.path))) {
			sawNonDocumentation = true;
			reasons.push(`legacy test change (outside unit execution): ${change.path}`);
			continue;
		}

		// Shipped prompt/skill/config markdown is graph-owned and was checked
		// above. Only unclaimed documentation may safely skip the unit suite.
		if (isKnownDocumentation(change.path) && (!change.oldPath || isKnownDocumentation(change.oldPath))) {
			reasons.push(`documentation-only change: ${change.path}`);
			continue;
		}

		unmapped.push(change.oldPath && !mappedOld ? change.oldPath : change.path);
		return allUnitPlan(graph, [deleted
			? `unresolved deleted dependency: ${change.oldPath ?? change.path}`
			: `unknown executable/infrastructure input: ${change.path}`], unmapped);
	}

	const kind = sawNonDocumentation || affected.size > 0 || browserAffected.size > 0 ? "bounded" : "skip-all";
	if (changes.length === 0) reasons.push("no changes");
	return {
		kind,
		cachePolicy: "eligible",
		affected,
		browserAffected,
		reasons,
		unmapped,
		runAll: false,
		reason: reasons[0],
	};
}
