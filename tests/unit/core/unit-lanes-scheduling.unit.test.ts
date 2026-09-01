// Pins the replacement for the deleted lane scheduler: the unit stage is one
// direct Vitest process with a fixed, environment-lowerable worker cap.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, posix, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { discoverTests } from "../../../scripts/testing-v2/test-discovery.mjs";
import {
	GitTemplateHandoffReporter,
	type GitTemplateHandoffCertifier,
} from "../../../tests/support/harnesses/shared/git-template-handoff-proof.js";
import { resolveGatewayRepositoryRoot } from "../../../tests/support/harnesses/shared/gateway.js";

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

type HandoffTestModule = Parameters<GitTemplateHandoffReporter["onTestModuleStart"]>[0];

function handoffModule(moduleId: string): HandoffTestModule {
	return { moduleId } as HandoffTestModule;
}

type LoadedConfig = {
	FIXED_UNIT_WORKERS: number;
	VITEST_MODULE_CACHE_ROOT: string;
	resolveMaxWorkers: (env?: NodeJS.ProcessEnv) => number;
	resolveVitestModuleCachePath: (pid?: number) => string;
	default: { test: { projects: ProjectConfig[] } };
};

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CONFIG_PATH = resolve(REPO_ROOT, "vitest.config.ts");
const HARNESS_ROOT = resolve(REPO_ROOT, "tests", "support", "harnesses", "shared");
const LEDGER_PATH = resolve(REPO_ROOT, "scripts", "testing-v2", "ledger.mjs");
const packageJson = JSON.parse(
	readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };
const configSource = readFileSync(CONFIG_PATH, "utf8");
const discoveredTests = discoverTests();

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
const originalRetryFreeFlag = process.env.BOBBIT_V2_RETRY_FREE;
const originalWorkerFlag = process.env.VITEST_MAX_WORKERS;
let normal: LoadedConfig;
let withNonExactE2eFlag: LoadedConfig;
let withE2e: LoadedConfig;
let withNonExactRetryFreeFlag: LoadedConfig;
let withRetryFree: LoadedConfig;

function restoreEnvironment(): void {
	if (originalE2eFlag === undefined) delete process.env.BOBBIT_V2_E2E_VITEST;
	else process.env.BOBBIT_V2_E2E_VITEST = originalE2eFlag;
	if (originalRetryFreeFlag === undefined) delete process.env.BOBBIT_V2_RETRY_FREE;
	else process.env.BOBBIT_V2_RETRY_FREE = originalRetryFreeFlag;
	if (originalWorkerFlag === undefined) delete process.env.VITEST_MAX_WORKERS;
	else process.env.VITEST_MAX_WORKERS = originalWorkerFlag;
}

async function loadConfig({ e2eFlag, retryFreeFlag }: {
	e2eFlag?: string;
	retryFreeFlag?: string;
} = {}): Promise<LoadedConfig> {
	if (e2eFlag === undefined) delete process.env.BOBBIT_V2_E2E_VITEST;
	else process.env.BOBBIT_V2_E2E_VITEST = e2eFlag;
	if (retryFreeFlag === undefined) delete process.env.BOBBIT_V2_RETRY_FREE;
	else process.env.BOBBIT_V2_RETRY_FREE = retryFreeFlag;
	delete process.env.VITEST_MAX_WORKERS;
	vi.resetModules();
	return await import("../../../vitest.config.ts") as LoadedConfig;
}

beforeAll(async () => {
	try {
		normal = await loadConfig();
		withNonExactE2eFlag = await loadConfig({ e2eFlag: "true" });
		withE2e = await loadConfig({ e2eFlag: "1" });
		withNonExactRetryFreeFlag = await loadConfig({ retryFreeFlag: "true" });
		withRetryFree = await loadConfig({ retryFreeFlag: "1" });
	} finally {
		restoreEnvironment();
		vi.resetModules();
	}
});

afterAll(restoreEnvironment);

function projects(config: LoadedConfig): ProjectConfig["test"][] {
	return config.default.test.projects.map((project) => project.test);
}

describe("shared gateway repository paths", () => {
	it("resolves the relocated harness root with POSIX and Windows spellings", () => {
		assert.equal(
			resolveGatewayRepositoryRoot("/checkout/tests/support/harnesses/shared", posix.resolve),
			"/checkout",
		);
		assert.equal(
			resolveGatewayRepositoryRoot("C:\\checkout\\tests\\support\\harnesses\\shared", win32.resolve),
			"C:\\checkout",
		);
	});

	it("locates every repository-owned gateway boot asset from the checkout root", () => {
		const repositoryRoot = resolveGatewayRepositoryRoot(HARNESS_ROOT);
		assert.equal(repositoryRoot, resolve(REPO_ROOT));
		for (const asset of [
			["defaults"],
			["market-packs", "file-explorer"],
			["tests", "e2e", "mock-agent.mjs"],
			["tests", "e2e", "in-process-mock-bridge.mjs"],
		]) {
			const assetPath = resolve(repositoryRoot, ...asset);
			assert.equal(existsSync(assetPath), true, `gateway boot asset must exist: ${relative(repositoryRoot, assetPath)}`);
		}
	});
});

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

	it("certifies Git handoff only for the complete inventory with the resolved worker count", async () => {
		assert.match(
			configSource,
			/new GitTemplateHandoffReporter\(coordinatorGitTemplate, MAX_WORKERS, discovery\.unit\)/,
			"the coordinator must inject the resolved cap and exact convention-discovered inventory",
		);
		assert.doesNotMatch(
			configSource,
			/new GitTemplateHandoffReporter\(coordinatorGitTemplate, FIXED_UNIT_WORKERS/,
			"lowered complete-suite runs must not retain the fixed default expectation",
		);

		const inventory = [
			"tests/unit/core/git-template-handoff-probe-a.unit.test.ts",
			"tests/unit/core/git-template-handoff-probe-b.unit.test.ts",
			"tests/unit/core/git-template-handoff-probe-c.unit.test.ts",
		];
		const descriptor = { path: "/run/git-template/repo", digest: "a".repeat(64) };
		for (const [env, expectedWorkers] of [
			[{}, 3],
			[{ VITEST_MAX_WORKERS: "1" }, 1],
			[{ VITEST_MAX_WORKERS: "2" }, 2],
		] as const) {
			const certifications: number[] = [];
			const certifier: GitTemplateHandoffCertifier = (_descriptor, workers) => {
				certifications.push(workers);
			};
			const reporter = new GitTemplateHandoffReporter(
				descriptor,
				normal.resolveMaxWorkers(env),
				inventory,
				certifier,
			);

			reporter.onTestRunStart();
			reporter.onTestModuleStart(handoffModule(`C:\\repo\\${inventory[0]}?focused`));
			await reporter.onTestRunEnd();
			assert.deepEqual(certifications, [], "focused selection must not certify or fail on missing companions");

			reporter.onTestRunStart();
			for (const path of inventory) {
				reporter.onTestModuleStart(handoffModule(`file:///repo/${path}#complete`));
			}
			await reporter.onTestRunEnd();
			assert.deepEqual(certifications, [expectedWorkers]);

			reporter.onTestRunStart();
			for (const path of [...inventory, "tests2/core/unexpected.test.ts"]) {
				reporter.onTestModuleStart(handoffModule(`/repo/${path}`));
			}
			await reporter.onTestRunEnd();
			assert.deepEqual(certifications, [expectedWorkers], "non-canonical supersets must not certify");
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

	it("keeps default retry three across exactly four normal projects", () => {
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

	it("disables retries only for the exact retry-free qualification flag", () => {
		assert.deepEqual(
			projects(withNonExactRetryFreeFlag).map(({ retry }) => retry),
			[3, 3, 3, 3],
			"non-exact retry-free values must retain normal workflow retries",
		);
		assert.deepEqual(
			projects(withRetryFree).map(({ retry }) => retry),
			[0, 0, 0, 0],
			"the exact retry-free flag must disable retries for every unit project",
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
				include: discoveredTests.vitestE2E,
				setupFiles: undefined,
			},
		);
	});
});
