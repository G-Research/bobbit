// v2-native — real SessionManager ↔ Claude SDK permission-card seam journey.
import { afterEach, describe, expect, it } from "vitest";

import { buildClaudeSdkToolSurface } from "../../src/server/agent/claude-agent-sdk-tool-surface.ts";
import { SessionManager } from "../../src/server/agent/session-manager.ts";
import { createManualClock } from "../harness/clock.ts";

const managers: any[] = [];

type TestClient = { readyState: number; bufferedAmount: number; sent: any[]; send: (payload: string) => void };

function makeClient(): TestClient {
	return {
		readyState: 1,
		bufferedAmount: 0,
		sent: [],
		send(payload) { this.sent.push(JSON.parse(payload)); },
	};
}

function makeHarness() {
	const clock = createManualClock(10_000);
	const role = { name: "general", label: "General", toolPolicies: {} as Record<string, "allow" | "ask" | "never"> };
	const roleManager = {
		getRole: (name: string) => name === role.name ? role : undefined,
		updateRole: (_name: string, update: { toolPolicies?: Record<string, "allow" | "ask" | "never"> }) => {
			if (update.toolPolicies) role.toolPolicies = update.toolPolicies;
		},
	};
	const manager: any = new SessionManager({ clock, roleManager: roleManager as any });
	clock.clearInterval(manager._statusHeartbeatTimer);
	manager._statusHeartbeatTimer = null;
	manager._testClock = clock;
	const client = makeClient();
	const session: any = {
		id: "claude-sdk-card-journey",
		title: "Claude SDK card journey",
		role: "general",
		lastPromptText: "Choose the permission duration.",
		allowedTools: ["ask_user_choices"],
		clients: new Set([client]),
		eventBuffer: { pushFrame: (() => { let seq = 40; return () => ({ seq: ++seq, ts: clock.now() }); })() },
	};
	manager.sessions.set(session.id, session);
	managers.push(manager);
	return { clock, client, manager, role, session };
}

function surfaceFor(harness: ReturnType<typeof makeHarness>, transform?: (resolution: any) => any) {
	const resolutions: any[] = [];
	const surface = buildClaudeSdkToolSurface({
		sessionId: harness.session.id,
		restriction: "restricted",
		entries: [
			{ name: "read", group: "Files", description: "Read", inputSchema: { type: "object", properties: {} }, policy: "allow", invoke: async () => "read" },
			{ name: "ask_user_choices", group: "Ask", description: "Ask", inputSchema: { type: "object", properties: {} }, policy: "ask", invoke: async () => "ask" },
			{ name: "bash", group: "Shell", description: "Shell", inputSchema: { type: "object", properties: {} }, policy: "never", invoke: async () => "bash" },
		],
		// Match session-setup's deliberately narrow SessionManager seam.
		requestToolGrant: async (toolName, group, options) => {
			const resolution = await harness.manager.requestToolGrant(harness.session.id, toolName, group, options);
			resolutions.push(resolution);
			return transform ? transform(resolution) : resolution;
		},
	});
	return { resolutions, surface };
}

function canUse(surface: ReturnType<typeof surfaceFor>["surface"], toolUseID: string, overrides: Record<string, unknown> = {}) {
	return (surface.canUseTool as any)("mcp__bobbit__ask_user_choices", {}, {
		signal: new AbortController().signal,
		toolUseID,
		...overrides,
	});
}

function preUse(surface: ReturnType<typeof surfaceFor>["surface"], toolName: string, toolUseId: string, extra: Record<string, unknown> = {}) {
	return (surface.preToolUseMatcher as any)[0].hooks[0]({ tool_name: toolName, tool_use_id: toolUseId, ...extra });
}

function pending(harness: ReturnType<typeof makeHarness>) {
	const request = harness.session.pendingGrantRequest;
	expect(request).toBeDefined();
	return request;
}

afterEach(() => {
	for (const manager of managers.splice(0)) {
		manager._testClock?.clearInterval?.(manager._statusHeartbeatTimer);
		manager.sessions.clear();
	}
});

describe("Claude SDK permission-card journey", () => {
	it("routes canonical ask calls through the existing card and consumes a one-time approval exactly once", async () => {
		const harness = makeHarness();
		const { surface, resolutions } = surfaceFor(harness);
		const blocked = canUse(surface, "one-time-call");
		const request = pending(harness);
		expect(request).toMatchObject({ id: "perm_41_ask_user_choices", toolName: "ask_user_choices", toolGroup: "Ask" });
		expect(harness.client.sent).toContainEqual(expect.objectContaining({
			type: "tool_permission_needed",
			id: request.id,
			toolName: "ask_user_choices",
			group: "Ask",
			lastPromptText: harness.session.lastPromptText,
			seq: 41,
		}));

		await harness.manager.grantToolPermission(harness.session.id, "ask_user_choices", "tool", "Ask", "one-time", request.id);
		await expect(blocked).resolves.toMatchObject({ behavior: "allow" });
		expect(resolutions).toContainEqual(expect.objectContaining({ granted: true, tools: ["ask_user_choices"], group: "Ask", mode: "one-time" }));
		expect(harness.client.sent).toContainEqual(expect.objectContaining({ type: "tool_permission_settled", status: "granted" }));
		expect(await preUse(surface, "mcp__bobbit__ask_user_choices", "one-time-call")).toEqual({ continue: true });
		expect(await preUse(surface, "mcp__bobbit__ask_user_choices", "one-time-call")).toEqual({ continue: true });

		const nextCall = canUse(surface, "requires-another-card");
		expect(pending(harness).id).not.toBe(request.id);
		harness.manager.denyToolPermission(harness.session.id, "ask_user_choices", harness.session.pendingGrantRequest.id);
		await expect(nextCall).resolves.toMatchObject({ behavior: "deny" });
	});

	it("keeps session and persistent duration ownership in SessionManager instead of the immutable SDK surface", async () => {
		const sessionHarness = makeHarness();
		const { surface: sessionSurface, resolutions: sessionResolutions } = surfaceFor(sessionHarness);
		const sessionCall = canUse(sessionSurface, "session-grant");
		const sessionRequest = pending(sessionHarness);
		await sessionHarness.manager.grantToolPermission(sessionHarness.session.id, "ask_user_choices", "tool", "Ask", "session-only", sessionRequest.id);
		await expect(sessionCall).resolves.toMatchObject({ behavior: "allow" });
		expect(sessionResolutions.at(-1)).toMatchObject({ granted: true, mode: "session-only", tools: ["ask_user_choices"] });
		expect(sessionHarness.session.sessionOnlyGrantedTools).toEqual(["ask_user_choices"]);
		// A new SDK invocation asks the manager again; its session-owned grant decides it without a second card.
		await expect(canUse(sessionSurface, "session-grant-next")).resolves.toMatchObject({ behavior: "allow" });
		expect(sessionHarness.session.pendingGrantRequest).toBeUndefined();
		expect(await preUse(sessionSurface, "mcp__bobbit__ask_user_choices", "session-grant-next")).toEqual({ continue: true });

		const persistentHarness = makeHarness();
		const { surface: persistentSurface, resolutions: persistentResolutions } = surfaceFor(persistentHarness);
		const persistentCall = canUse(persistentSurface, "persistent-grant");
		const persistentRequest = pending(persistentHarness);
		await persistentHarness.manager.grantToolPermission(persistentHarness.session.id, "ask_user_choices", "tool", "Ask", "persistent", persistentRequest.id);
		await expect(persistentCall).resolves.toMatchObject({ behavior: "allow" });
		expect(persistentResolutions.at(-1)).toMatchObject({ granted: true, mode: "persistent", tools: ["ask_user_choices"] });
		expect(persistentHarness.role.toolPolicies).toMatchObject({ ask_user_choices: "allow" });
		// The existing surface remains neutral; a recomputed/restarted surface owns the policy change.
		expect(await preUse(persistentSurface, "mcp__bobbit__ask_user_choices", "callback-bypass")).toEqual({ continue: true });
	});

	it("settles aborts, timeouts, stale actions, and disposed surfaces without leaving actionable cards", async () => {
		const abortHarness = makeHarness();
		const { surface: abortSurface } = surfaceFor(abortHarness);
		const controller = new AbortController();
		const aborted = (abortSurface.canUseTool as any)("mcp__bobbit__ask_user_choices", {}, { signal: controller.signal, toolUseID: "abort" });
		pending(abortHarness);
		controller.abort();
		await expect(aborted).resolves.toMatchObject({ behavior: "deny" });
		expect(abortHarness.session.pendingGrantRequest).toBeUndefined();
		expect(abortHarness.client.sent).toContainEqual(expect.objectContaining({ type: "tool_permission_settled", status: "cancelled" }));

		const timeoutHarness = makeHarness();
		const { surface: timeoutSurface } = surfaceFor(timeoutHarness);
		const timedOut = canUse(timeoutSurface, "timeout");
		pending(timeoutHarness);
		timeoutHarness.clock.advance(5 * 60 * 1000);
		await expect(timedOut).resolves.toMatchObject({ behavior: "deny" });
		expect(timeoutHarness.session.pendingGrantRequest).toBeUndefined();
		expect(timeoutHarness.client.sent).toContainEqual(expect.objectContaining({ type: "tool_permission_settled", status: "expired" }));

		const staleHarness = makeHarness();
		const { surface: staleSurface } = surfaceFor(staleHarness);
		const staleCall = canUse(staleSurface, "stale");
		const active = pending(staleHarness);
		await expect(staleHarness.manager.grantToolPermission(staleHarness.session.id, "ask_user_choices", "tool", "Ask", "one-time", "perm_stale")).rejects.toThrow(/stale permission grant/i);
		expect(staleHarness.session.pendingGrantRequest.id).toBe(active.id);
		staleHarness.manager.denyToolPermission(staleHarness.session.id, "ask_user_choices", active.id);
		await expect(staleCall).resolves.toMatchObject({ behavior: "deny" });

		const disposedHarness = makeHarness();
		const { surface: disposedSurface } = surfaceFor(disposedHarness);
		const late = canUse(disposedSurface, "disposed");
		const disposedRequest = pending(disposedHarness);
		disposedSurface.dispose?.();
		await disposedHarness.manager.grantToolPermission(disposedHarness.session.id, "ask_user_choices", "tool", "Ask", "one-time", disposedRequest.id);
		await expect(late).resolves.toMatchObject({ behavior: "deny" });
	});

	it("rejects mismatched results and blocks callback-bypass, native, foreign, never, and subagent calls", async () => {
		for (const [label, transform] of [
			["missing canonical tool", (resolution: any) => ({ ...resolution, tools: ["read"] })],
			["wrong group", (resolution: any) => ({ ...resolution, group: "Files" })],
		] as const) {
			const mismatchHarness = makeHarness();
			const { surface, resolutions } = surfaceFor(mismatchHarness, transform);
			const mismatched = canUse(surface, label);
			const request = pending(mismatchHarness);
			await mismatchHarness.manager.grantToolPermission(mismatchHarness.session.id, "ask_user_choices", "tool", "Ask", "one-time", request.id);
			await expect(mismatched).resolves.toMatchObject({ behavior: "deny" });
			expect(resolutions.at(-1)).toMatchObject({ granted: true, tools: ["ask_user_choices"], group: "Ask" });
			expect(await preUse(surface, "mcp__bobbit__ask_user_choices", label)).toEqual({ continue: true });
		}

		const defenceHarness = makeHarness();
		const { surface } = surfaceFor(defenceHarness);
		expect(await preUse(surface, "mcp__bobbit__ask_user_choices", "bypass")).toEqual({ continue: true });
		for (const name of ["Bash", "mcp__foreign__ask_user_choices", "mcp__bobbit__bash"]) {
			await expect((surface.canUseTool as any)(name, {}, { signal: new AbortController().signal, toolUseID: name })).resolves.toMatchObject({ behavior: "deny" });
			expect((await preUse(surface, name, name)).hookSpecificOutput.permissionDecision).toBe("deny");
		}
		await expect((surface.canUseTool as any)("mcp__bobbit__read", {}, { signal: new AbortController().signal, toolUseID: "child", agentID: "child" })).resolves.toMatchObject({ behavior: "deny" });
		expect((await preUse(surface, "mcp__bobbit__read", "child", { agent_id: "child" })).hookSpecificOutput.permissionDecision).toBe("deny");
	});
});
