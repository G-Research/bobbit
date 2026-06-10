/**
 * Unit tests for the ambient `host.agents` capability surface (Sub-goal C,
 * orchestration-core §8.3 / §13). Drives `createServerHostApi` over a REAL
 * OrchestrationCore backed by a FAKE OrchestrationSessionView, so the namespace
 * scoping + recursion denial are pinned WITHOUT a gateway.
 *
 * Pinned invariants:
 *   • `capabilities.agents === true` and `has("agents")`.
 *   • `host.agents` exposes ONLY the six poll-based verbs (no blocking `wait`,
 *     no method to reach the user or any foreign session).
 *   • SOURCE-FILTERED scoping: a `delegate`-sourced (or `team`) child of the
 *     SAME bound session is NOT visible to host.agents — only the session's own
 *     `childKind === "host-agents"` children are.
 *   • Capability-surface `host.agents.spawn` denial for a bound child session
 *     (the surface calls A's shared `OrchestrationCore.assertCanSpawn`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServerHostApi } from "../src/server/extension-host/server-host-api.ts";
import {
	OrchestrationCore,
	type OrchestrationSessionView,
	type OrchestrationSessionLike,
	type PersistedSessionLike,
} from "../src/server/agent/orchestration-core.ts";

/** Minimal in-memory OrchestrationSessionView (mirrors orchestration-core.test.ts). */
class FakeView implements OrchestrationSessionView {
	live = new Map<string, OrchestrationSessionLike>();
	persisted = new Map<string, PersistedSessionLike>();
	prompts: Array<{ sessionId: string; text: string }> = [];
	terminated: string[] = [];
	private seq = 0;

	owner(id: string, opts?: Partial<PersistedSessionLike> & { allowedTools?: string[] }): void {
		this.live.set(id, { id, status: "idle", cwd: `/cwd/${id}`, allowedTools: opts?.allowedTools });
		this.persisted.set(id, { id, delegateOf: opts?.delegateOf, parentSessionId: opts?.parentSessionId, childKind: opts?.childKind });
	}
	async createDelegateSession(parentSessionId: string, opts: { title?: string }): Promise<{ id: string }> {
		const id = `child-${++this.seq}`;
		this.live.set(id, { id, status: "idle", title: opts.title });
		this.persisted.set(id, { id, delegateOf: parentSessionId, title: opts.title });
		return { id };
	}
	async createSession(): Promise<{ id: string }> { return { id: `child-${++this.seq}` }; }
	async enqueuePrompt(sessionId: string, text: string): Promise<{ status: string }> {
		this.prompts.push({ sessionId, text });
		return { status: "running" };
	}
	async deliverLiveSteer(): Promise<unknown> { return { ok: true }; }
	async waitForIdle(): Promise<void> { /* immediate */ }
	async getSessionOutput(sessionId: string): Promise<string> { return `output:${sessionId}`; }
	getSession(id: string): OrchestrationSessionLike | undefined { return this.live.get(id); }
	getPersistedSession(id: string): PersistedSessionLike | undefined { return this.persisted.get(id); }
	async terminateSession(id: string): Promise<boolean> { this.terminated.push(id); return true; }
	async forceAbort(): Promise<void> { /* noop */ }
}

function makeCore(view: FakeView): OrchestrationCore {
	return new OrchestrationCore({ sessionManager: view, resolveSessionModel: () => "anthropic/x", audit: () => {} });
}

function makeHost(sessionId: string, core: OrchestrationCore, view: FakeView) {
	return createServerHostApi({
		sessionId,
		packId: "host-agents-exerciser",
		contributionId: "g/t",
		orchestrationCore: core,
		readChildStatus: (id) => view.getSession(id)?.status,
	});
}

describe("host.agents — capability flag + surface shape", () => {
	it("reports capabilities.agents === true and has(\"agents\")", () => {
		const view = new FakeView();
		view.owner("owner-1");
		const host = makeHost("owner-1", makeCore(view), view);
		assert.equal(host.capabilities.agents, true);
		assert.equal(host.capabilities.has("agents"), true);
	});

	it("exposes ONLY the six poll-based verbs (no blocking wait, no foreign-session method)", () => {
		const view = new FakeView();
		view.owner("owner-1");
		const host = makeHost("owner-1", makeCore(view), view);
		const keys = Object.keys(host.agents).sort();
		assert.deepEqual(keys, ["dismiss", "list", "prompt", "read", "spawn", "status"]);
		// No blocking `wait`, and no method that targets the user / a foreign session.
		const surface = host.agents as Record<string, unknown>;
		assert.equal(surface.wait, undefined);
		assert.equal(surface.postMessage, undefined);
		assert.equal(surface.promptSession, undefined);
		assert.equal(surface.spawnForSession, undefined);
	});
});

describe("host.agents — source-filtered scoping (childKind === \"host-agents\")", () => {
	it("lists ONLY the bound session's host-agents children, hiding delegate/team children", async () => {
		const view = new FakeView();
		view.owner("owner-1");
		const core = makeCore(view);
		const host = makeHost("owner-1", core, view);

		// One host-agents child (via the capability) + one delegate + one team child
		// of the SAME owner (via the core directly, as the agent-tool / team paths do).
		const ha = await host.agents.spawn({ instructions: "host-agents child" });
		const del = await core.spawn({ ownerSessionId: "owner-1", instructions: "delegate child", childKind: "delegate" });
		const team = await core.spawn({ ownerSessionId: "owner-1", instructions: "team child", childKind: "team" });

		// The core sees all three; host.agents sees ONLY the host-agents one.
		assert.equal(core.list("owner-1").length, 3);
		const listed = await host.agents.list();
		assert.deepEqual(listed.map((c) => c.childSessionId), [ha.childSessionId]);
		assert.equal(listed[0].childKind, "host-agents");

		// Verbs that take a child id reject a delegate/team child of the same session.
		await assert.rejects(host.agents.prompt(del.sessionId, "hi"), /not a host\.agents child/);
		await assert.rejects(host.agents.read(team.sessionId), /not a host\.agents child/);
		await assert.rejects(host.agents.dismiss(del.sessionId), /not a host\.agents child/);
		await assert.rejects(host.agents.status(team.sessionId), /not a host\.agents child/);
	});

	it("cannot see another session's host-agents children (own-session-only)", async () => {
		const view = new FakeView();
		view.owner("owner-1");
		view.owner("owner-2");
		const core = makeCore(view);
		// owner-2 has a host-agents child; owner-1's host must never see it.
		const foreign = await core.spawn({ ownerSessionId: "owner-2", instructions: "foreign", childKind: "host-agents" });
		const host1 = makeHost("owner-1", core, view);
		assert.deepEqual(await host1.agents.list(), []);
		await assert.rejects(host1.agents.read(foreign.sessionId), /not a host\.agents child/);
	});
});

describe("host.agents.spawn — recursion denial for a bound child session (§7)", () => {
	it("throws a capability-specific error when the bound session is itself a child", async () => {
		const view = new FakeView();
		// The bound session is a delegate child (has delegateOf) → assertCanSpawn throws.
		view.owner("child-session", { delegateOf: "grandparent" });
		const host = makeHost("child-session", makeCore(view), view);
		await assert.rejects(
			host.agents.spawn({ instructions: "grandchild" }),
			/host\.agents\.spawn is not permitted for a child session/,
		);
	});

	it("also denies a bound session that carries a childKind", async () => {
		const view = new FakeView();
		view.owner("prw-child", { parentSessionId: "p", childKind: "pr-walkthrough" });
		const host = makeHost("prw-child", makeCore(view), view);
		await assert.rejects(host.agents.spawn({ instructions: "x" }), /not permitted for a child session/);
	});

	it("allows a normal top-level bound session to spawn a host-agents child", async () => {
		const view = new FakeView();
		view.owner("owner-1");
		const host = makeHost("owner-1", makeCore(view), view);
		const { childSessionId } = await host.agents.spawn({ instructions: "ok" });
		assert.ok(childSessionId);
		const listed = await host.agents.list();
		assert.equal(listed.length, 1);
		assert.equal(listed[0].childKind, "host-agents");
	});
});
