import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";

import type { CommandRunner } from "../../src/server/gateway-deps.js";
import { GateStore, type GateSignal } from "../../src/server/agent/gate-store.js";
import { GoalStore, type PersistedGoal } from "../../src/server/agent/goal-store.js";
import { VerificationHarness } from "../../src/server/agent/verification-harness.js";
import type { Workflow, WorkflowGate } from "../../src/server/agent/workflow-store.js";

const START = 1_700_000_000_000;
const roleStore = Object.freeze({ get: () => undefined, getAll: () => [] });
const gitRunner: CommandRunner = {
	execFile: async (file, args) => {
		if (file === "git" && args.join(" ") === "symbolic-ref refs/remotes/origin/HEAD") {
			return { stdout: "refs/remotes/origin/main\n", stderr: "" };
		}
		throw new Error(`Unexpected command in command-template security fixture: ${file} ${args.join(" ")}`);
	},
};

test("untrusted command-template metadata fails before spawn and cannot create a marker", async () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "command-template-security-"));
	const marker = path.join(stateDir, "metadata-command-executed");
	const workflow: Workflow = {
		id: "command-template-security",
		name: "Command template security",
		description: "",
		createdAt: START,
		updatedAt: START,
		gates: [{
			id: "verify",
			name: "Verify",
			dependsOn: [],
			verify: [{ name: "Unsafe legacy command", type: "command", run: "{{agent.test_command}}" }],
		}],
	};
	const gate = workflow.gates[0] as WorkflowGate;
	const signal: GateSignal = {
		id: "command-template-security-signal",
		goalId: "command-template-security-goal",
		gateId: gate.id,
		sessionId: "team-lead",
		timestamp: START + 1,
		commitSha: "0123456789abcdef0123456789abcdef01234567",
		metadata: {
			test_command: `node -e "require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')"`,
		},
		verification: { status: "running", steps: [] },
	};
	let goalStore: GoalStore | undefined;
	let gateStore: GateStore | undefined;
	try {
		goalStore = new GoalStore(stateDir, undefined, { persistence: "json" });
		goalStore.put({
			id: signal.goalId,
			title: "Command template security",
			cwd: stateDir,
			state: "in-progress",
			spec: "",
			createdAt: START,
			updatedAt: START,
			workflowId: workflow.id,
			workflow,
			enabledOptionalSteps: [],
		} satisfies PersistedGoal);
		gateStore = new GateStore(stateDir, undefined, { persistence: "json" });
		gateStore.initGatesForGoal(signal.goalId, [gate.id]);
		const projectContextManager = {
			getContextForGoal: (goalId: string) => goalId === signal.goalId ? {
				goalStore,
				gateStore,
				project: { id: "command-template-security-project", name: "Command template security" },
				goalManager: { resolveRootMaxConcurrentChildren: () => 3 },
			} : undefined,
		};
		const harness = new VerificationHarness(
			stateDir, gateStore, () => undefined, roleStore as any,
			undefined, undefined, undefined, undefined, projectContextManager as any, undefined,
			{ commandRunner: gitRunner },
		);
		signal.verification.steps = harness.beginVerification(signal, gate);
		gateStore.recordSignal(signal);

		await harness.verifyGateSignal(signal, gate, stateDir);

		assert.equal(fs.existsSync(marker), false, "signal metadata must never reach a shell command");
		const recorded = gateStore.getGate(signal.goalId, gate.id)?.signals.at(-1)?.verification;
		assert.equal(recorded?.status, "failed");
		assert.match(recorded?.steps[0]?.output ?? "", /unsafe command template variable \{\{agent\.test_command\}\}/i);
	} finally {
		await Promise.allSettled([goalStore, gateStore]
			.filter((store): store is GoalStore | GateStore => store !== undefined)
			.map(store => store.close()));
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});
