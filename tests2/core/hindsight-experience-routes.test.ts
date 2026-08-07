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

	it("prefers injected EP-7 config and retains only a host-injected completed outcome", async () => {
		const store = new MemoryStore();
		const received: Array<{ content?: string; tags?: Record<string, string>; id?: string }> = [];
		__setClientFactory(() => ({
			health: async () => ({ ok: true }), ensureBank: async () => {}, recall: async () => ({ memories: [] }),
			retain: async (_bank, content, options) => { received.push({ content, tags: options?.tags, id: options?.id }); },
			reflect: async () => ({ text: "" }), listBanks: async () => ({ banks: [] }),
			browse: async () => ({ memories: [{ id: "m", text: "injected config" }] }),
		}));
		const context = {
			host: { store, providerConfig: { runtimeMode: "external", externalUrl: "http://127.0.0.1:8848" }, completedOutcome: { id: "outcome-1", content: "goal completed" }, memory: { requireCapability: () => ({ allowed: true as const }) } },
			scopeContext: { project: { id: "project-a" }, goal: { id: "goal-a" } },
		};
		const browse = await memoryRoutes.browse(context, { body: {} });
		assert.deepEqual(browse, { configured: true, memories: [{ id: "m", text: "injected config" }] });
		const outcome = await memoryRoutes["retain-outcome"](context, { body: { content: "forged body text" } });
		assert.deepEqual(outcome, { ok: true, configured: true, outcomeId: "outcome-1" });
		assert.deepEqual(received, [{ content: "goal completed", id: "outcome-1", tags: { kind: "outcome", project: "project-a", goal: "goal-a" } }]);
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
