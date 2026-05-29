import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-no-precreate-"));
process.env.BOBBIT_DIR = tmpRoot;

const { SessionManager } = await import("../src/server/agent/session-manager.ts");

const managers: any[] = [];

function makeManager(): any {
	const manager: any = new SessionManager();
	manager._testStore = {
		update: mock.fn(() => {}),
		get: mock.fn(() => undefined),
	};
	managers.push(manager);
	return manager;
}

function putSession(manager: any, sessionFile: string, overrides: Record<string, any> = {}): any {
	const session = {
		id: "s-precreate",
		title: "no-precreate",
		cwd: tmpRoot,
		status: "idle",
		statusVersion: 0,
		sandboxed: false,
		createdAt: Date.now(),
		lastActivity: Date.now(),
		clients: new Set(),
		rpcClient: {
			getState: mock.fn(async () => ({ success: true, data: { sessionFile } })),
		},
		...overrides,
	};
	manager.sessions.set(session.id, session);
	return session;
}

afterEach(() => {
	while (managers.length > 0) {
		const m = managers.pop();
		if (m._statusHeartbeatTimer) { clearInterval(m._statusHeartbeatTimer); m._statusHeartbeatTimer = null; }
		m.sessions?.clear();
	}
});

describe("persistSessionMetadata must not pre-create the agent session file", () => {
	// Pi (>=0.77) creates the session JSONL lazily with an exclusive
	// `openSync(file, "wx")` on the first assistant flush. If Bobbit touches the
	// path first, Pi throws `EEXIST: file already exists` and loses every
	// transcript write. persistSessionMetadata must therefore only record the
	// path, never create the file.
	it("records the path but leaves the file absent so Pi's exclusive open succeeds", async () => {
		const manager = makeManager();
		const sessionsDir = path.join(tmpRoot, "agent", "sessions", "--slug--");
		const sessionFile = path.join(sessionsDir, "2026-05-29T19-50-17-803Z_abc.jsonl");
		const session = putSession(manager, sessionFile);

		await manager.persistSessionMetadata(session);

		// The regression: the file must NOT exist on disk after persist.
		assert.equal(fs.existsSync(sessionFile), false, "session file must not be pre-created");

		// The path is still recorded for restore.
		assert.equal(manager._testStore.update.mock.callCount(), 1);
		assert.deepEqual(manager._testStore.update.mock.calls[0].arguments, [
			session.id,
			{ agentSessionFile: sessionFile },
		]);

		// Simulate Pi's exclusive create: it must NOT throw EEXIST.
		fs.mkdirSync(sessionsDir, { recursive: true });
		assert.doesNotThrow(() => {
			const fd = fs.openSync(sessionFile, "wx");
			fs.closeSync(fd);
		}, "Pi's exclusive `wx` open must succeed because Bobbit did not pre-create the file");
	});
});

function makeStore(): any {
	return {
		get: mock.fn(() => undefined),
		update: mock.fn(() => {}),
		archive: mock.fn(() => {}),
		getAll: mock.fn(() => []),
	};
}

function persistedSession(overrides: Record<string, any> = {}): any {
	return {
		id: "ps-preflush",
		title: "pre-flush session",
		cwd: tmpRoot,
		projectId: "proj-1",
		sandboxed: false,
		createdAt: Date.now(),
		lastActivity: Date.now(),
		// Recorded by persistSessionMetadata from a live getState, but Pi never
		// flushed a transcript before the restart, so the file is absent on disk.
		agentSessionFile: path.join(tmpRoot, "agent", "sessions", "--slug--", "never-written.jsonl"),
		...overrides,
	};
}

describe("restore tolerates a recorded-but-unflushed session file (no graceful archive)", () => {
	it("restores a non-sandboxed session whose transcript was never flushed, instead of archiving", async () => {
		const manager = makeManager();
		const store = makeStore();
		manager._testStore = store;
		manager.restoreSession = mock.fn(async () => {});

		const ps = persistedSession();
		assert.equal(fs.existsSync(ps.agentSessionFile), false, "precondition: transcript file absent");

		await manager.restoreOneSession(ps);

		assert.equal((manager.restoreSession as any).mock.callCount(), 1, "must attempt a live restore");
		assert.equal(store.archive.mock.callCount(), 0, "must NOT gracefully archive a pre-flush session");
	});

	it("falls back to a dormant (not archived) session when the live restore fails", async () => {
		const manager = makeManager();
		const store = makeStore();
		manager._testStore = store;
		manager.restoreSession = mock.fn(async () => { throw new Error("worktree gone"); });

		const ps = persistedSession({ id: "ps-preflush-dormant" });
		await manager.restoreOneSession(ps);

		assert.equal((manager.restoreSession as any).mock.callCount(), 1);
		assert.equal(store.archive.mock.callCount(), 0, "a failed restore must not archive — it goes dormant");
		assert.ok(manager.sessions.has(ps.id), "session must be kept in memory as dormant");
		assert.equal(manager.sessions.get(ps.id).status, "terminated");
	});
});
