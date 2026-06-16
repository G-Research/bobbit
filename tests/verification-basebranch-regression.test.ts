import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { VerificationHarness } = await import("../src/server/agent/verification-harness.js");

function makeTempStateDir(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "verif-basebranch-regression-"));
	const stateDir = path.join(root, "state");
	fs.mkdirSync(stateDir, { recursive: true });
	return stateDir;
}

function makeProjectConfigStore(baseRef: string) {
	return {
		get: (key: string) => key === "base_ref" ? baseRef : "",
		getWithDefaults: () => ({
			build_command: "npm run build",
			test_command: "npm test",
			typecheck_command: "npm run check",
			test_unit_command: "npm run test:unit",
			test_e2e_command: "npm run test:e2e",
			base_ref: baseRef,
		}),
		getComponents: () => [],
	};
}

function makeGateStore(signal: any) {
	const gateState: any = {
		goalId: signal.goalId,
		gateId: signal.gateId,
		status: "pending",
		signals: [signal],
	};
	return {
		getGate: () => gateState,
		getGatesForGoal: () => [gateState],
		updateSignalVerification: (signalId: string, verification: any) => {
			const target = gateState.signals.find((s: any) => s.id === signalId);
			assert.ok(target, `test fixture missing signal ${signalId}`);
			target.verification = verification;
		},
		updateGateStatus: (_goalId: string, _gateId: string, status: string) => {
			gateState.status = status;
		},
		_gateState: gateState,
	};
}

function makeHarnessFixture(baseRef = "origin/master") {
	const signal = {
		id: "signal-basebranch",
		goalId: "goal-basebranch",
		gateId: "ready-to-merge",
		sessionId: "session-basebranch",
		timestamp: Date.now(),
		commitSha: "abcdef1234567890",
		content: "ready",
		metadata: {},
	};
	const gateStore = makeGateStore(signal);
	const goal = {
		id: signal.goalId,
		branch: "goal/basebranch-regression",
		cwd: process.cwd(),
		worktreePath: process.cwd(),
		spec: "Reproduce baseBranch verification regression",
		state: "in-progress",
		workflowId: "feature",
	};
	const projectConfigStore = makeProjectConfigStore(baseRef);
	const projectContextManager = {
		getContextForGoal: (goalId: string) => goalId === signal.goalId ? {
			project: { id: "project-basebranch" },
			goalStore: { get: (id: string) => id === signal.goalId ? goal : undefined },
			gateStore,
			projectConfigStore,
		} : null,
	};
	const harness = new VerificationHarness(
		makeTempStateDir(),
		undefined,
		() => {},
		{ get: () => null, getAll: () => [] } as any,
		undefined,
		undefined,
		undefined,
		projectConfigStore as any,
		projectContextManager as any,
	);
	return { harness, signal, gateStore, goal };
}

test("ready-to-merge command templates resolve {{baseBranch}} from configured origin/master and execute", async () => {
	const { harness, signal, gateStore } = makeHarnessFixture("origin/master");
	let executedCommand: string | null = null;
	(harness as any).runCommandStep = async (command: string) => {
		executedCommand = command;
		return { passed: true, output: `executed ${command}` };
	};

	await harness.verifyGateSignal(
		signal as any,
		{
			id: "ready-to-merge",
			name: "Ready to Merge",
			dependsOn: [],
			verify: [{
				name: "Base branch must be normalized",
				type: "command",
				run: "node -e \"process.exit(process.argv[1] === 'master' ? 0 : 42)\" {{baseBranch}}",
			}],
		} as any,
		process.cwd(),
		undefined,
		"develop",
		new Map(),
		"Reproduce baseBranch verification regression",
	);

	const verification = gateStore._gateState.signals[0].verification;
	assert.ok(
		executedCommand,
		`BASE_BRANCH_REPRO: ready-to-merge command did not execute; {{baseBranch}} remained unresolved and was skipped. Verification output: ${verification?.steps?.[0]?.output ?? "<none>"}`,
	);
	assert.match(
		executedCommand,
		/\bmaster\b/,
		`BASE_BRANCH_REPRO: expected {{baseBranch}} to normalize project base_ref origin/master to bare branch "master", got command: ${executedCommand}`,
	);
	assert.doesNotMatch(
		executedCommand,
		/origin\/master|\bdevelop\b|\{\{baseBranch\}\}/,
		`BASE_BRANCH_REPRO: {{baseBranch}} must use normalized configured base_ref, not origin/master, detected primary, or an unresolved template. Command: ${executedCommand}`,
	);
	assert.equal(verification?.status, "passed");
});

test("rerun verification context includes {{baseBranch}} from configured base_ref", async () => {
	const { harness, signal, gateStore } = makeHarnessFixture("origin/develop");
	gateStore._gateState.signals[0] = {
		...signal,
		verification: {
			status: "passed",
			steps: [{ name: "old", type: "command", passed: true, output: "ok", duration_ms: 1 }],
		},
	};

	const context = await (harness as any)._gatherRerunContext(signal.goalId, signal.gateId, signal.id);
	assert.ok(context, "BASE_BRANCH_REPRO: expected rerun context to resolve");
	assert.equal(
		context.builtinVars.baseBranch,
		"develop",
		`BASE_BRANCH_REPRO: rerun builtinVars must include baseBranch="develop" from base_ref origin/develop, got ${JSON.stringify(context.builtinVars)}`,
	);
	assert.equal(
		context.builtinVars.master,
		"develop",
		`BASE_BRANCH_REPRO: legacy {{master}} alias should follow configured base_ref origin/develop in rerun context, got ${JSON.stringify(context.builtinVars)}`,
	);
});
