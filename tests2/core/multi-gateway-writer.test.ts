// v2-native — type-specific provider blocks must make routing structural.
import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
	buildAigwProviderBlock,
	buildOpenAiCompatibleProviderBlock,
	discoverAigwModels,
	saveGateways,
	syncGatewaysModelsJson,
	writeAigwModelsJson,
} from "../../src/server/agent/aigw-manager.js";
import { PreferencesStore } from "../../src/server/agent/preferences-store.js";
import { resetAgentDirStateForTests } from "../../src/server/bobbit-dir.js";
import { loadFixture } from "./helpers/aigw-wellknown-test-helpers.js";

const model = (id: string, overrides: Record<string, unknown> = {}) => ({
	id, name: id, api: "openai-completions", reasoning: false, input: ["text"] as ("text" | "image")[], contextWindow: 128_000, maxTokens: 16_384, ...overrides,
});

describe("multi-gateway models.json writers", () => {
	let agentDir = "";
	let stateDir = "";
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		previousAgentDir = process.env.BOBBIT_AGENT_DIR;
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-multi-gateway-writer-"));
		stateDir = path.join(agentDir, "state");
		fs.mkdirSync(stateDir, { recursive: true });
		process.env.BOBBIT_AGENT_DIR = agentDir;
		resetAgentDirStateForTests();
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR;
		else process.env.BOBBIT_AGENT_DIR = previousAgentDir;
		resetAgentDirStateForTests();
		fs.rmSync(agentDir, { recursive: true, force: true });
	});

	it("preserves authoritative AIGW model routing and provider headers", () => {
		const block: any = buildAigwProviderBlock(
			{ id: "a", name: "aigw", url: "https://gateway.test/v1", type: "aigw", enabled: true },
			[model("gpt-routed", { wireId: "gpt-wire", api: "openai-responses", baseUrl: "https://gateway.test/openai/v1", upstreamProvider: "openai" })],
		);
		assert.equal(block.apiKey, "none");
		assert.equal(block.headers["x-opencode-session"], `!node -e "process.stdout.write(process.env.BOBBIT_SESSION_ID || '')"`);
		assert.deepEqual(block.models[0], {
			id: "gpt-wire", upstreamProvider: "openai", name: "gpt-routed", contextWindow: 128_000, maxTokens: 16_384,
			reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, api: "openai-responses", baseUrl: "https://gateway.test/openai/v1",
		});
	});

	it("uses raw OpenAI ids with no AIGW header or Bedrock route", () => {
		const block: any = buildOpenAiCompatibleProviderBlock(
			{ id: "l", name: "local", url: "http://localhost:8080/", type: "openai-compatible", enabled: true },
			[model("claude-local")],
			"LOCAL_TOKEN_REFERENCE",
		);
		assert.equal(block.baseUrl, "http://localhost:8080/v1");
		assert.equal(block.apiKey, "LOCAL_TOKEN_REFERENCE", "the expression, never a resolved token, belongs in models.json");
		assert.equal(block.headers, undefined);
		assert.equal(block.models[0].id, "claude-local");
		assert.equal(block.models[0].api, "openai-completions");
		assert.equal(block.models[0].baseUrl, undefined);
	});

	it("emits byte-identical legacy AIGW output when an unchanged single AIGW is synced", async () => {
		const server = http.createServer((req, res) => {
			if (req.url !== "/.well-known/opencode") {
				res.writeHead(404);
				res.end();
				return;
			}
			const origin = `http://127.0.0.1:${(server.address() as any).port}`;
			const config = JSON.parse(JSON.stringify(loadFixture()).replaceAll("http://aigw-local.t3.zone", origin));
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(config));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const gatewayUrl = `http://127.0.0.1:${(server.address() as any).port}`;
		try {
			// The legacy writer is the compatibility oracle. It receives the same
			// authoritative well-known discovery result as the multi-gateway sync.
			const discovered = await discoverAigwModels(gatewayUrl);
			writeAigwModelsJson(gatewayUrl, discovered);
			const legacyBytes = fs.readFileSync(path.join(agentDir, "models.json"));

			fs.rmSync(path.join(agentDir, "models.json"));
			const prefs = new PreferencesStore(stateDir);
			saveGateways(prefs, [{ id: "single-aigw", name: "aigw", url: gatewayUrl, type: "aigw", enabled: true }]);
			await syncGatewaysModelsJson(prefs);
			const syncedBytes = fs.readFileSync(path.join(agentDir, "models.json"));

			assert.deepEqual(syncedBytes, legacyBytes, "single-AIGW sync must preserve legacy models.json bytes exactly");
			const provider = JSON.parse(syncedBytes.toString("utf8")).providers.aigw;
			assert.equal(provider.headers["x-opencode-session"], `!node -e "process.stdout.write(process.env.BOBBIT_SESSION_ID || '')"`);
			assert.equal(provider.models.find((entry: any) => entry.id === "gpt-5.6-sol").api, "openai-responses");
			assert.equal(provider.models.find((entry: any) => entry.id === "us.anthropic.claude-opus-4-6").api, "bedrock-converse-stream");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
