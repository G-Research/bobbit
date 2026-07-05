import { Store } from "../store.js";
import type { StoreConfig } from "../types.js";

export type AutoDiscoveryProviderType = "ollama" | "llama.cpp" | "vllm" | "lmstudio";

export type CustomProviderType =
	| AutoDiscoveryProviderType // Auto-discovery - models fetched on-demand
	| "openai-completions" // Manual models - stored in provider.models
	| "openai-responses" // Manual models - stored in provider.models
	| "anthropic-messages" // Manual models - stored in provider.models
	| "openai-images" // Manual image-generation models - stored in provider.models
	| "gemini-images" // Manual Gemini image-generation models - stored in provider.models
	| "google-imagen"; // Manual Imagen model providers - stored in provider.models

/**
 * One manually-configured model entry for a non-auto-discovery custom
 * provider. `contextWindow`/`maxTokens` are OPTIONAL per-model overrides —
 * most manual-provider APIs (e.g. NVIDIA NIM) don't report context length via
 * /v1/models, so the server falls back to a conservative 8192/4096 unless
 * overridden here. See CustomProviderConfig in
 * src/server/agent/model-registry.ts (the server-side twin of this shape).
 */
export interface CustomProviderModelEntry {
	id: string;
	name: string;
	contextWindow?: number;
	maxTokens?: number;
}

export interface CustomProvider {
	id: string; // UUID
	name: string; // Display name, also used as Model.provider
	type: CustomProviderType;
	baseUrl: string;
	// WRITE-ONLY. Sent to the server when the user types a new key; the
	// server NEVER returns stored keys on any read path (GET /api/custom-providers
	// redacts them — security fix, see redactCustomProviderConfig in
	// src/server/agent/model-registry.ts). On write: omit to keep the stored
	// key, send null to clear it, send a non-empty string to replace it.
	apiKey?: string | null;
	// READ-ONLY. Set by the server on GET responses: whether a key is stored.
	hasApiKey?: boolean;

	// For manual types ONLY - models stored directly on provider
	// Auto-discovery types: models fetched on-demand, never stored
	models?: CustomProviderModelEntry[];
}

/**
 * Store for custom LLM providers (auto-discovery servers + manual providers).
 */
export class CustomProvidersStore extends Store {
	getConfig(): StoreConfig {
		return {
			name: "custom-providers",
		};
	}

	async get(id: string): Promise<CustomProvider | null> {
		return this.getBackend().get("custom-providers", id);
	}

	async set(provider: CustomProvider): Promise<void> {
		await this.getBackend().set("custom-providers", provider.id, provider);
	}

	async delete(id: string): Promise<void> {
		await this.getBackend().delete("custom-providers", id);
	}

	async getAll(): Promise<CustomProvider[]> {
		const keys = await this.getBackend().keys("custom-providers");
		const providers: CustomProvider[] = [];
		for (const key of keys) {
			const provider = await this.get(key);
			if (provider) {
				providers.push(provider);
			}
		}
		return providers;
	}

	async has(id: string): Promise<boolean> {
		return this.getBackend().has("custom-providers", id);
	}
}
