// v2-native — multi-gateway consumer contracts.

import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { resetAgentDirStateForTests } from "../../src/server/bobbit-dir.js";
import { PreferencesStore } from "../../src/server/agent/preferences-store.js";
import { getAvailableModels, invalidateModelCache, type ApiModel } from "../../src/server/agent/model-registry.js";
import { SessionManager, gatewayModelBinding } from "../../src/server/agent/session-manager.js";
import { generateSessionTitle } from "../../src/server/agent/title-generator.js";
import type { ModelGateway } from "../../src/server/agent/aigw-manager.js";

const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function gateway(name: string, url: string, type: ModelGateway["type"] = "openai-compatible"): ModelGateway {
	return { id: `id-${name}`, name, url, type, enabled: true };
}

function startGateway(): Promise<{
	url: string;
	setAvailable: (available: boolean) => void;
	getModelRequests: () => number;
	close: () => Promise<void>;
}> {
	let available = true;
	let modelRequests = 0;
	const server = http.createServer((req, res) => {
		if (req.url === "/v1/models") {
			modelRequests++;
			if (!available) {
				res.writeHead(503, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "temporarily unavailable" }));
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: "claude-local" }] }));
			return;
		}
		res.writeHead(404);
		res.end();
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
		const port = (server.address() as { port: number }).port;
		resolve({
			url: `http://127.0.0.1:${port}`,
			setAvailable: (next) => { available = next; },
			getModelRequests: () => modelRequests,
			close: () => new Promise<void>((done) => server.close(() => done())),
		});
	}));
}

describe("multi-gateway consumers", () => {
	let agentDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		previousAgentDir = process.env.BOBBIT_AGENT_DIR;
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-gateway-consumers-"));
		process.env.BOBBIT_AGENT_DIR = agentDir;
		resetAgentDirStateForTests();
		invalidateModelCache();
	});

	afterEach(() => {
		invalidateModelCache();
		if (previousAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR;
		else process.env.BOBBIT_AGENT_DIR = previousAgentDir;
		resetAgentDirStateForTests();
		fs.rmSync(agentDir, { recursive: true, force: true });
	});

	it("keeps retained availability scoped to the named gateway and normalized endpoint", async () => {
		const service = await startGateway();
		try {
			service.setAvailable(false);
			const prefs = new PreferencesStore(path.join(agentDir, "state"));
			prefs.set("modelGateways", [gateway("local-a", service.url)]);
			fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
				providers: {
					"local-a": {
						baseUrl: `${service.url}/v1`, api: "openai-completions", apiKey: "none",
						models: [{ id: "retained-local", name: "Retained local", api: "openai-completions", baseUrl: `${service.url}/v1`, contextWindow: 8192, maxTokens: 4096, reasoning: false, input: ["text"], cost: COST }],
					},
				},
			}));

			const retained = await getAvailableModels(prefs);
			assert.ok(retained.some((model) => model.provider === "local-a" && model.id === "retained-local"));

			prefs.set("modelGateways", [gateway("local-b", service.url)]);
			invalidateModelCache();
			const renamed = await getAvailableModels(prefs);
			assert.equal(renamed.some((model) => model.provider === "local-b" && model.id === "retained-local"), false);
		} finally {
			await service.close();
		}
	});

	it("scopes discovery caching and Pi bindings to the owning gateway provider", async () => {
		const service = await startGateway();
		try {
			const manager: any = new SessionManager({ stateDir: path.join(agentDir, "session-state") });
			const first = gateway("local-a", service.url);
			const second = gateway("local-b", service.url);
			await manager.discoverGatewayModelsCached(first);
			await manager.discoverGatewayModelsCached(first);
			await manager.discoverGatewayModelsCached(second);
			assert.equal(service.getModelRequests(), 2, "same named gateway is cached, distinct gateway names are not conflated");
			assert.equal(gatewayModelBinding(first, { id: "claude-local", wireId: "must-not-use-wire-id" }), "local-a/claude-local");
			assert.equal(gatewayModelBinding(gateway("aigw", service.url, "aigw"), { id: "aws/claude-haiku" }), "aigw/claude-haiku");
		} finally {
			await service.close();
		}
	});

	it("routes explicit title tuples through their named gateway model and reserves implicit Claude fallback for AIGW", async () => {
		const local = gateway("local-a", "http://127.0.0.1:1234");
		const model: ApiModel = {
			id: "claude-local", name: "Claude local", provider: local.name, api: "openai-completions", baseUrl: `${local.url}/v1`,
			contextWindow: 8192, maxTokens: 4096, reasoning: false, input: ["text"], cost: COST, authenticated: true,
		};
		const calls: ApiModel[] = [];
		const title = await generateSessionTitle([{ role: "user", content: "Use the local gateway." }], {
			namingModel: "local-a/claude-local",
			gateways: [local],
			availableModels: [model],
			directModelCompleter: async (selected) => {
				calls.push(selected);
				return "<title>Local Gateway</title>";
			},
		});
		assert.equal(title, "Local Gateway");
		assert.deepEqual(calls.map(({ provider, id }) => ({ provider, id })), [{ provider: "local-a", id: "claude-local" }]);

		const prefs = new PreferencesStore(path.join(agentDir, "title-state"));
		prefs.set("modelGateways", [local]);
		const manager: any = new SessionManager({ preferencesStore: prefs, stateDir: path.join(agentDir, "title-session-state") });
		const localOptions = manager.getTitleGenOptions();
		assert.deepEqual(localOptions.gateways.map((row: ModelGateway) => row.name), ["local-a"]);
		assert.equal(localOptions.aigwUrl, undefined, "OpenAI-compatible Claude ids cannot enable implicit AIGW fallback");
		const enterprise = gateway("aigw", "http://127.0.0.1:7777", "aigw");
		prefs.set("modelGateways", [local, enterprise]);
		const enterpriseOptions = manager.getTitleGenOptions();
		assert.deepEqual(enterpriseOptions.gateways.map((row: ModelGateway) => row.name), ["local-a", "aigw"]);
		assert.equal(enterpriseOptions.aigwUrl, enterprise.url);
	});
});
