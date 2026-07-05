/**
 * Unit tests for `syncCustomProviderModelsJson()` / `removeCustomProviderModelsJsonEntry()`
 * (model-registry.ts) — the models.json bridge for custom local providers
 * (Ollama / LM Studio / vLLM / llama.cpp / manual).
 *
 * Bug this pins: `getAvailableModels()` (browser picker, title-gen, image-gen)
 * has always read the `customProviders` preference directly and could see a
 * configured Ollama/vLLM/etc. server. But the spawned `pi-coding-agent`
 * subprocess that actually RUNS a session has its own, separate model
 * registry sourced from `~/.bobbit/agent/models.json` and never consulted
 * `customProviders` at all — so a custom provider's models showed up as
 * "authenticated" in the picker while every session that selected one
 * failed at spawn with `Model "<provider>/<id>" not found. Use
 * --list-models to see available models.` (reproduced live against a real
 * local Ollama server — see PR description). `syncCustomProviderModelsJson`
 * is the fix: it discovers each configured custom provider's models and
 * writes them into models.json under a per-provider key, mirroring how
 * aigw-manager.ts's `writeAigwModelsJson` already does this for the AI
 * Gateway path.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let tmp: string;
let stateDir: string;
let previousAgentDir: string | undefined;

before(() => {
	tmp = mkdtempSync(path.join(tmpdir(), "bobbit-custom-provider-sync-"));
	stateDir = path.join(tmp, "state");
	mkdirSync(stateDir, { recursive: true });
	previousAgentDir = process.env.BOBBIT_AGENT_DIR;
	process.env.BOBBIT_AGENT_DIR = tmp;
});

after(() => {
	if (previousAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR;
	else process.env.BOBBIT_AGENT_DIR = previousAgentDir;
	rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
	const f = path.join(tmp, "models.json");
	if (existsSync(f)) rmSync(f);
	const prefsFile = path.join(stateDir, "preferences.json");
	if (existsSync(prefsFile)) rmSync(prefsFile);
});

const { syncCustomProviderModelsJson, removeCustomProviderModelsJsonEntry } =
	await import("../src/server/agent/model-registry.js");
const { PreferencesStore } = await import("../src/server/agent/preferences-store.js");

function readModels(): any {
	const f = path.join(tmp, "models.json");
	if (!existsSync(f)) return null;
	return JSON.parse(readFileSync(f, "utf-8"));
}

/** A minimal OpenAI-compat mock server serving GET /v1/models — same surface Ollama/vLLM/llama.cpp expose. */
function startMockOpenAICompatServer(modelIds: string[]): Promise<{ url: string; close: () => Promise<void> }> {
	const server = http.createServer((req, res) => {
		if (req.url?.endsWith("/v1/models")) {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				data: modelIds.map(id => ({ id, object: "model", created: 1700000000, owned_by: "local" })),
			}));
			return;
		}
		res.writeHead(404);
		res.end();
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as any).port;
			resolve({
				url: `http://127.0.0.1:${port}`,
				close: () => new Promise<void>((r) => server.close(() => r())),
			});
		});
	});
}

describe("syncCustomProviderModelsJson — custom local provider models.json bridge", () => {
	it("no custom providers configured, none ever were → models.json is never written", async () => {
		const prefs = new PreferencesStore(stateDir);
		await syncCustomProviderModelsJson(prefs as any);
		assert.equal(readModels(), null, "models.json must not be created when there is nothing to sync");
	});

	it("configured vLLM-type custom provider (Ollama's OpenAI-compat /v1 surface) → models.json gets a provider entry pi-coding-agent can resolve", async () => {
		const mock = await startMockOpenAICompatServer(["qwen3:0.6b", "llama3.2:1b"]);
		try {
			const prefs = new PreferencesStore(stateDir);
			prefs.set("customProviders", [
				{ id: "local-ollama", name: "local-ollama", type: "vllm", baseUrl: mock.url },
			]);

			await syncCustomProviderModelsJson(prefs as any);

			const data = readModels();
			assert.ok(data?.providers?.["local-ollama"], "providers.local-ollama must exist in models.json");
			const entry = data.providers["local-ollama"];
			assert.equal(entry.baseUrl, `${mock.url}/v1`, "provider baseUrl must point at the OpenAI-compat /v1 surface");
			assert.equal(entry.api, "openai-completions");
			const ids = entry.models.map((m: any) => m.id);
			assert.ok(ids.includes("qwen3:0.6b"));
			assert.ok(ids.includes("llama3.2:1b"));
		} finally {
			await mock.close();
		}
	});

	it("provider config removed from preferences → next sync prunes its stale models.json entry", async () => {
		const mock = await startMockOpenAICompatServer(["model-a"]);
		try {
			const prefs = new PreferencesStore(stateDir);
			prefs.set("customProviders", [
				{ id: "local-vllm", name: "local-vllm", type: "vllm", baseUrl: mock.url },
			]);
			await syncCustomProviderModelsJson(prefs as any);
			assert.ok(readModels()?.providers?.["local-vllm"], "sanity: entry written before removal");

			prefs.set("customProviders", []);
			await syncCustomProviderModelsJson(prefs as any);

			const data = readModels();
			assert.equal(data?.providers?.["local-vllm"], undefined, "stale entry must be pruned once its config is gone");
		} finally {
			await mock.close();
		}
	});

	it("renaming a provider (same id, new name) → old key pruned, new key present", async () => {
		const mock = await startMockOpenAICompatServer(["model-a"]);
		try {
			const prefs = new PreferencesStore(stateDir);
			prefs.set("customProviders", [
				{ id: "local-1", name: "old-name", type: "vllm", baseUrl: mock.url },
			]);
			await syncCustomProviderModelsJson(prefs as any);
			assert.ok(readModels()?.providers?.["old-name"]);

			prefs.set("customProviders", [
				{ id: "local-1", name: "new-name", type: "vllm", baseUrl: mock.url },
			]);
			await syncCustomProviderModelsJson(prefs as any);

			const data = readModels();
			assert.equal(data?.providers?.["old-name"], undefined, "renamed-away key must be pruned");
			assert.ok(data?.providers?.["new-name"], "new key must be present");
		} finally {
			await mock.close();
		}
	});

	it("sync does not disturb other writers' models.json entries (aigw, built-ins)", async () => {
		const sentinel = {
			providers: {
				anthropic: { apiKey: "sk-test", models: [{ id: "claude-x" }] },
				aigw: { baseUrl: "http://gateway.example/v1", apiKey: "none", api: "openai-completions", models: [{ id: "gw-model" }] },
			},
		};
		writeFileSync(path.join(tmp, "models.json"), JSON.stringify(sentinel, null, 2));

		const mock = await startMockOpenAICompatServer(["model-a"]);
		try {
			const prefs = new PreferencesStore(stateDir);
			prefs.set("customProviders", [
				{ id: "local-1", name: "local-1", type: "vllm", baseUrl: mock.url },
			]);
			await syncCustomProviderModelsJson(prefs as any);

			const data = readModels();
			assert.ok(data.providers.anthropic, "unrelated anthropic entry must survive");
			assert.ok(data.providers.aigw, "unrelated aigw entry must survive");
			assert.ok(data.providers["local-1"], "new custom provider entry must be added");
		} finally {
			await mock.close();
		}
	});

	it("unreachable custom provider server → no entry written, no crash", async () => {
		const prefs = new PreferencesStore(stateDir);
		prefs.set("customProviders", [
			// Port 1 (TCPMUX) reliably refuses connections.
			{ id: "unreachable", name: "unreachable", type: "vllm", baseUrl: "http://127.0.0.1:1" },
		]);

		await assert.doesNotReject(() => syncCustomProviderModelsJson(prefs as any));
		const data = readModels();
		assert.equal(data?.providers?.["unreachable"], undefined, "unreachable provider must not get an entry");
	});

	it("removeCustomProviderModelsJsonEntry() removes a single provider's entry immediately (DELETE route path)", async () => {
		const mockA = await startMockOpenAICompatServer(["model-a"]);
		const mockB = await startMockOpenAICompatServer(["model-b"]);
		try {
			const prefs = new PreferencesStore(stateDir);
			const configA = { id: "a", name: "a", type: "vllm" as const, baseUrl: mockA.url };
			const configB = { id: "b", name: "b", type: "vllm" as const, baseUrl: mockB.url };
			prefs.set("customProviders", [configA, configB]);
			await syncCustomProviderModelsJson(prefs as any);
			assert.ok(readModels()?.providers?.a);
			assert.ok(readModels()?.providers?.b);

			removeCustomProviderModelsJsonEntry(configA);

			const data = readModels();
			assert.equal(data?.providers?.a, undefined, "removed provider's entry must be gone");
			assert.ok(data?.providers?.b, "sibling provider's entry must be untouched");
		} finally {
			await mockA.close();
			await mockB.close();
		}
	});
});
