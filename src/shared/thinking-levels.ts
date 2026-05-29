/**
 * Per-model thinking-level capabilities. Single source of truth shared
 * between the server (`src/server/`) and the UI (`src/app/`, `src/ui/`).
 *
 * Resolution order:
 *   1. If the model carries upstream per-model metadata (`thinkingLevelMap`),
 *      trust it for xhigh support.
 *   2. Otherwise fall back to Bobbit's family heuristics for sparse model
 *      payloads (notably AI Gateway / fallback persisted state).
 *
 * Base rules:
 *   - "off" is always supported.
 *   - "minimal"/"low"/"medium"/"high" are supported iff the model has
 *     `reasoning === true`.
 *   - Fallback heuristic: "xhigh" is supported by:
 *       • Anthropic Claude Opus 4.6+ (claude-opus-4-6, claude-opus-4.8, …)
 *       • OpenAI gpt-5.1-codex-max
 *       • OpenAI gpt-5.2* / gpt-5.4* / gpt-5.5*
 *
 * Clamping (`clampThinkingLevel`) steps **down** by rank to the next-lower
 * supported level when the requested level is unsupported. Unknown tokens
 * are treated as "off" before clamping, so on a non-reasoning model any
 * unknown input ends up as "off".
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];

/** Numeric rank for clamping. off=0 .. xhigh=5. */
const RANK: Record<ThinkingLevel, number> = {
	off: 0,
	minimal: 1,
	low: 2,
	medium: 3,
	high: 4,
	xhigh: 5,
};

/** Ordered low→high for clamp-down traversal. */
const ORDERED: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/**
 * Minimal model shape consumed by capability detection. Mirrors the fields
 * present on both server `ApiModel` and the UI client `state.model`.
 */
export interface ModelLike {
	/** Model identifier, e.g. "claude-opus-4-7-20251101" or "gpt-5.2-codex". */
	id: string;
	/** Provider key, e.g. "anthropic", "openai", "aigw", "google". */
	provider?: string;
	/** Whether the model supports reasoning/thinking at all. */
	reasoning?: boolean;
	/** Optional upstream per-model effort metadata from pi-ai. */
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

/** Test whether a value is one of the canonical thinking levels. */
export function isThinkingLevel(v: unknown): v is ThinkingLevel {
	return typeof v === "string" && (THINKING_LEVELS as readonly string[]).includes(v);
}

/**
 * Validate-or-drop. Returns the canonical level token if `value` is a known
 * thinking level (after trimming), else `undefined`. Does NOT consult any
 * model — clamping happens at use-time against a resolved model.
 */
export function isKnownThinkingLevel(value: unknown): ThinkingLevel | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return isThinkingLevel(trimmed) ? (trimmed as ThinkingLevel) : undefined;
}

/**
 * Provider guards for xhigh capability. We fail CLOSED on cross-provider id
 * collisions: a model whose id resembles an Anthropic family but is served
 * via OpenAI (or vice versa) does not light up xhigh.
 *
 * Rules:
 *   - If `provider` is the canonical owner string for the family
 *     (`anthropic` / `openai`) → accept.
 *   - If `provider` is `aigw` (or empty) → accept, then rely on the id check.
 *     aigw routes models from many upstreams but preserves the canonical id.
 *   - Any other provider (`openai` for a `claude-*` id, `google`, etc.) →
 *     reject regardless of id.
 */
function providerMatches(provider: string, canonical: "anthropic" | "openai"): boolean {
	if (!provider) return true; // legacy / client state with unset provider
	if (provider === canonical) return true;
	if (provider === "aigw") return true;
	return false;
}

/**
 * Does the given model's id/provider indicate Anthropic Opus 4.6 or later?
 * Matches `claude-opus-4-N` and `claude-opus-4.N` where N is 6..9 or any
 * 2+ digit number, so future 4.10+ revisions work without a code change.
 */
function isOpusXHigh(id: string, provider: string): boolean {
	if (!providerMatches(provider, "anthropic")) return false;
	return /claude-opus-4(?:-|\.)(?:[6-9]|\d{2,})\b/i.test(id);
}

/**
 * Does the given model's id/provider indicate an OpenAI family that
 * supports xhigh in Bobbit's fallback heuristic? Currently
 * gpt-5.1-codex-max and any gpt-5.2* / gpt-5.4* / gpt-5.5*.
 */
function isOpenAiXHigh(id: string, provider: string): boolean {
	if (!providerMatches(provider, "openai")) return false;
	if (/^gpt-5\.1-codex-max\b/i.test(id)) return true;
	if (/^gpt-5\.(?:2|4|5)(?:\b|[-.])/i.test(id)) return true;
	return false;
}

/**
 * Whether the given model supports the "xhigh" thinking level.
 *
 * Prefer upstream per-model metadata when present (`thinkingLevelMap`) so
 * newly-added model families light up automatically without a Bobbit code
 * change. Fall back to id/provider heuristics for sparse payloads such as
 * AI Gateway discovery and persisted fallback state.
 */
export function supportsXHigh(m: ModelLike): boolean {
	if (m.thinkingLevelMap !== undefined) {
		return m.thinkingLevelMap.xhigh !== undefined && m.thinkingLevelMap.xhigh !== null;
	}
	const id = m.id || "";
	const provider = (m.provider || "").toLowerCase();
	return isOpusXHigh(id, provider) || isOpenAiXHigh(id, provider);
}

/**
 * Levels supported by the given model.
 *  - reasoning === false → only "off".
 *  - else → off, minimal, low, medium, high (+ xhigh iff `supportsXHigh`).
 *
 * If `reasoning` is undefined (legacy client state), default to true so
 * existing reasoning-capable selectors keep working; the server filters
 * non-reasoning models at the boundary via the registry-derived metadata.
 */
export function getSupportedThinkingLevels(m: ModelLike): ThinkingLevel[] {
	if (m.reasoning === false) return ["off"];
	const base: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
	return supportsXHigh(m) ? [...base, "xhigh"] : base;
}

/**
 * Clamp a user-supplied level to one supported by the model.
 *
 *  - If `level` is supported by the model, returns it unchanged.
 *  - Else steps DOWN by rank (xhigh→high→medium→low→minimal→off) until
 *    a supported level is found. "off" is always supported so the walk
 *    always terminates.
 *  - Unknown strings become "off" first, then are clamped (which yields
 *    "off" on any model).
 *  - If `level` is undefined/empty AND `opts.allowEmpty` is true, returns
 *    `undefined` (used by role overrides / prefs that mean "inherit").
 */
export function clampThinkingLevel(
	level: string | undefined | null,
	m: ModelLike,
	opts?: { allowEmpty?: boolean },
): ThinkingLevel | undefined {
	if (level === undefined || level === null || (typeof level === "string" && level.trim() === "")) {
		if (opts?.allowEmpty) return undefined;
		return "off";
	}
	const trimmed = typeof level === "string" ? level.trim() : "";
	const supported = getSupportedThinkingLevels(m);
	const supportedSet = new Set(supported);
	// Unknown token → off (also guarantees presence in `supported`).
	let token: ThinkingLevel = isThinkingLevel(trimmed) ? (trimmed as ThinkingLevel) : "off";
	if (supportedSet.has(token)) return token;
	// Walk down by rank until we hit a supported level.
	for (let i = RANK[token] - 1; i >= 0; i--) {
		const candidate = ORDERED[i];
		if (supportedSet.has(candidate)) return candidate;
	}
	return "off";
}
