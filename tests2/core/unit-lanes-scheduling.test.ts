// Pins the replacement for the deleted lane scheduler: the unit stage is one
// direct Vitest process with a fixed, environment-lowerable worker cap.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
	};
};

type LoadedConfig = {
	FIXED_UNIT_WORKERS: number;
	resolveMaxWorkers: (env?: NodeJS.ProcessEnv) => number;
	default: { test: { projects: ProjectConfig[] } };
};

const packageJson = JSON.parse(
	readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };
const configSource = readFileSync(new URL("../../vitest.config.ts", import.meta.url), "utf8");
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
					"tests2/core/marketplace-install.test.ts",
					"tests2/core/team-manager.test.ts",
				],
				setupFiles: undefined,
			},
		);
	});
});
