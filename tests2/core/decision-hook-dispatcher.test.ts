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
	it("dispatches a durable project import once with no session context", async () => {
		const imported = hook("import-hook", "/packs/import");
		imported.events = ["projectImported"];
		const run: any = {
			id: "import-1", projectId: "project-a", createdAt: "2026-01-01T00:00:00.000Z",
			context: { event: "projectImported", projectId: "project-a", importId: "import-1", projectRoot: "/project", ownedRoots: ["/project"], components: [] },
			hooks: {},
		};
		let imports = 0;
		const manager: any = {
			setContinuation: () => {}, registerProject: () => {}, getImportRun: () => run,
			ensureImportHooks: (_projectId: string, _importId: string, keys: string[]) => {
				for (const key of keys) run.hooks[key] ??= { state: "pending" };
				return structuredClone(run);
			},
			completeImportHook: (_projectId: string, _importId: string, key: string, outcome: string) => {
				if (run.hooks[key]?.state !== "pending") return false;
				run.hooks[key] = { state: "completed", outcome, completedAt: "2026-01-01T00:00:01.000Z" };
				return true;
			},
		};
		const dispatcher = new DecisionHookDispatcher({
			manager,
			registry: { list: () => [{ packId: "import", hooks: [imported] }], listHooks: () => [imported] } as any,
			moduleHost: { invoke: async (request: any) => { imports++; expect(request.ctx).toEqual(expect.objectContaining({ event: "projectImported", importId: "import-1" })); expect(request.ctx.sessionId).toBeUndefined(); return undefined; } } as any,
			grantsForProject: () => [{ packId: "import", hookId: "import-hook", capability: "decide", grantedAt: "2026-01-01T00:00:00.000Z", grantedBy: "user" }] as any,
		});

		await expect(dispatcher.dispatchProjectImport("project-a", "import-1")).resolves.toEqual([expect.objectContaining({ event: "projectImported", outcome: "applied" })]);
		await expect(dispatcher.dispatchProjectImport("project-a", "import-1")).resolves.toEqual([]);
		expect(imports).toBe(1);
	});

	it("keeps an import hook pending until an operator grant can replay its durable run", async () => {
		const imported = hook("import-hook", "/packs/import");
		imported.events = ["projectImported"];
		const run: any = {
			id: "import-1", projectId: "project-a", createdAt: "2026-01-01T00:00:00.000Z",
			context: { event: "projectImported", projectId: "project-a", importId: "import-1", projectRoot: "/project", ownedRoots: ["/project"], components: [] },
			hooks: {},
		};
		let granted = false;
		let imports = 0;
		const manager: any = {
			setContinuation: () => {}, registerProject: () => {}, getImportRun: () => run,
			ensureImportHooks: (_projectId: string, _importId: string, keys: string[]) => {
				for (const key of keys) run.hooks[key] ??= { state: "pending" };
				return structuredClone(run);
			},
			completeImportHook: (_projectId: string, _importId: string, key: string, outcome: string) => {
				if (run.hooks[key]?.state !== "pending") return false;
				run.hooks[key] = { state: "completed", outcome };
				return true;
			},
		};
		const dispatcher = new DecisionHookDispatcher({
			manager,
			registry: { list: () => [{ packId: "import", hooks: [imported] }], listHooks: () => [imported] } as any,
			moduleHost: { invoke: async () => { imports++; return undefined; } } as any,
			grantsForProject: () => granted
				? [{ packId: "import", hookId: "import-hook", capability: "decide", grantedAt: "2026-01-01T00:00:00.000Z", grantedBy: "admin" }] as any
				: [],
		});

		await expect(dispatcher.dispatchProjectImport("project-a", "import-1")).resolves.toEqual([expect.objectContaining({ outcome: "denied", reason: "Grant required" })]);
		expect(run.hooks["import:import-hook"]).toEqual({ state: "pending" });
		expect(imports).toBe(0);

		granted = true;
		await expect(dispatcher.dispatchProjectImport("project-a", "import-1")).resolves.toEqual([expect.objectContaining({ outcome: "applied" })]);
		expect(imports).toBe(1);
	});

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

	it("dispatches the setup selector once, reduces by active-pack priority, and never sends it to the live consumer", async () => {
		const low = hook("low", "/packs/low");
		const high = hook("high", "/packs/high");
		low.events = ["sessionSetup"];
		high.events = ["sessionSetup"];
		let imports = 0;
		const apply = async () => { throw new Error("setup advice must not use the live afterTurn consumer"); };
		const dispatcher = new DecisionHookDispatcher({
			manager: { setContinuation: () => {}, registerProject: () => {} } as any,
			registry: { list: () => [{ packId: "low", hooks: [low] }, { packId: "high", hooks: [high] }], listHooks: () => [low, high] } as any,
			moduleHost: {
				invoke: async (request: any) => {
					imports++;
					if (request.packRoot === "/packs/low") await new Promise(resolve => setTimeout(resolve, 10));
					return { kind: "selection", selection: { kind: "thinking", thinkingLevel: request.packRoot === "/packs/low" ? "low" : "high" } };
				},
			} as any,
			grantsForProject: () => [
				{ packId: "low", hookId: "low", capability: "decide", grantedAt: "2026-01-01T00:00:00.000Z", grantedBy: "user" },
				{ packId: "high", hookId: "high", capability: "decide", grantedAt: "2026-01-01T00:00:00.000Z", grantedBy: "user" },
			] as any,
			availabilityForProject: () => ({ models: [], thinkingLevels: ["low", "high"], roles: [], workflows: [] }),
			thinkingConsumer: { apply } as any,
		});

		const result: any = await (dispatcher as any).dispatchSetup(base);
		expect(imports).toBe(2);
		expect(result.thinkingLevel).toBe("high");
		expect(result.outcomes).toEqual(expect.arrayContaining([
			expect.objectContaining({ packId: "low", outcome: "superseded", selectionKind: "thinking" }),
			expect.objectContaining({ packId: "high", outcome: "advised", selectionKind: "thinking", selectionValue: "high" }),
		]));
	});

	it("does not import or return a setup candidate without an exact active decide grant", async () => {
		const selector = hook("default-thinking", "/packs/thinking-selector");
		selector.events = ["sessionSetup"];
		let imports = 0;
		const dispatcher = new DecisionHookDispatcher({
			manager: { setContinuation: () => {}, registerProject: () => {} } as any,
			registry: { list: () => [{ packId: "thinking-selector", hooks: [selector] }], listHooks: () => [selector] } as any,
			moduleHost: { invoke: async () => { imports++; return { kind: "selection", selection: { kind: "thinking", thinkingLevel: "medium" } }; } } as any,
			grantsForProject: () => [],
			availabilityForProject: () => ({ models: [], thinkingLevels: ["medium"], roles: [], workflows: [] }),
		});

		const result: any = await (dispatcher as any).dispatchSetup(base);
		expect(imports).toBe(0);
		expect(result).toMatchObject({ outcomes: [expect.objectContaining({ outcome: "denied", reason: "Grant required" })] });
		expect(result.thinkingLevel).toBeUndefined();
	});

	it("rejects a setup candidate when the exact grant is revoked while its worker runs", async () => {
		const selector = hook("default-thinking", "/packs/thinking-selector");
		selector.events = ["sessionSetup"];
		let granted = true;
		let release!: () => void;
		let started!: () => void;
		const workerStarted = new Promise<void>(resolve => { started = resolve; });
		const workerReleased = new Promise<void>(resolve => { release = resolve; });
		const dispatcher = new DecisionHookDispatcher({
			manager: { setContinuation: () => {}, registerProject: () => {} } as any,
			registry: { list: () => [{ packId: "thinking-selector", hooks: [selector] }], listHooks: () => [selector] } as any,
			moduleHost: { invoke: async () => { started(); await workerReleased; return { kind: "selection", selection: { kind: "thinking", thinkingLevel: "medium" } }; } } as any,
			grantsForProject: () => granted ? [{ packId: "thinking-selector", hookId: "default-thinking", capability: "decide", grantedAt: "2026-01-01T00:00:00.000Z", grantedBy: "user" }] as any : [],
			availabilityForProject: () => ({ models: [], thinkingLevels: ["medium"], roles: [], workflows: [] }),
		});

		const pending = (dispatcher as any).dispatchSetup(base);
		await workerStarted;
		granted = false;
		release();
		const result: any = await pending;
		expect(result.thinkingLevel).toBeUndefined();
		expect(result.outcomes).toEqual([expect.objectContaining({ outcome: "denied", reason: "Grant required", selectionKind: "thinking" })]);
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

	it("keeps unscheduled decisions dispatchable while excluding advisor every-N hooks", async () => {
		const ordinary = hook("ordinary", "/packs/ordinary");
		const wallClockOnly = hook("wall-clock", "/packs/wall-clock");
		wallClockOnly.schedule = { wallClockMs: 100 };
		const kindOnly = hook("kind-only", "/packs/kind-only");
		kindOnly.schedule = { kind: "decision" };
		const advisorEveryN = hook("advisor-every-n", "/packs/advisor");
		advisorEveryN.schedule = { everyNTurns: 3 };
		const hooks = [ordinary, wallClockOnly, kindOnly, advisorEveryN];
		const imports: string[] = [];
		const dispatcher = new DecisionHookDispatcher({
			manager: { setContinuation: () => {}, registerProject: () => {} } as any,
			registry: { list: () => hooks.map(item => ({ packId: item.id, hooks: [item] })), listHooks: () => hooks } as any,
			moduleHost: { invoke: async (request: any) => { imports.push(request.member); return undefined; } } as any,
			grantsForProject: () => hooks.map(item => ({ packId: item.id, hookId: item.id, capability: "decide", grantedAt: "2026-01-01T00:00:00.000Z", grantedBy: "user" })) as any,
		});

		await expect(dispatcher.dispatch("afterTurn", base)).resolves.toEqual([]);
		expect(imports).toEqual(["decide", "decide", "decide"]);
	});

	it("runs a scheduled decision only at its persisted due turn and fences a late revocation", async () => {
		const scheduled = hook("staff-improvement", "/packs/staff");
		scheduled.schedule = { everyNTurns: 3, kind: "decision" };
		let granted = true;
		let imports = 0;
		let release!: () => void;
		let started!: () => void;
		const entered = new Promise<void>(resolve => { started = resolve; });
		const blocked = new Promise<void>(resolve => { release = resolve; });
		const created: unknown[] = [];
		const dispatcher = new DecisionHookDispatcher({
			manager: { setContinuation: () => {}, registerProject: () => {}, create: async (_origin: unknown, request: unknown) => { created.push(request); return { status: "created" }; } } as any,
			registry: { list: () => [{ packId: "staff", hooks: [scheduled] }], listHooks: () => [scheduled] } as any,
			moduleHost: { invoke: async () => { imports++; started(); await blocked; return { kind: "advisory", advisory: { version: 1, staffId: "staff", key: "suggestion", title: "Suggestion", body: "Use an editable draft." } }; } } as any,
			grantsForProject: () => granted ? [{ packId: "staff", hookId: "staff-improvement", capability: "decide", grantedAt: "2026-01-01T00:00:00.000Z", grantedBy: "user" }] as any : [],
		});

		await expect(dispatcher.dispatch("afterTurn", { ...base, turnIndex: 99, cadenceTurnIndex: 2 })).resolves.toEqual([]);
		expect(imports).toBe(0);
		const pending = dispatcher.dispatch("afterTurn", { ...base, turnIndex: 1, cadenceTurnIndex: 3 });
		await entered;
		granted = false;
		release();
		await expect(pending).resolves.toEqual([expect.objectContaining({ outcome: "denied", reason: "Grant required" })]);
		expect(created).toEqual([]);
	});
});
