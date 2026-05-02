/**
 * Phase 2 — child goal worktree branches off parent.branch HEAD, NOT
 * origin/master / the worktree pool.
 *
 * Cases:
 *   1. setupWorktree on a child goal whose parent has its own branch with
 *      one extra commit creates the child branch with that commit visible
 *      in `git log child..parent` → empty (i.e. child is a descendant).
 *   2. setupWorktree on a top-level goal (no parentGoalId) uses the
 *      existing default behaviour (off master / origin/master).
 *   3. _resolveChildBaseBranch (via behaviour): when a child has
 *      parentGoalId set, the worktree pool is bypassed even when one is
 *      wired up. Indirect verification: poolResolver returns a stub pool
 *      whose `claim` should NOT be called for the child, only for the
 *      root.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import { GoalStore } from "../src/server/agent/goal-store.ts";
import { GoalManager } from "../src/server/agent/goal-manager.ts";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore } from "../src/server/agent/workflow-store.ts";

const execFile = promisify(execFileCb);

let tmpRoot: string;
let primary: string;
let stateDir: string;
let configDir: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await execFile("git", args, { cwd, timeout: 30_000 });
	return stdout.toString();
}

async function commitFile(cwd: string, file: string, contents: string, msg: string): Promise<void> {
	fs.writeFileSync(path.join(cwd, file), contents);
	await git(cwd, "add", file);
	await git(cwd, "commit", "-m", msg);
}

beforeEach(async () => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "create-child-base-"));
	primary = path.join(tmpRoot, "primary");
	stateDir = path.join(tmpRoot, "state");
	configDir = path.join(tmpRoot, "config");
	fs.mkdirSync(primary);
	fs.mkdirSync(stateDir);
	fs.mkdirSync(configDir);
	fs.writeFileSync(path.join(configDir, "project.yaml"), yaml.stringify({}));

	await git(primary, "init", "--initial-branch=master");
	await git(primary, "config", "user.email", "test@example.com");
	await git(primary, "config", "user.name", "Test");
	await git(primary, "config", "commit.gpgsign", "false");
	await commitFile(primary, "seed.txt", "seed\n", "seed");

	process.env.BOBBIT_TEST_NO_PUSH = "1";
});

afterEach(() => {
	delete process.env.BOBBIT_TEST_NO_PUSH;
	try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function makeManager(): { gm: GoalManager; store: GoalStore } {
	const goalStore = new GoalStore(stateDir);
	const cfg = new ProjectConfigStore(configDir);
	const wf = new InlineWorkflowStore(cfg);
	wf.setBuiltins([{
		id: "general", name: "General", description: "",
		gates: [{ id: "g", name: "G", dependsOn: [] }],
		createdAt: 0, updatedAt: 0,
	}]);
	return { gm: new GoalManager(goalStore, wf), store: goalStore };
}

describe("GoalManager.createGoal — child uses parent.branch as baseBranch", () => {
	it("child worktree branches off parent.branch HEAD (sees parent's commits)", async () => {
		const { gm, store } = makeManager();

		// Create root goal + setup its worktree off master.
		const root = await gm.createGoal("Root", primary, { workflowId: "general" });
		assert.ok(root.branch?.startsWith("goal/"));
		await gm.setupWorktree(root.id);
		const rootGoal = store.get(root.id)!;
		const rootWt = rootGoal.worktreePath!;
		assert.ok(fs.existsSync(rootWt), `root worktree should exist: ${rootWt}`);

		// Add a commit on the root branch — sentinel the child must see.
		await commitFile(rootWt, "root-only.txt", "from root\n", "root commit");
		const rootTip = (await git(rootWt, "rev-parse", "HEAD")).trim();

		// Create child with parentGoalId = root.id and setup its worktree.
		const child = await gm.createGoal("Child", primary, {
			workflowId: "general",
			parentGoalId: root.id,
		});
		assert.equal(child.parentGoalId, root.id);
		await gm.setupWorktree(child.id);
		const childGoal = store.get(child.id)!;
		const childWt = childGoal.worktreePath!;
		assert.ok(fs.existsSync(childWt), `child worktree should exist: ${childWt}`);

		// Sentinel file from the root commit MUST exist in the child
		// worktree — proves the branch was based on parent.branch HEAD.
		assert.ok(fs.existsSync(path.join(childWt, "root-only.txt")),
			"child worktree must contain the parent's pre-spawn commit");

		// And: the child branch should be a descendant of the root tip.
		// `git merge-base --is-ancestor <root-tip> HEAD` returns 0 (yes).
		const childTip = (await git(childWt, "rev-parse", "HEAD")).trim();
		assert.equal(childTip, rootTip,
			"child should start at exactly the root branch tip");
	});

	it("top-level goal (no parentGoalId) uses default startPoint (off master)", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", primary, { workflowId: "general" });
		await gm.setupWorktree(root.id);

		const wt = store.get(root.id)!.worktreePath!;
		const log = (await git(wt, "log", "--oneline", "-5")).trim();
		// Single commit "seed" — proves no extra ancestry.
		assert.match(log, /seed/);
	});

	it("child goals SKIP the worktree pool (pool.claim never invoked for them)", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", primary, { workflowId: "general" });
		await gm.setupWorktree(root.id);

		// Wire a stub pool that records every claim.
		const claimCalls: string[] = [];
		gm.setPoolResolver(() => ({
			claim: async (branchName: string) => {
				claimCalls.push(branchName);
				// Returning null forces fallback to createWorktree.
				return null;
			},
		} as any));

		// Child goal — pool.claim must NOT be invoked.
		const child = await gm.createGoal("Child", primary, {
			workflowId: "general",
			parentGoalId: root.id,
		});
		await gm.setupWorktree(child.id);
		assert.deepEqual(claimCalls, [],
			"pool.claim must NOT be called for child goals (pre-builds off master, would lose parent commits)");

		// And the child's worktree must exist (fallback path ran).
		const childWt = store.get(child.id)!.worktreePath!;
		assert.ok(fs.existsSync(childWt), `child worktree should exist via fallback: ${childWt}`);
	});
});
