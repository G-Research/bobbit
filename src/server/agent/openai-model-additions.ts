import fs from "node:fs";
import path from "node:path";

import { globalAgentDir } from "../bobbit-dir.js";
import type { ApiModel } from "./model-registry.js";

type OpenAIAddition = Omit<ApiModel, "authenticated">;

export const OPENAI_MODEL_ADDITIONS: OpenAIAddition[] = [
	{
		id: "gpt-5.5",
		name: "GPT-5.5",
		provider: "openai",
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5, output: 30, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "gpt-5.5-pro",
		name: "GPT-5.5 pro",
		provider: "openai",
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		contextWindow: 1_050_000,
		maxTokens: 128_000,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "gpt-5.5",
		name: "GPT-5.5",
		provider: "openai-codex",
		api: "openai-codex-responses",
		baseUrl: "https://chatgpt.com/backend-api",
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5, output: 30, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "gpt-5.5-pro",
		name: "GPT-5.5 pro",
		provider: "openai-codex",
		api: "openai-codex-responses",
		baseUrl: "https://chatgpt.com/backend-api",
		contextWindow: 1_050_000,
		maxTokens: 128_000,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
	},
];

export function getOpenAIModelAdditions(provider: string): OpenAIAddition[] {
	return OPENAI_MODEL_ADDITIONS.filter((model) => model.provider === provider);
}

function getModelsJsonPath(): string {
	return path.join(globalAgentDir(), "models.json");
}

function readModelsJson(): Record<string, any> {
	const p = getModelsJsonPath();
	try {
		if (fs.existsSync(p)) {
			return JSON.parse(fs.readFileSync(p, "utf-8"));
		}
	} catch (err) {
		console.error("[openai-model-additions] Failed to read models.json:", err);
	}
	return { providers: {} };
}

function writeModelsJson(data: Record<string, any>): void {
	const p = getModelsJsonPath();
	const dir = path.dirname(p);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	const tmp = `${p}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
	fs.renameSync(tmp, p);
	console.log(`[openai-model-additions] Wrote models.json to ${p}`);
}

export function writeOpenAIModelAdditions(): void {
	const data = readModelsJson();
	if (!data.providers) data.providers = {};

	let changed = false;
	for (const model of OPENAI_MODEL_ADDITIONS) {
		const provider = model.provider;
		if (!data.providers[provider]) data.providers[provider] = {};
		if (!Array.isArray(data.providers[provider].models)) data.providers[provider].models = [];

		const models = data.providers[provider].models as Array<Record<string, unknown>>;
		if (models.some((existing) => existing.id === model.id)) continue;

		models.push({
			id: model.id,
			name: model.name,
			api: model.api,
			baseUrl: model.baseUrl,
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		});
		changed = true;
	}

	if (changed) writeModelsJson(data);
}
