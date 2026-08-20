// v2-native — persistence, redaction, and routing guards for named gateways.
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PreferencesStore } from "../../src/server/agent/preferences-store.js";
import {
	buildOpenAiCompatibleProviderBlock,
	filterValidatedProviderUrls,
	getGatewayStatus,
	listGateways,
	migrateGatewayPrefs,
	saveGateways,
	setGatewayApiKey,
	syncGatewaysModelsJson,
	writeAigwModelsJson,
} from "../../src/server/agent/aigw-manager.js";
import { resetAgentDirStateForTests } from "../../src/server/bobbit-dir.js";
import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

let dir = "";
let previousAgentDir: string | undefined;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-multi-gateway-"));
	previousAgentDir = process.env.BOBBIT_AGENT_DIR;
	process.env.BOBBIT_AGENT_DIR = dir;
	resetAgentDirStateForTests();
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR;
	else process.env.BOBBIT_AGENT_DIR = previousAgentDir;
	resetAgentDirStateForTests();
	fs.rmSync(dir, { recursive: true, force: true });
});

const local = (id = "local-id") => ({ id, name: "local", url: "http://localhost:1111", type: "openai-compatible" as const, enabled: true });

describe("named gateway validation and migration", () => {
	it("validates safe, unique names and the singleton AIGW name", () => {
		const prefs = new PreferencesStore(path.join(dir, "state"));
		assert.throws(() => saveGateways(prefs, [{ ...local(), name: "openai" }]), /built-in/i);
		assert.throws(() => saveGateways(prefs, [{ ...local(), name: "not safe" }]), /invalid/i);
		assert.throws(() => saveGateways(prefs, [local(), { ...local(), id: "two" }]), /duplicate/i);
		assert.throws(() => saveGateways(prefs, [{ ...local(), type: "aigw", name: "enterprise" }]), /must be named/i);
		assert.doesNotThrow(() => saveGateways(prefs, [{ id: "a", name: "aigw", url: "http://localhost:1111/v1", type: "aigw", enabled: true }, local()]));
	});

	it("rejects unsafe URLs before persistence without reflecting their credential-like input", () => {
		const prefs = new PreferencesStore(path.join(dir, "state"));
		for (const url of [
			"relative/path",
			"file:///tmp/models",
			"ftp://example.test/v1",
			"http://user:password@example.test/v1",
			"https://example.test/v1#secret-fragment",
			"https://example.test/v1?x-api-key=super-secret",
		]) {
			try {
				saveGateways(prefs, [{ ...local(), url }]);
				assert.fail("unsafe URL unexpectedly persisted");
			} catch (error) {
				assert.match(String(error), /Gateway URL/);
				assert.ok(!String(error).includes("super-secret"));
				assert.ok(!String(error).includes("password"));
			}
			assert.equal(prefs.get("modelGateways"), undefined);
		}
		assert.doesNotThrow(() => saveGateways(prefs, [{ ...local(), url: "https://example.test/v1?region=us" }]));
	});

	it("filters credentialed cross-origin well-known providers while preserving same-origin routing", async () => {
		const origin = "https://gateway.example.test";
		const lookup = ((_hostname: string, _options: any, callback: any) => callback(null, [{ address: "8.8.8.8", family: 4 }])) as any;
		const config: any = { provider: {
			same: { options: { baseURL: `${origin}/openai/v1` }, models: {} },
			external: { options: { baseURL: "https://models.example.test/v1" }, models: {} },
		} };
		const credentialed = await filterValidatedProviderUrls(config, origin, Date.now() + 1_000, lookup, false);
		assert.deepEqual(Object.keys(credentialed.provider ?? {}), ["same"]);
		const anonymous = await filterValidatedProviderUrls(config, origin, Date.now() + 1_000, lookup);
		assert.deepEqual(Object.keys(anonymous.provider ?? {}).sort(), ["external", "same"]);
	});

	it("preserves a credential-resolution error in status while retaining last-good models", async () => {
		const prefs = new PreferencesStore(path.join(dir, "state"));
		saveGateways(prefs, [local()]);
		setGatewayApiKey(prefs, "local-id", "!false");
		fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: {
			local: { baseUrl: "http://localhost:1111/v1", models: [{ id: "retained" }] },
		} }));
		const saved = listGateways(prefs)[0];
		const expected = 'Unable to resolve API key for gateway "local"';
		assert.deepEqual(await getGatewayStatus(prefs, saved), { state: "unreachable", models: [{ id: "retained" }], error: expected });
		assert.deepEqual((await syncGatewaysModelsJson(prefs)).local, { state: "unreachable", models: [{ id: "retained" }], error: expected });
	});

	it("treats an existing empty list as authoritative and cleans legacy settings", () => {
		const prefs = new PreferencesStore(path.join(dir, "state"));
		prefs.set("modelGateways", []);
		prefs.set("aigw.url", "http://stale/v1");
		prefs.set("aigw.exclusive", true);
		assert.deepEqual(migrateGatewayPrefs(prefs), { migrated: false, gateways: [] });
		assert.deepEqual(prefs.get("modelGateways"), []);
		assert.equal(prefs.get("aigw.url"), undefined);
		assert.equal(prefs.get("aigw.exclusive"), undefined);
	});

	it("does not migrate a whitespace legacy URL", () => {
		const prefs = new PreferencesStore(path.join(dir, "state"));
		prefs.set("aigw.url", "  \t ");
		assert.deepEqual(migrateGatewayPrefs(prefs), { migrated: false, gateways: [] });
		assert.equal(prefs.get("modelGateways"), undefined);
		assert.equal(prefs.get("aigw.url"), undefined);
	});

	it("preserves an optional key on stable-id saves and clears it on explicit null or row removal", () => {
		const prefs = new PreferencesStore(path.join(dir, "state"));
		saveGateways(prefs, [local()]);
		setGatewayApiKey(prefs, "local-id", "LOCAL_TOKEN");
		saveGateways(prefs, [{ ...local(), url: "http://localhost:2222" }]);
		assert.deepEqual(listGateways(prefs), [{ ...local(), url: "http://localhost:2222", apiKeyConfigured: true }]);
		assert.equal(prefs.get("providerKey.gateway.local-id"), "LOCAL_TOKEN", "the private expression survives an omitted key field");
		setGatewayApiKey(prefs, "local-id", null);
		assert.equal(prefs.get("providerKey.gateway.local-id"), undefined);
		assert.equal(listGateways(prefs)[0].apiKeyConfigured, undefined);

		setGatewayApiKey(prefs, "local-id", "ORPHANED_TOKEN");
		saveGateways(prefs, []);
		assert.equal(prefs.get("providerKey.gateway.local-id"), undefined, "removing a row must also remove its private key expression");
	});

	it("keeps a Claude-named OpenAI-compatible model raw and out of Bedrock", () => {
		const provider = buildOpenAiCompatibleProviderBlock(local(), [{
			id: "claude-local", name: "Claude Local", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 2048,
		}]) as any;
		assert.equal(provider.baseUrl, "http://localhost:1111/v1");
		assert.equal(provider.headers, undefined);
		assert.equal(provider.models[0].id, "claude-local");
		assert.equal(provider.models[0].api, "openai-completions");
		assert.equal(provider.models[0].baseUrl, undefined);
	});

	it("keeps models.json byte-identical through a pure total outage", async () => {
		const prefs = new PreferencesStore(path.join(dir, "state"));
		saveGateways(prefs, [{ ...local(), url: "http://127.0.0.1:9" }]);
		const file = path.join(dir, "models.json");
		fs.writeFileSync(file, JSON.stringify({ providers: {
			local: { baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "retained" }] },
			foreign: { baseUrl: "https://example.test/v1", models: [{ id: "untouched" }] },
		} }, null, 2));
		const before = fs.readFileSync(file, "utf8");

		const status = await syncGatewaysModelsJson(prefs);
		assert.deepEqual(status.local, { state: "unreachable", models: [{ id: "retained" }], error: "Gateway is unreachable" });
		assert.equal(fs.readFileSync(file, "utf8"), before, "a pure total outage must not rewrite a last-known catalog");
	});

	it("publishes stale managed-provider pruning through a total outage", async () => {
		const prefs = new PreferencesStore(path.join(dir, "state"));
		saveGateways(prefs, [{ ...local(), url: "http://127.0.0.1:9" }]);
		prefs.set("_managedGatewayProviders", ["removed-gateway"]);
		const file = path.join(dir, "models.json");
		fs.writeFileSync(file, JSON.stringify({ providers: {
			"removed-gateway": {
				"x-bobbit-managed": { kind: "aigw-publication", version: 1 },
				baseUrl: "http://127.0.0.1:9999/v1", models: [{ id: "stale" }],
			},
			foreign: { baseUrl: "https://example.test/v1", models: [{ id: "untouched" }] },
		} }, null, 2));
		const before = fs.readFileSync(file, "utf8");

		const status = await syncGatewaysModelsJson(prefs);
		assert.deepEqual(status.local, { state: "unreachable", models: [], error: "Gateway is unreachable" });
		assert.notEqual(fs.readFileSync(file, "utf8"), before, "configuration-driven pruning must publish despite the outage");
		const after = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.equal(after.providers["removed-gateway"], undefined);
		assert.deepEqual(after.providers.foreign, { baseUrl: "https://example.test/v1", models: [{ id: "untouched" }] });
		assert.deepEqual(prefs.get("_managedGatewayProviders"), ["local"]);
	});

	it("publishes managed names only after an atomic models.json write", async () => {
		const gateway = http.createServer((req, res) => {
			assert.equal(req.url, "/v1/models");
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: "local-model" }] }));
		});
		await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
		const port = (gateway.address() as { port: number }).port;
		const prefs = new PreferencesStore(path.join(dir, "state"));
		saveGateways(prefs, [{ ...local(), url: `http://127.0.0.1:${port}` }]);
		const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("disk full"); });
		try {
			await assert.rejects(syncGatewaysModelsJson(prefs), /disk full/);
			assert.equal(prefs.get("_managedGatewayProviders"), undefined);
		} finally {
			rename.mockRestore();
			await new Promise<void>((resolve) => gateway.close(() => resolve()));
		}
	});

	it("leaves existing single-AIGW models.json bytes unchanged through migration", () => {
		const prefs = new PreferencesStore(path.join(dir, "state"));
		writeAigwModelsJson("http://localhost:1111/v1", [{ id: "qwen", name: "Qwen", api: "openai-completions", baseUrl: "http://localhost:1111/v1", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 2048 }]);
		const file = path.join(dir, "models.json");
		const before = fs.readFileSync(file, "utf8");
		prefs.set("aigw.url", "http://localhost:1111/v1");
		migrateGatewayPrefs(prefs);
		assert.equal(fs.readFileSync(file, "utf8"), before);
	});
});
