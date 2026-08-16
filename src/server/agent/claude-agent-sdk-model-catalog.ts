import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

/** The only provider identity that selects the Claude Agent SDK runtime. */
export const CLAUDE_AGENT_SDK_PROVIDER = "claude-agent-sdk";

/**
 * Stable Agent SDK aliases in picker order. The SDK accepts these aliases, not
 * Pi's dated Anthropic model ids; every other field comes from its pinned Pi
 * canonical row so capabilities and pricing stay in sync with that catalog.
 */
const ALIAS_SOURCES = [
	["sonnet", "claude-sonnet-5"],
	["opus", "claude-opus-5"],
	["fable", "claude-fable-5"],
	["haiku", "claude-haiku-4-5"],
] as const;

export const CLAUDE_AGENT_SDK_MODEL_ALIASES = ALIAS_SOURCES.map(([alias]) => alias);

/** The model shape consumed by model-registry without importing it cyclically. */
export interface ClaudeAgentSdkCatalogModel {
	id: (typeof CLAUDE_AGENT_SDK_MODEL_ALIASES)[number];
	name: string;
	provider: typeof CLAUDE_AGENT_SDK_PROVIDER;
	api: string;
	baseUrl?: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input: ("text" | "image")[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		tiers?: Array<{ input: number; output: number; cacheRead: number; cacheWrite: number; inputTokensAbove: number }>;
	};
	headers?: Record<string, string>;
	compat?: unknown;
	authenticated: boolean;
}

type CanonicalAnthropicModel = Omit<ClaudeAgentSdkCatalogModel, "id" | "provider" | "authenticated"> & { id: string };

/**
 * Build the fixed SDK picker catalog from Pi's exact Anthropic rows. Missing a
 * pinned row is an upgrade error: silently offering a partial alias list would
 * make selection behavior depend on a package drift.
 */
export function getClaudeAgentSdkModels(authenticated: boolean): ClaudeAgentSdkCatalogModel[] {
	return ALIAS_SOURCES.map(([alias, canonicalId]) => {
		const canonical = getBuiltinModel("anthropic" as any, canonicalId as any) as unknown as CanonicalAnthropicModel | undefined;
		if (!canonical) throw new Error(`Missing pinned Anthropic catalog row: ${canonicalId}`);
		return {
			...canonical,
			id: alias,
			provider: CLAUDE_AGENT_SDK_PROVIDER,
			authenticated,
		};
	});
}

/** Custom provider names and ids must never impersonate the built-in SDK runtime. */
export function isReservedClaudeAgentSdkProvider(value: string | undefined): boolean {
	return value?.trim().toLowerCase() === CLAUDE_AGENT_SDK_PROVIDER;
}
