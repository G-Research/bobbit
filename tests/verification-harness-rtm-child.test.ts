/**
 * Runtime safety net: `verifyGateSignal` rewrites a child goal's
 * `ready-to-merge` verify[] on the fly even when the on-disk workflow
 * snapshot still carries the root-only `Master merged into branch` /
 * `PR raised` steps.
 *
 * We drive the harness with mocks and capture the commands handed to
 * `runCommandStep` — a rewrite shows up there as an `echo 'child goal —…'`
 * line.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "verif-rtm-child-test-"));
fs.mkdirSync(path.join(TEST_DIR, "state"), { recursive: true });
process.env.BOBBIT_DIR = TEST_DIR;

const { VerificationHarness } = await import("../src/server/agent/verification-harness.ts");

function makeGateStore() {
	return {
		getGate: (_g: string, _gateId: string) => ({ signals: [] }),
		updateSignalVerification: () => {},
		updateGateStatus: () => {},
	};
}

function makeProjectContextManager(goalsById: Record<string, any>) {
	const gateStore = makeGateStore();
	return {
		getContextForGoal: (goalId: string) => {
			if (!goalsById[goalId]) return null;
			return {
				goalStore: { get: (id: string) => goalsById[id] },
				gateStore,
				project: { id: "p" },
				projectConfigStore: {
					getWithDefaults: () => ({}),
					getComponents: () => [],
				},
			};
		},
	};
}

function makeRoleStore() {
	return { get: () => null, getAll: () => [] };
}

const ROOT_RTM_VERIFY = [
	{ name: "Branch pushed to remote", type: "command", run: "git push origin {{branch}}:refs/heads/{{branch}} && git ls-remote --heads origin {{branch}} | grep -q ." },
	{ name: "Master merged into branch", type: "command", run: "git fetch origin master && git merge origin/master --no-edit" },
	{ name: "PR raised", type: "command", run: "gh pr view {{branch}}" },
];

function buildHarness(goalsById: Record<string, any>) {
	const broadcasts: any[] = [];
	const broadcastFn = (_goalId: string, event: any) => broadcasts.push(event);
	const pcm = makeProjectContextManager(goalsById);
	const harness = new VerificationHarness(
		path.join(TEST_DIR, "state"),
		makeGateStore() as any,
		broadcastFn,
		makeRoleStore() as any,
		undefined,
		undefined,
		undefined,
		undefined,
		pcm as any,
	);
	const runCalls: string[] = [];
	(harness as any).runCommandStep = async (cmd: string) => {
		runCalls.push(cmd);
		return { passed: true, output: cmd };
	};
	(harness as any).notifyTeamLead = () => {};
	const gateStoreCalls: any[] = [];
	(harness as any).resolveGateStore = () => ({
		getGate: () => ({ signals: [] }),
		updateSignalVerification: (id: string, payload: any) => { gateStoreCalls.push({ id, payload }); },
		updateGateStatus: () => {},
	});
	return { harness, broadcasts, runCalls, gateStoreCalls };
}

describe("verifyGateSignal — runtime safety net for child ready-to-merge", () => {
	it("rewrites verify[] when goal.mergeTarget === 'parent' and parent.branch is set", async () => {
		const goalsById = {
			child: {
				id: "child",
				branch: "goal/child-x",
				mergeTarget: "parent",
				parentGoalId: "parent",
				sandboxed: false,
				enabledOptionalSteps: [],
			},
			parent: {
				id: "parent",
				branch: "goal/parent-x",
				mergeTarget: "master",
				sandboxed: false,
				enabledOptionalSteps: [],
			},
		};
		const { harness, runCalls, gateStoreCalls } = buildHarness(goalsById);

		const gate = {
			id: "ready-to-merge",
			name: "Ready to Merge",
			dependsOn: ["execution"],
			verify: ROOT_RTM_VERIFY,
		};
		const signal = {
			id: "sig-1",
			goalId: "child",
			gateId: "ready-to-merge",
			commitSha: "abc",
			metadata: {},
		};

		await (harness as any).verifyGateSignal(
			signal,
			gate,
			"/tmp",
			"goal/child-x",
			"master",
			undefined,
			"",
		);

		if (runCalls.length === 0) {
			assert.fail(
				`runCommandStep was never invoked. gateStoreCalls=${JSON.stringify(gateStoreCalls)}`,
			);
		}

		// The "Master merged into branch" command should now be the echo step,
		// not the original `git fetch origin master && git merge ...`.
		assert.ok(
			runCalls.some(c => c.startsWith("echo 'child goal —") && c.includes("goal/parent-x")),
			`Expected an echo step referencing parent branch; got: ${JSON.stringify(runCalls)}`,
		);
		// The original master-merge command must NOT have been executed.
		assert.ok(
			!runCalls.some(c => c.includes("git fetch origin master")),
			`Original master-merge command leaked through: ${JSON.stringify(runCalls)}`,
		);
		// PR raised should also be rewritten.
		assert.ok(
			runCalls.some(c => c === "echo 'child goal — only the root goal raises a PR'"),
			`Expected the PR-no-op echo; got: ${JSON.stringify(runCalls)}`,
		);
		// "Branch pushed to remote" is NOT rewritten — should still execute the
		// original push command (template substitution leaves `goal/child-x`).
		assert.ok(
			runCalls.some(c => c.includes("git push origin")),
			`Expected the original branch-push command; got: ${JSON.stringify(runCalls)}`,
		);
	});

	it("does NOT rewrite for a root goal (mergeTarget !== 'parent')", async () => {
		const goalsById = {
			root: {
				id: "root",
				branch: "goal/root-x",
				mergeTarget: "master",
				sandboxed: false,
				enabledOptionalSteps: [],
			},
		};
		const { harness, runCalls, gateStoreCalls } = buildHarness(goalsById);

		const gate = {
			id: "ready-to-merge",
			name: "Ready to Merge",
			dependsOn: ["execution"],
			verify: ROOT_RTM_VERIFY,
		};
		const signal = {
			id: "sig-2",
			goalId: "root",
			gateId: "ready-to-merge",
			commitSha: "abc",
			metadata: {},
		};

		await (harness as any).verifyGateSignal(
			signal,
			gate,
			"/tmp",
			"goal/root-x",
			"master",
			undefined,
			"",
		);

		if (runCalls.length === 0) {
			assert.fail(
				`runCommandStep was never invoked (root). gateStoreCalls=${JSON.stringify(gateStoreCalls)}`,
			);
		}

		// Root goal — original commands should run, no echo rewrite.
		assert.ok(
			runCalls.some(c => c.includes("git fetch origin master")),
			`Expected original master-merge for root; got: ${JSON.stringify(runCalls)}`,
		);
		assert.ok(
			runCalls.some(c => c.includes("gh pr view")),
			`Expected original PR-view for root; got: ${JSON.stringify(runCalls)}`,
		);
		assert.ok(
			!runCalls.some(c => c.startsWith("echo 'child goal —")),
			`Echo rewrite leaked into root goal: ${JSON.stringify(runCalls)}`,
		);
	});
});
