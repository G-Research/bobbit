/**
 * S8 seam, V0+V2 — env-var vs. cascade-`VerificationPolicy` precedence at the
 * two `verifyGateSignal` call sites this slice wires (see
 * docs/design/verification-policy-seam.md §2/§6):
 *
 *   - `BOBBIT_GATE_CACHE` / `gateCacheDefault` (gate-cache mode selection)
 *   - `BOBBIT_PARALLEL_REVIEWS` / `parallelReviewsDefault` (early-start reviews)
 *
 * Contract pinned here: the env var, WHEN PRESENT (any value, including a
 * typo), is the highest-precedence override and is resolved through its
 * existing pure function (`resolveGateCacheMode` / `isParallelReviewsEnabled`)
 * exactly as before this slice — the cascade-resolved policy is consulted
 * ONLY when the env var is entirely unset. This matches design doc §2's own
 * code snippet (`process.env.X ? resolveX(process.env.X) : policy.field`)
 * rather than §6's looser prose ("any other value... falls through to the
 * policy field") — the two are inconsistent in the doc, and this file picks
 * the snippet's behavior because it's what today's code already does for
 * every currently-reachable env value (an env var set to garbage has NEVER
 * fallen through to a "policy" layer, since no such layer existed before
 * this slice); the prose's stronger claim only matters for a case
 * (garbage env + a project that has ALSO configured a non-default policy)
 * that literally cannot occur yet.
 *
 * `tests/verification-logic.test.ts` and `tests/verification-policy.test.ts`
 * cover the pure functions and the resolver/merge pair in isolation;
 * `tests/config-cascade.test.ts` covers the builtin -> server -> project
 * cascade layering. This file is the one that proves the HARNESS actually
 * wires them together at the two call sites, not just that the pieces work
 * individually.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "verif-gate-cache-policy-test-"));
fs.mkdirSync(path.join(TEST_DIR, "state"), { recursive: true });

const { VerificationHarness } = await import("../src/server/agent/verification-harness.ts");
const { DEFAULT_VERIFICATION_POLICY } = await import("../src/server/agent/verification-logic.ts");
import type { GateSignal } from "../src/server/agent/gate-store.ts";
import type { WorkflowGate } from "../src/server/agent/workflow-store.ts";
import type { VerificationPolicy } from "../src/server/agent/verification-logic.ts";

function makeHarness(policy?: VerificationPolicy) {
	const stateDir = fs.mkdtempSync(path.join(TEST_DIR, "harness-"));
	const stubGateStore = {
		updateSignalVerification: () => {},
		updateGateStatus: () => {},
		getGate: () => undefined,
	} as any;
	const roleStore = { get: () => undefined, getAll: () => [] } as any;
	const fakeCascade = policy ? { resolveVerificationPolicy: () => policy } as any : undefined;

	return new VerificationHarness(
		stateDir,
		stubGateStore,
		(_goalId: string, _event: any) => {},
		roleStore,
		undefined, undefined, undefined, undefined, undefined,
		fakeCascade,
	);
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

function makeGate(): WorkflowGate {
	return {
		id: "implementation",
		name: "Implementation",
		verify: [{ name: "Build", type: "command", run: "true" }],
	} as unknown as WorkflowGate;
}

/** Capture the `[verification][gate-cache] mode=<X> ...` line verifyGateSignal
 *  logs on every run — the most direct externally-observable signal of which
 *  gateCacheMode the precedence expression actually selected. */
async function runAndCaptureGateCacheMode(harness: any): Promise<string | undefined> {
	const originalLog = console.log;
	const lines: string[] = [];
	console.log = (...args: any[]) => { lines.push(args.map(String).join(" ")); };
	try {
		const signal = makeSignal(`sha-${Math.random().toString(36).slice(2)}`);
		const gate = makeGate();
		await harness.verifyGateSignal(signal, gate, TEST_DIR, undefined, "master");
	} finally {
		console.log = originalLog;
	}
	const line = lines.find(l => l.includes("[verification][gate-cache]"));
	return line?.match(/mode=(\w+)/)?.[1];
}

describe("resolveVerificationPolicyForGoal — direct wiring", () => {
	test("with no configCascade wired: falls back to DEFAULT_VERIFICATION_POLICY", () => {
		const harness = makeHarness() as any;
		assert.deepEqual(harness.resolveVerificationPolicyForGoal("goal-1"), DEFAULT_VERIFICATION_POLICY);
	});

	test("with a configCascade wired: delegates to configCascade.resolveVerificationPolicy", () => {
		const custom: VerificationPolicy = { ...DEFAULT_VERIFICATION_POLICY, gateCacheDefault: "content", parallelReviewsDefault: false };
		const harness = makeHarness(custom) as any;
		assert.deepEqual(harness.resolveVerificationPolicyForGoal("goal-1"), custom);
	});
});

describe("gate-cache mode: env vs. policy precedence", () => {
	test("no env, no policy configured: mode=sha (byte-identical to today's hardcoded default)", async () => {
		const prev = process.env.BOBBIT_GATE_CACHE;
		delete process.env.BOBBIT_GATE_CACHE;
		try {
			const harness = makeHarness();
			assert.equal(await runAndCaptureGateCacheMode(harness), "sha");
		} finally {
			if (prev !== undefined) process.env.BOBBIT_GATE_CACHE = prev;
		}
	});

	test("no env, policy.gateCacheDefault='content': mode=content (policy governs when env is unset)", async () => {
		const prev = process.env.BOBBIT_GATE_CACHE;
		delete process.env.BOBBIT_GATE_CACHE;
		try {
			const harness = makeHarness({ ...DEFAULT_VERIFICATION_POLICY, gateCacheDefault: "content" });
			assert.equal(await runAndCaptureGateCacheMode(harness), "content");
		} finally {
			if (prev !== undefined) process.env.BOBBIT_GATE_CACHE = prev;
		}
	});

	test("env='content', policy.gateCacheDefault='sha': mode=content (env overrides policy)", async () => {
		const prev = process.env.BOBBIT_GATE_CACHE;
		process.env.BOBBIT_GATE_CACHE = "content";
		try {
			const harness = makeHarness({ ...DEFAULT_VERIFICATION_POLICY, gateCacheDefault: "sha" });
			assert.equal(await runAndCaptureGateCacheMode(harness), "content");
		} finally {
			if (prev === undefined) delete process.env.BOBBIT_GATE_CACHE; else process.env.BOBBIT_GATE_CACHE = prev;
		}
	});

	test("env set to a typo, policy.gateCacheDefault='content': mode=sha — env PRESENCE alone routes through resolveGateCacheMode's own fail-closed default, never falling through to policy", async () => {
		const prev = process.env.BOBBIT_GATE_CACHE;
		process.env.BOBBIT_GATE_CACHE = "typo";
		try {
			const harness = makeHarness({ ...DEFAULT_VERIFICATION_POLICY, gateCacheDefault: "content" });
			assert.equal(await runAndCaptureGateCacheMode(harness), "sha");
		} finally {
			if (prev === undefined) delete process.env.BOBBIT_GATE_CACHE; else process.env.BOBBIT_GATE_CACHE = prev;
		}
	});
});

// --- Functional harness for the parallel-reviews end-to-end precedence tests ---
// Mirrors tests/verification-harness-parallel-reviews.test.ts's deferred-based
// interleaving pattern (no real sleeps/timing margins) but drives the
// (policy, env) matrix instead of only the env axis that file already covers.

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolveFn!: (value: T) => void;
	const promise = new Promise<T>((resolve) => { resolveFn = resolve; });
	return { promise, resolve: resolveFn };
}

function makeReviewGate(): WorkflowGate {
	return {
		id: "implementation",
		name: "Implementation",
		verify: [
			{ name: "Build", type: "command", run: "true" },
			{ name: "Unit tests", type: "command", phase: 1, run: "__controlled-by-stub__" },
			{ name: "Code quality review", type: "llm-review", phase: 2, role: "code-reviewer", prompt: "review it" },
		],
	} as unknown as WorkflowGate;
}

/**
 * Asserts the review step waits for Unit tests to complete (fully serial —
 * early-start OFF). Uses a real slow command (no deferred needed — there is
 * nothing to race when serial ordering is a hard requirement), same
 * technique as the existing BOBBIT_PARALLEL_REVIEWS=0 test in
 * verification-harness-parallel-reviews.test.ts.
 */
async function assertSerial(harness: any): Promise<void> {
	const events: Array<{ type: string; stepName?: string }> = [];
	harness._rawBroadcastFn = (_goalId: string, event: any) => { events.push(event); };
	harness.runLlmReviewStep = async (...args: any[]) => ({ passed: true, output: "LGTM", sessionId: args[8] });

	const signal = makeSignal(`sha-${Math.random().toString(36).slice(2)}`);
	const gate = makeReviewGate();
	gate.verify![1] = { ...gate.verify![1], run: "sleep 0.15 && true" } as any;
	await harness.verifyGateSignal(signal, gate, TEST_DIR, undefined, "master");

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
	], `expected strict serial ordering; got: ${JSON.stringify(order)}`);
}

/**
 * Asserts the review step starts concurrently with the (still in-flight)
 * Unit tests command (early-start ON). Deferred-controlled — same technique
 * as the existing BOBBIT_PARALLEL_REVIEWS=1 test in
 * verification-harness-parallel-reviews.test.ts — never a real sleep raced
 * against a wall-clock margin.
 */
async function assertEarlyStart(harness: any): Promise<void> {
	const events: Array<{ type: string; stepName?: string }> = [];
	harness._rawBroadcastFn = (_goalId: string, event: any) => { events.push(event); };

	const unitTests = deferred<{ passed: boolean; output: string }>();
	harness.runCommandStep = async (cmd: string) => {
		if (cmd === "true") return { passed: true, output: "" };
		return unitTests.promise;
	};
	let reviewInvoked = false;
	const reviewStarted = deferred<void>();
	harness.runLlmReviewStep = async (...args: any[]) => {
		reviewInvoked = true;
		reviewStarted.resolve();
		return { passed: true, output: "LGTM", sessionId: args[8] };
	};

	const signal = makeSignal(`sha-${Math.random().toString(36).slice(2)}`);
	const gate = makeReviewGate();
	const verifyPromise = harness.verifyGateSignal(signal, gate, TEST_DIR, undefined, "master");

	await reviewStarted.promise;
	assert.equal(reviewInvoked, true);
	const unitCompleteEarly = events.find(e => e.type === "gate_verification_step_complete" && e.stepName === "Unit tests");
	assert.equal(unitCompleteEarly, undefined, "Unit tests must still be in flight when the review starts");

	unitTests.resolve({ passed: true, output: "" });
	await verifyPromise;
}

describe("parallel-reviews: env vs. policy precedence (resolveVerificationPolicyForGoal)", () => {
	test("no env, no policy configured: resolves true (byte-identical to today's hardcoded default-ON)", () => {
		const prevFlag = process.env.BOBBIT_PARALLEL_REVIEWS;
		delete process.env.BOBBIT_PARALLEL_REVIEWS;
		try {
			const harness = makeHarness() as any;
			assert.equal(harness.resolveVerificationPolicyForGoal("goal-1").parallelReviewsDefault, true);
		} finally {
			if (prevFlag !== undefined) process.env.BOBBIT_PARALLEL_REVIEWS = prevFlag;
		}
	});

	test("no env, policy.parallelReviewsDefault=false: resolves false (policy governs when env is unset)", () => {
		const prevFlag = process.env.BOBBIT_PARALLEL_REVIEWS;
		delete process.env.BOBBIT_PARALLEL_REVIEWS;
		try {
			const harness = makeHarness({ ...DEFAULT_VERIFICATION_POLICY, parallelReviewsDefault: false }) as any;
			assert.equal(harness.resolveVerificationPolicyForGoal("goal-1").parallelReviewsDefault, false);
		} finally {
			if (prevFlag !== undefined) process.env.BOBBIT_PARALLEL_REVIEWS = prevFlag;
		}
	});
});

describe("parallel-reviews: env vs. policy precedence (end-to-end early-start behavior)", () => {
	test("no env, no policy configured (default true): review early-starts — byte-identical to today's hardcoded default-ON", async () => {
		const prevFlag = process.env.BOBBIT_PARALLEL_REVIEWS;
		delete process.env.BOBBIT_PARALLEL_REVIEWS;
		try {
			const harness = makeHarness() as any;
			await assertEarlyStart(harness);
		} finally {
			if (prevFlag !== undefined) process.env.BOBBIT_PARALLEL_REVIEWS = prevFlag;
		}
	});

	test("no env, policy.parallelReviewsDefault=false: review waits for the command phase (serial) — policy governs when env is unset", async () => {
		const prevFlag = process.env.BOBBIT_PARALLEL_REVIEWS;
		delete process.env.BOBBIT_PARALLEL_REVIEWS;
		try {
			const harness = makeHarness({ ...DEFAULT_VERIFICATION_POLICY, parallelReviewsDefault: false }) as any;
			await assertSerial(harness);
		} finally {
			if (prevFlag !== undefined) process.env.BOBBIT_PARALLEL_REVIEWS = prevFlag;
		}
	});

	test("env='0', policy.parallelReviewsDefault=true: review stays serial — env overrides policy", async () => {
		const prevFlag = process.env.BOBBIT_PARALLEL_REVIEWS;
		process.env.BOBBIT_PARALLEL_REVIEWS = "0";
		try {
			const harness = makeHarness({ ...DEFAULT_VERIFICATION_POLICY, parallelReviewsDefault: true }) as any;
			await assertSerial(harness);
		} finally {
			if (prevFlag === undefined) delete process.env.BOBBIT_PARALLEL_REVIEWS; else process.env.BOBBIT_PARALLEL_REVIEWS = prevFlag;
		}
	});

	test("env='1', policy.parallelReviewsDefault=false: review early-starts — env overrides policy", async () => {
		const prevFlag = process.env.BOBBIT_PARALLEL_REVIEWS;
		process.env.BOBBIT_PARALLEL_REVIEWS = "1";
		try {
			const harness = makeHarness({ ...DEFAULT_VERIFICATION_POLICY, parallelReviewsDefault: false }) as any;
			await assertEarlyStart(harness);
		} finally {
			if (prevFlag === undefined) delete process.env.BOBBIT_PARALLEL_REVIEWS; else process.env.BOBBIT_PARALLEL_REVIEWS = prevFlag;
		}
	});
});
