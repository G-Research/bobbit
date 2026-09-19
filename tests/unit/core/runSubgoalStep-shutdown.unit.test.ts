import { afterEach, describe, expect, it } from "vitest";
import assert from "node:assert/strict";

import {
	buildActive,
	buildFixture,
	buildSubgoalStep,
	type Fixture,
} from "../../../tests/helpers/run-subgoal-step-fixture.ts";

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(next => { resolve = next; });
	return { promise, resolve };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
		await new Promise<void>(resolve => setTimeout(resolve, 5));
	}
}

function admitSubgoalRun(
	fx: Fixture,
	step: ReturnType<typeof buildSubgoalStep>,
	run = buildActive(fx.parent.id),
): Promise<void> {
	return (fx.harness as any)._admitVerificationWriter(`subgoal ${step.subgoal?.planId ?? "unknown"}`, async () => {
		await fx.harness.runSubgoalStep(step, run.signal, run.active, run.stepIndex);
	});
}

const fixtures: Fixture[] = [];
afterEach(async () => {
	for (const fx of fixtures.splice(0)) {
		await fx.harness.shutdown().catch(() => {});
		fx.cleanup();
	}
});

async function fixture(): Promise<Fixture> {
	const fx = await buildFixture();
	fixtures.push(fx);
	return fx;
}

describe("runSubgoalStep — terminal verification shutdown", () => {
	it("does not enter an admitted subgoal body when shutdown wins its start microtask", async () => {
		const fx = await fixture();
		const writer = admitSubgoalRun(fx, buildSubgoalStep({ planId: "not-started", title: "Not started" }));

		await fx.harness.shutdown();
		await writer;
		expect(fx.calls).toEqual([]);
		expect(fx.goalStore.getAll().filter(goal => goal.parentGoalId === fx.parent.id)).toEqual([]);
	});

	it("interrupts a queued root semaphore acquire and never creates the late child", async () => {
		const fx = await fixture();
		fx.goalStore.update(fx.parent.id, { maxConcurrentChildren: 1 });
		const semaphore = (fx.harness as any)._acquireRootSubgoalSemaphore(fx.parent.id, fx.parent.id);
		await semaphore.acquire();

		const writer = admitSubgoalRun(fx, buildSubgoalStep({ planId: "queued", title: "Queued" }));
		await waitFor(() => semaphore.waiting === 1, "queued subgoal semaphore waiter");

		await fx.harness.shutdown();
		await writer;
		expect(semaphore.waiting).toBe(0);
		expect(fx.calls.some(call => call.kind === "createGoal")).toBe(false);

		semaphore.release();
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(fx.calls.some(call => call.kind === "createGoal")).toBe(false);
	});

	it("interrupts the blocked-dependency poll before a late unblock can start a team", async () => {
		const fx = await fixture();
		const teamStarts: string[] = [];
		fx.setSetupHook(async childGoalId => { teamStarts.push(childGoalId); });
		const writer = admitSubgoalRun(fx, buildSubgoalStep({
			planId: "blocked",
			title: "Blocked",
			dependsOn: ["missing-dependency"],
		}));

		const child = () => fx.goalStore.getAll().find(goal => goal.spawnedFromPlanId === "blocked");
		await waitFor(() => child()?.state === "blocked", "blocked child poll");
		await fx.harness.shutdown();
		await writer;

		const blockedChild = child();
		assert.ok(blockedChild);
		fx.goalStore.update(blockedChild.id, { state: "todo" });
		await new Promise<void>(resolve => setTimeout(resolve, 150));
		expect(teamStarts).toEqual([]);
		expect(fx.calls.some(call => call.kind === "mergeChild" || call.kind === "archiveGoalAfterMerge")).toBe(false);
	});

	it("interrupts a ready-to-merge hook and ignores its late passed result", async () => {
		const fx = await fixture();
		const held = deferred<"passed">();
		let waitSignal: { aborted: boolean } | undefined;
		let waitStarted!: () => void;
		const started = new Promise<void>(resolve => { waitStarted = resolve; });
		fx.setReadyToMergeHook(async (_childGoalId, signal) => {
			waitSignal = signal;
			waitStarted();
			return held.promise;
		});
		const writer = admitSubgoalRun(fx, buildSubgoalStep({ planId: "hook", title: "Hook" }));
		await started;

		await fx.harness.shutdown();
		await writer;
		expect(waitSignal?.aborted).toBe(true);
		held.resolve("passed");
		await new Promise<void>(resolve => setImmediate(resolve));

		expect(fx.calls.some(call => call.kind === "mergeChild" || call.kind === "archiveGoalAfterMerge")).toBe(false);
	});

	it("interrupts the ready-to-merge gate poll before a late gate pass can merge or archive", async () => {
		const fx = await fixture();
		(fx.harness as any)._subgoalHooks = { setupChildAndStartTeam: async () => {} };
		const writer = admitSubgoalRun(fx, buildSubgoalStep({ planId: "poll", title: "Poll" }));
		const child = () => fx.goalStore.getAll().find(goal => goal.spawnedFromPlanId === "poll");
		await waitFor(() => !!child(), "ready-to-merge polling child");
		await new Promise<void>(resolve => setImmediate(resolve));

		await fx.harness.shutdown();
		await writer;
		const pollingChild = child();
		assert.ok(pollingChild);
		fx.gateStore.updateGateStatus(pollingChild.id, "ready-to-merge", "passed");
		await new Promise<void>(resolve => setTimeout(resolve, 550));

		expect(fx.calls.some(call => call.kind === "mergeChild" || call.kind === "archiveGoalAfterMerge")).toBe(false);
	});
});
