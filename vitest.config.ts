import { defineConfig } from "vitest/config";
import { loadVitestExecutionMap } from "./scripts/testing-v2/test-map-execution.mjs";
import * as serverPrebundle from "./scripts/testing-v2/server-prebundle.mjs";
import UnitFileBudgetReporter from "./tests2/harness/unit-file-budget-reporter.js";

/** Fixed suite-wide cap. The environment may lower it, never raise it. */
export const FIXED_UNIT_WORKERS = 3;

export function resolveMaxWorkers(env: NodeJS.ProcessEnv = process.env): number {
	const requested = Number(env.VITEST_MAX_WORKERS);
	return Number.isFinite(requested) && requested >= 1
		? Math.min(FIXED_UNIT_WORKERS, Math.floor(requested))
		: FIXED_UNIT_WORKERS;
}

const MAX_WORKERS = resolveMaxWorkers();
const execution = loadVitestExecutionMap();
const shared = {
	pool: "forks" as const,
	isolate: false,
	maxWorkers: MAX_WORKERS,
	retry: 3,
	passWithNoTests: true,
	disableConsoleIntercept: true,
	testTimeout: 30_000,
	hookTimeout: 60_000,
	teardownTimeout: 30_000,
	// Vitest's cache key covers source, project environment, transform plugins,
	// config dependencies, lockfile state, NODE_ENV, and coverage instrumentation.
	// It stores transformed code only (never evaluated module state), so isolated
	// DOM/env suites keep fresh globals while repeated and concurrent runs avoid
	// paying the TypeScript transform tax. Cache publication is atomic.
	experimental: {
		fsModuleCache: true,
		fsModuleCachePath: ".profiles/testing-v2/vitest-module-cache",
	},
};
const tier1SetupFiles = ["tests2/harness/tier1-spawn-guard.ts"];

const coverage = {
	provider: "v8" as const,
	reporter: ["json-summary" as const],
	reportsDirectory: ".profiles/testing-v2/coverage",
	include: ["src/**/*.ts", "src/**/*.js"],
	exclude: [
		"src/**/*.d.ts",
		"src/**/*.spec.ts",
		"src/**/*.test.ts",
		"src/**/__mocks__/**",
	],
};

const prebundle = await serverPrebundle.ensureServerTestPrebundle();
process.env.BOBBIT_V2_SERVER_PREBUNDLE = prebundle.bundlePath;
const prebundlePlugins = (options: { webEntries?: boolean } = {}) => [
	serverPrebundle.serverPrebundleResolver(prebundle, options),
];

console.log(
	`[vitest.config] maxWorkers=${MAX_WORKERS} (fixed cap ${FIXED_UNIT_WORKERS}${
		process.env.VITEST_MAX_WORKERS ? "; lowered by VITEST_MAX_WORKERS when valid" : ""
	})`,
);

export default defineConfig({
	test: {
		...shared,
		reporters: ["default", new UnitFileBudgetReporter()],
		coverage,
		projects: [
			...(process.env.BOBBIT_V2_E2E_VITEST === "1" ? [{
				plugins: prebundlePlugins({ webEntries: false }),
				test: {
					...shared,
					name: "v2-e2e-vitest",
					environment: "node",
					isolate: true,
					maxWorkers: 1,
					include: execution.e2e,
				},
			}] : []),
			{
				plugins: prebundlePlugins({ webEntries: false }),
				test: {
					...shared,
					name: "v2-core",
					environment: "node",
					setupFiles: tier1SetupFiles,
					include: execution.core,
				},
			},
			{
				// Only the isolated happy-dom project may resolve eager browser entries;
				// node projects use a distinct resolver and transform-cache profile.
				plugins: prebundlePlugins({ webEntries: true }),
				test: {
					...shared,
					name: "v2-dom",
					environment: "happy-dom",
					pool: "threads" as const,
					isolate: true,
					setupFiles: tier1SetupFiles,
					include: execution.dom,
				},
			},
			{
				plugins: prebundlePlugins({ webEntries: false }),
				test: {
					...shared,
					name: "v2-integration",
					environment: "node",
					setupFiles: tier1SetupFiles,
					include: execution.integration,
					testTimeout: 60_000,
					hookTimeout: 90_000,
				},
			},
			{
				plugins: prebundlePlugins({ webEntries: false }),
				test: {
					...shared,
					name: "v2-isolated",
					environment: "node",
					isolate: true,
					maxWorkers: 1,
					setupFiles: tier1SetupFiles,
					include: execution.isolated,
				},
			},
		],
	},
});
