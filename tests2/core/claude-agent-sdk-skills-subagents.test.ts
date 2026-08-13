// v2-native — D3/D4 literal skills, constrained SDK subagents, and fail-closed admission contract.
import { describe, expect, it } from "vitest";

import * as sdkSurface from "../../src/server/agent/claude-agent-sdk-tool-surface.ts";
import { createClaudeSdkTranslatorState, translateClaudeSdkEvent } from "../../src/server/agent/claude-sdk-event-translator.ts";

const BUNDLED_SKILLS_0_3_222 = [
	"batch", "claude-api", "code-review", "dataviz", "debug", "deep-research", "design-sync", "doctor",
	"fewer-permission-prompts", "loop", "run", "run-skill-generator", "simplify", "update-config", "verify",
] as const;

const ROOT_NATIVE_DISALLOWED = [
	"Task", "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "NotebookEdit",
	"AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ExitWorktree", "Monitor",
	"ScheduleWakeup", "PushNotification", "RemoteTrigger", "CronCreate", "CronDelete", "CronList", "TaskCreate",
	"TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate", "ToolSearch",
] as const;

const CHILD_MCP_TOOLS = ["mcp__bobbit__read", "mcp__bobbit__find", "mcp__bobbit__grep"] as const;
const PROJECTIONS = {
	"bobbit-protocol-scout": { sourceRole: "claude-protocol-scout", effort: "high", maxTurns: 6 },
	"bobbit-backend-parity-reviewer": { sourceRole: "backend-parity-reviewer", effort: "medium", maxTurns: 4 },
	"bobbit-billing-safety-auditor": { sourceRole: "billing-safety-auditor", effort: "medium", maxTurns: 4 },
} as const;

type BuildPolicy = (input: {
	sessionId: string;
	goalBranch: string;
	roles: Readonly<Record<string, { name: string; promptTemplate: string }>>;
	entries: readonly {
		name: string;
		description: string;
		group: string;
		inputSchema: Record<string, unknown>;
		policy: "allow" | "ask" | "never";
		invoke: () => Promise<string>;
	}[];
	audit: (event: Record<string, unknown>) => void;
}) => any;

function policyFixture() {
	const audit: Array<Record<string, unknown>> = [];
	const buildPolicy = (sdkSurface as Record<string, unknown>).buildClaudeSdkSubagentPolicy;
	expect(buildPolicy, "D4 must expose the pure policy factory used by the session-setup preflight").toBeTypeOf("function");
	const roles = Object.fromEntries(Object.values(PROJECTIONS).map(({ sourceRole }) => [sourceRole, {
		name: sourceRole,
		promptTemplate: `Resolved ${sourceRole}: {{AGENT_ID}} @ {{GOAL_BRANCH}}`,
	}]));
	const policy = (buildPolicy as BuildPolicy)({
		sessionId: "root-sdk-session",
		goalBranch: "goal/immutable-projection",
		roles,
		entries: [
			{ name: "read", description: "read", group: "Files", inputSchema: { type: "object", properties: {} }, policy: "allow", invoke: async () => "ok" },
			{ name: "find", description: "find", group: "Files", inputSchema: { type: "object", properties: {} }, policy: "allow", invoke: async () => "ok" },
			{ name: "grep", description: "grep", group: "Files", inputSchema: { type: "object", properties: {} }, policy: "allow", invoke: async () => "ok" },
			{ name: "bash", description: "bash", group: "Shell", inputSchema: { type: "object", properties: {} }, policy: "never", invoke: async () => "ok" },
		],
		audit: event => audit.push(event),
	});
	return { policy, audit };
}

function hookInput(overrides: Record<string, unknown> = {}) {
	return {
		hook_event_name: "PreToolUse",
		session_id: "root-sdk-session",
		transcript_path: "/never/expose/child.jsonl",
		cwd: "/workspace",
		tool_name: "Agent",
		tool_use_id: "agent-use-1",
		tool_input: { subagent_type: "bobbit-backend-parity-reviewer", prompt: "Inspect this change", run_in_background: false },
		...overrides,
	};
}

function permissionContext(overrides: Record<string, unknown> = {}) {
	return { signal: new AbortController().signal, toolUseID: "agent-use-1", ...overrides };
}

function permissionDecision(value: any): string | undefined {
	return value?.hookSpecificOutput?.permissionDecision;
}

describe("Claude Agent SDK D3/D4 skills and subagents", () => {
	it("pins only the reviewed bundled skills and the root native inventory", () => {
		expect((sdkSurface as Record<string, unknown>).CLAUDE_BUNDLED_SKILLS_0_3_222).toEqual(BUNDLED_SKILLS_0_3_222);
		expect(sdkSurface.CLAUDE_NATIVE_TOOL_POLICY.retained).toEqual(["Skill", "Agent"]);
		expect(sdkSurface.CLAUDE_NATIVE_TOOL_POLICY.disallowed).toEqual(ROOT_NATIVE_DISALLOWED);
		expect(sdkSurface.CLAUDE_NATIVE_TOOL_POLICY.disallowed).toContain("Task");
		expect(sdkSurface.CLAUDE_NATIVE_TOOL_POLICY.disallowed).not.toContain("Skill");
		expect(sdkSurface.CLAUDE_NATIVE_TOOL_POLICY.disallowed).not.toContain("Agent");
	});

	it("projects exactly the three resolved Bobbit roles with immutable child bounds", () => {
		const { policy } = policyFixture();
		expect(Object.keys(policy.definitions).sort()).toEqual(Object.keys(PROJECTIONS).sort());
		for (const [agentType, expected] of Object.entries(PROJECTIONS)) {
			const definition = policy.definitions[agentType];
			expect(definition).toMatchObject({
				model: "inherit",
				effort: expected.effort,
				maxTurns: expected.maxTurns,
				background: false,
				permissionMode: "default",
				tools: ["Skill", ...CHILD_MCP_TOOLS],
				skills: BUNDLED_SKILLS_0_3_222,
			});
			expect(definition.prompt).toBe(`Resolved ${expected.sourceRole}: sdk-root-sdk-session @ goal/immutable-projection`);
			for (const forbidden of ["Agent", "Task", "Bash", "mcp__bobbit__bash"]) {
				expect(definition.disallowedTools, `${agentType} must explicitly disallow ${forbidden}`).toContain(forbidden);
			}
			for (const absent of ["memory", "mcpServers", "initialPrompt", "observer", "observerMessage"]) {
				expect(definition[absent], `${agentType} must not inherit ${absent}`).toBeUndefined();
			}
		}
		expect(policy.maxConcurrent).toBe(1);
		for (const forbiddenOwner of ["sessionStore", "taskManager", "worktree", "costLedger", "transcriptStore"]) {
			expect(policy, `SDK helper policy cannot own a Bobbit ${forbiddenOwner}`).not.toHaveProperty(forbiddenOwner);
		}
	});

	it("installs no Bobbit command or filesystem skill and retains only root Agent plus Skill", () => {
		const { policy } = policyFixture();
		const surface = sdkSurface.buildClaudeSdkToolSurface({
			sessionId: "root-sdk-session",
			restriction: "restricted",
			entries: [
				{ name: "read", description: "read", group: "Files", inputSchema: { type: "object", properties: {} }, policy: "allow", invoke: async () => "ok" },
				{ name: "find", description: "find", group: "Files", inputSchema: { type: "object", properties: {} }, policy: "allow", invoke: async () => "" },
				{ name: "grep", description: "grep", group: "Files", inputSchema: { type: "object", properties: {} }, policy: "allow", invoke: async () => "" },
				{ name: "bash", description: "bash", group: "Shell", inputSchema: { type: "object", properties: {} }, policy: "never", invoke: async () => "" },
			],
			requestToolGrant: async () => ({ granted: false }),
			subagentPolicy: policy,
		} as any);
		const options = sdkSurface.buildClaudeAgentSdkQueryOptions(surface, {
			cwd: "/workspace",
			env: { PATH: "/bin" },
			abortController: new AbortController(),
		} as any) as any;

		expect(options.tools).toEqual(["Skill", "Agent"]);
		expect(options.skills).toEqual(BUNDLED_SKILLS_0_3_222);
		expect(options.agents).toEqual(policy.definitions);
		expect(options.allowedTools).toEqual(["Agent", "mcp__bobbit__find", "mcp__bobbit__grep", "mcp__bobbit__read"]);
		expect(options.disallowedTools).toEqual(ROOT_NATIVE_DISALLOWED);
		expect(options.settingSources).toEqual([]);
		expect(options.strictMcpConfig).toBe(true);
		expect(options.managedSettings).toEqual({ autoMemoryEnabled: false });
		expect(options.toolAliases).toBeUndefined();
		expect(options.commands).toBeUndefined();
		expect(options.skills).not.toContain("bobbit");
	});

	it("admits only one foreground allowlisted Agent and fails closed for every native escape", async () => {
		const { policy } = policyFixture();
		const surface = sdkSurface.buildClaudeSdkToolSurface({
			sessionId: "root-sdk-session",
			restriction: "restricted",
			entries: CHILD_MCP_TOOLS.map(name => ({
				name: name.slice("mcp__bobbit__".length), description: name, group: "Files", inputSchema: { type: "object", properties: {} }, policy: "allow" as const, invoke: async () => "ok",
			})),
			requestToolGrant: async () => ({ granted: false }),
			subagentPolicy: policy,
		} as any);
		const preToolUse = (surface.preToolUseMatcher as any)[0].hooks[0];

		for (const subagent_type of Object.keys(PROJECTIONS)) {
			const admitted = hookInput({ tool_input: { subagent_type, prompt: "Inspect this change", run_in_background: false } });
			await expect((surface.canUseTool as any)("Agent", admitted.tool_input, permissionContext())).resolves.toMatchObject({ behavior: "allow" });
			expect(permissionDecision(await preToolUse(admitted))).toBe("allow");
			// Keep each projection's positive admission independent of the
			// one-pending-child cap exercised below.
			policy.clear();
		}
		for (const denied of [
			hookInput({ tool_name: "Task", tool_input: {} }),
			hookInput({ tool_input: { subagent_type: "general-purpose", prompt: "escape", run_in_background: false } }),
			hookInput({ tool_input: { subagent_type: "Bobbit-Backend-Parity-Reviewer", prompt: "case collision", run_in_background: false } }),
			hookInput({ tool_input: { subagent_type: "bobbit-backend-parity-reviewer", prompt: "background", run_in_background: true } }),
			hookInput({ tool_input: { subagent_type: "bobbit-backend-parity-reviewer", prompt: "missing foreground flag" } }),
			hookInput({ tool_input: { subagent_type: "bobbit-backend-parity-reviewer", prompt: "extra", run_in_background: false, model: "opus" } }),
			hookInput({ tool_input: { subagent_type: "bobbit-backend-parity-reviewer", prompt: "x".repeat(8 * 1024 + 1), run_in_background: false } }),
		]) {
			expect(permissionDecision(await preToolUse(denied))).toBe("deny");
			await expect((surface.canUseTool as any)(denied.tool_name, denied.tool_input, permissionContext())).resolves.toMatchObject({ behavior: "deny" });
		}
		for (const native of ["Task", "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate"]) {
			await expect((surface.canUseTool as any)(native, {}, permissionContext())).resolves.toMatchObject({ behavior: "deny" });
		}
	});

	it("correlates one pending admission across both permission paths, rejects invalid starts without ending the root, and partitions the bounded child lifecycle", async () => {
		const { policy, audit } = policyFixture();
		const surface = sdkSurface.buildClaudeSdkToolSurface({
			sessionId: "root-sdk-session",
			restriction: "restricted",
			entries: [
				...CHILD_MCP_TOOLS.map(name => ({ name: name.slice("mcp__bobbit__".length), description: name, group: "Files", inputSchema: { type: "object", properties: {} }, policy: "allow" as const, invoke: async () => "ok" })),
				{ name: "bash", description: "bash", group: "Shell", inputSchema: { type: "object", properties: {} }, policy: "allow" as const, invoke: async () => "bad" },
			],
			requestToolGrant: async () => ({ granted: false }),
			subagentPolicy: policy,
		} as any);
		const options = sdkSurface.buildClaudeAgentSdkQueryOptions(surface, { cwd: "/workspace", env: {}, abortController: new AbortController() } as any) as any;
		const preToolUse = options.hooks.PreToolUse[0].hooks[0];
		const start = options.hooks.SubagentStart[0].hooks[0];
		const stop = options.hooks.SubagentStop[0].hooks[0];
		const child = { agent_id: "child-1", agent_type: "bobbit-backend-parity-reviewer" };

		// These are the actual SDK hook fields. No invented lifecycle/cost/session
		// ids are permitted as a correlation backdoor.
		const startInput = { hook_event_name: "SubagentStart", session_id: "root-sdk-session", transcript_path: "/private/child.jsonl", cwd: "/workspace", ...child };
		// Invalid and unadmitted lifecycle hooks preserve the root query. Neither
		// can create a child capable of dispatching even a read-only MCP tool.
		expect(await start({ ...startInput, agent_id: "" })).toMatchObject({ continue: true });
		expect(policy.active.size).toBe(0);
		await expect((surface.canUseTool as any)("mcp__bobbit__read", {}, permissionContext({ agentID: "child-1" }))).resolves.toMatchObject({ behavior: "deny" });
		expect(await start(startInput)).toMatchObject({ continue: true });
		expect(policy.active.size).toBe(0);
		await expect((surface.canUseTool as any)("mcp__bobbit__read", {}, permissionContext({ agentID: "child-1" }))).resolves.toMatchObject({ behavior: "deny" });

		const rootCall = hookInput();
		await expect((surface.canUseTool as any)("Agent", rootCall.tool_input, permissionContext())).resolves.toMatchObject({ behavior: "allow" });
		expect(permissionDecision(await preToolUse(rootCall))).toBe("allow");
		expect(audit.filter(event => event.outcome === "admitted")).toHaveLength(1);
		const competing = hookInput({ tool_use_id: "agent-use-2", tool_input: { subagent_type: "bobbit-protocol-scout", prompt: "competing child", run_in_background: false } });
		expect(permissionDecision(await preToolUse(competing))).toBe("deny");

		// A mismatched start cannot consume the admitted root request or fabricate
		// an active child. It continues the root; only the exact pending projection
		// may start and inherit its originating Agent tool-use id.
		expect(await start({ ...startInput, agent_type: "general-purpose" })).toMatchObject({ continue: true });
		expect(policy.active.size).toBe(0);
		await expect((surface.canUseTool as any)("mcp__bobbit__read", {}, permissionContext({ agentID: "child-1" }))).resolves.toMatchObject({ behavior: "deny" });
		expect(await start(startInput)).toMatchObject({ continue: true });
		expect(policy.active.get("child-1")).toMatchObject({ agentId: "child-1", agentType: "bobbit-backend-parity-reviewer" });
		await expect((surface.canUseTool as any)("mcp__bobbit__read", {}, permissionContext({ agentID: "child-1" }))).resolves.toMatchObject({ behavior: "allow" });
		for (const tool_name of ["Agent", "Task", "Bash", "mcp__bobbit__bash", "mcp__foreign__read"]) {
			expect(permissionDecision(await preToolUse(hookInput({ tool_name, ...child })))).toBe("deny");
			await expect((surface.canUseTool as any)(tool_name, {}, permissionContext({ agentID: "child-1" }))).resolves.toMatchObject({ behavior: "deny" });
		}

		let translator = createClaudeSdkTranslatorState();
		const childFrame = translateClaudeSdkEvent(translator, {
			type: "assistant", parent_tool_use_id: "agent-use-1", parent_agent_id: "child-1", uuid: "child-frame",
			message: { role: "assistant", content: [{ type: "text", text: "read-only evidence" }], stop_reason: "end_turn" },
		});
		translator = childFrame.state;
		expect(childFrame.events).toEqual([expect.objectContaining({ type: "message_end", parentToolUseId: "agent-use-1" })]);
		expect(childFrame.events.some((event: any) => event.type === "agent_end")).toBe(false);
		await stop({ hook_event_name: "SubagentStop", session_id: "root-sdk-session", transcript_path: "/private/root.jsonl", cwd: "/workspace", stop_hook_active: false, agent_transcript_path: "/private/child.jsonl", ...child });
		expect(policy.active.size).toBe(0);
		const rootTerminal = translateClaudeSdkEvent(translator, { type: "result", subtype: "success" });
		expect(rootTerminal.events.filter((event: any) => event.type === "agent_end")).toHaveLength(1);
		for (const owner of ["sessionStore", "taskManager", "worktree", "costLedger", "transcriptStore"]) {
			expect(policy).not.toHaveProperty(owner);
			expect(surface).not.toHaveProperty(owner);
		}
	});

	it("publishes lifecycle records only for admitted entries and terminalizes live children once", () => {
		const { policy } = policyFixture();
		const events: any[] = [];
		const unsubscribe = policy.subscribe((event: unknown) => events.push(event));
		const child = { agent_id: "child-1", agent_type: "bobbit-backend-parity-reviewer" };

		// Invalid/unadmitted hooks never create an observable identity.
		expect(policy.onStart(child)).toBe(false);
		policy.onStop(child);
		expect(events).toEqual([]);

		expect(policy.admit("Agent", {
			subagent_type: child.agent_type, prompt: "Inspect this change", run_in_background: false,
		}, { toolUseId: "agent-use-1", permissionMode: "default" })).toBe(true);
		expect(policy.onStart(child)).toBe(true);
		expect(events).toEqual([expect.objectContaining({
			kind: "start",
			entry: expect.objectContaining({ agentId: "child-1", agentType: child.agent_type, toolUseId: "agent-use-1" }),
			at: expect.any(Number),
		})]);

		// Clearing an active policy terminalizes the exact registry entry once;
		// repeated terminal cleanup and an old stop hook cannot duplicate it.
		policy.clear();
		policy.clear();
		policy.onStop(child);
		expect(events.map(event => event.kind)).toEqual(["start", "aborted"]);
		expect(events[1]).toEqual(expect.objectContaining({
			entry: expect.objectContaining({ agentId: "child-1", toolUseId: "agent-use-1" }),
		}));

		unsubscribe();
		policy.admit("Agent", {
			subagent_type: child.agent_type, prompt: "Inspect again", run_in_background: false,
		}, { toolUseId: "agent-use-2", permissionMode: "default" });
		policy.onStart(child);
		policy.onStop(child);
		expect(events.map(event => event.kind)).toEqual(["start", "aborted"]);
	});

	it("requires a registered matching child, keeps its tool subset read-only, audits bounded fields, and clears on stop", async () => {
		const { policy, audit } = policyFixture();
		const surface = sdkSurface.buildClaudeSdkToolSurface({
			sessionId: "root-sdk-session",
			restriction: "restricted",
			entries: [
				...CHILD_MCP_TOOLS.map(name => ({ name: name.slice("mcp__bobbit__".length), description: name, group: "Files", inputSchema: { type: "object", properties: {} }, policy: "allow" as const, invoke: async () => "ok" })),
				{ name: "bash", description: "bash", group: "Shell", inputSchema: { type: "object", properties: {} }, policy: "allow" as const, invoke: async () => "bad" },
			],
			requestToolGrant: async () => ({ granted: false }),
			subagentPolicy: policy,
		} as any);
		const options = sdkSurface.buildClaudeAgentSdkQueryOptions(surface, { cwd: "/workspace", env: {}, abortController: new AbortController() } as any) as any;
		const hooks = options.hooks;
		const preToolUse = hooks.PreToolUse[0].hooks[0];
		const start = hooks.SubagentStart[0].hooks[0];
		const stop = hooks.SubagentStop[0].hooks[0];
		const child = { agent_id: "child-1", agent_type: "bobbit-backend-parity-reviewer" };

		expect(permissionDecision(await preToolUse(hookInput({ tool_name: "mcp__bobbit__read", ...child })))).toBe("deny");
		// Admit first: SubagentStart contains no parent/tool-use field in SDK
		// 0.3.222, so the policy must retain this approved root boundary itself.
		expect(permissionDecision(await preToolUse(hookInput()))).toBe("allow");
		await start({ hook_event_name: "SubagentStart", session_id: "root-sdk-session", transcript_path: "/private/child.jsonl", cwd: "/workspace", ...child });
		expect(permissionDecision(await preToolUse(hookInput({ tool_name: "mcp__bobbit__read", ...child })))).toBe("allow");
		for (const tool_name of ["Agent", "Task", "mcp__bobbit__bash", "mcp__foreign__read"]) {
			expect(permissionDecision(await preToolUse(hookInput({ tool_name, ...child })))).toBe("deny");
		}
		expect(permissionDecision(await preToolUse(hookInput({ tool_name: "Agent", agent_id: "child-1", agent_type: "bobbit-backend-parity-reviewer" })))).toBe("deny");
		await stop({ hook_event_name: "SubagentStop", session_id: "root-sdk-session", transcript_path: "/private/root.jsonl", cwd: "/workspace", agent_transcript_path: "/private/child.jsonl", stop_hook_active: false, ...child });
		expect(permissionDecision(await preToolUse(hookInput({ tool_name: "mcp__bobbit__read", ...child })))).toBe("deny");
		expect(audit).not.toEqual([]);
		for (const event of audit) {
			expect(JSON.stringify(event)).not.toMatch(/Inspect this change|private|transcript|credential|secret/i);
			expect(event).toEqual(expect.objectContaining({ sessionId: "root-sdk-session", outcome: expect.any(String) }));
			expect(Object.keys(event).every(key => ["sessionId", "outcome", "toolUseId", "agentId", "agentType", "parentToolUseId", "durationMs"].includes(key))).toBe(true);
		}
		expect(audit).toContainEqual(expect.objectContaining({ outcome: "started", toolUseId: "agent-use-1", agentId: "child-1", agentType: "bobbit-backend-parity-reviewer" }));
		// Stop must retain the bounded root Agent id correlated at exact admission,
		// never a lifecycle-hook supplied parent identifier.
		expect(audit).toContainEqual(expect.objectContaining({ outcome: "stopped", toolUseId: "agent-use-1", agentId: "child-1", agentType: "bobbit-backend-parity-reviewer", parentToolUseId: "agent-use-1", durationMs: expect.any(Number) }));
		surface.dispose?.();
		expect(permissionDecision(await preToolUse(hookInput({ tool_name: "mcp__bobbit__read", ...child })))).toBe("deny");
	});
});
