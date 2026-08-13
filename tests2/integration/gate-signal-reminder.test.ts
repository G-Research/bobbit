import { existsSync } from "node:fs";
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
const CONTENT_DIGEST = { algorithm: "sha256" as const, version: 1 as const, digest: "a".repeat(64), fileCount: 1 };
const V2_REPOSITORIES = [
	{ repoKey: "apps/web", commitSha: "b".repeat(40) },
	{ repoKey: "services/api", commitSha: "c".repeat(40) },
] as const;
// This suite deliberately shares one virtual volume. A real-fs fallback in a
// reopened store would otherwise let a delayed writer escape test isolation.
const memfs = createMemFs();
let stateSequence = 0;

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
		contentDigest: CONTENT_DIGEST,
		pinnedCheckout: { version: 1, commitSha: COMMIT_SHA, contentDigest: CONTENT_DIGEST },
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
	let stateDir: string;
	let clock: ManualClock;
	let notifications: Notification[];
	let notifier: CachedGateSignalNotifier;

	test.beforeEach(() => {
		stateDir = path.resolve("/memfs/gate-signal-reminder", String(++stateSequence));
		memfs.mkdirSync(stateDir, { recursive: true });
		gateStore = new GateStore(stateDir, memfs, { persistence: "json" });
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
			contentDigest: CONTENT_DIGEST,
			currentPinnedCheckout: { version: 1 },
			body: { sessionId: "cache-requester", content: "approved", metadata: { verdict: "pass" } },
			notifier,
			clock,
			createSignalId: () => "cached-response-signal",
		}).response;

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
			pinnedCheckout: { version: 1, commitSha: COMMIT_SHA, contentDigest: CONTENT_DIGEST },
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

	test("refuses whole-gate cache reuse for a same-SHA content mismatch", () => {
		gateStore.recordSignal(signal({
			id: "prior-pass",
			verification: { status: "passed", steps: [{
				name: "Fast cached verification", type: "command", status: "passed", passed: true, output: "ok", duration_ms: 1,
			}] },
		}));
		const decision = reuseCachedGateSignal({
			gateStore, goalId: GOAL_ID, gate, commitSha: COMMIT_SHA,
			contentDigest: { ...CONTENT_DIGEST, digest: "b".repeat(64) }, notifier,
		});
		expect(decision.response).toBeUndefined();
		expect(decision.missReason).toBe("content-digest-mismatch");
		expect(decision.priorSignalIds).toEqual(["prior-pass"]);
		expect(gateStore.getGate(GOAL_ID, GATE_ID)?.signals).toHaveLength(1);
	});

	test("requires a matching current component witness before reusing v2 whole-gate evidence", () => {
		const v2Pass = signal({
			id: "v2-pass",
			pinnedCheckout: {
				version: 2,
				layout: "multi-repo",
				contentDigest: CONTENT_DIGEST,
				repositories: V2_REPOSITORIES.map(repository => ({ ...repository, contentDigest: CONTENT_DIGEST })),
			},
			verification: { status: "passed", steps: [] },
		});
		gateStore.recordSignal(v2Pass);

		const common = { gateStore, goalId: GOAL_ID, gate, commitSha: COMMIT_SHA, contentDigest: CONTENT_DIGEST, notifier };
		expect(reuseCachedGateSignal(common).missReason, "v2 evidence must never reuse without a live component witness").toBe("pinned-checkout-mismatch");
		expect(reuseCachedGateSignal({
			...common,
			currentPinnedCheckout: { version: 2, repositories: [{ ...V2_REPOSITORIES[0], commitSha: "d".repeat(40) }, V2_REPOSITORIES[1]] },
		}).missReason, "a changed component commit must reject matching aggregate bytes").toBe("pinned-checkout-mismatch");
		expect(reuseCachedGateSignal({
			...common,
			currentPinnedCheckout: { version: 2, repositories: V2_REPOSITORIES },
			createSignalId: () => "v2-cached-response",
		}).response?.signal.cached, "the exact ordered v2 witness remains cacheable").toBe(true);
	});

	test("refuses whole-gate cache reuse across v1 and v2 layout transitions", async () => {
		const v1Pass = signal({ id: "v1-pass", verification: { status: "passed", steps: [] } });
		gateStore.recordSignal(v1Pass);
		expect(reuseCachedGateSignal({
			gateStore, goalId: GOAL_ID, gate, commitSha: COMMIT_SHA, contentDigest: CONTENT_DIGEST, notifier,
			currentPinnedCheckout: { version: 2, repositories: V2_REPOSITORIES },
		}).missReason).toBe("pinned-checkout-mismatch");
		expect(reuseCachedGateSignal({
			gateStore, goalId: GOAL_ID, gate, commitSha: COMMIT_SHA, contentDigest: CONTENT_DIGEST, notifier,
			currentPinnedCheckout: { layout: "multi-unavailable" },
		}).missReason, "an unreadable authoritative multi-repo layout cannot fall back to v1 evidence").toBe("pinned-checkout-mismatch");

		const v2ToV1StateDir = path.resolve(stateDir, "v2-to-v1");
		memfs.mkdirSync(v2ToV1StateDir, { recursive: true });
		gateStore = new GateStore(v2ToV1StateDir, memfs);
		gateStore.initGatesForGoal(GOAL_ID, [GATE_ID]);
		const v2Pass = signal({
			id: "v2-pass",
			pinnedCheckout: { version: 2, layout: "multi-repo", contentDigest: CONTENT_DIGEST, repositories: V2_REPOSITORIES.map(repository => ({ ...repository, contentDigest: CONTENT_DIGEST })) },
			verification: { status: "passed", steps: [] },
		});
		gateStore.recordSignal(v2Pass);
		await gateStore.flush();
		const virtualStoreFile = path.join(v2ToV1StateDir, "gates.json");
		expect(memfs.existsSync(virtualStoreFile), "the reopened v2→v1 store must flush into the suite virtual filesystem").toBe(true);
		expect(existsSync(virtualStoreFile), "the reopened v2→v1 store must never create a real state file").toBe(false);
		expect(reuseCachedGateSignal({
			gateStore, goalId: GOAL_ID, gate, commitSha: COMMIT_SHA, contentDigest: CONTENT_DIGEST, notifier,
			currentPinnedCheckout: { version: 1 },
		}).missReason).toBe("pinned-checkout-mismatch");
		await Promise.resolve();
		expect(existsSync(virtualStoreFile), "no post-flush teardown writer may escape to the real filesystem").toBe(false);
	});

	test("refuses whole-gate cache reuse when the current digest cannot be computed", () => {
		gateStore.recordSignal(signal({
			id: "prior-pass",
			verification: { status: "passed", steps: [{
				name: "Fast cached verification", type: "command", status: "passed", passed: true, output: "ok", duration_ms: 1,
			}] },
		}));
		const decision = reuseCachedGateSignal({
			gateStore, goalId: GOAL_ID, gate, commitSha: COMMIT_SHA,
			contentDigestError: { code: "VERIFICATION_CONTENT_DIGEST_FAILED", message: "Unable to compute verification content digest" }, notifier,
		});
		expect(decision.response).toBeUndefined();
		expect(decision.missReason).toBe("content-digest-unavailable");
		expect(decision.priorSignalIds).toEqual(["prior-pass"]);
		expect(gateStore.getGate(GOAL_ID, GATE_ID)?.signals).toHaveLength(1);
		expect(gateStore.getGate(GOAL_ID, GATE_ID)?.status).toBe("pending");
		expect(notifications).toEqual([]);
	});

	test("reports mismatch when a valid prior digest differs beside a legacy pass", () => {
		const legacyPass = signal({
			id: "legacy-pass",
			verification: { status: "passed", steps: [] },
		});
		delete legacyPass.contentDigest;
		gateStore.recordSignal(legacyPass);
		gateStore.recordSignal(signal({
			id: "changed-pass",
			contentDigest: { ...CONTENT_DIGEST, digest: "b".repeat(64) },
			verification: { status: "passed", steps: [] },
		}));
		const decision = reuseCachedGateSignal({
			gateStore, goalId: GOAL_ID, gate, commitSha: COMMIT_SHA, contentDigest: CONTENT_DIGEST, notifier,
		});
		expect(decision.response).toBeUndefined();
		expect(decision.missReason).toBe("content-digest-mismatch");
		expect(decision.priorSignalIds).toEqual(["legacy-pass", "changed-pass"]);
		expect(gateStore.getGate(GOAL_ID, GATE_ID)?.signals).toHaveLength(2);
	});

	test("fails closed when a matching passed signal lacks a pinned attestation", () => {
		const legacyPass = signal({ id: "legacy-pass", verification: { status: "passed", steps: [] } });
		delete legacyPass.pinnedCheckout;
		gateStore.recordSignal(legacyPass);

		const decision = reuseCachedGateSignal({
			gateStore, goalId: GOAL_ID, gate, commitSha: COMMIT_SHA, contentDigest: CONTENT_DIGEST, notifier,
		});
		expect(decision.response).toBeUndefined();
		expect(decision.missReason).toBe("pinned-checkout-mismatch");
		expect(decision.priorSignalIds).toEqual(["legacy-pass"]);
	});

	test("reports unavailable when a matching passed signal records a pinned checkout failure", () => {
		const unavailablePass = signal({ id: "unavailable-pass", verification: { status: "passed", steps: [] } });
		unavailablePass.pinnedCheckoutError = {
			code: "PINNED_CHECKOUT_UNREADABLE",
			message: "Pinned checkout could not be read",
		};
		delete unavailablePass.pinnedCheckout;
		gateStore.recordSignal(unavailablePass);

		const decision = reuseCachedGateSignal({
			gateStore, goalId: GOAL_ID, gate, commitSha: COMMIT_SHA, contentDigest: CONTENT_DIGEST, notifier,
		});
		expect(decision.response).toBeUndefined();
		expect(decision.missReason).toBe("pinned-checkout-unavailable");
		expect(decision.priorSignalIds).toEqual(["unavailable-pass"]);
	});
});
