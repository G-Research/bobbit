/**
 * Phase 2 — `GoalManager.mergeChild`
 *
 * Wraps `mergeChildBranchLocal` from `skills/git.ts` and best-effort pushes
 * the parent branch to origin. Cases covered:
 *
 *   1. Clean mergeChild → returns merged=true. Push is gated by
 *      BOBBIT_TEST_NO_PUSH=1 (no remote in the fixture) so `pushed` is
 *      false and `pushError` is undefined.
 *   2. parentGoalId mismatch → throws structured `PARENT_MISMATCH` error.
 *      Security: prevents cross-tree merges.
 *   3. Already-merged child → returns alreadyMerged=true.
 *
 * Tests use a real temp git repo with a primary directory + parent and child
 * worktrees. The parent goal record's `worktreePath` points at the parent
 * worktree, the child's `branch` is the child worktree's branch.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import { GoalStore, type PersistedGoal } from "../src/server/agent/goal-store.ts";
import { GoalManager } from "../src/server/agent/goal-manager.ts";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore } from "../src/server/agent/workflow-store.ts";

const execFile = promisify(execFileCb);

let tmpRoot: string;
let primary: string;
let parentWt: string;
let childWt: string;
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

async function setupRepoFixture(): Promise<void> {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "merge-child-mgr-"));
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

	parentWt = path.join(tmpRoot, "parent-wt");
	childWt = path.join(tmpRoot, "child-wt");
	await git(primary, "worktree", "add", "-b", "goal/parent", parentWt, "master");
	await git(primary, "worktree", "add", "-b", "goal/child", childWt, "goal/parent");
	await git(parentWt, "config", "commit.gpgsign", "false");
	await git(childWt, "config", "commit.gpgsign", "false");
}

function makeManager(): { gm: GoalManager; store: GoalStore } {
	const goalStore = new GoalStore(stateDir);
	const cfg = new ProjectConfigStore(configDir);
	const wf = new InlineWorkflowStore(cfg);
	wf.setBuiltins([{
		id: "general",
		name: "General",
		description: "",
		gates: [{ id: "g", name: "G", dependsOn: [] }],
		createdAt: 0, updatedAt: 0,
	}]);
	const gm = new GoalManager(goalStore, wf);
	return { gm, store: goalStore };
}

function persistedGoal(over: Partial<PersistedGoal>): PersistedGoal {
	const now = Date.now();
	return {
		id: over.id ?? "g",
		title: over.title ?? "G",
		cwd: over.cwd ?? primary,
		state: over.state ?? "in-progress",
		spec: "",
		createdAt: now,
		updatedAt: now,
		...over,
	};
}

beforeEach(async () => {
	await setupRepoFixture();
	// All tests in this file run with no remote configured, but be belt-and-
	// braces: skip remote pushes via the env flag too.
	process.env.BOBBIT_TEST_NO_PUSH = "1";
});

afterEach(() => {
	delete process.env.BOBBIT_TEST_NO_PUSH;
	try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("GoalManager.mergeChild", () => {
	it("clean mergeChild → merged=true, push skipped via BOBBIT_TEST_NO_PUSH", async () => {
		const { gm, store } = makeManager();
		store.put(persistedGoal({
			id: "parent", title: "Parent", branch: "goal/parent",
			worktreePath: parentWt, repoPath: primary,
			rootGoalId: "parent", mergeTarget: "master",
		}));
		store.put(persistedGoal({
			id: "child", title: "Child", branch: "goal/child",
			worktreePath: childWt, repoPath: primary,
			parentGoalId: "parent", rootGoalId: "parent", mergeTarget: "parent",
		}));
		// Add a commit on the child so there's something to merge.
		await commitFile(childWt, "feature.txt", "child\n", "feat: child work");

		const outcome = await gm.mergeChild("parent", "child");
		assert.equal(outcome.merged, true);
		assert.equal(outcome.alreadyMerged, false);
		assert.equal(outcome.conflict, false);
		assert.equal(outcome.pushed, false, "BOBBIT_TEST_NO_PUSH=1 → push must be skipped");
		assert.equal(outcome.pushError, undefined);

		// Parent worktree should now contain the merge commit.
		const log = await git(parentWt, "log", "--pretty=%P", "-1");
		const parents = log.trim().split(/\s+/);
		assert.equal(parents.length, 2, "must be a true --no-ff merge commit");
	});

	it("alreadyMerged child → returns alreadyMerged=true on second invocation", async () => {
		const { gm, store } = makeManager();
		store.put(persistedGoal({
			id: "p2", title: "P", branch: "goal/parent",
			worktreePath: parentWt, repoPath: primary,
			rootGoalId: "p2", mergeTarget: "master",
		}));
		store.put(persistedGoal({
			id: "c2", title: "C", branch: "goal/child",
			worktreePath: childWt, repoPath: primary,
			parentGoalId: "p2", rootGoalId: "p2", mergeTarget: "parent",
		}));
		await commitFile(childWt, "feature.txt", "child\n", "feat: child work");

		const first = await gm.mergeChild("p2", "c2");
		assert.equal(first.merged, true);

		const second = await gm.mergeChild("p2", "c2");
		assert.equal(second.alreadyMerged, true);
		assert.equal(second.merged, false);
		assert.equal(second.conflict, false);
	});

	it("parentGoalId mismatch → throws PARENT_MISMATCH (cross-tree merge guard)", async () => {
		const { gm, store } = makeManager();
		store.put(persistedGoal({
			id: "p3", title: "P3", branch: "goal/parent",
			worktreePath: parentWt, repoPath: primary,
			rootGoalId: "p3", mergeTarget: "master",
		}));
		// Child claims parentGoalId === "DIFFERENT" — caller asks to merge
		// it into "p3". This must throw.
		store.put(persistedGoal({
			id: "rogue", title: "Rogue", branch: "goal/child",
			worktreePath: childWt, repoPath: primary,
			parentGoalId: "DIFFERENT", rootGoalId: "DIFFERENT", mergeTarget: "parent",
		}));
		await assert.rejects(
			() => gm.mergeChild("p3", "rogue"),
			(err: any) => {
				assert.equal(err.code, "PARENT_MISMATCH");
				assert.match(err.message, /expected "p3"/);
				return true;
			},
		);
	});

	it("missing child throws clearly", async () => {
		const { gm, store } = makeManager();
		store.put(persistedGoal({
			id: "p4", title: "P4", branch: "goal/parent",
			worktreePath: parentWt, repoPath: primary,
			rootGoalId: "p4", mergeTarget: "master",
		}));
		await assert.rejects(
			() => gm.mergeChild("p4", "ghost"),
			/child goal not found: ghost/,
		);
	});

	it("missing parent throws clearly", async () => {
		const { gm, store } = makeManager();
		store.put(persistedGoal({
			id: "lonely", title: "Lonely", branch: "goal/child",
			worktreePath: childWt, repoPath: primary,
			parentGoalId: "absent", rootGoalId: "absent", mergeTarget: "parent",
		}));
		await assert.rejects(
			() => gm.mergeChild("absent", "lonely"),
			/parent goal not found: absent/,
		);
	});
});
