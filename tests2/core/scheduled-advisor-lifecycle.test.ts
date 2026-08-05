import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LifecycleHub } from "../../src/server/agent/lifecycle-hub.ts";
import { ContextTraceStore } from "../../src/server/agent/context-trace-store.ts";
import type { HookContribution } from "../../src/server/agent/pack-contributions.ts";
import type { PackContributionRegistry } from "../../src/server/extension-host/pack-contribution-registry.ts";
import type { ModuleHost } from "../../src/server/extension-host/module-host-worker.ts";

const roots: string[] = [];
afterEach(() => {
	while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function tmp(): string {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-advisor-")));
	roots.push(root);
	return root;
}

function hook(root: string, everyNTurns = 2): HookContribution {
	return {
		id: "advisor.turn",
		module: "advisor.mjs",
		events: ["afterTurn"],
		mode: "decide",
		capabilities: [],
		budget: { maxTokens: 123, timeoutMs: 1_000 },
		config: { stable: true },
		schedule: { everyNTurns },
		listName: "advisor.turn",
		sourceFile: path.join(root, "hooks.yml"),
		packRoot: root,
	};
}

function context(root: string, turn: number) {
	return {
		sessionId: "session-1", projectId: "project-1", scope: "project" as const,
		cwd: root, goalId: "goal-1", roleName: "coder", turn: { index: turn },
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

function makeHub(root: string, hooks: HookContribution[], invoke: (request: any, timeout?: number, signal?: AbortSignal) => Promise<unknown>, allowed: () => boolean) {
	const trace = new ContextTraceStore(path.join(root, "state"));
	const registry = { listScheduledAdvisorHooks: () => hooks } as unknown as PackContributionRegistry;
	const moduleHost = { invoke } as unknown as ModuleHost;
	return {
		trace,
		hub: new LifecycleHub({
			registry, moduleHost, trace,
			gatewayInfo: () => ({ baseUrl: "https://gateway.invalid", token: "must-not-reach-advisors" }),
			scheduledAdvisorAuthorizer: () => allowed(),
		}),
	};
}

describe("scheduled advisor lifecycle", () => {
	it("runs only at exact cadence boundaries with an advisory-only immutable context", async () => {
		const root = tmp();
		const calls: any[] = [];
		const { hub, trace } = makeHub(root, [hook(root)], async (request) => {
			calls.push(request);
			return { advisory: { value: "safe.marker" } };
		}, () => true);

		await hub.dispatchScheduledAdvisors(context(root, 1));
		assert.equal(calls.length, 0, "turn 1 is not due for every 2 turns");
		await hub.dispatchScheduledAdvisors(context(root, 2));
		assert.equal(calls.length, 1);
		assert.equal(calls[0].exportKind, "advisors");
		assert.equal(calls[0].member, "advisor.turn");
		assert.equal(calls[0].ctx.gateway, undefined, "advisors get no gateway secret");
		assert.equal(calls[0].ctx.host, undefined, "advisors get no host API");
		assert.equal(Object.isFrozen(calls[0].ctx), true);
		const [outcome] = trace.readTrace("session-1")[0].outcomes!;
		assert.deepEqual({ ...outcome, ms: 0 }, {
			kind: "advisory", packId: path.basename(root), hookId: "advisor.turn",
			event: "afterTurn", outcome: "advised", value: "safe.marker", ms: 0,
		});
	});

	it("drops overlap, fences a completion after revoke, and releases the keyed slot", async () => {
		const root = tmp();
		let permitted = true;
		const first = deferred<unknown>();
		let calls = 0;
		const { hub, trace } = makeHub(root, [hook(root, 1)], async () => {
			calls++;
			return calls === 1 ? first.promise : undefined;
		}, () => permitted);

		const running = hub.dispatchScheduledAdvisors(context(root, 1));
		await Promise.resolve();
		await hub.dispatchScheduledAdvisors(context(root, 2));
		assert.equal(calls, 1, "an occupied session+pack+hook is not queued");
		permitted = false;
		first.resolve(undefined);
		await running;
		const outcomes = trace.readTrace("session-1").flatMap((row) => row.outcomes ?? []);
		assert.deepEqual(outcomes.map((row) => row.reason), ["Overlapping invocation", "Disabled or revoked"]);

		permitted = true;
		await hub.dispatchScheduledAdvisors(context(root, 3));
		assert.equal(calls, 2, "completion releases only its own keyed invocation");
	});

	it("cancels active work, accepts no malformed result, and isolates the next due turn", async () => {
		const root = tmp();
		const first = deferred<unknown>();
		let calls = 0;
		let observedSignal: AbortSignal | undefined;
		const { hub, trace } = makeHub(root, [hook(root, 1)], async (_request, _timeout, signal) => {
			calls++;
			observedSignal = signal;
			return calls === 1 ? first.promise : { blocks: ["not advice"] };
		}, () => true);

		const running = hub.dispatchScheduledAdvisors(context(root, 1));
		await Promise.resolve();
		hub.cancelScheduledAdvisors({ sessionId: "session-1" });
		assert.equal(observedSignal?.aborted, true, "cancellation aborts the live invocation immediately");
		first.resolve(undefined);
		await running;
		await hub.dispatchScheduledAdvisors(context(root, 2));
		const outcomes = trace.readTrace("session-1").flatMap((row) => row.outcomes ?? []);
		assert.deepEqual(outcomes.map((row) => row.reason), ["Cancelled", "Malformed result"]);
	});

	it("isolates a thrown advisor error so a same-hook advisor in another pack still completes", async () => {
		const root = tmp();
		const failingPack = path.join(root, "failing-pack");
		const succeedingPack = path.join(root, "succeeding-pack");
		const invoked: string[] = [];
		const { hub, trace } = makeHub(root, [hook(failingPack, 1), hook(succeedingPack, 1)], async (request) => {
			invoked.push(request.packRoot);
			if (request.packRoot === failingPack) throw new Error("advisor crashed");
			return { advisory: { value: "independent.success" } };
		}, () => true);

		await hub.dispatchScheduledAdvisors(context(root, 1));
		assert.deepEqual(invoked, [failingPack, succeedingPack], "one failure cannot prevent other due advisors from launching");
		const outcomes = trace.readTrace("session-1").flatMap((row) => row.outcomes ?? []);
		assert.deepEqual(outcomes.map(({ packId, outcome, value }) => ({ packId, outcome, value })), [
			{ packId: "failing-pack", outcome: "error", value: undefined },
			{ packId: "succeeding-pack", outcome: "advised", value: "independent.success" },
		]);
	});

	it("classifies a timeout and releases its slot for the next due turn", async () => {
		const root = tmp();
		let calls = 0;
		const { hub, trace } = makeHub(root, [hook(root, 1)], async () => {
			calls++;
			throw new Error("advisor worker timed out");
		}, () => true);

		await hub.dispatchScheduledAdvisors(context(root, 1));
		await hub.dispatchScheduledAdvisors(context(root, 2));
		assert.equal(calls, 2, "the rejected invocation must release its key instead of blocking the next due turn");
		const outcomes = trace.readTrace("session-1").flatMap((row) => row.outcomes ?? []);
		assert.deepEqual(outcomes.map(({ outcome, reason }) => ({ outcome, reason })), [
			{ outcome: "dropped", reason: "Timed out" },
			{ outcome: "dropped", reason: "Timed out" },
		]);
	});

	it("runs same-hook advisors from separate packs concurrently under independent keys", async () => {
		const root = tmp();
		const firstPack = path.join(root, "first-pack");
		const secondPack = path.join(root, "second-pack");
		const first = deferred<unknown>();
		const second = deferred<unknown>();
		const invocations: Array<{ packRoot: string; signal: AbortSignal | undefined }> = [];
		const { hub, trace } = makeHub(root, [hook(firstPack, 1), hook(secondPack, 1)], async (request, _timeout, signal) => {
			invocations.push({ packRoot: request.packRoot, signal });
			return request.packRoot === firstPack ? first.promise : second.promise;
		}, () => true);

		const running = hub.dispatchScheduledAdvisors(context(root, 1));
		assert.deepEqual(invocations.map(({ packRoot }) => packRoot), [firstPack, secondPack],
			"the identical hook id must not make different packs overlap");
		assert.notEqual(invocations[0].signal, invocations[1].signal, "each pack owns a separate cancellation controller");
		second.resolve({ advisory: { value: "second.done" } });
		first.resolve({ advisory: { value: "first.done" } });
		await running;
		const outcomes = trace.readTrace("session-1").flatMap((row) => row.outcomes ?? []);
		assert.deepEqual(outcomes.map(({ packId, outcome, value }) => ({ packId, outcome, value })).sort((a, b) => (a.packId ?? "").localeCompare(b.packId ?? "")), [
			{ packId: "first-pack", outcome: "advised", value: "first.done" },
			{ packId: "second-pack", outcome: "advised", value: "second.done" },
		]);
	});
});
