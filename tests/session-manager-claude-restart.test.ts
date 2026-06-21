import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { makeTmpDir } from "./helpers/tmp.ts";

const tmpRoot = makeTmpDir("session-manager-claude-restart-");
process.env.BOBBIT_DIR = tmpRoot;

const { SessionManager } = await import("../src/server/agent/session-manager.ts");

type PersistedSession = import("../src/server/agent/session-store.ts").PersistedSession;

const managers: any[] = [];

function makePersisted(overrides: Partial<PersistedSession> = {}): PersistedSession {
	return {
		id: "claude-session",
		title: "Claude Code session",
		cwd: tmpRoot,
		createdAt: Date.now() - 1000,
		lastActivity: Date.now() - 500,
		runtime: "claude-code",
		claudeCodeSessionId: "cc-session-123",
		...overrides,
	};
}

function makeStore(initial: PersistedSession[] = []): any {
	const rows = new Map(initial.map((ps) => [ps.id, { ...ps }]));
	return {
		get: mock.fn((id: string) => rows.get(id)),
		getLive: mock.fn(() => [...rows.values()].filter((ps: PersistedSession) => !ps.archived)),
		getAll: mock.fn(() => [...rows.values()]),
		update: mock.fn((id: string, patch: Partial<PersistedSession>) => {
			const existing = rows.get(id);
			if (existing) rows.set(id, { ...existing, ...patch });
		}),
		archive: mock.fn((id: string) => {
			const existing = rows.get(id);
			if (existing) rows.set(id, { ...existing, archived: true, archivedAt: Date.now() });
			return true;
		}),
	};
}

function makeManager(store = makeStore()): any {
	const manager: any = new SessionManager();
	manager._testStore = store;
	managers.push(manager);
	return manager;
}

function makeLiveSession(id: string): any {
	return {
		id,
		title: "Claude Code session",
		cwd: tmpRoot,
		status: "terminated",
		clients: new Set(),
		rpcClient: { stop: mock.fn(async () => {}) },
		unsubscribe: mock.fn(() => {}),
	};
}

afterEach(() => {
	for (const manager of managers.splice(0)) {
		if (manager._statusHeartbeatTimer) {
			clearInterval(manager._statusHeartbeatTimer);
			manager._statusHeartbeatTimer = null;
		}
		manager.sessions?.clear?.();
	}
});

describe("Claude Code restart/restore without Pi agentSessionFile", () => {
	it("restartAgent respawns a Claude Code session using claudeCodeSessionId instead of archiving it as a zombie", async () => {
		const ps = makePersisted();
		const store = makeStore([ps]);
		const manager = makeManager(store);
		const live = makeLiveSession(ps.id);
		manager.sessions.set(ps.id, live);
		manager._respawnAgentInPlace = mock.fn(async (_session: any, persisted: PersistedSession) => {
			assert.equal(persisted.claudeCodeSessionId, "cc-session-123");
			return live;
		});

		await manager.restartAgent(ps.id);

		assert.equal(manager._respawnAgentInPlace.mock.callCount(), 1);
		assert.equal(store.archive.mock.callCount(), 0);
		assert.equal(
			store.update.mock.calls.some((call: any) => call.arguments[1]?.archived === true),
			false,
			"restartAgent must not mark resumable Claude Code sessions archived",
		);
	});

	it("ensureSessionAlive respawns a terminated Claude Code session without requiring agentSessionFile", async () => {
		const ps = makePersisted({ id: "claude-ensure" });
		const store = makeStore([ps]);
		const manager = makeManager(store);
		const live = makeLiveSession(ps.id);
		manager.sessions.set(ps.id, live);
		manager._respawnAgentInPlace = mock.fn(async () => live);

		await manager.ensureSessionAlive(ps.id);

		assert.equal(manager._respawnAgentInPlace.mock.callCount(), 1);
	});

	it("addClient revives dormant Claude Code sessions that only have claudeCodeSessionId", () => {
		const ps = makePersisted({ id: "claude-dormant" });
		const store = makeStore([ps]);
		const manager = makeManager(store);
		manager.sessions.set(ps.id, makeLiveSession(ps.id));
		manager._restoreSessionCoalesced = mock.fn(async () => manager.sessions.get(ps.id));

		const accepted = manager.addClient(ps.id, { readyState: 1 } as any);

		assert.equal(accepted, true);
		assert.equal(manager._restoreSessionCoalesced.mock.callCount(), 1);
		assert.equal(manager._restoreSessionCoalesced.mock.calls[0].arguments[0].claudeCodeSessionId, "cc-session-123");
	});

	it("restoreSessions restores Claude-Code-backed delegates with no agentSessionFile instead of archiving them", async () => {
		const owner = makePersisted({
			id: "owner",
			runtime: "pi",
			claudeCodeSessionId: undefined,
			agentSessionFile: `${tmpRoot}/owner.jsonl`,
		});
		const delegate = makePersisted({
			id: "delegate",
			delegateOf: owner.id,
			agentSessionFile: undefined,
		});
		const store = makeStore([owner, delegate]);
		const manager = makeManager(store);
		manager.restoreOneSession = mock.fn(async () => {});

		await manager.restoreSessions();

		const restoredIds = manager.restoreOneSession.mock.calls.map((call: any) => call.arguments[0].id);
		assert.ok(restoredIds.includes("delegate"), "Claude Code delegate must be routed through live restore");
		assert.equal(store.archive.mock.callCount(), 0, "Claude Code delegate must not be archived for missing agentSessionFile");
	});

	it("tryAutoSelectModel skips Pi role/default/aigw binding for Claude Code sessions", async () => {
		const ps = makePersisted({ id: "claude-auto-model" });
		const store = makeStore([ps]);
		const manager = makeManager(store);
		manager.preferencesStore = {
			get: mock.fn((key: string) => {
				if (key === "default.sessionModel") return "aigw/us.anthropic.claude-haiku-4-5";
				if (key === "aigw.url") return "https://aigw.example.invalid";
				return undefined;
			}),
		};
		manager._writeModelNameFile = mock.fn(() => {});
		const setModel = mock.fn(async () => {
			throw new Error("setModel must not be called for Pi models on Claude Code sessions");
		});
		const session: any = {
			id: ps.id,
			role: "coder",
			clients: new Set(),
			promptQueue: { size: 0 },
			rpcClient: {
				setModel,
				getState: mock.fn(async () => ({ success: true, data: { runtime: "claude-code", model: { provider: "claude-code", id: "sonnet" } } })),
			},
		};
		manager.sessions.set(ps.id, session);

		await manager.tryAutoSelectModel(session);

		assert.equal(setModel.mock.callCount(), 0);
		assert.equal(manager._writeModelNameFile.mock.callCount(), 0);
	});
});
