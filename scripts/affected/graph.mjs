// Sound affected-test dependency graph.
//
// The authoritative runnable inventory comes from tests2/tests-map.json via
// loadVitestExecutionMap(). Static repo imports, Vitest-owned setup boundaries,
// the real server runtime closure, and declared filesystem inputs all become one
// ordinary dependency graph. That same testDeps graph drives selection and cache
// hashing; there is no separate invalidation map.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, isAbsolute, join, resolve, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { loadVitestExecutionMap } from "../testing-v2/test-map-execution.mjs";
import { serverRuntimeRepoSourceFiles } from "../testing-v2/repo-source-closure.mjs";
import {
	IMPACT_RULES,
	INDIRECT_REPOSITORY_READ_RULES,
	REPOSITORY_SCAN_RULES,
	impactRulesForPath,
	inventoryRepositoryScanInputs,
	inventoryShippedInputs,
	repositoryScanRulesForPath,
	validateImpactInventory,
	validateIndirectRepositoryReadRegistry,
	validateRepositoryScanInventory,
	validateUnresolvedRepositoryReadAudit,
} from "./impact-rules.mjs";
import { classifyAffectedTests, TEST_MAP_CONTRACT_TESTS } from "./classification.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");

export const GATEWAY_HARNESS = "tests2/harness/gateway.ts";
export const DOM_ENV = "tests2/harness/v2-dom-environment.ts";
export const TIER1_SETUP = "tests2/harness/tier1-spawn-guard.ts";
export const FILE_BOUNDARY_RUNNER = "tests2/harness/file-boundary-runner.ts";

const EXECUTABLE_RE = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/i;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx", ".json"];
const IMPORT_RE = /(?:\b(?:import|export)\s+(?!type\b)(?:[^"'`;]*?\s+from\s*)?|\brequire\s*\(|\bimport\s*\()\s*(["'`])([^"'`]+)\1/gms;
// Browser fixtures name their esbuild entry files through path.resolve() rather
// than imports. Treat those repo-relative literals as ordinary graph edges.
const TEST_RESOURCE_RE = /(["'`])(tests\/(?:fixtures|ui-fixtures)\/[^"'`]+)\1/gms;
// Run-isolation contracts iterate root Playwright config names from a literal
// array before passing the variable to readFileSync(). Preserve those computed
// literal reads without pretending to resolve arbitrary data flow.
const ROOT_TEST_CONFIG_RE = /(["'`])(playwright[^/"'`]*\.config\.[cm]?[jt]s)\1/gms;

const posix = (value) => String(value).replace(/\\/g, "/").replace(/^\.\//, "");

function repoPath(repoRoot, absolute) {
	const path = relative(repoRoot, absolute);
	if (path.startsWith("..") || isAbsolute(path)) return undefined;
	return posix(path);
}

function walk(dir, predicate, out = []) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (entry.name === "node_modules" || entry.name === ".git") continue;
		const absolute = join(dir, entry.name);
		if (entry.isDirectory()) walk(absolute, predicate, out);
		else if (predicate(entry.name, absolute)) out.push(absolute);
	}
	return out;
}

function resolveRepoLiteral(repoRoot, value) {
	const path = posix(value);
	if (!path || isAbsolute(value) || path === ".." || path.startsWith("../") || path.includes("/../")) return undefined;
	const absolute = resolve(repoRoot, path);
	const relativePath = repoPath(repoRoot, absolute);
	if (!relativePath) return undefined;
	try {
		return statSync(absolute).isFile() ? relativePath : undefined;
	} catch (error) {
		if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
		return undefined;
	}
}

const isAbsoluteLike = (value) => isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
const stringValue = (value) => ({ kind: "string", value });
const pathValue = (value) => ({ kind: "path", value });

function importBindings(sourceFile) {
	const bindings = {
		readFunctions: new Set(),
		fsNamespaces: new Set(),
		pathFunctions: new Map(),
		pathNamespaces: new Set(),
		urlFunctions: new Map(),
	};
	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		const module = statement.moduleSpecifier.text.replace(/^node:/, "");
		const clause = statement.importClause;
		if (!clause) continue;
		if (clause.name) {
			if (module === "fs" || module === "fs/promises") bindings.fsNamespaces.add(clause.name.text);
			if (module === "path") bindings.pathNamespaces.add(clause.name.text);
		}
		const named = clause.namedBindings;
		if (!named) continue;
		if (ts.isNamespaceImport(named)) {
			if (module === "fs" || module === "fs/promises") bindings.fsNamespaces.add(named.name.text);
			if (module === "path") bindings.pathNamespaces.add(named.name.text);
			continue;
		}
		for (const element of named.elements) {
			const imported = (element.propertyName ?? element.name).text;
			const local = element.name.text;
			if ((module === "fs" || module === "fs/promises") && (imported === "readFile" || imported === "readFileSync")) {
				bindings.readFunctions.add(local);
			}
			if (module === "path" && ["resolve", "join", "dirname"].includes(imported)) {
				bindings.pathFunctions.set(local, imported);
			}
			if (module === "url" && imported === "fileURLToPath") bindings.urlFunctions.set(local, imported);
		}
	}
	return bindings;
}

function staticVariableInitializers(sourceFile) {
	const initializers = new Map();
	const duplicates = new Set();
	const visit = (node) => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
			const name = node.name.text;
			if (initializers.has(name)) duplicates.add(name);
			else initializers.set(name, node.initializer);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	for (const duplicate of duplicates) initializers.delete(duplicate);
	return initializers;
}

function isImportMeta(node) {
	return ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword;
}

function readCall(node, bindings) {
	if (!ts.isCallExpression(node)) return false;
	const callee = node.expression;
	if (ts.isIdentifier(callee)) return bindings.readFunctions.has(callee.text);
	if (!ts.isPropertyAccessExpression(callee) || !["readFile", "readFileSync"].includes(callee.name.text)) return false;
	const owner = callee.expression;
	if (ts.isIdentifier(owner)) return bindings.fsNamespaces.has(owner.text);
	return ts.isPropertyAccessExpression(owner)
		&& owner.name.text === "promises"
		&& ts.isIdentifier(owner.expression)
		&& bindings.fsNamespaces.has(owner.expression.text);
}

function pathFunctionName(callee, bindings) {
	if (ts.isIdentifier(callee)) return bindings.pathFunctions.get(callee.text);
	if (ts.isPropertyAccessExpression(callee)
		&& ts.isIdentifier(callee.expression)
		&& bindings.pathNamespaces.has(callee.expression.text)) {
		return callee.name.text;
	}
	return undefined;
}

function unwrapExpression(node) {
	let current = node;
	while (ts.isParenthesizedExpression(current)
		|| ts.isAsExpression(current)
		|| ts.isTypeAssertionExpression(current)
		|| ts.isNonNullExpression(current)
		|| (typeof ts.isSatisfiesExpression === "function" && ts.isSatisfiesExpression(current))) {
		current = current.expression;
	}
	return current;
}

function staticPathEvaluator({ repoRoot, importer, sourceFile, bindings }) {
	const initializers = staticVariableInitializers(sourceFile);
	const memo = new Map();
	const resolving = new Set();

	const evaluate = (rawNode) => {
		const node = unwrapExpression(rawNode);
		if (ts.isStringLiteralLike(node)) return stringValue(node.text);
		if (ts.isIdentifier(node)) {
			if (memo.has(node.text)) return memo.get(node.text);
			const initializer = initializers.get(node.text);
			if (!initializer || resolving.has(node.text)) return undefined;
			resolving.add(node.text);
			const value = evaluate(initializer);
			resolving.delete(node.text);
			memo.set(node.text, value);
			return value;
		}
		if (ts.isPropertyAccessExpression(node) && isImportMeta(node.expression)) {
			if (node.name.text === "url") return pathValue(importer);
			if (node.name.text === "dirname") return pathValue(dirname(importer));
		}
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
			return evaluate(node.left) ?? evaluate(node.right);
		}
		if (ts.isNewExpression(node)
			&& ts.isIdentifier(node.expression)
			&& node.expression.text === "URL"
			&& node.arguments?.length === 2) {
			const relativeUrl = evaluate(node.arguments[0]);
			const base = evaluate(node.arguments[1]);
			if (relativeUrl?.kind !== "string" || base?.kind !== "path") return undefined;
			try {
				return pathValue(fileURLToPath(new URL(relativeUrl.value, pathToFileURL(base.value))));
			} catch {
				return undefined;
			}
		}
		if (!ts.isCallExpression(node)) return undefined;
		if (ts.isPropertyAccessExpression(node.expression)
			&& ts.isIdentifier(node.expression.expression)
			&& node.expression.expression.text === "process"
			&& node.expression.name.text === "cwd"
			&& node.arguments.length === 0) {
			return pathValue(repoRoot);
		}
		const urlFunction = ts.isIdentifier(node.expression)
			? bindings.urlFunctions.get(node.expression.text)
			: undefined;
		if (urlFunction === "fileURLToPath" && node.arguments.length === 1) {
			const value = evaluate(node.arguments[0]);
			return value?.kind === "path" ? value : undefined;
		}
		const functionName = pathFunctionName(node.expression, bindings);
		if (!functionName) return undefined;
		const values = node.arguments.map(evaluate);
		if (values.some((value) => !value)) return undefined;
		const parts = values.map((value) => value.value);
		// A Windows absolute literal cannot be safely interpreted by POSIX path
		// semantics (and vice versa). Relative backslashes remain portable.
		if (parts.some((part, index) => values[index].kind === "string" && isAbsoluteLike(part) && !isAbsolute(part))) {
			return undefined;
		}
		const normalized = parts.map((part, index) => values[index].kind === "string" ? posix(part) : part);
		if (functionName === "dirname" && normalized.length === 1) {
			const base = values[0].kind === "path" ? normalized[0] : resolve(repoRoot, normalized[0]);
			return pathValue(dirname(base));
		}
		if (functionName === "resolve") return pathValue(resolve(repoRoot, ...normalized));
		if (functionName === "join") {
			return pathValue(values[0]?.kind === "path"
				? join(...normalized)
				: join(repoRoot, ...normalized));
		}
		return undefined;
	};
	return evaluate;
}

/**
 * Extract safe, statically provable repository reads from one executable file.
 * Resolved reads become ordinary graph edges; unsupported variables and paths
 * outside the repository remain visible in the returned inventory but are never
 * guessed or treated as repository dependencies.
 */
export function extractRepositoryReadDependencies({ repoRoot: rootValue, importerPath, source }) {
	if (!/\breadFile(?:Sync)?\b/.test(source)) return { dependencies: new Set(), reads: [] };
	const repoRoot = resolve(rootValue);
	const importer = isAbsolute(importerPath)
		? resolve(importerPath)
		: resolve(repoRoot, ...posix(importerPath).split("/"));
	const sourceFile = ts.createSourceFile(importer, source, ts.ScriptTarget.Latest, true);
	const bindings = importBindings(sourceFile);
	const evaluate = staticPathEvaluator({ repoRoot, importer, sourceFile, bindings });
	const dependencies = new Set();
	const reads = [];
	const visit = (node) => {
		if (readCall(node, bindings)) {
			const expression = node.arguments[0]?.getText(sourceFile) ?? "(missing)";
			const value = node.arguments[0] ? evaluate(node.arguments[0]) : undefined;
			if (!value) {
				reads.push({ expression, status: "unresolved" });
			} else {
				const absolute = value.kind === "path"
					? resolve(value.value)
					: isAbsoluteLike(value.value)
						? undefined
						: resolve(repoRoot, posix(value.value));
				const dependency = absolute ? repoPath(repoRoot, absolute) : undefined;
				if (!absolute || !dependency) {
					reads.push({ expression, status: "outside-repository" });
				} else {
					try {
						if (statSync(absolute).isFile()) {
							dependencies.add(dependency);
							reads.push({ expression, status: "resolved", dependency });
						} else {
							reads.push({ expression, status: "not-file" });
						}
					} catch (error) {
						if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
						reads.push({ expression, status: "missing" });
					}
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return { dependencies, reads };
}

function resolveSpec(repoRoot, importer, specifier) {
	const spec = specifier.replace(/[?#].*$/, "");
	if (!spec.startsWith(".") && !spec.startsWith("/")) return undefined;
	const unresolved = spec.startsWith("/") ? resolve(repoRoot, `.${spec}`) : resolve(dirname(importer), spec);
	const extension = extname(unresolved).toLowerCase();
	const candidates = [];
	if (extension) {
		const stem = unresolved.slice(0, -extension.length);
		if (extension === ".js" || extension === ".jsx") candidates.push(`${stem}.ts`, `${stem}.tsx`);
		else if (extension === ".mjs") candidates.push(`${stem}.mts`);
		else if (extension === ".cjs") candidates.push(`${stem}.cts`);
		candidates.push(unresolved);
	} else {
		candidates.push(unresolved);
		for (const candidateExtension of SOURCE_EXTENSIONS) candidates.push(`${unresolved}${candidateExtension}`);
		for (const candidateExtension of SOURCE_EXTENSIONS) candidates.push(join(unresolved, `index${candidateExtension}`));
	}
	for (const candidate of candidates) {
		if (!repoPath(repoRoot, candidate)) continue;
		try {
			if (statSync(candidate).isFile()) return repoPath(repoRoot, candidate);
		} catch (error) {
			if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
		}
	}
	return undefined;
}

function optionsFrom(value) {
	if (typeof value === "string") return { repoRoot: resolve(value) };
	return { ...(value ?? {}), repoRoot: resolve(value?.repoRoot ?? REPO_ROOT) };
}

function reverseIndex(dependencies) {
	const reverse = new Map();
	for (const [test, deps] of dependencies) {
		for (const dependency of deps) {
			if (!reverse.has(dependency)) reverse.set(dependency, new Set());
			reverse.get(dependency).add(test);
		}
	}
	return reverse;
}

/**
 * Build the complete selection graph.
 *
 * Options are primarily a test seam; callers normally use buildGraph().
 *  - repoRoot: repository root (also accepted as the direct string argument)
 *  - serverRuntimeFiles: optional absolute-path closure injection
 *  - strictImpactInventory: fail construction for missing shipped owners/canaries
 */
export function buildGraph(value) {
	const options = optionsFrom(value);
	const repoRoot = options.repoRoot;
	const testMapPath = join(repoRoot, "tests2", "tests-map.json");
	const execution = loadVitestExecutionMap({
		repoRoot,
		mapPath: testMapPath,
	});
	const testMap = JSON.parse(readFileSync(testMapPath, "utf8"));
	const legacyTestFiles = new Set((testMap.entries ?? [])
		.filter((entry) => typeof entry?.file === "string" && !entry.v2Path)
		.map((entry) => posix(entry.file)));
	const testFiles = [...execution.unit];
	const browserFiles = walk(join(repoRoot, "tests2", "browser"), (name) => name.endsWith(".spec.ts"))
		.map((absolute) => repoPath(repoRoot, absolute))
		.filter(Boolean)
		.sort();

	const executableFiles = [];
	for (const root of ["src", "tests2", "defaults", "scripts", "market-packs"]) {
		executableFiles.push(...walk(join(repoRoot, root), (name) => EXECUTABLE_RE.test(name) && !name.endsWith(".d.ts")));
	}

	// Forward edges: repo file -> repo-local files it imports or dynamically owns.
	const edges = new Map();
	const repositoryReads = new Map();
	const unresolvedRepositoryReads = new Map();
	const pending = executableFiles.map((absolute) => repoPath(repoRoot, absolute)).filter(Boolean);
	const ensureScanned = (path) => {
		if (edges.has(path)) return;
		const absolute = join(repoRoot, ...path.split("/"));
		const dependencies = new Set();
		edges.set(path, dependencies);
		if (!EXECUTABLE_RE.test(path)) return;
		let source;
		try {
			source = readFileSync(absolute, "utf8");
		} catch {
			return;
		}
		IMPORT_RE.lastIndex = 0;
		for (const match of source.matchAll(IMPORT_RE)) {
			const dependency = resolveSpec(repoRoot, absolute, match[2]);
			if (!dependency) continue;
			dependencies.add(dependency);
			if (!edges.has(dependency)) pending.push(dependency);
		}
		const extractedReads = extractRepositoryReadDependencies({ repoRoot, importerPath: path, source });
		if (extractedReads.dependencies.size > 0) repositoryReads.set(path, extractedReads.dependencies);
		const unresolvedReads = extractedReads.reads.filter((read) => read.status === "unresolved");
		if (unresolvedReads.length > 0) unresolvedRepositoryReads.set(path, unresolvedReads);
		for (const dependency of extractedReads.dependencies) {
			dependencies.add(dependency);
			if (!edges.has(dependency)) pending.push(dependency);
		}
		TEST_RESOURCE_RE.lastIndex = 0;
		for (const match of source.matchAll(TEST_RESOURCE_RE)) {
			const dependency = posix(match[2]);
			try {
				if (!statSync(join(repoRoot, ...dependency.split("/"))).isFile()) continue;
			} catch {
				continue;
			}
			dependencies.add(dependency);
			if (!edges.has(dependency)) pending.push(dependency);
		}
		ROOT_TEST_CONFIG_RE.lastIndex = 0;
		for (const match of source.matchAll(ROOT_TEST_CONFIG_RE)) {
			const dependency = resolveRepoLiteral(repoRoot, match[2]);
			if (!dependency) continue;
			dependencies.add(dependency);
			if (!edges.has(dependency)) pending.push(dependency);
		}
	};
	while (pending.length > 0) ensureScanned(pending.pop());

	const addDependency = (consumer, dependency) => {
		ensureScanned(consumer);
		ensureScanned(dependency);
		edges.get(consumer).add(dependency);
	};

	// Vitest owns these dependencies through config, not source imports.
	for (const test of testFiles) addDependency(test, TIER1_SETUP);
	for (const test of [...execution.core, ...execution.integration]) addDependency(test, FILE_BOUNDARY_RUNNER);
	for (const test of execution.dom) addDependency(test, DOM_ENV);

	// Gateway tests depend on the actual runtime-entry repository closure. The
	// shared resolver returns absolute files and is also used by prebundling.
	const absoluteRuntimeFiles = options.serverRuntimeFiles
		?? serverRuntimeRepoSourceFiles(repoRoot);
	const runtimeFiles = [...new Set(absoluteRuntimeFiles
		.map((absolute) => repoPath(repoRoot, absolute))
		.filter(Boolean))].sort();
	for (const runtimeFile of runtimeFiles) addDependency(GATEWAY_HARNESS, runtimeFile);

	// happy-dom eagerly imports the UI entry graph. Keep this existing declared
	// boundary while the domain extraction needed to narrow it remains out of scope.
	const uiFiles = executableFiles
		.map((absolute) => repoPath(repoRoot, absolute))
		.filter((path) => path?.startsWith("src/app/") || path?.startsWith("src/ui/"))
		.sort();
	for (const uiFile of uiFiles) addDependency(DOM_ENV, uiFile);

	// Root shell and public assets participate in the UI runtime without being
	// imported by TypeScript. Model that config-owned boundary and its direct
	// unit canaries so changes remain bounded and enter the same cache hashes.
	const uiRuntimeInputs = [
		"index.html",
		...walk(join(repoRoot, "public"), () => true)
			.map((absolute) => repoPath(repoRoot, absolute))
			.filter(Boolean),
	];
	const uiRuntimeCanaries = [
		"tests2/core/base-path-pwa-cookie-guards.test.ts",
		"tests2/core/ensure-dist-build-key.test.ts",
		"tests2/core/index-html-meta.test.ts",
	];
	for (const input of uiRuntimeInputs) {
		addDependency(DOM_ENV, input);
		for (const test of uiRuntimeCanaries) {
			if (testFiles.includes(test)) addDependency(test, input);
		}
		for (const browser of browserFiles) addDependency(browser, input);
	}

	const impactInputs = inventoryShippedInputs(repoRoot);
	for (const input of impactInputs) {
		for (const rule of impactRulesForPath(input)) {
			for (const owner of rule.owners) addDependency(owner, input);
			for (const canary of rule.canaries) addDependency(canary, input);
		}
	}

	const repositoryScanInputs = inventoryRepositoryScanInputs(repoRoot);
	for (const input of repositoryScanInputs) {
		for (const rule of repositoryScanRulesForPath(input)) {
			for (const consumer of rule.consumers) addDependency(consumer, input);
		}
	}
	const indirectRepositoryReadValidation = validateIndirectRepositoryReadRegistry(
		repoRoot,
		new Set(testFiles),
		INDIRECT_REPOSITORY_READ_RULES,
	);
	for (const { consumer, input } of indirectRepositoryReadValidation.pairs) {
		addDependency(consumer, input);
	}
	// package.json and execution-map tables have semantic classifiers, but their
	// bounded canaries still need the bytes in their verdict hashes.
	for (const rule of IMPACT_RULES.filter((candidate) => candidate.matches("package.json"))) {
		for (const canary of rule.canaries) addDependency(canary, "package.json");
	}
	for (const resource of ["scripts/testing-v2/test-map-execution.mjs", "tests2/tests-map.json"]) {
		for (const canary of TEST_MAP_CONTRACT_TESTS) addDependency(canary, resource);
	}

	const closure = (start) => {
		const seen = new Set();
		const stack = [start];
		while (stack.length > 0) {
			const current = stack.pop();
			for (const dependency of edges.get(current) ?? []) {
				if (seen.has(dependency)) continue;
				seen.add(dependency);
				stack.push(dependency);
			}
		}
		return seen;
	};

	const testDeps = new Map();
	const bootTests = new Set();
	const domTests = new Set(execution.dom);
	for (const test of testFiles) {
		const dependencies = closure(test);
		if (dependencies.has(GATEWAY_HARNESS)) bootTests.add(test);
		dependencies.add(test);
		testDeps.set(test, dependencies);
	}
	const browserDeps = new Map();
	for (const test of browserFiles) {
		const dependencies = closure(test);
		dependencies.add(test);
		browserDeps.set(test, dependencies);
	}

	const srcToTests = reverseIndex(testDeps);
	const srcToBrowser = reverseIndex(browserDeps);
	const allPaths = new Set([
		...edges.keys(),
		...srcToTests.keys(),
		...srcToBrowser.keys(),
		...testFiles,
		...browserFiles,
		...execution.e2e,
	]);
	const pathIndex = new Map([...allPaths].map((path) => [path.toLowerCase(), path]));
	const impactValidation = validateImpactInventory(repoRoot, new Set(testFiles));
	const repositoryScanValidation = validateRepositoryScanInventory(repoRoot, new Set(testFiles));
	const unresolvedReadDeclarations = new Map();
	const declareUnresolvedRead = (consumer, declaration) => {
		if (!unresolvedReadDeclarations.has(consumer)) unresolvedReadDeclarations.set(consumer, new Set());
		unresolvedReadDeclarations.get(consumer).add(declaration);
	};
	for (const rule of IMPACT_RULES) {
		for (const canary of rule.canaries) declareUnresolvedRead(canary, `impact:${rule.id}`);
	}
	for (const rule of REPOSITORY_SCAN_RULES) {
		for (const consumer of rule.consumers) declareUnresolvedRead(consumer, `scan:${rule.id}`);
	}
	for (const rule of INDIRECT_REPOSITORY_READ_RULES) {
		declareUnresolvedRead(rule.consumer, `indirect:${rule.id}`);
	}
	for (const [consumer, dependencies] of repositoryReads) {
		for (const dependency of dependencies) declareUnresolvedRead(consumer, `static:${dependency}`);
	}
	const unresolvedRepositoryReadAudit = validateUnresolvedRepositoryReadAudit(
		unresolvedRepositoryReads,
		new Set(testFiles),
		unresolvedReadDeclarations,
	);
	const inventoryIssues = [
		...impactValidation.issues,
		...repositoryScanValidation.issues,
		...indirectRepositoryReadValidation.issues,
		...unresolvedRepositoryReadAudit.issues,
	];
	if (options.strictImpactInventory !== false && inventoryIssues.length > 0) {
		throw new Error(`Invalid affected-test impact inventory:\n- ${inventoryIssues.join("\n- ")}`);
	}

	return {
		repoRoot,
		testFiles,
		browserFiles,
		testDeps,
		browserDeps,
		srcToTests,
		srcToBrowser,
		meta: {
			// serverFiles is retained for MVP compatibility, but now means the real
			// runtime entry closure rather than every src/server/** file.
			serverFiles: runtimeFiles,
			runtimeFiles,
			uiFiles,
			bootTests,
			domTests,
			allSrc: executableFiles.map((absolute) => repoPath(repoRoot, absolute)).filter((path) => path?.startsWith("src/")),
			e2eFiles: new Set(execution.e2e),
			projects: execution,
			pathIndex,
			impactInputs,
			impactValidation,
			repositoryReads,
			unresolvedRepositoryReads,
			repositoryScanInputs,
			repositoryScanValidation,
			indirectRepositoryReadValidation,
			unresolvedRepositoryReadAudit,
			unresolvedReadDeclarations,
			legacyTestFiles,
		},
	};
}

/** Preserve the public graph.mjs API while returning the tri-state plan. */
export function affectedTests(graph, changed) {
	return classifyAffectedTests(graph, changed);
}
