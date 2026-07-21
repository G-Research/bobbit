// Pins the replacement for the deleted lane scheduler: the unit stage is one
// direct Vitest process with a fixed, environment-lowerable worker cap.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, it, vi } from "vitest";

type ProjectConfig = {
	test: {
		name: string;
		environment: string;
		pool: string;
		isolate: boolean;
		maxWorkers: number;
		retry: number;
		include: string[];
		setupFiles?: string[];
		experimental: {
			fsModuleCache: boolean;
			fsModuleCachePath: string;
		};
	};
};

type LoadedConfig = {
	FIXED_UNIT_WORKERS: number;
	VITEST_MODULE_CACHE_ROOT: string;
	resolveMaxWorkers: (env?: NodeJS.ProcessEnv) => number;
	resolveVitestModuleCachePath: (pid?: number) => string;
	default: { test: { projects: ProjectConfig[] } };
};

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CONFIG_PATH = resolve(REPO_ROOT, "vitest.config.ts");
const HARNESS_ROOT = resolve(REPO_ROOT, "tests2", "harness");
const LEDGER_PATH = resolve(REPO_ROOT, "scripts", "testing-v2", "ledger.mjs");
const packageJson = JSON.parse(
	readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };
const configSource = readFileSync(CONFIG_PATH, "utf8");

function resolveSourceImport(importer: string, specifier: string): string | undefined {
	if (!specifier.startsWith(".")) return undefined;
	const base = resolve(dirname(importer), specifier);
	const extension = extname(base);
	const withoutExtension = extension ? base.slice(0, -extension.length) : base;
	const candidates = [
		...(extension === ".js" ? [`${withoutExtension}.ts`, `${withoutExtension}.tsx`, base] : []),
		...(extension === ".mjs" ? [`${withoutExtension}.mts`, base] : []),
		...(extension === ".cjs" ? [`${withoutExtension}.cts`, base] : []),
		...(!extension ? [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.mjs`, `${base}.js`] : []),
		join(base, "index.ts"),
		join(base, "index.mts"),
		join(base, "index.mjs"),
	];
	return candidates.find((candidate) => {
		try { return existsSync(candidate) && statSync(candidate).isFile(); } catch { return false; }
	});
}

function runtimeImportSpecifiers(file: string): string[] {
	const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
	const specifiers: string[] = [];
	const visit = (node: ts.Node): void => {
		if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
			specifiers.push(node.moduleSpecifier.text);
		} else if (
			ts.isCallExpression(node)
			&& node.expression.kind === ts.SyntaxKind.ImportKeyword
			&& node.arguments.length === 1
			&& ts.isStringLiteral(node.arguments[0])
		) {
			specifiers.push(node.arguments[0].text);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return specifiers;
}

function collectSourceDependencyGraph(roots: string[]): Set<string> {
	const visited = new Set<string>();
	const pending = [...roots];
	while (pending.length) {
		const file = pending.pop()!;
		if (visited.has(file)) continue;
		visited.add(file);
		for (const specifier of runtimeImportSpecifiers(file)) {
			const dependency = resolveSourceImport(file, specifier);
			if (dependency && !visited.has(dependency)) pending.push(dependency);
		}
	}
	return visited;
}
const originalE2eFlag = process.env.BOBBIT_V2_E2E_VITEST;
const originalWorkerFlag = process.env.VITEST_MAX_WORKERS;
let normal: LoadedConfig;
let withNonExactE2eFlag: LoadedConfig;
let withE2e: LoadedConfig;

function restoreEnvironment(): void {
	if (originalE2eFlag === undefined) delete process.env.BOBBIT_V2_E2E_VITEST;
	else process.env.BOBBIT_V2_E2E_VITEST = originalE2eFlag;
	if (originalWorkerFlag === undefined) delete process.env.VITEST_MAX_WORKERS;
	else process.env.VITEST_MAX_WORKERS = originalWorkerFlag;
}

async function loadConfig(e2eFlag?: string): Promise<LoadedConfig> {
	if (e2eFlag === undefined) delete process.env.BOBBIT_V2_E2E_VITEST;
	else process.env.BOBBIT_V2_E2E_VITEST = e2eFlag;
	delete process.env.VITEST_MAX_WORKERS;
	vi.resetModules();
	return await import("../../vitest.config.ts") as LoadedConfig;
}

beforeAll(async () => {
	try {
		normal = await loadConfig();
		withNonExactE2eFlag = await loadConfig("true");
		withE2e = await loadConfig("1");
	} finally {
		restoreEnvironment();
		vi.resetModules();
	}
});

afterAll(restoreEnvironment);

function projects(config: LoadedConfig): ProjectConfig["test"][] {
	return config.default.test.projects.map((project) => project.test);
}

describe("direct unit-stage scheduling", () => {
	it("runs test:unit as one direct Vitest command with no lane or ledger import", () => {
		assert.equal(
			packageJson.scripts["test:unit"],
			"vitest run --config vitest.config.ts --silent=passed-only",
		);
		assert.doesNotMatch(packageJson.scripts["test:unit"], /run-unit-lanes|ledger/i);

		const configImports = [...configSource.matchAll(/from\s+["']([^"']+)["']/g)]
			.map((match) => match[1]);
		assert.ok(configImports.length > 0, "the config import boundary must be inspectable");
		assert.deepEqual(
			configImports.filter((specifier) => /run-unit-lanes|ledger/i.test(specifier)),
			[],
			"the direct unit config must not import deleted lane or ledger orchestration",
		);
	});

	it("keeps the unit config and harness dependency graph free of ledger boot leases", () => {
		const harnessRoots = readdirSync(HARNESS_ROOT, { withFileTypes: true })
			.filter((entry) => entry.isFile() && /\.(?:ts|mts|mjs)$/.test(entry.name))
			.map((entry) => join(HARNESS_ROOT, entry.name));
		const graph = collectSourceDependencyGraph([CONFIG_PATH, ...harnessRoots]);
		assert.ok(graph.has(CONFIG_PATH), "the unit config must be an inspected graph root");
		assert.ok(graph.has(resolve(HARNESS_ROOT, "gateway.ts")), "the tier-1 gateway must be an inspected graph root");
		assert.deepEqual(
			[...graph].filter((file) => file === LEDGER_PATH).map((file) => relative(REPO_ROOT, file)),
			[],
			"unit config/harness runtime dependencies must not reach the cross-tier ledger",
		);

		const gatewaySource = readFileSync(resolve(HARNESS_ROOT, "gateway.ts"), "utf8");
		assert.doesNotMatch(
			gatewaySource,
			/acquireGatewayBootLease|bootLease|scripts\/testing-v2\/ledger/,
			"tier-1 gateway boot must not acquire or release a cross-process lease",
		);
	});

	it("fixes the unit cap at three and lets VITEST_MAX_WORKERS lower it only", () => {
		assert.equal(normal.FIXED_UNIT_WORKERS, 3);
		const resolve = normal.resolveMaxWorkers;
		assert.equal(resolve({}), 3);
		assert.equal(resolve({ VITEST_MAX_WORKERS: "1" }), 1);
		assert.equal(resolve({ VITEST_MAX_WORKERS: "2.9" }), 2);
		assert.equal(resolve({ VITEST_MAX_WORKERS: "3.9" }), 3);
		assert.equal(resolve({ VITEST_MAX_WORKERS: "4" }), 3);
		assert.equal(resolve({ VITEST_MAX_WORKERS: "999" }), 3);
		for (const invalid of ["", "0", "0.9", "-1", "NaN", "Infinity", "workers"]) {
			assert.equal(
				resolve({ VITEST_MAX_WORKERS: invalid }),
				3,
				`invalid worker request ${JSON.stringify(invalid)} must retain the fixed cap`,
			);
		}
	});

	it("uses one process-scoped transform cache across this run's projects and forks", () => {
		const thisProcessCache = normal.resolveVitestModuleCachePath(process.pid);
		const anotherProcessCache = normal.resolveVitestModuleCachePath(process.pid + 1);
		assert.notEqual(thisProcessCache, anotherProcessCache, "simultaneous Vitest parents must never share writable cache files");
		assert.equal(dirname(thisProcessCache), normal.VITEST_MODULE_CACHE_ROOT);
		assert.match(thisProcessCache.replaceAll("\\", "/"), /\/process-\d+$/);
		assert.deepEqual(
			projects(normal).map(({ experimental }) => experimental),
			Array.from({ length: 4 }, () => ({ fsModuleCache: true, fsModuleCachePath: thisProcessCache })),
			"every project and its worker forks must reuse the parent process namespace",
		);
	});

	it("keeps retry three across exactly four normal projects", () => {
		const actual = projects(normal);
		assert.deepEqual(
			actual.map(({ name }) => name),
			["v2-core", "v2-dom", "v2-integration", "v2-isolated"],
		);
		assert.deepEqual(
			actual.map(({ name, environment, pool, isolate, maxWorkers, retry }) => ({
				name,
				environment,
				pool,
				isolate,
				maxWorkers,
				retry,
			})),
			[
				{ name: "v2-core", environment: "node", pool: "forks", isolate: false, maxWorkers: 3, retry: 3 },
				{ name: "v2-dom", environment: "happy-dom", pool: "threads", isolate: true, maxWorkers: 3, retry: 3 },
				{ name: "v2-integration", environment: "node", pool: "forks", isolate: false, maxWorkers: 3, retry: 3 },
				{ name: "v2-isolated", environment: "node", pool: "forks", isolate: true, maxWorkers: 1, retry: 3 },
			],
		);
	});

	it("adds only the exact isolated E2E project when explicitly enabled", () => {
		const normalNames = ["v2-core", "v2-dom", "v2-integration", "v2-isolated"];
		assert.deepEqual(
			projects(withNonExactE2eFlag).map(({ name }) => name),
			normalNames,
			"only the exact flag value 1 may enable the E2E project",
		);

		const actual = projects(withE2e);
		assert.deepEqual(
			actual.map(({ name }) => name),
			["v2-e2e-vitest", ...normalNames],
		);
		const e2e = actual[0];
		assert.deepEqual(
			{
				name: e2e.name,
				environment: e2e.environment,
				pool: e2e.pool,
				isolate: e2e.isolate,
				maxWorkers: e2e.maxWorkers,
				retry: e2e.retry,
				include: e2e.include,
				setupFiles: e2e.setupFiles,
			},
			{
				name: "v2-e2e-vitest",
				environment: "node",
				pool: "forks",
				isolate: true,
				maxWorkers: 1,
				retry: 3,
				include: [
					"tests2/core/file-mentions-authenticated-boundary.test.ts",
					"tests2/core/git-lifecycle-no-publication-real-git.test.ts",
					"tests2/core/marketplace-install.test.ts",
					"tests2/core/orphan-tool-result-rehydration-boundaries.test.ts",
					"tests2/core/team-manager.test.ts",
				],
				setupFiles: undefined,
			},
		);
	});
});
