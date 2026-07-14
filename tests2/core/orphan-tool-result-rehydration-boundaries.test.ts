import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-rehydration-boundaries-"));
const stateDir = path.join(tmpRoot, "state");
process.env.BOBBIT_DIR = tmpRoot;
process.env.BOBBIT_AGENT_DIR = path.join(tmpRoot, "agent");
fs.mkdirSync(stateDir, { recursive: true });

const { activeAgentSessionsDir } = await import("../../src/server/agent/agent-session-path.ts");
const { EventBuffer } = await import("../../src/server/agent/event-buffer.ts");
const { PromptQueue } = await import("../../src/server/agent/prompt-queue.ts");
const { containerPathToHost, registerRpcBridgeFactory } = await import("../../src/server/agent/rpc-bridge.ts");
const { sessionFsContextForAgentFile } = await import("../../src/server/agent/session-fs.ts");
const { SessionManager, switchSessionPathForAgent } = await import("../../src/server/agent/session-manager.ts");
const { executePlan } = await import("../../src/server/agent/session-setup.ts");
const { initPromptDirs } = await import("../../src/server/agent/system-prompt.ts");
const { loadOrCreateToken } = await import("../../src/server/auth/token.ts");

initPromptDirs(stateDir);
loadOrCreateToken();

const managers: any[] = [];
const createdFiles: string[] = [];

afterEach(() => {
	registerRpcBridgeFactory(null);
	vi.restoreAllMocks();
	while (managers.length > 0) {
		const manager = managers.pop();
		if (manager._statusHeartbeatTimer) clearInterval(manager._statusHeartbeatTimer);
		manager.sessions?.clear?.();
	}
	while (createdFiles.length > 0) fs.rmSync(createdFiles.pop()!, { force: true });
});

afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function orphanTranscript(): string {
	return [
		{
			type: "message",
			id: "assistant-text-only",
			parentId: null,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "I will inspect it." }],
				provider: "anthropic",
				stopReason: "toolUse",
			},
		},
		{
			type: "message",
			id: "orphan-result",
			parentId: "assistant-text-only",
			message: {
				role: "toolResult",
				toolCallId: "toolu_missing_from_assistant",
				toolName: "read",
				content: [{ type: "text", text: "payload must not be logged" }],
				isError: false,
			},
		},
		{
			type: "message",
			id: "next-user",
			parentId: "orphan-result",
			message: { role: "user", content: [{ type: "text", text: "continue" }] },
		},
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

function assertOrphanRewritten(content: string): void {
	const entries = content.trimEnd().split("\n").map((line) => JSON.parse(line));
	expect(entries.map((entry) => entry.id)).toEqual(["assistant-text-only", "next-user"]);
	expect(entries[1].parentId).toBe("assistant-text-only");
	expect(content).not.toContain("toolu_missing_from_assistant");
}

function hostTranscript(name: string): string {
	const dir = path.join(activeAgentSessionsDir(), "--orphan-boundaries--");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${name}.jsonl`);
	fs.writeFileSync(file, orphanTranscript(), "utf8");
	createdFiles.push(file);
	return file;
}

function recordingBridge(onSwitch: (sessionPath: string) => void): any {
	return {
		running: true,
		async start() {},
		async stop() {},
		async waitForReady() {},
		async promptWhenReady() { return { success: true }; },
		async prompt() { return { success: true }; },
		async steer() { return { success: true }; },
		async abort() { return { success: true }; },
		async getState() { return { success: true, data: {} }; },
		async getMessages() { return { success: true, data: { messages: [] } }; },
		async setModel() { return { success: true }; },
		async setThinkingLevel() { return { success: true }; },
		async compact() { return { success: true }; },
		async sendCommand(command: any) {
			if (command?.type === "switch_session") onSwitch(command.sessionPath);
			return { success: true };
		},
		onEvent() { return () => {}; },
	};
}

function failingSwitchBridge(
	failure: "response" | "exception",
	timeouts: number[],
): { bridge: any; stop: ReturnType<typeof vi.fn> } {
	const bridge = recordingBridge(() => {});
	const stop = vi.fn(async () => {});
	let listener: ((event: any) => void) | undefined;
	bridge.stop = stop;
	bridge.onEvent = vi.fn((nextListener: (event: any) => void) => {
		listener = nextListener;
		return () => { listener = undefined; };
	});
	bridge.sendCommand = vi.fn(async (command: any, timeoutMs?: number) => {
		if (command?.type !== "switch_session") return { success: true };
		timeouts.push(timeoutMs!);
		listener?.({ type: "agent_end", messages: [] });
		if (failure === "exception") throw new Error("fixture switch timeout");
		return { success: false, error: "fixture switch rejected" };
	});
	return { bridge, stop };
}

function persisted(id: string, agentSessionFile: string, overrides: Record<string, any> = {}): any {
	return {
		id,
		title: `Boundary ${id}`,
		cwd: tmpRoot,
		agentSessionFile,
		projectId: "project-boundary",
		createdAt: Date.now(),
		lastActivity: Date.now(),
		sandboxed: false,
		...overrides,
	};
}

function makeManager(ps: any, bridge: any): any {
	registerRpcBridgeFactory(() => bridge);
	const manager: any = new SessionManager();
	manager._testStore = {
		get: vi.fn(() => ps),
		update: vi.fn(() => {}),
		put: vi.fn(() => {}),
		archive: vi.fn(() => {}),
	};
	managers.push(manager);
	return manager;
}

function liveSession(id: string, rpcClient: any, overrides: Record<string, any> = {}): any {
	return {
		id,
		title: `Live ${id}`,
		titleGenerated: true,
		cwd: tmpRoot,
		status: "idle",
		statusVersion: 4,
		createdAt: Date.now(),
		lastActivity: Date.now(),
		clients: new Set(),
		promptQueue: new PromptQueue(),
		eventBuffer: new EventBuffer(),
		inFlightSteerTexts: [],
		unsubscribe() {},
		rpcClient,
		projectId: "project-boundary",
		...overrides,
	};
}

describe("executable SessionManager rehydration boundaries", () => {
	it("repairs a cold-restored host transcript before switch_session observes it", async () => {
		const file = hostTranscript("cold-restore");
		const switches: string[] = [];
		const bridge = recordingBridge((sessionPath) => {
			switches.push(sessionPath);
			assertOrphanRewritten(fs.readFileSync(file, "utf8"));
		});
		const ps = persisted("cold-restore", file);
		const manager = makeManager(ps, bridge);

		await manager.restoreSession(ps);

		expect(switches).toEqual([file]);
	});

	it("repairs an in-place restart/respawn before the replacement process switches history", async () => {
		const file = hostTranscript("restart-respawn");
		const switches: string[] = [];
		const replacement = recordingBridge((sessionPath) => {
			switches.push(sessionPath);
			assertOrphanRewritten(fs.readFileSync(file, "utf8"));
		});
		const ps = persisted("restart-respawn", file);
		const manager = makeManager(ps, replacement);
		const oldBridge = recordingBridge(() => { throw new Error("old process must not switch"); });
		manager.sessions.set(ps.id, liveSession(ps.id, oldBridge));

		await manager.restartAgent(ps.id);

		expect(switches).toEqual([file]);
		expect(manager.sessions.get(ps.id)?.id).toBe(ps.id);
	});

	it("repairs assignRole refresh history before switch_session", async () => {
		const file = hostTranscript("assign-role");
		const switches: string[] = [];
		const replacement = recordingBridge((sessionPath) => {
			switches.push(sessionPath);
			assertOrphanRewritten(fs.readFileSync(file, "utf8"));
		});
		const ps = persisted("assign-role", file);
		const manager = makeManager(ps, replacement);
		const oldBridge = recordingBridge(() => { throw new Error("old process must not switch"); });
		oldBridge.getState = async () => ({ success: true, data: { sessionFile: file } });
		manager.sessions.set(ps.id, liveSession(ps.id, oldBridge));

		const assigned = await manager.assignRole(ps.id, {
			name: "boundary-role",
			promptTemplate: "Boundary role",
			accessory: "none",
		});

		expect(assigned).toBe(true);
		expect(switches).toEqual([file]);
	});

	it("repairs force-abort hard recovery before the replacement process switches history", async () => {
		const file = hostTranscript("force-abort");
		const switches: string[] = [];
		const replacement = recordingBridge((sessionPath) => {
			switches.push(sessionPath);
			assertOrphanRewritten(fs.readFileSync(file, "utf8"));
		});
		const ps = persisted("force-abort", file);
		const manager = makeManager(ps, replacement);
		const oldBridge = recordingBridge(() => { throw new Error("old process must not switch"); });
		oldBridge.getState = async () => ({ success: true, data: { sessionFile: file } });
		oldBridge.abort = async () => new Promise(() => {});
		manager.sessions.set(ps.id, liveSession(ps.id, oldBridge, {
			status: "streaming",
			streamingStartedAt: Date.now(),
		}));

		await manager.forceAbort(ps.id, 5);

		expect(switches).toEqual([file]);
	});

	it.each([
		{ realm: "host", sandboxed: false, failure: "response" as const, timeout: 15_000 },
		{ realm: "sandbox", sandboxed: true, failure: "exception" as const, timeout: 60_000 },
	])("does not install an assignRole replacement when the $realm history switch fails", async ({ realm, sandboxed, failure, timeout }) => {
		const file = hostTranscript(`assign-role-${realm}-failure`);
		const timeouts: number[] = [];
		const { bridge: replacement, stop } = failingSwitchBridge(failure, timeouts);
		const ps = persisted(`assign-role-${realm}-failure`, file, { sandboxed });
		const manager = makeManager(ps, replacement);
		manager.drainQueue = vi.fn();
		const oldBridge = recordingBridge(() => { throw new Error("old process must not switch"); });
		oldBridge.getState = async () => ({ success: true, data: { sessionFile: file } });
		const original = liveSession(ps.id, oldBridge, {
			sandboxed,
			spawnPinnedModel: "fixture/previous-model",
			spawnPinnedThinkingLevel: "high",
		});
		original.promptQueue.enqueue("queued user intent");
		manager.sessions.set(ps.id, original);

		await expect(manager.assignRole(ps.id, {
			name: "boundary-role",
			promptTemplate: "Boundary role",
			accessory: "none",
		})).rejects.toThrow(failure === "response" ? "switch_session failed" : "fixture switch timeout");

		expect(timeouts).toEqual([timeout]);
		expect(stop).toHaveBeenCalledTimes(1);
		expect(manager.drainQueue).not.toHaveBeenCalled();
		expect(manager.sessions.get(ps.id)).toBe(original);
		expect(original.rpcClient).toBe(oldBridge);
		expect(original.promptQueue.toArray().map((message: any) => message.text)).toEqual(["queued user intent"]);
		expect(original.role).toBeUndefined();
		expect(original.spawnPinnedModel).toBe("fixture/previous-model");
		expect(original.spawnPinnedThinkingLevel).toBe("high");
		expect(original.status).toBe("terminated");
		assertOrphanRewritten(fs.readFileSync(file, "utf8"));
	});

	it.each([
		{ realm: "host", sandboxed: false, failure: "response" as const, timeout: 15_000 },
		{ realm: "sandbox", sandboxed: true, failure: "exception" as const, timeout: 60_000 },
	])("does not install or drain a force-abort replacement when the $realm history switch fails", async ({ realm, sandboxed, failure, timeout }) => {
		const file = hostTranscript(`force-abort-${realm}-failure`);
		const timeouts: number[] = [];
		const { bridge: replacement, stop } = failingSwitchBridge(failure, timeouts);
		const ps = persisted(`force-abort-${realm}-failure`, file, { sandboxed });
		const manager = makeManager(ps, replacement);
		manager.applySandboxWiring = vi.fn(async () => sandboxed);
		manager.drainQueue = vi.fn();
		const oldBridge = recordingBridge(() => { throw new Error("old process must not switch"); });
		oldBridge.getState = async () => ({ success: true, data: { sessionFile: file } });
		oldBridge.abort = async () => new Promise(() => {});
		const original = liveSession(ps.id, oldBridge, {
			status: "streaming",
			streamingStartedAt: Date.now(),
			sandboxed,
			spawnPinnedModel: "fixture/previous-model",
			spawnPinnedThinkingLevel: "high",
		});
		original.promptQueue.enqueue("queued user intent");
		manager.sessions.set(ps.id, original);

		await manager.forceAbort(ps.id, 5);

		expect(timeouts).toEqual([timeout]);
		expect(stop).toHaveBeenCalledTimes(1);
		expect(manager.drainQueue).not.toHaveBeenCalled();
		expect(manager.sessions.get(ps.id)).toBe(original);
		expect(original.rpcClient).toBe(oldBridge);
		expect(original.promptQueue.toArray().map((message: any) => message.text)).toEqual(["queued user intent"]);
		expect(original.spawnPinnedModel).toBe("fixture/previous-model");
		expect(original.spawnPinnedThinkingLevel).toBe("high");
		expect(original.status).toBe("terminated");
		assertOrphanRewritten(fs.readFileSync(file, "utf8"));
	});
});

function pipelineContext(sandboxManager: any = null): any {
	return {
		roleManager: null,
		toolManager: null,
		mcpManager: null,
		goalManager: {},
		taskManager: { assignTask() {} },
		projectConfigStore: null,
		sandboxManager,
		sandboxTokenStore: null,
		sessionSecretStore: { getOrCreateSecret: () => "fixture-secret" },
		groupPolicyStore: null,
		configCascade: null,
		costTracker: {},
		store: { put: vi.fn(), update: vi.fn() },
		searchIndex: {},
		sessions: new Map(),
		assemblePrompt: () => undefined,
		applySandboxWiring: async (options: any) => {
			options.containerId = "container-boundary";
			return true;
		},
		handleAgentLifecycle() {},
		trackCostFromEvent() {},
		broadcast() {},
		tryAutoSelectModel: async () => {},
		tryApplyDefaultThinkingLevel: async () => {},
		buildWorkflowList: () => "",
		resolveInitialModel: () => undefined,
		resolveInitialThinkingLevel: () => undefined,
		prStatusStore: {},
	};
}

function setupPlan(id: string, agentSessionFile: string, sandboxed: boolean): any {
	return {
		id,
		mode: "normal",
		title: `Continue ${id}`,
		cwd: sandboxed ? "/workspace" : tmpRoot,
		projectId: "project-boundary",
		sandboxed,
		bridgeOptions: {},
		preExistingAgentSessionFile: agentSessionFile,
		skipAutoModel: true,
		skipAutoThinking: true,
	};
}

describe("executable continue-archived/live-fork setup boundary", () => {
	it("repairs a host clone before setup dispatches switch_session", async () => {
		const file = hostTranscript("continue-host");
		const switches: string[] = [];
		registerRpcBridgeFactory(() => recordingBridge((sessionPath) => {
			switches.push(sessionPath);
			assertOrphanRewritten(fs.readFileSync(file, "utf8"));
		}));

		await executePlan(setupPlan("continue-host", file, false), pipelineContext());

		expect(switches).toEqual([file]);
	});

	it("rewrites an orphan in a sandbox container-path clone before switching the sandbox process", async () => {
		const containerFile = "/home/node/.bobbit/agent/sessions/--orphan-boundaries--/continue-sandbox.jsonl";
		const hostFile = containerPathToHost(containerFile);
		fs.mkdirSync(path.dirname(hostFile), { recursive: true });
		fs.writeFileSync(hostFile, orphanTranscript(), "utf8");
		createdFiles.push(hostFile);
		const sandbox = {
			exec: vi.fn(async (args: string[]) => {
				if (args[0] === "cat") return fs.readFileSync(hostFile, "utf8");
				if (args[0] === "test") return "";
				if (args[0] === "echo") return "ok";
				throw new Error(`unexpected sandbox exec: ${args.join(" ")}`);
			}),
		};
		const sandboxManager = {
			ensureForProject: vi.fn(async () => sandbox),
			get: vi.fn(() => sandbox),
		};
		const switches: string[] = [];
		registerRpcBridgeFactory(() => recordingBridge((sessionPath) => {
			switches.push(sessionPath);
			expect(sessionPath).toBe(containerFile);
			assertOrphanRewritten(fs.readFileSync(hostFile, "utf8"));
		}));

		await executePlan(setupPlan("continue-sandbox", containerFile, true), pipelineContext(sandboxManager));

		expect(switches).toEqual([containerFile]);
		expect(sandbox.exec).toHaveBeenCalledWith(["cat", containerFile]);
	});
});

describe("worktree continue/fork shared boundary", () => {
	it("pins the shared sanitizer before switch_session ordering", () => {
		// executeWorktreeAsync performs real git worktree creation and component setup;
		// executing it here would turn this focused core test into an integration test.
		// Its transcript path still uses the same executable sanitizer + realm helpers
		// exercised above, so structurally pin only the worktree-specific call ordering.
		const source = fs.readFileSync(path.join(process.cwd(), "src/server/agent/session-setup.ts"), "utf8");
		const start = source.indexOf("export async function executeWorktreeAsync(");
		const end = source.indexOf("// ── Internal helpers", start);
		expect(start).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThan(start);
		const body = source.slice(start, end);
		const realm = body.indexOf("sessionFsContextForAgentFile(plan, plan.preExistingAgentSessionFile)");
		const sanitize = body.indexOf("sanitizeAgentTranscriptFile(", realm);
		const translate = body.indexOf("switchSessionPathForAgent({", sanitize);
		const dispatch = body.indexOf('{ type: "switch_session", sessionPath: switchSessionPath }', translate);

		expect(realm).toBeGreaterThanOrEqual(0);
		expect(sanitize).toBeGreaterThan(realm);
		expect(translate).toBeGreaterThan(sanitize);
		expect(dispatch).toBeGreaterThan(translate);
	});
});

describe("transcript realm resolution retained at every shared boundary", () => {
	it("keeps host and sandbox path translation deterministic", () => {
		const hostFile = hostTranscript("realm-host");
		const containerFile = switchSessionPathForAgent({ sandboxed: true, agentSessionFile: hostFile } as any);

		expect(sessionFsContextForAgentFile({ sandboxed: false, projectId: "p" }, hostFile))
			.toEqual({ sandboxed: false, projectId: "p" });
		expect(sessionFsContextForAgentFile({ sandboxed: true, projectId: "p" }, hostFile))
			.toEqual({ sandboxed: false, projectId: "p" });
		expect(containerFile).toBe("/home/node/.bobbit/agent/sessions/--orphan-boundaries--/realm-host.jsonl");
		expect(sessionFsContextForAgentFile({ sandboxed: true, projectId: "p" }, containerFile))
			.toEqual({ sandboxed: true, projectId: "p" });
	});
});
