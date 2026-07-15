import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { reserveWorkerSlots } from "./scripts/testing-v2/ledger.mjs";

/**
 * Tier-1 vitest configuration for Test Suite v2.
 *
 * Decisions (see docs/testing-v2/design.md §2, D1):
 *   - pool "forks", isolate:false → one reused process per worker; the gateway
 *     fixture boots once per worker (module singleton) and is shared across files.
 *   - retry:0 → infrastructure and assertion failures remain visible; throughput
 *     is fixed by worker budgeting and work elimination, never hidden retries.
 *   - projects: v2-core (node), v2-dom (happy-dom), v2-integration (node).
 *     The lane runner starts these independent groups concurrently.
 *
 * `maxWorkers` is derived from the concurrency ledger so concurrent suites obey
 * `sum(workerSlots) <= cores`. Vitest 4 removed the 60-second birpc timeout that
 * forced the old Windows two-worker cap, so the ledger grant is now the sole
 * concurrency limit. VITEST_MAX_WORKERS may lower a grant for debugging, but it
 * can never raise it or bypass the ledger.
 */
function resolveMaxWorkers(): number {
	try {
		const { workerSlots } = reserveWorkerSlots("vitest");
		const requested = Number(process.env.VITEST_MAX_WORKERS);
		return Number.isFinite(requested) && requested >= 1
			? Math.min(workerSlots, Math.floor(requested))
			: workerSlots;
	} catch (e) {
		console.warn(`[vitest.config] ledger reserve failed, falling back to 1 worker: ${(e as Error)?.message ?? e}`);
		return 1;
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
	// Real git/worktree-sync flows (init repos + remotes + worktrees + fetch);
	// each test runs ~4-25s even in isolation, so in the broad v2-core pool they
	// blow the 30s testTimeout under concurrent lane CPU-starvation. Sequenced in
	// the dedicated single-fork heavy lane (with extra timeout headroom below).
	"tests2/core/verification-goal-sync-nondestructive.test.ts",
];

// Heavy gateway-integration specs whose command steps are API/status/metadata
// stand-ins (echo, deterministic exit, or scripted delay) rather than real shell
// lifecycle coverage. They run in the dedicated `v2-integration-fake` project
// with the non-spawning fake command-step runner injected, removing the cmd.exe/
// Git-Bash spawns that oversubscribe the box under concurrent load.
//
// Keep real-runner coverage for tests that assert OS-process fidelity or command
// side effects: cancel-verification (real cancellation), verification-core
// (streaming/tree-kill/durable runner), gate-inspect-slicing (retained logs/artifacts/filesystem side
// effects), bg/sandbox command suites, and gate-verification (legacy
// createTestGateway fixture outside this fake-DI seam).
// See docs/testing-v2/gateway-cost-feasibility.md.
const sourceIntegrationFiles = [
	// These are source-module/store tests, not gateway journeys. Keep them in one
	// dedicated source worker so broad SessionManager/VerificationHarness imports
	// do not duplicate the prebundled gateway graph in every integration worker.
	"tests2/integration/cost-tracker-real-fs.test.ts",
	"tests2/integration/direct-agent-admin-token.test.ts",
	"tests2/integration/session-store-real-fs.test.ts",
	"tests2/integration/verification-review-timeout-payload.test.ts",
];

const isolatedIntegrationFiles = [
	// These suites mutate gateway-wide singleton/lifecycle state. Give each a
	// dedicated unit fork so sibling teardown cannot reset active HTTP connections.
	"tests2/integration/maintenance-api.test.ts",
	"tests2/integration/preview-mount-route.test.ts",
];

const realCommandIntegrationFiles = [
	// Retained-output/artifact assertions require the durable OS command runner,
	// but get a dedicated unit fork so they cannot contend with sibling gateways.
	"tests2/integration/gate-inspect-slicing.test.ts",
];

const fakeCommandStepFiles = [
	// API/state assertions use the deterministic command-step backend. The real
	// process runner's cancellation, artifact and restart contracts remain pinned
	// in core verification-command-* tests.
	"tests2/integration/cancel-verification.test.ts",
	"tests2/integration/gate-bypass-api.test.ts",
	"tests2/integration/gate-reset-api.test.ts",
	"tests2/integration/gate-resign-cancel.test.ts",
	"tests2/integration/gate-signal-progress.test.ts",
	"tests2/integration/gate-signal-reminder.test.ts",
	"tests2/integration/gate-status-summary.test.ts",
	"tests2/integration/gates-api-heavy.test.ts",
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

const MAX_WORKERS = resolveMaxWorkers();
console.log(
	`[vitest.config] maxWorkers=${MAX_WORKERS} (source: ${
		process.env.BOBBIT_V2_SLOTS_VITEST ? "ledger parent grant" : "ledger standalone reserve"
	}${process.env.VITEST_MAX_WORKERS ? "; lowered by VITEST_MAX_WORKERS" : ""})`,
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

// Process-fidelity tests stay in the complete unit inventory but use one isolated
// fork. This prevents concurrent cmd/git/Node/Chromium launches from starving the
// ordinary unit workers (and one another) on Windows. High-level decision tests
// should prefer injected runners; this project owns the remaining OS canaries.
const processFidelityCoreFiles = listTestFilesUnder("tests2/core").filter((file) => {
	const source = readFileSync(file, "utf-8");
	return /node:child_process|\bplaywright\b/.test(source);
});
const ioFidelityCoreFiles = [
	"tests2/core/agent-dir-migration.test.ts",
	"tests2/core/bg-process-persistence.test.ts",
	"tests2/core/continue-archived-clone.test.ts",
	"tests2/core/extension-host-pack-store.test.ts",
	"tests2/core/google-code-assist.test.ts",
	"tests2/core/headquarters-state-migration.test.ts",
	"tests2/core/marketplace-install.test.ts",
	"tests2/core/pack-pi-extensions-loader.test.ts",
	"tests2/core/preview-mount.test.ts",
	"tests2/core/project-preflight.test.ts",
	"tests2/core/project-registry-provisional-dedupe.test.ts",
	"tests2/core/rpc-bridge-gateway-env.test.ts",
	"tests2/core/sandbox-codex-auth.test.ts",
	"tests2/core/sandbox-google-auth.test.ts",
].filter((file) => !processFidelityCoreFiles.includes(file));
// Keep targeted legacy invocations such as `--project v2-core tests2/core/foo.test.ts`
// working while unfiltered broad runs hand special files to their unit sub-projects.
const explicitV2CoreHeavyFiles = cliSelectsProject("v2-core") ? heavyCoreFiles.filter(cliSelectsFile) : [];
const explicitProcessFidelityFiles = cliSelectsProject("v2-core") ? processFidelityCoreFiles.filter(cliSelectsFile) : [];
const explicitIoFidelityFiles = cliSelectsProject("v2-core") ? ioFidelityCoreFiles.filter(cliSelectsFile) : [];
const unitProcessFidelityFiles = processFidelityCoreFiles.filter((file) => !explicitProcessFidelityFiles.includes(file));
const unitIoFidelityFiles = ioFidelityCoreFiles.filter((file) => !explicitIoFidelityFiles.includes(file));
const unitFidelityCoreFiles = [...new Set([...unitProcessFidelityFiles, ...unitIoFidelityFiles])];
const unitHeavyCoreFiles = heavyCoreFiles.filter((file) => !unitFidelityCoreFiles.includes(file));

// Hindsight support is not currently part of the shipped product. Re-enable
// this test file if/when Hindsight support is added.
const deferredUnsupportedCoreFiles = ["tests2/core/hindsight-client.test.ts"];

const broadCoreFiles = listTestFilesUnder("tests2/core").filter(
	(file) => !deferredUnsupportedCoreFiles.includes(file)
		&& (!heavyCoreFiles.includes(file) || explicitV2CoreHeavyFiles.includes(file))
		&& (!processFidelityCoreFiles.includes(file) || explicitProcessFidelityFiles.includes(file))
		&& (!ioFidelityCoreFiles.includes(file) || explicitIoFidelityFiles.includes(file))
		&& !singleForkFiles.includes(file),
);
// Vitest 4's pool rewrite removes the birpc timeout/backlog failure that required
// sequential Windows core shards. Keep one broad project on every platform.
const broadCoreShards = [broadCoreFiles];
const CORE_FOLLOWUP_GROUP_ORDER = 1;

const poolConfig = {
	pool: "forks" as const,
	isolate: false,
	maxWorkers: MAX_WORKERS,
};

const shared = {
	...poolConfig,
	// Failures are never converted into passes. Concurrency starvation is addressed
	// by the ledger and by removing process amplification, not by retrying tests.
	retry: 0,
	passWithNoTests: true,
	// Gateway workers emit teardown diagnostics after the final assertion. Sending
	// those logs through Vitest's worker RPC can leave onUserConsoleLog pending as
	// the fork closes; write directly to inherited stdio instead.
	disableConsoleIntercept: true,
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
					maxWorkers: MAX_WORKERS,
					sequence: { groupOrder: index },
					environment: "node",
					include,
				},
			})),
			{
				test: {
					...shared,
					name: "v2-core-fidelity",
					sequence: { groupOrder: 0 },
					environment: "node",
					pool: "forks" as const,
					isolate: true,
					// Two workers overlap process and filesystem canaries without the
					// severe Windows Defender thrash observed with three or more.
					maxWorkers: Math.min(2, MAX_WORKERS),
					include: unitFidelityCoreFiles,
				},
			},
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
					maxWorkers: 1,
					// These files run real git/worktree flows that are individually slow
					// (tens of seconds) and get slower under the parallel integration lane's
					// CPU load. Give them headroom over the shared 30s default so a busy box
					// doesn't turn a legitimately-long git test into a spurious timeout.
					testTimeout: 120_000,
					hookTimeout: 120_000,
					include: unitHeavyCoreFiles,
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
					maxWorkers: 1,
					include: singleForkFiles,
				},
			},
			{
				test: {
					...shared,
					name: "v2-dom",
					sequence: { groupOrder: CORE_FOLLOWUP_GROUP_ORDER + 2 },
					environment: "happy-dom",
					// Reuse a bounded worker-thread pool instead of spawning one fork process
					// per isolated DOM file. isolate:true still gives every file a fresh
					// happy-dom environment and module graph, preventing global/storage leaks.
					pool: "threads" as const,
					isolate: true,
					include: ["tests2/dom/**/*.test.ts"],
				},
			},
			{
				test: {
					...shared,
					name: "v2-integration",
					sequence: { groupOrder: CORE_FOLLOWUP_GROUP_ORDER + 3 },
					environment: "node",
					include: ["tests2/integration/**/*.test.ts"],
					// Special command/source/isolated specs run in dedicated unit projects.
					// All other integration files—including the twelve formerly relocated
					// real-fidelity owners—remain owned by the unit gate.
					exclude: [...fakeCommandStepFiles, ...realCommandIntegrationFiles, ...sourceIntegrationFiles, ...isolatedIntegrationFiles],
					// Integration tests each boot a real gateway + verification harness;
					// under concurrent load they can take >30 s, so override the default.
					testTimeout: 60_000,
					hookTimeout: 90_000,
				},
			},
			{
				test: {
					...shared,
					name: "v2-integration-source",
					sequence: { groupOrder: CORE_FOLLOWUP_GROUP_ORDER + 4 },
					environment: "node",
					include: sourceIntegrationFiles,
					pool: "forks" as const,
					maxWorkers: 1,
				},
			},
			{
				test: {
					...shared,
					name: "v2-integration-isolated",
					sequence: { groupOrder: CORE_FOLLOWUP_GROUP_ORDER + 5 },
					environment: "node",
					include: isolatedIntegrationFiles,
					pool: "forks" as const,
					isolate: true,
					maxWorkers: 1,
					testTimeout: 60_000,
					hookTimeout: 90_000,
				},
			},
			{
				test: {
					...shared,
					name: "v2-integration-command",
					sequence: { groupOrder: CORE_FOLLOWUP_GROUP_ORDER + 6 },
					environment: "node",
					include: realCommandIntegrationFiles,
					pool: "forks" as const,
					isolate: true,
					maxWorkers: 1,
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
					sequence: { groupOrder: CORE_FOLLOWUP_GROUP_ORDER + 7 },
					environment: "node",
					setupFiles: ["tests2/integration/_e2e/fake-cmd-setup.ts"],
					include: [...fakeCommandStepFiles],
					pool: "forks" as const,
					maxWorkers: 1,
					testTimeout: 60_000,
					hookTimeout: 90_000,
				},
			},
		],
	},
});
