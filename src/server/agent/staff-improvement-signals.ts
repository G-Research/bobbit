import type { StaffImprovementSignals, StaffTranscriptPattern } from "./decision-hook-contract.js";

const MAX_WINDOW_TURNS = 20;
const PATTERNS = new Set<StaffTranscriptPattern>([
	"repeated-user-correction",
	"repeated-tool-failure",
	"repeated-goal-blocker",
]);

/**
 * Defensive boundary for the optional fixture-only signal source. Production
 * currently has no retained, transcript-safe turn histogram owner, so callers
 * must pass `undefined`; this function never inspects session text or messages.
 */
export function snapshotStaffImprovementSignals(value: unknown): StaffImprovementSignals | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	if (Object.keys(value).length !== 2 || !Object.hasOwn(value, "windowTurns") || !Object.hasOwn(value, "patterns")) return undefined;
	const raw = value as { windowTurns?: unknown; patterns?: unknown };
	if (typeof raw.windowTurns !== "number" || !Number.isSafeInteger(raw.windowTurns) || raw.windowTurns < 1 || raw.windowTurns > MAX_WINDOW_TURNS || !Array.isArray(raw.patterns)) return undefined;
	const patterns: Array<Readonly<{ kind: StaffTranscriptPattern; count: number }>> = [];
	const seen = new Set<StaffTranscriptPattern>();
	for (const candidate of raw.patterns) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
		if (Object.keys(candidate).length !== 2 || !Object.hasOwn(candidate, "kind") || !Object.hasOwn(candidate, "count")) return undefined;
		const { kind, count } = candidate as { kind?: unknown; count?: unknown };
		if (typeof kind !== "string" || !PATTERNS.has(kind as StaffTranscriptPattern) || seen.has(kind as StaffTranscriptPattern)
			|| typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || count > MAX_WINDOW_TURNS) return undefined;
		seen.add(kind as StaffTranscriptPattern);
		patterns.push(Object.freeze({ kind: kind as StaffTranscriptPattern, count }));
	}
	return Object.freeze({ windowTurns: raw.windowTurns, patterns: Object.freeze(patterns) });
}
