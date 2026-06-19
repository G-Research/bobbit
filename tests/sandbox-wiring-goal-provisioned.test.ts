/**
 * Regression: sandboxed worktree provisioning must dispatch `goalProvisioned`.
 *
 * `SessionManager.applySandboxWiring()` creates the actual worktree for a
 * sandboxed team lead / member inside the container via
 * `ProjectSandbox.createWorktree(...)`. team-manager deliberately skips its own
 * `dispatchGoalProvisionedForWorktree` for sandboxed members (no host
 * worktreeResult), and the session-setup provisioning dispatch never runs for
 * container worktrees — so without a dispatch HERE, metadata-driven filesystem
 * treatments would be missing on every sandboxed agent worktree.
 *
 * This test pins that applySandboxWiring fires `goalProvisioned` for the actual
 * container worktree with the resolved effective metadata, the offset-applied
 * cwd, and the branch. No Docker required — the sandbox + stores are stubbed.
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "../src/server/agent/session-manager.js";
import { makeTmpDir } from "./helpers/tmp.js";

describe("applySandboxWiring — goalProvisioned dispatch for the container worktree", () => {
	function setup(): { sm: any; restoreEnv: () => void; dispatchSpy: ReturnType<typeof mock.fn> } {
		const stateRoot = makeTmpDir("sandbox-wiring-");
		const prevBobbitDir = process.env.BOBBIT_DIR;
		process.env.BOBBIT_DIR = stateRoot;
		const stateDir = path.join(stateRoot, "state");
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(path.join(stateDir, "gateway-url"), "https://127.0.0.1:3001\n");
		fs.writeFileSync(path.join(stateDir, "token"), "admin-token\n");

		const sm: any = new SessionManager();
		// Sandbox config = docker so applySandboxWiring proceeds.
		sm.projectConfigStore = {
			get: (key: string) => (key === "sandbox" ? "docker" : undefined),
			getSandboxTokens: () => [],
		};
		sm.preferencesStore = undefined;
		sm.projectContextManager = null;
		sm.sandboxTokenStore = null;

		const sandbox = {
			getContainerId: async () => "container-xyz",
			createWorktree: mock.fn(async () => "/workspace-branches/goal-g1-coder-x"),
		};
		sm.sandboxManager = {
			ensureForProject: async () => {},
			get: () => sandbox,
		};

		// Spy on the shared dispatcher so we assert the call without needing a
		// real LifecycleHub. The production code reuses this single resolver +
		// dispatcher — no ad-hoc ancestry walk in applySandboxWiring.
		const dispatchSpy = mock.fn(async () => {});
		sm.dispatchGoalProvisionedForWorktree = dispatchSpy;

		const restoreEnv = () => {
			if (prevBobbitDir === undefined) delete process.env.BOBBIT_DIR;
			else process.env.BOBBIT_DIR = prevBobbitDir;
		};
		return { sm, restoreEnv, dispatchSpy };
	}

	it("dispatches goalProvisioned for the created sandbox worktree with offset cwd + branch", async () => {
		const { sm, restoreEnv, dispatchSpy } = setup();
		try {
			const bridgeOptions: any = { env: {} };
			const ok = await sm.applySandboxWiring(bridgeOptions, "sess-lead", {
				projectId: "proj-1",
				goalId: "goal-g1",
				sandboxBranch: "goal/g1/coder-x",
				sandboxBaseBranch: "origin/goal/g1",
				sandboxCwdOffset: "packages/app",
			});
			assert.equal(ok, true, "wiring should succeed for a docker sandbox");

			assert.equal(dispatchSpy.mock.calls.length, 1, "goalProvisioned must be dispatched exactly once");
			const arg = dispatchSpy.mock.calls[0].arguments[0];
			assert.equal(arg.goalId, "goal-g1");
			assert.equal(arg.projectId, "proj-1");
			assert.equal(arg.branch, "goal/g1/coder-x");
			// worktreePath is the raw container worktree path returned by createWorktree.
			assert.equal(arg.worktreePath, "/workspace-branches/goal-g1-coder-x");
			// cwd applies the repo-relative offset onto the container worktree path,
			// matching the cwd the agent will boot with (and bridgeOptions.cwd).
			assert.equal(arg.cwd, "/workspace-branches/goal-g1-coder-x/packages/app");
			assert.equal(bridgeOptions.cwd, arg.cwd, "dispatch cwd must match the agent's boot cwd");
		} finally {
			restoreEnv();
		}
	});

	it("does not dispatch when no sandbox branch is provided (no worktree created)", async () => {
		const { sm, restoreEnv, dispatchSpy } = setup();
		try {
			const bridgeOptions: any = { env: {}, cwd: "/some/host/path" };
			const ok = await sm.applySandboxWiring(bridgeOptions, "sess-plain", {
				projectId: "proj-1",
				goalId: "goal-g1",
				// no sandboxBranch — regular no-worktree session
			});
			assert.equal(ok, true);
			assert.equal(dispatchSpy.mock.calls.length, 0, "no worktree ⇒ no goalProvisioned dispatch");
		} finally {
			restoreEnv();
		}
	});
});
