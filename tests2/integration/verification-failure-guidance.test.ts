import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import type { CommandRunner } from "../../src/server/gateway-deps.js";
import { GateStore, type GateSignal } from "../../src/server/agent/gate-store.js";
import { GoalStore, type PersistedGoal } from "../../src/server/agent/goal-store.js";
import { buildVerificationFailureMessage } from "../../src/server/agent/notify-team-lead-failure.js";
import { VerificationHarness } from "../../src/server/agent/verification-harness.js";
import type { Workflow, WorkflowGate } from "../../src/server/agent/workflow-store.js";
import { createFakeVerificationCommandRunner } from "../harness/fake-verification-command-runner.js";

const GATE_ID = "implementation";
const START_TIME = 1_700_000_000_000;
const FROZEN_GUIDANCE = "Inspect the **frozen** diagnostic first.\nRe-run only this command.";
const MUTATED_GUIDANCE = "MUTATED TEMPLATE GUIDANCE MUST NOT BE USED";
const VERIFIER_OUTPUT = "runtime verifier output must stay retained";
const SYNTHETIC_ERROR = "synthetic harness setup failure";

const fakeGitRunner: CommandRunner = {
	execFile: async (file, args) => {
		if (file === "git" && args.join(" ") === "symbolic-ref refs/remotes/origin/HEAD") {
			return { stdout: "refs/remotes/origin/main\n", stderr: "" };
		}
		throw new Error(`Unexpected command in failure-guidance fixture: ${file} ${args.join(" ")}`);
	},
};

const roleStore = Object.freeze({ get: () => undefined, getAll: () => [] });

function workflowFor(goalId: string, stepName: string, failureGuidance: string): Workflow {
	return {
		id: `failure-guidance-workflow-${goalId}`,
		name: "Failure guidance workflow",
		description: "Frozen notification guidance integration fixture.",
		gates: [{
			id: GATE_ID,
			name: "Implementation",
			dependsOn: [],
			verify: [{
				name: stepName,
				type: "command",
				run: `node -e "console.error('${VERIFIER_OUTPUT}');process.exit(1)"`,
				failureGuidance,
			}],
		}],
		createdAt: START_TIME,
		updatedAt: START_TIME,
	} as unknown as Workflow;
}

async function runFailureNotification(options: {
	goalId: string;
	stepName: string;
	projectConfigStore?: unknown;
}): Promise<{ message: string; persistedGuidance: string | undefined }> {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "failure-guidance-integration-"));
	let initialGoalStore: GoalStore | undefined;
	let goalStore: GoalStore | undefined;
	let gateStore: GateStore | undefined;
	try {
		const frozenWorkflow = workflowFor(options.goalId, options.stepName, FROZEN_GUIDANCE);
		const runtimeWorkflow = workflowFor(options.goalId, options.stepName, MUTATED_GUIDANCE);
		const runtimeGate = runtimeWorkflow.gates[0] as WorkflowGate;
		initialGoalStore = new GoalStore(stateDir, undefined, { persistence: "json" });
		const goal: PersistedGoal = {
			id: options.goalId,
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
		await initialGoalStore.close();
		initialGoalStore = undefined;

		// Reload from disk so notification lookup exercises the persisted frozen
		// snapshot rather than sharing the runtime verifier's workflow object.
		goalStore = new GoalStore(stateDir, undefined, { persistence: "json" });
		const persistedGuidance = goalStore.get(options.goalId)?.workflow?.gates[0].verify?.[0]?.failureGuidance;
		gateStore = new GateStore(stateDir, undefined, { persistence: "json" });
		gateStore.initGatesForGoal(options.goalId, [GATE_ID]);
		const context = {
			goalStore,
			gateStore,
			projectConfigStore: options.projectConfigStore,
			project: { id: "failure-guidance-project", name: "Failure Guidance" },
			goalManager: { resolveRootMaxConcurrentChildren: () => 3 },
		};
		const projectContextManager = {
			getContextForGoal: (goalId: string) => goalId === options.goalId ? context : undefined,
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
			id: `failure-guidance-signal-${options.goalId}`,
			goalId: options.goalId,
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
		return { message: notifications[0], persistedGuidance };
	} finally {
		await Promise.allSettled([initialGoalStore, goalStore, gateStore]
			.filter((store): store is GoalStore | GateStore => store !== undefined)
			.map(store => store.close()));
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
}

test("a genuine command step named Error receives guidance from the reloaded frozen workflow", async () => {
	const { message, persistedGuidance } = await runFailureNotification({
		goalId: "failure-guidance-real-error-goal",
		stepName: "Error",
	});

	expect(persistedGuidance).toBe(FROZEN_GUIDANCE);
	const inspectIndex = message.indexOf('gate_inspect(gate_id="implementation", section="verification", step="Error", mode="tail", lines=120)');
	const guidanceIndex = message.indexOf(FROZEN_GUIDANCE);
	expect(inspectIndex).toBeGreaterThanOrEqual(0);
	expect(guidanceIndex).toBeGreaterThan(inspectIndex);
	expect(message).toContain("**Workflow remediation guidance**");
	expect(message).not.toContain(MUTATED_GUIDANCE);
	expect(message).not.toContain(VERIFIER_OUTPUT);
});

test("a synthetic harness Error collision stays unaligned with authored workflow guidance", async () => {
	const { message, persistedGuidance } = await runFailureNotification({
		goalId: "failure-guidance-synthetic-error-goal",
		stepName: "Error",
		projectConfigStore: {
			getWithDefaults: () => { throw new Error(SYNTHETIC_ERROR); },
		},
	});

	expect(persistedGuidance).toBe(FROZEN_GUIDANCE);
	expect(message).toBe(buildVerificationFailureMessage(GATE_ID, [{
		name: "Error",
		type: "command",
		passed: false,
		status: "failed",
		output: SYNTHETIC_ERROR,
	}]));
	expect(message).not.toContain("Workflow remediation guidance");
	expect(message).not.toContain(FROZEN_GUIDANCE);
	expect(message).not.toContain(MUTATED_GUIDANCE);
});
