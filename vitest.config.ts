import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { reserveWorkerSlots } from "./scripts/testing-v2/ledger.mjs";

/**
 * Tier-1 vitest configuration for Test Suite v2.
 *
 * Decisions (see docs/testing-v2/design.md §2, D1):
 *   - pool "forks", isolate:false → one reused process per fork; the gateway
 *     fixture boots once per fork (module singleton) and is shared across files.
 *   - retry:3 → TEMPORARY concurrency bridge (NOT flake-masking). See the
 *     `shared.retry` note below and docs/testing-strategy.md "Concurrency &
 *     budgets". NB: vitest's key is `retry` (singular); the earlier `retries: 0`
 *     here was a silently-ignored no-op — vitest never applied it.
 *   - projects: v2-core (node), v2-dom (happy-dom), v2-integration (node).
 *     On Windows, broad v2-core is split into sequenced shards to keep Vitest's
 *     worker RPC task-update queue below the post-run timeout threshold.
 *
 * `maxForks` is derived from the concurrency ledger so the 5-way concurrency
 * proof's `sum(workerSlots) <= cores` invariant holds. Resolution precedence:
 *   1. VITEST_MAX_FORKS env override wins (dev/debug); skips the ledger entirely.
 *   2. reserveWorkerSlots("vitest") — under run-v2.mjs this re-uses the parent
 *      grant (BOBBIT_V2_SLOTS_VITEST) with a no-op release; standalone
 *      `test:v2:core` performs its own cross-run reservation with the ledger's
 *      direct-vitest safety cap. release() is registered on process exit so the
 *      slot isn't leaked.
 *   3. Ledger grants are capped at 6 by default for the full-suite Vitest
 *      parent, then capped to 2 on Windows to avoid `[vitest-worker]: Timeout
 *      calling "onTaskUpdate"` while the parent drains RPC/reporting updates.
 *      `VITEST_MAX_FORKS` remains an explicit escape hatch.
 *   4. Fallback to 2 only if the ledger call throws.
 */
const STABLE_FULL_SUITE_FORK_CAP = 6;

function capDefaultForks(workerSlots: number): number {
	const capped = Math.max(1, Math.min(workerSlots, STABLE_FULL_SUITE_FORK_CAP));
	if (capped < workerSlots) {
		console.log(`[vitest.config] capping ledger grant from ${workerSlots} to ${capped} forks to avoid Vitest RPC saturation; set VITEST_MAX_FORKS to override.`);
	}
	return capped;
}

function resolveMaxForks(): number {
	const override = process.env.VITEST_MAX_FORKS;
	if (override != null && override !== "") {
		const n = Number(override);
		if (Number.isFinite(n) && n >= 1) return Math.floor(n);
	}
	try {
		const { workerSlots, release } = reserveWorkerSlots("vitest");
		process.once("exit", release);
		return capDefaultForks(workerSlots);
	} catch (e) {
		console.warn(`[vitest.config] ledger reserve failed, falling back to 2 forks: ${(e as Error)?.message ?? e}`);
		return 2;
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
	// session-event-bus is a synchronous unit over a MODULE-GLOBAL EventTarget
	// (src/app/session-event-bus.ts). Under isolate:false a sibling core file that
	// constructs a RemoteAgent/host-api can leave a live listener on the shared bus;
	// when this file publishes, that leaked handler fires (and can throw a stale
	// closure), flaking all three subtests under load. A fresh isolated module graph
	// removes the cross-file bleed deterministically.
	"tests2/core/extension-host-session-event-bus.test.ts",
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
	"tests2/core/transcript-sanitizer.test.ts",
];

// Long-running core files that legitimately exercise git/worktree flows. Keep
// them out of the broad v2-core fork pool so normal core files can finish/report
// without waiting behind a minutes-long straggler and tripping Vitest worker RPC
// timeouts (`[vitest-worker]: Timeout calling "onTaskUpdate"`). These files do
// not require module isolation; they only need their own sequenced single fork.
const heavyCoreFiles = [
	"tests2/core/git-status-native.test.ts",
	"tests2/core/team-manager.test.ts",
];

// DOM fixture that renders a lazy custom element also imported by broader DOM
// AgentInterface fixtures. Under isolate:false the first importer can pin lit's
// template/customElements registry to another happy-dom window; the file passes
// alone but fails in the full project with an inert <goal-status-widget>. Keep
// the assertions intact and give it a fresh single fork/module graph.
const isolatedDomFiles = [
	"tests2/dom/goal-status-widget.test.ts",
];

// Heavy gateway-integration specs whose command steps are API/status/metadata
// stand-ins (echo, deterministic exit, or scripted delay) rather than real shell
// lifecycle coverage. They run in the dedicated `v2-integration-fake` project
// with the non-spawning fake command-step runner injected, removing the cmd.exe/
// Git-Bash spawns that oversubscribe the box under concurrent load.
//
// Keep real-runner coverage for tests that assert OS-process fidelity or command
// side effects: cancel-verification (real cancellation), verification-core
// (streaming/tree-kill/durable runner), verification-restart-resignal (restart
// zombie cleanup), gate-inspect-slicing (retained logs/artifacts/filesystem side
// effects), bg/sandbox command suites, and gate-verification (legacy
// createTestGateway fixture outside this fake-DI seam).
// See docs/testing-v2/gateway-cost-feasibility.md.
const fakeCommandStepFiles = [
	"tests2/integration/gate-bypass-api.test.ts",
	"tests2/integration/gate-reset-api.test.ts",
	"tests2/integration/gate-resign-cancel.test.ts",
	"tests2/integration/gate-signal-progress.test.ts",
	"tests2/integration/gate-signal-reminder.test.ts",
	"tests2/integration/gate-status-summary.test.ts",
	"tests2/integration/gates-api-heavy.test.ts",
	"tests2/integration/maintenance-api.test.ts",
	"tests2/integration/optional-steps-api.test.ts",
];

function listTestFilesUnder(root: string): string[] {
	const files: string[] = [];
	function visit(dir: string): void {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			const stat = statSync(full);
			if (stat.isDirectory()) {
				visit(full);
			} else if (entry.endsWith(".test.ts")) {
				files.push(full.replace(/\\/g, "/"));
			}
		}
	}
	visit(root);
	return files.sort();
}

function shardFiles(files: string[], requestedShardCount: number): string[][] {
	const shardCount = Math.max(1, Math.min(requestedShardCount, files.length || 1));
	const shardSize = Math.ceil(files.length / shardCount);
	const shards: string[][] = [];
	for (let i = 0; i < files.length; i += shardSize) {
		shards.push(files.slice(i, i + shardSize));
	}
	return shards.length > 0 ? shards : [[]];
}

const LEDGER_MAX_FORKS = resolveMaxForks();
// Windows Vitest worker RPC saturates at ledger grants above two forks and can
// fail the run *after* all tests pass with `[vitest-worker]: Timeout calling
// "onTaskUpdate"`. Cap the shared Windows pool deterministically; dedicated
// heavy/isolated projects keep their explicit single-fork pools, and non-Windows
// runs keep the normal ledger-derived pool.
const MAX_FORKS = process.platform === "win32" ? Math.min(LEDGER_MAX_FORKS, 2) : LEDGER_MAX_FORKS;
const V2_CORE_MAX_FORKS = MAX_FORKS;
console.log(
	`[vitest.config] maxForks=${MAX_FORKS}; ledgerMaxForks=${LEDGER_MAX_FORKS}; v2CoreMaxForks=${V2_CORE_MAX_FORKS} (source: ${
		process.env.VITEST_MAX_FORKS ? "VITEST_MAX_FORKS override" : process.env.BOBBIT_V2_SLOTS_VITEST ? "ledger parent grant" : "ledger standalone reserve"
	})`,
);

function cliSelectsProject(projectName: string): boolean {
	const args = process.argv;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--project" && args[i + 1] === projectName) return true;
		if (args[i] === `--project=${projectName}`) return true;
	}
	return false;
}

function cliSelectsFile(file: string): boolean {
	const normalizedFile = file.replace(/\\/g, "/");
	return process.argv.some((arg) => {
		const normalizedArg = arg.replace(/\\/g, "/");
		return normalizedArg === normalizedFile || normalizedArg.endsWith(`/${normalizedFile}`);
	});
}

// Keep targeted legacy invocations such as `--project v2-core tests2/core/foo.test.ts`
// working while unfiltered broad runs still hand heavy files to v2-core-heavy.
const explicitV2CoreHeavyFiles = cliSelectsProject("v2-core") ? heavyCoreFiles.filter(cliSelectsFile) : [];
const broadCoreFiles = listTestFilesUnder("tests2/core").filter(
	(file) => (!heavyCoreFiles.includes(file) || explicitV2CoreHeavyFiles.includes(file)) && !singleForkFiles.includes(file),
);
// The Windows gateway can pass all ~520 broad core files and then fail while
// workers wait for the parent to acknowledge a large backlog of onTaskUpdate RPCs.
// Sequential shards preserve coverage and the Windows-safe two-fork throughput,
// while bounding each worker-pool's reporting queue before the next shard starts.
// Keep explicit `--project v2-core` invocations on the historical unsplit project
// for compatibility with coverage/chaos helper scripts that scope by that name.
const shouldShardBroadCore = process.platform === "win32" && !cliSelectsProject("v2-core");
const broadCoreShards = shardFiles(broadCoreFiles, shouldShardBroadCore ? 4 : 1);
const CORE_FOLLOWUP_GROUP_ORDER = broadCoreShards.length;
if (broadCoreShards.length > 1) {
	console.log(`[vitest.config] splitting v2-core into ${broadCoreShards.length} sequenced shards (${broadCoreFiles.length} files total) to avoid Vitest RPC saturation`);
}

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
	// TEMPORARY CONCURRENCY BRIDGE (retry, not flake-masking).
	// vitest's option is `retry` (singular) — the prior `retries: 0` was a no-op
	// that vitest silently ignored (its real default is already 0), so single-run
	// determinism is unchanged. We set retry:3 because Bobbit runs goals
	// CONCURRENTLY in prod, and the concurrency proof (docs/testing-v2/concurrency-proof.md,
	// the N=2 → 3/6 finding) shows a PROVEN structural server-throughput ceiling:
	// at N≥2 concurrent full test:v2 runs a rotating cast of integration tests hits
	// 60s timeouts under CPU starvation — NOT assertion/logic bugs. With retries:0
	// those spurious starvation timeouts would fail concurrent goal gate-loops.
	// The flakes are KNOWN and DOCUMENTED (not blind-masked); retry:3 is a bridge
	// until the higher-N throughput fix lands, at which point this restores to 0.
	retry: 3,
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
			...broadCoreShards.map((include, index) => ({
				test: {
					...shared,
					name: broadCoreShards.length === 1 || index === 0 ? "v2-core" : `v2-core-${index + 1}`,
					// Keep broad unit shards sequenced. Vitest 3.x can finish green on
					// Windows and then report `[vitest-worker]: Timeout calling
					// "onTaskUpdate"` while draining a large task-update backlog. Shards
					// bound each pool's RPC queue without dropping or isolating coverage.
					poolOptions: { forks: { minForks: V2_CORE_MAX_FORKS, maxForks: V2_CORE_MAX_FORKS, singleFork: false } },
					sequence: { groupOrder: index },
					environment: "node",
					include,
				},
			})),
			// Heavy core files: single sequenced fork, no module isolation needed. This
			// prevents a minutes-long git/worktree file from holding a broad v2-core
			// worker pool open after all other files have reported.
			{
				test: {
					...shared,
					name: "v2-core-heavy",
					sequence: { groupOrder: CORE_FOLLOWUP_GROUP_ORDER },
					environment: "node",
					pool: "forks" as const,
					poolOptions: { forks: { minForks: 1, maxForks: 1, singleFork: true } },
					include: heavyCoreFiles,
				},
			},
			// singleFork: files that genuinely cannot share a fork even with env-guard.
			// Target: ≤10 files. Each must be documented in tests2/tests-map.json with reason.
			{
				test: {
					...shared,
					name: "v2-core-isolated",
					sequence: { groupOrder: CORE_FOLLOWUP_GROUP_ORDER + 1 },
					environment: "node",
					isolate: true,
					pool: "forks" as const,
					poolOptions: { forks: { minForks: 1, maxForks: 1, singleFork: true } },
					include: singleForkFiles,
				},
			},
			{
				test: {
					...shared,
					name: "v2-dom",
					sequence: { groupOrder: CORE_FOLLOWUP_GROUP_ORDER + 2 },
					environment: "happy-dom",
					include: ["tests2/dom/**/*.test.ts"],
					exclude: [...isolatedDomFiles],
				},
			},
			{
				test: {
					...shared,
					name: "v2-integration",
					sequence: { groupOrder: CORE_FOLLOWUP_GROUP_ORDER + 3 },
					environment: "node",
					include: ["tests2/integration/**/*.test.ts"],
					// The fake-command-step specs run in the dedicated fake project below.
					exclude: [...fakeCommandStepFiles],
					// Integration tests each boot a real gateway + verification harness;
					// under concurrent load they can take >30 s, so override the default.
					testTimeout: 60_000,
					hookTimeout: 90_000,
				},
			},
			// Heavy verification specs with the NON-SPAWNING fake command-step runner.
			// Dedicated single fork (isolate:false so the gateway boots once and is
			// shared across these files) — kept OUT of the real-runner forks so the
			// fake-injection flag never crosses into verification-core / durability
			// tests. setupFiles sets the flag before the per-fork gateway boots.
			{
				test: {
					...shared,
					name: "v2-integration-fake",
					sequence: { groupOrder: CORE_FOLLOWUP_GROUP_ORDER + 4 },
					environment: "node",
					setupFiles: ["tests2/integration/_e2e/fake-cmd-setup.ts"],
					include: [...fakeCommandStepFiles],
					pool: "forks" as const,
					poolOptions: { forks: { minForks: 1, maxForks: 1, singleFork: true } },
					testTimeout: 60_000,
					hookTimeout: 90_000,
				},
			},
			// Run last so happy-dom/global fetch stubbing in this isolated fixture cannot
			// poison later Node integration workers when Vitest reuses processes.
			{
				test: {
					...shared,
					name: "v2-dom-isolated",
					sequence: { groupOrder: CORE_FOLLOWUP_GROUP_ORDER + 5 },
					environment: "happy-dom",
					isolate: true,
					pool: "forks" as const,
					poolOptions: { forks: { minForks: 1, maxForks: 1, singleFork: true } },
					include: [...isolatedDomFiles],
				},
			},
		],
	},
});
