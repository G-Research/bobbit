/**
 * VER-07 — parallelize LLM reviews off the command-suite critical path.
 *
 * Behind `BOBBIT_PARALLEL_REVIEWS=1` (default OFF), `llm-review` steps in the
 * leading contiguous review-only phase (e.g. phase 2 in the built-in
 * general/feature/bug-fix workflows) are started concurrently with the
 * command phases (Build/typecheck/unit/e2e) that precede them, instead of
 * waiting for those phases to finish. Reviews only ever read the branch diff
 * — never a same-gate command step's output — so this changes wall-clock,
 * not the review's inputs.
 *
 * Safety net: verdicts are only committed when the command track passes.
 * On command failure, the concurrently-computed review verdicts are
 * discarded and the review's session (if still running) is terminated; the
 * persisted result is the exact same "Skipped — earlier phase failed" the
 * fully-serial path would have written.
 *
 * These tests exercise `verifyGateSignal` end-to-end with:
 *   - real `command`-type steps (actual `runCommandStep` shell spawns) where
 *     ordering doesn't matter (the default-OFF serial path), and
 *   - stubbed `runCommandStep`/`runLlmReviewStep` (so no real subprocess or
 *     LLM session is spawned) wherever a test needs to pin the *interleaving*
 *     of the command track and the early-started review. Interleaving is
 *     controlled with explicit deferreds (a command/review "step" only
 *     resolves when the test tells it to) rather than real sleeps + wall-clock
 *     margins — the former VER-07 tests raced a real `sleep 0.1`/`sleep 0.3`
 *     shell spawn against a fixed `setTimeout`, which was flaky under load
 *     (spawn overhead routinely ate the timing margin — see
 *     docs/testing-strategy.md and the fix commit for the measured rates).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Same shape as verification-harness.ts's internal `deferred()` — lets a
 * test hold a stubbed step "open" until it explicitly decides to resolve it,
 * making interleaving assertions exact instead of timing-margin-based. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolveFn!: (value: T) => void;
	const promise = new Promise<T>((resolve) => { resolveFn = resolve; });
	return { promise, resolve: resolveFn };
}

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "verif-parallel-reviews-test-"));
fs.mkdirSync(path.join(TEST_DIR, "state"), { recursive: true });

const { VerificationHarness } = await import("../src/server/agent/verification-harness.js");
import type { GateSignal } from "../src/server/agent/gate-store.js";
import type { WorkflowGate } from "../src/server/agent/workflow-store.js";

type BroadcastEvent = { type: string; stepIndex?: number; stepName?: string; phase?: number; status?: string; sessionId?: string };

function makeHarness(events: BroadcastEvent[]) {
	const stateDir = fs.mkdtempSync(path.join(TEST_DIR, "harness-"));
	const persisted: { signalId: string; status: string; steps: any[] }[] = [];
	const gateStatuses: { goalId: string; gateId: string; status: string }[] = [];
	const stubGateStore = {
		updateSignalVerification: (signalId: string, data: { status: string; steps: any[] }) => {
			persisted.push({ signalId, status: data.status, steps: data.steps });
		},
		updateGateStatus: (goalId: string, gateId: string, status: string) => {
			gateStatuses.push({ goalId, gateId, status });
		},
		getGate: () => undefined,
	} as any;
	const roleStore = { get: () => undefined, getAll: () => [] } as any;

	const harness = new VerificationHarness(
		stateDir,
		stubGateStore,
		(_goalId: string, event: any) => { events.push(event); },
		roleStore,
		undefined, undefined, undefined, undefined, undefined, undefined,
	);
	return { harness, persisted, gateStatuses };
}

function makeSignal(commitSha: string): GateSignal {
	return {
		id: `sig-${commitSha}`,
		gateId: "implementation",
		goalId: "goal-1",
		sessionId: "s1",
		timestamp: Date.now(),
		commitSha,
		verification: { status: "running", steps: [] },
	};
}

/**
 * A three-step gate mirroring the shape of the built-in workflows:
 *   phase 0 — Build (command)
 *   phase 1 — Unit tests (command, artificially slow so we can observe
 *             whether the review started before or after it finished)
 *   phase 2 — Code quality review (llm-review, stubbed)
 */
function makeGate(unitTestsCmd: string): WorkflowGate {
	return {
		id: "implementation",
		name: "Implementation",
		verify: [
			{ name: "Build", type: "command", run: "true" },
			{ name: "Unit tests", type: "command", phase: 1, run: unitTestsCmd },
			{ name: "Code quality review", type: "llm-review", phase: 2, role: "code-reviewer", prompt: "review it" },
		],
	} as unknown as WorkflowGate;
}

function stepStartedEvents(events: BroadcastEvent[]): BroadcastEvent[] {
	return events.filter(e => e.type === "gate_verification_step_started");
}
function stepCompleteEvents(events: BroadcastEvent[]): BroadcastEvent[] {
	return events.filter(e => e.type === "gate_verification_step_complete");
}

test("BOBBIT_PARALLEL_REVIEWS unset (default OFF): review step starts strictly after the command phase completes — serial ordering pinned", async () => {
	const prevFlag = process.env.BOBBIT_PARALLEL_REVIEWS;
	delete process.env.BOBBIT_PARALLEL_REVIEWS;
	try {
		const events: BroadcastEvent[] = [];
		const { harness, persisted, gateStatuses } = makeHarness(events);
		const reviewCalls: number[] = [];
		(harness as any).runLlmReviewStep = async (...args: any[]) => {
			reviewCalls.push(Date.now());
			return { passed: true, output: "LGTM", sessionId: args[8] };
		};

		const signal = makeSignal("sha-off-1");
		const gate = makeGate("sleep 0.15 && true");
		await (harness as any).verifyGateSignal(signal, gate, TEST_DIR, undefined, "master");

		// Exact broadcast ordering pinned: phase-started/step-started/
		// step-complete triples run strictly in phase order — Build, then
		// Unit tests, then the review — with the review's step_started event
		// appearing only after Unit tests' step_complete event.
		const order = events
			.filter(e => e.type === "gate_verification_step_started" || e.type === "gate_verification_step_complete")
			.map(e => `${e.type}:${e.stepName}`);
		assert.deepEqual(order, [
			"gate_verification_step_started:Build",
			"gate_verification_step_complete:Build",
			"gate_verification_step_started:Unit tests",
			"gate_verification_step_complete:Unit tests",
			"gate_verification_step_started:Code quality review",
			"gate_verification_step_complete:Code quality review",
		], `default (flag off) must preserve strict serial ordering; got: ${JSON.stringify(order)}`);

		assert.equal(reviewCalls.length, 1, "review should run exactly once");
		assert.equal(gateStatuses.at(-1)?.status, "passed");
		assert.equal(persisted.at(-1)?.status, "passed");
		const reviewResult = persisted.at(-1)?.steps.find((s: any) => s.name === "Code quality review");
		assert.equal(reviewResult.passed, true);
		assert.equal(reviewResult.output, "LGTM");
	} finally {
		if (prevFlag === undefined) delete process.env.BOBBIT_PARALLEL_REVIEWS;
		else process.env.BOBBIT_PARALLEL_REVIEWS = prevFlag;
	}
});

test("BOBBIT_PARALLEL_REVIEWS=1: review starts concurrently with the command phase (overlaps, doesn't wait)", async () => {
	const prevFlag = process.env.BOBBIT_PARALLEL_REVIEWS;
	process.env.BOBBIT_PARALLEL_REVIEWS = "1";
	try {
		const events: BroadcastEvent[] = [];
		const { harness, persisted, gateStatuses } = makeHarness(events);

		// Unit tests is held open on a deferred instead of a real `sleep N` —
		// the test controls exactly when it resolves, so "the review started
		// while Unit tests was still running" is asserted by construction,
		// never by racing a real subprocess against a wall-clock margin.
		const unitTests = deferred<{ passed: boolean; output: string }>();
		(harness as any).runCommandStep = async (cmd: string) => {
			if (cmd === "true") return { passed: true, output: "" };
			return unitTests.promise;
		};

		let reviewInvoked = false;
		const reviewStarted = deferred<void>();
		(harness as any).runLlmReviewStep = async (...args: any[]) => {
			reviewInvoked = true;
			reviewStarted.resolve();
			return { passed: true, output: "LGTM", sessionId: args[8] };
		};

		const signal = makeSignal("sha-on-1");
		const gate = makeGate("__controlled-by-stub__");
		const verifyPromise = (harness as any).verifyGateSignal(signal, gate, TEST_DIR, undefined, "master");

		// Wait for the review to actually be invoked — proves it was kicked
		// off without waiting for the (still in-flight) Unit tests command.
		await reviewStarted.promise;
		assert.equal(reviewInvoked, true);

		const unitCompleteEarly = stepCompleteEvents(events).find(e => e.stepName === "Unit tests");
		const reviewStartedEvent = stepStartedEvents(events).find(e => e.stepName === "Code quality review");
		assert.ok(reviewStartedEvent, "Code quality review should have started");
		assert.equal(
			unitCompleteEarly, undefined,
			"Unit tests must still be in flight when the review starts — this is the overlap being pinned, not a race",
		);

		// Now let Unit tests finish (passing) and let the gate resolve fully.
		unitTests.resolve({ passed: true, output: "" });
		await verifyPromise;

		const order = events
			.filter(e => e.type === "gate_verification_step_started" || e.type === "gate_verification_step_complete")
			.map(e => `${e.type}:${e.stepName}`);
		const reviewStartIdx = order.indexOf("gate_verification_step_started:Code quality review");
		const unitCompleteIdx = order.indexOf("gate_verification_step_complete:Unit tests");
		assert.ok(reviewStartIdx >= 0 && unitCompleteIdx >= 0);
		assert.ok(
			reviewStartIdx < unitCompleteIdx,
			`expected review to start before Unit tests completed; order was: ${JSON.stringify(order)}`,
		);

		assert.equal(gateStatuses.at(-1)?.status, "passed");
		assert.equal(persisted.at(-1)?.status, "passed");
		const reviewResult = persisted.at(-1)?.steps.find((s: any) => s.name === "Code quality review");
		assert.equal(reviewResult.passed, true, "on a passing command track, the real review verdict is committed");
		assert.equal(reviewResult.output, "LGTM");
	} finally {
		if (prevFlag === undefined) delete process.env.BOBBIT_PARALLEL_REVIEWS;
		else process.env.BOBBIT_PARALLEL_REVIEWS = prevFlag;
	}
});

test("BOBBIT_PARALLEL_REVIEWS=1 + command phase fails: the early review verdict is discarded, session terminated, and persisted result matches the serial skip path exactly", async () => {
	const prevFlag = process.env.BOBBIT_PARALLEL_REVIEWS;
	process.env.BOBBIT_PARALLEL_REVIEWS = "1";
	try {
		const events: BroadcastEvent[] = [];
		const { harness, persisted, gateStatuses } = makeHarness(events);

		const terminateCalls: string[] = [];
		const terminateCalled = deferred<void>();
		(harness as any).sessionManager = {
			terminateSession: async (sessionId: string) => {
				terminateCalls.push(sessionId);
				terminateCalled.resolve();
				return true;
			},
		};

		// Unit tests is held open on a deferred (instead of a real
		// `sleep 0.1 && false`) so the test decides exactly when the command
		// track fails. The review is likewise held open on a deferred
		// (instead of a real `setTimeout(250)`) so the test — not the OS
		// scheduler — decides exactly when it "would have" resolved. This
		// replaces the former timestamp-margin assertion (which flaked under
		// load when subprocess-spawn overhead ate the 50ms margin) with a
		// strictly-ordered proof: the session is torn down BEFORE the review
		// is ever allowed to resolve, full stop — no race, no margin.
		const unitTests = deferred<{ passed: boolean; output: string }>();
		(harness as any).runCommandStep = async (cmd: string) => {
			if (cmd === "true") return { passed: true, output: "" };
			return unitTests.promise;
		};

		let reviewResolved = false;
		const reviewInFlight = deferred<void>();
		const releaseReview = deferred<{ passed: boolean; output: string }>();
		(harness as any).runLlmReviewStep = async (...args: any[]) => {
			reviewInFlight.resolve();
			const result = await releaseReview.promise;
			reviewResolved = true;
			return { ...result, sessionId: args[8] };
		};

		const signal = makeSignal("sha-fail-1");
		const gate = makeGate("__controlled-by-stub__");
		const verifyPromise = (harness as any).verifyGateSignal(signal, gate, TEST_DIR, undefined, "master");

		// Let the review actually start before failing Unit tests, so the
		// discard genuinely races a review that is in flight.
		await reviewInFlight.promise;

		// Fail Unit tests now that the review is confirmed running.
		unitTests.resolve({ passed: false, output: "unit tests failed" });

		// The reviewer session must be torn down as soon as the command
		// track's failure is discovered.
		await terminateCalled.promise;
		assert.equal(
			reviewResolved, false,
			"the review must still be unresolved when its session is torn down — proves the discard doesn't wait for (or depend on) the review's real verdict",
		);

		// Only now let the (now-irrelevant) review settle, so
		// verifyGateSignal can finish joining the discarded promise.
		releaseReview.resolve({ passed: true, output: "Would have passed" });
		await verifyPromise;

		assert.equal(gateStatuses.at(-1)?.status, "failed");
		const finalSteps = persisted.at(-1)?.steps ?? [];
		const reviewResult = finalSteps.find((s: any) => s.name === "Code quality review");
		assert.ok(reviewResult, "review step should be present in the final persisted signal");
		assert.equal(reviewResult.status, "skipped");
		assert.equal(reviewResult.passed, false);
		assert.equal(
			reviewResult.output,
			"Skipped — earlier phase failed",
			"persisted output must match the fully-serial skip path byte-for-byte, discarding the review's real (would-have-passed) verdict",
		);

		const reviewStartedEvent = stepStartedEvents(events).find(e => e.stepName === "Code quality review");
		assert.ok(reviewStartedEvent?.sessionId, "review step_started event should carry the pre-generated sessionId");
		assert.equal(terminateCalls.length, 1, "the in-flight reviewer session should be terminated exactly once");
		assert.equal(terminateCalls[0], reviewStartedEvent!.sessionId, "the terminated session must be the one the early-started review actually used");

		// Final skip broadcast supersedes whatever transient event the early
		// start may have produced — assert the LAST event for this step is
		// the skip.
		const stepEventsForReview = events.filter(e => e.stepName === "Code quality review" && e.type === "gate_verification_step_complete");
		assert.ok(stepEventsForReview.length >= 1);
		assert.equal(stepEventsForReview.at(-1)?.status, "skipped");
	} finally {
		if (prevFlag === undefined) delete process.env.BOBBIT_PARALLEL_REVIEWS;
		else process.env.BOBBIT_PARALLEL_REVIEWS = prevFlag;
	}
});

test("BOBBIT_PARALLEL_REVIEWS=1 + command phase passes: real review verdict (a failing one) is committed, not overridden", async () => {
	const prevFlag = process.env.BOBBIT_PARALLEL_REVIEWS;
	process.env.BOBBIT_PARALLEL_REVIEWS = "1";
	try {
		const events: BroadcastEvent[] = [];
		const { harness, persisted, gateStatuses } = makeHarness(events);
		(harness as any).runLlmReviewStep = async (...args: any[]) => {
			return { passed: false, output: "Found a bug at foo.ts:12", sessionId: args[8] };
		};

		const signal = makeSignal("sha-review-fail-1");
		const gate = makeGate("sleep 0.05 && true");
		await (harness as any).verifyGateSignal(signal, gate, TEST_DIR, undefined, "master");

		assert.equal(gateStatuses.at(-1)?.status, "failed", "gate overall status reflects the real review failure");
		const reviewResult = persisted.at(-1)?.steps.find((s: any) => s.name === "Code quality review");
		assert.equal(reviewResult.status, "failed");
		assert.equal(reviewResult.output, "Found a bug at foo.ts:12", "the real verdict is committed verbatim when the command track passed");
	} finally {
		if (prevFlag === undefined) delete process.env.BOBBIT_PARALLEL_REVIEWS;
		else process.env.BOBBIT_PARALLEL_REVIEWS = prevFlag;
	}
});
