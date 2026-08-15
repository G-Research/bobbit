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
			return { stdout: Buffer.from(args.includes("--cached") ? `${tracked.join("\0")}\0` : ""), stderr: "" };
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
		// Git's `ls-files -z` inventory is POSIX-separated on every platform.
		const source = "packages/app/source.ts";
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

	it("does not reuse a nested child's v2 cache entry when only a sibling repository commit changes", () => {
		const store = new GateStore("/memfs/nested-child-v2", createMemFs());
		store.initGatesForGoal("child", [GATE_ID]);
		const digest = { algorithm: "sha256" as const, version: 1 as const, digest: "d".repeat(64), fileCount: 2 };
		const apiCommit = "1".repeat(40);
		const priorWebCommit = "2".repeat(40);
		const changedWebCommit = "3".repeat(40);
		const v2 = (id: string, webCommit: string, status: "passed" | "running"): GateSignal => ({
			...passedSignal("child", id, digest),
			verification: status === "passed"
				? { status, steps: [{ name: "component check", type: "command", passed: true, status: "passed", output: "ok", duration_ms: 1 }] }
				: { status, steps: [] },
			// Keep the aggregate digest deliberately equal: repository commits are
			// still part of a v2 identity, so an unchanged byte witness cannot let
			// the child reuse a cache entry for a changed sibling repository.
			pinnedCheckout: {
				version: 2,
				layout: "multi-repo",
				contentDigest: digest,
				repositories: [
					{ repoKey: "services/api", commitSha: apiCommit, contentDigest: digest },
					{ repoKey: "apps/web", commitSha: webCommit, contentDigest: digest },
				],
			} as any,
		}) as GateSignal;
		const prior = v2("child-v2-pass", priorWebCommit, "passed");
		const current = v2("child-v2-current", changedWebCommit, "running");
		store.recordSignal(prior);
		store.recordSignal(current);

		const cache = buildStepCache(
			store.getGate("child", GATE_ID)?.signals ?? [],
			current.id,
			current.commitSha,
			digest,
		);
		assert.equal(cache.steps.size, 0, "the child's own cache must compare every v2 repository identity, not just the display SHA or aggregate digest");
		assert.equal(cache.missReason, "pinned-checkout-mismatch");
		assert.deepEqual(cache.priorSignalIds, [prior.id]);
	});
});
