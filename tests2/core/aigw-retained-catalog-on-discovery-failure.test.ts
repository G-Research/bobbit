// v2-native — NOT a migrated legacy test. Listed in tests-map.json `v2Native`.
// Retained AIGW catalog availability during transient discovery failures.

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
import {
	findSessionSelectableModel,
	getAvailableModels,
	invalidateModelCache,
} from "../../src/server/agent/model-registry.js";

const RETAINED_ID = "gpt-5.4";
const RETAINED_COST = { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 };

type DiscoveryMode = "failure" | "success";

function startGateway(): Promise<{
	url: string;
	setMode: (mode: DiscoveryMode) => void;
	close: () => Promise<void>;
}> {
	let mode: DiscoveryMode = "failure";
	const server = http.createServer((req, res) => {
		if (req.url === "/.well-known/opencode") {
			res.writeHead(mode === "failure" ? 503 : 404);
			res.end();
			return;
		}
		if (req.url === "/v1/models") {
			if (mode === "failure") {
				res.writeHead(503, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "temporarily unavailable" }));
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: "openai/replacement-model", object: "model" }] }));
			return;
		}
		res.writeHead(404);
		res.end();
	});

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			resolve({
				url: `http://127.0.0.1:${port}`,
				setMode: (next) => { mode = next; },
				close: () => new Promise<void>((done) => server.close(() => done())),
			});
		});
	});
}

function writeRetainedCatalog(agentDir: string, configuredUrl: string, providerUrl = configuredUrl): void {
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: {
			aigw: {
				baseUrl: providerUrl,
				apiKey: "none",
				api: "openai-completions",
				models: [{
					id: RETAINED_ID,
					name: "Retained GPT 5.4",
					upstreamProvider: "openai",
					api: "openai-responses",
					baseUrl: `${configuredUrl}/openai/v1`,
					contextWindow: 1_000_000,
					maxTokens: 128_000,
					reasoning: true,
					thinkingLevelMap: { xhigh: "xhigh", max: "max" },
					input: ["text", "image"],
					cost: RETAINED_COST,
					compat: { supportsReasoningEffort: true, supportsStrictTools: true },
				}],
			},
		},
	}, null, 2));
}

describe("AIGW retained catalog on discovery failure", () => {
	let agentDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		previousAgentDir = process.env.BOBBIT_AGENT_DIR;
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-aigw-retained-"));
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

	it("retains a matching persisted catalog only while discovery fails", async () => {
		const gateway = await startGateway();
		try {
			const prefs = new PreferencesStore(path.join(agentDir, "state"));
			prefs.set("aigw.url", gateway.url);
			writeRetainedCatalog(agentDir, gateway.url);

			const unavailableModels = await getAvailableModels(prefs);
			const retained = findSessionSelectableModel(unavailableModels, "aigw", RETAINED_ID);
			assert.ok(retained, "a transient HTTP 503 must retain the exact persisted AIGW model for restore/spawn validation");
			assert.deepEqual(retained, {
				id: RETAINED_ID,
				name: "Retained GPT 5.4",
				provider: "aigw",
				runtime: "pi",
				upstreamProvider: "openai",
				api: "openai-responses",
				baseUrl: `${gateway.url}/openai/v1`,
				contextWindow: 1_000_000,
				maxTokens: 128_000,
				reasoning: true,
				thinkingLevelMap: { xhigh: "xhigh", max: "max" },
				input: ["text", "image"],
				cost: RETAINED_COST,
				compat: { supportsReasoningEffort: true, supportsStrictTools: true },
				authenticated: true,
			});

			writeRetainedCatalog(agentDir, gateway.url, "http://127.0.0.1:9");
			invalidateModelCache();
			const mismatchedModels = await getAvailableModels(prefs);
			assert.equal(
				findSessionSelectableModel(mismatchedModels, "aigw", RETAINED_ID),
				undefined,
				"retained routing from a different AIGW URL must not become selectable",
			);

			writeRetainedCatalog(agentDir, gateway.url);
			gateway.setMode("success");
			invalidateModelCache();
			const refreshedModels = await getAvailableModels(prefs);
			assert.equal(
				findSessionSelectableModel(refreshedModels, "aigw", RETAINED_ID),
				undefined,
				"a successful discovery omission is authoritative catalog drift",
			);
			assert.ok(
				findSessionSelectableModel(refreshedModels, "aigw", "openai/replacement-model"),
				"the successful live discovery catalog must replace retained availability",
			);
		} finally {
			await gateway.close();
		}
	});
});
