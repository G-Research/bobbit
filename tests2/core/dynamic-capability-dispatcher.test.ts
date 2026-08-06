import { describe, expect, it } from "vitest";
import { DecisionHookDispatcher } from "../../src/server/agent/decision-request-manager.ts";
import { LifecycleHub } from "../../src/server/agent/lifecycle-hub.ts";
import { ContextTraceStore } from "../../src/server/agent/context-trace-store.ts";

const context = {
	event: "sessionSetup" as const,
	projectId: "project-a",
	sessionId: "session-a",
	cwd: "/work",
	query: "help me test",
	available: ["allowed", "other"],
};

function selector(id: string, packId: string, selectors: readonly ("skills" | "mcp")[]): any {
	return {
		id, listName: id, packRoot: `/packs/${packId}`, sourceFile: `/packs/${packId}/hooks/${id}.yaml`, module: "index.mjs",
		mode: "decide", events: ["sessionSetup"], selectors, capabilities: [], budget: { timeoutMs: 100, maxTokens: 10 },
	};
}

function grant(packId: string, hookId: string): any {
	return { packId, hookId, capability: "decide", grantedAt: "2026-01-01T00:00:00.000Z", grantedBy: "user" };
}

describe("dynamic capability decision dispatch", () => {
	it("calls only declared, granted stage exports and reduces additions against the core ceiling", async () => {
		const skills = selector("skill-selector", "skill-pack", ["skills"]);
		const mcp = selector("mcp-selector", "mcp-pack", ["mcp"]);
		const invocations: any[] = [];
		const dispatcher = new DecisionHookDispatcher({
			manager: { setContinuation: () => {}, registerProject: () => {} } as any,
			registry: {
				list: () => [{ packId: "skill-pack", hooks: [skills] }, { packId: "mcp-pack", hooks: [mcp] }],
				listHooks: () => [skills, mcp],
			} as any,
			moduleHost: { invoke: async (request: any) => {
				invocations.push(request);
				return { add: [request.member === "selectSkills" ? "allowed" : "other", "forbidden"], reason: "never traced", confidence: 1 };
			} } as any,
			grantsForProject: () => [grant("skill-pack", "skill-selector"), grant("mcp-pack", "mcp-selector")],
		});

		const skillResult = await dispatcher.selectCapabilities("skills", context);
		expect(skillResult).toMatchObject({ selected: ["allowed"], authoritative: true });
		expect(invocations).toHaveLength(1);
		expect(invocations[0]).toMatchObject({ member: "selectSkills", ctx: { event: "sessionSetup", available: ["allowed", "other"] } });
		expect(Object.isFrozen(invocations[0].ctx)).toBe(true);

		const mcpResult = await dispatcher.selectCapabilities("mcp", { ...context, available: ["other"], selectedSkills: skillResult.selected });
		expect(mcpResult).toMatchObject({ selected: ["other"], authoritative: true });
		expect(invocations).toHaveLength(2);
		expect(invocations[1]).toMatchObject({ member: "selectMcp", ctx: { selectedSkills: ["allowed"] } });
	});

	it("marks a valid explicit-empty proposal authoritative so it can deny the optional stage", async () => {
		const hook = selector("empty", "pack", ["skills"]);
		const dispatcher = new DecisionHookDispatcher({
			manager: { setContinuation: () => {}, registerProject: () => {} } as any,
			registry: { list: () => [{ packId: "pack", hooks: [hook] }], listHooks: () => [hook] } as any,
			moduleHost: { invoke: async () => ({ add: [], reason: "intentionally empty", confidence: 1 }) } as any,
			grantsForProject: () => [grant("pack", "empty")],
		});

		await expect(dispatcher.selectCapabilities("skills", context)).resolves.toMatchObject({ selected: [], authoritative: true });
	});

	it("rechecks active grants after an isolated selector finishes", async () => {
		const hook = selector("selector", "pack", ["skills"]);
		let grants: any[] = [grant("pack", "selector")];
		const dispatcher = new DecisionHookDispatcher({
			manager: { setContinuation: () => {}, registerProject: () => {} } as any,
			registry: { list: () => [{ packId: "pack", hooks: [hook] }], listHooks: () => [hook] } as any,
			moduleHost: { invoke: async () => {
				grants = [];
				return { add: ["allowed"], reason: "never traced", confidence: 1 };
			} } as any,
			grantsForProject: () => grants,
		});

		const result = await dispatcher.selectCapabilities("skills", context);
		expect(result).toMatchObject({ selected: [], authoritative: false });
		expect(result.outcomes).toEqual([expect.objectContaining({ outcome: "denied", reason: "Grant required", capabilityStage: "skills" })]);
	});

	it("forwards selector stages through LifecycleHub without leaking dispatcher failures", async () => {
		const hub = new LifecycleHub({
			registry: { listProviders: () => [] } as any,
			moduleHost: {} as any,
			trace: new ContextTraceStore("/tmp/dynamic-capability-dispatcher-test"),
			gatewayInfo: () => ({ baseUrl: "http://gateway", token: "secret" }),
		});
		const calls: string[] = [];
		hub.setDecisionDispatcher({
			dispatch: async () => [],
			selectCapabilities: async (stage, received) => {
				expect(received.event).toBe("sessionSetup");
				calls.push(stage);
				if (stage === "mcp") throw new Error("isolated");
				return { selected: ["selected"], authoritative: true, outcomes: [{ kind: "decision", packId: "pack", hookId: "hook", event: "sessionSetup", outcome: "advised" }] } as any;
			},
		});

		await expect(hub.selectCapabilities("skills", context)).resolves.toMatchObject({ selected: ["selected"] });
		await expect(hub.selectCapabilities("mcp", { ...context, selectedSkills: ["selected"] })).resolves.toEqual({ selected: [], authoritative: false, outcomes: [] });
		expect(calls).toEqual(["skills", "mcp"]);
	});
});
