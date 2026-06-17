/**
 * Browser-safe pi-ai boundary.
 *
 * Do not statically or dynamically import the bare `@earendil-works/pi-ai`
 * value module from browser code. Its index re-exports Node environment probing
 * (`env-api-keys.js`) and makes Vite externalize `node:fs` during UI builds.
 *
 * Runtime browser needs either go through server APIs (provider catalog / key
 * tests) or narrow browser-compatible provider subpaths for first-message
 * streaming. Type-only imports remain safe because `tsc` erases them.
 *
 * See `docs/design/shrink-initial-bundle.md` (Task A) for the full design.
 */

import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { gatewayFetch } from "./api.js";

export async function getPiAiProviders(): Promise<string[]> {
	const res = await gatewayFetch("/api/pi-ai/providers");
	if (!res.ok) throw new Error(`Failed to load providers: ${res.status}`);
	const body = await res.json() as { providers?: unknown };
	return Array.isArray(body.providers) ? body.providers.filter((provider): provider is string => typeof provider === "string") : [];
}

export async function getPiAiModel(provider: string, modelId: string): Promise<Model<any> | undefined> {
	const res = await gatewayFetch("/api/models");
	if (!res.ok) return undefined;
	const models = await res.json() as Array<Model<any>>;
	return models.find(model => model.provider === provider && model.id === modelId);
}

export async function testPiAiProviderKey(provider: string, modelId: string, apiKey: string): Promise<boolean> {
	const res = await gatewayFetch("/api/pi-ai/provider-key-test", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ provider, modelId, key: apiKey }),
	});
	if (!res.ok) return false;
	const body = await res.json() as { ok?: unknown };
	return body.ok === true;
}

export async function streamSimplePiAi(model: Model<any>, context: Context, options?: SimpleStreamOptions): Promise<any> {
	switch (model.api) {
		case "anthropic-messages": {
			const { streamSimpleAnthropic } = await import("@earendil-works/pi-ai/anthropic");
			return streamSimpleAnthropic(model as any, context, options as any);
		}
		case "azure-openai-responses": {
			const { streamSimpleAzureOpenAIResponses } = await import("@earendil-works/pi-ai/azure-openai-responses");
			return streamSimpleAzureOpenAIResponses(model as any, context, options as any);
		}
		case "google-generative-ai": {
			const { streamSimpleGoogle } = await import("@earendil-works/pi-ai/google");
			return streamSimpleGoogle(model as any, context, options as any);
		}
		case "google-vertex": {
			const { streamSimpleGoogleVertex } = await import("@earendil-works/pi-ai/google-vertex");
			return streamSimpleGoogleVertex(model as any, context, options as any);
		}
		case "mistral-conversations": {
			const { streamSimpleMistral } = await import("@earendil-works/pi-ai/mistral");
			return streamSimpleMistral(model as any, context, options as any);
		}
		case "openai-codex-responses": {
			const { streamSimpleOpenAICodexResponses } = await import("@earendil-works/pi-ai/openai-codex-responses");
			return streamSimpleOpenAICodexResponses(model as any, context, options as any);
		}
		case "openai-completions": {
			const { streamSimpleOpenAICompletions } = await import("@earendil-works/pi-ai/openai-completions");
			return streamSimpleOpenAICompletions(model as any, context, options as any);
		}
		case "openai-responses": {
			const { streamSimpleOpenAIResponses } = await import("@earendil-works/pi-ai/openai-responses");
			return streamSimpleOpenAIResponses(model as any, context, options as any);
		}
		case "bedrock-converse-stream":
			throw new Error("Bedrock browser streaming is unavailable without the server-side agent path.");
		default:
			throw new Error(`No browser stream provider registered for api: ${model.api}`);
	}
}
