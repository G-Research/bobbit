// v2-native — Official Claude Agent SDK session-access/history adapter contract.
import { describe, expect, it, vi } from "vitest";

import {
	claudeAgentSdkDirectConfigDir,
	readSdkSessionInfo,
	readSdkSessionMessages,
	readSdkSubagentMessages,
	readSdkSubagents,
	type ClaudeAgentSdkSessionApi,
	type SdkSessionMessage,
} from "../../src/server/agent/claude-agent-sdk-session-access.ts";
import { adaptSdkSessionMessages } from "../../src/server/agent/claude-agent-sdk-history-adapter.ts";
import { ClaudeAgentSdkUnavailableError } from "../../src/server/agent/claude-agent-sdk-bridge.ts";
import { claudeAgentSdkUnavailableDiagnostic } from "../../src/server/agent/claude-agent-sdk-error.ts";

const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";
const CWD = "/workspace/project";

function sdkFixture(overrides: Partial<ClaudeAgentSdkSessionApi> = {}) {
	const sdk: ClaudeAgentSdkSessionApi = {
		getSessionInfo: vi.fn(async () => ({ sessionId: SESSION_ID, summary: "test", lastModified: 1 })),
		getSessionMessages: vi.fn(async () => []),
		listSubagents: vi.fn(async () => []),
		getSubagentMessages: vi.fn(async () => []),
		...overrides,
	};
	return { sdk, deps: { loadSdk: vi.fn(async () => sdk) } };
}

describe("Claude Agent SDK session access", () => {
	it("derives direct config only from a validated Bobbit session UUID", () => {
		const stateDir = "/isolated/bobbit-state";
		const previousHome = process.env.HOME;
		const previousConfig = process.env.CLAUDE_CONFIG_DIR;
		try {
			process.env.HOME = "/hostile/home";
			process.env.CLAUDE_CONFIG_DIR = "/hostile/config";
			expect(claudeAgentSdkDirectConfigDir(SESSION_ID, stateDir)).toBe(`/isolated/bobbit-state/claude-agent-sdk/${SESSION_ID}`);
			expect(() => claudeAgentSdkDirectConfigDir("not-a-uuid", stateDir)).toThrow(/SDK_SESSION_UNAVAILABLE/);
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = previousConfig;
		}
	});

	it("uses only the official API with the persisted cwd and accepts confirmed empty history", async () => {
		const fixture = sdkFixture();

		await expect(readSdkSessionInfo({ sessionId: SESSION_ID, cwd: CWD }, fixture.deps)).resolves.toMatchObject({ sessionId: SESSION_ID });
		await expect(readSdkSessionMessages({ sessionId: SESSION_ID, cwd: CWD }, fixture.deps)).resolves.toEqual([]);

		expect(fixture.deps.loadSdk).toHaveBeenCalledTimes(2);
		expect(fixture.sdk.getSessionInfo).toHaveBeenNthCalledWith(1, SESSION_ID, { dir: CWD });
		expect(fixture.sdk.getSessionInfo).toHaveBeenNthCalledWith(2, SESSION_ID, { dir: CWD });
		expect(fixture.sdk.getSessionMessages).toHaveBeenCalledWith(SESSION_ID, { dir: CWD });
	});

	it("uses the injected private direct config accessor instead of the gateway SDK environment", async () => {
		const direct = sdkFixture();
		const fallback = sdkFixture();
		await expect(readSdkSessionMessages({ sessionId: SESSION_ID, cwd: CWD }, {
			loadSdk: fallback.deps.loadSdk,
			directSdk: direct.sdk,
		})).resolves.toEqual([]);
		expect(direct.sdk.getSessionInfo).toHaveBeenCalledWith(SESSION_ID, { dir: CWD });
		expect(fallback.deps.loadSdk).not.toHaveBeenCalled();
	});

	it("reads pinned child APIs without inferring parent identity from agent ids", async () => {
		const fixture = sdkFixture({ listSubagents: vi.fn(async () => ["child-1"]), getSubagentMessages: vi.fn(async () => []) });

		await expect(readSdkSubagents({ sessionId: SESSION_ID, cwd: CWD }, fixture.deps)).resolves.toEqual(["child-1"]);
		await expect(readSdkSubagentMessages({ sessionId: SESSION_ID, cwd: CWD, agentId: "child-1" }, fixture.deps)).resolves.toEqual([]);
		await expect(readSdkSubagentMessages({ sessionId: SESSION_ID, cwd: CWD, agentId: "child-1", limit: 17 }, fixture.deps)).resolves.toEqual([]);
		expect(fixture.sdk.listSubagents).toHaveBeenCalledWith(SESSION_ID, { dir: CWD });
		expect(fixture.sdk.getSubagentMessages).toHaveBeenNthCalledWith(1, SESSION_ID, "child-1", { dir: CWD });
		expect(fixture.sdk.getSubagentMessages).toHaveBeenNthCalledWith(2, SESSION_ID, "child-1", { dir: CWD, limit: 17 });
		await expect(readSdkSubagentMessages({ sessionId: SESSION_ID, cwd: CWD, agentId: "" }, fixture.deps)).rejects.toMatchObject({
			code: "SDK_SESSION_UNAVAILABLE",
		});
		await expect(readSdkSubagents({ sessionId: SESSION_ID, cwd: CWD }, sdkFixture({ listSubagents: vi.fn(async () => ["", 3] as any) }).deps)).rejects.toMatchObject({
			message: expect.stringContaining("SDK_SESSION_UNAVAILABLE"),
		});
	});

	it("fails absent, invalid, loader, and provider sources as sanitized unavailable errors", async () => {
		const absent = sdkFixture({ getSessionInfo: vi.fn(async () => undefined) });
		await expect(readSdkSessionMessages({ sessionId: SESSION_ID, cwd: CWD }, absent.deps)).rejects.toMatchObject({
			code: "SDK_SESSION_UNAVAILABLE",
			message: "SDK_SESSION_UNAVAILABLE",
		});
		expect(absent.sdk.getSessionMessages).not.toHaveBeenCalled();

		const providerFailure = "provider Authorization: Bearer sk-private-value abcdefgh.abcdefgh.ijklmnop /Users/aj/.claude.json opaque_12345678901234567890123456789012 unavailable";
		const broken = { loadSdk: vi.fn(async () => { throw new Error(providerFailure); }) };
		const failure = await readSdkSessionInfo({ sessionId: SESSION_ID, cwd: CWD }, broken).catch(error => error);
		expect(failure).toMatchObject({ code: "SDK_SESSION_UNAVAILABLE", message: "SDK_SESSION_UNAVAILABLE" });
		const diagnostic = claudeAgentSdkUnavailableDiagnostic(failure);
		for (const secret of ["sk-private-value", "abcdefgh.abcdefgh.ijklmnop", "/Users/aj/.claude.json", "opaque_12345678901234567890123456789012"]) {
			expect(diagnostic).not.toContain(secret);
			expect(JSON.stringify(failure)).not.toContain(secret);
		}
		await expect(readSdkSessionInfo({ sessionId: "not-a-uuid", cwd: CWD }, sdkFixture().deps)).rejects.toBeInstanceOf(ClaudeAgentSdkUnavailableError);
	});

	it("adapts official history in order with SDK UUIDs, parent relationships, and existing SDK content normalization", () => {
		const history: SdkSessionMessage[] = [
			{
				type: "user", uuid: "user-1", session_id: SESSION_ID, parent_tool_use_id: null, parent_agent_id: null,
				message: { role: "user", content: "Inspect the project", timestamp: "2025-01-02T03:04:05.000Z" },
			},
			{
				type: "assistant", uuid: "assistant-1", session_id: SESSION_ID, parent_tool_use_id: null, parent_agent_id: null,
				message: { model: "claude-test", content: [
					{ type: "thinking", thinking: "I should inspect it", signature: "opaque" },
					{ type: "tool_use", id: "tool-1", name: "Read", input: { path: "src" } },
				], stop_reason: "tool_use", timestamp: "2025-01-02T03:04:06.000Z" },
			},
			{
				type: "user", uuid: "tool-result-1", session_id: SESSION_ID, parent_tool_use_id: null, parent_agent_id: null,
				message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "found it" }] },
			},
			{
				type: "assistant", uuid: "assistant-child", session_id: SESSION_ID, parent_tool_use_id: "agent-tool-1", parent_agent_id: "agent-1",
				message: { model: "claude-test", content: [{ type: "text", text: "Child result" }], stop_reason: "end_turn" },
			},
		];

		const snapshot = adaptSdkSessionMessages(history);
		expect(snapshot.map(message => message.id)).toEqual(["user-1", "assistant-1", "tool-result-1", "assistant-child"]);
		expect(snapshot.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		expect(snapshot[0]).toMatchObject({ content: "Inspect the project", timestamp: Date.parse("2025-01-02T03:04:05.000Z") });
		expect(snapshot[1]).toMatchObject({
			content: expect.arrayContaining([
				expect.objectContaining({ type: "thinking", thinkingSignature: "opaque" }),
				expect.objectContaining({ type: "toolCall", id: "tool-1", name: "Read", arguments: { path: "src" } }),
			]),
		});
		expect(snapshot[2]).toMatchObject({ toolCallId: "tool-1", toolName: "Read", content: [{ type: "text", text: "found it" }] });
		expect(snapshot[3]).toMatchObject({ parentToolUseId: "agent-tool-1", parentAgentId: "agent-1", content: [{ type: "text", text: "Child result" }] });
	});
});
