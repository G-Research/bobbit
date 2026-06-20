/**
 * Unit tests for the experiment-runner host seam: `host.agents.spawnGoal`
 * (docs/design/experiment-runner-spawn-goal.md). Drives the REAL
 * `createServerHostApi` over a FAKE OrchestrationCore view + a FAKE injected
 * `spawnChildGoal` closure, so the surface shape, argument forwarding,
 * validation, recursion denial, backend-unavailable, and masked-namespace
 * denial are pinned WITHOUT a gateway.
 *
 * Pinned invariants:
 *   • `host.agents` exposes the six poll verbs PLUS `spawnGoal` — and NO
 *     `goalStatus` companion (the only new verb is `spawnGoal`).
 *   • No new `capabilities.spawnGoal` flag — it rides `capabilities.agents`.
 *   • `spawnGoal` forwards spec/title/runKey/metadata/inlineRoles/workflow(Id)
 *     verbatim to the injected closure and returns exactly `{ goalId }`.
 *   • Blank spec/title/runKey reject before the closure is called.
 *   • A bound CHILD session is denied (recursion belt reuses assertCanSpawn).
 *   • Missing closure ⇒ "backend unavailable".
 *   • A masked-off `agents` namespace denies `spawnGoal` too.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServerHostApi, type CreateServerHostApiOptions } from "../src/server/extension-host/server-host-api.ts";
import type { SpawnChildGoalOpts } from "../src/server/agent/experiment-spawn-goal.ts";
import {
	OrchestrationCore,
	type OrchestrationSessionView,
	type OrchestrationSessionLike,
	type PersistedSessionLike,
} from "../src/server/agent/orchestration-core.ts";

/** Minimal in-memory OrchestrationSessionView (mirrors host-agents-scope.test.ts). */
class FakeView implements OrchestrationSessionView {
	live = new Map<string, OrchestrationSessionLike>();
	persisted = new Map<string, PersistedSessionLike>();
	private seq = 0;

	owner(id: string, opts?: Partial<PersistedSessionLike>): void {
		this.live.set(id, { id, status: "idle", cwd: `/cwd/${id}` });
		this.persisted.set(id, { id, delegateOf: opts?.delegateOf, parentSessionId: opts?.parentSessionId, childKind: opts?.childKind });
	}
	async createDelegateSession(parentSessionId: string, opts: { title?: string }): Promise<{ id: string }> {
		const id = `child-${++this.seq}`;
		this.persisted.set(id, { id, delegateOf: parentSessionId, title: opts.title });
		return { id };
	}
	async createSession(_cwd: string, _a: unknown, _g: unknown, _t: unknown, _opts?: unknown): Promise<{ id: string }> {
		const id = `child-${++this.seq}`;
		return { id };
	}
	async enqueuePrompt(): Promise<{ status: string }> { return { status: "running" }; }
	async deliverLiveSteer(): Promise<unknown> { return { ok: true }; }
	async waitForIdle(): Promise<void> { /* immediate */ }
	async getSessionOutput(id: string): Promise<string> { return `output:${id}`; }
	getSession(id: string): OrchestrationSessionLike | undefined { return this.live.get(id); }
	getPersistedSession(id: string): PersistedSessionLike | undefined { return this.persisted.get(id); }
	async terminateSession(): Promise<boolean> { return true; }
	async forceAbort(): Promise<void> { /* noop */ }
}

function makeCore(view: FakeView): OrchestrationCore {
	return new OrchestrationCore({ sessionManager: view, resolveSessionModel: () => "anthropic/x", audit: () => {} });
}

interface SpawnCall { ownerSessionId: string; opts: SpawnChildGoalOpts }

function makeHost(
	sessionId: string,
	core: OrchestrationCore,
	view: FakeView,
	extra?: Partial<CreateServerHostApiOptions>,
) {
	return createServerHostApi({
		sessionId,
		packId: "experiment-runner",
		contributionId: "g/t",
		orchestrationCore: core,
		readChildStatus: (id) => view.getSession(id)?.status,
		...extra,
	});
}

/** A recording spawnChildGoal closure. */
function recordingClosure(goalId = "child-goal-1"): { calls: SpawnCall[]; fn: NonNullable<CreateServerHostApiOptions["spawnChildGoal"]> } {
	const calls: SpawnCall[] = [];
	return {
		calls,
		fn: async (ownerSessionId, opts) => {
			calls.push({ ownerSessionId, opts });
			return { goalId };
		},
	};
}

describe("host.agents.spawnGoal — surface shape", () => {
	it("exposes spawnGoal alongside the six poll verbs, with NO goalStatus companion", () => {
		const view = new FakeView();
		view.owner("owner-1");
		const host = makeHost("owner-1", makeCore(view), view);
		const keys = Object.keys(host.agents).sort();
		assert.deepEqual(keys, ["dismiss", "list", "prompt", "read", "spawn", "spawnGoal", "status"]);
		assert.equal((host.agents as Record<string, unknown>).goalStatus, undefined);
	});

	it("rides capabilities.agents — there is no separate spawnGoal capability flag", () => {
		const view = new FakeView();
		view.owner("owner-1");
		const host = makeHost("owner-1", makeCore(view), view);
		assert.equal(host.capabilities.agents, true);
		assert.equal(host.capabilities.has("agents"), true);
		assert.equal(host.capabilities.has("spawnGoal"), false);
		assert.equal((host.capabilities as Record<string, unknown>).spawnGoal, undefined);
	});
});

describe("host.agents.spawnGoal — argument forwarding + return shape", () => {
	it("forwards spec/title/runKey/parentGoalId/metadata/inlineRoles/workflow(Id) verbatim and returns { goalId }", async () => {
		const view = new FakeView();
		view.owner("owner-1");
		const rec = recordingClosure("g-abc");
		const host = makeHost("owner-1", makeCore(view), view, { spawnChildGoal: rec.fn });

		const role = { name: "arm-coder", label: "Arm Coder", promptTemplate: "do" };
		const workflow = { id: "wf-arm", name: "Arm WF", gates: [] } as unknown as Parameters<typeof host.agents.spawnGoal>[0]["workflow"];
		const result = await host.agents.spawnGoal({
			title: "Variant A",
			spec: "run the arm",
			runKey: "arm-a#0",
			parentGoalId: "exp-goal",
			metadata: { bobbit: { disabledTools: ["x"] } },
			inlineRoles: { "arm-coder": role as never },
			workflowId: "wf-arm",
			workflow,
		});
		assert.deepEqual(result, { goalId: "g-abc" });
		assert.equal(rec.calls.length, 1);
		const call = rec.calls[0];
		assert.equal(call.ownerSessionId, "owner-1");
		assert.equal(call.opts.title, "Variant A");
		assert.equal(call.opts.spec, "run the arm");
		assert.equal(call.opts.runKey, "arm-a#0");
		assert.equal(call.opts.parentGoalId, "exp-goal");
		assert.deepEqual(call.opts.metadata, { bobbit: { disabledTools: ["x"] } });
		assert.deepEqual(call.opts.inlineRoles, { "arm-coder": role });
		assert.equal(call.opts.workflowId, "wf-arm");
		assert.equal((call.opts.workflow as { id: string }).id, "wf-arm");
	});

	it("trims spec/title/runKey before forwarding", async () => {
		const view = new FakeView();
		view.owner("owner-1");
		const rec = recordingClosure();
		const host = makeHost("owner-1", makeCore(view), view, { spawnChildGoal: rec.fn });
		await host.agents.spawnGoal({ title: "  T  ", spec: "  S  ", runKey: "  K  " });
		assert.deepEqual(
			{ title: rec.calls[0].opts.title, spec: rec.calls[0].opts.spec, runKey: rec.calls[0].opts.runKey },
			{ title: "T", spec: "S", runKey: "K" },
		);
	});
});

describe("host.agents.spawnGoal — required-field validation", () => {
	for (const missing of ["spec", "title", "runKey"] as const) {
		it(`rejects a blank ${missing} BEFORE calling the closure`, async () => {
			const view = new FakeView();
			view.owner("owner-1");
			const rec = recordingClosure();
			const host = makeHost("owner-1", makeCore(view), view, { spawnChildGoal: rec.fn });
			const base = { title: "T", spec: "S", runKey: "K" };
			await assert.rejects(
				host.agents.spawnGoal({ ...base, [missing]: "   " }),
				new RegExp(`spawnGoal: ${missing} is required`),
			);
			assert.equal(rec.calls.length, 0);
		});
	}
});

describe("host.agents.spawnGoal — recursion denial + backend availability", () => {
	it("denies a bound CHILD session (delegateOf) with a capability-specific message", async () => {
		const view = new FakeView();
		view.owner("child-session", { delegateOf: "grandparent" });
		const rec = recordingClosure();
		const host = makeHost("child-session", makeCore(view), view, { spawnChildGoal: rec.fn });
		await assert.rejects(
			host.agents.spawnGoal({ title: "T", spec: "S", runKey: "K" }),
			/host\.agents\.spawnGoal is not permitted for a child session/,
		);
		assert.equal(rec.calls.length, 0);
	});

	it("denies a bound session that carries a childKind", async () => {
		const view = new FakeView();
		view.owner("prw-child", { parentSessionId: "p", childKind: "pr-walkthrough" });
		const rec = recordingClosure();
		const host = makeHost("prw-child", makeCore(view), view, { spawnChildGoal: rec.fn });
		await assert.rejects(host.agents.spawnGoal({ title: "T", spec: "S", runKey: "K" }), /not permitted for a child session/);
	});

	it("throws backend-unavailable when no spawnChildGoal closure is injected", async () => {
		const view = new FakeView();
		view.owner("owner-1");
		const host = makeHost("owner-1", makeCore(view), view); // no spawnChildGoal
		await assert.rejects(
			host.agents.spawnGoal({ title: "T", spec: "S", runKey: "K" }),
			/host\.agents\.spawnGoal backend unavailable/,
		);
	});
});

describe("host.agents.spawnGoal — masked-namespace denial (least privilege)", () => {
	it("a host built with capabilityMask:{ store:true } denies spawnGoal", async () => {
		const view = new FakeView();
		view.owner("owner-1");
		const rec = recordingClosure();
		const host = createServerHostApi({
			sessionId: "owner-1",
			packId: "experiment-runner",
			contributionId: "g/t",
			orchestrationCore: makeCore(view),
			spawnChildGoal: rec.fn,
			capabilityMask: { store: true, session: false, agents: false },
		});
		assert.equal(host.capabilities.agents, false);
		// The denied namespace stub throws SYNCHRONOUSLY (defence-in-depth) — use
		// assert.throws, not assert.rejects.
		assert.throws(
			() => host.agents.spawnGoal({ title: "T", spec: "S", runKey: "K" }),
			/host\.agents capability is not available in this context/,
		);
		assert.equal(rec.calls.length, 0);
	});
});
