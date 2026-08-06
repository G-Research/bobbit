import { describe, expect, it } from "vitest";
import { DecisionHookDispatcher } from "../../src/server/agent/decision-request-manager.ts";

const base = { projectId: "project-a", sessionId: "session-a", cwd: "/work" };

function hook(id: string, packRoot: string): any {
	return {
		id, listName: id, packRoot, sourceFile: `${packRoot}/hooks/${id}.yaml`, module: "index.mjs",
		mode: "decide", events: ["afterTurn"], capabilities: [], budget: { timeoutMs: 100, maxTokens: 10 },
	};
}

describe("decision hook dispatcher selections", () => {
	it("reduces concurrently completed selection hooks in deterministic active-pack order", async () => {
		const hooks = [hook("z-hook", "/packs/low"), hook("a-hook", "/packs/high")];
		const registry: any = {
			list: () => [
				{ packId: "low", hooks: [hooks[0]] },
				{ packId: "high", hooks: [hooks[1]] },
			],
			listHooks: () => hooks,
		};
		const dispatcher = new DecisionHookDispatcher({
			manager: { setContinuation: () => {}, registerProject: () => {} } as any,
			registry,
			moduleHost: {
				invoke: async (request: any) => {
					if (request.packRoot === "/packs/low") await new Promise(resolve => setTimeout(resolve, 10));
					return { kind: "selection", selection: { kind: "thinking", thinkingLevel: request.packRoot === "/packs/low" ? "low" : "high" } };
				},
			} as any,
			grantsForProject: () => [
				{ packId: "low", hookId: "z-hook", capability: "decide", grantedAt: "2026-01-01T00:00:00.000Z", grantedBy: "user" },
				{ packId: "high", hookId: "a-hook", capability: "decide", grantedAt: "2026-01-01T00:00:00.000Z", grantedBy: "user" },
			] as any,
			availabilityForProject: () => ({ models: [], thinkingLevels: ["low", "high"], roles: [], workflows: [] }),
			thinkingConsumer: { apply: async () => ({ status: "applied", effectiveThinkingLevel: "high" }) } as any,
		});

		const outcomes = await dispatcher.dispatch("afterTurn", base);
		expect(outcomes).toEqual(expect.arrayContaining([
			expect.objectContaining({ packId: "low", outcome: "superseded", reason: "Lower-priority selection", selectionKind: "thinking" }),
			expect.objectContaining({ packId: "high", outcome: "applied", selectionKind: "thinking", selectionValue: "high" }),
		]));
	});

	it("does not import a hook whose exact decide grant is absent", async () => {
		let imports = 0;
		const one = hook("hook", "/packs/one");
		const dispatcher = new DecisionHookDispatcher({
			manager: { setContinuation: () => {}, registerProject: () => {} } as any,
			registry: { list: () => [{ packId: "one", hooks: [one] }], listHooks: () => [one] } as any,
			moduleHost: { invoke: async () => { imports++; return undefined; } } as any,
			grantsForProject: () => [],
		});
		await expect(dispatcher.dispatch("afterTurn", base)).resolves.toEqual([
			expect.objectContaining({ outcome: "denied", reason: "Grant required" }),
		]);
		expect(imports).toBe(0);
	});
});
