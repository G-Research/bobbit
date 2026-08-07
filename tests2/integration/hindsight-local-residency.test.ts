import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";

import { routes, __setClientFactory } from "../../market-packs/hindsight/src/routes.ts";
import { CONFIG_KEY, type StoreLike } from "../../market-packs/hindsight/src/shared.ts";
import { DEFAULT_HINDSIGHT_OCI_IMAGE, validateHindsightRuntimeSettings } from "../../market-packs/hindsight/src/runtime-settings.ts";

class MemoryStore implements StoreLike {
	private readonly values = new Map<string, unknown>();
	async get<T>(key: string): Promise<T | null> { return this.values.has(key) ? this.values.get(key) as T : null; }
	async read<T>(key: string) { return this.values.has(key) ? { state: "present" as const, value: this.values.get(key) as T } : { state: "absent" as const }; }
	async put<T>(key: string, value: T): Promise<void> { this.values.set(key, value); }
}

const EXTERNAL_DATABASE_URL = "postgresql://hindsight:integration-password@127.0.0.1:5432/hindsight";

function localSettings() {
	return {
		runtimeMode: "local" as const, localLlmProvider: "openai-compatible", localLlmModelId: "qwen3-coder",
		localLlmBaseUrl: "http://127.0.0.1:11434/v1", localLlmContextTokens: 32768,
		localLlmMaxOutputTokens: 4096, localLlmResidency: "resident", localLlmKeepAlive: 3600,
		ociImage: DEFAULT_HINDSIGHT_OCI_IMAGE, databaseMode: "external" as const,
	};
}

/** Direct pack-route contexts must model the live EP-6 boundary explicitly.
 * Production injects this adapter from the gateway; tests must never depend on
 * an absent adapter being treated as a grant. */
const allowMemoryCapabilities = { requireCapability: () => ({ allowed: true as const }) };

afterEach(() => __setClientFactory(null));

describe("Hindsight local resident model integration", () => {
	it("preserves resident local settings and reuses one ready runtime endpoint across retain and reflect", async () => {
		const validated = validateHindsightRuntimeSettings(localSettings(), { externalDatabaseUrl: EXTERNAL_DATABASE_URL }, true);
		assert.equal(validated.ok, true);
		if (validated.ok) assert.equal(validated.model?.residency, "resident");

		const store = new MemoryStore();
		await store.put(CONFIG_KEY, { runtimeMode: "local" });
		const calls: string[] = [];
		const endpoints: string[] = [];
		const client = {
			health: async () => ({ ok: true }), ensureBank: async () => { calls.push("ensure-bank"); },
			recall: async () => ({ memories: [] }), retain: async () => { calls.push("retain"); },
			reflect: async () => ({ text: "legacy unscoped reflection" }),
			reflectScoped: async () => { calls.push("reflect"); return { text: "reflection" }; }, listBanks: async () => ({ banks: [] }),
		};
		__setClientFactory(config => { endpoints.push(config.baseUrl); return client; });
		const context = { host: { store, memory: allowMemoryCapabilities }, scopeContext: { project: { id: "project-a" } }, runtime: { state: "ready" as const, endpoint: "http://127.0.0.1:45123" } };
		assert.deepEqual(await routes.retain(context, { body: { content: "keep resident" } }), { ok: true, configured: true });
		assert.deepEqual(await routes.reflect(context, { body: { prompt: "summarize" } }), { configured: true, text: "reflection" });
		assert.deepEqual(calls, ["ensure-bank", "retain", "reflect"]);
		assert.deepEqual(endpoints, ["http://127.0.0.1:45123", "http://127.0.0.1:45123"]);
	});

	it("returns promptly for a down local runtime without constructing a fallback client", async () => {
		const store = new MemoryStore();
		await store.put(CONFIG_KEY, { runtimeMode: "local" });
		let clientConstructed = false;
		__setClientFactory(() => { clientConstructed = true; throw new Error("unexpected fallback"); });
		const context = { host: { store, memory: allowMemoryCapabilities }, scopeContext: { project: { id: "project-a" } }, runtime: { state: "degraded" as const, diagnostic: { code: "SERVICE_UNHEALTHY" } } };
		assert.deepEqual(await routes.recall(context, { body: { query: "do not hang" } }), { configured: true, code: "SERVICE_UNHEALTHY" });
		assert.deepEqual(await routes.retain(context, { body: { content: "do not write" } }), { ok: false, configured: true, code: "SERVICE_UNHEALTHY" });
		assert.deepEqual(await routes.reflect(context, { body: { prompt: "do not reflect" } }), { configured: true, code: "SERVICE_UNHEALTHY" });
		assert.equal(clientConstructed, false);
	});
});
