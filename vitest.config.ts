import { defineConfig } from "vitest/config";

/**
 * Tier-1 vitest configuration for Test Suite v2.
 *
 * Decisions (see docs/testing-v2/design.md §2, D1):
 *   - pool "forks", isolate:false → one reused process per fork; the gateway
 *     fixture boots once per fork (module singleton) and is shared across files.
 *   - retries:0 → budgets are met by architecture, never by masking flakes.
 *   - three projects: v2-core (node), v2-dom (happy-dom), v2-integration (node).
 *
 * `maxForks` here is a sane fixed default for a single uncontended run. The
 * concurrency ledger (scripts/testing-v2) overrides it per invocation.
 */
const MAX_FORKS = Number(process.env.VITEST_MAX_FORKS || 6);

// minForks === maxForks pins the pool size for the whole run. Under
// pool:"forks" + isolate:false, letting tinypool spin DOWN an idle fork (a fast
// file finishes while a slow gateway-boot fork is still working) surfaces a
// spurious "Terminating worker thread" unhandled rejection that fails the run.
// A fixed-size pool is only torn down once, after every file completes.
const poolConfig = {
	pool: "forks" as const,
	isolate: false,
	poolOptions: { forks: { minForks: MAX_FORKS, maxForks: MAX_FORKS, singleFork: false } },
};

const shared = {
	...poolConfig,
	retries: 0,
	passWithNoTests: true,
	testTimeout: 30_000,
	hookTimeout: 60_000,
	teardownTimeout: 30_000,
};

export default defineConfig({
	test: {
		...shared,
		reporters: ["default"],
		projects: [
			{
				test: {
					...shared,
					name: "v2-core",
					environment: "node",
					include: ["tests2/core/**/*.test.ts"],
				},
			},
			{
				test: {
					...shared,
					name: "v2-dom",
					environment: "happy-dom",
					include: ["tests2/dom/**/*.test.ts"],
				},
			},
			{
				test: {
					...shared,
					name: "v2-integration",
					environment: "node",
					include: ["tests2/integration/**/*.test.ts"],
				},
			},
		],
	},
});
