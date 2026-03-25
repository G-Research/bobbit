/**
 * Client-side AI Gateway configuration helpers.
 * Maps aigw model data from server preferences into Model objects
 * for the ModelSelector.
 */

import type { Model } from "@mariozechner/pi-ai";
import type { AigwModelConfig } from "../ui/dialogs/ModelSelector.js";

/**
 * Build an AigwModelConfig from server preferences.
 * Returns { active: false, models: [] } if aigw is not configured.
 */
export function buildAigwModelConfig(prefs: Record<string, unknown>): AigwModelConfig {
	const aigwUrl = prefs["aigw.url"] as string | undefined;
	const aigwModels = prefs["aigw.models"] as any[] | undefined;

	if (!aigwUrl || !aigwModels || aigwModels.length === 0) {
		return { active: false, models: [] };
	}

	return {
		active: true,
		models: aigwModels.map((m: any): Model<any> => ({
			id: m.id,
			name: m.name || m.id,
			api: "openai-completions" as any,
			provider: "aigw",
			baseUrl: aigwUrl,
			reasoning: m.reasoning ?? false,
			input: m.input ?? ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: m.contextWindow ?? 128_000,
			maxTokens: m.maxTokens ?? 16_384,
		})),
	};
}

/**
 * Apply aigw config to ModelSelector. Safe to call at any time.
 */
export async function applyAigwConfig(prefs: Record<string, unknown>): Promise<void> {
	const { ModelSelector } = await import("../ui/dialogs/ModelSelector.js");
	ModelSelector.aigwConfig = buildAigwModelConfig(prefs);
}
