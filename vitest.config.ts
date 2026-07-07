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
	// env-bleed stragglers: BOBBIT_DIR / HOME / agent-dir recorded at module-top,
	// or a pinned module singleton (globalAgentDir) that a sibling file in the same
	// fork can initialise first — needs a fresh process for deterministic state.
	"tests2/core/bobbit-dir-agent-dir.test.ts",
	"tests2/core/container-path-translation.test.ts",
	"tests2/core/goal-metadata-edges.test.ts",
	"tests2/core/lifecycle-hub.test.ts",
	"tests2/core/pr-walkthrough-durable-routes.test.ts",
	"tests2/core/sandbox-wiring-goal-provisioned.test.ts",
	"tests2/core/session-recovery-agent-dir.test.ts",
	"tests2/core/transcript-sanitizer-agent-dir.test.ts",
];

// FEASIBILITY STUDY (task 144a0853): the ~6 heaviest gateway-integration specs
// that deterministically starve under concurrent load. When
// BOBBIT_V2_RELOCATE_HEAVY=1 they are excluded from the v2-integration tier
// (simulating a move to the daily lane) so 4-way concurrency can be measured
// with vs without them. This gate is temporary/study-only and defaults OFF —
// with the env unset the config is byte-for-behaviour identical to before.
const relocateHeavyFiles = [
	"tests2/integration/gate-reset-api.test.ts",
	"tests2/integration/gates-api-heavy.test.ts",
	"tests2/integration/verification-core.test.ts",
	"tests2/integration/maintenance-api.test.ts",
	"tests2/integration/gate-signal-progress.test.ts",
	"tests2/integration/gate-resign-cancel.test.ts",
];
const RELOCATE_HEAVY = process.env.BOBBIT_V2_RELOCATE_HEAVY === "1";
if (RELOCATE_HEAVY) {
	console.log(`[vitest.config] RELOCATE_HEAVY=1 — excluding ${relocateHeavyFiles.length} heavy integration specs from v2-integration tier (study mode)`);
}

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

/**
 * V8 coverage configuration for --scope all parity proof.
 * Output: .profiles/testing-v2/coverage/coverage-summary.json
 * Used by scripts/testing-v2/parity.mjs to compare per-area line+branch
 * coverage against the baselines in tests2/v2-baseline-coverage.json.
 */
const coverage = {
	provider: "v8" as const,
	reporter: ["json-summary"] as const,
	reportsDirectory: ".profiles/testing-v2/coverage",
	include: ["src/**/*.ts", "src/**/*.js"],
	exclude: [
		"src/**/*.d.ts",
		"src/**/*.spec.ts",
		"src/**/*.test.ts",
		"src/**/__mocks__/**",
	],
};

export default defineConfig({
	test: {
		...shared,
		reporters: ["default"],
		coverage,
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
					exclude: RELOCATE_HEAVY ? relocateHeavyFiles : [],
					// Integration tests each boot a real gateway + verification harness;
					// under concurrent load they can take >30 s, so override the default.
					testTimeout: 60_000,
					hookTimeout: 90_000,
				},
			},
		],
	},
});
