import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it, vi } from "vitest";

import {
	closeGatewayListeners,
	createGatewayShutdownOnce,
	observeDeferredShutdownPhase,
	runGatewayShutdownPhases,
	stopWorktreePoolsForShutdown,
} from "../../../src/server/server.ts";
import {
	SESSION_STARTUP_SHUTDOWN_CODE,
	SessionManager,
	SessionStartupShutdownError,
} from "../../../src/server/agent/session-manager.ts";
import type { WorktreePool } from "../../../src/server/agent/worktree-pool.ts";
import type { PoolRecordSink } from "../../../src/server/agent/worktree-pool-record.ts";

describe("gateway shutdown is idempotent", () => {
	it("awaits both listener close callbacks after starting them together", async () => {
		const callbacks = new Map<string, (error?: Error) => void>();
		const closeable = (name: string) => ({
			close(callback: (error?: Error) => void) { callbacks.set(name, callback); },
		});
		let settled = false;
		const closing = closeGatewayListeners(closeable("http"), closeable("ws"))
			.then(() => { settled = true; });

		assert.deepEqual([...callbacks.keys()], ["http", "ws"]);
		callbacks.get("http")!();
		await Promise.resolve();
		assert.equal(settled, false, "HTTP closure alone must not release teardown");
		callbacks.get("ws")!();
		await closing;
		assert.equal(settled, true);
	});

	it("continues later teardown phases and aggregates phase failures", async () => {
		const events: string[] = [];
		const firstFailure = new Error("first failed");
		const thirdFailure = new Error("third failed");
		await assert.rejects(
			runGatewayShutdownPhases([
				{ name: "first", run: () => { events.push("first"); throw firstFailure; } },
				{ name: "second", run: () => { events.push("second"); } },
				{ name: "third", run: async () => { events.push("third"); throw thirdFailure; } },
			]),
			(error: unknown) => {
				assert.ok(error instanceof AggregateError);
				assert.match(error.message, /first, third/);
				assert.equal(error.errors.length, 2);
				return true;
			},
		);
		assert.deepEqual(events, ["first", "second", "third"]);
	});

	it("observes an eager phase immediately and reports its failure at the ordered join", async () => {
		const listenerFailure = new Error("listener close failed");
		const eagerClose = Promise.reject(listenerFailure);
		const catchSpy = vi.spyOn(eagerClose, "catch");
		const listenerClose = observeDeferredShutdownPhase(eagerClose);

		assert.strictEqual(listenerClose, eagerClose, "the original outcome must remain the join authority");
		assert.equal(catchSpy.mock.calls.length, 1, "rejection observation must attach synchronously");
		await Promise.resolve();

		const events: string[] = [];
		await assert.rejects(
			runGatewayShutdownPhases([
				{ name: "owner", run: () => { events.push("owner"); } },
				{ name: "listeners", run: async () => { events.push("listeners"); await listenerClose; } },
				{ name: "after", run: () => { events.push("after"); } },
			]),
			(error: unknown) => {
				assert.ok(error instanceof AggregateError);
				assert.match(error.message, /listeners/);
				assert.equal((error.errors[0] as Error).cause, listenerFailure);
				return true;
			},
		);
		assert.deepEqual(events, ["owner", "listeners", "after"]);
	});

	it("closes session admission before listeners while preserving WebSocket closure order", () => {
		const source = readFileSync(new URL("../../../src/server/server.ts", import.meta.url), "utf8");
		const start = source.indexOf("sessionManager.beginTerminalShutdown();");
		const listener = source.indexOf("observeDeferredShutdownPhase(closeBoundServer())", start);
		const sessionPhase = source.indexOf('{ name: "session-manager"', listener);
		const websocketPhase = source.indexOf('name: "websocket-clients"', sessionPhase);
		const listenerPhase = source.indexOf('{ name: "listeners"', websocketPhase);
		assert.ok(start >= 0 && listener > start, "terminal admission closes synchronously before listener close starts");
		assert.ok(sessionPhase > listener, "session owners still drain in their established phase");
		assert.ok(websocketPhase > sessionPhase, "WebSocket clients still close after session teardown");
		assert.ok(listenerPhase > websocketPhase, "listener join remains the final network phase");
	});

	it("keeps run-root removal behind the verification command-tree barrier", async () => {
		let releaseVerification!: () => void;
		const verificationBarrier = new Promise<void>(resolve => { releaseVerification = resolve; });
		const events: string[] = [];

		const gatewayShutdown = runGatewayShutdownPhases([
			{ name: "verification-harness", run: async () => { events.push("verification:start"); await verificationBarrier; events.push("verification:done"); } },
			{ name: "session-manager", run: () => { events.push("sessions"); } },
			{ name: "listeners", run: () => { events.push("listeners"); } },
		]);
		const shutdownThenRemove = gatewayShutdown.then(() => { events.push("remove-run-root"); });
		await Promise.resolve();
		assert.deepEqual(events, ["verification:start"]);

		releaseVerification();
		await shutdownThenRemove;
		assert.deepEqual(events, ["verification:start", "verification:done", "sessions", "listeners", "remove-run-root"]);
	});

	it("retains the run root but drains later gateway phases after verification cleanup fails", async () => {
		const events: string[] = [];
		let removed = false;
		const gatewayShutdown = runGatewayShutdownPhases([
			{ name: "verification-harness", run: async () => { events.push("verification"); throw new Error("tree exit unverified"); } },
			{ name: "session-manager", run: () => { events.push("sessions"); } },
			{ name: "listeners", run: () => { events.push("listeners"); } },
		]);

		await assert.rejects(
			gatewayShutdown.then(() => { removed = true; }),
			(error: unknown) => {
				assert.ok(error instanceof AggregateError);
				assert.match(error.message, /verification-harness/);
				return true;
			},
		);
		assert.deepEqual(events, ["verification", "sessions", "listeners"]);
		assert.equal(removed, false, "failed owner cleanup must prevent run-root removal");
	});

	it("shares one production teardown across concurrent and late callers", async () => {
		let release!: () => void;
		const blocked = new Promise<void>(resolve => { release = resolve; });
		let runs = 0;
		const once = createGatewayShutdownOnce();
		const shutdown = () => once(async () => {
			runs++;
			await blocked;
		});

		const first = shutdown();
		const second = shutdown();
		assert.strictEqual(second, first, "concurrent callers must receive the same promise");
		assert.equal(runs, 1);
		release();
		await Promise.all([first, second]);

		const late = shutdown();
		assert.strictEqual(late, first, "late callers must receive the completed promise");
		await late;
		assert.equal(runs, 1);
	});

	it("memoizes a teardown failure instead of retrying it", async () => {
		const expected = new Error("teardown failed");
		let runs = 0;
		const once = createGatewayShutdownOnce();
		const shutdown = () => once(async () => { runs++; throw expected; });

		const results = await Promise.allSettled([shutdown(), shutdown()]);
		assert.deepEqual(results.map(result => result.status), ["rejected", "rejected"]);
		assert.ok(results.every(result => result.status === "rejected" && result.reason === expected));
		await assert.rejects(shutdown(), error => error === expected);
		assert.equal(runs, 1);
	});
});

describe("session-manager terminal owner shutdown", () => {
	it("closes startup admission synchronously and drains nested detached setup before snapshot", async () => {
		let releaseParent!: () => void;
		let releaseDetached!: () => void;
		const parentGate = new Promise<void>(resolve => { releaseParent = resolve; });
		const detachedGate = new Promise<void>(resolve => { releaseDetached = resolve; });
		const events: string[] = [];
		const manager: any = new SessionManager();
		manager.createSessionOwned = async () => {
			events.push("create:admitted");
			await parentGate;
			const detached = (async () => {
				events.push("worktree:admitted");
				await detachedGate;
				manager.assertTerminalStartupAllowed();
				events.push("worktree:published");
			})();
			manager.trackDetachedTerminalStartup("worktree:fixture", detached);
			void detached.catch(() => undefined);
			return { id: "preparing" };
		};

		const creating = manager.createSession("C:/fixture");
		await Promise.resolve();
		assert.deepEqual(events, ["create:admitted"]);

		manager.beginTerminalShutdown();
		const shutdown = manager.shutdown();
		await assert.rejects(
			manager.createSession("C:/late"),
			(error: any) => error?.code === SESSION_STARTUP_SHUTDOWN_CODE,
		);

		releaseParent();
		await creating;
		await Promise.resolve();
		assert.deepEqual(events, ["create:admitted", "worktree:admitted"]);
		let shutdownSettled = false;
		void shutdown.finally(() => { shutdownSettled = true; });
		await Promise.resolve();
		assert.equal(shutdownSettled, false, "detached setup registered by an admitted parent remains in the drain");

		releaseDetached();
		await shutdown;
		assert.equal(events.includes("worktree:published"), false, "terminal setup must not publish after the latch");
	});

	it("rejects public startup admissions and fences a pre-admitted restart continuation", async () => {
		let signalRestartEntered!: () => void;
		let releaseRestart!: () => void;
		const restartEntered = new Promise<void>(resolve => { signalRestartEntered = resolve; });
		const restartGate = new Promise<void>(resolve => { releaseRestart = resolve; });
		const manager: any = new SessionManager();
		const session = {
			id: "restart",
			title: "restart fixture",
			cwd: "C:/fixture",
			status: "idle",
			clients: new Set(),
			unsubscribe() {},
		};
		manager.sessions.set(session.id, session);
		manager.assertSessionGoalPromotionMutationAllowed = () => undefined;
		manager._assertModelSelectionReady = () => undefined;
		manager.resolveStoreForSession = () => ({ get: () => ({ id: session.id }) });
		manager.recomputeAllowedToolsForRestart = async () => {
			signalRestartEntered();
			await restartGate;
			return undefined;
		};
		manager._respawnAgentInPlace = async () => assert.fail("a latch-crossing restart must not respawn");

		const preAdmittedRestart = manager.restartAgent(session.id);
		await restartEntered;
		manager.beginTerminalShutdown();

		const admissionLabels = ["create", "delegate", "restart", "restore"];
		const lateAdmissions = await Promise.allSettled([
			manager.createSession("C:/late"),
			manager.createDelegateSession("parent", { instructions: "x", cwd: "C:/late" }),
			manager.restartAgent(session.id),
			manager.restoreSessions(),
		]);
		for (let index = 0; index < lateAdmissions.length; index++) {
			const result = lateAdmissions[index];
			assert.equal(result.status, "rejected", `${admissionLabels[index]} must reject after admission closes`);
			assert.ok(result.reason instanceof SessionStartupShutdownError);
			assert.equal(result.reason.code, SESSION_STARTUP_SHUTDOWN_CODE);
		}

		releaseRestart();
		await assert.rejects(
			preAdmittedRestart,
			(error: unknown) => error instanceof SessionStartupShutdownError
				&& error.code === SESSION_STARTUP_SHUTDOWN_CODE,
		);
		manager.sessions.delete(session.id);
		await manager.shutdown();
	});

	it("bounds a stuck admitted startup and retains the shutdown failure", async () => {
		let now = 0;
		const clock: any = {
			now: () => now,
			setTimeout(handler: () => void, ms: number) {
				now += ms;
				queueMicrotask(handler);
				return 1;
			},
			clearTimeout() {},
			setInterval() { return 2; },
			clearInterval() {},
		};
		const manager: any = new SessionManager({ clock });
		manager.createSessionOwned = () => new Promise(() => {});
		void manager.createSession("C:/stuck");

		await assert.rejects(manager.shutdown(), (error: unknown) => {
			assert.ok(error instanceof AggregateError);
			assert.match(String(error), /session-startup-drain/);
			const startupFailure = error.errors.find((entry: Error) => /session-startup-drain/.test(entry.message));
			assert.match(String(startupFailure?.cause), /timed out after 15000ms/);
			assert.match(String(startupFailure?.cause), /create:new/);
			return true;
		});
	});

	it("retains a latch-crossing startup owner when exact cleanup proof fails", async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		let terminalCalls = 0;
		const events: string[] = [];
		const manager: any = new SessionManager();
		manager._testGoalStore = { async close() { events.push("store"); } };
		manager._testTaskStore = null;
		manager.createSessionOwned = async () => {
			const session: any = {
				id: "late-startup-owner",
				title: "late startup",
				cwd: "C:/owned/worktree",
				status: "starting",
				clients: new Set(),
				unsubscribe() {},
				rpcClient: {
					async stop() { assert.fail("terminal cleanup must use exact-tree ownership"); },
					async terminateOwnedTree() {
						terminalCalls++;
						throw new Error("tree proof failed token=startup-secret");
					},
				},
			};
			await gate;
			try {
				manager.assertTerminalStartupAllowed();
			} catch (error) {
				await manager.cleanupTerminalStartupOwner(session);
				throw error;
			}
			return session;
		};

		const creating = manager.createSession("C:/fixture");
		await Promise.resolve();
		const shutdown = manager.shutdown();
		release();
		await assert.rejects(creating);
		await assert.rejects(shutdown, (error: unknown) => {
			assert.ok(error instanceof AggregateError);
			assert.match(String(error), /session-startup-drain|late-startup-owner/);
			assert.doesNotMatch(String(error), /startup-secret/);
			return true;
		});

		const retained = manager.sessions.get("late-startup-owner");
		assert.ok(retained, "failed cleanup retains the exact startup owner");
		assert.equal(retained.terminalCleanupPending?.phase, "runtime");
		assert.match(retained.terminalCleanupPending?.errors[0] ?? "", /<redacted-token>/);
		assert.equal(terminalCalls, 1, "the retained owner is not killed a second time by the snapshot");
		assert.deepEqual(events, ["store"], "unrelated manager phases still drain");
	});

	it("joins an in-flight default MCP initialization and disconnects its late owner", async () => {
		let connectStarted!: () => void;
		let releaseConnect!: () => void;
		const started = new Promise<void>(resolve => { connectStarted = resolve; });
		const connect = new Promise<void>(resolve => { releaseConnect = resolve; });
		const events: string[] = [];
		const manager: any = new SessionManager();
		manager.createMcpManager = () => ({
			async connectAll() { events.push("connect"); connectStarted(); await connect; },
			async disconnectAll() { events.push("disconnect"); },
		});

		const initializing = manager.initMcp("C:/fixture");
		await started;
		const shutdown = manager.shutdown();
		await Promise.resolve();
		assert.deepEqual(events, ["connect"]);
		releaseConnect();
		await Promise.all([initializing, shutdown]);
		assert.deepEqual(events, ["connect", "disconnect"]);
		assert.equal(manager.mcpManager, null, "the late owner must never become active");
	});

	it("joins MCP initialization, disconnects each unique owner once, then closes stores", async () => {
		let releaseInitialization!: () => void;
		const initialization = new Promise<void>(resolve => { releaseInitialization = resolve; });
		const events: string[] = [];
		const mcp = { async disconnectAll() { events.push("mcp"); } };
		const manager: any = new SessionManager();
		manager.mcpManager = mcp;
		manager.scopedMcpManagers.set("project:p", mcp);
		manager.mcpManagerInitializations.set("project:p", initialization);
		manager._testGoalStore = { async close() { events.push("store"); } };
		manager._testTaskStore = null;

		const first = manager.shutdown();
		const second = manager.shutdown();
		await Promise.resolve();
		assert.deepEqual(events, [], "resource teardown must wait for initialization ownership");
		releaseInitialization();
		await Promise.all([first, second]);
		assert.deepEqual(events, ["mcp", "store"]);

		await manager.shutdown();
		assert.deepEqual(events, ["mcp", "store"], "late shutdown must not rerun owners or stores");
	});

	it("continues disconnecting owners and closes stores after an owner failure", async () => {
		const events: string[] = [];
		const manager: any = new SessionManager();
		manager.mcpManager = {
			async disconnectAll() { events.push("mcp:failed"); throw new Error("disconnect failed"); },
		};
		manager.scopedMcpManagers.set("project:p", {
			async disconnectAll() { events.push("mcp:ok"); },
		});
		manager._testGoalStore = { async close() { events.push("store"); } };
		manager._testTaskStore = null;

		await assert.rejects(manager.shutdown(), (error: unknown) => {
			assert.ok(error instanceof AggregateError);
			assert.match(error.message, /mcp-disconnect/);
			return true;
		});
		assert.deepEqual(events.slice(0, 2).sort(), ["mcp:failed", "mcp:ok"]);
		assert.equal(events.at(-1), "store", "stores close only after terminal MCP owners settle");

		await assert.rejects(manager.shutdown());
		assert.equal(events.filter(event => event === "store").length, 1, "failed shutdown is still exact-once");
	});

	it("retains an unverified session runtime owner and blocks dependent root cleanup", async () => {
		const events: string[] = [];
		let terminalCalls = 0;
		let closeCalls = 0;
		let untrackCalls = 0;
		let removed = false;
		const bridge = {
			running: true,
			async getState() { return { success: true, data: {} }; },
			async stop() { assert.fail("terminal shutdown must not use ordinary stop"); },
			async terminateOwnedTree() {
				terminalCalls++;
				throw new Error("tree proof failed token=super-secret-value");
			},
		};
		const client = { close() { closeCalls++; } };
		const session: any = {
			id: "cleanup-pending-session",
			title: "cleanup pending",
			cwd: "C:/owned/worktree",
			status: "streaming",
			clients: new Set([client]),
			rpcClient: bridge,
			unsubscribe() { events.push("unsubscribe"); },
		};
		const manager: any = new SessionManager();
		manager.sessions.set(session.id, session);
		manager.sessionsWithConnectedClients.add(session);
		manager._untrackConnectedSession = () => { untrackCalls++; };
		manager.mcpManager = { async disconnectAll() { events.push("mcp"); } };
		manager._testGoalStore = { async close() { events.push("store"); } };
		manager._testTaskStore = null;

		await assert.rejects(
			manager.shutdown().then(() => { removed = true; }),
			(error: unknown) => {
				assert.ok(error instanceof AggregateError);
				assert.match(error.message, /session:cleanup-pending-session:runtime/);
				assert.doesNotMatch(String(error), /super-secret-value/);
				return true;
			},
		);

		assert.equal(terminalCalls, 1, "terminal shutdown requests exactly one bounded owned-tree proof");
		assert.strictEqual(manager.sessions.get(session.id), session, "the exact runtime owner must remain tracked");
		assert.equal(session.status, "streaming", "an unverified runtime must not be finalized as terminated");
		assert.equal(session.terminalCleanupPending?.phase, "runtime");
		assert.equal(session.terminalCleanupPending?.attempts, 1);
		assert.match(session.terminalCleanupPending?.errors[0] ?? "", /<redacted-token>/);
		assert.equal(closeCalls, 0, "client finalization follows verified runtime exit");
		assert.equal(untrackCalls, 0, "cleanup-pending owners must not be untracked");
		assert.equal(removed, false, "a rejected gateway owner barrier must block root removal");
		assert.deepEqual(events, ["unsubscribe", "mcp", "store"], "unrelated shutdown phases still drain");
	});

	it("finalizes a retained session only after the bounded runtime barrier succeeds", async () => {
		let releaseExit!: () => void;
		const exitBarrier = new Promise<void>(resolve => { releaseExit = resolve; });
		let terminalCalls = 0;
		let closeCalls = 0;
		let untrackCalls = 0;
		const bridge = {
			running: true,
			async getState() { return { success: true, data: {} }; },
			async stop() { assert.fail("terminal shutdown must not use ordinary stop"); },
			async terminateOwnedTree() {
				terminalCalls++;
				await exitBarrier;
				bridge.running = false;
			},
		};
		const session: any = {
			id: "eventually-stopped-session",
			title: "eventually stopped",
			cwd: "C:/owned/worktree",
			status: "streaming",
			clients: new Set([{ close() { closeCalls++; } }]),
			rpcClient: bridge,
			unsubscribe() {},
		};
		const manager: any = new SessionManager();
		manager.sessions.set(session.id, session);
		manager._untrackConnectedSession = () => { untrackCalls++; };

		const shutdown = manager.shutdown();
		while (terminalCalls < 1) await Promise.resolve();
		assert.strictEqual(manager.sessions.get(session.id), session, "ownership remains live while exit is unverified");
		assert.equal(closeCalls, 0);
		assert.equal(untrackCalls, 0);

		releaseExit();
		await shutdown;
		assert.equal(manager.sessions.has(session.id), false);
		assert.equal(session.status, "terminated");
		assert.equal(closeCalls, 1);
		assert.equal(untrackCalls, 1);
		assert.equal(session.terminalCleanupPending, undefined);
	});
});

describe("graceful worktree-pool shutdown", () => {
	it("stops every pool, flushes ownership, and never drains retained entries", async () => {
		const events: string[] = [];
		const pool = (id: string) => ({
			async stop() { events.push(`stop:${id}`); },
			async drain() { events.push(`drain:${id}`); },
		});
		const pools = new Map([
			["alpha", pool("alpha")],
			["beta", pool("beta")],
		]);
		const recordStore = { async flush() { events.push("flush"); } };

		await stopWorktreePoolsForShutdown(pools, recordStore, 1_000);

		assert.deepEqual(new Set(events.slice(0, 2)), new Set(["stop:alpha", "stop:beta"]));
		assert.equal(events[2], "flush", "the record is flushed after stop barriers settle");
		assert.ok(!events.some(event => event.startsWith("drain:")), "graceful shutdown retains ready entries");
	});

	it("still flushes when one pool cannot stop", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		let flushed = 0;
		try {
			await stopWorktreePoolsForShutdown(new Map([
				["broken", {
					async stop() { throw new Error("stop failed"); },
				}],
			]), { async flush() { flushed++; } }, 1_000);
		} finally {
			warn.mockRestore();
		}
		assert.equal(flushed, 1);
	});

	it("orders an existing live-pool deletion as drain, forget, then durable flush", async () => {
		const events: string[] = [];
		const records: PoolRecordSink = {
			replace() { assert.fail("an existing live-pool deletion must not reconstruct ownership"); },
			read() { return { entries: [] }; },
			forget(projectId: string) { events.push(`forget:${projectId}`); },
			async flush() { events.push("flush"); },
		};
		const manager = new SessionManager({ worktreePoolRecordStore: records });
		const pool = { async drain() { events.push("drain"); } } as WorktreePool;
		manager.getAllWorktreePools().set("project-1", pool);
		try {
			await manager.removeWorktreePool("project-1");

			assert.deepEqual(events, ["drain", "forget:project-1", "flush"]);
			assert.equal(manager.getWorktreePool("project-1"), null);
		} finally {
			await manager.shutdown();
		}
	});
});
