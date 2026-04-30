/**
 * Pure helpers for the New Goal dialog.
 *
 * Kept in a standalone module so the predicates can be unit-tested via the
 * Node test runner without bundling Lit / DOM dependencies. See
 * `docs/design/nested-goals.md` §10.4 + §14.2.
 */

import { parseAcceptanceCriteria } from "../shared/acceptance-criteria.js";

/**
 * Returns `true` if a goal spec looks like a multi-phase / multi-version
 * delivery program for which the `parent` workflow is the better default.
 *
 * Three independent signals — any one is sufficient:
 *
 *   1. `spec.length > 5000`
 *   2. `/v0\.\d|v\d\.\d|phase\s*\d|milestone/i.test(spec)`
 *   3. `parseAcceptanceCriteria(spec).length >= 5`
 *
 * The predicate is **suggestion-only** — the New Goal dialog never auto-
 * selects the `parent` workflow; it surfaces a non-blocking banner the
 * user can accept or dismiss.
 */
export function isMultiPhaseSpec(spec: string): boolean {
	if (!spec || typeof spec !== "string") return false;
	if (spec.length > 5000) return true;
	if (/v0\.\d|v\d\.\d|phase\s*\d|milestone/i.test(spec)) return true;
	if (parseAcceptanceCriteria(spec).length >= 5) return true;
	return false;
}

/**
 * Per-project localStorage key for the multi-phase suggestion banner's
 * "Keep current" dismissal. Sessions in the same project share the
 * dismissal; new projects re-show the banner.
 */
export function multiPhaseBannerDismissedKey(projectId: string): string {
	return `bobbit-multiphase-banner-dismissed-${projectId}`;
}

/**
 * Returns `true` if the user has dismissed the multi-phase banner for the
 * given project. Safe under privacy modes that disable storage.
 */
export function isMultiPhaseBannerDismissed(projectId: string): boolean {
	try {
		return localStorage.getItem(multiPhaseBannerDismissedKey(projectId)) === "1";
	} catch {
		return false;
	}
}

/**
 * Persist a "Keep current" dismissal of the multi-phase suggestion banner
 * for the given project. Idempotent.
 */
export function dismissMultiPhaseBanner(projectId: string): void {
	try {
		localStorage.setItem(multiPhaseBannerDismissedKey(projectId), "1");
	} catch {
		/* storage unavailable — banner stays open this session, no harm */
	}
}
