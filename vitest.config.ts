import { defineConfig } from "vitest/config";
import { reserveWorkerSlots } from "./scripts/testing-v2/ledger.mjs";

/**
 * Tier-1 vitest configuration for Test Suite v2.
 *
 * Decisions (see docs/testing-v2/design.md §2, D1):
 *   - pool "forks", isolate:false → one reused process per fork; the gateway
 *     fixture boots once per fork (module singleton) and is shared across files.
 *   - retries:0 → budgets are met by architecture, never by masking flakes.
 *   - three projects: v2-core (node), v2-dom (happy-dom), v2-integration (node).
 *
 * `maxForks` is derived from the concurrency ledger so the 5-way concurrency
 * proof's `sum(workerSlots) <= cores` invariant holds. Resolution precedence:
 *   1. VITEST_MAX_FORKS env override wins (dev/debug); skips the ledger entirely.
 *   2. reserveWorkerSlots("vitest") — under run-v2.mjs this re-uses the parent
 *      grant (BOBBIT_V2_SLOTS_VITEST) with a no-op release; standalone
 *      `test:v2:core` performs its own cross-run reservation. release() is
 *      registered on process exit so the slot isn't leaked.
 *   3. Fallback to 6 only if the ledger call throws.
 */
function resolveMaxForks(): number {
	const override = process.env.VITEST_MAX_FORKS;
	if (override != null && override !== "") {
		const n = Number(override);
		if (Number.isFinite(n) && n >= 1) return Math.floor(n);
	}
	try {
		const { workerSlots, release } = reserveWorkerSlots("vitest");
		process.once("exit", release);
		return Math.max(1, workerSlots);
	} catch (e) {
		console.warn(`[vitest.config] ledger reserve failed, falling back to 6 forks: ${(e as Error)?.message ?? e}`);
		return 6;
	}
}

// Files that mutate process.env / NODE_OPTIONS at module-top (or in beforeAll) and
// require genuine process isolation because a sibling file's env-guard afterAll can
// clobber the values between collection and test execution under pool:forks isolate:false.
// Keep this list alphabetical. Target: ≤10 files (currently 9 + some env-bleed stragglers).
const singleForkFiles = [
	// extension-host files all spawn worker_threads that need NODE_OPTIONS=--import ts-worker-register
	// which env-guard's afterAll strips between collect and run.
	"tests2/core/extension-host-action-dispatcher.test.ts",
	"tests2/core/extension-host-channel-registry.test.ts",
	"tests2/core/extension-host-isolation-config-invariant.test.ts",
	"tests2/core/extension-host-module-isolation.test.ts",
	"tests2/core/extension-host-route-dispatcher.test.ts",
	// env-bleed stragglers: BOBBIT_DIR / HOME / agent-dir recorded at module-top
	"tests2/core/container-path-translation.test.ts",
	"tests2/core/goal-metadata-edges.test.ts",
	"tests2/core/lifecycle-hub.test.ts",
	"tests2/core/pr-walkthrough-durable-routes.test.ts",
	"tests2/core/sandbox-wiring-goal-provisioned.test.ts",
	"tests2/core/session-recovery-agent-dir.test.ts",
	"tests2/core/transcript-sanitizer-agent-dir.test.ts",
];

const MAX_FORKS = resolveMaxForks();
console.log(
	`[vitest.config] maxForks=${MAX_FORKS} (source: ${
		process.env.VITEST_MAX_FORKS ? "VITEST_MAX_FORKS override" : process.env.BOBBIT_V2_SLOTS_VITEST ? "ledger parent grant" : "ledger standalone reserve"
	})`,
);

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
					// Exclude stragglers that require process isolation (singleFork project below)
					include: ["tests2/core/**/*.test.ts"],
					exclude: [
						// singleFork stragglers — all listed in singleFork project below
						...singleForkFiles,
					],
				},
			},
			// singleFork: files that genuinely cannot share a fork even with env-guard.
			// Target: ≤10 files. Each must be documented in tests2/tests-map.json with reason.
			{
				test: {
					...shared,
					name: "v2-core-isolated",
					environment: "node",
					isolate: true,
					pool: "forks" as const,
					poolOptions: { forks: { singleFork: true } },
					include: singleForkFiles,
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
