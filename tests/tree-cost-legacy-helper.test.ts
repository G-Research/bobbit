/**
 * Unit tests for the legacy-zero tree-cost row classification helper.
 *
 * Pinned contract (see `src/app/tree-cost-legacy.ts`):
 *  - Threshold prefers `treeCost.unattributableLegacy.firstSeenAt` when present
 *    (positive finite number); otherwise falls back to
 *    `EARLIEST_SIDECAR_TIMESTAMP_MS`.
 *  - A row is "legacy" only when ALL of the following hold:
 *      1. Non-zero `unattributableLegacy` bucket exists.
 *      2. Entry is exactly zero across cost AND both token axes.
 *      3. Goal is known and has a finite numeric `createdAt`.
 *      4. `goal.createdAt < threshold`.
 *  - The render path MUST NOT inline a hardcoded date; this test pins the
 *    constant so a future refactor cannot silently reintroduce one.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
	isLegacyUnattributableTreeCostRow,
	resolveLegacyThresholdMs,
	EARLIEST_SIDECAR_TIMESTAMP_MS,
	LEGACY_TREE_COST_ROW_TOOLTIP,
} = await import("../src/app/tree-cost-legacy.ts");

const zeroEntry = { costUsd: 0, tokensIn: 0, tokensOut: 0 };
const nonZeroBucket = { costUsd: 12.34, tokensIn: 1000, tokensOut: 2000 };

describe("resolveLegacyThresholdMs", () => {
	it("prefers server-supplied firstSeenAt when positive and finite", () => {
		const t = resolveLegacyThresholdMs({
			unattributableLegacy: { ...nonZeroBucket, firstSeenAt: 1_700_000_000_000 },
		});
		assert.equal(t, 1_700_000_000_000);
	});

	it("falls back to EARLIEST_SIDECAR_TIMESTAMP_MS when missing", () => {
		assert.equal(resolveLegacyThresholdMs(null), EARLIEST_SIDECAR_TIMESTAMP_MS);
		assert.equal(resolveLegacyThresholdMs({}), EARLIEST_SIDECAR_TIMESTAMP_MS);
		assert.equal(
			resolveLegacyThresholdMs({ unattributableLegacy: nonZeroBucket }),
			EARLIEST_SIDECAR_TIMESTAMP_MS,
		);
	});

	it("falls back when firstSeenAt is zero, negative, or non-finite", () => {
		const fb = EARLIEST_SIDECAR_TIMESTAMP_MS;
		assert.equal(
			resolveLegacyThresholdMs({ unattributableLegacy: { ...nonZeroBucket, firstSeenAt: 0 } }),
			fb,
		);
		assert.equal(
			resolveLegacyThresholdMs({ unattributableLegacy: { ...nonZeroBucket, firstSeenAt: -1 } }),
			fb,
		);
		assert.equal(
			resolveLegacyThresholdMs({
				unattributableLegacy: { ...nonZeroBucket, firstSeenAt: Number.NaN },
			}),
			fb,
		);
	});
});

describe("isLegacyUnattributableTreeCostRow", () => {
	const oldGoal = { createdAt: 1_600_000_000_000 }; // long before any threshold
	const newGoal = { createdAt: Date.now() + 1_000_000 };

	it("returns false when treeCost is null/undefined", () => {
		assert.equal(isLegacyUnattributableTreeCostRow(oldGoal, zeroEntry, null), false);
		assert.equal(isLegacyUnattributableTreeCostRow(oldGoal, zeroEntry, undefined), false);
	});

	it("returns false when there is no unattributable bucket", () => {
		assert.equal(isLegacyUnattributableTreeCostRow(oldGoal, zeroEntry, {}), false);
	});

	it("returns false when the unattributable bucket has no spend", () => {
		assert.equal(
			isLegacyUnattributableTreeCostRow(oldGoal, zeroEntry, {
				unattributableLegacy: { costUsd: 0, tokensIn: 0, tokensOut: 0 },
			}),
			false,
		);
	});

	it("returns false when the breakdown entry has non-zero cost or tokens", () => {
		const tc = { unattributableLegacy: nonZeroBucket };
		assert.equal(
			isLegacyUnattributableTreeCostRow(oldGoal, { ...zeroEntry, costUsd: 0.0001 }, tc),
			false,
		);
		assert.equal(
			isLegacyUnattributableTreeCostRow(oldGoal, { ...zeroEntry, tokensIn: 1 }, tc),
			false,
		);
		assert.equal(
			isLegacyUnattributableTreeCostRow(oldGoal, { ...zeroEntry, tokensOut: 1 }, tc),
			false,
		);
	});

	it("returns false when the goal is missing", () => {
		assert.equal(
			isLegacyUnattributableTreeCostRow(null, zeroEntry, { unattributableLegacy: nonZeroBucket }),
			false,
		);
		assert.equal(
			isLegacyUnattributableTreeCostRow(undefined, zeroEntry, {
				unattributableLegacy: nonZeroBucket,
			}),
			false,
		);
	});

	it("returns false when createdAt is missing or non-finite", () => {
		const tc = { unattributableLegacy: nonZeroBucket };
		assert.equal(
			isLegacyUnattributableTreeCostRow({ createdAt: Number.NaN }, zeroEntry, tc),
			false,
		);
		assert.equal(
			isLegacyUnattributableTreeCostRow({} as any, zeroEntry, tc),
			false,
		);
	});

	it("returns false when goal predates fallback threshold but a newer firstSeenAt pulls it forward", () => {
		// Goal at 2026-01-01, firstSeenAt at 2025-01-01 → goal is NEWER than
		// the threshold, so it is NOT legacy.
		const tc = {
			unattributableLegacy: { ...nonZeroBucket, firstSeenAt: Date.UTC(2025, 0, 1) },
		};
		assert.equal(
			isLegacyUnattributableTreeCostRow({ createdAt: Date.UTC(2026, 0, 1) }, zeroEntry, tc),
			false,
		);
	});

	it("returns true when zero entry, non-zero bucket, and goal predates fallback threshold", () => {
		assert.equal(
			isLegacyUnattributableTreeCostRow(oldGoal, zeroEntry, {
				unattributableLegacy: nonZeroBucket,
			}),
			true,
		);
	});

	it("returns true when goal predates server-supplied firstSeenAt", () => {
		const firstSeenAt = Date.UTC(2026, 5, 1);
		assert.equal(
			isLegacyUnattributableTreeCostRow(
				{ createdAt: Date.UTC(2026, 4, 1) },
				zeroEntry,
				{ unattributableLegacy: { ...nonZeroBucket, firstSeenAt } },
			),
			true,
		);
	});

	it("returns false when goal post-dates threshold", () => {
		assert.equal(
			isLegacyUnattributableTreeCostRow(newGoal, zeroEntry, {
				unattributableLegacy: nonZeroBucket,
			}),
			false,
		);
	});
});

describe("constants", () => {
	it("EARLIEST_SIDECAR_TIMESTAMP_MS is a stable named export", () => {
		// Pin: the renderer must source the threshold from this constant or
		// the server-supplied firstSeenAt — never an inline date literal.
		assert.equal(typeof EARLIEST_SIDECAR_TIMESTAMP_MS, "number");
		assert.ok(EARLIEST_SIDECAR_TIMESTAMP_MS > 0);
		// Sidecar feature landed 2026-05-11 (commit a407aa4a). The fallback
		// must be at or before that date.
		assert.ok(EARLIEST_SIDECAR_TIMESTAMP_MS <= Date.UTC(2026, 4, 11));
	});

	it("LEGACY_TREE_COST_ROW_TOOLTIP mentions the Unattributable bucket", () => {
		assert.match(LEGACY_TREE_COST_ROW_TOOLTIP, /legacy/i);
		assert.match(LEGACY_TREE_COST_ROW_TOOLTIP, /Unattributable/);
	});
});
