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

function lifecycleSession(
	id: string,
	transcript: string,
	opts: { borrowed?: boolean; ownerId?: string; branch?: string; staffId?: string } = {},
): PersistedSession {
	const branch = opts.branch ?? "session/source";
	const root = `/workspace-wt/${branch}`;
	return {
		id,
		title: opts.borrowed ? `Borrower ${id}` : `Owner ${id}`,
		cwd: `${root}/packages/web`,
		agentSessionFile: transcript,
		createdAt: 1_700_000_000_000,
		lastActivity: 1_700_000_000_100,
		projectId: "project-sandbox",
		sandboxed: true,
		staffId: opts.staffId,
		borrowsWorktree: opts.borrowed || undefined,
		borrowedWorktreeOwnerSessionId: opts.ownerId,
		...(opts.borrowed ? {} : {
			worktreePath: root,
			repoPath: "/workspace",
			branch,
		}),
	};
}

function deferred<T = void>(): {
	promise: Promise<T>;
	resolve: (value?: T) => void;
	reject: (error: Error) => void;
} {
	let resolve!: (value?: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = (value?: T) => res(value as T);
		reject = rej;
	});
	return { promise, resolve, reject };
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
		getOrCreate: () => ({
			toolManager: manager.toolManager,
			toolGroupPolicyStore: manager.groupPolicyStore,
		}),
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

async function sandboxLifecycleFixture(records: PersistedSession[]): Promise<{
	manager: any;
	store: SessionStore;
	removeWorktree: ReturnType<typeof vi.fn>;
	bridges: Map<string, { getState: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }>;
	bridgeOptions: Map<string, Record<string, any>>;
}> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-sandbox-lifecycle-"));
	fixtureRoots.push(root);
	const store1 = new SessionStore(path.join(root, "store"));
	for (const record of records) store1.put(record);
	await store1.flushAsync();
	const store = new SessionStore(path.join(root, "store"));

	const removeWorktree = vi.fn(async () => {});
	const sandbox = {
		getContainerId: vi.fn(async () => "container-lifecycle"),
		removeWorktree,
	};
	const bridges = new Map<string, { getState: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }>();
	const bridgeOptions = new Map<string, Record<string, any>>();
	let bridgeIndex = 0;
	registerRpcBridgeFactory((options: Record<string, any>) => {
		const record = records[bridgeIndex++];
		if (record) bridgeOptions.set(record.id, { ...options, env: { ...options.env } });
		const bridge = {
			running: true,
			start: vi.fn(async () => {}),
			stop: vi.fn(async () => {}),
			onEvent: vi.fn(() => vi.fn()),
			sendCommand: vi.fn(async () => ({ success: true })),
			getState: vi.fn(async () => ({ success: true, data: {} })),
		};
		if (record) bridges.set(record.id, bridge);
		return bridge as any;
	});

	const manager: any = new SessionManager({
		commandRunner: { execFile: vi.fn(async () => ({ stdout: "", stderr: "" })) } as any,
		projectContextManager: {} as any,
		remoteGitPolicy: { skipRemotePush: true },
		stateDir: path.join(root, "manager"),
	});
	managers.push(manager);
	manager.sandboxManager = { get: vi.fn(() => sandbox) };
	manager.projectContextManager = {
		all: () => [],
		getAllSessions: () => store.getAll(),
		getAllLiveSessions: () => store.getLive(),
		getOrCreate: () => ({
			toolManager: manager.toolManager,
			toolGroupPolicyStore: manager.groupPolicyStore,
		}),
	};
	manager.getSessionStore = () => store;
	manager.resolveStoreForSession = () => store;
	manager.resolveStoreForId = () => store;
	manager.applySandboxWiring = vi.fn(async (options: Record<string, any>) => {
		options.sandboxed = true;
		options.containerId = "container-lifecycle";
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

	for (const record of records) await manager.restoreSession(store.get(record.id)!);
	return { manager, store, removeWorktree, bridges, bridgeOptions };
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

	it("persists staff-fork identity and flattened ownership, then rejects owner termination until its borrower is archived", async () => {
		const ownerTranscript = writeTranscript("lifecycle-owner");
		const borrowerTranscript = writeTranscript("lifecycle-borrower");
		const owner = lifecycleSession("lifecycle-owner", ownerTranscript, { staffId: "staff-source" });
		const borrower = lifecycleSession("lifecycle-borrower", borrowerTranscript, {
			borrowed: true,
			ownerId: owner.id,
			staffId: "staff-fork",
		});
		const fixture = await sandboxLifecycleFixture([owner, borrower]);
		const ownerBridge = fixture.bridges.get(owner.id)!;
		const borrowerBridge = fixture.bridges.get(borrower.id)!;

		const persistedOwner = fixture.store.get(owner.id)!;
		const persistedBorrower = fixture.store.get(borrower.id)!;
		assert.equal(persistedOwner.staffId, "staff-source");
		assert.equal(persistedBorrower.staffId, "staff-fork",
			"the borrowed staff fork must retain its independent staff identity after a real store reload");
		assert.equal(persistedBorrower.borrowsWorktree, true);
		assert.equal(persistedBorrower.borrowedWorktreeOwnerSessionId, owner.id,
			"flattened ownership provenance must survive a real store reload");
		assert.deepEqual({
			cwd: persistedBorrower.cwd,
			worktreePath: persistedBorrower.worktreePath,
			repoPath: persistedBorrower.repoPath,
			branch: persistedBorrower.branch,
		}, {
			cwd: owner.cwd,
			worktreePath: undefined,
			repoPath: undefined,
			branch: undefined,
		}, "a whole-session staff fork may borrow the exact cwd but never ownership coordinates");
		assert.equal(fixture.manager.getSession(borrower.id)?.borrowedWorktreeOwnerSessionId, owner.id);
		assert.equal(fixture.manager.getSession(borrower.id)?.staffId, "staff-fork");
		assert.equal(fixture.manager.resolveSandboxWorktreeOwnerSessionId(borrower.id), owner.id);
		assert.equal(fixture.bridgeOptions.get(owner.id)?.env?.BOBBIT_STAFF_ID, "staff-source");
		assert.equal(fixture.bridgeOptions.get(borrower.id)?.env?.BOBBIT_STAFF_ID, "staff-fork",
			"restored borrower authorization must target only the destination staff record");

		await assert.rejects(
			fixture.manager.terminateSession(owner.id),
			(error: any) => error?.code === "SHARED_SANDBOX_WORKTREE_IN_USE",
		);
		assert.equal(ownerBridge.getState.mock.calls.length, 0, "owner rejection must precede bridge flush");
		assert.equal(ownerBridge.stop.mock.calls.length, 0, "owner rejection must precede bridge stop");
		assert.equal(fixture.store.get(owner.id)?.archived, undefined, "owner rejection must precede archive");
		assert.equal(fixture.store.get(owner.id)?.agentSessionFile, ownerTranscript, "owner rejection must retain transcript identity");
		assert.equal(fixture.removeWorktree.mock.calls.length, 0, "owner rejection must precede worktree removal");

		assert.equal(await fixture.manager.terminateSession(borrower.id), true);
		assert.equal(borrowerBridge.stop.mock.calls.length, 1);
		assert.equal(fixture.removeWorktree.mock.calls.length, 0, "borrower termination never removes shared state");
		assert.equal(fixture.store.get(borrower.id)?.archived, true);

		assert.equal(await fixture.manager.terminateSession(owner.id), true);
		assert.equal(ownerBridge.stop.mock.calls.length, 1);
		assert.deepEqual(fixture.removeWorktree.mock.calls, [["session/source"]],
			"owner retry removes the authoritative branch root, never its nested cwd suffix");
	});

	it("infers one legacy owner but fails closed when the same borrowed cwd has ambiguous live owners", async () => {
		const ownerA = lifecycleSession("legacy-owner-a", writeTranscript("legacy-owner-a"));
		const borrower = lifecycleSession("legacy-borrower", writeTranscript("legacy-borrower"), { borrowed: true });
		const fixture = await sandboxLifecycleFixture([ownerA, borrower]);

		assert.equal(fixture.manager.resolveSandboxWorktreeOwnerSessionId(borrower.id), ownerA.id,
			"one authoritative same-project root is a safe legacy inference");

		const ownerB = lifecycleSession("legacy-owner-b", writeTranscript("legacy-owner-b"));
		fixture.store.put(ownerB);
		await fixture.store.flushAsync();
		assert.equal(fixture.manager.resolveSandboxWorktreeOwnerSessionId(borrower.id), undefined,
			"multiple matching roots must not guess teardown ownership");
	});

	it("serializes one owner FIFO, releases after rejection, and lets unrelated owners proceed", async () => {
		const fixture = await sandboxLifecycleFixture([]);
		const firstGate = deferred<void>();
		const events: string[] = [];

		const first = fixture.manager.withSandboxWorktreeOwnerLifecycle("owner-a", async () => {
			events.push("a1:start");
			await firstGate.promise;
			throw new Error("fixture owner-a failure");
		});
		const second = fixture.manager.withSandboxWorktreeOwnerLifecycle("owner-a", async () => {
			events.push("a2:start");
			return "a2";
		});
		const unrelated = fixture.manager.withSandboxWorktreeOwnerLifecycle("owner-b", async () => {
			events.push("b1:start");
			return "b1";
		});

		await Promise.resolve();
		await Promise.resolve();
		assert.deepEqual(events, ["a1:start", "b1:start"], "same-key successor waits while another owner proceeds");
		assert.equal(await unrelated, "b1");
		firstGate.resolve();
		await assert.rejects(first, /fixture owner-a failure/);
		assert.equal(await second, "a2");
		assert.deepEqual(events, ["a1:start", "b1:start", "a2:start"], "rejection releases the FIFO head");
		assert.equal(fixture.manager._sandboxBorrowerLifecycleQueues.size, 0, "completed owner queues are retired");
	});
});
