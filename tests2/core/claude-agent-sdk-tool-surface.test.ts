// v2-native — exact Agent SDK native-surface and isolated-options contract.
import { describe, expect, it } from "vitest";

import {
	CLAUDE_NATIVE_TOOL_FLOOR,
	CLAUDE_NATIVE_TOOL_POLICY,
	ClaudeSdkToolSurfaceError,
	buildClaudeAgentSdkQueryOptions,
	buildClaudeSdkToolSurface,
	normalizeClaudeSdkMcpToolName,
} from "../../src/server/agent/claude-agent-sdk-tool-surface.ts";

const NATIVE_FLOOR_0_3_222 = [
	"Task", "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Skill",
	"NotebookEdit", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ExitWorktree",
	"Monitor", "ScheduleWakeup", "PushNotification", "RemoteTrigger", "CronCreate", "CronDelete", "CronList",
	"TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate", "ToolSearch",
] as const;

const SUPPRESSED_NATIVE_0_3_222 = [
	"Task", "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch",
	"NotebookEdit", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ExitWorktree",
	"Monitor", "ScheduleWakeup", "PushNotification", "RemoteTrigger", "CronCreate", "CronDelete", "CronList",
	"TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate", "ToolSearch",
] as const;

const entries = [
	{ name: "read", description: "Read", group: "Filesystem", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, policy: "allow" as const, invoke: async () => "read" },
	{ name: "ask_tool", description: "Ask", group: "Browser", inputSchema: { type: "object", properties: {} }, policy: "ask" as const, invoke: async () => "ask" },
	{ name: "never_tool", description: "Never", group: "Internal", inputSchema: { type: "object", properties: {} }, policy: "never" as const, invoke: async () => "never" },
];

function build(options: Partial<Parameters<typeof buildClaudeSdkToolSurface>[0]> = {}) {
	return buildClaudeSdkToolSurface({
		sessionId: "sdk-surface-test",
		restriction: "restricted",
		entries,
		requestToolGrant: async () => ({ granted: true, tools: ["ask_tool"], group: "Browser", mode: "one-time" }),
		...options,
	});
}

function permissionContext(overrides: Record<string, unknown> = {}) {
	return { signal: new AbortController().signal, toolUseID: "use-1", ...overrides };
}

describe("Claude Agent SDK tool surface", () => {
	it("pins the complete 0.3.222 native floor, retaining only approved Skill and Agent while denying Task", () => {
		expect(CLAUDE_NATIVE_TOOL_FLOOR).toEqual(NATIVE_FLOOR_0_3_222);
		expect(new Set(CLAUDE_NATIVE_TOOL_FLOOR).size).toBe(30);
		expect(CLAUDE_NATIVE_TOOL_POLICY.retained).toEqual(["Skill", "Agent"]);
		expect(CLAUDE_NATIVE_TOOL_POLICY.suppressed).toEqual(SUPPRESSED_NATIVE_0_3_222);
		expect(CLAUDE_NATIVE_TOOL_POLICY.reserved).toEqual(["Agent"]);
		expect(CLAUDE_NATIVE_TOOL_POLICY.disallowed).toEqual(SUPPRESSED_NATIVE_0_3_222);
		expect(CLAUDE_NATIVE_TOOL_POLICY.disallowed).not.toContain("Skill");
		expect(CLAUDE_NATIVE_TOOL_POLICY.disallowed).not.toContain("Agent");
		expect(CLAUDE_NATIVE_TOOL_POLICY.disallowed).toContain("Task");
		expect(CLAUDE_NATIVE_TOOL_POLICY.disallowed).toContain("ToolSearch");
	});

	it("normalizes only reversible Bobbit MCP names and retains canonical spelling for dispatch", () => {
		const surface = build();
		expect(normalizeClaudeSdkMcpToolName("MCP__BOBBIT__READ", surface.entriesBySdkRawLower)).toMatchObject({
			rawName: "MCP__BOBBIT__READ",
			canonicalName: "read",
			definition: expect.objectContaining({ name: "read", rawName: "mcp__bobbit__read" }),
		});
		const hyphenated = build({ entries: [{ ...entries[0], name: "mcp_nano-banana" }] });
		expect(normalizeClaudeSdkMcpToolName("mcp__bobbit__mcp_nano-banana", hyphenated.entriesBySdkRawLower)?.canonicalName).toBe("mcp_nano-banana");
		for (const invalid of ["Read", "mcp__other__read", "mcp__bobbit__", "mcp__bobbit__missing", "", null, undefined]) {
			expect(normalizeClaudeSdkMcpToolName(invalid, surface.entriesBySdkRawLower)).toBeUndefined();
		}
	});

	it("fails closed on invalid, reserved, and case-colliding adapter identities before selecting a winner", () => {
		for (const badEntries of [
			[{ ...entries[0], name: "Read" }],
			[{ ...entries[0], name: "mcp__bobbit__read" }],
			[{ ...entries[0], name: "read" }, { ...entries[1], name: "READ" }],
		]) {
			expect(() => build({ entries: badEntries })).toThrow(ClaudeSdkToolSurfaceError);
			expect(() => build({ entries: badEntries })).toThrow(/invalid|reserved|colliding|ambiguous/i);
		}
	});

	it("distinguishes unrestricted, selected, and explicitly empty surfaces without widening an empty restriction", async () => {
		const unrestricted = build({ restriction: "unrestricted", entries: [entries[0]] });
		const selected = build({ restriction: "restricted", entries: [entries[0]] });
		const empty = build({ restriction: "restricted", entries: [] });
		expect(unrestricted.restriction).toBe("unrestricted");
		expect(selected.sdkAllowNames).toEqual(["mcp__bobbit__read"]);
		expect(empty.restriction).toBe("restricted");
		expect(empty.entriesByCanonicalLower.size).toBe(0);
		expect(empty.sdkAllowNames).toEqual([]);
		expect(await (empty.canUseTool as any)("mcp__bobbit__read", {}, permissionContext())).toMatchObject({ behavior: "deny" });
	});

	it("derives visibility and permission ceilings independently for allow, ask, never, native, foreign, and subagent calls", async () => {
		const grants: Array<[string, string]> = [];
		const surface = build({
			requestToolGrant: async (name, group) => {
				grants.push([name, group]);
				return { granted: true, tools: [name], group, mode: "one-time" };
			},
		});
		expect(surface.sdkAllowNames).toEqual(["mcp__bobbit__read"]);
		expect(surface.entriesByCanonicalLower.get("never_tool")?.policy).toBe("never");

		expect(await (surface.canUseTool as any)("mcp__bobbit__read", {}, permissionContext())).toMatchObject({ behavior: "allow" });
		const hook = (surface.preToolUseMatcher as any)[0].hooks[0];
		expect((await hook({ tool_name: "mcp__bobbit__ask_tool", tool_use_id: "use-1" })).hookSpecificOutput.permissionDecision).toBe("ask");
		expect(await (surface.canUseTool as any)("mcp__bobbit__ask_tool", {}, permissionContext())).toMatchObject({ behavior: "allow" });
		expect(grants).toEqual([["ask_tool", "Browser"]]);
		for (const raw of ["mcp__bobbit__never_tool", "Bash", "Agent", "mcp__foreign__read"]) {
			expect(await (surface.canUseTool as any)(raw, {}, permissionContext())).toMatchObject({ behavior: "deny" });
		}
		expect(await (surface.canUseTool as any)("mcp__bobbit__read", {}, permissionContext({ agentID: "child" }))).toMatchObject({ behavior: "deny" });

		expect((await hook({ tool_name: "mcp__bobbit__never_tool", tool_use_id: "never" })).hookSpecificOutput.permissionDecision).toBe("deny");
		expect((await hook({ tool_name: "Bash", tool_use_id: "native" })).hookSpecificOutput.permissionDecision).toBe("deny");
		expect((await hook({ tool_name: "mcp__bobbit__read", tool_use_id: "allow" })).hookSpecificOutput.permissionDecision).toBe("allow");
	});

	it("projects only always-allow tools into the strict isolated SDK query", () => {
		const surface = build();
		const options = buildClaudeAgentSdkQueryOptions(surface, {
			cwd: "/workspace/project",
			env: { PATH: "/bin", CLAUDE_CONFIG_DIR: "/isolated/claude" },
			abortController: new AbortController(),
		} as any) as any;
		expect(options.tools).toEqual(["Skill", "Agent"]);
		expect(options.disallowedTools).toEqual(SUPPRESSED_NATIVE_0_3_222);
		expect(options.disallowedTools).toContain("Task");
		expect(options.disallowedTools).not.toContain("Agent");
		// Bare allowedTools bypass the SDK permission callback. The allow entry is
		// safe there, but ask/never entries and Agent must use their callbacks.
		expect(options.allowedTools).toEqual(["mcp__bobbit__read"]);
		for (const name of ["mcp__bobbit__ask_tool", "mcp__bobbit__never_tool", "Agent"]) {
			expect(options.allowedTools).not.toContain(name);
		}
		expect(options.agents).toEqual({});
		expect(options.mcpServers).toEqual({ bobbit: surface.server });
		expect(options.settingSources).toEqual([]);
		expect(options.strictMcpConfig).toBe(true);
		expect(options.managedSettings).toEqual({ autoMemoryEnabled: false });
		expect(options.permissionMode).toBe("default");
		expect(options.toolAliases).toBeUndefined();
		expect(options.bypassPermissions).toBeUndefined();
		expect(options.allowDangerouslySkipPermissions).toBeUndefined();
	});

	it("keeps Agent callback-reachable for the bounded subagent policy", async () => {
		const calls: Array<{ rawName: unknown; input: unknown; context: unknown }> = [];
		const surface = build({
			subagentPolicy: {
				definitions: {},
				admit: (rawName: unknown, input: unknown, context: unknown) => {
					calls.push({ rawName, input, context });
					return true;
				},
			} as any,
		});
		const options = buildClaudeAgentSdkQueryOptions(surface, {
			cwd: "/workspace/project",
			env: { PATH: "/bin" },
			abortController: new AbortController(),
		} as any) as any;
		const input = { subagent_type: "bobbit-backend-parity-reviewer", prompt: "Inspect", run_in_background: false };

		expect(options.allowedTools).not.toContain("Agent");
		await expect(options.canUseTool("Agent", input, permissionContext())).resolves.toMatchObject({ behavior: "allow" });
		expect(calls).toEqual([expect.objectContaining({ rawName: "Agent", input })]);
	});
});
