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
const ORPHAN_ERROR =
	"400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"messages.88.content.0: unexpected tool_use_id found in tool_result blocks: toolu_fixture. Each tool_result block must have a corresponding tool_use block in the previous message.\"}}";

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

function containerTranscript(name: string): { containerFile: string; hostFile: string } {
	const containerFile = `/home/node/.bobbit/agent/sessions/--orphan-boundaries--/${name}.jsonl`;
	const hostFile = containerPathToHost(containerFile);
	fs.mkdirSync(path.dirname(hostFile), { recursive: true });
	fs.writeFileSync(hostFile, orphanTranscript(), "utf8");
	createdFiles.push(hostFile);
	return { containerFile, hostFile };
}

function realSandboxFixture(containerFile: string, containerId = "container-boundary"): {
	projectConfigStore: any;
	sandboxManager: any;
	sandbox: any;
} {
	const sandbox = {
		getContainerId: vi.fn(async () => containerId),
		exec: vi.fn(async (args: string[]) => {
			if (args[0] === "test" && args[1] === "-f" && args[2] === containerFile) return "";
			if (args[0] === "cat" && args[1] === containerFile) {
				return fs.readFileSync(containerPathToHost(containerFile), "utf8");
			}
			if (args[0] === "echo") return "ok";
			throw new Error(`unexpected sandbox exec: ${args.join(" ")}`);
		}),
	};
	return {
		projectConfigStore: {
			get: vi.fn((key: string) => key === "sandbox" ? "docker" : undefined),
			getSandboxTokens: vi.fn(() => []),
		},
		sandboxManager: {
			ensureForProject: vi.fn(async () => sandbox),
			get: vi.fn(() => sandbox),
		},
		sandbox,
	};
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
): {
	bridge: any;
	stop: ReturnType<typeof vi.fn>;
	unsubscribe: ReturnType<typeof vi.fn>;
	hasListener: () => boolean;
	emit: (event: any) => void;
} {
	const bridge = recordingBridge(() => {});
	const stop = vi.fn(async () => {});
	let listener: ((event: any) => void) | undefined;
	const unsubscribe = vi.fn(() => { listener = undefined; });
	bridge.stop = stop;
	bridge.onEvent = vi.fn((nextListener: (event: any) => void) => {
		listener = nextListener;
		return unsubscribe;
	});
	bridge.sendCommand = vi.fn(async (command: any, timeoutMs?: number) => {
		if (command?.type !== "switch_session") return { success: true };
		timeouts.push(timeoutMs!);
		listener?.({ type: "agent_end", messages: [] });
		if (failure === "exception") throw new Error("fixture switch timeout");
		return { success: false, error: "fixture switch rejected" };
	});
	return {
		bridge,
		stop,
		unsubscribe,
		hasListener: () => listener !== undefined,
		emit: (event: any) => listener?.(event),
	};
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

	it.each(["response", "exception"] as const)(
		"does not drain a durable restore queue when replayed agent_end precedes a failed switch (%s)",
		async (failure) => {
			const file = hostTranscript(`cold-restore-replay-${failure}`);
			const queued = new PromptQueue();
			queued.enqueue("durable queued intent");
			const ps = persisted(`cold-restore-replay-${failure}`, file, {
				messageQueue: queued.toArray(),
			});
			const bridge = recordingBridge(() => {});
			let listener: ((event: any) => void) | undefined;
			bridge.onEvent = vi.fn((nextListener: (event: any) => void) => {
				listener = nextListener;
				return () => { listener = undefined; };
			});
			bridge.prompt = vi.fn(async () => ({ success: true }));
			bridge.sendCommand = vi.fn(async (command: any) => {
				if (command?.type !== "switch_session") return { success: true };
				listener?.({ type: "agent_end", messages: [] });
				if (failure === "exception") throw new Error("fixture switch timeout");
				return { success: false, error: "fixture switch rejected" };
			});
			const manager = makeManager(ps, bridge);

			await expect(manager._restoreSessionCoalesced(ps)).rejects.toThrow(
				failure === "exception" ? "fixture switch timeout" : "switch_session failed",
			);

			expect(bridge.prompt).not.toHaveBeenCalled();
			expect(ps.messageQueue.map((message: any) => message.text)).toEqual(["durable queued intent"]);
			expect(manager.sessions.has(ps.id)).toBe(false);
		},
	);

	it("drains a durable restore queue once, only after replay succeeds and the replacement is canonical", async () => {
		const file = hostTranscript("cold-restore-replay-success");
		const queued = new PromptQueue();
		queued.enqueue("durable queued intent");
		const ps = persisted("cold-restore-replay-success", file, {
			messageQueue: queued.toArray(),
		});
		const bridge = recordingBridge(() => {});
		let listener: ((event: any) => void) | undefined;
		bridge.onEvent = vi.fn((nextListener: (event: any) => void) => {
			listener = nextListener;
			return () => { listener = undefined; };
		});
		let manager: any;
		bridge.prompt = vi.fn(async () => {
			const canonical = manager.sessions.get(ps.id);
			expect(canonical).toBeDefined();
			expect(canonical.rpcClient).toBe(bridge);
			return { success: true };
		});
		bridge.sendCommand = vi.fn(async (command: any) => {
			if (command?.type === "switch_session") {
				listener?.({ type: "agent_end", messages: [] });
			}
			return { success: true };
		});
		manager = makeManager(ps, bridge);

		await manager._restoreSessionCoalesced(ps);

		expect(bridge.prompt).toHaveBeenCalledTimes(1);
		expect(bridge.prompt).toHaveBeenCalledWith("durable queued intent", undefined);
		expect(manager.sessions.get(ps.id)?.promptQueue.isEmpty).toBe(true);
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
		// A structured getState rejection must fall back to the durable transcript,
		// not silently launch the replacement with empty history.
		oldBridge.getState = async () => ({ success: false, error: "fixture state unavailable" });
		oldBridge.stop = vi.fn(async () => {});
		const oldUnsubscribe = vi.fn();
		manager.sessions.set(ps.id, liveSession(ps.id, oldBridge, { unsubscribe: oldUnsubscribe }));

		const assigned = await manager.assignRole(ps.id, {
			name: "boundary-role",
			promptTemplate: "Boundary role",
			accessory: "none",
		});

		expect(assigned).toBe(true);
		expect(switches).toEqual([file]);
		expect(oldBridge.stop).toHaveBeenCalledTimes(1);
		expect(oldUnsubscribe).toHaveBeenCalledTimes(1);
		expect(manager.sessions.get(ps.id)?.rpcClient).toBe(replacement);
	});

	it("assignRole wires a real sandbox replacement before rehydrating container history", async () => {
		const { containerFile, hostFile } = containerTranscript("assign-role-real-sandbox");
		const sandboxFx = realSandboxFixture(containerFile, "container-role-boundary");
		fs.writeFileSync(path.join(stateDir, "gateway-url"), "http://127.0.0.1:7890\n", "utf8");
		const switches: string[] = [];
		const replacement = recordingBridge((sessionPath) => {
			switches.push(sessionPath);
			assertOrphanRewritten(fs.readFileSync(hostFile, "utf8"));
		});
		const sendCommand = vi.spyOn(replacement, "sendCommand");
		let replacementOptions: any;
		registerRpcBridgeFactory((options: any) => {
			replacementOptions = { ...options, env: { ...options.env } };
			return replacement;
		});
		const manager: any = new SessionManager({ projectConfigStore: sandboxFx.projectConfigStore });
		manager.sandboxManager = sandboxFx.sandboxManager;
		const ps = persisted("assign-role-real-sandbox", containerFile, {
			sandboxed: true,
			cwd: "/workspace",
		});
		manager._testStore = {
			get: vi.fn(() => ps),
			update: vi.fn(() => {}),
			put: vi.fn(() => {}),
			archive: vi.fn(() => {}),
		};
		managers.push(manager);
		const oldBridge = recordingBridge(() => { throw new Error("old process must not switch"); });
		oldBridge.getState = async () => ({ success: true, data: { sessionFile: containerFile } });
		manager.sessions.set(ps.id, liveSession(ps.id, oldBridge, {
			sandboxed: true,
			cwd: "/workspace",
		}));

		await expect(manager.assignRole(ps.id, {
			name: "boundary-role",
			promptTemplate: "Boundary role",
			accessory: "none",
		})).resolves.toBe(true);

		expect(sandboxFx.sandboxManager.ensureForProject).toHaveBeenCalledWith("project-boundary");
		expect(sandboxFx.sandbox.getContainerId).toHaveBeenCalledTimes(1);
		expect(replacementOptions).toMatchObject({
			containerId: "container-role-boundary",
			sandboxed: true,
			cwd: "/workspace",
			gatewayUrl: "http://127.0.0.1:7890",
		});
		expect(switches).toEqual([containerFile]);
		expect(sendCommand).toHaveBeenCalledWith(
			{ type: "switch_session", sessionPath: containerFile },
			60_000,
		);
	});

	it("assignRole leaves the original sandbox bridge usable when realm wiring is unavailable", async () => {
		const { containerFile } = containerTranscript("assign-role-sandbox-unavailable");
		const replacement = recordingBridge(() => { throw new Error("unavailable realm must not switch"); });
		replacement.start = vi.fn(async () => {});
		const ps = persisted("assign-role-sandbox-unavailable", containerFile, {
			sandboxed: true,
			cwd: "/workspace",
		});
		const manager = makeManager(ps, replacement);
		manager.applySandboxWiring = vi.fn(async () => false);
		const oldBridge = recordingBridge(() => { throw new Error("old process must not switch"); });
		oldBridge.getState = async () => ({ success: true, data: { sessionFile: containerFile } });
		oldBridge.stop = vi.fn(async () => {});
		const original = liveSession(ps.id, oldBridge, {
			sandboxed: true,
			cwd: "/workspace",
			unsubscribe: vi.fn(),
		});
		manager.sessions.set(ps.id, original);

		await expect(manager.assignRole(ps.id, {
			name: "boundary-role",
			promptTemplate: "Boundary role",
			accessory: "none",
		})).rejects.toThrow("sandbox realm is unavailable");

		expect(original.unsubscribe).not.toHaveBeenCalled();
		expect(oldBridge.stop).not.toHaveBeenCalled();
		expect(replacement.start).not.toHaveBeenCalled();
		expect(manager.sessions.get(ps.id)).toBe(original);
		expect(original.rpcClient).toBe(oldBridge);
		expect(original.role).toBeUndefined();
		expect(original.sandboxed).toBe(true);
		expect(original.status).toBe("idle");
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
		{ realm: "host", sandboxed: false, timeout: undefined, failureBoundary: "start" as const, switchFailure: "response" as const, firstAction: "retry" as const, laterAction: "retry" as const },
		{ realm: "sandbox", sandboxed: true, timeout: 60_000, failureBoundary: "switch" as const, switchFailure: "exception" as const, firstAction: "follow-up" as const, laterAction: "follow-up" as const },
	])("rolls back a failed $realm poison respawn at $failureBoundary and later recovers by $laterAction with the same session", async ({ realm, sandboxed, timeout, failureBoundary, switchFailure, firstAction, laterAction }) => {
		const file = hostTranscript(`poison-rollback-${realm}`);
		const switchTimeouts: number[] = [];
		const failedSwitch = failingSwitchBridge(switchFailure, switchTimeouts);
		const failedReplacement = failedSwitch.bridge;
		const stopFailedReplacement = failedSwitch.stop;
		if (failureBoundary === "start") {
			failedReplacement.start = vi.fn(async () => { throw new Error("fixture replacement start failed"); });
		}
		const successfulPrompts: string[] = [];
		const successfulSwitches: string[] = [];
		const successfulReplacement = recordingBridge((sessionPath) => successfulSwitches.push(sessionPath));
		successfulReplacement.getState = vi.fn(async () => ({
			success: true,
			data: { model: { provider: "anthropic", id: "claude-sonnet-4-5" } },
		}));
		successfulReplacement.prompt = vi.fn(async (text: string) => {
			successfulPrompts.push(text);
			return { success: true };
		});
		let replacementIndex = 0;
		const replacementOptions: any[] = [];
		registerRpcBridgeFactory((options: any) => {
			replacementOptions.push({ ...options });
			return replacementIndex++ === 0 ? failedReplacement : successfulReplacement;
		});

		const ps = persisted(`poison-rollback-${realm}`, file, {
			title: `Visible ${realm} history`,
			sandboxed,
			cwd: sandboxed ? "/workspace" : tmpRoot,
			modelProvider: "anthropic",
			modelId: "claude-sonnet-4-5",
			allowedTools: ["read"],
		});
		const manager: any = new SessionManager();
		manager._testStore = {
			get: vi.fn(() => ps),
			update: vi.fn((_id: string, updates: Record<string, unknown>) => Object.assign(ps, updates)),
			put: vi.fn(() => {}),
			archive: vi.fn(() => {}),
		};
		manager.resolveInitialThinkingLevel = vi.fn(() => "high");
		if (sandboxed) {
			manager.applySandboxWiring = vi.fn(async (options: any) => {
				options.containerId = "container-poison-rollback";
				options.sandboxed = true;
				return true;
			});
		}
		managers.push(manager);

		const oldBridge = recordingBridge(() => { throw new Error("poisoned bridge must not switch"); });
		oldBridge.stop = vi.fn(async () => {});
		oldBridge.prompt = vi.fn(async () => { throw new Error("poisoned bridge must not receive work"); });
		const client = { readyState: 1, send: vi.fn() };
		const original = liveSession(ps.id, oldBridge, {
			title: `Visible ${realm} history`,
			cwd: ps.cwd,
			sandboxed,
			clients: new Set([client]),
			lastTurnErrored: true,
			lastTurnErrorMessage: ORPHAN_ERROR,
			lastPromptText: "original user intent",
			lastPromptSource: "user",
			modelProvider: "anthropic",
			modelId: "claude-sonnet-4-5",
			thinkingLevel: "high",
			spawnPinnedModel: "anthropic/claude-sonnet-4-5",
			spawnPinnedThinkingLevel: "high",
			allowedTools: ["read", "grep", "bash"],
			sessionOnlyGrantedTools: ["grep"],
			oneTimeGrantedTools: ["bash"],
		});
		original.promptQueue.enqueue("parked queue intent");
		ps.messageQueue = original.promptQueue.toArray();
		manager.sessions.set(ps.id, original);
		vi.spyOn(console, "info").mockImplementation(() => {});

		const firstRecovery = firstAction === "retry"
			? manager.retryLastPrompt(ps.id)
			: manager.enqueuePrompt(ps.id, "preserved failed follow-up", { source: "user" });
		await expect(firstRecovery).rejects.toThrow(
			failureBoundary === "start"
				? "fixture replacement start failed"
				: (switchFailure === "exception" ? "fixture switch timeout" : "switch_session failed"),
		);

		const rollback = manager.sessions.get(ps.id);
		expect(rollback).toBe(original);
		expect(rollback.id).toBe(ps.id);
		expect(rollback.status).toBe("terminated");
		expect(rollback.dormant).toBe(true);
		expect(rollback.lifecycleFenced).toBe(true);
		expect(rollback.clients.has(client)).toBe(true);
		const expectedParkedIntent = firstAction === "follow-up"
			? ["parked queue intent", "preserved failed follow-up"]
			: ["parked queue intent"];
		expect(rollback.promptQueue.toArray().map((message: any) => message.text)).toEqual(expectedParkedIntent);
		expect(rollback.lastPromptText).toBe("original user intent");
		expect(rollback.modelId).toBe("claude-sonnet-4-5");
		expect(rollback.thinkingLevel).toBe("high");
		expect(rollback.allowedTools).toEqual(["read", "grep", "bash"]);
		expect(rollback.sessionOnlyGrantedTools).toEqual(["grep"]);
		expect(rollback.oneTimeGrantedTools).toEqual(["bash"]);
		expect(rollback.sandboxed).toBe(sandboxed);
		expect(rollback.cwd).toBe(ps.cwd);
		expect(ps.sandboxed).toBe(sandboxed);
		expect(oldBridge.prompt).not.toHaveBeenCalled();
		expect(oldBridge.stop).toHaveBeenCalledTimes(1);
		expect(stopFailedReplacement).toHaveBeenCalledTimes(1);
		if (failureBoundary === "switch") {
			expect(failedSwitch.unsubscribe).toHaveBeenCalledTimes(1);
			expect(failedSwitch.hasListener()).toBe(false);
			failedSwitch.emit({ type: "agent_end", messages: [] });
			expect(manager.sessions.get(ps.id)).toBe(rollback);
		}

		if (laterAction === "retry") {
			await expect(manager.retryLastPrompt(ps.id)).resolves.toBeUndefined();
		} else {
			await expect(manager.enqueuePrompt(ps.id, "later follow-up intent", { source: "user" }))
				.resolves.toEqual({ status: "dispatched" });
		}

		const restored = manager.sessions.get(ps.id);
		expect(restored).not.toBe(original);
		expect(restored.id).toBe(ps.id);
		expect(restored.title).toBe(`Visible ${realm} history`);
		expect(restored.clients.has(client)).toBe(true);
		expect(restored.promptQueue.toArray().map((message: any) => message.text)).toEqual(expectedParkedIntent);
		expect(restored.spawnPinnedModel).toBe("anthropic/claude-sonnet-4-5");
		expect(restored.spawnPinnedThinkingLevel).toBe("high");
		expect(restored.allowedTools).toEqual(["read", "grep", "bash"]);
		expect(restored.sessionOnlyGrantedTools).toEqual(["grep"]);
		expect(restored.oneTimeGrantedTools).toEqual(["bash"]);
		expect(restored.sandboxed).toBe(sandboxed);
		expect(restored.cwd).toBe(ps.cwd);
		expect(successfulPrompts).toEqual([
			laterAction === "retry" ? "original user intent" : "later follow-up intent",
		]);
		expect(switchTimeouts).toEqual(timeout === undefined ? [] : [timeout]);
		expect(successfulSwitches).toEqual([
			sandboxed ? switchSessionPathForAgent(ps) : file,
		]);
		if (sandboxed) {
			expect(manager.applySandboxWiring).toHaveBeenCalledTimes(2);
			expect(replacementOptions).toHaveLength(2);
			expect(replacementOptions[0].cwd).toBe("/workspace");
			expect(replacementOptions[1].cwd).toBe("/workspace");
		}
	});

	it("keeps a failed sandbox poison rollback intact across addClient reconnect until one later Retry", async () => {
		const file = hostTranscript("poison-rollback-sandbox-reconnect");
		const successfulPrompts: string[] = [];
		const replacement = recordingBridge(() => {});
		replacement.getState = vi.fn(async () => ({
			success: true,
			data: { model: { provider: "anthropic", id: "claude-sonnet-4-5" } },
		}));
		replacement.prompt = vi.fn(async (text: string) => {
			successfulPrompts.push(text);
			return { success: true };
		});
		const factory = vi.fn(() => replacement);
		registerRpcBridgeFactory(factory);

		const ps = persisted("poison-rollback-sandbox-reconnect", file, {
			title: "Visible sandbox reconnect history",
			sandboxed: true,
			cwd: "/workspace",
			modelProvider: "anthropic",
			modelId: "claude-sonnet-4-5",
			allowedTools: ["read"],
		});
		const manager: any = new SessionManager();
		manager._testStore = {
			get: vi.fn(() => ps),
			update: vi.fn((_id: string, updates: Record<string, unknown>) => Object.assign(ps, updates)),
			put: vi.fn(() => {}),
			archive: vi.fn(() => {}),
		};
		let sandboxAvailable = false;
		manager.applySandboxWiring = vi.fn(async (options: any) => {
			if (!sandboxAvailable) return false;
			options.containerId = "container-poison-reconnect";
			options.sandboxed = true;
			return true;
		});
		manager.resolveInitialThinkingLevel = vi.fn(() => "high");
		managers.push(manager);

		const oldPrompts: string[] = [];
		const oldBridge = recordingBridge(() => { throw new Error("poisoned bridge must not switch"); });
		oldBridge.stop = vi.fn(async () => {});
		oldBridge.prompt = vi.fn(async (text: string) => {
			oldPrompts.push(text);
			throw new Error("poisoned bridge must not receive work");
		});
		const originalClient = { readyState: 1, send: vi.fn() };
		const reconnectClient = { readyState: 1, send: vi.fn() };
		const original = liveSession(ps.id, oldBridge, {
			title: ps.title,
			cwd: ps.cwd,
			sandboxed: true,
			clients: new Set([originalClient]),
			lastTurnErrored: true,
			lastTurnErrorMessage: ORPHAN_ERROR,
			lastPromptText: "original sandbox retry intent",
			lastPromptSource: "user",
			turnHadToolCalls: false,
			modelProvider: "anthropic",
			modelId: "claude-sonnet-4-5",
			spawnPinnedModel: "anthropic/claude-sonnet-4-5",
			spawnPinnedThinkingLevel: "high",
			allowedTools: ["read"],
			sessionOnlyGrantedTools: ["grep"],
			oneTimeGrantedTools: ["bash"],
			pendingSkillExpansions: [{
				modelText: "expanded retry intent",
				originalText: "/fixture retry intent",
				skillExpansions: [],
			}],
		});
		original.promptQueue.enqueue("parked sandbox intent");
		ps.messageQueue = original.promptQueue.toArray();
		original.eventBuffer.push({ type: "message_end", message: { role: "assistant", content: "visible history" } });
		const rollbackBuffer = original.eventBuffer;
		const rollbackLastSeq = rollbackBuffer.lastSeq;
		manager.sessions.set(ps.id, original);
		vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});

		await expect(manager.retryLastPrompt(ps.id)).rejects.toThrow("sandbox realm is unavailable");
		const rollback = manager.sessions.get(ps.id);
		expect(rollback).toBe(original);
		expect(rollback.status).toBe("terminated");
		expect(manager.applySandboxWiring).toHaveBeenCalledTimes(1);
		expect(factory).not.toHaveBeenCalled();

		expect(manager.addClient(ps.id, reconnectClient)).toBe(true);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(manager.sessions.get(ps.id)).toBe(rollback);
		expect(rollback.clients.has(originalClient)).toBe(true);
		expect(rollback.clients.has(reconnectClient)).toBe(true);
		expect(rollback.eventBuffer).toBe(rollbackBuffer);
		expect(rollback.eventBuffer.lastSeq).toBe(rollbackLastSeq);
		expect(rollback.lastPromptText).toBe("original sandbox retry intent");
		expect(rollback.turnHadToolCalls).toBe(false);
		expect(rollback.pendingSkillExpansions).toHaveLength(1);
		expect(rollback.promptQueue.toArray().map((message: any) => message.text)).toEqual(["parked sandbox intent"]);
		expect(rollback.sessionOnlyGrantedTools).toEqual(["grep"]);
		expect(rollback.oneTimeGrantedTools).toEqual(["bash"]);
		expect(ps.sandboxed).toBe(true);
		expect(manager.applySandboxWiring).toHaveBeenCalledTimes(1);
		expect(manager._testStore.update).not.toHaveBeenCalledWith(ps.id, { sandboxed: false });

		sandboxAvailable = true;
		await expect(manager.retryLastPrompt(ps.id)).resolves.toBeUndefined();

		const restored = manager.sessions.get(ps.id);
		expect(restored).not.toBe(original);
		expect(restored.id).toBe(ps.id);
		expect(restored.title).toBe("Visible sandbox reconnect history");
		expect(restored.sandboxed).toBe(true);
		expect(restored.clients.has(originalClient)).toBe(true);
		expect(restored.clients.has(reconnectClient)).toBe(true);
		expect(restored.eventBuffer.lastSeq).toBeGreaterThanOrEqual(rollbackLastSeq);
		expect(restored.spawnPinnedModel).toBe("anthropic/claude-sonnet-4-5");
		expect(restored.spawnPinnedThinkingLevel).toBe("high");
		expect(restored.sessionOnlyGrantedTools).toEqual(["grep"]);
		expect(restored.oneTimeGrantedTools).toEqual(["bash"]);
		expect(restored.pendingSkillExpansions).toHaveLength(1);
		expect(restored.promptQueue.toArray().map((message: any) => message.text)).toEqual(["parked sandbox intent"]);
		expect(successfulPrompts).toEqual(["original sandbox retry intent"]);
		expect(oldPrompts).toEqual([]);
		expect(factory).toHaveBeenCalledTimes(1);
		expect(manager.applySandboxWiring).toHaveBeenCalledTimes(2);
		expect(ps.sandboxed).toBe(true);
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
		if (sandboxed) {
			manager.applySandboxWiring = vi.fn(async (options: any) => {
				options.containerId = "container-assign-failure";
				options.sandboxed = true;
				return true;
			});
		}
		manager.drainQueue = vi.fn();
		const oldBridge = recordingBridge(() => { throw new Error("old process must not switch"); });
		oldBridge.getState = async () => ({ success: true, data: { sessionFile: file } });
		oldBridge.stop = vi.fn(async () => {});
		const oldUnsubscribe = vi.fn();
		const original = liveSession(ps.id, oldBridge, {
			sandboxed,
			unsubscribe: oldUnsubscribe,
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
		expect(oldBridge.stop).not.toHaveBeenCalled();
		expect(oldUnsubscribe).not.toHaveBeenCalled();
		expect(original.promptQueue.toArray().map((message: any) => message.text)).toEqual(["queued user intent"]);
		expect(original.role).toBeUndefined();
		expect(original.spawnPinnedModel).toBe("fixture/previous-model");
		expect(original.spawnPinnedThinkingLevel).toBe("high");
		expect(original.status).toBe("idle");
		assertOrphanRewritten(fs.readFileSync(file, "utf8"));
	});

	it("assignRole fails closed when its durable history path has disappeared", async () => {
		const file = hostTranscript("assign-role-missing-history");
		const replacement = recordingBridge(() => { throw new Error("missing history must not switch"); });
		replacement.stop = vi.fn(async () => {});
		const ps = persisted("assign-role-missing-history", file);
		const manager = makeManager(ps, replacement);
		const oldBridge = recordingBridge(() => { throw new Error("old process must not switch"); });
		oldBridge.getState = async () => ({ success: false, error: "fixture state unavailable" });
		oldBridge.stop = vi.fn(async () => {});
		const oldUnsubscribe = vi.fn();
		const original = liveSession(ps.id, oldBridge, { unsubscribe: oldUnsubscribe });
		manager.sessions.set(ps.id, original);
		fs.rmSync(file);

		await expect(manager.assignRole(ps.id, {
			name: "replacement-role",
			promptTemplate: "Replacement role",
			accessory: "replacement-accessory",
		})).rejects.toThrow("persisted conversation history is unavailable");

		expect(manager.sessions.get(ps.id)).toBe(original);
		expect(original.rpcClient).toBe(oldBridge);
		expect(original.status).toBe("idle");
		expect(oldBridge.stop).not.toHaveBeenCalled();
		expect(oldUnsubscribe).not.toHaveBeenCalled();
		expect(replacement.stop).toHaveBeenCalledTimes(1);
	});

	it.each(["start", "model", "old-stop"] as const)(
		"assignRole fails closed when replacement preparation fails at %s",
		async (failure) => {
			const file = hostTranscript(`assign-role-${failure}-failure`);
			const replacement = recordingBridge(() => {});
			replacement.stop = vi.fn(async () => {});
			if (failure === "start") {
				replacement.start = vi.fn(async () => { throw new Error("fixture replacement start failed"); });
			}
			const ps = persisted(`assign-role-${failure}-failure`, file, {
				role: "previous-role",
				accessory: "previous-accessory",
			});
			const manager = makeManager(ps, replacement);
			if (failure === "model") {
				manager.tryAutoSelectModel = vi.fn(async () => { throw new Error("fixture model verification failed"); });
			}
			const oldBridge = recordingBridge(() => { throw new Error("old process must not switch"); });
			oldBridge.getState = async () => ({ success: true, data: { sessionFile: file } });
			oldBridge.stop = failure === "old-stop"
				? vi.fn(async () => { throw new Error("fixture old stop failed"); })
				: vi.fn(async () => {});
			const oldUnsubscribe = vi.fn();
			const original = liveSession(ps.id, oldBridge, {
				role: "previous-role",
				accessory: "previous-accessory",
				unsubscribe: oldUnsubscribe,
			});
			manager.sessions.set(ps.id, original);

			await expect(manager.assignRole(ps.id, {
				name: "replacement-role",
				promptTemplate: "Replacement role",
				accessory: "replacement-accessory",
			})).rejects.toThrow(
				failure === "start"
					? "fixture replacement start failed"
					: failure === "model"
						? "fixture model verification failed"
						: "fixture old stop failed",
			);

			expect(manager.sessions.get(ps.id)).toBe(original);
			expect(original.rpcClient).toBe(oldBridge);
			expect(original.status).toBe("idle");
			expect(original.role).toBe("previous-role");
			expect(original.accessory).toBe("previous-accessory");
			expect(oldUnsubscribe).not.toHaveBeenCalled();
			expect(oldBridge.stop).toHaveBeenCalledTimes(failure === "old-stop" ? 1 : 0);
			expect(replacement.stop).toHaveBeenCalledTimes(1);
			expect(ps.role).toBe("previous-role");
			expect(ps.accessory).toBe("previous-accessory");
		},
	);

	it("force-abort fails closed when a sandbox replacement cannot retain the transcript realm", async () => {
		const { containerFile, hostFile } = containerTranscript("force-abort-sandbox-downgrade");
		const replacement = recordingBridge(() => { throw new Error("realm downgrade must not switch"); });
		replacement.start = vi.fn(async () => {});
		const ps = persisted("force-abort-sandbox-downgrade", containerFile, {
			sandboxed: true,
			cwd: "/workspace",
		});
		const manager = makeManager(ps, replacement);
		manager.applySandboxWiring = vi.fn(async () => false);
		manager.drainQueue = vi.fn();
		const oldBridge = recordingBridge(() => { throw new Error("old process must not switch"); });
		oldBridge.getState = async () => ({ success: true, data: { sessionFile: containerFile } });
		oldBridge.abort = async () => new Promise(() => {});
		const original = liveSession(ps.id, oldBridge, {
			status: "streaming",
			streamingStartedAt: Date.now(),
			sandboxed: true,
			cwd: "/workspace",
		});
		original.promptQueue.enqueue("queued user intent");
		manager.sessions.set(ps.id, original);

		await manager.forceAbort(ps.id, 5);

		expect(manager.applySandboxWiring).toHaveBeenCalledTimes(1);
		expect(replacement.start).not.toHaveBeenCalled();
		expect(manager.drainQueue).not.toHaveBeenCalled();
		expect(manager.sessions.get(ps.id)).toBe(original);
		expect(original.rpcClient).toBe(oldBridge);
		expect(original.sandboxed).toBe(true);
		expect(original.promptQueue.toArray().map((message: any) => message.text)).toEqual(["queued user intent"]);
		expect(original.status).toBe("terminated");
		expect(manager._testStore.update).not.toHaveBeenCalledWith(ps.id, { sandboxed: false });
		expect(fs.readFileSync(hostFile, "utf8")).toBe(orphanTranscript());
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
