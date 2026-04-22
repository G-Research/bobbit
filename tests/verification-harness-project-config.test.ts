/**
 * Reproducing test for the per-goal project config resolution bug in
 * `VerificationHarness`.
 *
 * BUG: `VerificationHarness` reads project config from the server-level
 * singleton `this.projectConfigStore` (injected at construction time, bound
 * to the bobbit project's own `project.yaml`) instead of resolving the
 * goal's owning project via
 * `projectContextManager.getContextForGoal(goalId).projectConfigStore`.
 *
 * When a goal lives in a non-bobbit project (e.g. ReqLess with
 * `typecheck_command: "dotnet build"`), command-type verify steps
 * substitute bobbit's command (`npm run check`) and every such gate fails.
 *
 * EXPECTED FIX: A private helper `resolveProjectConfigStore(goalId)` that
 * consults the context manager first and falls back to the injected
 * server-level store for legacy/test paths.
 *
 * This test invokes `(harness as any).resolveProjectConfigStore(goalId)`
 * directly. Before the fix the method does not exist, so the call throws
 * `TypeError: ... resolveProjectConfigStore is not a function`, producing
 * a clean reproducing-failure signal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "verif-proj-config-test-"));
fs.mkdirSync(path.join(TEST_DIR, "state"), { recursive: true });

const { VerificationHarness } = await import("../src/server/agent/verification-harness.js");

// ---------------------------------------------------------------------------
// Minimal in-memory ProjectConfigStore shim (just `getWithDefaults`).
// ---------------------------------------------------------------------------
function makeConfigStore(overrides: Record<string, string>) {
	return {
		getWithDefaults: () => ({
			build_command: "npm run build",
			test_command: "npm test",
			typecheck_command: "npm run check",
			test_unit_command: "npm run test:unit",
			test_e2e_command: "npm run test:e2e",
			qa_max_duration_minutes: "10",
			...overrides,
		}),
	};
}

/**
 * Build a mock ProjectContextManager with two projects. Project B owns goal
 * "goal-b"; project A owns goal "goal-a". Each has a distinct
 * typecheck_command so we can tell whose config was used.
 */
function makeContextManager() {
	const projectAConfig = makeConfigStore({ typecheck_command: "npm run check" });
	const projectBConfig = makeConfigStore({ typecheck_command: "dotnet build" });

	const contexts: Record<string, any> = {
		"goal-a": {
			project: { id: "proj-a" },
			goalStore: { get: (id: string) => (id === "goal-a" ? { id: "goal-a" } : undefined) },
			gateStore: { getGate: () => ({ signals: [] }) },
			projectConfigStore: projectAConfig,
		},
		"goal-b": {
			project: { id: "proj-b" },
			goalStore: { get: (id: string) => (id === "goal-b" ? { id: "goal-b" } : undefined) },
			gateStore: { getGate: () => ({ signals: [] }) },
			projectConfigStore: projectBConfig,
		},
	};

	return {
		getContextForGoal: (goalId: string) => contexts[goalId] ?? null,
		_projectAConfig: projectAConfig,
		_projectBConfig: projectBConfig,
	};
}

test("VerificationHarness.resolveProjectConfigStore returns the goal's owning project store, not the server-level default", () => {
	// Server-level store mimics bobbit's project.yaml — has npm run check.
	// If the harness falls through to this store, the test fails.
	const serverLevelConfig = makeConfigStore({ typecheck_command: "npm run check (SERVER DEFAULT — WRONG)" });

	const pcm = makeContextManager();

	const harness = new VerificationHarness(
		path.join(TEST_DIR, "state"),
		undefined, // gateStore (resolved via pcm)
		() => {}, // broadcastFn
		{ get: () => null, getAll: () => [] } as any, // roleStore
		undefined, // preferencesStore
		undefined, // sessionManager
		undefined, // teamManager
		serverLevelConfig as any, // server-level projectConfigStore (the BUG source)
		pcm as any, // projectContextManager
	);

	// Call the (currently missing) private helper. Before the fix this throws
	// `TypeError: ...resolveProjectConfigStore is not a function`.
	const resolved = (harness as any).resolveProjectConfigStore("goal-b");

	assert.ok(
		resolved && typeof resolved.getWithDefaults === "function",
		`resolveProjectConfigStore("goal-b") returned ${resolved} — expected project B's ProjectConfigStore`,
	);

	const cfg = resolved.getWithDefaults();
	assert.equal(
		cfg.typecheck_command,
		"dotnet build",
		`expected "dotnet build" (project B's typecheck_command) but got "${cfg.typecheck_command}" — ` +
		`VerificationHarness is reading project config from the server-level singleton ` +
		`instead of resolving per-goal via projectContextManager.getContextForGoal(goalId).projectConfigStore`,
	);

	// Project A's goal should resolve to project A's store (sanity — both paths
	// must route per-goal, not both to the server-level default).
	const resolvedA = (harness as any).resolveProjectConfigStore("goal-a");
	assert.equal(
		resolvedA.getWithDefaults().typecheck_command,
		"npm run check",
		`expected project A's typecheck_command for "goal-a" but got "${resolvedA.getWithDefaults().typecheck_command}"`,
	);
});

test("VerificationHarness.resolveProjectConfigStore falls back to server-level store when projectContextManager is absent (legacy/test path)", () => {
	const serverLevelConfig = makeConfigStore({ typecheck_command: "npm run check" });

	const harness = new VerificationHarness(
		path.join(TEST_DIR, "state"),
		undefined,
		() => {},
		{ get: () => null, getAll: () => [] } as any,
		undefined,
		undefined,
		undefined,
		serverLevelConfig as any,
		undefined, // no projectContextManager
	);

	const resolved = (harness as any).resolveProjectConfigStore("any-goal");
	assert.ok(
		resolved && typeof resolved.getWithDefaults === "function",
		`fallback path: resolveProjectConfigStore returned ${resolved}`,
	);
	assert.equal(resolved.getWithDefaults().typecheck_command, "npm run check");
});
