/**
 * Legacy-zero classification helper for tree-cost rows.
 *
 * A "legacy zero" row is one whose goal predates the per-goal cost tracking
 * feature (sidecar-based goalId stamping) and therefore has $0 / 0 tokens in
 * the per-goal breakdown even though it clearly did real work. Its spend is
 * instead aggregated into the residual `unattributableLegacy` bucket
 * rendered at the bottom of the tree-cost breakdown table.
 *
 * The classification is broken out into a pure module so unit tests can pin
 * the threshold logic without exporting dashboard internals. The render path
 * MUST go through {@link isLegacyUnattributableTreeCostRow}; do not inline a
 * hardcoded date in the renderer.
 */

/**
 * Fallback threshold used when the server-supplied
 * `unattributableLegacy.firstSeenAt` is missing. Represents the approximate
 * landing of the session-sidecar feature (commit `a407aa4a`, 2026-05-11):
 * any goal created BEFORE this could only have had per-goal cost attribution
 * via the boot-time backfill.
 *
 * This is deliberately conservative (one full day before the commit landed)
 * so we never mis-flag a recent zero-cost goal as "legacy". Tests pin this
 * constant; do not move/inline it.
 */
export const EARLIEST_SIDECAR_TIMESTAMP_MS = Date.UTC(2026, 4, 11, 0, 0, 0);
/** Back-compat alias for tests/consumers that name the fallback by purpose. */
export const LEGACY_THRESHOLD_FALLBACK_MS = EARLIEST_SIDECAR_TIMESTAMP_MS;

export interface LegacyTreeCostBreakdownEntry {
	costUsd: number;
	tokensIn: number;
	tokensOut: number;
}

export interface LegacyTreeCostUnattributableLegacy {
	costUsd: number;
	tokensIn: number;
	tokensOut: number;
	firstSeenAt?: number;
}

export interface LegacyTreeCost {
	unattributableLegacy?: LegacyTreeCostUnattributableLegacy;
}

export interface LegacyTreeCostGoal {
	createdAt: number;
}

/**
 * Resolve the threshold timestamp used to decide whether a zero-cost goal
 * predates per-goal cost tracking. Prefers the server-supplied oldest-entry
 * timestamp from the unattributable bucket; falls back to
 * {@link EARLIEST_SIDECAR_TIMESTAMP_MS}.
 */
export function resolveLegacyThresholdMs(
	treeCost: LegacyTreeCost | null | undefined,
): number {
	const fromServer = treeCost?.unattributableLegacy?.firstSeenAt;
	if (typeof fromServer === "number" && Number.isFinite(fromServer) && fromServer > 0) {
		return fromServer;
	}
	return EARLIEST_SIDECAR_TIMESTAMP_MS;
}

/**
 * True when a breakdown row should be displayed as "legacy $0" (muted
 * italic, `(legacy)` suffix). All four conditions must hold:
 *
 *   1. `treeCost.unattributableLegacy` exists and has non-zero spend
 *      (cost or tokens) — otherwise there is no bucket to point at.
 *   2. The breakdown entry is exactly zero on every axis.
 *   3. The goal is known.
 *   4. The goal's `createdAt` is strictly older than the resolved threshold.
 */
export function isLegacyUnattributableTreeCostRow(
	goal: LegacyTreeCostGoal | null | undefined,
	entry: LegacyTreeCostBreakdownEntry | null | undefined,
	treeCost: LegacyTreeCost | null | undefined,
): boolean {
	if (!goal || !entry || !treeCost) return false;
	const u = treeCost.unattributableLegacy;
	if (!u) return false;
	const bucketHasSpend = u.costUsd > 0 || u.tokensIn > 0 || u.tokensOut > 0;
	if (!bucketHasSpend) return false;
	if (entry.costUsd !== 0 || entry.tokensIn !== 0 || entry.tokensOut !== 0) {
		return false;
	}
	if (typeof goal.createdAt !== "number" || !Number.isFinite(goal.createdAt)) {
		return false;
	}
	const threshold = resolveLegacyThresholdMs(treeCost);
	return goal.createdAt < threshold;
}

/** Tooltip shown on legacy-zero rows. Exported so tests can pin the copy. */
export const LEGACY_TREE_COST_ROW_TOOLTIP =
	"$0.0000 (legacy) — this goal predates per-goal cost tracking. " +
	"Its spend is included in the Unattributable (legacy) bucket at " +
	"the bottom of this list.";
