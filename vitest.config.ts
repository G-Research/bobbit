import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { loadVitestExecutionMap } from "./scripts/testing-v2/test-map-execution.mjs";
import * as serverPrebundle from "./scripts/testing-v2/server-prebundle.mjs";
import UnitFileBudgetReporter from "./tests2/harness/unit-file-budget-reporter.js";
import GitTemplateHandoffReporter, {
	GIT_TEMPLATE_HANDOFF_PROOF_ENV,
} from "./tests2/harness/git-template-handoff-proof.js";
import {
	GIT_TEMPLATE_DIGEST_ENV,
	GIT_TEMPLATE_PATH_ENV,
	prepareGitTemplate,
	type GitTemplateDescriptor,
} from "./tests2/harness/git-template.js";
import { getRunRoot, installRunIsolation, isRunRootOwner } from "./tests2/harness/run-isolation.js";

// Must run before server prebundling and test collection so workers inherit
// only run-owned discovery roots and the credential-neutral environment.
installRunIsolation();

// The coordinator completes the only Git bootstrap before Vitest starts any
// guarded worker. Workers inherit readiness as path + digest and may only adopt.
let coordinatorGitTemplate: GitTemplateDescriptor | undefined;
if (isRunRootOwner()) {
	coordinatorGitTemplate = await prepareGitTemplate({ mode: "create" });
	process.env[GIT_TEMPLATE_PATH_ENV] = coordinatorGitTemplate.path;
	process.env[GIT_TEMPLATE_DIGEST_ENV] = coordinatorGitTemplate.digest;
}

/** Fixed suite-wide cap. The environment may lower it, never raise it. */
export const FIXED_UNIT_WORKERS = 3;

export function resolveMaxWorkers(env: NodeJS.ProcessEnv = process.env): number {
	const requested = Number(env.VITEST_MAX_WORKERS);
	return Number.isFinite(requested) && requested >= 1
		? Math.min(FIXED_UNIT_WORKERS, Math.floor(requested))
		: FIXED_UNIT_WORKERS;
}

// Every mutable Vitest artifact belongs to the coordinator's canonical root.
// Worker forks inherit that root before they evaluate this configuration.
export const VITEST_MODULE_CACHE_ROOT = join(getRunRoot(), "vitest-module-cache");
export const VITEST_COVERAGE_ROOT = join(getRunRoot(), "vitest-coverage");

/**
 * One Vitest parent owns one cache namespace. Its projects and worker forks
 * share transformed modules, while simultaneous Vitest parents never race on
 * the same metadata, temporary files, or atomic-rename destinations.
 */
export function resolveVitestModuleCachePath(pid: number = process.pid): string {
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid Vitest process id: ${pid}`);
	return join(VITEST_MODULE_CACHE_ROOT, `process-${pid}`);
}

export function resolveVitestCoveragePath(pid: number = process.pid): string {
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid Vitest process id: ${pid}`);
	return join(VITEST_COVERAGE_ROOT, `process-${pid}`);
}

const MAX_WORKERS = resolveMaxWorkers();
const MODULE_CACHE_PATH = resolveVitestModuleCachePath();
const execution = loadVitestExecutionMap();
const shared = {
	pool: "forks" as const,
	isolate: false,
	maxWorkers: MAX_WORKERS,
	// Workflow retries protect developer productivity after an isolated transient.
	// Qualification uses the exact flag to prove first-attempt stability.
	retry: process.env.BOBBIT_V2_RETRY_FREE === "1" ? 0 : 3,
	passWithNoTests: true,
	disableConsoleIntercept: true,
	testTimeout: 30_000,
	hookTimeout: 60_000,
	teardownTimeout: 30_000,
	// Vitest's cache key covers source, project environment, transform plugins,
	// config dependencies, lockfile state, NODE_ENV, and coverage instrumentation.
	// It stores transformed code only (never evaluated module state). All projects
	// and forks in this run share the process namespace; other Vitest processes use
	// separate namespaces so their cache writes cannot contend or replace ours.
	experimental: {
		fsModuleCache: true,
		fsModuleCachePath: MODULE_CACHE_PATH,
	},
};
const tier1SetupFiles = ["tests2/harness/tier1-spawn-guard.ts"];
// Per-file reset of leaking dir singletons for the isolate:false projects.
const fileBoundaryRunner = "tests2/harness/file-boundary-runner.ts";

const coverage = {
	provider: "v8" as const,
	reporter: ["json-summary" as const],
	reportsDirectory: resolveVitestCoveragePath(),
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
	}); moduleCache=${MODULE_CACHE_PATH}`,
);

export default defineConfig({
	test: {
		...shared,
		reporters: [
			"default",
			new UnitFileBudgetReporter(),
			...(coordinatorGitTemplate
				? [new GitTemplateHandoffReporter(coordinatorGitTemplate, MAX_WORKERS, execution.unit)]
				: []),
		],
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
					env: { [GIT_TEMPLATE_HANDOFF_PROOF_ENV]: "v2-core" },
					runner: fileBoundaryRunner,
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
					isolate: true,
					setupFiles: [...tier1SetupFiles, "tests2/harness/v2-dom-environment.ts"],
					include: execution.dom,
				},
			},
			{
				plugins: prebundlePlugins({ webEntries: false }),
				test: {
					...shared,
					name: "v2-integration",
					environment: "node",
					env: { [GIT_TEMPLATE_HANDOFF_PROOF_ENV]: "v2-integration" },
					runner: fileBoundaryRunner,
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
