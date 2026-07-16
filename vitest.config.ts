import type { PluginOption } from "vite";
import { defineConfig } from "vitest/config";
import { loadVitestExecutionMap } from "./scripts/testing-v2/test-map-execution.mjs";
import * as serverPrebundle from "./scripts/testing-v2/server-prebundle.mjs";

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
const resolverFactory = (serverPrebundle as typeof serverPrebundle & {
	serverPrebundleResolver?: () => PluginOption;
}).serverPrebundleResolver;

console.log(
	`[vitest.config] maxWorkers=${MAX_WORKERS} (fixed cap ${FIXED_UNIT_WORKERS}${
		process.env.VITEST_MAX_WORKERS ? "; lowered by VITEST_MAX_WORKERS when valid" : ""
	})`,
);

export default defineConfig({
	...(resolverFactory ? { plugins: [resolverFactory()] } : {}),
	test: {
			...shared,
			reporters: ["default", "./tests2/harness/unit-file-budget-reporter.ts"],
			coverage,
			projects: [
				...(process.env.BOBBIT_V2_E2E_VITEST === "1" ? [{
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
					test: {
						...shared,
						name: "v2-core",
						environment: "node",
						setupFiles: tier1SetupFiles,
						include: execution.core,
					},
				},
				{
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
