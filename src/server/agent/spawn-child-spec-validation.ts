/**
 * Shared spec validation for the spawn-child path.
 *
 * Called from:
 *   - `nested-goal-routes.ts` (POST /api/goals/:id/spawn-child)
 *   - `verification-harness.ts` (runSubgoalStep — harness-spawned children)
 *
 * Both paths must reject placeholder specs so that child team-leads always
 * receive the real task description in their first user message. The
 * placeholder-then-PUT pattern is explicitly unsupported: the team-lead's
 * first message is built from the spec at spawn time, so a placeholder spec
 * means the team-lead has no task context.
 */

export type SpecValidationOk = { ok: true };
export type SpecValidationFail = {
	ok: false;
	code: "SPEC_TOO_SHORT" | "SPEC_PLACEHOLDER";
	error: string;
	actualLength?: number;
	minLength?: number;
};
export type SpecValidationResult = SpecValidationOk | SpecValidationFail;

/** Minimum meaningful spec length. Rejects single-word placeholders. */
export const MIN_SPEC_LENGTH = 50;

/**
 * Words that are obviously placeholder values. Matched against the full
 * (trimmed, lowercased) spec only — so a real spec that happens to contain
 * "placeholder" as part of a longer description passes fine.
 */
const PLACEHOLDER_PATTERN = /^(placeholder|tbd|todo|wip|test|temp)\.?\s*$/i;

/** Returns true when the spec looks like a placeholder string. */
export function looksLikePlaceholder(spec: string): boolean {
	return PLACEHOLDER_PATTERN.test(spec.trim());
}

/**
 * Validate that a `spec` string is not a placeholder.
 *
 * Returns `{ ok: true }` on success, or `{ ok: false, code, error }` on
 * failure. Callers are responsible for converting the failure into their
 * appropriate response (HTTP 400 or a `{ passed: false }` harness result).
 */
export function validateSpawnChildSpec(spec: string): SpecValidationResult {
	const trimmed = spec.trim();

	if (PLACEHOLDER_PATTERN.test(trimmed)) {
		return {
			ok: false,
			code: "SPEC_PLACEHOLDER",
			error: `Goal spec looks like a placeholder ("${trimmed.slice(0, 30)}"). Pass the real task description at spawn time — the child team-lead's first message is built from this spec.`,
		};
	}

	if (trimmed.length < MIN_SPEC_LENGTH) {
		return {
			ok: false,
			code: "SPEC_TOO_SHORT",
			error: `Goal spec must be at least ${MIN_SPEC_LENGTH} characters (got ${trimmed.length}). Placeholder specs and two-stage PUT-after-spawn are not supported — the team-lead reads the spec from its first user message, which must contain the real task.`,
			actualLength: trimmed.length,
			minLength: MIN_SPEC_LENGTH,
		};
	}

	return { ok: true };
}
