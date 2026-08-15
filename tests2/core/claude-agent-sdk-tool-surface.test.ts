// v2-native — exact Agent SDK native-surface and isolated-options contract.
import { describe, expect, it } from "vitest";

import {
	CLAUDE_NATIVE_TOOL_FLOOR,
	CLAUDE_NATIVE_TOOL_POLICY,
	ClaudeSdkToolSurfaceError,
	isClaudeSdkRetainedNativeTool,
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
	"Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch",
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

function opaqueInput(): Record<string, unknown> {
	return Object.freeze(Object.create(null));
}

describe("Claude Agent SDK tool surface", () => {
	it("pins Task as Agent's private alias target without exposing native task tools", () => {
		expect(CLAUDE_NATIVE_TOOL_FLOOR).toEqual(NATIVE_FLOOR_0_3_222);
		expect(new Set(CLAUDE_NATIVE_TOOL_FLOOR).size).toBe(30);
		expect(CLAUDE_NATIVE_TOOL_POLICY.retained).toEqual(["Skill", "Agent"]);
		expect(CLAUDE_NATIVE_TOOL_POLICY.suppressed).toEqual(SUPPRESSED_NATIVE_0_3_222);
		expect(CLAUDE_NATIVE_TOOL_POLICY.reserved).toEqual(["Agent"]);
		expect(CLAUDE_NATIVE_TOOL_POLICY.disallowed).toEqual(SUPPRESSED_NATIVE_0_3_222);
		expect(CLAUDE_NATIVE_TOOL_POLICY.disallowed).not.toContain("Skill");
		expect(CLAUDE_NATIVE_TOOL_POLICY.disallowed).not.toContain("Agent");
		// Task must resolve only as Agent's SDK alias target, never as a public tool.
		expect(CLAUDE_NATIVE_TOOL_POLICY.disallowed).not.toContain("Task");
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
		expect(await hook({ tool_name: "mcp__bobbit__ask_tool", tool_use_id: "use-1" })).toEqual({ continue: true });
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

	it("returns the exact current SDK input for every admitted callback path", async () => {
		const surface = build({
			subagentPolicy: {
				definitions: {},
				admit: () => true,
				authorizeChild: () => true,
			} as any,
		});
		const admitted = [
			["mcp__bobbit__read", permissionContext()],
			["mcp__bobbit__ask_tool", permissionContext({ toolUseID: "ask" })],
			["Agent", permissionContext({ toolUseID: "agent" })],
			["Skill", permissionContext({ toolUseID: "skill" })],
			["mcp__bobbit__read", permissionContext({ toolUseID: "child", agentID: "child" })],
		] as const;
		for (const [name, context] of admitted) {
			const input = opaqueInput();
			const result = await (surface.canUseTool as any)(name, input, context);
			expect(result).toMatchObject({ behavior: "allow" });
			expect(result.updatedInput).toBe(input);
		}

		const deniedInput = opaqueInput();
		const denied = await (surface.canUseTool as any)("mcp__bobbit__never_tool", deniedInput, permissionContext());
		expect(denied).toMatchObject({ behavior: "deny" });
		expect(denied).not.toHaveProperty("updatedInput");
	});

	it("leaves root ask hooks neutral and makes canUseTool the sole current-grant authority", async () => {
		const resolutions = [
			{ granted: false },
			{ granted: true, tools: ["ask_tool"], group: "Browser", mode: "one-time" as const },
			{ granted: true, tools: ["ask_tool"], group: "Files", mode: "one-time" as const },
		];
		const requested: Array<[string, string]> = [];
		const surface = build({
			requestToolGrant: async (name, group) => {
				requested.push([name, group]);
				return resolutions.shift()!;
			},
		});
		const hook = (surface.preToolUseMatcher as any)[0].hooks[0];

		expect(surface.sdkAllowNames).toEqual(["mcp__bobbit__read"]);
		expect(surface.sdkAllowNames).not.toContain("mcp__bobbit__ask_tool");
		expect(await hook({ tool_name: "mcp__bobbit__ask_tool", tool_use_id: "ask" })).toEqual({ continue: true });
		const deniedInput = opaqueInput();
		const denied = await (surface.canUseTool as any)("mcp__bobbit__ask_tool", deniedInput, permissionContext({ toolUseID: "denied" }));
		expect(denied).toMatchObject({ behavior: "deny" });
		expect(denied).not.toHaveProperty("updatedInput");
		const grantedInput = opaqueInput();
		const granted = await (surface.canUseTool as any)("mcp__bobbit__ask_tool", grantedInput, permissionContext({ toolUseID: "granted" }));
		expect(granted).toMatchObject({ behavior: "allow" });
		expect(granted.updatedInput).toBe(grantedInput);
		const wrongScopeInput = opaqueInput();
		const wrongScope = await (surface.canUseTool as any)("mcp__bobbit__ask_tool", wrongScopeInput, permissionContext({ toolUseID: "wrong-scope" }));
		expect(wrongScope).toMatchObject({ behavior: "deny" });
		expect(wrongScope).not.toHaveProperty("updatedInput");
		expect(requested).toEqual([["ask_tool", "Browser"], ["ask_tool", "Browser"], ["ask_tool", "Browser"]]);
		// A neutral hook stays neutral after a grant; no replay or re-entry state exists.
		expect(await hook({ tool_name: "mcp__bobbit__ask_tool", tool_use_id: "granted" })).toEqual({ continue: true });

		const controller = new AbortController();
		controller.abort();
		const abortedInput = opaqueInput();
		const aborted = await (surface.canUseTool as any)("mcp__bobbit__ask_tool", abortedInput, permissionContext({ signal: controller.signal, toolUseID: "aborted" }));
		expect(aborted).toMatchObject({ behavior: "deny" });
		expect(aborted).not.toHaveProperty("updatedInput");
		expect(requested).toHaveLength(3);
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
		expect(options.disallowedTools).not.toContain("Task");
		expect(options.disallowedTools).not.toContain("Agent");
		// Agent is required by the official SDK programmatic-agent contract. Its
		// bare allow shadows canUseTool, so its strict PreToolUse gate is pinned below.
		expect(options.allowedTools).toEqual(["Agent", "mcp__bobbit__read"]);
		for (const name of ["mcp__bobbit__ask_tool", "mcp__bobbit__never_tool", "Task", "Skill"]) {
			expect(options.allowedTools).not.toContain(name);
		}
		expect(isClaudeSdkRetainedNativeTool("Agent")).toBe(true);
		expect(isClaudeSdkRetainedNativeTool("Skill")).toBe(true);
		expect(isClaudeSdkRetainedNativeTool("Task")).toBe(false);
		expect(isClaudeSdkRetainedNativeTool("mcp__bobbit__Agent")).toBe(false);
		expect(options.agents).toEqual({});
		expect(options.mcpServers).toEqual({ bobbit: surface.server });
		expect(options.settingSources).toEqual([]);
		expect(options.strictMcpConfig).toBe(true);
		expect(options.managedSettings).toEqual({ autoMemoryEnabled: false });
		expect(options.permissionMode).toBe("default");
		expect(options.toolAliases).toEqual({ Agent: "Task" });
		expect(options.bypassPermissions).toBeUndefined();
		expect(options.allowDangerouslySkipPermissions).toBeUndefined();
	});

	it("keeps the public Agent allow entry behind the strict alias-aware PreToolUse policy", async () => {
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
		const input = opaqueInput();

		expect(options.allowedTools).toContain("Agent");
		const result = await options.canUseTool("Agent", input, permissionContext());
		expect(result).toMatchObject({ behavior: "allow" });
		expect(result.updatedInput).toBe(input);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.rawName).toBe("Agent");
		expect(calls[0]!.input).toBe(input);
		// The 0.3.222 hook sees the resolved Task target, but it must retain the
		// public Agent's exact id/input and admission policy.
		expect((await options.hooks.PreToolUse[0].hooks[0]({ tool_name: "Task", tool_use_id: "agent-alias", tool_input: input })).hookSpecificOutput.permissionDecision).toBe("allow");
		expect(calls[calls.length - 1]).toMatchObject({ rawName: "Agent", input, context: { toolUseId: "agent-alias", permissionMode: "default" } });
		// Raw Task is not model-visible or auto-allowed, so its callback path stays
		// denied even though Task is the private alias target.
		expect(await options.canUseTool("Task", input, permissionContext({ toolUseID: "raw-task" }))).toMatchObject({ behavior: "deny" });
		// SDK bare allowlists can bypass canUseTool; a root without an admitted
		// policy is still denied at PreToolUse rather than becoming a native escape.
		const noPolicy = buildClaudeAgentSdkQueryOptions(build(), {
			cwd: "/workspace/project", env: { PATH: "/bin" }, abortController: new AbortController(),
		} as any) as any;
		const preToolUse = noPolicy.hooks.PreToolUse[0].hooks[0];
		for (const name of ["Agent", "Task"]) {
			expect((await preToolUse({ tool_name: name, tool_use_id: `unadmitted-${name}`, tool_input: input })).hookSpecificOutput.permissionDecision).toBe("deny");
		}
	});
});
