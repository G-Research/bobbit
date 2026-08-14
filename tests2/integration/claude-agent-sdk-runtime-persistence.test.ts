// v2-native — durable runtime selection and SDK resume metadata coverage.
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	createSessionBridge,
	resolveSessionRuntime,
	runtimeFromProvider,
} from "../../src/server/agent/session-runtime.ts";
import { SessionStore, type PersistedSession } from "../../src/server/agent/session-store.ts";
import { RpcBridge } from "../../src/server/agent/rpc-bridge.ts";
import { SessionManager } from "../../src/server/agent/session-manager.ts";
import { CostTracker } from "../../src/server/agent/cost-tracker.ts";

const SDK_SESSION_ID = "00000000-0000-4000-8000-000000000004";

const roots: string[] = [];
function root(): string {
	const value = fs.mkdtempSync(path.join(os.tmpdir(), "claude-sdk-runtime-"));
	roots.push(value);
	return value;
}
afterEach(() => {
	for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

function persistedSdkSession(id: string, opaqueId = SDK_SESSION_ID): PersistedSession {
	const now = Date.now();
	return {
		id,
		title: "SDK session",
		cwd: "/workspace/project",
		agentSessionFile: "/workspace/project/transcript.jsonl",
		createdAt: now,
		lastActivity: now,
		claudeAgentSdkSessionId: opaqueId,
		modelProvider: "claude-agent-sdk",
		modelId: "sonnet-test",
		effectiveThinkingLevel: "high",
	};
}

describe("Claude Agent SDK durable runtime boundary", () => {
	it("derives runtime from the provider tuple before using a legacy persisted fallback", () => {
		expect(runtimeFromProvider("claude-agent-sdk")).toBe("claude-agent-sdk");
		expect(runtimeFromProvider("anthropic")).toBe("pi");
		expect(runtimeFromProvider("anthropic/claude-sonnet-4")).toBe("pi");
		expect(resolveSessionRuntime({ modelProvider: "anthropic", persistedRuntime: "claude-agent-sdk" })).toBe("pi");
		expect(resolveSessionRuntime({ modelProvider: "claude-agent-sdk", persistedRuntime: "pi" })).toBe("claude-agent-sdk");
		expect(resolveSessionRuntime({ initialModel: "anthropic/claude-sonnet-4", persistedRuntime: "claude-agent-sdk" })).toBe("pi");
		expect(resolveSessionRuntime({ initialModel: "claude-agent-sdk", persistedRuntime: "claude-agent-sdk" })).toBe("claude-agent-sdk");
		expect(resolveSessionRuntime({ initialModel: "claude-agent-sdk" })).toBe("pi");
		expect(resolveSessionRuntime({ initialModel: "claude-agent-sdk", modelProvider: "anthropic", persistedRuntime: "claude-agent-sdk" })).toBe("pi");
		expect(resolveSessionRuntime({ persistedRuntime: "claude-agent-sdk" })).toBe("claude-agent-sdk");
		expect(resolveSessionRuntime({})).toBe("pi");

		const pi = createSessionBridge({ runtime: "pi", cwd: "/workspace/project" });
		expect(pi).toBeInstanceOf(RpcBridge);
	});

	it("round-trips SDK runtime, opaque resume id, and verified model tuple through SessionStore", async () => {
		const stateDir = path.join(root(), "state");
		const store = new SessionStore(stateDir);
		store.put({ ...persistedSdkSession("sdk-session"), runtime: "claude-agent-sdk" });
		await store.flushAsync();

		const reloaded = new SessionStore(stateDir);
		const record = reloaded.get("sdk-session");
		expect(record).toMatchObject({
			runtime: "claude-agent-sdk",
			claudeAgentSdkSessionId: SDK_SESSION_ID,
			modelProvider: "claude-agent-sdk",
			modelId: "sonnet-test",
			effectiveThinkingLevel: "high",
		});
	});

	it("reads archived SDK history derived from the provider tuple without touching Pi JSONL", async () => {
		const session = { ...persistedSdkSession("00000000-0000-4000-8000-000000000010"), archived: true, agentSessionFile: "/must-not-read.jsonl" };
		expect(session.runtime).toBeUndefined();
		const calls: Array<[string, string, unknown]> = [];
		const manager: any = Object.create(SessionManager.prototype);
		manager.sessions = new Map();
		manager.projectContextManager = null;
		manager._testStore = { get: vi.fn((id: string) => id === session.id ? session : undefined) };
		manager.claudeAgentSdkBridgeDepsFactory = () => {
			const directSdk = {
				getSessionInfo: async (id: string, options: unknown) => {
					calls.push(["info", id, options]);
					return { sessionId: id, summary: "archived", lastModified: 1 };
				},
				getSessionMessages: async (id: string, options: unknown) => {
					calls.push(["messages", id, options]);
					return [{
						type: "user" as const,
						uuid: "archived-sdk-message",
						session_id: id,
						message: { role: "user", content: "SDK-owned archive" },
						parent_tool_use_id: null,
						parent_agent_id: null,
					}];
				},
				listSubagents: async () => [],
				getSubagentMessages: async () => [],
			};
			return {
				clock: { now: () => 0, setTimeout: () => 0, setInterval: () => 0, clearTimeout: () => {}, clearInterval: () => {} },
				query: vi.fn(),
				sessionAccess: { loadSdk: async () => directSdk, directSdk },
			};
		};

		const messages = await manager.getArchivedMessages(session.id) as any[];
		expect(messages).toEqual([expect.objectContaining({ id: "archived-sdk-message", role: "user", content: "SDK-owned archive" })]);
		expect(calls).toEqual([
			["info", SDK_SESSION_ID, { dir: "/workspace/project" }],
			["messages", SDK_SESSION_ID, { dir: "/workspace/project" }],
		]);
	});

	it("fails closed on invalid Bobbit identity without loading native direct history", async () => {
		const session = persistedSdkSession("not-a-bobbit-uuid");
		let nativeLoads = 0;
		const manager: any = Object.create(SessionManager.prototype);
		manager.claudeAgentSdkBridgeDepsFactory = () => ({
			clock: { now: () => 0, setTimeout: () => 0, setInterval: () => 0, clearTimeout: () => {}, clearInterval: () => {} },
			query: vi.fn(),
			sessionAccess: {
				loadSdk: async () => { nativeLoads++; throw new Error("native SDK must not load"); },
			},
		});
		await expect(manager.readSdkSessionInfo(session)).rejects.toMatchObject({ code: "SDK_SESSION_UNAVAILABLE" });
		expect(nativeLoads).toBe(0);
	});

	it("accounts only a canonical SDK root result once", () => {
		const manager: any = Object.create(SessionManager.prototype);
		const tracker = new CostTracker(path.join(root(), "usage"));
		const session: any = {
			id: "sdk-ledger", runtime: "claude-agent-sdk", clients: new Set(),
			goalId: "goal-1", lifecycleGeneration: 0,
		};
		manager.sessions = new Map([[session.id, session]]);
		manager._sessionRespawnGenerations = new Map();
		manager.resolveCostTracker = () => tracker;
		manager.resolveTaskIdForSession = () => undefined;
		const rootResult = {
			type: "agent_end",
			claudeSdkUsage: {
				sourceResultId: "sdk-uuid/result-uuid", costBasis: "subscription-notional",
				total: { inputTokens: 12, outputTokens: 4, notionalCostUsd: 0.01 },
				modelUsage: { "claude-sonnet": { inputTokens: 12, outputTokens: 4, contextTokens: 16, contextWindow: 200_000 } },
			},
		};
		manager.trackCostFromEvent(session, rootResult);
		manager.trackCostFromEvent(session, rootResult);
		manager.trackCostFromEvent(session, { type: "message_end", message: { role: "assistant", usage: { inputTokens: 999, cost: 999 } } });
		const usage = tracker.getSessionUsage(session.id)!;
		expect(usage.inputTokens).toBe(12);
		expect(usage.totalCost).toBeNull();
		expect(usage.context.highWaterTokens).toBe(16);
	});

	it("keeps queued and in-flight steer rows when an unavailable SDK restore becomes dormant", async () => {
		const session = {
			...persistedSdkSession("sdk-unavailable"),
			projectId: "project-1",
			messageQueue: [{ id: "queued", text: "queued work", isSteered: false, createdAt: 1 }],
			inFlightSteerTexts: [{ text: "redirect", promptId: "steer-1" }],
		};
		const sessionStore = { get: vi.fn() };
		const manager: any = Object.create(SessionManager.prototype);
		manager.sessions = new Map();
		manager.projectContextManager = {
			getOrCreate: vi.fn((projectId: string) => projectId === session.projectId ? { sessionStore } : null),
		};
		manager.claudeAgentSdkBridgeDepsFactory = () => ({
			clock: { now: () => 0, setTimeout: () => 0, setInterval: () => 0, clearTimeout: () => {}, clearInterval: () => {} },
			query: vi.fn(),
		});
		manager._restoreSessionCoalesced = vi.fn(async () => { throw new Error("SDK_SESSION_UNAVAILABLE: session was not found"); });
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await manager.restoreOneSession(session);
		} finally {
			error.mockRestore();
		}
		expect(manager._restoreSessionCoalesced).toHaveBeenCalledWith(session);
		expect(manager.projectContextManager.getOrCreate).toHaveBeenCalledWith(session.projectId);
		const dormant = manager.sessions.get(session.id);
		expect(dormant).toMatchObject({ dormant: true, status: "terminated", restoreError: expect.stringContaining("SDK_SESSION_UNAVAILABLE") });
		expect(dormant.promptQueue.toArray()).toEqual(session.messageQueue);
		expect(dormant.inFlightSteerTexts).toEqual(session.inFlightSteerTexts);
	});

	it("persists only the validated SDK resume identity from bridge state", async () => {
		const manager: any = Object.create(SessionManager.prototype);
		const update = vi.fn();
		manager.sessions = new Map();
		manager.projectContextManager = null;
		manager._testStore = { update };
		const session: any = {
			id: "sdk-valid-metadata",
			rpcClient: { getState: vi.fn(async () => ({ success: true, data: { provider: "claude-agent-sdk", sessionId: SDK_SESSION_ID, sessionFile: "/must-not-use.jsonl" } })) },
		};
		manager.sessions.set(session.id, session);

		await manager.persistSessionMetadata(session);
		expect(update).toHaveBeenCalledTimes(1);
		expect(update).toHaveBeenCalledWith(session.id, {
			runtime: "claude-agent-sdk",
			claudeAgentSdkSessionId: SDK_SESSION_ID,
		});
	});

	it("propagates malformed SDK metadata after one attempt instead of Pi-style retries", async () => {
		const manager: any = Object.create(SessionManager.prototype);
		const update = vi.fn();
		manager.sessions = new Map();
		manager.projectContextManager = null;
		manager._testStore = { update };
		const session: any = {
			id: "sdk-invalid-metadata",
			rpcClient: { getState: vi.fn(async () => ({ success: true, data: { provider: "claude-agent-sdk", sessionId: "not-a-uuid", sessionFile: "/must-not-use.jsonl" } })) },
		};
		manager.sessions.set(session.id, session);

		await expect(manager.persistSessionMetadata(session)).rejects.toMatchObject({
			code: "SDK_SESSION_UNAVAILABLE",
			message: "SDK_SESSION_UNAVAILABLE",
		});
		expect(update).not.toHaveBeenCalled();
		expect(session.rpcClient.getState).toHaveBeenCalledTimes(1);
	});

});
