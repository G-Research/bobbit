import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-session-recovery-agent-dir-"));
const projectRoot = path.join(tmpRoot, "project");
const tmpHome = path.join(tmpRoot, "home");
const activeAgentDir = path.join(tmpRoot, "active-agent");
const historicalAgentDir = path.join(tmpRoot, "historical-agent");
const previousEnv = {
	BOBBIT_AGENT_DIR: process.env.BOBBIT_AGENT_DIR,
	BOBBIT_DIR: process.env.BOBBIT_DIR,
	HOME: process.env.HOME,
	USERPROFILE: process.env.USERPROFILE,
};

fs.mkdirSync(projectRoot, { recursive: true });
fs.mkdirSync(tmpHome, { recursive: true });
process.env.BOBBIT_AGENT_DIR = activeAgentDir;
process.env.BOBBIT_DIR = path.join(tmpRoot, ".bobbit");
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const bobbitDirModule = await import("../src/server/bobbit-dir.ts");
bobbitDirModule.setProjectRoot(projectRoot);
const { SessionManager } = await import("../src/server/agent/session-manager.ts");
const { formatAgentTimestamp, slugifyCwd } = await import("../src/server/agent/agent-session-path.ts");

const managers: any[] = [];

function cleanupManager(manager: any): void {
	if (manager._statusHeartbeatTimer) {
		clearInterval(manager._statusHeartbeatTimer);
		manager._statusHeartbeatTimer = null;
	}
	manager.sessionsWithConnectedClients?.clear();
	manager.sessions?.clear();
}

function makeManager(store?: any): any {
	const manager: any = new SessionManager();
	manager._testStore = store ?? makeStore();
	managers.push(manager);
	return manager;
}

function makeStore(initial: any[] = []): any {
	const records = new Map<string, any>();
	for (const record of initial) records.set(record.id, record);
	return {
		get: (id: string) => records.get(id),
		put: (record: any) => { records.set(record.id, record); },
		update: (id: string, fields: any) => { records.set(id, { ...records.get(id), ...fields }); },
		archive: (id: string) => { const existing = records.get(id); if (existing) records.set(id, { ...existing, archived: true }); },
		getAll: () => [...records.values()],
	};
}

function sessionsRoot(agentDir: string): string {
	return path.join(agentDir, "sessions");
}

function transcriptPath(agentDir: string, cwd: string, createdAt: number, id: string): string {
	return path.join(
		sessionsRoot(agentDir),
		`--${slugifyCwd(cwd)}--`,
		`${formatAgentTimestamp(createdAt)}_${id}.jsonl`,
	).replace(/\\/g, "/");
}

function writeRecoverableTranscript(agentDir: string, opts: { cwd: string; createdAt: number; id: string; text?: string }): string {
	const file = transcriptPath(agentDir, opts.cwd, opts.createdAt, opts.id);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		JSON.stringify({ type: "message", message: { role: "user", content: opts.text ?? opts.id } }) + "\n",
		"utf-8",
	);
	return file;
}

function makePersistedSession(overrides: Record<string, any> = {}): any {
	return {
		id: overrides.id ?? "session-under-test",
		title: "Recoverable session",
		cwd: overrides.cwd ?? projectRoot,
		agentSessionFile: overrides.agentSessionFile ?? "",
		createdAt: overrides.createdAt ?? Date.parse("2026-04-03T15:15:12.009Z"),
		lastActivity: overrides.lastActivity ?? Date.parse("2026-04-03T15:15:42.009Z"),
		...overrides,
	};
}

async function recordHistoryIfAvailable(agentDir: string): Promise<boolean> {
	const fn = (bobbitDirModule as any).recordAgentDirHistory;
	if (typeof fn !== "function") return false;
	await Promise.resolve(fn(agentDir));
	return true;
}

function assertHistoryRecorderAvailable(): void {
	assert.equal(
		typeof (bobbitDirModule as any).recordAgentDirHistory,
		"function",
		"recordAgentDirHistory(dir) must be exported so recoverSessionFile can scan historical sessions roots",
	);
}

function samePath(actual: string | null, expected: string): void {
	assert.equal(actual?.replace(/\\/g, "/"), expected.replace(/\\/g, "/"));
}

fs.mkdirSync(sessionsRoot(activeAgentDir), { recursive: true });
fs.mkdirSync(sessionsRoot(historicalAgentDir), { recursive: true });
await recordHistoryIfAvailable(activeAgentDir);
await recordHistoryIfAvailable(historicalAgentDir);

after(() => {
	while (managers.length > 0) cleanupManager(managers.pop());
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("recoverSessionFile with configurable agent directories", () => {
	it("recovers a missing agentSessionFile from the startup active sessions root", () => {
		const manager = makeManager();
		const ps = makePersistedSession({ id: "active-session" });
		const expected = writeRecoverableTranscript(activeAgentDir, ps);

		samePath(manager.recoverSessionFile(ps), expected);
	});

	it("recovers from a recorded historical sessions root after the active agent dir changes", () => {
		assertHistoryRecorderAvailable();
		const manager = makeManager();
		const ps = makePersistedSession({ id: "historical-session" });
		const expected = writeRecoverableTranscript(historicalAgentDir, ps);

		samePath(manager.recoverSessionFile(ps), expected);
	});

	it("recovers legacy ~/.bobbit/agent and ~/.pi/agent transcripts even when a custom active dir is configured", () => {
		const manager = makeManager();
		const legacyBobbitPs = makePersistedSession({ id: "legacy-bobbit-session", createdAt: Date.parse("2026-04-03T16:00:00.000Z") });
		const legacyPiPs = makePersistedSession({ id: "legacy-pi-session", createdAt: Date.parse("2026-04-03T17:00:00.000Z") });
		const legacyBobbit = writeRecoverableTranscript(path.join(tmpHome, ".bobbit", "agent"), legacyBobbitPs);
		const legacyPi = writeRecoverableTranscript(path.join(tmpHome, ".pi", "agent"), legacyPiPs);

		samePath(manager.recoverSessionFile(legacyBobbitPs), legacyBobbit);
		samePath(manager.recoverSessionFile(legacyPiPs), legacyPi);
	});

	it("keeps an exact persisted absolute agentSessionFile readable after the active dir changes", async () => {
		const oldAgentDir = path.join(tmpRoot, "old-agent-dir-not-in-history");
		const ps = makePersistedSession({ id: "persisted-absolute-session", archived: true });
		const persistedPath = writeRecoverableTranscript(oldAgentDir, { ...ps, text: "read me from the persisted absolute path" });
		ps.agentSessionFile = persistedPath;
		const store = makeStore([ps]);
		const manager = makeManager(store);

		const messages = await manager.getArchivedMessages(ps.id);
		assert.equal(messages.length, 1);
		assert.deepEqual(messages[0], { role: "user", content: "read me from the persisted absolute path" });
	});
});
