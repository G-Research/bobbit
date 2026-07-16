import path from "node:path";
import { expect, test } from "vitest";

import { GateStore, type GateSignal } from "../../src/server/agent/gate-store.js";
import type { WorkflowGate } from "../../src/server/agent/workflow-store.js";
import {
	buildRunningGateSignalResponse,
	reuseCachedGateSignal,
	type CachedGateSignalNotifier,
} from "../../src/server/gate-signal-response.js";
import { createManualClock, type ManualClock } from "../harness/clock.js";
import { createMemFs } from "../harness/mem-fs.js";

const DO_NOT_POLL_PATTERN = /Verification is running asynchronously|Do not poll|gate_status|gate_inspect|Go idle|wait for the server/i;
const GOAL_ID = "gate-signal-reminder-goal";
const GATE_ID = "cached-gate";
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
const START_TIME = 1_700_000_000_000;

const gate: WorkflowGate = {
	id: GATE_ID,
	name: "Cached Gate",
	dependsOn: [],
	verify: [{ name: "Fast cached verification", type: "command", run: "echo cache-seed" }],
};

type Notification =
	| { type: "signal"; goalId: string; gateId: string; signalId: string }
	| { type: "complete"; goalId: string; gateId: string; signalId: string; status: "passed" }
	| { type: "status"; goalId: string; gateId: string; status: "passed" };

function makeNotifier(notifications: Notification[]): CachedGateSignalNotifier {
	return {
		signalReceived: (goalId, gateId, signalId) => notifications.push({ type: "signal", goalId, gateId, signalId }),
		verificationComplete: (goalId, gateId, signalId, status) => notifications.push({ type: "complete", goalId, gateId, signalId, status }),
		statusChanged: (goalId, gateId, status) => notifications.push({ type: "status", goalId, gateId, status }),
	};
}

function signal(overrides: Partial<GateSignal> = {}): GateSignal {
	return {
		id: "running-signal",
		gateId: GATE_ID,
		goalId: GOAL_ID,
		sessionId: "session-owner",
		timestamp: START_TIME,
		commitSha: COMMIT_SHA,
		verification: {
			status: "running",
			steps: [{
				name: "Fast cached verification",
				type: "command",
				status: "running",
				passed: false,
				output: "",
				duration_ms: 0,
				phase: 0,
			}],
		},
		...overrides,
	};
}

function expectUiSignalShapePreserved(body: any, expected: { goalId: string; gateId: string; status: string; stepNames: string[] }): void {
	expect(body.signal, "GATE_SIGNAL_AGENT_REMINDER: response must keep the top-level signal object for existing UI renderers").toBeTruthy();
	expect(Object.keys(body.signal).sort(), "GATE_SIGNAL_AGENT_REMINDER: signal object shape used by the UI must not grow a nested reminder field").toEqual(["gateId", "goalId", "id", "status", "steps"].sort());
	expect(body.signal.id).toEqual(expect.any(String));
	expect(body.signal.gateId).toBe(expected.gateId);
	expect(body.signal.goalId).toBe(expected.goalId);
	expect(body.signal.status).toBe(expected.status);
	expect(body.signal.steps.map((step: { name: string }) => step.name)).toEqual(expected.stepNames);
	expect(body.signal.agentReminder, "GATE_SIGNAL_AGENT_REMINDER: reminder must be top-level, never nested under signal").toBeUndefined();
}

test.describe("POST /api/goals/:goalId/gates/:gateId/signal agent reminder", () => {
	let gateStore: GateStore;
	let clock: ManualClock;
	let notifications: Notification[];
	let notifier: CachedGateSignalNotifier;

	test.beforeEach(() => {
		const memfs = createMemFs();
		const stateDir = path.resolve("/memfs/gate-signal-reminder");
		memfs.mkdirSync(stateDir, { recursive: true });
		gateStore = new GateStore(stateDir, memfs);
		gateStore.initGatesForGoal(GOAL_ID, [GATE_ID]);
		clock = createManualClock(START_TIME);
		notifications = [];
		notifier = makeNotifier(notifications);
	});

	test("async verification response includes top-level agentReminder while preserving the UI signal shape", () => {
		const runningSignal = signal();
		gateStore.recordSignal(runningSignal);

		const body = buildRunningGateSignalResponse(runningSignal, true);

		expectUiSignalShapePreserved(body, {
			goalId: GOAL_ID,
			gateId: GATE_ID,
			status: "running",
			stepNames: ["Fast cached verification"],
		});
		expect(Object.keys(body), "GATE_SIGNAL_AGENT_REMINDER: agent reminder must be a top-level sibling after signal").toEqual(["signal", "agentReminder"]);
		expect(body.agentReminder, "GATE_SIGNAL_AGENT_REMINDER: async signal response should tell agents not to poll").toEqual(expect.any(String));
		expect(body.agentReminder).toMatch(/Gate signal accepted/i);
		expect(body.agentReminder).toMatch(/Verification is running asynchronously/i);
		expect(body.agentReminder).toMatch(/Do not poll/i);
		expect(body.agentReminder).toMatch(/gate_status/);
		expect(body.agentReminder).toMatch(/gate_inspect/);
		expect(body.agentReminder).toMatch(/Go idle now/i);
	});

	test("cached pass response does not include the async wait reminder", () => {
		const passedSignal = signal({
			id: "authored-passed-signal",
			verification: {
				status: "passed",
				steps: [{
					name: "Fast cached verification",
					type: "command",
					status: "passed",
					passed: true,
					output: "cache-seed",
					duration_ms: 4,
				}],
			},
		});
		gateStore.recordSignal(passedSignal);
		gateStore.updateGateStatus(GOAL_ID, GATE_ID, "passed");
		clock.advance(25);

		const body = reuseCachedGateSignal({
			gateStore,
			goalId: GOAL_ID,
			gate,
			commitSha: COMMIT_SHA,
			body: { sessionId: "cache-requester", content: "approved", metadata: { verdict: "pass" } },
			notifier,
			clock,
			createSignalId: () => "cached-response-signal",
		});

		expect(body?.signal, "GATE_SIGNAL_AGENT_REMINDER: cached response must still include the signal object").toBeTruthy();
		expect(body?.signal.id).toBe("cached-response-signal");
		expect(body?.signal.gateId).toBe(GATE_ID);
		expect(body?.signal.goalId).toBe(GOAL_ID);
		expect(body?.signal.status).toBe("passed");
		expect(body?.signal.cached).toBe(true);
		expect(body?.signal.steps.map((step) => step.name)).toEqual(["Fast cached verification"]);
		expect((body?.signal as any).agentReminder, "GATE_SIGNAL_AGENT_REMINDER: reminder must not be nested under signal on cached responses").toBeUndefined();
		expect(String(body?.agentReminder ?? ""), "GATE_SIGNAL_AGENT_REMINDER: cached/pass responses must not instruct agents to wait for async verification").not.toMatch(DO_NOT_POLL_PATTERN);

		const storedGate = gateStore.getGate(GOAL_ID, GATE_ID);
		const cachedSignal = storedGate?.signals.at(-1);
		expect(storedGate).toMatchObject({
			status: "passed",
			currentContent: "approved",
			currentContentVersion: 1,
			currentMetadata: { verdict: "pass" },
		});
		expect(cachedSignal).toMatchObject({
			id: "cached-response-signal",
			sessionId: "cache-requester",
			timestamp: START_TIME + 25,
			commitSha: COMMIT_SHA,
			verification: {
				status: "passed",
				steps: [{
					name: "Fast cached verification",
					status: "passed",
					phase: 0,
					output: "[cached from prior signal] cache-seed",
				}],
			},
		});
		expect(notifications).toEqual([
			{ type: "signal", goalId: GOAL_ID, gateId: GATE_ID, signalId: "cached-response-signal" },
			{ type: "complete", goalId: GOAL_ID, gateId: GATE_ID, signalId: "cached-response-signal", status: "passed" },
			{ type: "status", goalId: GOAL_ID, gateId: GATE_ID, status: "passed" },
		]);
	});
});
