// Sound affected-test dependency graph.
//
// The authoritative runnable inventory comes from tests2/tests-map.json via
// loadVitestExecutionMap(). Static repo imports, Vitest-owned setup boundaries,
// the real server runtime closure, and declared filesystem inputs all become one
// ordinary dependency graph. That same testDeps graph drives selection and cache
// hashing; there is no separate invalidation map.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, isAbsolute, join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVitestExecutionMap } from "../testing-v2/test-map-execution.mjs";
import { serverRuntimeRepoSourceFiles } from "../testing-v2/repo-source-closure.mjs";
import {
	IMPACT_RULES,
	impactRulesForPath,
	inventoryShippedInputs,
	validateImpactInventory,
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
// Tests sometimes validate repository source/config bytes through cwd-relative
// filesystem reads instead of imports. Literal reads are real cache/selection
// dependencies; computed reads still require an explicit impact rule.
const REPO_LITERAL_READ_RE = /\b(?:readFileSync|readFile)\s*\(\s*(["'`])([^"'`${}]+)\1/gms;
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
		REPO_LITERAL_READ_RE.lastIndex = 0;
		for (const match of source.matchAll(REPO_LITERAL_READ_RE)) {
			const dependency = resolveRepoLiteral(repoRoot, match[2]);
			if (!dependency) continue;
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
	if (options.strictImpactInventory !== false && impactValidation.issues.length > 0) {
		throw new Error(`Invalid affected-test impact inventory:\n- ${impactValidation.issues.join("\n- ")}`);
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
			legacyTestFiles,
		},
	};
}

/** Preserve the public graph.mjs API while returning the tri-state plan. */
export function affectedTests(graph, changed) {
	return classifyAffectedTests(graph, changed);
}
