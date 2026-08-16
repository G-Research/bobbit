/**
 * Browser-safe model recency ranks shared by server auto-selection and the
 * model selector UI.
 */

/** Recency rank for the speculative GPT-5.5 tier. Higher = newer/better. */
export const GPT_55_RECENCY_RANK = 104;

/**
 * Fixed aliases accepted only by the Claude Agent SDK. Keep this provider-aware:
 * other providers may legitimately expose similarly named models with unrelated
 * semantics.
 */
const CLAUDE_AGENT_SDK_RECENCY_IDS: Readonly<Record<string, string>> = {
	sonnet: "claude-sonnet-5",
	opus: "claude-opus-5",
	fable: "claude-fable-5",
	haiku: "claude-haiku-4-5",
};

function claudeOpus4Minor(id: string): number | undefined {
	// Limit the minor capture to version-looking values so date-only IDs like
	// claude-opus-4-20250514 remain in the generic Opus 4 tier.
	const match = id.toLowerCase().match(/claude-opus-4(?:-|\.)(\d{1,3})\b/);
	return match ? Number(match[1]) : undefined;
}

function claudeOpus4Rank(id: string): number | undefined {
	const minor = claudeOpus4Minor(id);
	if (minor === undefined) return undefined;
	if (minor === 1) return 96;
	// No future-looking Opus 4 minor may overtake the intentional Claude 5 tiers.
	return Math.min(110, 88 + minor * 2);
}

function claude5Family(id: string): "fable" | "opus" | "sonnet" | undefined {
	// Match a complete bare/provider-prefixed Claude ID or a regional/non-regional
	// Bedrock profile. Do not rank arbitrary names that merely contain `opus-5`.
	const match = id.toLowerCase().match(
		/(?:^|\/)(?:claude-(fable|opus|sonnet)-5|(?:(?:au|eu|global|jp|us)\.)?anthropic\.claude-(fable|opus|sonnet)-5)(?:$|[-.:])/,
	);
	return (match?.[1] ?? match?.[2]) as "fable" | "opus" | "sonnet" | undefined;
}

/**
 * Rank a model ID by recency/quality tier. Higher = newer/better.
 * Models not matching a known family return 0.
 */
export function modelRecencyRank(id: string): number {
	const s = id.toLowerCase();

	// ── Anthropic Claude ──
	const claude5 = claude5Family(s);
	if (claude5 === "fable") return 113;
	if (claude5 === "opus") return 112;
	if (claude5 === "sonnet") return 111;
	const opus4Rank = claudeOpus4Rank(s);
	if (opus4Rank !== undefined) return opus4Rank;
	if (s.includes("claude-sonnet-4-6") || s.includes("claude-sonnet-4.6")) return 99;
	if (s.includes("claude-sonnet-4-5") || s.includes("claude-sonnet-4.5")) return 97;
	if (s.includes("claude-opus-4")) return 95;
	if (s.includes("claude-sonnet-4") && !s.includes("4-5") && !s.includes("4.5") && !s.includes("4-6") && !s.includes("4.6")) return 94;
	if (s.includes("claude-haiku-4-5") || s.includes("claude-haiku-4.5")) return 90;
	if (s.includes("claude-3-7-sonnet") || s.includes("claude-3.7-sonnet")) return 80;
	if (s.includes("claude-3-5-sonnet") || s.includes("claude-3.5-sonnet")) return 70;
	if (s.includes("claude-3-5-haiku") || s.includes("claude-3.5-haiku")) return 65;
	if (s.includes("claude-3-opus")) return 60;
	if (s.includes("claude")) return 50;

	// ── OpenAI ──
	if (s.includes("gpt-5.5")) return GPT_55_RECENCY_RANK;
	if (s.includes("gpt-5.4")) return 100;
	if (s.includes("gpt-5.3")) return 98;
	if (s.includes("gpt-5.2")) return 96;
	if (s.includes("gpt-5.1")) return 94;
	if (s.includes("gpt-5") && !s.includes("5.")) return 92;
	if (s.includes("o4-mini")) return 91;
	if (s.includes("o3-pro")) return 89;
	if (s.includes("o3") && !s.includes("o3-mini")) return 88;
	if (s.includes("o3-mini")) return 85;
	if (s.includes("o1-pro")) return 80;
	if (s.includes("o1") && !s.includes("o1-mini")) return 78;
	if (s.includes("gpt-4o") && !s.includes("mini")) return 70;
	if (s.includes("gpt-4.1")) return 68;
	if (s.includes("gpt-4o-mini") || s.includes("gpt-4.1-mini")) return 65;
	if (s.includes("gpt-4")) return 50;

	// ── Google Gemini ──
	if (s.includes("gemini-3.1-pro")) return 100;
	if (s.includes("gemini-3-pro")) return 98;
	if (s.includes("gemini-3.1-flash") || s.includes("gemini-3-flash")) return 95;
	if (s.includes("gemini-2.5-pro")) return 90;
	if (s.includes("gemini-2.5-flash") && !s.includes("lite")) return 85;
	if (s.includes("gemini-2.5-flash-lite")) return 80;
	if (s.includes("gemini-2.0")) return 60;
	if (s.includes("gemini-1.5")) return 40;
	if (s.includes("gemini")) return 30;

	// ── xAI Grok ──
	if (s.includes("grok-4")) return 100;
	if (s.includes("grok-3") && !s.includes("mini")) return 90;
	if (s.includes("grok-3-mini")) return 85;
	if (s.includes("grok-2")) return 70;
	if (s.includes("grok")) return 50;

	// ── DeepSeek ──
	if (s.includes("deepseek-v3.2")) return 95;
	if (s.includes("deepseek-v3.1")) return 90;
	if (s.includes("deepseek-r1")) return 88;
	if (s.includes("deepseek-v3")) return 85;
	if (s.includes("deepseek")) return 50;

	// ── Qwen ──
	if (s.includes("qwen3.5") || s.includes("qwen-3.5")) return 95;
	if (s.includes("qwen3-coder") || s.includes("qwen-3-coder")) return 90;
	if (s.includes("qwen3-next") || s.includes("qwen-3-next")) return 88;
	if (s.includes("qwen3") || s.includes("qwen-3")) return 85;
	if (s.includes("qwen")) return 50;

	// ── Mistral ──
	if (s.includes("devstral-medium")) return 90;
	if (s.includes("magistral")) return 88;
	if (s.includes("devstral")) return 85;
	if (s.includes("codestral")) return 80;
	if (s.includes("mistral-large")) return 75;
	if (s.includes("mistral-medium")) return 70;
	if (s.includes("mistral")) return 50;

	// ── Llama ──
	if (s.includes("llama-4") || s.includes("llama4")) return 90;
	if (s.includes("llama-3.3") || s.includes("llama3-3")) return 80;
	if (s.includes("llama-3.2") || s.includes("llama3-2")) return 70;
	if (s.includes("llama")) return 50;

	return 0;
}

/**
 * Rank a provider/model pair. Claude Agent SDK aliases inherit the rank of
 * their pinned canonical catalog rows; every other provider preserves generic
 * ID-only ranking.
 */
export function modelRecencyRankFor(provider: string, id: string): number {
	return modelRecencyRank(
		provider === "claude-agent-sdk" ? (CLAUDE_AGENT_SDK_RECENCY_IDS[id] ?? id) : id,
	);
}
