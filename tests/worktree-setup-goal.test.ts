/**
 * Per-goal worktree setup hook + configurable timeout.
 *
 * Covers the pure helpers in `src/server/skills/worktree-setup.ts`:
 *   - `resolveSetupTimeoutMs` precedence + invalid-value fallback
 *   - `runGoalSetup` exec invocation (cwd + injected env), blank skip,
 *     failure propagation, and the BOBBIT_TEST_RECORD_SETUP audit line.
 *
 * The runner takes an injected `exec`, so no real shell is needed.
 * See the per-goal worktree setup design doc.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	DEFAULT_WORKTREE_SETUP_TIMEOUT_MS,
	resolveSetupTimeoutMs,
	runGoalSetup,
} from "../src/server/skills/worktree-setup.ts";

describe("resolveSetupTimeoutMs", () => {
	it("exposes the documented 120s default constant", () => {
		assert.equal(DEFAULT_WORKTREE_SETUP_TIMEOUT_MS, 120_000);
	});

	it("returns the default when nothing is supplied", () => {
		assert.equal(resolveSetupTimeoutMs(), DEFAULT_WORKTREE_SETUP_TIMEOUT_MS);
		assert.equal(resolveSetupTimeoutMs({}), DEFAULT_WORKTREE_SETUP_TIMEOUT_MS);
	});

	it("prefers a finite positive goal override over project + default", () => {
		assert.equal(
			resolveSetupTimeoutMs({ goalTimeoutMs: 5000, projectTimeoutMs: 9000 }),
			5000,
		);
	});

	it("falls back to the project default when the goal value is absent", () => {
		assert.equal(resolveSetupTimeoutMs({ projectTimeoutMs: 9000 }), 9000);
	});

	it("accepts a numeric-string project default (project config stores strings)", () => {
		assert.equal(resolveSetupTimeoutMs({ projectTimeoutMs: "30000" }), 30_000);
	});

	it("rejects fractional values rather than flooring them", () => {
		// Design requires finite positive INTEGERS. A fractional goal override
		// must fall through to the next tier, not be truncated.
		assert.equal(resolveSetupTimeoutMs({ goalTimeoutMs: 1500.9 }), DEFAULT_WORKTREE_SETUP_TIMEOUT_MS);
		assert.equal(resolveSetupTimeoutMs({ goalTimeoutMs: 1500.9, projectTimeoutMs: 7000 }), 7000);
		// "0.5" must fall back, not resolve to 0.
		assert.equal(resolveSetupTimeoutMs({ goalTimeoutMs: "0.5", projectTimeoutMs: 7000 }), 7000);
		assert.equal(resolveSetupTimeoutMs({ projectTimeoutMs: "2.5" }), DEFAULT_WORKTREE_SETUP_TIMEOUT_MS);
	});

	it("falls through invalid / zero / negative / fractional / non-finite goal values to the project default", () => {
		for (const bad of [0, -1, -1000, 0.5, 1.9, "0.5", "1.5", Number.NaN, Number.POSITIVE_INFINITY, "nope", "", "  ", null, undefined, {}, []]) {
			assert.equal(
				resolveSetupTimeoutMs({ goalTimeoutMs: bad as unknown, projectTimeoutMs: 7000 }),
				7000,
				`goal value ${String(bad)} should fall through to the project default`,
			);
		}
	});

	it("falls through invalid project values to the 120s default", () => {
		for (const bad of [0, -5, 0.5, 2.5, "0.5", "2.5", Number.NaN, Number.POSITIVE_INFINITY, "abc", "", null, undefined]) {
			assert.equal(
				resolveSetupTimeoutMs({ projectTimeoutMs: bad as unknown }),
				DEFAULT_WORKTREE_SETUP_TIMEOUT_MS,
				`project value ${String(bad)} should fall through to the default`,
			);
		}
	});
});

describe("runGoalSetup", () => {
	const recordFiles: string[] = [];
	afterEach(() => {
		delete process.env.BOBBIT_TEST_RECORD_SETUP;
		for (const f of recordFiles.splice(0)) {
			try { fs.rmSync(f, { force: true }); } catch { /* best-effort */ }
		}
	});

	const baseOpts = {
		goalId: "goal-123",
		branch: "goal/feature-x",
		worktreePath: "/wt/branch-x",
		cwd: "/wt/branch-x/app",
		primaryWorktreeRoot: "/repo",
	};

	it("invokes exec exactly once with the resolved cwd and injected env", async () => {
		const calls: Array<{ cmd: string; cwd: string; env: NodeJS.ProcessEnv }> = [];
		await runGoalSetup({
			...baseOpts,
			command: "setup.sh",
			exec: async (cmd, cwd, env) => { calls.push({ cmd, cwd, env }); },
		});

		assert.equal(calls.length, 1);
		assert.equal(calls[0].cmd, "setup.sh");
		// cwd is the offset-applied goal cwd, where the team will actually work.
		assert.equal(calls[0].cwd, "/wt/branch-x/app");

		// Injected goal-context env vars.
		assert.equal(calls[0].env.SOURCE_REPO, "/repo");
		assert.equal(calls[0].env.BOBBIT_GOAL_ID, "goal-123");
		assert.equal(calls[0].env.BOBBIT_GOAL_BRANCH, "goal/feature-x");
		assert.equal(calls[0].env.BOBBIT_WORKTREE_PATH, "/wt/branch-x");
		// Inherited process env is preserved (spot-check PATH presence).
		assert.equal(calls[0].env.PATH, process.env.PATH);
	});

	it("trims the command before passing it to exec", async () => {
		const calls: string[] = [];
		await runGoalSetup({
			...baseOpts,
			command: "   npm run seed   ",
			exec: async (cmd) => { calls.push(cmd); },
		});
		assert.deepEqual(calls, ["npm run seed"]);
	});

	it("skips exec entirely for a blank / absent command", async () => {
		let called = false;
		const exec = async () => { called = true; };
		await runGoalSetup({ ...baseOpts, command: undefined, exec });
		await runGoalSetup({ ...baseOpts, command: "", exec });
		await runGoalSetup({ ...baseOpts, command: "   ", exec });
		assert.equal(called, false);
	});

	it("propagates exec failures (per-goal setup is fatal)", async () => {
		await assert.rejects(
			runGoalSetup({
				...baseOpts,
				command: "boom",
				exec: async () => { throw new Error("setup blew up"); },
			}),
			/setup blew up/,
		);
	});

	it("writes a distinguishable per-goal BOBBIT_TEST_RECORD_SETUP audit line", async () => {
		const recordFile = path.join(
			fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-goal-setup-")),
			"record.tsv",
		);
		recordFiles.push(recordFile);
		process.env.BOBBIT_TEST_RECORD_SETUP = recordFile;

		await runGoalSetup({
			...baseOpts,
			command: "  setup.sh  ",
			exec: async () => { /* no-op */ },
		});

		const contents = fs.readFileSync(recordFile, "utf-8").trim();
		// Format: goal\t<goalId>\t<cwd>\t<SOURCE_REPO>\t<command>
		assert.equal(contents, ["goal", "goal-123", "/wt/branch-x/app", "/repo", "setup.sh"].join("\t"));
	});

	it("does not write an audit line for a blank command", async () => {
		const recordFile = path.join(
			fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-goal-setup-")),
			"record.tsv",
		);
		recordFiles.push(recordFile);
		process.env.BOBBIT_TEST_RECORD_SETUP = recordFile;

		await runGoalSetup({ ...baseOpts, command: "  ", exec: async () => {} });

		assert.equal(fs.existsSync(recordFile), false, "blank command must not append an audit line");
	});
});
