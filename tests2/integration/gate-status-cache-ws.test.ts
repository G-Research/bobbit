import { describe, expect, it } from "vitest";
import path from "node:path";
import { GateStore } from "../../src/server/agent/gate-store.js";
import { GoalStore } from "../../src/server/agent/goal-store.js";
import {
	broadcastGateStatusChanged,
	wireGateStatusGenerationInvalidation,
	type GateStatusChangedEvent,
} from "../../src/server/gate-status-broadcast.js";
import { createManualClock, type ManualClock } from "../harness/clock.js";
import { createMemFs } from "../harness/mem-fs.js";

// Preserve the migrated Playwright declaration identity without importing the
// gateway-backed compatibility harness.
const test = Object.assign(it, { describe });

class FakeSocketSubscriber {
	readonly messages: GateStatusChangedEvent[] = [];

	constructor(private readonly clock: ManualClock) {}

	send(payload: string): void {
		this.clock.setTimeout(() => {
			this.messages.push(JSON.parse(payload) as GateStatusChangedEvent);
		}, 0);
	}
}

class FakeGoalEventHub {
	private readonly subscribers = new Map<string, Set<FakeSocketSubscriber>>();

	subscribe(goalId: string, subscriber: FakeSocketSubscriber): void {
		const goalSubscribers = this.subscribers.get(goalId) ?? new Set<FakeSocketSubscriber>();
		goalSubscribers.add(subscriber);
		this.subscribers.set(goalId, goalSubscribers);
	}

	readonly broadcast = (goalId: string, event: GateStatusChangedEvent): void => {
		const payload = JSON.stringify(event);
		for (const subscriber of this.subscribers.get(goalId) ?? []) subscriber.send(payload);
	};
}

test.describe("Gate status WebSocket broadcast", () => {
	test("gate_status_changed is broadcast when a gate passes", () => {
		const memfs = createMemFs();
		const stateDir = path.resolve("/memfs/gate-status-cache-ws");
		memfs.mkdirSync(stateDir, { recursive: true });
		const gateStore = new GateStore(stateDir, memfs);
		const goalStore = new GoalStore(stateDir, memfs);
		const clock = createManualClock(1_700_000_000_000);
		const hub = new FakeGoalEventHub();
		const matchingSocket = new FakeSocketSubscriber(clock);
		const unrelatedSocket = new FakeSocketSubscriber(clock);
		const goalId = "goal-gate-status-broadcast";
		const gateId = "design-doc";

		hub.subscribe(goalId, matchingSocket);
		hub.subscribe("another-goal", unrelatedSocket);
		wireGateStatusGenerationInvalidation(gateStore, goalStore);
		gateStore.initGatesForGoal(goalId, [gateId]);
		const generationBeforePass = goalStore.getGeneration();

		gateStore.updateGateStatus(goalId, gateId, "passed");
		const event = broadcastGateStatusChanged(hub.broadcast, goalId, gateId, "passed");

		// The production GateStore callback invalidates conditional goal-list
		// reads synchronously; socket delivery is then driven without a real wait.
		expect(goalStore.getGeneration()).toBe(generationBeforePass + 1);
		expect(gateStore.getGate(goalId, gateId)?.status).toBe("passed");
		expect(matchingSocket.messages).toEqual([]);
		clock.advance(0);

		expect(event).toEqual({ type: "gate_status_changed", goalId, gateId, status: "passed" });
		expect(matchingSocket.messages).toEqual([event]);
		expect(unrelatedSocket.messages).toEqual([]);
	});
});
