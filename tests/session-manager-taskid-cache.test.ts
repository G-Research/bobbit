/**
 * Unit tests for PERF-05: `trackCostFromEvent`'s taskId resolution used to
 * allocate a `new TaskManager()` and scan `getTasksForSession` across EVERY
 * project context on EVERY assistant `message_end`, even when the session
 * has no task at all (the common case for goal-lead / ad hoc sessions).
 *
 * `SessionManager.resolveTaskIdForSession` (shared by `trackCostFromEvent`
 * and `getSessionCostUpdate`/reconnect hydration) now caches the fallback
 * scan's result per session, keyed by `ProjectContextManager.getTaskGeneration()`
 * (a cheap sum of `TaskStore.getGeneration()` across projects). These tests
 * pin:
 *  - N `message_end` events for a session with no fast-path taskId → the
 *    cross-project scan (`TaskStore.getBySessionId`, the method the inlined
 *    `new TaskManager().getTasksForSession()` ultimately calls) runs AT MOST
 *    ONCE across all N events.
 *  - Reassigning the task (bumping the TaskStore generation) invalidates the
 *    cache: the next event re-scans and picks up the new taskId.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { SessionManager } = await import("../src/server/agent/session-manager.ts");
const { ProjectContextManager } = await import("../src/server/agent/project-context-manager.ts");
const { ProjectRegistry } = await import("../src/server/agent/project-registry.ts");
const { TaskManager } = await import("../src/server/agent/task-manager.ts");

function makeMessageEndEvent(cost: number) {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			usage: { inputTokens: 10, outputTokens: 5, cost },
		},
	};
}

describe("SessionManager.resolveTaskIdForSession cache (PERF-05)", () => {
	const tmpRoots: string[] = [];

	after(() => {
		for (const root of tmpRoots) {
			try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ok */ }
		}
	});

	async function setup() {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskid-cache-"));
		tmpRoots.push(root);
		const registryStateDir = path.join(root, "state");
		const projectRoot = path.join(root, "project");
		fs.mkdirSync(projectRoot, { recursive: true });
		fs.mkdirSync(registryStateDir, { recursive: true });

		const projectId = "proj-1";
		fs.writeFileSync(path.join(registryStateDir, "projects.json"), JSON.stringify([{
			id: projectId,
			name: "Project 1",
			rootPath: projectRoot,
			createdAt: Date.now(),
			colorLight: "#3b82f6",
			colorDark: "#60a5fa",
		}]));

		const registry = new ProjectRegistry(registryStateDir);
		const pcm = new ProjectContextManager(registry);
		const sessionManager = new SessionManager({ projectContextManager: pcm }) as any;
		const ctx = pcm.getOrCreate(projectId)!;

		return { root, projectId, pcm, ctx, sessionManager };
	}

	it("scans the task store at most once across N message_end events, then reuses the cached result", async () => {
		const { ctx, sessionManager } = await setup();
		try {
			const tm = new TaskManager(ctx.taskStore);
			const task = tm.createTask("goal-1", "Do the thing", "code");
			tm.assignTask(task.id, "sess-1");

			let scanCalls = 0;
			const origGetBySessionId = ctx.taskStore.getBySessionId.bind(ctx.taskStore);
			ctx.taskStore.getBySessionId = (sid: string) => {
				scanCalls++;
				return origGetBySessionId(sid);
			};

			// Session deliberately has NO `taskId` of its own — this is the
			// fallback-scan case the PERF-05 finding is about (fast-path
			// session.taskId is exercised by the assignment-time flow, not this).
			const session = {
				id: "sess-1",
				projectId: "proj-1",
				clients: new Set(),
				goalId: undefined,
				teamGoalId: undefined,
				taskId: undefined,
			};
			sessionManager.sessions.set(session.id, session);

			const N = 5;
			let lastTaskId: string | undefined;
			for (let i = 0; i < N; i++) {
				sessionManager.trackCostFromEvent(session, makeMessageEndEvent(0.001));
				lastTaskId = sessionManager.resolveTaskIdForSession(session.id);
			}

			assert.equal(lastTaskId, task.id, "resolves the assigned task's id");
			assert.ok(scanCalls <= 1, `expected at most 1 task-store scan across ${N} messages, got ${scanCalls}`);
		} finally {
			await ctx.close();
		}
	});

	it("invalidates the cache when the session's task assignment changes", async () => {
		const { ctx, sessionManager } = await setup();
		try {
			const tm = new TaskManager(ctx.taskStore);
			const task1 = tm.createTask("goal-1", "First task", "code");
			tm.assignTask(task1.id, "sess-2");

			const session = {
				id: "sess-2",
				projectId: "proj-1",
				clients: new Set(),
				goalId: undefined,
				teamGoalId: undefined,
				taskId: undefined,
			};
			sessionManager.sessions.set(session.id, session);

			sessionManager.trackCostFromEvent(session, makeMessageEndEvent(0.001));
			assert.equal(sessionManager.resolveTaskIdForSession(session.id), task1.id);

			// Re-bind: task1 is reassigned away from sess-2 (e.g. handed to a
			// different worker) and a new task2 is assigned to sess-2 instead.
			// Both `assignTask` calls go through `TaskStore.put`, which bumps
			// the generation counter — this must invalidate the stale cache
			// entry rather than keep returning task1's id.
			tm.assignTask(task1.id, "sess-other");
			const task2 = tm.createTask("goal-1", "Second task", "code");
			tm.assignTask(task2.id, "sess-2");

			sessionManager.trackCostFromEvent(session, makeMessageEndEvent(0.001));
			assert.equal(
				sessionManager.resolveTaskIdForSession(session.id),
				task2.id,
				"cache must reflect the re-binding, not the stale task1 id",
			);
		} finally {
			await ctx.close();
		}
	});
});
