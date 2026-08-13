/**
 * Per-model thinking-level capabilities. Single source of truth shared
 * between the server (`src/server/`) and the UI (`src/app/`, `src/ui/`).
 *
 * Capability data is consumed exactly as supplied. A model's explicit
 * `thinkingLevelMap` is the only authority for extended `xhigh` and `max`
 * levels; model ids and provider names never grant capabilities.
 *
 * Map-present rules (mirror pi-ai exactly):
 *   - `reasoning === false` → only "off".
 *   - A level whose map value is exactly `null` is DROPPED (explicitly
 *     unsupported). Notably `off: null` = forced adaptive thinking, so "off"
 *     is NOT selectable (e.g. Claude Fable 5 → minimal/low/medium/high/xhigh).
 *   - A level ABSENT from the map is KEPT (uses provider default), except
 *     "xhigh" and "max" which are kept only when present with a non-null value.
 *
 * Map-absent rules:
 *   - `reasoning === true` supports "off" through "high".
 *   - false or unavailable reasoning metadata supports only "off".
 *   - "xhigh" and "max" are never inferred from a model family.
 *
 * Clamping (`clampThinkingLevel`) resolves the requested token (unknown →
 * "off"), returns it if supported, else steps **up** by rank to the
 * next-higher supported level, then down if none exists above. This preserves
 * Pi's clamp direction for maps that drop a middle or low level.
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];

/** Numeric rank for clamping. off=0 .. max=6. */
const RANK: Record<ThinkingLevel, number> = {
	off: 0,
	minimal: 1,
	low: 2,
	medium: 3,
	high: 4,
	xhigh: 5,
	max: 6,
};

/** Ordered low→high for clamp-down traversal. */
const ORDERED: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

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

/** Whether exact per-model metadata advertises the "xhigh" level. */
export function supportsXHigh(m: ModelLike): boolean {
	return m.thinkingLevelMap?.xhigh !== undefined && m.thinkingLevelMap.xhigh !== null;
}

/**
 * Levels supported by the given model.
 *
 * When `thinkingLevelMap` is present, mirror pi-ai's `getSupportedThinkingLevels`
 * exactly: filter the canonical ladder, dropping any level mapped to `null`
 * (e.g. `off: null` = forced adaptive thinking → "off" unsupported) and keeping
 * absent levels (except "xhigh" and "max", which need an explicit non-null entry).
 *
 * When the map is absent, `reasoning === true` enables the base ladder through
 * "high". Missing reasoning metadata is treated conservatively as unknown and
 * supports only "off".
 */
export function getSupportedThinkingLevels(m: ModelLike): ThinkingLevel[] {
	if (m.reasoning === false) return ["off"];
	if (m.thinkingLevelMap !== undefined) {
		const map = m.thinkingLevelMap;
		return THINKING_LEVELS.filter((level) => {
			const mapped = map[level];
			if (mapped === null) return false;          // explicit null → dropped (unsupported)
			if (level === "xhigh" || level === "max") return mapped !== undefined; // extended levels need an explicit non-null entry
			return true;                                 // absent (undefined) → kept (provider default)
		});
	}
	return m.reasoning === true
		? ["off", "minimal", "low", "medium", "high"]
		: ["off"];
}

/**
 * Clamp a user-supplied level to one supported by the model.
 *
 *  - If `level` is supported by the model, returns it unchanged.
 *  - Else steps UP by rank to the nearest supported level, then DOWN — exactly
 *    mirroring pi-ai's `clampThinkingLevel` direction (the runtime source of
 *    truth). Upward-first matters when a map drops a *middle* level while
 *    keeping lower ones (e.g. gpt-5.5's `minimal: null` → supported
 *    off/low/medium/high/xhigh): requesting `minimal` clamps UP to `low`, not
 *    down to `off`, so valid reasoning intent is never silently disabled. It
 *    also covers a map that drops `off` itself (Fable's `off: null`): `off`
 *    clamps up to the lowest supported level rather than returning an
 *    unsupported `off`.
 *  - Unknown strings become "off" first, then are clamped.
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
	// Unknown token → off.
	const token: ThinkingLevel = isThinkingLevel(trimmed) ? (trimmed as ThinkingLevel) : "off";
	if (supportedSet.has(token)) return token;
	// Walk UP by rank to the nearest supported level, then DOWN — matching
	// pi-ai's clampThinkingLevel direction exactly. Upward-first keeps an
	// unsupported middle level (e.g. gpt-5.5 drops "minimal") clamping to the
	// next *higher* supported effort rather than collapsing to "off".
	for (let i = RANK[token] + 1; i < ORDERED.length; i++) {
		const candidate = ORDERED[i];
		if (supportedSet.has(candidate)) return candidate;
	}
	for (let i = RANK[token] - 1; i >= 0; i--) {
		const candidate = ORDERED[i];
		if (supportedSet.has(candidate)) return candidate;
	}
	return supported[0] ?? "off";
}
