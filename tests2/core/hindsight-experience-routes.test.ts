import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "vitest";
import YAML from "yaml";

import toolsExtension from "../../market-packs/hindsight/src/tools.ts";
import { memoryRoutes, requiredMemoryCapability, resolveMemoryScope } from "../../market-packs/hindsight/src/memory-routes.ts";
import { routes, __setClientFactory } from "../../market-packs/hindsight/src/routes.ts";
import { CONFIG_KEY, type StoreLike } from "../../market-packs/hindsight/src/shared.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packRoot = path.join(root, "market-packs/hindsight");

class MemoryStore implements StoreLike {
	private readonly values = new Map<string, unknown>();
	async get<T>(key: string): Promise<T | null> { return this.values.has(key) ? this.values.get(key) as T : null; }
	async read<T>(key: string) { return this.values.has(key) ? { state: "present" as const, value: this.values.get(key) as T } : { state: "absent" as const }; }
	async put<T>(key: string, value: T): Promise<void> { this.values.set(key, value); }
}

function configuredStore(): MemoryStore {
	const store = new MemoryStore();
	void store.put(CONFIG_KEY, { runtimeMode: "external", externalUrl: "http://127.0.0.1:8848" });
	return store;
}

afterEach(() => __setClientFactory(null));

describe("Hindsight typed memory routes and tool adapters", () => {
	it("derives narrow scope from the host and requires the exact live read grant", async () => {
		const store = configuredStore();
		const capabilities: string[] = [];
		const scope = resolveMemoryScope({ host: { store }, scopeContext: { project: { id: "project-a" }, goal: { id: "goal-a" } } }, {
			body: { projectId: "forged-project", scopeContext: { project: { id: "forged" } }, scope: "all" },
		});
		assert.deepEqual(scope, { projectId: "project-a", goalId: "goal-a", all: true });
		assert.equal(requiredMemoryCapability("recall", { body: { scope: "all" } }), "memory.read.all");
		assert.equal(requiredMemoryCapability("recall", { body: {} }), "memory.read");
		assert.equal(requiredMemoryCapability("retain", { body: {} }), "memory.write");
		assert.equal(requiredMemoryCapability("reflect", { body: {} }), "memory.reflect");
		assert.equal(requiredMemoryCapability("invalidate", { body: {} }), "memory.invalidate");

		const denied = await memoryRoutes.browse({
			host: { store, memory: { requireCapability: capability => { capabilities.push(capability); return { allowed: false, reason: "denied" }; } } },
			scopeContext: { project: { id: "project-a" } },
		}, { body: { query: "only this project" } });
		assert.deepEqual(capabilities, ["memory.read"]);
		assert.deepEqual(denied, { configured: true, code: "EXTENSION_CAPABILITY_DENIED", memories: [] });
	});

	it("rechecks a live read grant after delayed client construction before dispatching", async () => {
		const store = configuredStore();
		let allowed = true;
		let browseCalls = 0;
		__setClientFactory(async () => {
			await Promise.resolve();
			allowed = false; // Models a grant revoked while makeClient yields.
			return { browse: async () => { browseCalls++; return { memories: [] }; } } as any;
		});

		const result = await memoryRoutes.browse({
			host: { store, memory: { requireCapability: () => allowed ? { allowed: true as const } : { allowed: false as const, reason: "denied" as const } } },
			scopeContext: { project: { id: "project-a" } },
		}, { body: {} });

		assert.deepEqual(result, { configured: true, code: "EXTENSION_CAPABILITY_DENIED", memories: [] });
		assert.equal(browseCalls, 0, "a revoked post-construction grant must prevent the client call");
	});

	it("rechecks grants between compound route operations without changing successful dispatch", async () => {
		const store = configuredStore();
		let capability: "memory.read" | "memory.write" | "memory.invalidate" = "memory.write";
		let allowed = true;
		const calls = { ensure: 0, retain: 0, detail: 0, history: 0, invalidate: 0 };
		const grant = (requested: string) => requested === capability && allowed
			? { allowed: true as const }
			: { allowed: false as const, reason: "denied" as const };

		__setClientFactory(() => ({
			ensureBank: async () => { calls.ensure++; },
			retain: async () => { calls.retain++; },
			detail: async () => { calls.detail++; return { id: "memory-a", tags: ["project:project-a"] }; },
			history: async () => { calls.history++; return { history: [] }; },
			invalidateMemory: async () => { calls.invalidate++; },
		}) as any);
		const context = { host: { store, memory: { requireCapability: grant } }, scopeContext: { project: { id: "project-a" } } };

		// A live grant preserves normal compound write success.
		assert.deepEqual(await memoryRoutes.retain(context, { body: { content: "keep this" } }), { ok: true, configured: true });
		assert.deepEqual(calls, { ensure: 1, retain: 1, detail: 0, history: 0, invalidate: 0 });

		// Revocation while ensureBank is awaited must prevent retain.
		allowed = true;
		__setClientFactory(() => ({
			ensureBank: async () => { calls.ensure++; allowed = false; },
			retain: async () => { calls.retain++; },
		}) as any);
		assert.deepEqual(await memoryRoutes.retain(context, { body: { content: "do not retain" } }), { ok: false, configured: true, code: "EXTENSION_CAPABILITY_DENIED" });
		assert.equal(calls.retain, 1, "no retain follows an ensureBank-time revocation");

		// Read and destructive compounds recheck after their detail disclosure.
		capability = "memory.read";
		allowed = true;
		__setClientFactory(() => ({
			detail: async () => { calls.detail++; allowed = false; return { id: "memory-a", tags: ["project:project-a"] }; },
			history: async () => { calls.history++; return { history: [] }; },
		}) as any);
		assert.deepEqual(await memoryRoutes.history(context, { body: { id: "memory-a" } }), { configured: true, code: "EXTENSION_CAPABILITY_DENIED", history: [] });
		assert.equal(calls.history, 0, "history must not follow a revoked detail grant");

		capability = "memory.invalidate";
		allowed = true;
		__setClientFactory(() => ({
			detail: async () => { calls.detail++; allowed = false; return { id: "memory-a", tags: ["project:project-a"] }; },
			invalidateMemory: async () => { calls.invalidate++; },
		}) as any);
		assert.deepEqual(await memoryRoutes.invalidate(context, { body: { id: "memory-a", confirmation: "memory-a" } }), { ok: false, configured: true, code: "EXTENSION_CAPABILITY_DENIED", id: "memory-a" });
		assert.equal(calls.invalidate, 0, "invalidation must not follow a revoked detail grant");
	});

	it("marks unhealthy and client failures from mutating routes as explicit failures", async () => {
		const store = new MemoryStore();
		await store.put(CONFIG_KEY, { runtimeMode: "local" });
		const unhealthyContext = {
			host: { store, memory: { requireCapability: () => ({ allowed: true as const }) } },
			scopeContext: { project: { id: "project-a" } },
			runtime: { state: "degraded" as const },
		};
		assert.deepEqual(await memoryRoutes.retain(unhealthyContext, { body: { content: "must remain editable" } }), { ok: false, configured: true, code: "SERVICE_UNHEALTHY" });
		assert.deepEqual(await memoryRoutes.invalidate(unhealthyContext, { body: { id: "memory-a", confirmation: "memory-a" } }), { ok: false, configured: true, code: "SERVICE_UNHEALTHY" });

		const activeStore = configuredStore();
		__setClientFactory(() => { throw new Error("service disconnected during mutation"); });
		const activeContext = {
			host: { store: activeStore, memory: { requireCapability: () => ({ allowed: true as const }) } },
			scopeContext: { project: { id: "project-a" } },
		};
		assert.deepEqual(await memoryRoutes.retain(activeContext, { body: { content: "must remain editable" } }), { ok: false, configured: true, code: "SERVICE_UNHEALTHY" });
		assert.deepEqual(await memoryRoutes.invalidate(activeContext, { body: { id: "memory-a", confirmation: "memory-a" } }), { ok: false, configured: true, code: "SERVICE_UNHEALTHY" });
	});

	it("uses the real server completion envelope, ignores body content, and repeats a stable outcome document", async () => {
		const store = new MemoryStore();
		const received: Array<{ content?: string; tags?: Record<string, string>; id?: string }> = [];
		__setClientFactory(() => ({
			health: async () => ({ ok: true }), ensureBank: async () => {}, recall: async () => ({ memories: [] }),
			retain: async (_bank, content, options) => { received.push({ content, tags: options?.tags, id: options?.id }); },
			reflect: async () => ({ text: "" }), listBanks: async () => ({ banks: [] }),
			browse: async () => ({ memories: [{ id: "m", text: "injected config" }] }),
		}));
		const context = {
			host: {
				store,
				providerConfig: { runtimeMode: "external", externalUrl: "http://127.0.0.1:8848" },
				completedOutcome: {
					outcome: {
						version: 1,
						goal: { id: "goal-a", title: "Ship retention", state: "complete", spec: "Preserve the real snapshot" },
						tasks: [{ id: "task-a", title: "Retain result", state: "complete", resultSummary: "verified" }],
						gates: [{ id: "gate-a", status: "passed", content: "all checks pass" }],
					},
					completedAt: 1_700_000_000_000,
					completionRevision: 1_700_000_000_000,
				},
				memory: { requireCapability: () => ({ allowed: true as const }) },
			},
			scopeContext: { project: { id: "project-a" }, goal: { id: "goal-a" } },
		};
		const browse = await memoryRoutes.browse(context, { body: {} });
		assert.deepEqual(browse, { configured: true, memories: [{ id: "m", text: "injected config" }] });
		const first = await memoryRoutes["retain-outcome"](context, { body: { content: "forged body text", goal: "forged-goal", completionRevision: "forged" } });
		const second = await memoryRoutes["retain-outcome"](context, { body: { content: "different forged body" } });
		assert.deepEqual(second, first);
		assert.deepEqual(received.map(call => call.id), [(first as { outcomeId: string }).outcomeId, (first as { outcomeId: string }).outcomeId]);
		assert.deepEqual(received.map(call => call.tags), [{ kind: "outcome", project: "project-a", goal: "goal-a" }, { kind: "outcome", project: "project-a", goal: "goal-a" }]);
		assert.match(received[0]!.content ?? "", /Goal title: Ship retention/);
		assert.match(received[0]!.content ?? "", /Task: Retain result — complete — verified/);
		assert.doesNotMatch(received[0]!.content ?? "", /forged body|forged-goal/);

		const unavailable = await memoryRoutes["retain-outcome"]({ ...context, host: { ...context.host, completedOutcome: undefined } }, { body: {} });
		assert.deepEqual(unavailable, { ok: false, configured: true, code: "OUTCOME_UNAVAILABLE" });
	});

	it("registers every exported memory route, including the required browse surface", async () => {
		const manifest = YAML.parse(fs.readFileSync(path.join(packRoot, "pack.yaml"), "utf8")) as { routes: { names: string[] } };
		const registeredRouteNames = new Set(manifest.routes.names);
		const exportedMemoryRouteNames = Object.keys(memoryRoutes);
		assert.deepEqual(exportedMemoryRouteNames.filter(routeName => !registeredRouteNames.has(routeName)), []);
		for (const routeName of ["browse", "search", "detail", "history"]) {
			assert.ok(registeredRouteNames.has(routeName), `${routeName} must be available to the panel`);
		}
		for (const routeName of exportedMemoryRouteNames) {
			assert.equal(typeof (routes as Record<string, unknown>)[routeName], "function");
		}

		const store = new MemoryStore();
		await store.put(CONFIG_KEY, { runtimeMode: "local" });
		__setClientFactory(() => { throw new Error("a degraded runtime must not dispatch a data-plane client"); });
		const result = await memoryRoutes.browse({
			host: { store, memory: { requireCapability: () => ({ allowed: true }) } },
			scopeContext: { project: { id: "project-a" } },
			runtime: { state: "degraded", diagnostic: { code: "SERVICE_UNHEALTHY" } },
		}, { body: {} });
		assert.deepEqual(result, { configured: true, code: "SERVICE_UNHEALTHY" });
		assert.equal(typeof routes.recall, "function");
	});

	it("ships exactly five registered tools that dispatch only their corresponding typed route", async () => {
		const registered: Array<{ name: string; execute: (id: string, params: any, signal?: AbortSignal) => Promise<unknown> }> = [];
		(toolsExtension as any)({ registerTool: (tool: any) => registered.push(tool) });
		const names = ["hindsight_recall", "hindsight_retain", "hindsight_reflect", "hindsight_invalidate", "hindsight_retain_outcome"];
		assert.deepEqual(registered.map(tool => tool.name), names);
		const toolDir = path.join(packRoot, "tools/hindsight");
		assert.deepEqual(fs.readdirSync(toolDir).filter(file => file.endsWith(".yaml")).sort(), names.map(name => `${name}.yaml`).sort());

		const previousFetch = globalThis.fetch;
		const previousToken = process.env.BOBBIT_TOKEN;
		const previousUrl = process.env.BOBBIT_GATEWAY_URL;
		const previousSession = process.env.BOBBIT_SESSION_ID;
		const dispatched: string[] = [];
		process.env.BOBBIT_TOKEN = "test-token";
		process.env.BOBBIT_GATEWAY_URL = "http://gateway.test";
		process.env.BOBBIT_SESSION_ID = "session-a";
		globalThis.fetch = (async (input: string | URL) => {
			const url = String(input);
			if (url.endsWith("/api/ext/surface-token")) return new Response(JSON.stringify({ token: "surface" }), { status: 200 });
			dispatched.push(decodeURIComponent(url.slice(url.lastIndexOf("/") + 1)));
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		}) as typeof fetch;
		try {
			await registered[0]!.execute("id", { query: "q" });
			await registered[1]!.execute("id", { content: "c" });
			await registered[2]!.execute("id", { prompt: "p" });
			await registered[3]!.execute("id", { id: "memory-1", confirmation: "memory-1" });
			await registered[4]!.execute("id", {});
		} finally {
			globalThis.fetch = previousFetch;
			if (previousToken === undefined) delete process.env.BOBBIT_TOKEN; else process.env.BOBBIT_TOKEN = previousToken;
			if (previousUrl === undefined) delete process.env.BOBBIT_GATEWAY_URL; else process.env.BOBBIT_GATEWAY_URL = previousUrl;
			if (previousSession === undefined) delete process.env.BOBBIT_SESSION_ID; else process.env.BOBBIT_SESSION_ID = previousSession;
		}
		assert.deepEqual(dispatched, ["recall", "retain", "reflect", "invalidate", "retain-outcome"]);
	});
});
