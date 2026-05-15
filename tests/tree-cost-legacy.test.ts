/**
 * Unit tests for the tree-cost legacy-zero classifier helper.
 *
 * Design ("transcript-pass cost backfill + legacy-zero UI"):
 *   `isLegacyUnattributableTreeCostRow(goal, breakdownEntry, treeCost)`
 *   lives in `src/app/tree-cost-legacy.ts` and returns true iff:
 *
 *   1. `treeCost.unattributableLegacy` exists AND has non-zero
 *      `costUsd` OR non-zero `tokensIn` OR non-zero `tokensOut`.
 *   2. The breakdown entry is exactly zero on all three of
 *      `costUsd`, `tokensIn`, `tokensOut`.
 *   3. The goal exists AND `goal.createdAt < threshold`, where
 *      threshold = `treeCost.unattributableLegacy.firstSeenAt` when
 *      present, otherwise an exported fallback constant
 *      (`LEGACY_THRESHOLD_FALLBACK_MS`) representing earliest sidecar
 *      support. Threshold MUST NOT be hardcoded inline in the render
 *      path — that's the regression this file pins.
 *
 * The helper module is created by the implementation task. This file
 * dynamic-imports it and `skip`s gracefully until the module exists.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

type BreakdownLike = { goalId: string; costUsd: number; tokensIn: number; tokensOut: number };
type UnattributableLike = { goalId: "__unattributable__"; title: string; costUsd: number; tokensIn: number; tokensOut: number; firstSeenAt?: number };
type TreeCostLike = { unattributableLegacy?: UnattributableLike };
type GoalLike = { id: string; createdAt: number };

type HelperFn = (goal: GoalLike | undefined, entry: BreakdownLike, treeCost: TreeCostLike) => boolean;

// Top-level await so `importError` is set BEFORE `it()` calls are registered
// — node:test reads the `skip` option at registration time, not at run time.
let isLegacyUnattributableTreeCostRow: HelperFn | undefined;
let LEGACY_THRESHOLD_FALLBACK_MS: number | undefined;
let importError: string | undefined;
try {
	const mod = await import("../src/app/tree-cost-legacy.ts") as unknown as {
		isLegacyUnattributableTreeCostRow?: HelperFn;
		LEGACY_THRESHOLD_FALLBACK_MS?: number;
	};
	isLegacyUnattributableTreeCostRow = mod.isLegacyUnattributableTreeCostRow;
	LEGACY_THRESHOLD_FALLBACK_MS = mod.LEGACY_THRESHOLD_FALLBACK_MS;
	if (!isLegacyUnattributableTreeCostRow || typeof LEGACY_THRESHOLD_FALLBACK_MS !== "number") {
		importError = "missing exports: isLegacyUnattributableTreeCostRow and/or LEGACY_THRESHOLD_FALLBACK_MS";
	}
} catch (err) {
	importError = String(err);
}

function pendingReason(): string | false {
	return importError ? `pending impl — ${importError}` : false;
}

const ZERO_ENTRY = (goalId = "g1"): BreakdownLike => ({ goalId, costUsd: 0, tokensIn: 0, tokensOut: 0 });
const NON_ZERO_BUCKET = (firstSeenAt?: number): UnattributableLike => ({
	goalId: "__unattributable__",
	title: "Unattributable (legacy)",
	costUsd: 12.34,
	tokensIn: 1000,
	tokensOut: 500,
	...(firstSeenAt !== undefined ? { firstSeenAt } : {}),
});

describe("isLegacyUnattributableTreeCostRow", () => {
	it("uses treeCost.unattributableLegacy.firstSeenAt as threshold when present", { skip: pendingReason() }, () => {
		const firstSeenAt = 1_700_000_000_000;
		const treeCost = { unattributableLegacy: NON_ZERO_BUCKET(firstSeenAt) };
		const goalOld: GoalLike = { id: "g1", createdAt: firstSeenAt - 1 };
		const goalNew: GoalLike = { id: "g1", createdAt: firstSeenAt + 1 };

		assert.equal(isLegacyUnattributableTreeCostRow!(goalOld, ZERO_ENTRY(), treeCost), true);
		assert.equal(isLegacyUnattributableTreeCostRow!(goalNew, ZERO_ENTRY(), treeCost), false,
			"goals created after the firstSeenAt threshold are NOT legacy zeros");
	});

	it("falls back to LEGACY_THRESHOLD_FALLBACK_MS when firstSeenAt missing", { skip: pendingReason() }, () => {
		const treeCost = { unattributableLegacy: NON_ZERO_BUCKET(undefined) };
		// Pre-fallback goal — should classify as legacy.
		const goalOld: GoalLike = { id: "g1", createdAt: LEGACY_THRESHOLD_FALLBACK_MS! - 1 };
		// Post-fallback goal — should NOT classify.
		const goalNew: GoalLike = { id: "g1", createdAt: LEGACY_THRESHOLD_FALLBACK_MS! + 1 };

		assert.equal(isLegacyUnattributableTreeCostRow!(goalOld, ZERO_ENTRY(), treeCost), true);
		assert.equal(isLegacyUnattributableTreeCostRow!(goalNew, ZERO_ENTRY(), treeCost), false);
	});

	it("returns false when the breakdown entry has any non-zero cost or token field", { skip: pendingReason() }, () => {
		const firstSeenAt = 1_700_000_000_000;
		const treeCost = { unattributableLegacy: NON_ZERO_BUCKET(firstSeenAt) };
		const goal: GoalLike = { id: "g1", createdAt: firstSeenAt - 1 };

		assert.equal(isLegacyUnattributableTreeCostRow!(goal, { goalId: "g1", costUsd: 0.001, tokensIn: 0, tokensOut: 0 }, treeCost), false);
		assert.equal(isLegacyUnattributableTreeCostRow!(goal, { goalId: "g1", costUsd: 0, tokensIn: 1, tokensOut: 0 }, treeCost), false);
		assert.equal(isLegacyUnattributableTreeCostRow!(goal, { goalId: "g1", costUsd: 0, tokensIn: 0, tokensOut: 1 }, treeCost), false);
	});

	it("returns false when treeCost.unattributableLegacy is missing entirely", { skip: pendingReason() }, () => {
		const goal: GoalLike = { id: "g1", createdAt: 1 };
		assert.equal(isLegacyUnattributableTreeCostRow!(goal, ZERO_ENTRY(), {}), false);
	});

	it("returns false when unattributable bucket exists but is itself all-zero", { skip: pendingReason() }, () => {
		const treeCost = {
			unattributableLegacy: { goalId: "__unattributable__" as const, title: "Unattributable (legacy)", costUsd: 0, tokensIn: 0, tokensOut: 0 },
		};
		const goal: GoalLike = { id: "g1", createdAt: 1 };
		assert.equal(isLegacyUnattributableTreeCostRow!(goal, ZERO_ENTRY(), treeCost), false,
			"no point flagging legacy when there is no residual spend to surface");
	});

	it("returns false when goal is unknown (caller couldn't resolve it)", { skip: pendingReason() }, () => {
		const treeCost = { unattributableLegacy: NON_ZERO_BUCKET(1_700_000_000_000) };
		assert.equal(isLegacyUnattributableTreeCostRow!(undefined, ZERO_ENTRY(), treeCost), false);
	});

	it("LEGACY_THRESHOLD_FALLBACK_MS is a sane positive epoch timestamp (not inline-hardcoded in render path)", { skip: pendingReason() }, () => {
		// The constant is exported precisely so render code never needs an
		// inline date literal. We don't pin its exact value (impl detail —
		// derived from earliest sidecar support), but we DO pin shape:
		// positive number representing a real ms epoch in the past.
		assert.equal(typeof LEGACY_THRESHOLD_FALLBACK_MS, "number");
		assert.ok(LEGACY_THRESHOLD_FALLBACK_MS! > 0, "must be a positive epoch ms");
		assert.ok(LEGACY_THRESHOLD_FALLBACK_MS! < Date.now(),
			"fallback threshold must be in the past — sidecar epoch is historical");
	});

	it("equal createdAt and threshold is NOT considered legacy (strict less-than)", { skip: pendingReason() }, () => {
		// Pins the strict `<` (not `<=`) contract from the design. A goal
		// created exactly at the firstSeenAt boundary already had sidecar
		// support and should NOT be classified legacy.
		const firstSeenAt = 1_700_000_000_000;
		const treeCost = { unattributableLegacy: NON_ZERO_BUCKET(firstSeenAt) };
		const goal: GoalLike = { id: "g1", createdAt: firstSeenAt };
		assert.equal(isLegacyUnattributableTreeCostRow!(goal, ZERO_ENTRY(), treeCost), false);
	});
});
