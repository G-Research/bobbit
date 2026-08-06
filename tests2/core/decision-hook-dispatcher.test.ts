import { describe, expect, it } from "vitest";
import { ActionError } from "../../src/server/extension-host/action-dispatcher.ts";
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

	it("isolates selection timeout, throw, and malformed output while applying a valid selection", async () => {
		const timeout = hook("timeout", "/packs/timeout");
		const throwing = hook("throwing", "/packs/throwing");
		const malformed = hook("malformed", "/packs/malformed");
		const valid = hook("valid", "/packs/valid");
		const hooks = [timeout, throwing, malformed, valid];
		const dispatcher = new DecisionHookDispatcher({
			manager: { setContinuation: () => {}, registerProject: () => {} } as any,
			registry: {
				list: () => hooks.map(item => ({ packId: item.packRoot.split("/").at(-1), hooks: [item] })),
				listHooks: () => hooks,
			} as any,
			moduleHost: {
				invoke: async (request: any) => {
					switch (request.packRoot) {
						case "/packs/timeout": throw new ActionError(504, "timed out");
						case "/packs/throwing": throw new Error("hook crashed");
						case "/packs/malformed": return { kind: "selection", selection: { kind: "thinking", thinkingLevel: "not-a-level" } };
						default: return { kind: "selection", selection: { kind: "thinking", thinkingLevel: "high" } };
					}
				},
			} as any,
			grantsForProject: () => hooks.map(item => ({ packId: item.packRoot.split("/").at(-1), hookId: item.id, capability: "decide", grantedAt: "2026-01-01T00:00:00.000Z", grantedBy: "user" })) as any,
			availabilityForProject: () => ({ models: [], thinkingLevels: ["high"], roles: [], workflows: [] }),
			thinkingConsumer: { apply: async () => ({ status: "applied", effectiveThinkingLevel: "high" }) } as any,
		});

		const outcomes = await dispatcher.dispatch("afterTurn", base);
		expect(outcomes).toHaveLength(4);
		expect(outcomes).toEqual(expect.arrayContaining([
			expect.objectContaining({ hookId: "timeout", outcome: "dropped", reason: "Timed out" }),
			expect.objectContaining({ hookId: "throwing", outcome: "error" }),
			expect.objectContaining({ hookId: "malformed", outcome: "dropped", reason: "Malformed result" }),
			expect.objectContaining({ hookId: "valid", outcome: "applied", selectionKind: "thinking", selectionValue: "high" }),
		]));
	});

	it("isolates per-hook registry and grant reads before imports", async () => {
		const registryFailure = hook("registry-failure", "/packs/registry-failure");
		const grantFailure = hook("grant-failure", "/packs/grant-failure");
		const valid = hook("valid", "/packs/valid");
		const hooks = [registryFailure, grantFailure, valid];
		const packs = hooks.map(item => ({ packId: item.packRoot.split("/").at(-1)!, hooks: [item] }));
		let registryReads = 0;
		let grantReads = 0;
		let imports = 0;
		const grants = hooks.map(item => ({ packId: item.packRoot.split("/").at(-1), hookId: item.id, capability: "decide", grantedAt: "2026-01-01T00:00:00.000Z", grantedBy: "user" }));
		const dispatcher = new DecisionHookDispatcher({
			manager: { setContinuation: () => {}, registerProject: () => {} } as any,
			registry: {
				list: () => {
					if (++registryReads === 2) throw new Error("registry unavailable");
					return packs;
				},
				listHooks: () => hooks,
			} as any,
			moduleHost: { invoke: async () => { imports++; return { kind: "selection", selection: { kind: "thinking", thinkingLevel: "high" } }; } } as any,
			grantsForProject: () => {
				if (++grantReads === 1) throw new Error("grant lookup unavailable");
				return grants as any;
			},
			availabilityForProject: () => ({ models: [], thinkingLevels: ["high"], roles: [], workflows: [] }),
			thinkingConsumer: { apply: async () => ({ status: "applied", effectiveThinkingLevel: "high" }) } as any,
		});

		const outcomes = await dispatcher.dispatch("afterTurn", base);
		expect(imports).toBe(1);
		expect(outcomes).toHaveLength(3);
		expect(outcomes).toEqual(expect.arrayContaining([
			expect.objectContaining({ hookId: "registry-failure", outcome: "error" }),
			expect.objectContaining({ hookId: "grant-failure", outcome: "error" }),
			expect.objectContaining({ hookId: "valid", outcome: "applied", selectionKind: "thinking", selectionValue: "high" }),
		]));
	});
});
