import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import { afterEach, describe, expect, it, vi } from "vitest";
import assert from "node:assert/strict";
import { makeTmpDir } from "../../tests/helpers/tmp.ts";

const tmpRoot = makeTmpDir("session-manager-lifecycle-dispatch-");
process.env.BOBBIT_DIR = tmpRoot;

const { SessionManager } = await import("../../src/server/agent/session-manager.ts");
const { PromptQueue } = await import("../../src/server/agent/prompt-queue.ts");
const { EventBuffer } = await import("../../src/server/agent/event-buffer.ts");

const managers: any[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	while (managers.length > 0) {
		const manager = managers.pop();
		if (manager._statusHeartbeatTimer) clearInterval(manager._statusHeartbeatTimer);
		manager.sessions?.clear();
	}
});

function makeStore(session?: any) {
	let record = session;
	const archiveAsync = vi.fn(async (id: string) => {
		if (!record || record.id !== id) return false;
		record.archived = true;
		return true;
	});
	return {
		get: vi.fn(() => record),
		getLive: vi.fn(() => record && !record.archived ? [record] : []),
		archiveAsync,
		update: vi.fn(() => {}),
	};
}

function makeManager(store = makeStore()): any {
	const manager: any = new SessionManager();
	manager._testStore = store;
	managers.push(manager);
	return manager;
}

function scopeCoordinates(overrides: Record<string, unknown> = {}) {
	return {
		projectId: "project-1",
		goalId: undefined,
		teamGoalId: "team-goal-1",
		role: "reviewer",
		cwd: "/workspace/project",
		worktreePath: "/workspace/wt/reviewer",
		repoPath: "/repos/project",
		repoWorktrees: [
			{ repo: ".", worktreePath: "/workspace/wt/reviewer" },
			{ repo: "packages/api", worktreePath: "/workspace/wt/api" },
		],
		...overrides,
	};
}

function expectedScope(source: any) {
	const repoWorktrees = Array.isArray(source.repoWorktrees)
		? Object.fromEntries(source.repoWorktrees.map(({ repo, worktreePath }: any) => [repo, worktreePath]))
		: source.repoWorktrees;
	return {
		projectId: source.projectId,
		goalId: source.goalId ?? source.teamGoalId,
		roleName: source.role,
		cwd: source.cwd,
		worktreePath: source.worktreePath,
		repoPath: source.repoPath,
		repoWorktrees,
	};
}

describe("SessionManager lifecycle dispatch boundaries", () => {
	it("dispatches afterTurn once with effective goal and scope coordinates without delaying terminal settlement", async () => {
		const manager = makeManager();
		const dispatch = vi.fn(async () => { throw new Error("after-turn provider failed"); });
		manager.lifecycleHub = { dispatch };
		const coordinates = scopeCoordinates();
		const session: any = {
			id: "session-after-turn",
			...coordinates,
			status: "streaming",
			statusVersion: 1,
			createdAt: Date.now(),
			lastActivity: Date.now(),
			clients: new Set(),
			promptQueue: new PromptQueue(),
			eventBuffer: new EventBuffer(),
			latestTurnUserText: "Summarize the findings",
			latestTurnAssistantText: "Summary complete.",
			rpcClient: { prompt: vi.fn(async () => ({ success: true })) },
		};
		manager.sessions.set(session.id, session);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const terminalAssistant = {
			type: "message_end",
			message: {
				role: "assistant",
				provider: "anthropic",
				model: "claude-test",
				usage: { input: 21, output: 8, cacheRead: 5, cacheWrite: 0, cost: { total: 0.12 } },
			},
		};
		manager.handleAgentLifecycle(session, terminalAssistant);
		manager.trackCostFromEvent(session, terminalAssistant);
		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false });

		assert.equal(session.status, "idle", "provider failures never delay terminal settlement");
		assert.equal(session.completedTurnCount, 1);
		await vi.waitFor(() => assert.equal(dispatch.mock.calls.length, 1));
		assert.deepEqual(dispatch.mock.calls[0], [
			"afterTurn",
			{
				sessionId: session.id,
				projectId: coordinates.projectId,
				scope: "project",
				cwd: coordinates.cwd,
				goalId: coordinates.teamGoalId,
				roleName: coordinates.role,
				prompt: session.latestTurnUserText,
				userText: session.latestTurnUserText,
				assistantText: session.latestTurnAssistantText,
				turn: { index: 1 },
				cadenceTurnIndex: 1,
				usage: {
					telemetry: "known",
					inputTokens: 21,
					outputTokens: 8,
					cacheReadTokens: 5,
					cacheWriteTokens: 0,
					cost: 0.12,
					provider: "anthropic",
					modelId: "claude-test",
				},
			},
			expectedScope(coordinates),
		]);
		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false });
		await Promise.resolve();
		assert.equal(dispatch.mock.calls.length, 1, "duplicate agent_end cannot emit a second afterTurn");
		warn.mockRestore();
	});

	it("uses the final retry attempt's snapshot and reports unknown telemetry when it has none", async () => {
		const manager = makeManager();
		const dispatch = vi.fn(async () => ({ blocks: [], diagnostics: [] }));
		manager.lifecycleHub = { dispatch };
		const session: any = {
			id: "session-retry-usage",
			...scopeCoordinates(),
			status: "streaming",
			statusVersion: 1,
			createdAt: Date.now(),
			lastActivity: Date.now(),
			setupComplete: true,
			clients: new Set(),
			promptQueue: new PromptQueue(),
			eventBuffer: new EventBuffer(),
			rpcClient: { prompt: vi.fn(async () => ({ success: true })) },
		};
		manager.sessions.set(session.id, session);

		const firstAttempt = { type: "message_end", message: { role: "assistant", usage: { input: 3, cost: 0.01 } } };
		manager.handleAgentLifecycle(session, firstAttempt);
		manager.trackCostFromEvent(session, firstAttempt);
		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: true });
		expect(dispatch).not.toHaveBeenCalled();

		manager.handleAgentLifecycle(session, { type: "agent_start" });
		manager.handleAgentLifecycle(session, { type: "message_end", message: { role: "assistant" } });
		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false });
		await vi.waitFor(() => assert.equal(dispatch.mock.calls.length, 1));
		expect((dispatch.mock.calls[0] as unknown as any[])[1].usage).toEqual({ telemetry: "unknown" });
	});

	it("preserves reported usage for terminal error and abort outcomes", async () => {
		for (const [id, stopReason, errorMessage] of [
			["session-error-usage", "error", "provider failed"],
			["session-abort-usage", "aborted", undefined],
		] as const) {
			const manager = makeManager();
			const dispatch = vi.fn(async () => ({ blocks: [], diagnostics: [] }));
			manager.lifecycleHub = { dispatch };
			const session: any = {
				id,
				...scopeCoordinates(),
				status: "streaming",
				statusVersion: 1,
				createdAt: Date.now(),
				lastActivity: Date.now(),
				setupComplete: true,
				clients: new Set(),
				promptQueue: new PromptQueue(),
				eventBuffer: new EventBuffer(),
				rpcClient: { prompt: vi.fn(async () => ({ success: true })) },
			};
			const terminal = { type: "message_end", message: {
				role: "assistant", stopReason, errorMessage, usage: { input: 7, cost: 0.03 },
			} };
			manager.handleAgentLifecycle(session, terminal);
			manager.trackCostFromEvent(session, terminal);
			manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false });
			await vi.waitFor(() => assert.equal(dispatch.mock.calls.length, 1));
			expect((dispatch.mock.calls[0] as unknown as any[])[1].usage).toMatchObject({ telemetry: "known", inputTokens: 7, cost: 0.03 });
		}
	});

	it("does not allocate terminal usage state when no lifecycle hub is installed", () => {
		const manager = makeManager();
		const session: any = {
			id: "session-no-usage-hub",
			...scopeCoordinates(),
			status: "streaming",
			statusVersion: 1,
			createdAt: Date.now(),
			lastActivity: Date.now(),
			setupComplete: true,
			clients: new Set(),
			promptQueue: new PromptQueue(),
			eventBuffer: new EventBuffer(),
			rpcClient: { prompt: vi.fn(async () => ({ success: true })) },
		};
		const terminal = { type: "message_end", message: { role: "assistant", usage: { input: 4, cost: 0.02 } } };
		manager.handleAgentLifecycle(session, terminal);
		manager.trackCostFromEvent(session, terminal);
		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false });
		expect(session.terminalTurnUsage).toBeUndefined();
	});

	it("persists advisor cadence before detached ordinary and scheduled afterTurn dispatch", async () => {
		const store = makeStore();
		const manager = makeManager(store);
		const pending = new Promise<void>(() => {});
		const dispatch = vi.fn(async () => {});
		const dispatchScheduledAdvisors = vi.fn(async () => pending);
		manager.lifecycleHub = { dispatch, dispatchScheduledAdvisors };
		const coordinates = scopeCoordinates();
		const session: any = {
			// Simulate a restored session: ordinary telemetry starts fresh while the
			// persisted cadence remains the sole scheduler clock.
			id: "session-scheduled-advisor", ...coordinates, status: "streaming", statusVersion: 1,
			completedTurnCount: 41, scheduledAdvisorTurnCount: 5,
			createdAt: Date.now(), lastActivity: Date.now(), clients: new Set(),
			promptQueue: new PromptQueue(), eventBuffer: new EventBuffer(),
			rpcClient: { prompt: vi.fn(async () => ({ success: true })) },
		};
		manager.sessions.set(session.id, session);

		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false });
		assert.equal(session.status, "idle", "a pending advisor cannot delay terminal settlement");
		assert.equal(session.completedTurnCount, 42);
		assert.equal(session.scheduledAdvisorTurnCount, 6);
		await vi.waitFor(() => assert.equal(dispatchScheduledAdvisors.mock.calls.length, 1));
		assert.equal(dispatch.mock.invocationCallOrder[0] < dispatchScheduledAdvisors.mock.invocationCallOrder[0], true);
		assert.equal((dispatch.mock.calls[0] as unknown as any[])[1].turn.index, 42, "ordinary turn telemetry retains completedTurnCount semantics");
		assert.equal((dispatch.mock.calls[0] as unknown as any[])[1].cadenceTurnIndex, 6, "scheduled decisions use the persisted restore-safe cadence");
		assert.equal(store.update.mock.calls.some(([, update]: any[]) => update.scheduledAdvisorTurnCount === 6), true, "cadence is persisted before detached scheduling");

		manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false });
		assert.equal(session.scheduledAdvisorTurnCount, 6, "duplicate terminal events do not advance cadence");
	});

	it("continues dormant archival after a rejected sessionShutdown dispatch", async () => {
		const persisted = {
			id: "session-dormant-archive",
			...scopeCoordinates({
				role: "delegate",
				repoWorktrees: {
					".": "/workspace/wt/reviewer",
					"packages/api": "/workspace/wt/api",
				},
			}),
		};
		const store = makeStore(persisted);
		const manager = makeManager(store);
		const dispatch = vi.fn(async () => { throw new Error("shutdown provider failed"); });
		const cancelScheduledAdvisors = vi.fn();
		manager.lifecycleHub = { dispatch, cancelScheduledAdvisors };
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		assert.equal(await manager.storeArchive(persisted.id), true, "archive completes despite provider rejection");
		assert.deepEqual(cancelScheduledAdvisors.mock.calls, [[{ sessionId: persisted.id }]], "real hubs cancel active advisors before archival");
		assert.equal(store.archiveAsync.mock.calls.length, 1);
		assert.deepEqual(dispatch.mock.calls, [[
			"sessionShutdown",
			{
				sessionId: persisted.id,
				projectId: persisted.projectId,
				scope: "project",
				cwd: persisted.cwd,
				goalId: persisted.teamGoalId,
				roleName: persisted.role,
			},
			expectedScope(persisted),
		]]);
		warn.mockRestore();
	});

	it("continues live termination after a rejected sessionShutdown dispatch", async () => {
		const store = makeStore();
		const manager = makeManager(store);
		const dispatch = vi.fn(async () => { throw new Error("shutdown provider failed"); });
		manager.lifecycleHub = { dispatch };
		const coordinates = scopeCoordinates({ goalId: "session-goal-1", teamGoalId: "team-goal-ignored" });
		const session: any = {
			id: "session-live-terminate",
			title: "Live termination",
			titleGenerated: true,
			...coordinates,
			status: "idle",
			statusVersion: 1,
			createdAt: Date.now(),
			lastActivity: Date.now(),
			clients: new Set(),
			promptQueue: new PromptQueue(),
			eventBuffer: new EventBuffer(),
			unsubscribe: vi.fn(),
			rpcClient: {
				getState: vi.fn(async () => ({ success: true })),
				stop: vi.fn(async () => {}),
				prompt: vi.fn(async () => ({ success: true })),
			},
		};
		(store.get as any).mockImplementation(() => session);
		(store.getLive as any).mockImplementation(() => [session]);
		manager.sessions.set(session.id, session);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		assert.equal(await manager.terminateSession(session.id), true, "termination completes despite provider rejection");
		assert.equal(store.archiveAsync.mock.calls.length, 1);
		assert.deepEqual(dispatch.mock.calls, [[
			"sessionShutdown",
			{
				sessionId: session.id,
				projectId: coordinates.projectId,
				scope: "project",
				cwd: coordinates.cwd,
				goalId: coordinates.goalId,
				roleName: coordinates.role,
			},
			expectedScope(coordinates),
		]]);
		warn.mockRestore();
	});
});
