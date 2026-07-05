/**
 * PIN — regression test for the ambient-MCP test-isolation bug class found
 * while fixing tests/session-manager-force-abort-grace.test.ts (PR #105) and,
 * in the same audit, tests/openrouter-key-bridge-repro.test.ts and
 * tests/cold-restart-reprompt.test.ts:
 *
 * Several SessionManager code paths — createSession(), restoreSession(),
 * createDelegateSession(), assignRole(), and forceAbort()'s force-kill/
 * respawn branch — unconditionally call ensureMcpManagerForContext() to
 * rebuild tool-activation args. That builds a REAL McpManager and connects
 * it, which reads ambient ~/.claude.json / ~/.claude/.mcp.json /
 * ~/.bobbit/.mcp.json (McpManager's manual-config cascade in
 * src/server/mcp/mcp-manager.ts, unconditional on os.homedir()) regardless
 * of what cwd/project this test constructs. On a machine with any MCP
 * server configured there, an unstubbed unit test spawns real child
 * processes / opens real network sockets entirely unrelated to its own
 * fixtures — and nothing tears them down, so the leaked handles keep the
 * test file's event loop alive past every `it()` block completing.
 *
 * This file pins two invariants so a future unstubbed test can't silently
 * reintroduce the leak:
 *
 *   1. With HOME/USERPROFILE isolated to an empty tmp dir (the existing
 *      convention in this repo — mirrors
 *      tests/mcp-manager-marketplace-discovery.test.ts,
 *      tests/session-recovery-agent-dir.test.ts, and
 *      tests/transcript-sanitizer-agent-dir.test.ts), the real (unstubbed)
 *      createSession() -> ensureMcpManagerForContext() ->
 *      McpManager.connectAll() chain discovers zero servers and spawns zero
 *      child processes — proving the discovery mechanism is correctly
 *      HOME-scoped, so a test that forgets to isolate HOME is only ever
 *      exposed to whatever's on the real host, never anything this repo's
 *      test suite controls.
 *   2. SessionManager.shutdown() disconnects every MCP manager (default +
 *      scoped) it created — the hardening added alongside the
 *      force-abort-grace fix — so a manager that DID connect (because a
 *      test, or a real gateway, has ambient servers configured) does not
 *      outlive the SessionManager it belongs to.
 */
import { after, afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";

// Isolate HOME/USERPROFILE so McpManager's ambient ~/.claude.json /
// ~/.claude/.mcp.json / ~/.bobbit/.mcp.json cascade can never read this
// developer/CI machine's real config, regardless of what's configured there.
// This must happen before SessionManager (and transitively McpManager) is
// imported, since os.homedir() reads process.env.HOME at call time, not
// import time — but some helpers below cache directories at module init.
const isolatedHome = makeTmpDir("session-manager-ambient-mcp-isolated-home-");
const previousEnv = {
	HOME: process.env.HOME,
	USERPROFILE: process.env.USERPROFILE,
};
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;

const tmpRoot = makeTmpDir("session-manager-ambient-mcp-isolation-");
const stateDir = path.join(tmpRoot, "state");
const agentDir = path.join(tmpRoot, "agent");
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
process.env.BOBBIT_DIR = tmpRoot;
process.env.BOBBIT_AGENT_DIR = agentDir;

const { SessionManager } = await import("../src/server/agent/session-manager.ts");
const { registerRpcBridgeFactory } = await import("../src/server/agent/rpc-bridge.ts");
const { initPromptDirs } = await import("../src/server/agent/system-prompt.ts");

initPromptDirs(stateDir);

after(() => {
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
		else (process.env as Record<string, string | undefined>)[key] = value;
	}
	fs.rmSync(isolatedHome, { recursive: true, force: true });
});

function makeBridge(overrides: Record<string, any> = {}): any {
	return {
		running: true,
		async start() {},
		async stop() {},
		async waitForReady() {},
		prompt: mock.fn(async () => ({ success: true })),
		steer: mock.fn(async () => ({ success: true })),
		abort: mock.fn(async () => ({ success: true })),
		getState: mock.fn(async () => ({
			success: true,
			data: { sessionFile: path.join(agentDir, "sessions", "ambient-mcp-isolation.jsonl") },
		})),
		getMessages: mock.fn(async () => ({ success: true, data: { messages: [] } })),
		setModel: mock.fn(async () => ({ success: true })),
		setThinkingLevel: mock.fn(async () => ({ success: true })),
		compact: mock.fn(async () => ({ success: true })),
		sendCommand: mock.fn(async () => ({ success: true })),
		onEvent: mock.fn(() => () => {}),
		...overrides,
	};
}

const managers: any[] = [];
afterEach(() => {
	registerRpcBridgeFactory(null);
	while (managers.length > 0) {
		const m = managers.pop();
		if (m._statusHeartbeatTimer) clearInterval(m._statusHeartbeatTimer);
		m.sessions?.clear?.();
	}
});

function makeManager(): any {
	registerRpcBridgeFactory(() => makeBridge());
	const manager: any = new SessionManager();
	manager._testStore = {
		put: mock.fn(() => {}),
		update: mock.fn(() => {}),
		get: mock.fn(() => undefined),
		archive: mock.fn(() => {}),
		flush: mock.fn(() => {}),
	};
	managers.push(manager);
	return manager;
}

function countChildProcessHandles(): number {
	const handles = (process as any)._getActiveHandles?.() ?? [];
	return handles.filter((h: any) => h?.constructor?.name === "ChildProcess").length;
}

describe("SessionManager ambient-MCP isolation (regression pin)", () => {
	it("createSession's real (unstubbed) MCP path spawns zero child processes when HOME has no ambient config", async () => {
		const manager = makeManager();
		const before = countChildProcessHandles();

		// Deliberately NOT stubbed: this exercises the real
		// ensureMcpManagerForContext() -> ensureMcpManager() -> createMcpManager()
		// -> McpManager.connectAll() chain end-to-end, under an isolated HOME.
		const session = await manager.createSession(tmpRoot, [], undefined, undefined, {
			sessionId: "s-ambient-mcp-isolation",
			sandboxed: false,
			skipAutoModel: true,
			skipAutoThinking: true,
		});
		if (session.pendingMetadataPersist) await session.pendingMetadataPersist;

		const afterCount = countChildProcessHandles();
		assert.equal(
			afterCount,
			before,
			"isolated HOME with no ambient MCP config must not spawn any child process during createSession's MCP connect",
		);

		await manager.shutdown();
	});

	it("shutdown() disconnects every MCP manager (default + scoped) createSession created", async () => {
		const manager = makeManager();

		const connectAll = mock.fn(async () => {});
		const disconnectAll = mock.fn(async () => {});
		const spyMgr = {
			connectAll,
			disconnectAll,
			getToolInfos: () => [],
			getServerStatuses: () => [],
		};
		manager.createMcpManager = () => spyMgr;

		const session = await manager.createSession(tmpRoot, [], undefined, undefined, {
			sessionId: "s-ambient-mcp-shutdown",
			sandboxed: false,
			skipAutoModel: true,
			skipAutoThinking: true,
		});
		if (session.pendingMetadataPersist) await session.pendingMetadataPersist;

		assert.equal(
			connectAll.mock.callCount(),
			1,
			"createSession must connect the scoped MCP manager it creates for this cwd — otherwise this pin is vacuous",
		);

		await manager.shutdown();

		assert.equal(
			disconnectAll.mock.callCount(),
			1,
			"shutdown() must disconnect every MCP manager it created — a leaked connection would otherwise outlive the SessionManager",
		);
		assert.equal(
			manager.scopedMcpManagers.size,
			0,
			"shutdown() must clear scopedMcpManagers so a stale manager can't be reused after shutdown",
		);
	});
});
