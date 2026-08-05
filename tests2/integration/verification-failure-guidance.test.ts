import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import type { CommandRunner } from "../../src/server/gateway-deps.js";
import { GateStore, type GateSignal } from "../../src/server/agent/gate-store.js";
import { GoalStore, type PersistedGoal } from "../../src/server/agent/goal-store.js";
import { VerificationHarness } from "../../src/server/agent/verification-harness.js";
import type { Workflow, WorkflowGate } from "../../src/server/agent/workflow-store.js";
import { createFakeVerificationCommandRunner } from "../harness/fake-verification-command-runner.js";

const GOAL_ID = "failure-guidance-frozen-goal";
const GATE_ID = "implementation";
const START_TIME = 1_700_000_000_000;
const FROZEN_GUIDANCE = "Inspect the **frozen** diagnostic first.\nRe-run only this command.";
const MUTATED_GUIDANCE = "MUTATED TEMPLATE GUIDANCE MUST NOT BE USED";
const VERIFIER_OUTPUT = "runtime verifier output must stay retained";

const frozenWorkflow = {
	id: "failure-guidance-workflow",
	name: "Failure guidance workflow",
	description: "Frozen notification guidance integration fixture.",
	gates: [{
		id: GATE_ID,
		name: "Implementation",
		dependsOn: [],
		verify: [{
			name: "Focused tests",
			type: "command",
			run: `node -e "console.error('${VERIFIER_OUTPUT}');process.exit(1)"`,
			failureGuidance: FROZEN_GUIDANCE,
		}],
	}],
	createdAt: START_TIME,
	updatedAt: START_TIME,
} as unknown as Workflow;

const runtimeGate = {
	...frozenWorkflow.gates[0],
	verify: [{
		name: "Focused tests",
		type: "command",
		run: `node -e "console.error('${VERIFIER_OUTPUT}');process.exit(1)"`,
		failureGuidance: MUTATED_GUIDANCE,
	}],
} as unknown as WorkflowGate;

const fakeGitRunner: CommandRunner = {
	execFile: async (file, args) => {
		if (file === "git" && args.join(" ") === "symbolic-ref refs/remotes/origin/HEAD") {
			return { stdout: "refs/remotes/origin/main\n", stderr: "" };
		}
		throw new Error(`Unexpected command in failure-guidance fixture: ${file} ${args.join(" ")}`);
	},
};

const roleStore = Object.freeze({ get: () => undefined, getAll: () => [] });

test("live failure notification uses guidance from the reloaded frozen goal workflow", async () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "failure-guidance-integration-"));
	try {
		const initialGoalStore = new GoalStore(stateDir);
		const goal: PersistedGoal = {
			id: GOAL_ID,
			title: "Frozen failure guidance",
			cwd: stateDir,
			state: "in-progress",
			spec: "Prove notifications use the frozen workflow snapshot.",
			createdAt: START_TIME,
			updatedAt: START_TIME,
			workflowId: frozenWorkflow.id,
			workflow: frozenWorkflow,
			enabledOptionalSteps: [],
		};
		initialGoalStore.put(goal);
		await initialGoalStore.flush();

		// Reload from disk to exercise the persisted frozen snapshot rather than
		// sharing the authored workflow object with the live verifier.
		const goalStore = new GoalStore(stateDir);
		expect((goalStore.get(GOAL_ID)?.workflow?.gates[0].verify?.[0] as any)?.failureGuidance).toBe(FROZEN_GUIDANCE);

		const gateStore = new GateStore(stateDir);
		gateStore.initGatesForGoal(GOAL_ID, [GATE_ID]);
		const context = {
			goalStore,
			gateStore,
			projectConfigStore: undefined,
			project: { id: "failure-guidance-project", name: "Failure Guidance" },
			goalManager: { resolveRootMaxConcurrentChildren: () => 3 },
		};
		const projectContextManager = {
			getContextForGoal: (goalId: string) => goalId === GOAL_ID ? context : undefined,
		};
		const harness = new VerificationHarness(
			stateDir,
			gateStore,
			() => undefined,
			roleStore as any,
			undefined,
			undefined,
			undefined,
			undefined,
			projectContextManager as any,
			undefined,
			{
				commandRunner: fakeGitRunner,
				commandStepRunner: createFakeVerificationCommandRunner(),
			},
		);
		const notifications: string[] = [];
		harness.setTeamLeadNotifier((_goalId, message) => notifications.push(message));

		const signal: GateSignal = {
			id: "failure-guidance-signal",
			goalId: GOAL_ID,
			gateId: GATE_ID,
			sessionId: "failure-guidance-team-lead",
			timestamp: START_TIME + 1,
			commitSha: "0123456789abcdef0123456789abcdef01234567",
			content: "Implementation ready for verification.",
			verification: { status: "running", steps: [] },
		};
		signal.verification.steps = harness.beginVerification(signal, runtimeGate);
		gateStore.recordSignal(signal);

		await harness.verifyGateSignal(signal, runtimeGate, stateDir);

		expect(notifications).toHaveLength(1);
		const message = notifications[0];
		const inspectIndex = message.indexOf('gate_inspect(gate_id="implementation", section="verification", step="Focused tests", mode="tail", lines=120)');
		const guidanceIndex = message.indexOf(FROZEN_GUIDANCE);
		expect(inspectIndex).toBeGreaterThanOrEqual(0);
		expect(guidanceIndex).toBeGreaterThan(inspectIndex);
		expect(message).toContain("**Workflow remediation guidance**");
		expect(message).not.toContain(MUTATED_GUIDANCE);
		expect(message).not.toContain(VERIFIER_OUTPUT);
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});
