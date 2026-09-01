import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "vitest";
import { PromptQueue } from "../../../src/server/agent/prompt-queue.ts";
import { SessionManager } from "../../../src/server/agent/session-manager.ts";
import { SessionStore } from "../../../src/server/agent/session-store.ts";
import { createManualClock } from "../../../tests/support/harnesses/shared/clock.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function persisted(id: string, root: string) {
	return {
		id,
		title: id,
		cwd: root,
		agentSessionFile: "",
		createdAt: 1,
		lastActivity: 1,
	};
}

function liveSession(id: string, root: string, events: string[]): any {
	let stopped = false;
	const stateWaiters = new Set<(error: Error) => void>();
	return {
		...persisted(id, root),
		status: "streaming",
		statusVersion: 0,
		clients: new Set(),
		promptQueue: new PromptQueue(),
		rpcClient: {
			getState: () => {
				events.push(`${id}:get-state`);
				if (stopped) return Promise.resolve({ success: false, error: "bridge stopped" });
				return new Promise((_resolve, reject) => { stateWaiters.add(reject); });
			},
			stop: async () => {
				events.push(`${id}:stop`);
				stopped = true;
				for (const reject of stateWaiters) reject(new Error("process stopped"));
				stateWaiters.clear();
			},
		},
		unsubscribe: () => { events.push(`${id}:unsubscribe`); },
		isCompacting: false,
		titleGenerated: false,
		setupComplete: false,
		onStatusChanged: () => {},
		onEventAccepted: () => {},
	};
}

function lifecycleManager(store: SessionStore): any {
	const manager: any = Object.create(SessionManager.prototype);
	manager.sessions = new Map();
	manager._sessionReplacementCoordinators = new Map();
	manager._sessionRespawnGenerations = new Map();
	manager._bootRepromptedSessions = new Set();
	manager._taskIdCache = new Map();
	manager._statusHeartbeatTimer = null;
	manager.clock = {
		now: () => 2,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
	};
	manager._testStore = store;
	manager._testGoalStore = null;
	manager._testTaskStore = null;
	manager._testCostTracker = undefined;
	manager._testSearchIndex = undefined;
	manager.projectContextManager = undefined;
	manager.sessionSecretStore = { remove: () => {} };
	manager.clearToolCallProvenance = () => {};
	manager.closeExtensionChannelsForSession = async () => {};
	manager.cancelPendingAutoRetry = () => {};
	manager._consumeSteerEcho = () => {};
	manager.publishSessionNotification = () => {};
	manager.resolveIdleWaiters = () => {};
	manager.rejectIdleWaiters = () => {};
	manager.rejectAllVerifierPromptReceipts = () => {};
	manager.schedulePromptCursorRefresh = () => {};
	manager.drainQueue = () => {};
	manager.purgeVerifierPromptRows = () => {};
	manager.cascadeReapOwner = async () => {};
	manager.cleanupScopedMcpManagersForSessionScope = async () => {};
	manager.dispatchSessionShutdownInterceptor = async () => {};
	manager.archivePersistedSession = async (id: string, target: SessionStore) => {
		manager._events.push(`${id}:archive`);
		await target.archiveAsync(id);
		return true;
	};
	manager.assertSessionGoalPromotionMutationAllowed = () => {};
	manager.assertPromotedSessionLifecycleAllowed = () => {};
	manager.assertWorktreeOwnerHasNoLiveBorrowers = () => {};
	manager.stopPurgeSchedule = async () => {};
	manager._untrackConnectedSession = () => {};
	return manager;
}

async function advanceMicrotasks(count = 8): Promise<void> {
	for (let index = 0; index < count; index++) await Promise.resolve();
}

it("fences late first-turn metadata and uses process stop to settle terminate, quiesce, and shutdown", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-first-turn-finalizer-"));
	try {
		for (const terminal of ["terminate", "quiesce", "shutdown"] as const) {
			const stateDir = path.join(root, terminal);
			const store = new SessionStore(stateDir);
			const manager = lifecycleManager(store);
			const events: string[] = [];
			manager._events = events;
			const flushStarted = deferred();
			const flushGate = deferred();
			const id = `first-turn-${terminal}`;
			const preIdleSessionFile = path.join(root, `${id}-pre-idle.jsonl`);
			const session = liveSession(id, root, events);
			store.put({ ...persisted(id, root), agentSessionFile: preIdleSessionFile });
			await store.flushAsync();

			const flushAsync = store.flushAsync.bind(store);
			store.flushAsync = async () => {
				events.push(`${id}:flush-start`);
				flushStarted.resolve();
				await flushGate.promise;
				await flushAsync();
				events.push(`${id}:flush-end`);
			};
			const finishSessionSetup = manager._finishSessionSetup.bind(manager);
			manager._finishSessionSetup = async (target: any) => {
				events.push(`${id}:setup-start`);
				await finishSessionSetup(target);
				events.push(`${id}:setup-end`);
			};
			manager.sessions.set(id, session);

			manager.trackSessionMetadataWork(session, async () => {
				events.push(`${id}:predecessor-start`);
				await manager.persistSessionMetadata(session);
				events.push(`${id}:predecessor-end`);
			});
			manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false, messages: [] });
			await advanceMicrotasks(2);
			const ownerAtFence = session.pendingMetadataPersist;
			assert.ok(ownerAtFence, "predecessor and real first-turn finalizer must share one registered lane");

			let lateAdmissionBlocked = false;
			session.unsubscribe = () => {
				events.push(`${id}:unsubscribe`);
				// Model an already-queued terminal frame arriving at listener removal.
				// Resetting this flag makes a second finalizer observable if the lifecycle
				// fence is not authoritative.
				session.setupComplete = false;
				manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false, messages: [] });
				lateAdmissionBlocked = session.pendingMetadataPersist === ownerAtFence && session.setupComplete === false;
			};

			let teardownSettled = false;
			const teardown: Promise<unknown> = terminal === "terminate"
				? manager.terminateSession(id)
				: terminal === "quiesce"
					? manager.quiesceSessionRuntime(id)
					: manager.shutdown();
			void teardown.finally(() => { teardownSettled = true; });
			await flushStarted.promise;

			assert.equal(lateAdmissionBlocked, true, `${terminal} must reject lifecycle work queued at unsubscribe`);
			assert.equal(events.filter(event => event === `${id}:unsubscribe`).length, 1);
			assert.equal(events.filter(event => event === `${id}:stop`).length, 1);
			assert.equal(events.filter(event => event === `${id}:setup-start`).length, 1);
			assert.equal(events.filter(event => event === `${id}:flush-start`).length, 1);
			assert.equal(teardownSettled, false, `${terminal} must still join the real durable flush`);
			assert.ok(
				events.indexOf(`${id}:get-state`) < events.indexOf(`${id}:stop`),
				`${terminal} must issue final state before process cancellation`,
			);
			assert.ok(
				events.indexOf(`${id}:stop`) < events.indexOf(`${id}:predecessor-end`),
				"process stop must cancel the predecessor RPC without a retry delay",
			);

			flushGate.resolve();
			await teardown;

			assert.equal(session.pendingMetadataPersist, undefined);
			assert.ok(
				events.indexOf(`${id}:predecessor-end`) < events.indexOf(`${id}:setup-start`),
				"the first-turn finalizer must serialize behind its predecessor",
			);
			assert.ok(
				events.indexOf(`${id}:setup-start`) < events.indexOf(`${id}:flush-end`),
				"the real first-turn finalizer must durably flush before teardown",
			);
			if (terminal === "terminate") {
				assert.ok(events.indexOf(`${id}:flush-end`) < events.indexOf(`${id}:archive`));
			}
			assert.equal(manager.sessions.has(id), false, `${terminal} must remove runtime ownership only after the lane settles`);
			const durable = store.get(id);
			assert.equal(durable?.agentSessionFile, preIdleSessionFile, "terminal cancellation must preserve pre-idle metadata");
			assert.equal(durable?.archived === true, terminal === "terminate");
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

it("rechecks the terminal fence after a metadata retry timer fires but before its await continues", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-metadata-retry-fence-"));
	try {
		for (const failure of ["missing-session-file", "exception"] as const) {
			const store = new SessionStore(path.join(root, failure));
			const manager = lifecycleManager(store);
			const clock = createManualClock(10);
			const events: string[] = [];
			const id = `metadata-retry-${failure}`;
			const originalSessionFile = path.join(root, `${id}.jsonl`);
			const session = liveSession(id, root, events);
			let stateCalls = 0;
			manager.clock = clock;
			manager._events = events;
			session.rpcClient = {
				getState: async () => {
					stateCalls += 1;
					events.push(`${id}:get-state-${stateCalls}`);
					if (stateCalls === 1 && failure === "exception") throw new Error("metadata state failed");
					return { success: false, error: "no session file" };
				},
				stop: async () => { events.push(`${id}:stop`); },
			};
			store.put({ ...persisted(id, root), agentSessionFile: originalSessionFile });
			await store.flushAsync();
			manager.sessions.set(id, session);

			const owner = manager.trackSessionMetadataWork(session, () => manager.persistSessionMetadata(session));
			void owner.then(() => { events.push(`${id}:owner-settled`); });
			await advanceMicrotasks();
			assert.equal(stateCalls, 1);
			assert.equal(clock.pending(), 1, "the first failure must enter the existing 500ms live retry delay");

			// Fire the timer synchronously, but do not yield to its promise continuation.
			// The timer has already removed its cancellation callback at this point, so
			// only the post-await terminal predicate can prevent the second metadata RPC.
			clock.advance(500);
			assert.equal(session.pendingMetadataRetryCancellations?.size, 0);
			manager.fenceTerminalMetadataAdmission(session);
			await owner;

			assert.equal(stateCalls, 1, "the fired retry must not issue another metadata getState after the terminal fence");
			assert.equal(session.pendingMetadataPersist, undefined, "the cancelled metadata owner must settle without another clock advance");
			assert.equal(clock.pending(), 0);

			const cleaned = await manager.terminateSession(id);
			assert.equal(cleaned, true);
			assert.equal(stateCalls, 2, "terminal cleanup keeps its one final best-effort state request");
			assert.ok(events.indexOf(`${id}:owner-settled`) < events.indexOf(`${id}:get-state-2`));
			assert.ok(events.indexOf(`${id}:get-state-2`) < events.indexOf(`${id}:stop`));
			assert.ok(events.indexOf(`${id}:stop`) < events.indexOf(`${id}:archive`));
			assert.equal(manager.sessions.has(id), false);
			assert.equal(store.get(id)?.agentSessionFile, originalSessionFile);
			assert.equal(store.get(id)?.archived, true);
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
