// v2-native — durable runtime selection and SDK resume metadata coverage.
import { afterEach, describe, expect, it } from "vitest";
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

const roots: string[] = [];
function root(): string {
	const value = fs.mkdtempSync(path.join(os.tmpdir(), "claude-sdk-runtime-"));
	roots.push(value);
	return value;
}
afterEach(() => {
	for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

function persistedSdkSession(id: string, opaqueId = "sdk-opaque-session-id"): PersistedSession {
	const now = Date.now();
	return {
		id,
		title: "SDK session",
		cwd: "/workspace/project",
		agentSessionFile: "/workspace/project/transcript.jsonl",
		createdAt: now,
		lastActivity: now,
		runtime: "claude-agent-sdk",
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
		expect(resolveSessionRuntime({ persistedRuntime: "claude-agent-sdk" })).toBe("claude-agent-sdk");
		expect(resolveSessionRuntime({})).toBe("pi");

		const pi = createSessionBridge({ runtime: "pi", cwd: "/workspace/project" });
		expect(pi).toBeInstanceOf(RpcBridge);
	});

	it("round-trips SDK runtime, opaque resume id, and verified model tuple through SessionStore", async () => {
		const stateDir = path.join(root(), "state");
		const store = new SessionStore(stateDir);
		store.put(persistedSdkSession("sdk-session"));
		await store.flushAsync();

		const reloaded = new SessionStore(stateDir);
		const record = reloaded.get("sdk-session");
		expect(record).toMatchObject({
			runtime: "claude-agent-sdk",
			claudeAgentSdkSessionId: "sdk-opaque-session-id",
			modelProvider: "claude-agent-sdk",
			modelId: "sonnet-test",
			effectiveThinkingLevel: "high",
		});
	});

});
