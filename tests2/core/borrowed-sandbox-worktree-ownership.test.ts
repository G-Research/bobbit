import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, vi } from "vitest";

import { activeAgentSessionsDir } from "../../src/server/agent/agent-session-path.js";
import { SessionManager } from "../../src/server/agent/session-manager.js";
import { SessionStore, type PersistedSession } from "../../src/server/agent/session-store.js";
import { registerRpcBridgeFactory } from "../../src/server/agent/rpc-bridge.js";

const managers: any[] = [];
const fixtureRoots: string[] = [];
const transcriptRoots: string[] = [];

function persistedSession(id: string, transcript: string, borrowed: boolean): PersistedSession {
	return {
		id,
		title: borrowed ? "Borrowed sandbox fork" : "Owned sandbox session",
		cwd: borrowed ? "/workspace-wt/session/source/packages/web" : "/workspace-wt/session/owned",
		agentSessionFile: transcript,
		createdAt: 1_700_000_000_000,
		lastActivity: 1_700_000_000_100,
		projectId: "project-sandbox",
		sandboxed: true,
		borrowsWorktree: borrowed || undefined,
		...(borrowed ? {} : {
			worktreePath: "/workspace-wt/session/owned",
			repoPath: "/workspace",
			branch: "session/owned",
		}),
	};
}

function writeTranscript(id: string): string {
	const dir = path.join(activeAgentSessionsDir(), `--borrowed-worktree-ownership-${process.pid}--`);
	fs.mkdirSync(dir, { recursive: true });
	transcriptRoots.push(dir);
	const file = path.join(dir, `${id}.jsonl`);
	fs.writeFileSync(file, [
		{ type: "session", version: 3, id: `pi-${id}`, cwd: "/workspace" },
		{
			type: "message",
			id: "retained-user",
			parentId: null,
			message: { role: "user", content: [{ type: "text", text: "retained" }] },
		},
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
	return file;
}

async function persistedReloadFixture(borrowed: boolean): Promise<{
	manager: any;
	restored: PersistedSession;
	removeWorktree: ReturnType<typeof vi.fn>;
	dockerCalls: Array<{ file: string; args: string[] }>;
	bridgeOptions: Record<string, any>;
}> {
	const id = borrowed ? "borrowed-reload" : "owned-reload";
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `bobbit-${id}-`));
	fixtureRoots.push(root);
	const transcript = writeTranscript(id);
	const store1 = new SessionStore(path.join(root, "store"));
	store1.put(persistedSession(id, transcript, borrowed));
	await store1.flushAsync();

	// A separate store instance is the gateway-restart boundary under test.
	const store2 = new SessionStore(path.join(root, "store"));
	const restored = store2.get(id);
	assert.ok(restored);

	const dockerCalls: Array<{ file: string; args: string[] }> = [];
	const commandRunner = {
		async execFile(file: string, args: string[]) {
			dockerCalls.push({ file, args: [...args] });
			return { stdout: "", stderr: "" };
		},
	};
	const removeWorktree = vi.fn(async () => {});
	const sandbox = {
		getContainerId: vi.fn(async () => "container-ownership"),
		removeWorktree,
	};
	const sandboxManager = {
		get: vi.fn(() => sandbox),
	};
	let bridgeOptions: Record<string, any> = {};
	const bridge = {
		running: true,
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		onEvent: vi.fn(() => vi.fn()),
		sendCommand: vi.fn(async () => ({ success: true })),
		getState: vi.fn(async () => ({ success: true, data: {} })),
	};
	registerRpcBridgeFactory((options: Record<string, any>) => {
		bridgeOptions = { ...options, env: { ...options.env } };
		return bridge as any;
	});

	const manager: any = new SessionManager({
		commandRunner: commandRunner as any,
		projectContextManager: {} as any,
		remoteGitPolicy: { skipRemotePush: true },
		stateDir: path.join(root, "manager"),
	});
	managers.push(manager);
	manager.sandboxManager = sandboxManager;
	manager.projectContextManager = {
		all: () => [],
		getAllLiveSessions: () => store2.getLive(),
	};
	manager.getSessionStore = () => store2;
	manager.resolveStoreForSession = () => store2;
	manager.resolveStoreForId = () => store2;
	manager.applySandboxWiring = vi.fn(async (options: Record<string, any>) => {
		options.sandboxed = true;
		options.containerId = "container-ownership";
		options.cwd = restored.cwd;
		return true;
	});
	manager.ensureMcpManagerForContext = vi.fn(async () => {});
	manager.buildToolActivationArgs = vi.fn(() => ({ args: [], runtimeExtensions: [], env: {} }));
	manager.assemblePrompt = vi.fn(() => undefined);
	manager.resolveCurrentCatalogSpawnModel = vi.fn(async () => undefined);
	manager.resolveCurrentCatalogThinkingLevel = vi.fn(async () => undefined);
	manager.applyDirectProviderEnv = vi.fn(async () => {});
	manager.finalizeSpawnOptions = vi.fn(async () => {});
	manager.tryAutoSelectModel = vi.fn(async () => {});
	manager.tryApplyDefaultThinkingLevel = vi.fn(async () => {});

	await manager.restoreSession(restored);
	return { manager, restored, removeWorktree, dockerCalls, bridgeOptions };
}

afterEach(() => {
	registerRpcBridgeFactory(null);
	vi.restoreAllMocks();
	while (managers.length > 0) {
		const manager = managers.pop();
		if (manager?._statusHeartbeatTimer) clearInterval(manager._statusHeartbeatTimer);
		manager?.sessions?.clear?.();
	}
	while (transcriptRoots.length > 0) fs.rmSync(transcriptRoots.pop()!, { recursive: true, force: true });
	while (fixtureRoots.length > 0) fs.rmSync(fixtureRoots.pop()!, { recursive: true, force: true });
});

describe("borrowed sandbox worktree ownership", () => {
	it("round-trips borrowed ownership across persistence and never verifies or removes the source worktree", async () => {
		const fixture = await persistedReloadFixture(true);
		const sourceBytes = fs.readFileSync(fixture.restored.agentSessionFile);
		const sourceCoordinates = {
			cwd: fixture.restored.cwd,
			worktreePath: fixture.restored.worktreePath,
			repoPath: fixture.restored.repoPath,
			branch: fixture.restored.branch,
		};

		assert.equal(fixture.restored.borrowsWorktree, true, "ownership marker must survive a real store reload");
		assert.deepEqual(sourceCoordinates, {
			cwd: "/workspace-wt/session/source/packages/web",
			worktreePath: undefined,
			repoPath: undefined,
			branch: undefined,
		}, "a borrowed fork keeps the exact cwd without registering teardown coordinates");
		assert.equal(fixture.manager.getSession(fixture.restored.id)?.borrowsWorktree, true);
		assert.equal(fixture.bridgeOptions.cwd, sourceCoordinates.cwd);
		assert.deepEqual(fixture.dockerCalls, [], "borrowed worktrees must not be verified, repaired, or recreated on reload");

		await fixture.manager.terminateSession(fixture.restored.id);

		assert.equal(fixture.removeWorktree.mock.calls.length, 0, "terminating the borrower must not remove the owner's worktree");
		assert.equal(fs.readFileSync(fixture.restored.agentSessionFile).equals(sourceBytes), true, "source transcript bytes stay unchanged");
		assert.deepEqual(sourceCoordinates, {
			cwd: "/workspace-wt/session/source/packages/web",
			worktreePath: undefined,
			repoPath: undefined,
			branch: undefined,
		});
	});

	it("keeps owned sandbox cleanup as the control and removes its registered worktree coordinate exactly once", async () => {
		const fixture = await persistedReloadFixture(false);
		const live = fixture.manager.getSession(fixture.restored.id);

		assert.equal(fixture.restored.borrowsWorktree, undefined);
		assert.deepEqual({
			cwd: live?.cwd,
			worktreePath: live?.worktreePath,
			repoPath: live?.repoPath,
			branch: live?.branch,
		}, {
			cwd: "/workspace-wt/session/owned",
			worktreePath: "/workspace-wt/session/owned",
			repoPath: "/workspace",
			branch: "session/owned",
		});
		assert.deepEqual(fixture.dockerCalls, [{
			file: "docker",
			args: ["exec", "container-ownership", "test", "-d", "/workspace-wt/session/owned"],
		}], "an owning reload still verifies its worktree through the established lifecycle seam");

		await fixture.manager.terminateSession(fixture.restored.id);

		assert.deepEqual(fixture.removeWorktree.mock.calls, [["session/owned"]]);
	});
});
