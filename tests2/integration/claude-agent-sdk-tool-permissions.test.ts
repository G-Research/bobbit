// v2-native — integration coverage for the three independent Claude SDK permission ceilings.
import { describe, expect, it } from "vitest";

import {
	buildClaudeSdkToolSurface,
} from "../../src/server/agent/claude-agent-sdk-tool-surface.ts";

type Grant = {
	granted: boolean;
	tools?: string[];
	scope?: "tool" | "group";
	group?: string;
	mode?: "one-time" | "session-only" | "persistent";
	reason?: string;
};

type Surface = {
	sdkAllowNames: readonly string[];
	entriesByCanonicalLower: ReadonlyMap<string, unknown>;
	canUseTool: (name: string, input: unknown, context: { signal?: AbortSignal; parentToolUseID?: string; toolUseID?: string }) => Promise<{ behavior: string; message?: string }>;
	preToolUseMatcher: { hooks: Array<(input: { tool_name?: string; tool_input?: unknown; parent_tool_use_id?: string }, toolUseId: string, context?: { signal?: AbortSignal; parentToolUseID?: string }) => Promise<{ hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }> };
	invoke: (rawName: string, input: unknown, context?: { signal?: AbortSignal }) => Promise<unknown>;
	renderToolName: (rawName: string) => string | undefined;
};

function decision(result: Awaited<ReturnType<Surface["preToolUseMatcher"]["hooks"][number]>>): string | undefined {
	return result.hookSpecificOutput?.permissionDecision;
}

function fixture(overrides: {
	restriction?: "unrestricted" | "restricted";
	allowedTools?: readonly string[];
	grant?: (name: string, group: string, signal?: AbortSignal) => Promise<Grant>;
} = {}) {
	const grants: Array<{ name: string; group: string; signal?: AbortSignal }> = [];
	const dispatched: Array<{ name: string; args: unknown }> = [];
	const requestToolGrant = async (name: string, group: string, signal?: AbortSignal): Promise<Grant> => {
		grants.push({ name, group, signal });
		return overrides.grant?.(name, group, signal) ?? { granted: false, reason: "denied by test" };
	};
	const surface = buildClaudeSdkToolSurface({
		sessionId: "sdk-permission-session",
		restriction: overrides.restriction ?? "unrestricted",
		allowedTools: overrides.allowedTools,
		entries: [
			{ name: "read", group: "Files", description: "Read a file", inputSchema: { type: "object" }, policy: "allow" },
			{ name: "ask_user_choices", group: "Ask", description: "Ask the user", inputSchema: { type: "object" }, policy: "ask" },
			{ name: "bash", group: "Shell", description: "Run a command", inputSchema: { type: "object" }, policy: "never" },
		],
		requestToolGrant,
		dispatch: async (name: string, args: unknown) => {
			dispatched.push({ name, args });
			return { content: [{ type: "text", text: "ok" }] };
		},
	}) as Surface;
	return { surface, grants, dispatched };
}

async function canUse(surface: Surface, name: string, context: { signal?: AbortSignal; parentToolUseID?: string; toolUseID?: string } = {}) {
	return surface.canUseTool(name, {}, context);
}

async function preUse(surface: Surface, name: string, toolUseId = "tool-use-1", context: { signal?: AbortSignal; parentToolUseID?: string } = {}) {
	return surface.preToolUseMatcher.hooks[0]!({ tool_name: name, tool_input: {} }, toolUseId, context);
}

describe("Claude SDK Bobbit tool permission integration", () => {
	it("applies the registration/allowedTools, canUseTool, and PreToolUse ceilings independently", async () => {
		const { surface } = fixture();

		// Visibility is only a convenience layer: allow is preallowed, ask remains
		// registered but is absent from allowedTools, and never is absent entirely.
		expect(surface.sdkAllowNames).toEqual(["mcp__bobbit__read"]);
		expect(surface.entriesByCanonicalLower.has("read")).toBe(true);
		expect(surface.entriesByCanonicalLower.has("ask_user_choices")).toBe(true);
		expect(surface.entriesByCanonicalLower.has("bash")).toBe(false);

		await expect(canUse(surface, "mcp__bobbit__read")).resolves.toMatchObject({ behavior: "allow" });
		await expect(preUse(surface, "mcp__bobbit__read")).resolves.toSatisfy((result: unknown) => decision(result as any) === "allow");

		for (const name of [
			"mcp__bobbit__bash", // never
			"Bash", // native
			"mcp__foreign__read", // foreign server
			"mcp__bobbit__", // malformed
			"mcp__bobbit__missing", // unknown
		]) {
			await expect(canUse(surface, name)).resolves.toMatchObject({ behavior: "deny" });
			await expect(preUse(surface, name)).resolves.toSatisfy((result: unknown) => decision(result as any) === "deny");
		}
	});

	it("fails closed for an explicitly empty surface and for subagent-originated calls", async () => {
		const { surface } = fixture({ restriction: "restricted", allowedTools: [] });
		expect(surface.entriesByCanonicalLower.size).toBe(0);
		expect(surface.sdkAllowNames).toEqual([]);

		await expect(canUse(surface, "mcp__bobbit__read")).resolves.toMatchObject({ behavior: "deny" });
		await expect(preUse(surface, "mcp__bobbit__read")).resolves.toSatisfy((result: unknown) => decision(result as any) === "deny");

		const unrestricted = fixture().surface;
		await expect(canUse(unrestricted, "mcp__bobbit__read", { parentToolUseID: "native-agent-call" })).resolves.toMatchObject({ behavior: "deny" });
		await expect(preUse(unrestricted, "mcp__bobbit__read", { parentToolUseID: "native-agent-call" })).resolves.toSatisfy((result: unknown) => decision(result as any) === "deny");
	});

	it("uses the existing grant seam only for ask, requires exact normalized coverage, and settles cancellation", async () => {
		const aborted = new AbortController();
		const pending = fixture({
			grant: async (_name, _group, signal) => new Promise<Grant>((resolve) => signal?.addEventListener("abort", () => resolve({ granted: false, reason: "cancelled" }), { once: true })),
		});
		const permission = canUse(pending.surface, "mcp__bobbit__ask_user_choices", { signal: aborted.signal });
		expect(pending.grants).toEqual([{ name: "ask_user_choices", group: "Ask", signal: aborted.signal }]);
		aborted.abort();
		await expect(permission).resolves.toMatchObject({ behavior: "deny" });
		await expect(preUse(pending.surface, "mcp__bobbit__ask_user_choices")).resolves.toSatisfy((result: unknown) => decision(result as any) === "deny");

		for (const grant of [
			{ granted: true, tools: ["read"], scope: "tool", group: "Ask", mode: "one-time" },
			{ granted: true, tools: ["ask_user_choices"], scope: "tool", group: "Files", mode: "one-time" },
			{ granted: true, tools: ["ask_user_choices"], scope: "group", group: "Other", mode: "one-time" },
		] satisfies Grant[]) {
			const { surface } = fixture({ grant: async () => grant });
			await expect(canUse(surface, "mcp__bobbit__ask_user_choices")).resolves.toMatchObject({ behavior: "deny" });
		}
	});

	it("does not cache one-time approval and keeps PreToolUse as the final bypass defence", async () => {
		const { surface, grants } = fixture({
			grant: async () => ({ granted: true, tools: ["ask_user_choices"], scope: "tool", group: "Ask", mode: "one-time" }),
		});

		await expect(canUse(surface, "mcp__bobbit__ask_user_choices", { toolUseID: "tool-use-1" })).resolves.toMatchObject({ behavior: "allow" });
		await expect(preUse(surface, "mcp__bobbit__ask_user_choices", "tool-use-1")).resolves.toSatisfy((result: unknown) => decision(result as any) === "allow");
		// A second SDK permission decision must prompt again: a one-time grant is
		// invocation-local and must never mutate allowedTools or a callback cache.
		await expect(canUse(surface, "mcp__bobbit__ask_user_choices", { toolUseID: "tool-use-2" })).resolves.toMatchObject({ behavior: "allow" });
		expect(grants).toHaveLength(2);
		// Even if the SDK routes a call as preallowed/default-mode, PreToolUse sees
		// no current one-time authorization and blocks the otherwise ask-gated call.
		await expect(preUse(surface, "mcp__bobbit__ask_user_choices", "sdk-bypass-tool-use")).resolves.toSatisfy((result: unknown) => decision(result as any) === "deny");
	});

	it("dispatches and renders only the canonical Bobbit identity", async () => {
		const { surface, dispatched } = fixture();
		await expect(surface.invoke("mcp__bobbit__ReAd", { path: "README.md" })).resolves.toMatchObject({ content: expect.any(Array) });
		expect(dispatched).toEqual([{ name: "read", args: { path: "README.md" } }]);
		expect(surface.renderToolName("mcp__bobbit__ReAd")).toBe("read");
		expect(surface.renderToolName("mcp__foreign__read")).toBeUndefined();
	});
});
