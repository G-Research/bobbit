/**
 * Pins the CORE recursion guard (orchestration-core.md §7, sub-goal A):
 *   1. OrchestrationCore.assertCanSpawn rejects a bound-child owner (one with
 *      delegateOf OR childKind) — no child of any kind spawns grandchildren.
 *   2. spawn() calls assertCanSpawn first.
 *   3. spawn() subtracts EVERY spawn verb from the child's allowedTools.
 *
 * This is the SHARED mechanism both spawn paths use: the agent-tool path (A)
 * and host.agents.spawn (C). The host.agents capability-SURFACE denial test is
 * deferred to sub-goal C — the `host.agents` namespace does not exist in A, so
 * this file does NOT assert it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	OrchestrationCore,
	OrchestrationCoreError,
	SPAWN_VERBS,
	type OrchestrationSessionView,
	type OrchestrationSessionLike,
	type PersistedSessionLike,
} from "../src/server/agent/orchestration-core.ts";

class MinimalView implements OrchestrationSessionView {
	live = new Map<string, OrchestrationSessionLike>();
	persisted = new Map<string, PersistedSessionLike>();
	lastDelegateOpts: any = undefined;
	private seq = 0;
	async createDelegateSession(parent: string, opts: any): Promise<{ id: string }> {
		this.lastDelegateOpts = opts;
		const id = `c-${++this.seq}`;
		this.live.set(id, { id, status: "idle" });
		this.persisted.set(id, { id, delegateOf: parent });
		return { id };
	}
	async createSession(): Promise<{ id: string }> { const id = `c-${++this.seq}`; this.live.set(id, { id, status: "idle" }); return { id }; }
	async enqueuePrompt(): Promise<{ status: string }> { return { status: "running" }; }
	async deliverLiveSteer(): Promise<unknown> { return {}; }
	waitForIdle(): Promise<void> { return Promise.resolve(); }
	async getSessionOutput(): Promise<string> { return ""; }
	getSession(id: string): OrchestrationSessionLike | undefined { return this.live.get(id); }
	getPersistedSession(id: string): PersistedSessionLike | undefined { return this.persisted.get(id); }
	async terminateSession(): Promise<boolean> { return true; }
	async forceAbort(): Promise<void> { /* noop */ }
}

function core(view: MinimalView) {
	return new OrchestrationCore({ sessionManager: view, resolveSessionModel: () => undefined, audit: () => {} });
}

describe("recursion guard — core assertCanSpawn", () => {
	it("SPAWN_VERBS contains exactly team_delegate and team_spawn", () => {
		assert.deepEqual([...SPAWN_VERBS].sort(), ["team_delegate", "team_spawn"]);
	});

	it("rejects a delegate-child owner", () => {
		const v = new MinimalView();
		v.live.set("kid", { id: "kid", status: "idle" });
		v.persisted.set("kid", { id: "kid", delegateOf: "parent" });
		assert.throws(() => core(v).assertCanSpawn("kid"), (e: unknown) => e instanceof OrchestrationCoreError && (e as OrchestrationCoreError).code === "NO_GRANDCHILDREN");
	});

	it("rejects a childKind owner (e.g. pr-walkthrough / host-agents)", () => {
		const v = new MinimalView();
		v.persisted.set("kid", { id: "kid", parentSessionId: "p", childKind: "host-agents" });
		assert.throws(() => core(v).assertCanSpawn("kid"), /grandchildren/i);
	});

	it("permits a normal top-level owner", () => {
		const v = new MinimalView();
		v.live.set("top", { id: "top", status: "idle", cwd: "/x" });
		v.persisted.set("top", { id: "top" });
		assert.doesNotThrow(() => core(v).assertCanSpawn("top"));
	});

	it("spawn() refuses to spawn a grandchild (calls assertCanSpawn first)", async () => {
		const v = new MinimalView();
		v.live.set("kid", { id: "kid", status: "idle", cwd: "/x" });
		v.persisted.set("kid", { id: "kid", delegateOf: "parent" });
		await assert.rejects(core(v).spawn({ ownerSessionId: "kid", instructions: "x" }), /grandchildren/i);
		assert.equal(v.lastDelegateOpts, undefined, "no child session must be created for a blocked spawn");
	});
});

describe("recursion guard — allowedTools subtraction", () => {
	it("a spawned child loses team_delegate AND team_spawn", async () => {
		const v = new MinimalView();
		v.live.set("owner", { id: "owner", status: "idle", cwd: "/x", allowedTools: ["bash", "team_delegate", "team_spawn", "read_session", "read"] });
		v.persisted.set("owner", { id: "owner" });
		await core(v).spawn({ ownerSessionId: "owner", instructions: "x" });
		const childTools: string[] = v.lastDelegateOpts.allowedTools;
		assert.ok(!childTools.includes("team_delegate"), "child must not inherit team_delegate");
		assert.ok(!childTools.includes("team_spawn"), "child must not inherit team_spawn");
		// read_session stays — children must still read transcripts.
		assert.ok(childTools.includes("read_session"));
		assert.deepEqual(childTools, ["bash", "read_session", "read"]);
	});
});
