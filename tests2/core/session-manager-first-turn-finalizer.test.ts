import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "vitest";
import { PromptQueue } from "../../src/server/agent/prompt-queue.ts";
import { SessionManager } from "../../src/server/agent/session-manager.ts";
import { SessionStore } from "../../src/server/agent/session-store.ts";

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
	return {
		...persisted(id, root),
		status: "streaming",
		statusVersion: 0,
		clients: new Set(),
		promptQueue: new PromptQueue(),
		rpcClient: {
			getState: async () => {
				events.push(`${id}:get-state`);
				return { success: true };
			},
			stop: async () => { events.push(`${id}:stop`); },
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
	manager.schedulePromptCursorRefresh = () => {};
	manager.drainQueue = () => {};
	manager.purgeVerifierPromptRows = () => {};
	manager.cascadeReapOwner = async () => {};
	manager.cleanupScopedMcpManagersForSessionScope = async () => {};
	manager.dispatchSessionShutdownInterceptor = async () => {};
	manager.archivePersistedSession = (id: string, target: SessionStore) => target.archiveAsync(id);
	manager.assertSessionGoalPromotionMutationAllowed = () => {};
	manager.assertPromotedSessionLifecycleAllowed = () => {};
	manager.stopPurgeSchedule = async () => {};
	manager._untrackConnectedSession = () => {};
	return manager;
}

async function advanceMicrotasks(count = 6): Promise<void> {
	for (let index = 0; index < count; index++) await Promise.resolve();
}

it("tracks the first-turn setup finalizer until terminate and shutdown join its metadata lane", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-first-turn-finalizer-"));
	try {
		for (const terminal of ["terminate", "shutdown"] as const) {
			const stateDir = path.join(root, terminal);
			const store = new SessionStore(stateDir);
			const manager = lifecycleManager(store);
			const events: string[] = [];
			const setupGate = deferred();
			const id = `first-turn-${terminal}`;
			const session = liveSession(id, root, events);
			store.put(persisted(id, root));
			await store.flushAsync();
			manager.sessions.set(id, session);
			manager._finishSessionSetup = async () => {
				events.push(`${id}:metadata-start`);
				await setupGate.promise;
				store.update(id, { lastActivity: 2 });
				await store.flushAsync();
				events.push(`${id}:metadata-end`);
			};

			manager.handleAgentLifecycle(session, { type: "agent_end", willRetry: false, messages: [] });
			assert.ok(session.pendingMetadataPersist, "the first-turn finalizer must be registered synchronously as session-owned metadata work");
			await advanceMicrotasks();
			assert.deepEqual(events, [`${id}:metadata-start`]);

			const teardown = terminal === "terminate"
				? manager.terminateSession(id)
				: manager.shutdown();
			await advanceMicrotasks();
			assert.equal(events.includes(`${id}:stop`), false, `${terminal} must not stop the bridge before metadata settles`);

			setupGate.resolve();
			await teardown;
			assert.ok(events.indexOf(`${id}:metadata-end`) < events.indexOf(`${id}:stop`), `${terminal} must join metadata before bridge teardown`);
			assert.equal(session.pendingMetadataPersist, undefined);
			await store.flushAsync();
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
