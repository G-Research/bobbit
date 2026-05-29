import { ModelSelector } from "../../src/ui/dialogs/ModelSelector.js";

type FixtureModel = {
	id: string;
	name: string;
	provider: string;
	api: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	input: string[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	authenticated: boolean;
};

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

let models: FixtureModel[] = [
	{
		id: "claude-opus-4-7",
		name: "Claude Opus 4.7",
		provider: "anthropic",
		api: "anthropic-messages",
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		reasoning: true,
		input: ["text", "image"],
		cost,
		authenticated: true,
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		provider: "anthropic",
		api: "anthropic-messages",
		contextWindow: 1_000_000,
		maxTokens: 64_000,
		reasoning: true,
		input: ["text", "image"],
		cost,
		authenticated: true,
	},
	{
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8",
		provider: "anthropic",
		api: "anthropic-messages",
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		reasoning: true,
		input: ["text", "image"],
		cost,
		authenticated: true,
	},
	{
		id: "claude-opus-4-10",
		name: "Claude Opus 4.10",
		provider: "anthropic",
		api: "anthropic-messages",
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		reasoning: true,
		input: ["text", "image"],
		cost,
		authenticated: true,
	},
];

let selectedModel: FixtureModel | null = null;
let fetchLog: string[] = [];

localStorage.setItem("gateway.url", "https://fixture.local");
localStorage.setItem("gateway.token", "fixture-token");

function response(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

window.fetch = (async (input: RequestInfo | URL) => {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	fetchLog.push(raw);
	const url = new URL(raw, window.location.href);
	if (url.pathname === "/api/models") return response(models);
	return new Response("Not found", { status: 404 });
}) as typeof window.fetch;

(window as any).__openModelSelectorFixture = (currentModel: FixtureModel | null = null) => {
	selectedModel = null;
	ModelSelector.open(currentModel as any, (model) => {
		selectedModel = model as FixtureModel;
	});
};

(window as any).__setModelSelectorModels = (nextModels: FixtureModel[]) => {
	models = nextModels;
};

(window as any).__getSelectedModel = () => selectedModel;
(window as any).__getModelFetchLog = () => fetchLog;
(window as any).__resetModelSelectorFixture = () => {
	selectedModel = null;
	fetchLog = [];
};

(window as any).__modelSelectorFixtureReady = true;
