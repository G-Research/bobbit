import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";

import { GateStore, type GateSignal } from "../../src/server/agent/gate-store.ts";
import { goalBranchContainer, resolveStep } from "../../src/server/agent/verification-harness.ts";
import { buildStepCache } from "../../src/server/agent/verification-logic.ts";
import { computeVerificationContentDigest } from "../../src/server/agent/verification-content-digest.ts";
import { reuseCachedGateSignal } from "../../src/server/gate-signal-response.ts";
import type { CommandRunner } from "../../src/server/gateway-deps.ts";
import type { Component } from "../../src/server/agent/project-config-store.ts";
import type { WorkflowGate } from "../../src/server/agent/workflow-store.ts";
import { createMemFs } from "../harness/mem-fs.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
const GATE_ID = "verify";
const gate: WorkflowGate = {
	id: GATE_ID,
	name: "Verify",
	dependsOn: [],
	verify: [{ name: "component check", type: "command", component: "app", command: "check" }],
};

function inventoryRunner(trackedByRoot: Map<string, string[]>): CommandRunner {
	return {
		execFile: async (file, args) => {
			assert.equal(file, "git");
			assert.equal(args[0], "-C");
			const tracked = trackedByRoot.get(path.resolve(String(args[1])));
			if (!tracked) throw new Error(`unexpected worktree: ${args[1]}`);
			return { stdout: args.includes("--cached") ? `${tracked.join("\0")}\0` : "", stderr: "" };
		},
	};
}

function passedSignal(goalId: string, id: string, contentDigest: GateSignal["contentDigest"]): GateSignal {
	return {
		id,
		gateId: GATE_ID,
		goalId,
		sessionId: "session",
		timestamp: 1,
		commitSha: COMMIT_SHA,
		contentDigest,
		verification: {
			status: "passed",
			steps: [{ name: "component check", type: "command", passed: true, status: "passed", output: "ok", duration_ms: 1 }],
		},
	};
}

const notifier = {
	signalReceived() {},
	verificationComplete() {},
	statusChanged() {},
};

describe("nested goal content-digest cache isolation", () => {
	it("uses the child branch container after mutation and reports both cache misses", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "bobbit-nested-digest-"));
		roots.push(root);
		const parentWorktree = path.join(root, "parent-worktree");
		const childWorktree = path.join(root, "child-worktree");
		const source = path.join("packages", "app", "source.ts");
		await Promise.all([mkdir(path.join(parentWorktree, "packages", "app"), { recursive: true }), mkdir(path.join(childWorktree, "packages", "app"), { recursive: true })]);
		await Promise.all([
			writeFile(path.join(parentWorktree, source), "export const value = 'before';\n"),
			writeFile(path.join(childWorktree, source), "export const value = 'before';\n"),
		]);

		const runner = inventoryRunner(new Map([
			[parentWorktree, [source]],
			[childWorktree, [source]],
		]));
		const childGoal = { worktreePath: childWorktree, cwd: path.join(childWorktree, "packages", "app") };
		assert.equal(goalBranchContainer(childGoal), childWorktree, "nested child digest root must be its own branch container");
		const parentDigest = await computeVerificationContentDigest(parentWorktree, runner);
		const beforeDigest = await computeVerificationContentDigest(goalBranchContainer(childGoal), runner);
		assert.equal(parentDigest.digest, beforeDigest.digest, "parent and child begin at the same commit content in separate worktrees");

		const parentStore = new GateStore("/memfs/nested-parent", createMemFs());
		const childStore = new GateStore("/memfs/nested-child", createMemFs());
		parentStore.initGatesForGoal("parent", [GATE_ID]);
		childStore.initGatesForGoal("child", [GATE_ID]);
		parentStore.recordSignal(passedSignal("parent", "parent-pass", parentDigest));
		childStore.recordSignal(passedSignal("child", "child-pass", beforeDigest));

		await writeFile(path.join(childWorktree, source), "export const value = 'after';\n");
		const afterDigest = await computeVerificationContentDigest(goalBranchContainer(childGoal), runner);
		assert.notEqual(afterDigest.digest, beforeDigest.digest, "child mutation must change the child witness despite the shared commit SHA");
		assert.equal((await computeVerificationContentDigest(parentWorktree, runner)).digest, parentDigest.digest, "the parent worktree must not stand in for the child worktree");

		const wholeGate = reuseCachedGateSignal({
			gateStore: childStore,
			goalId: "child",
			gate,
			commitSha: COMMIT_SHA,
			contentDigest: afterDigest,
			notifier,
		});
		assert.equal(wholeGate.response, undefined);
		assert.equal(wholeGate.missReason, "content-digest-mismatch");
		assert.deepEqual(wholeGate.priorSignalIds, ["child-pass"]);

		const stepCache = buildStepCache(
			childStore.getGate("child", GATE_ID)?.signals ?? [],
			"new-child-signal",
			COMMIT_SHA,
			afterDigest,
		);
		assert.equal(stepCache.steps.size, 0);
		assert.equal(stepCache.missReason, "content-digest-mismatch");
		assert.deepEqual(stepCache.priorSignalIds, ["child-pass"]);

		const components: Component[] = [{ name: "app", repo: ".", relativePath: "packages/app", commands: { check: "echo ok" } }];
		const resolved = resolveStep(gate.verify![0], components, goalBranchContainer(childGoal));
		assert.equal(resolved.cwd, path.join(childWorktree, "packages", "app"), "component relativePath must be applied once from the child branch root");
		assert.ok(!resolved.cwd.endsWith(path.join("packages", "app", "packages", "app")));
	});
});
