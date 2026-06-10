/**
 * Sub-goal B — runtime archive cascade-reap (OrchestrationCore §6).
 *
 * Pins the generalized `cascadeReapOwner` behaviour: a parent's child agents of
 * ANY child kind (delegate / team / pr-walkthrough / host-agents / future) are
 * reaped both on TERMINATE and on ARCHIVE (the `storeArchive` seam), and dormant
 * persisted-but-not-in-memory children are archived too — so a live child never
 * outlives its parent's archival, even when the parent is dormant/not-live.
 *
 * Modelled on the existing pr-walkthrough cascade tests in
 * `pr-walkthrough-agent-manager.test.ts` (same SessionManager + SessionStore
 * harness).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { SessionManager } = await import("../src/server/agent/session-manager.ts");
const { SessionStore } = await import("../src/server/agent/session-store.ts");
const { PromptQueue } = await import("../src/server/agent/prompt-queue.ts");

describe("SessionManager archive cascade-reap (OrchestrationCore §6)", () => {
	let stateRoot = "";
	let prevBobbitDir: string | undefined;
	const managers: any[] = [];

	beforeEach(() => {
		stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orch-cascade-"));
		prevBobbitDir = process.env.BOBBIT_DIR;
		process.env.BOBBIT_DIR = stateRoot;
	});

	afterEach(() => {
		while (managers.length > 0) {
			const m = managers.pop();
			if (m?._statusHeartbeatTimer) { clearInterval(m._statusHeartbeatTimer); m._statusHeartbeatTimer = null; }
			m?.sessions?.clear?.();
		}
		if (prevBobbitDir === undefined) delete process.env.BOBBIT_DIR;
		else process.env.BOBBIT_DIR = prevBobbitDir;
		fs.rmSync(stateRoot, { recursive: true, force: true });
	});

	function makeInfo(store: InstanceType<typeof SessionStore>, id: string, extra: Record<string, any>): any {
		const persisted = {
			id,
			title: id,
			cwd: stateRoot,
			agentSessionFile: "",
			createdAt: Date.now(),
			lastActivity: Date.now(),
			...extra,
		};
		store.put(persisted as any);
		return {
			id,
			title: id,
			cwd: stateRoot,
			status: "idle",
			statusVersion: 0,
			createdAt: persisted.createdAt,
			lastActivity: persisted.lastActivity,
			clients: new Set(),
			promptQueue: new PromptQueue(),
			rpcClient: { getState: async () => ({ success: true }), stop: async () => {}, onEvent: () => () => {} },
			unsubscribe: () => {},
			...extra,
		};
	}

	function makeManager(store: InstanceType<typeof SessionStore>): any {
		const manager: any = new SessionManager();
		manager._testStore = store;
		managers.push(manager);
		return manager;
	}

	it("TERMINATE cascades to live children of EVERY child kind (not just pr-walkthrough)", async () => {
		const store = new SessionStore(stateRoot);
		const manager = makeManager(store);

		manager.sessions.set("parent", makeInfo(store, "parent", {}));
		// delegate child is linked by delegateOf; the rest by parentSessionId+childKind.
		manager.sessions.set("c-delegate", makeInfo(store, "c-delegate", { delegateOf: "parent" }));
		manager.sessions.set("c-team", makeInfo(store, "c-team", { childKind: "team", parentSessionId: "parent" }));
		manager.sessions.set("c-host", makeInfo(store, "c-host", { childKind: "host-agents", parentSessionId: "parent" }));
		manager.sessions.set("c-prw", makeInfo(store, "c-prw", { childKind: "pr-walkthrough", parentSessionId: "parent" }));

		await manager.terminateSession("parent");

		for (const id of ["parent", "c-delegate", "c-team", "c-host", "c-prw"]) {
			assert.equal(manager.sessions.has(id), false, `${id} must be terminated`);
			assert.equal(store.get(id)?.archived, true, `${id} must be archived`);
		}
	});

	it("ARCHIVE (storeArchive) of a DORMANT parent cascade-reaps live + dormant children of every kind", async () => {
		const store = new SessionStore(stateRoot);
		const manager = makeManager(store);

		// Parent exists only in the store (dormant — NOT in the in-memory map).
		store.put({ id: "parent", title: "parent", cwd: stateRoot, agentSessionFile: "", createdAt: Date.now(), lastActivity: Date.now() } as any);

		// One live in-memory child (host-agents) + two dormant store-only children.
		manager.sessions.set("c-live-host", makeInfo(store, "c-live-host", { childKind: "host-agents", parentSessionId: "parent" }));
		store.put({ id: "c-dormant-delegate", title: "c-dormant-delegate", cwd: stateRoot, agentSessionFile: "", createdAt: Date.now(), lastActivity: Date.now(), delegateOf: "parent" } as any);
		store.put({ id: "c-dormant-team", title: "c-dormant-team", cwd: stateRoot, agentSessionFile: "", createdAt: Date.now(), lastActivity: Date.now(), childKind: "team", parentSessionId: "parent" } as any);

		const ok = await manager.storeArchive("parent");
		assert.equal(ok, true, "storeArchive must report success");

		assert.equal(store.get("parent")?.archived, true, "dormant parent must be archived");
		assert.equal(manager.sessions.has("c-live-host"), false, "live host-agents child must be cascade-terminated");
		assert.equal(store.get("c-live-host")?.archived, true, "live host-agents child must be archived");
		assert.equal(store.get("c-dormant-delegate")?.archived, true, "dormant delegate child must be archived");
		assert.equal(store.get("c-dormant-team")?.archived, true, "dormant team child must be archived");
	});

	it("ARCHIVE does NOT touch sessions belonging to a different parent", async () => {
		const store = new SessionStore(stateRoot);
		const manager = makeManager(store);

		store.put({ id: "parent-a", title: "parent-a", cwd: stateRoot, agentSessionFile: "", createdAt: Date.now(), lastActivity: Date.now() } as any);
		manager.sessions.set("a-child", makeInfo(store, "a-child", { childKind: "host-agents", parentSessionId: "parent-a" }));
		// Unrelated session owned by parent-b — must survive.
		manager.sessions.set("b-child", makeInfo(store, "b-child", { childKind: "host-agents", parentSessionId: "parent-b" }));

		await manager.storeArchive("parent-a");

		assert.equal(store.get("a-child")?.archived, true, "parent-a's child must be archived");
		assert.equal(manager.sessions.has("b-child"), true, "parent-b's child must NOT be touched");
		assert.notEqual(store.get("b-child")?.archived, true, "parent-b's child must NOT be archived");
	});
});
