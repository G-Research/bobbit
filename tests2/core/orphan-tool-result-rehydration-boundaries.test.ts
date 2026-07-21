// v2-e2e-vitest real-filesystem owner: exercises host and sandbox transcript
// rehydration boundaries plus coordinated replacement lifecycle behavior.
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
		getLive: vi.fn(() => [ps]),
		update: vi.fn(() => {}),
		put: vi.fn(() => {}),
		archive: vi.fn(() => {}),
		archiveAsync: vi.fn(async (id: string) => { manager._testStore.archive(id); }),
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

function deferred<T = void>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
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

	it("keeps boot continuation fenced and preserves terminal lifecycle before delayed prompt acknowledgement", async () => {
		const file = hostTranscript("boot-continuation-dispatch-fence");
		const bootEntered = deferred<void>();
		const bootAccepted = deferred<void>();
		let listener: ((event: any) => void) | undefined;
		const bridge = recordingBridge(() => {});
		bridge.onEvent = vi.fn((next: (event: any) => void) => {
			listener = next;
			return () => { listener = undefined; };
		});
		bridge.promptWhenReady = vi.fn(async () => {
			bootEntered.resolve();
			await bootAccepted.promise;
			return { success: true };
		});
		bridge.prompt = vi.fn(async () => {
			listener?.({ type: "agent_start" });
			listener?.({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "queued done" }], stopReason: "stop" },
			});
			listener?.({ type: "agent_end", messages: [] });
			return { success: true };
		});
		const ps = persisted("boot-continuation-dispatch-fence", file, { wasStreaming: true });
		const manager = makeManager(ps, bridge);

		const restore = manager._restoreSessionCoalesced(ps);
		await bootEntered.promise;
		expect(manager._sessionReplacementCoordinators.has(ps.id)).toBe(true);

		await expect(manager.enqueuePrompt(ps.id, "accepted while boot prompt is pending"))
			.resolves.toEqual({ status: "queued" });
		expect(bridge.prompt).not.toHaveBeenCalled();

		listener?.({ type: "agent_start" });
		listener?.({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "continued" }], stopReason: "stop" },
		});
		listener?.({ type: "agent_end", messages: [] });
		const canonicalBeforeAck = manager.sessions.get(ps.id);
		expect(canonicalBeforeAck?.status).toBe("idle");
		expect(canonicalBeforeAck?.completedTurnCount).toBe(1);
		expect(canonicalBeforeAck?.promptQueue.toArray().map((row: any) => row.text))
			.toEqual(["accepted while boot prompt is pending"]);
		expect(bridge.prompt).not.toHaveBeenCalled();

		bootAccepted.resolve();
		await restore;
		expect(manager._sessionReplacementCoordinators.has(ps.id)).toBe(false);
		expect(bridge.prompt).toHaveBeenCalledTimes(1);
		expect(bridge.prompt).toHaveBeenCalledWith("accepted while boot prompt is pending", undefined);
		const canonical = manager.sessions.get(ps.id);
		expect(canonical?.status).toBe("idle");
		expect(canonical?.promptQueue.isEmpty).toBe(true);
		expect(canonical?.completedTurnCount).toBe(2);
	});

	it("treats a rejected boot-continuation acknowledgement as accepted after terminal lifecycle", async () => {
		const file = hostTranscript("boot-continuation-terminal-before-rejection");
		const bootEntered = deferred<void>();
		const rejectAck = deferred<void>();
		let listener: ((event: any) => void) | undefined;
		const bridge = recordingBridge(() => {});
		bridge.onEvent = vi.fn((next: (event: any) => void) => {
			listener = next;
			return () => { listener = undefined; };
		});
		bridge.promptWhenReady = vi.fn(async () => {
			bootEntered.resolve();
			await rejectAck.promise;
			throw new Error("Command timed out: prompt");
		});
		const ps = persisted("boot-continuation-terminal-before-rejection", file, { wasStreaming: true });
		const manager = makeManager(ps, bridge);
		vi.spyOn(console, "warn").mockImplementation(() => {});

		const restore = manager._restoreSessionCoalesced(ps);
		await bootEntered.promise;
		listener?.({ type: "agent_start" });
		listener?.({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "continued" }], stopReason: "stop" },
		});
		listener?.({ type: "agent_end", messages: [] });
		rejectAck.resolve();
		await restore;

		const canonical = manager.sessions.get(ps.id);
		expect(canonical?.status).toBe("idle");
		expect(canonical?.completedTurnCount).toBe(1);
		expect(canonical?.restoreStartupWasStreaming).toBe(false);
		expect(manager._testStore.update).toHaveBeenCalledWith(ps.id, { wasStreaming: false });
		expect(manager._sessionReplacementCoordinators.has(ps.id)).toBe(false);
	});

	it("does not release-drain a queued follow-up after the boot continuation ends in error before acknowledgement", async () => {
		const file = hostTranscript("boot-continuation-error-before-ack");
		const bootEntered = deferred<void>();
		const bootAccepted = deferred<void>();
		let listener: ((event: any) => void) | undefined;
		const bridge = recordingBridge(() => {});
		bridge.onEvent = vi.fn((next: (event: any) => void) => {
			listener = next;
			return () => { listener = undefined; };
		});
		bridge.promptWhenReady = vi.fn(async () => {
			bootEntered.resolve();
			await bootAccepted.promise;
			return { success: true };
		});
		bridge.prompt = vi.fn(async () => ({ success: true }));
		const ps = persisted("boot-continuation-error-before-ack", file, { wasStreaming: true });
		const manager = makeManager(ps, bridge);

		const restore = manager._restoreSessionCoalesced(ps);
		await bootEntered.promise;
		await expect(manager.enqueuePrompt(ps.id, "recoverable follow-up after failed continuation"))
			.resolves.toEqual({ status: "queued" });

		listener?.({ type: "agent_start" });
		listener?.({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "continuation failed" }],
				stopReason: "error",
				errorMessage: "fixture terminal provider error",
			},
		});
		listener?.({ type: "agent_end", messages: [] });
		bootAccepted.resolve();
		await restore;

		const canonical = manager.sessions.get(ps.id);
		expect(bridge.prompt).not.toHaveBeenCalled();
		expect(canonical?.status).toBe("idle");
		expect(canonical?.lastTurnErrored).toBe(true);
		expect(canonical?.promptQueue.toArray().map((row: any) => row.text))
			.toEqual(["recoverable follow-up after failed continuation"]);
		expect(manager._testStore.update).toHaveBeenCalledWith(
			ps.id,
			expect.objectContaining({
				messageQueue: [expect.objectContaining({ text: "recoverable follow-up after failed continuation" })],
			}),
		);
		expect(manager._sessionReplacementCoordinators.has(ps.id)).toBe(false);
	});

	it("re-arms an unobserved failed boot continuation on the queued assignRole replacement", async () => {
		const file = hostTranscript("boot-continuation-rearmed-after-role");
		const bootEntered = deferred<void>();
		const rejectBoot = deferred<void>();
		const restoreBridge = recordingBridge(() => {});
		const roleBridge = recordingBridge(() => {});
		restoreBridge.promptWhenReady = vi.fn(async () => {
			bootEntered.resolve();
			await rejectBoot.promise;
			throw new Error("fixture boot continuation rejection");
		});
		roleBridge.promptWhenReady = vi.fn(async () => ({ success: true }));
		roleBridge.prompt = vi.fn(async () => ({ success: true }));
		const factory = vi.fn()
			.mockReturnValueOnce(restoreBridge)
			.mockReturnValueOnce(roleBridge);
		registerRpcBridgeFactory(factory);
		const ps = persisted("boot-continuation-rearmed-after-role", file, { wasStreaming: true });
		const manager: any = new SessionManager();
		manager._testStore = {
			get: vi.fn(() => ps),
			getLive: vi.fn(() => [ps]),
			update: vi.fn((_id: string, updates: Record<string, unknown>) => Object.assign(ps, updates)),
			put: vi.fn(() => {}),
			archive: vi.fn(() => {}),
		};
		managers.push(manager);
		vi.spyOn(console, "error").mockImplementation(() => {});

		const restore = manager._restoreSessionCoalesced(ps);
		await bootEntered.promise;
		const assignment = manager.assignRole(ps.id, {
			name: "replacement-role",
			promptTemplate: "Replacement role",
			accessory: "replacement-accessory",
		});
		rejectBoot.resolve();

		await expect(Promise.all([restore, assignment])).resolves.toEqual([
			expect.objectContaining({ id: ps.id }),
			true,
		]);
		expect(factory).toHaveBeenCalledTimes(2);
		expect(restoreBridge.promptWhenReady).toHaveBeenCalledTimes(1);
		expect(roleBridge.promptWhenReady).toHaveBeenCalledTimes(1);
		expect(roleBridge.promptWhenReady).toHaveBeenCalledWith(expect.stringMatching(/server restarted while you were mid-turn/i));
		expect(roleBridge.prompt).not.toHaveBeenCalled();
		const canonical = manager.sessions.get(ps.id);
		expect(canonical?.rpcClient).toBe(roleBridge);
		expect(canonical?.restoreStartupWasStreaming).toBe(false);
		expect(ps.wasStreaming).toBe(false);
		expect(manager._sessionReplacementCoordinators.has(ps.id)).toBe(false);
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

	it("durably queues prompts during assignRole staging and dispatches them only after commit", async () => {
		const file = hostTranscript("assign-role-staging-prompt");
		const startGate = deferred<void>();
		const replacement = recordingBridge(() => {});
		replacement.start = vi.fn(() => startGate.promise);
		replacement.prompt = vi.fn(async () => ({ success: true }));
		const ps = persisted("assign-role-staging-prompt", file);
		const manager = makeManager(ps, replacement);
		const oldBridge = recordingBridge(() => { throw new Error("old process must not switch"); });
		oldBridge.prompt = vi.fn(async () => ({ success: true }));
		oldBridge.stop = vi.fn(async () => {});
		const original = liveSession(ps.id, oldBridge, { unsubscribe: vi.fn() });
		manager.sessions.set(ps.id, original);

		const assignment = manager.assignRole(ps.id, {
			name: "replacement-role",
			promptTemplate: "Replacement role",
			accessory: "replacement-accessory",
		});
		await vi.waitFor(() => expect(replacement.start).toHaveBeenCalledTimes(1));
		expect(original.status).toBe("starting");

		await expect(manager.enqueuePrompt(ps.id, "accepted during staging")).resolves.toEqual({ status: "queued" });
		// A late event from the still-subscribed old bridge must not release the
		// staging fence or drain accepted intent against the process being replaced.
		manager.handleAgentLifecycle(original, { type: "agent_end", messages: [] });
		expect(original.status).toBe("starting");
		expect(oldBridge.prompt).not.toHaveBeenCalled();
		expect(replacement.prompt).not.toHaveBeenCalled();
		expect(original.promptQueue.toArray().map((message: any) => message.text)).toEqual(["accepted during staging"]);
		expect(manager._testStore.update).toHaveBeenCalledWith(
			ps.id,
			expect.objectContaining({
				messageQueue: [expect.objectContaining({ text: "accepted during staging" })],
			}),
		);

		startGate.resolve();
		await expect(assignment).resolves.toBe(true);

		expect(oldBridge.prompt).not.toHaveBeenCalled();
		expect(replacement.prompt).toHaveBeenCalledTimes(1);
		expect(replacement.prompt).toHaveBeenCalledWith("accepted during staging", undefined);
		expect(manager.sessions.get(ps.id)?.rpcClient).toBe(replacement);
		expect(manager.sessions.get(ps.id)?.promptQueue.isEmpty).toBe(true);
	});

	it.each([
		{ label: "generic errored", error: "fixture provider failure" },
		{ label: "poisoned-history", error: ORPHAN_ERROR },
	])("keeps a $label follow-up error-gated after assignRole staging", async ({ error }) => {
		const file = hostTranscript(`assign-role-error-fence-${error === ORPHAN_ERROR ? "poison" : "generic"}`);
		const startGate = deferred<void>();
		const replacement = recordingBridge(() => {});
		replacement.start = vi.fn(() => startGate.promise);
		replacement.prompt = vi.fn(async () => ({ success: true }));
		const ps = persisted(`assign-role-error-fence-${error === ORPHAN_ERROR ? "poison" : "generic"}`, file);
		const manager = makeManager(ps, replacement);
		const oldBridge = recordingBridge(() => { throw new Error("old process must not switch"); });
		oldBridge.prompt = vi.fn(async () => ({ success: true }));
		oldBridge.stop = vi.fn(async () => {});
		const original = liveSession(ps.id, oldBridge, {
			unsubscribe: vi.fn(),
			lastTurnErrored: true,
			lastTurnErrorMessage: error,
			consecutiveErrorTurns: 3,
		});
		manager.sessions.set(ps.id, original);
		const poisonRecovery = vi.spyOn(manager, "_recoverPoisonedHistory");

		const assignment = manager.assignRole(ps.id, {
			name: "replacement-role",
			promptTemplate: "Replacement role",
			accessory: "replacement-accessory",
		});
		await vi.waitFor(() => expect(replacement.start).toHaveBeenCalledTimes(1));

		await expect(manager.enqueuePrompt(ps.id, "fenced errored intent"))
			.resolves.toEqual({ status: "queued" });
		expect(poisonRecovery).not.toHaveBeenCalled();
		expect(oldBridge.prompt).not.toHaveBeenCalled();
		expect(original.promptQueue.toArray().map((row: any) => row.text)).toEqual(["fenced errored intent"]);

		startGate.resolve();
		await expect(assignment).resolves.toBe(true);
		expect(replacement.prompt).not.toHaveBeenCalled();
		expect(oldBridge.prompt).not.toHaveBeenCalled();
		const canonical = manager.sessions.get(ps.id);
		expect(canonical.lastTurnErrored).toBe(true);
		expect(canonical.promptQueue.toArray().map((row: any) => row.text))
			.toEqual(["fenced errored intent"]);
		expect(manager._sessionReplacementCoordinators.has(ps.id)).toBe(false);
	});

	it("rolls staged prompts back durably and dispatches them on the original bridge after assignment failure", async () => {
		const file = hostTranscript("assign-role-staging-rollback");
		const startGate = deferred<void>();
		const replacement = recordingBridge(() => {});
		replacement.start = vi.fn(() => startGate.promise);
		replacement.stop = vi.fn(async () => {});
		const ps = persisted("assign-role-staging-rollback", file, {
			role: "previous-role",
			accessory: "previous-accessory",
		});
		const manager = makeManager(ps, replacement);
		const oldBridge = recordingBridge(() => { throw new Error("old process must not switch"); });
		oldBridge.prompt = vi.fn(async () => ({ success: true }));
		oldBridge.stop = vi.fn(async () => {});
		const oldUnsubscribe = vi.fn();
		const original = liveSession(ps.id, oldBridge, {
			role: "previous-role",
			accessory: "previous-accessory",
			unsubscribe: oldUnsubscribe,
		});
		manager.sessions.set(ps.id, original);

		const assignment = manager.assignRole(ps.id, {
			name: "replacement-role",
			promptTemplate: "Replacement role",
			accessory: "replacement-accessory",
		});
		await vi.waitFor(() => expect(replacement.start).toHaveBeenCalledTimes(1));
		await manager.enqueuePrompt(ps.id, "intent survives rollback");
		startGate.reject(new Error("fixture staged start failed"));

		await expect(assignment).rejects.toThrow("fixture staged start failed");
		expect(manager.sessions.get(ps.id)).toBe(original);
		expect(original.rpcClient).toBe(oldBridge);
		expect(original.role).toBe("previous-role");
		expect(original.accessory).toBe("previous-accessory");
		expect(oldBridge.stop).not.toHaveBeenCalled();
		expect(oldUnsubscribe).not.toHaveBeenCalled();
		expect(replacement.stop).toHaveBeenCalledTimes(1);
		expect(oldBridge.prompt).toHaveBeenCalledTimes(1);
		expect(oldBridge.prompt).toHaveBeenCalledWith("intent survives rollback", undefined);
		expect(original.promptQueue.isEmpty).toBe(true);
	});

	it("serializes concurrent assignRole replacements and leaves only the final bridge live", async () => {
		const file = hostTranscript("assign-role-concurrent");
		const firstStart = deferred<void>();
		const secondStart = deferred<void>();
		const firstReplacement = recordingBridge(() => {});
		const secondReplacement = recordingBridge(() => {});
		firstReplacement.start = vi.fn(() => firstStart.promise);
		secondReplacement.start = vi.fn(() => secondStart.promise);
		firstReplacement.stop = vi.fn(async () => {});
		secondReplacement.stop = vi.fn(async () => {});
		firstReplacement.prompt = vi.fn(async () => ({ success: true }));
		secondReplacement.prompt = vi.fn(async () => ({ success: true }));
		const firstUnsubscribe = vi.fn();
		const secondUnsubscribe = vi.fn();
		firstReplacement.onEvent = vi.fn(() => firstUnsubscribe);
		secondReplacement.onEvent = vi.fn(() => secondUnsubscribe);
		const factory = vi.fn()
			.mockReturnValueOnce(firstReplacement)
			.mockReturnValueOnce(secondReplacement);
		registerRpcBridgeFactory(factory);
		const ps = persisted("assign-role-concurrent", file);
		const manager: any = new SessionManager();
		manager._testStore = {
			get: vi.fn(() => ps),
			update: vi.fn(() => {}),
			put: vi.fn(() => {}),
			archive: vi.fn(() => {}),
		};
		managers.push(manager);
		const oldBridge = recordingBridge(() => { throw new Error("old process must not switch"); });
		oldBridge.stop = vi.fn(async () => {});
		oldBridge.prompt = vi.fn(async () => ({ success: true }));
		const oldUnsubscribe = vi.fn();
		manager.sessions.set(ps.id, liveSession(ps.id, oldBridge, { unsubscribe: oldUnsubscribe }));

		const first = manager.assignRole(ps.id, {
			name: "first-role",
			promptTemplate: "First role",
			accessory: "first-accessory",
		});
		const second = manager.assignRole(ps.id, {
			name: "second-role",
			promptTemplate: "Second role",
			accessory: "second-accessory",
		});
		await vi.waitFor(() => expect(firstReplacement.start).toHaveBeenCalledTimes(1));
		expect(secondReplacement.start).not.toHaveBeenCalled();
		await manager.enqueuePrompt(ps.id, "intent waits for final role");

		firstStart.resolve();
		await vi.waitFor(() => expect(secondReplacement.start).toHaveBeenCalledTimes(1));
		expect(oldBridge.stop).toHaveBeenCalledTimes(1);
		expect(oldUnsubscribe).toHaveBeenCalledTimes(1);
		expect(firstReplacement.prompt).not.toHaveBeenCalled();
		expect(firstReplacement.stop).not.toHaveBeenCalled();

		secondStart.resolve();
		await expect(Promise.all([first, second])).resolves.toEqual([true, true]);

		const canonical = manager.sessions.get(ps.id);
		expect(factory).toHaveBeenCalledTimes(2);
		expect(canonical.rpcClient).toBe(secondReplacement);
		expect(canonical.role).toBe("second-role");
		expect(canonical.accessory).toBe("second-accessory");
		expect(manager._sessionReplacementCoordinators.has(ps.id)).toBe(false);
		expect(firstReplacement.stop).toHaveBeenCalledTimes(1);
		expect(firstUnsubscribe).toHaveBeenCalledTimes(1);
		expect(secondReplacement.stop).not.toHaveBeenCalled();
		expect(secondUnsubscribe).not.toHaveBeenCalled();
		expect(oldBridge.prompt).not.toHaveBeenCalled();
		expect(firstReplacement.prompt).not.toHaveBeenCalled();
		expect(secondReplacement.prompt).toHaveBeenCalledTimes(1);
		expect(secondReplacement.prompt).toHaveBeenCalledWith("intent waits for final role", undefined);
		expect(manager._sessionReplacementCoordinators.has(ps.id)).toBe(false);
	});

	it("serializes assignRole then restart across the old-stop await and commits only the restart bridge", async () => {
		const file = hostTranscript("assign-role-vs-restart");
		const oldStopGate = deferred<void>();
		const roleReplacement = recordingBridge(() => {});
		const restartReplacement = recordingBridge(() => {});
		roleReplacement.start = vi.fn(async () => {});
		restartReplacement.start = vi.fn(async () => {});
		roleReplacement.stop = vi.fn(async () => {});
		restartReplacement.stop = vi.fn(async () => {});
		roleReplacement.prompt = vi.fn(async () => ({ success: true }));
		restartReplacement.prompt = vi.fn(async () => ({ success: true }));
		const roleUnsubscribe = vi.fn();
		const restartUnsubscribe = vi.fn();
		roleReplacement.onEvent = vi.fn(() => roleUnsubscribe);
		restartReplacement.onEvent = vi.fn(() => restartUnsubscribe);
		const factory = vi.fn()
			.mockReturnValueOnce(roleReplacement)
			.mockReturnValueOnce(restartReplacement);
		registerRpcBridgeFactory(factory);
		const ps = persisted("assign-role-vs-restart", file);
		const manager: any = new SessionManager();
		manager._testStore = {
			get: vi.fn(() => ps),
			update: vi.fn((_id: string, updates: Record<string, unknown>) => Object.assign(ps, updates)),
			put: vi.fn(() => {}),
			archive: vi.fn(() => {}),
		};
		managers.push(manager);
		const oldBridge = recordingBridge(() => { throw new Error("old process must not switch"); });
		oldBridge.stop = vi.fn(() => oldStopGate.promise);
		oldBridge.prompt = vi.fn(async () => ({ success: true }));
		manager.sessions.set(ps.id, liveSession(ps.id, oldBridge, { unsubscribe: vi.fn() }));

		const assignment = manager.assignRole(ps.id, {
			name: "race-role",
			promptTemplate: "Race role",
			accessory: "race-accessory",
		});
		await vi.waitFor(() => expect(oldBridge.stop).toHaveBeenCalledTimes(1));
		const restart = manager.restartAgent(ps.id);
		await expect(manager.enqueuePrompt(ps.id, "intent survives role restart race"))
			.resolves.toEqual({ status: "queued" });
		expect(restartReplacement.start).not.toHaveBeenCalled();

		oldStopGate.resolve();
		await expect(Promise.all([assignment, restart])).resolves.toEqual([true, undefined]);

		const canonical = manager.sessions.get(ps.id);
		expect(factory).toHaveBeenCalledTimes(2);
		expect(canonical.rpcClient).toBe(restartReplacement);
		expect(roleReplacement.stop).toHaveBeenCalledTimes(1);
		expect(roleUnsubscribe).toHaveBeenCalledTimes(1);
		expect(restartReplacement.stop).not.toHaveBeenCalled();
		expect(restartUnsubscribe).not.toHaveBeenCalled();
		expect(oldBridge.prompt).not.toHaveBeenCalled();
		expect(roleReplacement.prompt).not.toHaveBeenCalled();
		expect(restartReplacement.prompt).toHaveBeenCalledTimes(1);
		expect(restartReplacement.prompt).toHaveBeenCalledWith("intent survives role restart race", undefined);
		expect(manager._sessionReplacementCoordinators.has(ps.id)).toBe(false);
	});

	it("serializes forceAbort then assignRole and drains only on the final role bridge", async () => {
		const file = hostTranscript("force-abort-vs-role");
		const forceStartGate = deferred<void>();
		const forceReplacement = recordingBridge(() => {});
		const roleReplacement = recordingBridge(() => {});
		forceReplacement.start = vi.fn(() => forceStartGate.promise);
		roleReplacement.start = vi.fn(async () => {});
		forceReplacement.stop = vi.fn(async () => {});
		roleReplacement.stop = vi.fn(async () => {});
		forceReplacement.prompt = vi.fn(async () => ({ success: true }));
		roleReplacement.prompt = vi.fn(async () => ({ success: true }));
		const forceUnsubscribe = vi.fn();
		const roleUnsubscribe = vi.fn();
		forceReplacement.onEvent = vi.fn(() => forceUnsubscribe);
		roleReplacement.onEvent = vi.fn(() => roleUnsubscribe);
		const factory = vi.fn()
			.mockReturnValueOnce(forceReplacement)
			.mockReturnValueOnce(roleReplacement);
		registerRpcBridgeFactory(factory);
		const ps = persisted("force-abort-vs-role", file);
		const manager: any = new SessionManager();
		manager._testStore = {
			get: vi.fn(() => ps),
			update: vi.fn((_id: string, updates: Record<string, unknown>) => Object.assign(ps, updates)),
			put: vi.fn(() => {}),
			archive: vi.fn(() => {}),
		};
		managers.push(manager);
		const oldBridge = recordingBridge(() => { throw new Error("old process must not switch"); });
		oldBridge.abort = vi.fn(() => new Promise(() => {}));
		oldBridge.getState = vi.fn(async () => ({ success: true, data: { sessionFile: file } }));
		oldBridge.stop = vi.fn(async () => {});
		oldBridge.prompt = vi.fn(async () => ({ success: true }));
		manager.sessions.set(ps.id, liveSession(ps.id, oldBridge, {
			status: "streaming",
			streamingStartedAt: Date.now(),
			unsubscribe: vi.fn(),
		}));

		const abort = manager.forceAbort(ps.id, 5);
		await vi.waitFor(() => expect(forceReplacement.start).toHaveBeenCalledTimes(1));
		const assignment = manager.assignRole(ps.id, {
			name: "post-abort-role",
			promptTemplate: "Post-abort role",
			accessory: "post-abort-accessory",
		});
		await expect(manager.enqueuePrompt(ps.id, "intent waits for abort and role"))
			.resolves.toEqual({ status: "queued" });
		expect(roleReplacement.start).not.toHaveBeenCalled();

		forceStartGate.resolve();
		await expect(Promise.all([abort, assignment])).resolves.toEqual([undefined, true]);

		const canonical = manager.sessions.get(ps.id);
		expect(factory).toHaveBeenCalledTimes(2);
		expect(canonical.rpcClient).toBe(roleReplacement);
		expect(forceReplacement.stop).toHaveBeenCalledTimes(1);
		expect(forceUnsubscribe).toHaveBeenCalledTimes(1);
		expect(roleReplacement.stop).not.toHaveBeenCalled();
		expect(roleUnsubscribe).not.toHaveBeenCalled();
		expect(oldBridge.prompt).not.toHaveBeenCalled();
		expect(forceReplacement.prompt).not.toHaveBeenCalled();
		expect(roleReplacement.prompt).toHaveBeenCalledTimes(1);
		expect(roleReplacement.prompt).toHaveBeenCalledWith("intent waits for abort and role", undefined);
		expect(manager._sessionReplacementCoordinators.has(ps.id)).toBe(false);
	});

	it("rejects queued assignRole when a coordinated poison redrive is already streaming", async () => {
		const file = hostTranscript("active-poison-redrive-vs-role");
		const redriveAccepted = deferred<void>();
		const poisonBridge = recordingBridge(() => {});
		poisonBridge.prompt = vi.fn(async () => {
			await redriveAccepted.promise;
			return { success: true };
		});
		poisonBridge.stop = vi.fn(async () => {});
		const factory = vi.fn().mockReturnValueOnce(poisonBridge);
		registerRpcBridgeFactory(factory);
		const ps = persisted("active-poison-redrive-vs-role", file);
		const manager: any = new SessionManager();
		manager._testStore = {
			get: vi.fn(() => ps),
			getLive: vi.fn(() => [ps]),
			update: vi.fn((_id: string, updates: Record<string, unknown>) => Object.assign(ps, updates)),
			put: vi.fn(() => {}),
			archive: vi.fn(() => {}),
		};
		managers.push(manager);
		const oldBridge = recordingBridge(() => {});
		oldBridge.stop = vi.fn(async () => {});
		manager.sessions.set(ps.id, liveSession(ps.id, oldBridge, {
			lastTurnErrored: true,
			lastTurnErrorMessage: ORPHAN_ERROR,
		}));

		const followUp = manager.enqueuePrompt(ps.id, "active redrive intent");
		await vi.waitFor(() => expect(poisonBridge.prompt).toHaveBeenCalledTimes(1));
		expect(manager.sessions.get(ps.id)?.status).toBe("streaming");
		const assignment = manager.assignRole(ps.id, {
			name: "must-not-interrupt-role",
			promptTemplate: "Must not interrupt role",
			accessory: "must-not-interrupt-accessory",
		});

		redriveAccepted.resolve();
		await expect(followUp).resolves.toEqual({ status: "dispatched" });
		await expect(assignment).rejects.toThrow("Cannot assign role while agent is streaming");
		expect(factory).toHaveBeenCalledTimes(1);
		expect(poisonBridge.stop).not.toHaveBeenCalled();
		expect(manager.sessions.get(ps.id)?.rpcClient).toBe(poisonBridge);
		expect(manager.sessions.get(ps.id)?.role).toBeUndefined();
		expect(manager.sessions.get(ps.id)?.status).toBe("streaming");
	});

	it("does not release-drain a rejected poison redrive after assignRole requests a drain", async () => {
		const file = hostTranscript("poison-redrive-rejection-vs-role-drain");
		const oldStopGate = deferred<void>();
		const poisonBridge = recordingBridge(() => {});
		const roleBridge = recordingBridge(() => {});
		poisonBridge.prompt = vi.fn(async () => ({ success: true }));
		roleBridge.prompt = vi.fn(async () => ({ success: false, error: ORPHAN_ERROR }));
		const factory = vi.fn().mockReturnValueOnce(poisonBridge).mockReturnValueOnce(roleBridge);
		registerRpcBridgeFactory(factory);
		const ps = persisted("poison-redrive-rejection-vs-role-drain", file);
		const manager: any = new SessionManager();
		manager._testStore = {
			get: vi.fn(() => ps),
			getLive: vi.fn(() => [ps]),
			update: vi.fn((_id: string, updates: Record<string, unknown>) => Object.assign(ps, updates)),
			put: vi.fn(() => {}),
			archive: vi.fn(() => {}),
		};
		managers.push(manager);
		const oldBridge = recordingBridge(() => {});
		oldBridge.stop = vi.fn(() => oldStopGate.promise);
		manager.sessions.set(ps.id, liveSession(ps.id, oldBridge, {
			lastTurnErrored: true,
			lastTurnErrorMessage: ORPHAN_ERROR,
		}));
		vi.spyOn(console, "warn").mockImplementation(() => {});

		const followUp = manager.enqueuePrompt(ps.id, "recoverable rejected redrive");
		await vi.waitFor(() => expect(oldBridge.stop).toHaveBeenCalledTimes(1));
		const assignment = manager.assignRole(ps.id, {
			name: "redrive-role",
			promptTemplate: "Redrive role",
			accessory: "redrive-accessory",
		});
		oldStopGate.resolve();

		await expect(assignment).resolves.toBe(true);
		await expect(followUp).rejects.toThrow(/unexpected tool_use_id/i);
		const canonical = manager.sessions.get(ps.id);
		expect(factory).toHaveBeenCalledTimes(2);
		expect(poisonBridge.prompt).not.toHaveBeenCalled();
		expect(roleBridge.prompt).toHaveBeenCalledTimes(1);
		expect(canonical?.status).toBe("idle");
		expect(canonical?.lastTurnErrored).toBe(true);
		expect(canonical?.promptQueue.toArray().map((row: any) => row.text))
			.toEqual(["recoverable rejected redrive"]);
		expect(manager._testStore.update).toHaveBeenCalledWith(
			ps.id,
			expect.objectContaining({
				messageQueue: [expect.objectContaining({ text: "recoverable rejected redrive" })],
			}),
		);
		expect(manager._sessionReplacementCoordinators.has(ps.id)).toBe(false);
	});

	it("redrives poisoned follow-up only after a queued assignRole commits", async () => {
		const file = hostTranscript("poison-redrive-vs-role");
		const oldStopGate = deferred<void>();
		const poisonBridge = recordingBridge(() => {});
		const roleBridge = recordingBridge(() => {});
		poisonBridge.prompt = vi.fn(async () => ({ success: true }));
		roleBridge.prompt = vi.fn(async () => ({ success: true }));
		const factory = vi.fn().mockReturnValueOnce(poisonBridge).mockReturnValueOnce(roleBridge);
		registerRpcBridgeFactory(factory);
		const ps = persisted("poison-redrive-vs-role", file);
		const manager: any = new SessionManager();
		manager._testStore = {
			get: vi.fn(() => ps),
			getLive: vi.fn(() => [ps]),
			update: vi.fn((_id: string, updates: Record<string, unknown>) => Object.assign(ps, updates)),
			put: vi.fn(() => {}),
			archive: vi.fn(() => {}),
		};
		managers.push(manager);
		const oldBridge = recordingBridge(() => {});
		oldBridge.stop = vi.fn(() => oldStopGate.promise);
		manager.sessions.set(ps.id, liveSession(ps.id, oldBridge, {
			lastTurnErrored: true,
			lastTurnErrorMessage: ORPHAN_ERROR,
		}));

		const followUp = manager.enqueuePrompt(ps.id, "redrive after role");
		await vi.waitFor(() => expect(oldBridge.stop).toHaveBeenCalledTimes(1));
		const assignment = manager.assignRole(ps.id, {
			name: "redrive-role",
			promptTemplate: "Redrive role",
			accessory: "redrive-accessory",
		});
		oldStopGate.resolve();

		await expect(Promise.all([followUp, assignment])).resolves.toEqual([
			{ status: "dispatched" },
			true,
		]);
		expect(factory).toHaveBeenCalledTimes(2);
		expect(poisonBridge.prompt).not.toHaveBeenCalled();
		expect(roleBridge.prompt).toHaveBeenCalledTimes(1);
		expect(roleBridge.prompt).toHaveBeenCalledWith("redrive after role", undefined);
		expect(manager.sessions.get(ps.id)?.rpcClient).toBe(roleBridge);
	});

	it("redrives poisoned Retry only after a queued restart commits", async () => {
		const file = hostTranscript("poison-redrive-vs-restart");
		const oldStopGate = deferred<void>();
		const poisonBridge = recordingBridge(() => {});
		const restartBridge = recordingBridge(() => {});
		poisonBridge.prompt = vi.fn(async () => ({ success: true }));
		restartBridge.prompt = vi.fn(async () => ({ success: true }));
		const factory = vi.fn().mockReturnValueOnce(poisonBridge).mockReturnValueOnce(restartBridge);
		registerRpcBridgeFactory(factory);
		const ps = persisted("poison-redrive-vs-restart", file);
		const manager: any = new SessionManager();
		manager._testStore = {
			get: vi.fn(() => ps),
			getLive: vi.fn(() => [ps]),
			update: vi.fn((_id: string, updates: Record<string, unknown>) => Object.assign(ps, updates)),
			put: vi.fn(() => {}),
			archive: vi.fn(() => {}),
		};
		managers.push(manager);
		const oldBridge = recordingBridge(() => {});
		oldBridge.stop = vi.fn(() => oldStopGate.promise);
		manager.sessions.set(ps.id, liveSession(ps.id, oldBridge, {
			lastTurnErrored: true,
			lastTurnErrorMessage: ORPHAN_ERROR,
			lastPromptText: "retry me once",
		}));

		const retry = manager.retryLastPrompt(ps.id);
		await vi.waitFor(() => expect(oldBridge.stop).toHaveBeenCalledTimes(1));
		const restart = manager.restartAgent(ps.id);
		oldStopGate.resolve();

		await expect(Promise.all([retry, restart])).resolves.toEqual([undefined, undefined]);
		expect(factory).toHaveBeenCalledTimes(2);
		expect(poisonBridge.prompt).not.toHaveBeenCalled();
		expect(restartBridge.prompt).toHaveBeenCalledTimes(1);
		expect(restartBridge.prompt).toHaveBeenCalledWith("retry me once", undefined);
		expect(manager.sessions.get(ps.id)?.rpcClient).toBe(restartBridge);
	});

	it("lets queued termination win over poisoned redrive without deleting durable intent", async () => {
		const file = hostTranscript("poison-redrive-vs-terminate");
		const oldStopGate = deferred<void>();
		const poisonBridge = recordingBridge(() => {});
		poisonBridge.prompt = vi.fn(async () => ({ success: true }));
		const ps = persisted("poison-redrive-vs-terminate", file);
		const manager = makeManager(ps, poisonBridge);
		const oldBridge = recordingBridge(() => {});
		oldBridge.stop = vi.fn(() => oldStopGate.promise);
		manager.sessions.set(ps.id, liveSession(ps.id, oldBridge, {
			lastTurnErrored: true,
			lastTurnErrorMessage: ORPHAN_ERROR,
		}));

		const followUp = manager.enqueuePrompt(ps.id, "durable but never dispatched");
		await vi.waitFor(() => expect(oldBridge.stop).toHaveBeenCalledTimes(1));
		const termination = manager.terminateSession(ps.id);
		oldStopGate.resolve();

		await expect(followUp).rejects.toThrow("respawn cancelled by terminate");
		await expect(termination).resolves.toBe(true);
		expect(poisonBridge.prompt).not.toHaveBeenCalled();
		expect(manager.sessions.has(ps.id)).toBe(false);
		expect(manager._testStore.archive).toHaveBeenCalledWith(ps.id);
		expect(manager._testStore.update).toHaveBeenCalledWith(
			ps.id,
			expect.objectContaining({
				messageQueue: [expect.objectContaining({ text: "durable but never dispatched" })],
			}),
		);
	});

	it("lets queued Stop cancel poisoned redrive before bridge install", async () => {
		const file = hostTranscript("poison-redrive-vs-stop");
		const oldStopGate = deferred<void>();
		const poisonBridge = recordingBridge(() => {});
		poisonBridge.stop = vi.fn(async () => {});
		poisonBridge.prompt = vi.fn(async () => ({ success: true }));
		const ps = persisted("poison-redrive-vs-stop", file);
		const manager = makeManager(ps, poisonBridge);
		const oldBridge = recordingBridge(() => {});
		oldBridge.stop = vi.fn(() => oldStopGate.promise);
		const original = liveSession(ps.id, oldBridge, {
			lastTurnErrored: true,
			lastTurnErrorMessage: ORPHAN_ERROR,
		});
		manager.sessions.set(ps.id, original);

		const followUp = manager.enqueuePrompt(ps.id, "must remain durable after Stop");
		await vi.waitFor(() => expect(oldBridge.stop).toHaveBeenCalledTimes(1));
		const stop = manager.forceAbort(ps.id, 5);
		oldStopGate.resolve();

		await expect(followUp).rejects.toThrow("respawn cancelled by stop");
		await expect(stop).resolves.toBeUndefined();
		expect(poisonBridge.prompt).not.toHaveBeenCalled();
		expect(poisonBridge.stop).toHaveBeenCalledTimes(1);
		expect(manager.sessions.get(ps.id)).toBe(original);
		expect(original.promptQueue.toArray().map((row: any) => row.text))
			.toEqual(["must remain durable after Stop"]);
		expect(original.status).toBe("terminated");
	});

	it("keeps Stop sticky across poison recovery and cancels a queued role install", async () => {
		const file = hostTranscript("poison-role-stop-sticky");
		const oldStopGate = deferred<void>();
		const poisonBridge = recordingBridge(() => {});
		poisonBridge.stop = vi.fn(async () => {});
		poisonBridge.prompt = vi.fn(async () => ({ success: true }));
		const factory = vi.fn(() => poisonBridge);
		registerRpcBridgeFactory(factory);
		const ps = persisted("poison-role-stop-sticky", file);
		const manager: any = new SessionManager();
		manager._testStore = {
			get: vi.fn(() => ps),
			getLive: vi.fn(() => [ps]),
			update: vi.fn((_id: string, patch: Record<string, unknown>) => Object.assign(ps, patch)),
			put: vi.fn(() => {}),
			archive: vi.fn(() => {}),
		};
		managers.push(manager);
		const oldBridge = recordingBridge(() => {});
		oldBridge.stop = vi.fn(() => oldStopGate.promise);
		const original = liveSession(ps.id, oldBridge, {
			lastTurnErrored: true,
			lastTurnErrorMessage: ORPHAN_ERROR,
		});
		manager.sessions.set(ps.id, original);
		const stagedRole = vi.spyOn(manager, "_assignRoleStaged");

		const followUp = manager.enqueuePrompt(ps.id, "intent remains after sticky Stop");
		await vi.waitFor(() => expect(oldBridge.stop).toHaveBeenCalledTimes(1));
		const assignment = manager.assignRole(ps.id, {
			name: "must-not-install",
			promptTemplate: "Must not install",
			accessory: "none",
		});
		const stop = manager.forceAbort(ps.id, 5);
		oldStopGate.resolve();

		await expect(followUp).rejects.toThrow("respawn cancelled by stop");
		await expect(assignment).resolves.toBe(false);
		await expect(stop).resolves.toBeUndefined();
		expect(stagedRole).not.toHaveBeenCalled();
		expect(factory).toHaveBeenCalledTimes(1);
		expect(poisonBridge.stop).toHaveBeenCalledTimes(1);
		expect(poisonBridge.prompt).not.toHaveBeenCalled();
		expect(manager.sessions.get(ps.id)).toBe(original);
		expect(original.status).toBe("terminated");
		expect(original.promptQueue.toArray().map((row: any) => row.text))
			.toEqual(["intent remains after sticky Stop"]);
		expect(manager._sessionReplacementCoordinators.has(ps.id)).toBe(false);
	});

	it("cancels an active staged role on Stop and restores the untouched canonical bridge", async () => {
		const file = hostTranscript("assign-role-noop-abort-generation");
		const startGate = deferred<void>();
		const replacement = recordingBridge(() => {});
		replacement.start = vi.fn(() => startGate.promise);
		replacement.stop = vi.fn(async () => {});
		replacement.prompt = vi.fn(async () => ({ success: true }));
		const ps = persisted("assign-role-noop-abort-generation", file);
		const manager = makeManager(ps, replacement);
		const oldBridge = recordingBridge(() => { throw new Error("old process must not switch"); });
		oldBridge.stop = vi.fn(async () => {});
		const original = liveSession(ps.id, oldBridge, { unsubscribe: vi.fn() });
		manager.sessions.set(ps.id, original);

		const assignment = manager.assignRole(ps.id, {
			name: "replacement-role",
			promptTemplate: "Replacement role",
			accessory: "replacement-accessory",
		});
		await vi.waitFor(() => expect(replacement.start).toHaveBeenCalledTimes(1));
		await manager.enqueuePrompt(ps.id, "intent survives queued no-op Stop");
		const abort = manager.forceAbort(ps.id, 5);

		startGate.resolve();
		await expect(assignment).rejects.toThrow("superseded before old bridge stop");
		await expect(abort).resolves.toBeUndefined();

		const canonical = manager.sessions.get(ps.id);
		expect(canonical.lifecycleGeneration).toBe(manager._currentRespawnGeneration(ps.id));
		expect(canonical.lifecycleFenced).not.toBe(true);
		expect(canonical.rpcClient).toBe(oldBridge);
		expect(canonical.status).toBe("idle");
		expect(replacement.stop).toHaveBeenCalledTimes(1);
		expect(replacement.prompt).not.toHaveBeenCalled();
		expect(canonical.promptQueue.toArray().map((row: any) => row.text))
			.toEqual(["intent survives queued no-op Stop"]);
	});

	it("preserves prompt acceptance order before and after replacement installation", async () => {
		const file = hostTranscript("respawn-install-prompt-order");
		const startGate = deferred<void>();
		const bgRestoreGate = deferred<void>();
		const replacement = recordingBridge(() => {});
		replacement.start = vi.fn(() => startGate.promise);
		replacement.prompt = vi.fn(async () => ({ success: true }));
		const ps = persisted("respawn-install-prompt-order", file);
		const manager = makeManager(ps, replacement);
		manager.bgProcessManager = { restoreSession: vi.fn(() => bgRestoreGate.promise) };
		const oldBridge = recordingBridge(() => { throw new Error("old process must not switch"); });
		oldBridge.stop = vi.fn(async () => {});
		manager.sessions.set(ps.id, liveSession(ps.id, oldBridge, { unsubscribe: vi.fn() }));

		const restart = manager.restartAgent(ps.id);
		await vi.waitFor(() => expect(replacement.start).toHaveBeenCalledTimes(1));
		expect(manager.sessions.has(ps.id)).toBe(false);
		await manager.enqueuePrompt(ps.id, "accepted before install");

		startGate.resolve();
		await vi.waitFor(() => expect(manager.bgProcessManager.restoreSession).toHaveBeenCalledTimes(1));
		expect(manager.sessions.get(ps.id)?.rpcClient).toBe(replacement);
		await manager.enqueuePrompt(ps.id, "accepted after install");
		expect(replacement.prompt).not.toHaveBeenCalled();

		bgRestoreGate.resolve();
		await restart;

		expect(replacement.prompt).toHaveBeenCalledTimes(1);
		expect(replacement.prompt).toHaveBeenCalledWith("accepted before install", undefined);
		expect(manager.sessions.get(ps.id)?.promptQueue.toArray().map((row: any) => row.text))
			.toEqual(["accepted after install"]);
	});

	it("serializes termination requested while an in-place respawn is absent from the session map", async () => {
		const file = hostTranscript("respawn-map-gap-termination");
		const startGate = deferred<void>();
		const replacement = recordingBridge(() => {});
		replacement.start = vi.fn(() => startGate.promise);
		replacement.stop = vi.fn(async () => {});
		const ps = persisted("respawn-map-gap-termination", file);
		const manager = makeManager(ps, replacement);
		const oldBridge = recordingBridge(() => { throw new Error("old process must not switch"); });
		oldBridge.stop = vi.fn(async () => {});
		manager.sessions.set(ps.id, liveSession(ps.id, oldBridge, { unsubscribe: vi.fn() }));

		const restart = manager.restartAgent(ps.id);
		await vi.waitFor(() => expect(replacement.start).toHaveBeenCalledTimes(1));
		expect(manager.sessions.has(ps.id)).toBe(false);
		const termination = manager.terminateSession(ps.id);

		startGate.resolve();
		await expect(restart).rejects.toThrow("respawn cancelled by terminate");
		await expect(termination).resolves.toBe(true);

		expect(manager.sessions.has(ps.id)).toBe(false);
		expect(replacement.stop).toHaveBeenCalledTimes(1);
		expect(manager._testStore.archive).toHaveBeenCalledWith(ps.id);
		expect(manager._sessionReplacementCoordinators.has(ps.id)).toBe(false);
	});

	it("joins assignRole through an in-place respawn session-map gap", async () => {
		const file = hostTranscript("respawn-map-gap-assign-role");
		const restartStart = deferred<void>();
		const restartBridge = recordingBridge(() => {});
		const roleBridge = recordingBridge(() => {});
		restartBridge.start = vi.fn(() => restartStart.promise);
		restartBridge.stop = vi.fn(async () => {});
		roleBridge.stop = vi.fn(async () => {});
		const factory = vi.fn()
			.mockReturnValueOnce(restartBridge)
			.mockReturnValueOnce(roleBridge);
		registerRpcBridgeFactory(factory);
		const ps = persisted("respawn-map-gap-assign-role", file);
		const manager: any = new SessionManager();
		manager._testStore = {
			get: vi.fn(() => ps),
			getLive: vi.fn(() => [ps]),
			update: vi.fn((_id: string, updates: Record<string, unknown>) => Object.assign(ps, updates)),
			put: vi.fn(() => {}),
			archive: vi.fn(() => {}),
		};
		managers.push(manager);
		const oldBridge = recordingBridge(() => { throw new Error("old process must not switch"); });
		oldBridge.stop = vi.fn(async () => {});
		manager.sessions.set(ps.id, liveSession(ps.id, oldBridge, { unsubscribe: vi.fn() }));

		const restart = manager.restartAgent(ps.id);
		await vi.waitFor(() => expect(restartBridge.start).toHaveBeenCalledTimes(1));
		expect(manager.sessions.has(ps.id)).toBe(false);
		const assignment = manager.assignRole(ps.id, {
			name: "map-gap-role",
			promptTemplate: "Map gap role",
			accessory: "map-gap-accessory",
		});

		restartStart.resolve();
		await expect(Promise.all([restart, assignment])).resolves.toEqual([undefined, true]);
		expect(factory).toHaveBeenCalledTimes(2);
		expect(manager.sessions.get(ps.id)?.rpcClient).toBe(roleBridge);
		expect(manager.sessions.get(ps.id)?.role).toBe("map-gap-role");
		expect(restartBridge.stop).toHaveBeenCalledTimes(1);
		expect(roleBridge.stop).not.toHaveBeenCalled();
		expect(manager._sessionReplacementCoordinators.has(ps.id)).toBe(false);
	});

	it.each([
		{ realm: "host", sandboxed: false },
		{ realm: "sandbox", sandboxed: true },
	])("serializes Stop through the $realm respawn map gap and cancels install", async ({ realm, sandboxed }) => {
		const file = hostTranscript(`respawn-map-gap-stop-${realm}`);
		const startGate = deferred<void>();
		const replacement = recordingBridge(() => {});
		replacement.start = vi.fn(() => startGate.promise);
		replacement.stop = vi.fn(async () => {});
		replacement.prompt = vi.fn(async () => ({ success: true }));
		const ps = persisted(`respawn-map-gap-stop-${realm}`, file, { sandboxed });
		const manager = makeManager(ps, replacement);
		manager.applySandboxWiring = vi.fn(async () => true);
		const oldBridge = recordingBridge(() => {});
		oldBridge.stop = vi.fn(async () => {});
		const original = liveSession(ps.id, oldBridge, {
			sandboxed,
			unsubscribe: vi.fn(),
		});
		manager.sessions.set(ps.id, original);

		const restart = manager.restartAgent(ps.id);
		await vi.waitFor(() => expect(replacement.start).toHaveBeenCalledTimes(1));
		expect(manager.sessions.has(ps.id)).toBe(false);
		const stop = manager.forceAbort(ps.id, 5);
		startGate.resolve();

		await expect(restart).rejects.toThrow("respawn cancelled by stop");
		await expect(stop).resolves.toBeUndefined();
		expect(replacement.stop).toHaveBeenCalledTimes(1);
		expect(replacement.prompt).not.toHaveBeenCalled();
		expect(manager.sessions.get(ps.id)).toBe(original);
		expect(original.status).toBe("terminated");
		expect(manager._sessionReplacementCoordinators.has(ps.id)).toBe(false);
		if (sandboxed) expect(manager.applySandboxWiring).toHaveBeenCalled();
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

	it("suppresses hard force-abort switch replay from live events, resume buffer, and activity", async () => {
		const file = hostTranscript("force-abort-replay-suppression");
		let listener: ((event: any) => void) | undefined;
		const replacement = recordingBridge(() => {});
		replacement.onEvent = vi.fn((next: (event: any) => void) => {
			listener = next;
			return () => { listener = undefined; };
		});
		replacement.sendCommand = vi.fn(async (command: any) => {
			if (command?.type === "switch_session") {
				listener?.({
					type: "message_end",
					message: { id: "historical-assistant", role: "assistant", content: [{ type: "text", text: "restored history" }] },
				});
				listener?.({ type: "agent_end", messages: [] });
			}
			return { success: true };
		});
		const ps = persisted("force-abort-replay-suppression", file, { lastActivity: 123_456 });
		const manager = makeManager(ps, replacement);
		const oldBridge = recordingBridge(() => { throw new Error("old process must not switch"); });
		oldBridge.getState = async () => ({ success: true, data: { sessionFile: file } });
		oldBridge.abort = async () => new Promise(() => {});
		const original = liveSession(ps.id, oldBridge, {
			status: "streaming",
			streamingStartedAt: Date.now(),
			lastActivity: ps.lastActivity,
		});
		const client = { readyState: 1, bufferedAmount: 0, send: vi.fn() };
		original.clients.add(client);
		original.eventBuffer.push({ type: "preexisting-live-event" });
		manager.sessions.set(ps.id, original);

		await manager.forceAbort(ps.id, 5);

		// The synthetic live agent_end emitted by hard abort is retained/broadcast;
		// the two switch_session replay frames receive no new live sequence identity.
		expect(original.eventBuffer.getAll().map((entry: any) => entry.event.type))
			.toEqual(["preexisting-live-event", "agent_end"]);
		const emittedEventTypes = client.send.mock.calls
			.map((call: any[]) => JSON.parse(call[0]))
			.filter((frame: any) => frame.type === "event")
			.map((frame: any) => frame.data.type);
		expect(emittedEventTypes).toEqual(["agent_end"]);
		expect(original.lastActivity).toBe(123_456);
		expect(manager._testStore.update.mock.calls.some(([, patch]: any[]) => "lastActivity" in patch)).toBe(false);
		expect(replacement.sendCommand).toHaveBeenCalledWith(
			{ type: "switch_session", sessionPath: file },
			15_000,
		);
		expect(manager.sessions.get(ps.id)?.rpcClient).toBe(replacement);
		assertOrphanRewritten(fs.readFileSync(file, "utf8"));
	});

	it("fails closed when hard force-abort cannot read declared durable history", async () => {
		const file = hostTranscript("force-abort-missing-history");
		fs.rmSync(file, { force: true });
		const switches: string[] = [];
		const replacement = recordingBridge((sessionPath) => switches.push(sessionPath));
		replacement.stop = vi.fn(async () => {});
		replacement.prompt = vi.fn(async () => ({ success: true }));
		const ps = persisted("force-abort-missing-history", file);
		const manager = makeManager(ps, replacement);
		const oldBridge = recordingBridge(() => { throw new Error("old process must not switch"); });
		oldBridge.getState = vi.fn(async () => ({ success: true, data: { sessionFile: file } }));
		oldBridge.abort = vi.fn(() => new Promise(() => {}));
		oldBridge.stop = vi.fn(async () => {});
		const original = liveSession(ps.id, oldBridge, {
			status: "streaming",
			streamingStartedAt: Date.now(),
		});
		original.promptQueue.enqueue("must remain parked with missing history");
		manager.sessions.set(ps.id, original);
		vi.spyOn(console, "error").mockImplementation(() => {});

		await manager.forceAbort(ps.id, 5);

		expect(switches).toEqual([]);
		expect(replacement.stop).toHaveBeenCalledTimes(1);
		expect(replacement.prompt).not.toHaveBeenCalled();
		expect(manager.sessions.get(ps.id)).toBe(original);
		expect(original.rpcClient).toBe(oldBridge);
		expect(original.status).toBe("terminated");
		expect(original.promptQueue.toArray().map((row: any) => row.text))
			.toEqual(["must remain parked with missing history"]);
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
		const expectedAfterFailure = firstAction === "follow-up"
			? ["parked queue intent", "preserved failed follow-up"]
			: ["original user intent", "parked queue intent"];
		const expectedAfterSuccess = firstAction === "follow-up"
			? expectedAfterFailure
			: ["parked queue intent"];
		expect(rollback.promptQueue.toArray().map((message: any) => message.text)).toEqual(expectedAfterFailure);
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
		expect(restored.promptQueue.toArray().map((message: any) => message.text)).toEqual(expectedAfterSuccess);
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
		expect(rollback.promptQueue.toArray().map((message: any) => message.text)).toEqual([
			"original sandbox retry intent",
			"parked sandbox intent",
		]);
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
		// Releasing the role-assignment fence redrains any intent that was already
		// durable on the rollback session. This fixture stubs drainQueue so the row
		// remains available for the assertions below.
		expect(manager.drainQueue).toHaveBeenCalledTimes(1);
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
