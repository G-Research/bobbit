// v2-native — integration coverage for the three independent Claude SDK permission ceilings.
import { describe, expect, it } from "vitest";

import { buildClaudeSdkToolSurface } from "../../src/server/agent/claude-agent-sdk-tool-surface.ts";

type Grant = { granted: boolean; tools?: string[]; group?: string; mode?: "one-time" | "session-only" | "persistent"; reason?: string };

function fixture(grant: (name: string, group: string, options?: { signal: AbortSignal; toolUseId?: string }) => Promise<Grant> = async () => ({ granted: false })) {
	const dispatched: Array<{ name: string; args: unknown }> = [];
	const surface = buildClaudeSdkToolSurface({
		sessionId: "sdk-permission-session",
		restriction: "unrestricted",
		entries: [
			{ name: "read", group: "Files", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } }, policy: "allow", invoke: async args => { dispatched.push({ name: "read", args }); return { content: [{ type: "text", text: "ok" }] }; } },
			{ name: "ask_user_choices", group: "Ask", description: "Ask the user", inputSchema: { type: "object", properties: { questions: { type: "array" } } }, policy: "ask", invoke: async () => "ok" },
			{ name: "ask_other", group: "Ask", description: "Another ask", inputSchema: { type: "object", properties: {} }, policy: "ask", invoke: async () => "ok" },
			{ name: "bash", group: "Shell", description: "Run a command", inputSchema: { type: "object", properties: { command: { type: "string" } } }, policy: "never", invoke: async () => "never" },
		],
		requestToolGrant: (name, group, options) => grant(name, group, options),
	});
	return { surface, dispatched };
}

function canUse(surface: ReturnType<typeof fixture>["surface"], name: string, overrides: Record<string, unknown> = {}) {
	return (surface.canUseTool as any)(name, {}, { signal: new AbortController().signal, toolUseID: "tool-use-1", ...overrides });
}

function preUse(surface: ReturnType<typeof fixture>["surface"], name: string, toolUseId = "tool-use-1") {
	return (surface.preToolUseMatcher as any)[0].hooks[0]({ tool_name: name, tool_use_id: toolUseId });
}

describe("Claude SDK Bobbit tool permission integration", () => {
	it("applies registration, canUseTool, and PreToolUse ceilings independently", async () => {
		const { surface } = fixture();
		expect(surface.sdkAllowNames).toEqual(["mcp__bobbit__read"]);
		expect(surface.entriesByCanonicalLower.has("bash")).toBe(true);
		for (const name of ["mcp__bobbit__bash", "Bash", "mcp__foreign__read", "mcp__bobbit__", "mcp__bobbit__missing"]) {
			await expect(canUse(surface, name)).resolves.toMatchObject({ behavior: "deny" });
			expect((await preUse(surface, name)).hookSpecificOutput.permissionDecision).toBe("deny");
		}
		await expect(canUse(surface, "mcp__bobbit__read")).resolves.toMatchObject({ behavior: "allow" });
		expect((await preUse(surface, "mcp__bobbit__read")).hookSpecificOutput.permissionDecision).toBe("allow");
	});

	it("requires a current exact grant and never caches one-time approval", async () => {
		let calls = 0;
		const { surface } = fixture(async () => { calls++; return { granted: true, tools: ["ask_user_choices"], group: "Ask", mode: "one-time" }; });
		await expect(canUse(surface, "mcp__bobbit__ask_user_choices", { toolUseID: "one" })).resolves.toMatchObject({ behavior: "allow" });
		expect((await preUse(surface, "mcp__bobbit__ask_user_choices", "one")).hookSpecificOutput.permissionDecision).toBe("allow");
		await expect(canUse(surface, "mcp__bobbit__ask_user_choices", { toolUseID: "two" })).resolves.toMatchObject({ behavior: "allow" });
		expect(calls).toBe(2);
		expect((await preUse(surface, "mcp__bobbit__ask_user_choices", "bypass")).hookSpecificOutput.permissionDecision).toBe("deny");
	});

	it("binds approvals to their canonical tool and denies subagent hook calls", async () => {
		const { surface } = fixture(async () => ({ granted: true, tools: ["ask_user_choices"], group: "Ask", mode: "one-time" }));
		await canUse(surface, "mcp__bobbit__ask_user_choices", { toolUseID: "shared" });
		// A malicious same tool-use id cannot replay an ask approval for another tool.
		expect((await preUse(surface, "mcp__bobbit__ask_other", "shared")).hookSpecificOutput.permissionDecision).toBe("ask");
		expect((await preUse(surface, "mcp__bobbit__ask_user_choices", "shared")).hookSpecificOutput.permissionDecision).toBe("allow");
		expect((await (surface.preToolUseMatcher as any)[0].hooks[0]({ tool_name: "mcp__bobbit__read", tool_use_id: "native", agent_id: "child" })).hookSpecificOutput.permissionDecision).toBe("deny");
	});

	it("passes cancellation to the grant seam and denies the abandoned request", async () => {
		let captured: AbortSignal | undefined;
		const { surface } = fixture(async (_name, _group, options?: { signal: AbortSignal }) => {
			captured = options?.signal;
			return new Promise(resolve => options?.signal.addEventListener("abort", () => resolve({ granted: false, reason: "cancelled" }), { once: true }));
		});
		const controller = new AbortController();
		const pending = (surface.canUseTool as any)("mcp__bobbit__ask_user_choices", {}, { signal: controller.signal, toolUseID: "cancelled" });
		controller.abort();
		await expect(pending).resolves.toMatchObject({ behavior: "deny" });
		expect(captured?.aborted).toBe(true);
	});

	it("dispatches and renders the canonical Bobbit name", async () => {
		const { surface, dispatched } = fixture();
		await expect(surface.invoke("mcp__bobbit__ReAd", { path: "README.md" })).resolves.toMatchObject({ content: expect.any(Array) });
		expect(dispatched).toEqual([{ name: "read", args: { path: "README.md" } }]);
		expect(surface.renderToolName("mcp__bobbit__ReAd")).toBe("read");
	});
});
