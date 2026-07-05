import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ADDITION_COUNT = 39;

let tmp: string;
let stateDir: string;
let previousAgentDir: string | undefined;

before(() => {
	tmp = mkdtempSync(path.join(tmpdir(), "bobbit-models-json-concurrency-"));
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

const { PreferencesStore } = await import("../src/server/agent/preferences-store.js");
const { syncCustomProviderModelsJson } = await import("../src/server/agent/model-registry.js");
const { writeOpenAIModelAdditions, OPENAI_MODEL_ADDITIONS } = await import("../src/server/agent/openai-model-additions.js");

function readModels(): any {
	return JSON.parse(readFileSync(path.join(tmp, "models.json"), "utf-8"));
}

describe("models.json writer serialization", () => {
	it("preserves concurrent read-modify-write updates from independent writer modules", async () => {
		const originalAdditionLength = OPENAI_MODEL_ADDITIONS.length;
		const syntheticProvider = `bobbit-concurrency-${process.pid}`;
		try {
			for (let i = 0; i < ADDITION_COUNT; i++) {
				OPENAI_MODEL_ADDITIONS.push({
					id: `synthetic-${i}`,
					name: `Synthetic ${i}`,
					provider: syntheticProvider,
					api: "openai-responses",
					baseUrl: "https://example.invalid/v1",
					contextWindow: 128_000,
					maxTokens: 4096,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				});
			}

			const prefs = new PreferencesStore(stateDir);
			prefs.set("customProviders", [
				{
					id: "manual-local",
					name: "manual-local",
					type: "manual",
					baseUrl: "http://127.0.0.1:65535",
					models: [{ id: "local-manual", name: "Local Manual" }],
				},
			]);

			const customWrite = syncCustomProviderModelsJson(prefs as any);
			await writeOpenAIModelAdditions();
			await customWrite;

			const data = readModels();
			assert.ok(data.providers?.["manual-local"], "custom provider writer update must survive");
			const additions = data.providers?.[syntheticProvider]?.models ?? [];
			assert.equal(
				additions.length,
				ADDITION_COUNT,
				`all ${ADDITION_COUNT} OpenAI-addition writer updates must survive`,
			);
			assert.equal(1 + additions.length, 40, "all 40 concurrent model config updates must land");
		} finally {
			OPENAI_MODEL_ADDITIONS.splice(originalAdditionLength);
		}
	});
});
