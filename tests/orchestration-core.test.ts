/**
 * Unit tests for OrchestrationCore (docs/design/orchestration-core.md sub-goal A).
 *
 * Drives the core through a FAKE OrchestrationSessionView so the orchestration
 * logic is tested in isolation from SessionManager. Covers:
 *   • model inheritance (+ per-call override)
 *   • allowedTools subtraction (recursion guard belt-and-braces)
 *   • the single `wait` primitive (policy all/first, incl. one child terminating)
 *   • index rebuild from persisted fields (no new persisted registry)
 *   • shouldReapChildOnBoot table
 *   • assertCanSpawn rejecting a bound-child owner
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	OrchestrationCore,
	OrchestrationCoreError,
	shouldReapChildOnBoot,
	type OrchestrationSessionView,
	type OrchestrationSessionLike,
	type PersistedSessionLike,
} from "../src/server/agent/orchestration-core.ts";

interface FakeSession extends OrchestrationSessionLike {
	output?: string;
	/** How waitForIdle settles: resolve | reject-timeout | reject-exit | pending. */
	wait?: "resolve" | "reject-timeout" | "reject-exit" | "pending";
}

class FakeView implements OrchestrationSessionView {
	live = new Map<string, FakeSession>();
	persisted = new Map<string, PersistedSessionLike>();
	delegateCalls: Array<{ parentSessionId: string; opts: any }> = [];
	createSessionCalls: Array<{ cwd: string; opts: any }> = [];
	prompts: Array<{ sessionId: string; text: string; opts?: any }> = [];
	terminated: string[] = [];
	aborted: string[] = [];
	private seq = 0;

	owner(id: string, opts?: Partial<FakeSession> & Partial<PersistedSessionLike>): void {
		this.live.set(id, { id, status: "idle", cwd: `/cwd/${id}`, allowedTools: opts?.allowedTools, title: opts?.title });
		this.persisted.set(id, { id, title: opts?.title, delegateOf: opts?.delegateOf, parentSessionId: opts?.parentSessionId, childKind: opts?.childKind, archived: opts?.archived });
	}

	async createDelegateSession(parentSessionId: string, opts: any): Promise<{ id: string }> {
		const id = `child-${++this.seq}`;
		this.delegateCalls.push({ parentSessionId, opts });
		this.live.set(id, { id, status: "idle", title: opts.title, output: "" });
		// Persist childKind/readOnly exactly as the real createDelegateSession now
		// does (findings #1/#2) so restart-rebuild + scoping tests are faithful.
		this.persisted.set(id, { id, title: opts.title, delegateOf: parentSessionId, childKind: opts.childKind });
		return { id };
	}
	async createSession(cwd: string, _a: any, _g: any, _t: any, opts?: any): Promise<{ id: string }> {
		const id = `child-${++this.seq}`;
		this.createSessionCalls.push({ cwd, opts });
		this.live.set(id, { id, status: "idle" });
		this.persisted.set(id, { id, parentSessionId: opts?.parentSessionId, childKind: opts?.childKind });
		return { id };
	}
	async enqueuePrompt(sessionId: string, text: string, opts?: any): Promise<{ status: string }> {
		this.prompts.push({ sessionId, text, opts });
		return { status: "running" };
	}
	async deliverLiveSteer(): Promise<unknown> { return { ok: true }; }
	waitForIdle(sessionId: string): Promise<void> {
		const s = this.live.get(sessionId);
		switch (s?.wait) {
			case "reject-timeout": return Promise.reject(new Error(`Timeout waiting for session ${sessionId} to become idle`));
			case "reject-exit": return Promise.reject(new Error(`Agent process exited unexpectedly (code 1) for session ${sessionId}`));
			case "pending": return new Promise<void>(() => { /* never settles */ });
			default: return Promise.resolve();
		}
	}
	async getSessionOutput(sessionId: string): Promise<string> { return this.live.get(sessionId)?.output ?? ""; }
	getSession(id: string): OrchestrationSessionLike | undefined { return this.live.get(id); }
	getPersistedSession(id: string): PersistedSessionLike | undefined { return this.persisted.get(id); }
	async terminateSession(id: string): Promise<boolean> { this.terminated.push(id); return true; }
	async forceAbort(id: string): Promise<void> { this.aborted.push(id); }
}

function makeCore(view: FakeView, model?: string, resolveEffectiveTools?: (id: string) => string[] | undefined) {
	return new OrchestrationCore({
		sessionManager: view,
		resolveSessionModel: () => model,
		resolveEffectiveTools,
		audit: () => { /* silent */ },
	});
}

describe("OrchestrationCore.spawn — model inheritance", () => {
	it("inherits the owner's current model when none is passed", async () => {
		const view = new FakeView();
		view.owner("owner-1");
		const core = makeCore(view, "anthropic/claude-x");
		await core.spawn({ ownerSessionId: "owner-1", instructions: "do it" });
		assert.equal(view.delegateCalls.length, 1);
		assert.equal(view.delegateCalls[0].opts.initialModel, "anthropic/claude-x");
	});

	it("per-call model override wins over inheritance", async () => {
		const view = new FakeView();
		view.owner("owner-1");
		const core = makeCore(view, "anthropic/claude-x");
		await core.spawn({ ownerSessionId: "owner-1", instructions: "do it", model: "openai/gpt-z" });
		assert.equal(view.delegateCalls[0].opts.initialModel, "openai/gpt-z");
	});
});

describe("OrchestrationCore.spawn — allowedTools subtraction (recursion guard)", () => {
	it("strips every spawn verb from the child's allowedTools", async () => {
		const view = new FakeView();
		view.owner("owner-1", { allowedTools: ["bash", "team_delegate", "read", "team_spawn", "write"] });
		const core = makeCore(view);
		await core.spawn({ ownerSessionId: "owner-1", instructions: "x" });
		assert.deepEqual(view.delegateCalls[0].opts.allowedTools, ["bash", "read", "write"]);
	});

	it("synthesizes an explicit all-except-spawn-verbs list when the owner is UNRESTRICTED", async () => {
		// Finding [LOW]: an unrestricted owner (no explicit allow-list) must still
		// produce a child whose REGISTERED tool set excludes the spawn verbs — the
		// core resolves the owner's full effective catalogue and subtracts them.
		const view = new FakeView();
		view.owner("owner-1"); // allowedTools undefined → unrestricted
		const fullCatalogue = ["bash", "read", "write", "team_delegate", "team_spawn", "read_session"];
		const core = makeCore(view, undefined, () => fullCatalogue);
		await core.spawn({ ownerSessionId: "owner-1", instructions: "x" });
		const childTools: string[] = view.delegateCalls[0].opts.allowedTools;
		assert.ok(Array.isArray(childTools), "child must get an explicit allow-list, not undefined");
		assert.ok(!childTools.includes("team_delegate"), "unrestricted owner's child must not carry team_delegate");
		assert.ok(!childTools.includes("team_spawn"), "unrestricted owner's child must not carry team_spawn");
		assert.deepEqual(childTools, ["bash", "read", "write", "read_session"]);
	});

	it("read-only child: strips mutating tools (write/edit/bash) from an explicit allow-list", async () => {
		// Finding #1: a read-only child must NOT have a mutating tool REGISTERED.
		const view = new FakeView();
		view.owner("owner-1", { allowedTools: ["bash", "bash_bg", "read", "write", "edit", "grep"] });
		const core = makeCore(view);
		await core.spawn({ ownerSessionId: "owner-1", instructions: "x", readOnly: true });
		const tools: string[] = view.delegateCalls[0].opts.allowedTools;
		assert.deepEqual(tools, ["read", "grep"]);
		// readOnly marker is persisted/forwarded.
		assert.equal(view.delegateCalls[0].opts.readOnly, true);
	});

	it("read-only child: strips mutating tools from a synthesized unrestricted catalogue", async () => {
		const view = new FakeView();
		view.owner("owner-1");
		const fullCatalogue = ["bash", "read", "write", "edit", "generate_image", "team_delegate", "read_session"];
		const core = makeCore(view, undefined, () => fullCatalogue);
		await core.spawn({ ownerSessionId: "owner-1", instructions: "x", readOnly: true });
		const tools: string[] = view.delegateCalls[0].opts.allowedTools;
		assert.deepEqual(tools, ["read", "read_session"]);
	});

	it("writable (default) child KEEPS mutating tools", async () => {
		const view = new FakeView();
		view.owner("owner-1", { allowedTools: ["bash", "read", "write", "edit"] });
		const core = makeCore(view);
		await core.spawn({ ownerSessionId: "owner-1", instructions: "x" });
		assert.deepEqual(view.delegateCalls[0].opts.allowedTools, ["bash", "read", "write", "edit"]);
	});

	it("falls back to undefined when the owner is unrestricted AND no catalogue is available", async () => {
		// No resolveEffectiveTools (e.g. no tool manager) — the core cannot
		// synthesize a list; assertCanSpawn remains the runtime recursion belt.
		const view = new FakeView();
		view.owner("owner-1");
		const core = makeCore(view);
		await core.spawn({ ownerSessionId: "owner-1", instructions: "x" });
		assert.equal(view.delegateCalls[0].opts.allowedTools, undefined);
	});
});

describe("OrchestrationCore.assertCanSpawn — no grandchildren", () => {
	it("throws when the owner is itself a delegate child", async () => {
		const view = new FakeView();
		view.owner("child-owner", { delegateOf: "grandparent" });
		const core = makeCore(view);
		assert.throws(() => core.assertCanSpawn("child-owner"), (e: unknown) => e instanceof OrchestrationCoreError && (e as OrchestrationCoreError).code === "NO_GRANDCHILDREN");
		await assert.rejects(core.spawn({ ownerSessionId: "child-owner", instructions: "x" }), /grandchildren/i);
	});

	it("throws when the owner has a childKind set", () => {
		const view = new FakeView();
		view.owner("prw-child", { childKind: "pr-walkthrough", parentSessionId: "p" });
		const core = makeCore(view);
		assert.throws(() => core.assertCanSpawn("prw-child"), /grandchildren/i);
	});

	it("allows a normal top-level owner", () => {
		const view = new FakeView();
		view.owner("owner-1");
		const core = makeCore(view);
		assert.doesNotThrow(() => core.assertCanSpawn("owner-1"));
	});
});

describe("OrchestrationCore.wait — policy all/first + terminal handling", () => {
	it("policy:all resolves when every child is settled; never rejects on one crash", async () => {
		const view = new FakeView();
		view.owner("owner-1");
		const core = makeCore(view);
		const a = await core.spawn({ ownerSessionId: "owner-1", instructions: "a" });
		const b = await core.spawn({ ownerSessionId: "owner-1", instructions: "b" });
		// a crashes (process exit → terminated), b finishes idle.
		view.live.get(a.sessionId)!.wait = "reject-exit";
		view.live.get(a.sessionId)!.status = "terminated";
		view.live.get(b.sessionId)!.wait = "resolve";
		view.live.get(b.sessionId)!.status = "idle";

		const result = await core.wait("owner-1", [a.sessionId, b.sessionId], { policy: "all", timeoutMs: 1000 });
		const byId = new Map(result.statuses.map(s => [s.sessionId, s.status]));
		assert.equal(byId.get(a.sessionId), "terminated");
		assert.equal(byId.get(b.sessionId), "idle");
		assert.equal(result.remaining, 0);
	});

	it("policy:first returns on the first settled child, with the rest's live status", async () => {
		const view = new FakeView();
		view.owner("owner-1");
		const core = makeCore(view);
		const a = await core.spawn({ ownerSessionId: "owner-1", instructions: "a" });
		const b = await core.spawn({ ownerSessionId: "owner-1", instructions: "b" });
		// a terminates immediately; b is still streaming (never settles in-test).
		view.live.get(a.sessionId)!.wait = "reject-exit";
		view.live.get(a.sessionId)!.status = "terminated";
		view.live.get(b.sessionId)!.wait = "pending";
		view.live.get(b.sessionId)!.status = "streaming";

		const result = await core.wait("owner-1", [a.sessionId, b.sessionId], { policy: "first", timeoutMs: 1000 });
		assert.equal(result.firstIdle, a.sessionId);
		assert.equal(result.firstIsTerminal, true);
		const byId = new Map(result.statuses.map(s => [s.sessionId, s.status]));
		assert.equal(byId.get(a.sessionId), "terminated");
		assert.equal(byId.get(b.sessionId), "streaming");
		assert.equal(result.remaining, 1);
	});

	it("maps a timeout rejection to the `timeout` terminal status", async () => {
		const view = new FakeView();
		view.owner("owner-1");
		const core = makeCore(view);
		const a = await core.spawn({ ownerSessionId: "owner-1", instructions: "a" });
		view.live.get(a.sessionId)!.wait = "reject-timeout";
		const result = await core.wait("owner-1", [a.sessionId], { policy: "all", timeoutMs: 1 });
		assert.equal(result.statuses[0].status, "timeout");
	});

	it("rejects waiting on a child the owner does not own", async () => {
		const view = new FakeView();
		view.owner("owner-1");
		const core = makeCore(view);
		await assert.rejects(core.wait("owner-1", ["not-mine"], { policy: "all", timeoutMs: 1 }), /not owned/i);
	});
});

describe("OrchestrationCore — ownership scoping", () => {
	it("prompt/steer/abort/dismiss reject a foreign child", async () => {
		const view = new FakeView();
		view.owner("owner-1");
		const core = makeCore(view);
		await assert.rejects(core.prompt("owner-1", "foreign", "hi"), /not owned/i);
		await assert.rejects(core.abort("owner-1", "foreign"), /not owned/i);
		await assert.rejects(core.dismiss("owner-1", "foreign"), /not owned/i);
	});

	it("dismiss terminates and forgets an owned child", async () => {
		const view = new FakeView();
		view.owner("owner-1");
		const core = makeCore(view);
		const a = await core.spawn({ ownerSessionId: "owner-1", instructions: "a" });
		assert.equal(core.list("owner-1").length, 1);
		const ok = await core.dismiss("owner-1", a.sessionId);
		assert.equal(ok, true);
		assert.deepEqual(view.terminated, [a.sessionId]);
		assert.equal(core.list("owner-1").length, 0);
	});

	it("steer requires the child to be streaming (else NOT_STREAMING)", async () => {
		const view = new FakeView();
		view.owner("owner-1");
		const core = makeCore(view);
		const a = await core.spawn({ ownerSessionId: "owner-1", instructions: "a" });
		view.live.get(a.sessionId)!.status = "idle";
		await assert.rejects(core.steer("owner-1", a.sessionId, "go"), (e: unknown) => e instanceof OrchestrationCoreError && (e as OrchestrationCoreError).code === "NOT_STREAMING");
		view.live.get(a.sessionId)!.status = "streaming";
		await assert.doesNotReject(core.steer("owner-1", a.sessionId, "go"));
	});
});

describe("OrchestrationCore.rebuildIndexFromPersisted", () => {
	it("rebuilds children from delegateOf and parentSessionId+childKind; skips archived and non-children", () => {
		const view = new FakeView();
		const core = makeCore(view);
		core.rebuildIndexFromPersisted([
			{ id: "owner-1" },                                                    // not a child
			{ id: "d1", delegateOf: "owner-1" },                                  // delegate child
			{ id: "prw", parentSessionId: "owner-1", childKind: "pr-walkthrough" }, // kinded child
			{ id: "ha", parentSessionId: "owner-2", childKind: "host-agents" },   // other owner
			{ id: "arch", delegateOf: "owner-1", archived: true },                // archived → skipped
			{ id: "loose", parentSessionId: "owner-1" },                          // parent but no childKind → not a child
		]);
		const o1 = core.list("owner-1").map(h => h.sessionId).sort();
		assert.deepEqual(o1, ["d1", "prw"]);
		assert.deepEqual(core.list("owner-2").map(h => h.sessionId), ["ha"]);
		// host-agents discriminator preserved.
		assert.equal(core.list("owner-2")[0].childKind, "host-agents");
		// blocking-ness never persisted.
		assert.equal(core.list("owner-1").every(h => h.blocking === false), true);
	});

	it("a host-agents child spawned via createDelegateSession survives restart as host-agents (finding #2)", async () => {
		// host.agents.spawn routes through createDelegateSession (bare) with
		// childKind="host-agents". That kind MUST be persisted so the rebuilt index
		// reconstructs it as host-agents — otherwise host.agents.list/read/... stop
		// seeing it after a restart (and a delegate sibling stays excluded).
		const view = new FakeView();
		const core = makeCore(view);
		view.owner("owner-1");
		const ha = await core.spawn({ ownerSessionId: "owner-1", instructions: "ha", childKind: "host-agents" });
		const del = await core.spawn({ ownerSessionId: "owner-1", instructions: "d", childKind: "delegate" });
		// The persisted record carries the discriminator the real session-manager writes.
		assert.equal(view.delegateCalls[0].opts.childKind, "host-agents");
		assert.equal(view.persisted.get(ha.sessionId)?.childKind, "host-agents");

		// Simulate restart: rebuild purely from the persisted fields.
		core.rebuildIndexFromPersisted([...view.persisted.values()]);
		const rebuilt = core.list("owner-1");
		const byKind = new Map(rebuilt.map(h => [h.sessionId, h.childKind]));
		assert.equal(byKind.get(ha.sessionId), "host-agents");
		assert.equal(byKind.get(del.sessionId), "delegate");
	});
});

describe("shouldReapChildOnBoot table (§5)", () => {
	it("reaps a kind-terminal child", () => {
		assert.deepEqual(shouldReapChildOnBoot({ childKind: "pr-walkthrough", ownerSessionId: "o", ownerExists: true, ownerArchived: false, kindTerminal: true, kindTerminalReason: "ready" }), { reap: true, reason: "ready" });
	});
	it("reaps an orphaned delegate (owner gone)", () => {
		assert.equal(shouldReapChildOnBoot({ childKind: "delegate", ownerSessionId: "o", ownerExists: false, ownerArchived: false }).reap, true);
	});
	it("reaps when the owner is archived", () => {
		assert.equal(shouldReapChildOnBoot({ childKind: "delegate", ownerSessionId: "o", ownerExists: true, ownerArchived: true }).reap, true);
	});
	it("does NOT reap a delegate whose owner is restoring", () => {
		assert.equal(shouldReapChildOnBoot({ childKind: "delegate", ownerSessionId: "o", ownerExists: true, ownerArchived: false }).reap, false);
	});
	it("reaps when ownerSessionId is missing", () => {
		assert.equal(shouldReapChildOnBoot({ childKind: "delegate", ownerExists: false, ownerArchived: false }).reap, true);
	});
});

describe("OrchestrationCore.remindOwnersWithLiveChildren (restart survival §4)", () => {
	it("reminds owners with live children and can filter out team children", async () => {
		const view = new FakeView();
		view.owner("owner-1", { title: "Owner One" });
		view.owner("owner-2");
		const core = makeCore(view);
		core.rebuildIndexFromPersisted([
			{ id: "d1", delegateOf: "owner-1", title: "Helper" },
			{ id: "t1", parentSessionId: "owner-2", childKind: "team" },
		]);
		const reminded = await core.remindOwnersWithLiveChildren(h => h.childKind !== "team");
		assert.equal(reminded, 1);
		assert.equal(view.prompts.length, 1);
		assert.equal(view.prompts[0].sessionId, "owner-1");
		assert.match(view.prompts[0].text, /team_wait/);
		assert.equal(view.prompts[0].opts?.source, "system");
	});
});
