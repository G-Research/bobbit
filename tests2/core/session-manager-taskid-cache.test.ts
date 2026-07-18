import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { afterAll, afterEach, describe, it, vi } from "vitest";
import { SessionManager } from "../../src/server/agent/session-manager.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-task-cache-"));
const managers: any[] = [];

function task(id: string, assignedSessionId?: string): any {
	return {
		id,
		goalId: "goal",
		title: id,
		type: "implementation",
		state: "todo",
		assignedSessionId,
		createdAt: 1,
		updatedAt: 1,
	};
}

function context(projectId: string, persistedSessions: any[] = [], initialTasks: any[] = []) {
	const tasks = new Map(initialTasks.map((value) => [value.id, value]));
	const sessions = new Map(persistedSessions.map((value) => [value.id, value]));
	const getBySessionId = vi.fn((sessionId: string) => [...tasks.values()].filter((value: any) => value.assignedSessionId === sessionId));
	return {
		project: { id: projectId },
		taskStore: {
			get: (id: string) => tasks.get(id),
			getBySessionId,
		},
		sessionStore: {
			get: (id: string) => sessions.get(id),
		},
		costTracker: { flush: () => {} },
		tasks,
		getBySessionId,
	};
}

function fixture(contexts: any[]) {
	let generation = 0;
	const pcm: any = {
		all: () => contexts,
		getTaskGeneration: () => generation,
	};
	const manager: any = new SessionManager({ projectContextManager: pcm, stateDir: tmpRoot });
	managers.push(manager);
	return {
		manager,
		setGeneration: (value: number) => { generation = value; },
		bumpGeneration: () => { generation++; },
	};
}

afterEach(() => {
	for (const manager of managers.splice(0)) {
		if (manager._statusHeartbeatTimer) clearInterval(manager._statusHeartbeatTimer);
	}
});

afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

describe("SessionManager generation-invalidated task lookup", () => {
	it("caches presence and absence at a stable task generation", () => {
		const ctx = context("p1", [{ id: "s1" }], [task("t1", "s1")]);
		const { manager } = fixture([ctx]);

		assert.equal(manager.resolveTaskIdForSession("s1"), "t1");
		assert.equal(manager.resolveTaskIdForSession("s1"), "t1");
		assert.equal(ctx.getBySessionId.mock.calls.length, 1);

		assert.equal(manager.resolveTaskIdForSession("missing"), undefined);
		assert.equal(manager.resolveTaskIdForSession("missing"), undefined);
		assert.equal(ctx.getBySessionId.mock.calls.length, 2, "cached undefined avoids a second scan");
	});

	it("invalidates cached absence after assignment and cached presence after removal", () => {
		const ctx = context("p1", [{ id: "s1" }]);
		const { manager, bumpGeneration } = fixture([ctx]);
		assert.equal(manager.resolveTaskIdForSession("s1"), undefined);

		ctx.tasks.set("assigned", task("assigned", "s1"));
		bumpGeneration();
		assert.equal(manager.resolveTaskIdForSession("s1"), "assigned");

		ctx.tasks.delete("assigned");
		bumpGeneration();
		assert.equal(manager.resolveTaskIdForSession("s1"), undefined);
	});

	it("treats stamped task ids as verified hints and follows reassignment", () => {
		const session = { id: "s1", taskId: "stamped-old" };
		const ctx = context("p1", [session], [
			task("stamped-old", "someone-else"),
			task("current", "s1"),
		]);
		const { manager, bumpGeneration } = fixture([ctx]);

		assert.equal(manager.resolveTaskIdForSession("s1"), "current", "stale stamp must be rejected");
		ctx.tasks.set("stamped-old", task("stamped-old", "s1"));
		ctx.tasks.set("current", task("current", "someone-else"));
		bumpGeneration();
		assert.equal(manager.resolveTaskIdForSession("s1"), "stamped-old", "verified stamp may take the fast path");
	});

	it("invalidates on project topology token changes even when task contents are unchanged", () => {
		const first = context("p1", [{ id: "s1" }]);
		const contexts = [first];
		const { manager, setGeneration } = fixture(contexts);
		assert.equal(manager.resolveTaskIdForSession("s1"), undefined);

		const added = context("p2", [], [task("topology-task", "s1")]);
		contexts.push(added);
		setGeneration(1);
		assert.equal(manager.resolveTaskIdForSession("s1"), "topology-task");

		contexts.pop();
		setGeneration(2);
		assert.equal(manager.resolveTaskIdForSession("s1"), undefined);
	});

	it("drops cache entries when a session is fenced for replacement", () => {
		const ctx = context("p1", [{ id: "s1" }], [task("t1", "s1")]);
		const { manager } = fixture([ctx]);
		assert.equal(manager.resolveTaskIdForSession("s1"), "t1");
		assert.equal(manager._taskIdCache.has("s1"), true);

		manager.cancelPendingAutoRetry = () => {};
		manager._untrackConnectedSession = () => {};
		const live: any = { id: "s1", clients: new Set(), status: "idle" };
		manager.sessions.set("s1", live);
		manager._fenceReplacedSession(live, 1);
		assert.equal(manager._taskIdCache.has("s1"), false);
	});
});
