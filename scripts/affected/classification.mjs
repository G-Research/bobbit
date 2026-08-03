// Pure change classification for the affected-test graph. Git collection lives
// in run.mjs; this module accepts normalized strings or rich change records.

import ts from "typescript";

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

const TEST_EXECUTION_MAP_SOURCE = "scripts/testing-v2/test-map-execution.mjs";

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

const EXECUTION_TABLE_NAMES = Object.freeze([
	"APPROVED_E2E_VITEST_PATHS",
	"ISOLATED_VITEST_FILES",
]);

function literalText(node) {
	return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
		? node.text
		: undefined;
}

function isTestPath(value) {
	if (!/^tests2\/(?:core|dom|integration)\/.+\.test\.ts$/.test(value) || value.includes("\\")) return false;
	return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function isExportedConstDeclaration(sourceFile, declaration) {
	const declarationList = declaration.parent;
	const statement = declarationList?.parent;
	return ts.isVariableDeclarationList(declarationList)
		&& (declarationList.flags & ts.NodeFlags.Const) !== 0
		&& declarationList.declarations.length === 1
		&& ts.isVariableStatement(statement)
		&& statement.parent === sourceFile
		&& statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
		&& statement.modifiers.every((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function frozenTableValue(sourceFile, declaration) {
	if (!isExportedConstDeclaration(sourceFile, declaration)) return undefined;
	const initializer = declaration.initializer;
	if (!initializer || !ts.isCallExpression(initializer) || initializer.questionDotToken || initializer.arguments.length !== 1) {
		return undefined;
	}
	const callee = initializer.expression;
	if (!ts.isPropertyAccessExpression(callee)
		|| callee.questionDotToken
		|| !ts.isIdentifier(callee.expression)
		|| callee.expression.text !== "Object"
		|| callee.name.text !== "freeze") {
		return undefined;
	}
	return { initializer, table: initializer.arguments[0] };
}

function approvedPaths(table) {
	if (!ts.isArrayLiteralExpression(table)) return undefined;
	const paths = new Set();
	for (const element of table.elements) {
		const path = literalText(element);
		if (path === undefined || !isTestPath(path) || paths.has(path)) return undefined;
		paths.add(path);
	}
	return paths;
}

function isolatedPaths(table) {
	if (!ts.isObjectLiteralExpression(table)) return undefined;
	const paths = new Set();
	for (const property of table.properties) {
		if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name)) return undefined;
		const path = property.name.text;
		const reason = literalText(property.initializer);
		if (!isTestPath(path) || reason === undefined || paths.has(path)) return undefined;
		paths.add(path);
	}
	return paths;
}

/**
 * Parse and validate the two execution ownership tables without evaluating
 * source. Only their exact, data-only Object.freeze initializers may vary.
 */
function parseExecutionMapTables(source) {
	const normalized = source.replace(/\r\n/g, "\n");
	const sourceFile = ts.createSourceFile(
		TEST_EXECUTION_MAP_SOURCE,
		normalized,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.JS,
	);
	if (sourceFile.parseDiagnostics?.length) return undefined;

	const declarations = new Map(EXECUTION_TABLE_NAMES.map((name) => [name, []]));
	const visit = (node) => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && declarations.has(node.name.text)) {
			declarations.get(node.name.text).push(node);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);

	const initializers = [];
	const paths = new Set();
	for (const name of EXECUTION_TABLE_NAMES) {
		const matches = declarations.get(name);
		if (matches.length !== 1) return undefined;
		const frozen = frozenTableValue(sourceFile, matches[0]);
		if (!frozen) return undefined;
		const tablePaths = name === "APPROVED_E2E_VITEST_PATHS"
			? approvedPaths(frozen.table)
			: isolatedPaths(frozen.table);
		if (!tablePaths) return undefined;
		for (const path of tablePaths) {
			if (paths.has(path)) return undefined;
			paths.add(path);
		}
		initializers.push({
			name,
			start: frozen.initializer.getStart(sourceFile),
			end: frozen.initializer.end,
		});
	}

	let comparableSource = normalized;
	for (const initializer of initializers.sort((a, b) => b.start - a.start)) {
		comparableSource = `${comparableSource.slice(0, initializer.start)}<${initializer.name}-initializer>${comparableSource.slice(initializer.end)}`;
	}
	return { comparableSource, paths };
}

/**
 * Recognize table-only edits to test-map-execution.mjs. Any algorithm edit or
 * unsupported/ambiguous table syntax deliberately fails closed to RUN-ALL.
 */
export function classifyExecutionMapSourceChange(before, after) {
	if (typeof before !== "string" || typeof after !== "string") return { recognized: false, paths: new Set() };
	const oldSource = parseExecutionMapTables(before);
	const newSource = parseExecutionMapTables(after);
	if (!oldSource || !newSource || oldSource.comparableSource !== newSource.comparableSource) {
		return { recognized: false, paths: new Set() };
	}
	return { recognized: true, paths: new Set([...oldSource.paths, ...newSource.paths]) };
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

function broadRunAllReasonForPath(pathValue) {
	const candidate = posix(pathValue);
	const path = candidate.toLowerCase();
	if (ROOT_LOCKFILES.has(path)) return `lockfile change: ${candidate}`;
	if (/^tsconfig(?:\.[^/]+)?\.json$/i.test(candidate)) return `TypeScript config change: ${candidate}`;
	if (/^vitest\.config\.(?:[cm]?[jt]s)$/i.test(candidate)) return `Vitest config change: ${candidate}`;
	if (AFFECTED_EXECUTION_FILES.has(path)) return `affected runner implementation change: ${candidate}`;
	if (GLOBAL_EXECUTION_FILES.has(path)) return `unit runtime implementation change: ${candidate}`;
	return undefined;
}

export function broadRunAllReason(change) {
	for (const path of [change.path, change.oldPath].filter(Boolean)) {
		const reason = broadRunAllReasonForPath(path);
		if (reason) return reason;
	}
	return undefined;
}

function semanticRunAllReason(change) {
	const path = change.path.toLowerCase();
	const packagePath = path === "package.json";
	const packageOldPath = change.oldPath === undefined
		? packagePath
		: change.oldPath.toLowerCase() === "package.json";
	if (packagePath !== packageOldPath) {
		return `root package topology change: ${change.oldPath} -> ${change.path}`;
	}
	if (packagePath) {
		try {
			return packageExecutionChanged(change.before, change.after)
				? `package execution projection changed: ${change.path}`
				: undefined;
		} catch (error) {
			return `package semantic comparison unavailable: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	if (path === TEST_EXECUTION_MAP_SOURCE) {
		return classifyExecutionMapSourceChange(change.before, change.after).recognized
			? undefined
			: `test execution-map algorithm or semantic base changed: ${change.path}`;
	}
	if (path === "tests2/tests-map.json") {
		try {
			changedTestsMapPaths(change.before, change.after);
			return undefined;
		} catch (error) {
			return `tests-map semantic comparison unavailable: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	return undefined;
}

export function isKnownDocumentation(pathValue) {
	const path = posix(pathValue);
	const basename = path.slice(path.lastIndexOf("/") + 1);
	return path.startsWith("docs/")
		|| /^README(?:\.[^/]+)?\.md$/i.test(basename)
		|| /^(?:CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY)\.md$/i.test(basename)
		|| /^(?:LICENSE|NOTICE)(?:\.[^/]+)?$/i.test(basename);
}

function canonicalPath(graph, pathValue) {
	const path = posix(pathValue);
	return graph.meta?.pathIndex?.get(path.toLowerCase()) ?? path;
}

function vitestConfigRunAllReason(graph, change) {
	const closure = new Set((graph.meta?.vitestConfigFiles ?? []).map((path) => posix(path).toLowerCase()));
	for (const pathValue of [change.path, change.oldPath].filter(Boolean)) {
		const candidate = canonicalPath(graph, pathValue);
		const normalized = candidate.toLowerCase();
		// Ownership-table-only edits retain their dedicated semantic classifier.
		if (normalized === TEST_EXECUTION_MAP_SOURCE) continue;
		if (closure.has(normalized)) return `Vitest config dependency change: ${candidate}`;
	}
	return undefined;
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

function graphClaimsPath(graph, pathValue) {
	if (addMappedTests(graph, pathValue, new Set(), new Set())) return true;
	const path = canonicalPath(graph, pathValue);
	return Boolean(graph.meta?.e2eFiles?.has(path) || graph.meta?.legacyTestFiles?.has(path));
}

/** True only when every rename side is known, unclaimed documentation. */
export function isDocumentationOnly(graph, changed) {
	const changes = [...changed].map(normalizeChange);
	return changes.length > 0 && changes.every((change) =>
		[change.oldPath, change.path].filter(Boolean).every((path) =>
			isKnownDocumentation(path) && !graphClaimsPath(graph, path),
		),
	);
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

	// Determine known suite-wide invalidators before mapping any individual input.
	// Git orders changes by path, so returning from the mapping loop would let an
	// earlier unknown file hide the actionable lock/config/semantic reason.
	for (const change of changes) {
		if (!change.path || change.path === "." || change.path.startsWith("../") || change.path.includes("/../")) {
			return allUnitPlan(graph, [`invalid changed path: ${change.path || "(empty)"}`], [change.path]);
		}
	}
	for (const change of changes) {
		const broadReason = broadRunAllReason(change);
		if (broadReason) return allUnitPlan(graph, [broadReason]);
	}
	for (const change of changes) {
		const configReason = vitestConfigRunAllReason(graph, change);
		if (configReason) return allUnitPlan(graph, [configReason]);
	}
	for (const change of changes) {
		const semanticReason = semanticRunAllReason(change);
		if (semanticReason) return allUnitPlan(graph, [semanticReason]);
	}

	for (const change of changes) {
		if (change.path.toLowerCase() === "package.json") {
			sawNonDocumentation = true;
			addMappedTests(graph, change.path, affected, browserAffected);
			reasons.push(`package metadata/scripts change: ${change.path}`);
			continue;
		}

		if (change.path.toLowerCase() === TEST_EXECUTION_MAP_SOURCE) {
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
		const documentationChange = isDocumentationOnly(graph, [change]);
		const oldPathIsDocumentation = change.oldPath
			? isDocumentationOnly(graph, [{ path: change.oldPath, status: "D" }])
			: false;
		if (/^R/.test(change.status) && change.oldPath && !mappedOld && !oldPathIsDocumentation) {
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

		// Shipped prompt/skill/config/pack markdown is graph-owned and was checked
		// above. Only unclaimed documentation may safely skip the unit suite.
		if (documentationChange) {
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
