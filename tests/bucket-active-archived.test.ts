/**
 * Pure unit tests for `bucketActiveArchived` — the single-source-of-truth
 * helper used by every sidebar render path that splits a list of rows into
 * an active bucket above an "Archived" divider and an archived bucket
 * below.
 *
 * Pinned invariants:
 *   1. Order within each bucket is preserved from the input order.
 *   2. `needsDivider` is true iff BOTH buckets are non-empty — this is the
 *      canonical signal callers (renderTeamGroup, renderNestedNode,
 *      renderProjectContent forest loop) use to decide whether to emit
 *      `archivedDivider()` between them.
 *   3. The helper is pure & generic — no implicit globals, no DOM, works
 *      with any predicate.
 *
 * If any of these invariants change, every consumer breaks at the same
 * time — so this is the right place to pin them.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bucketActiveArchived } from "../src/app/render-helpers.ts";

describe("bucketActiveArchived — pure split helper", () => {
	it("empty input → empty buckets, no divider", () => {
		const out = bucketActiveArchived<{ id: string }>([], () => false);
		assert.deepEqual(out.active, []);
		assert.deepEqual(out.archived, []);
		assert.equal(out.needsDivider, false);
	});

	it("all-active → archived empty, no divider", () => {
		const rows = [{ id: "a", arc: false }, { id: "b", arc: false }, { id: "c", arc: false }];
		const out = bucketActiveArchived(rows, r => r.arc);
		assert.deepEqual(out.active.map(r => r.id), ["a", "b", "c"]);
		assert.deepEqual(out.archived, []);
		assert.equal(out.needsDivider, false);
	});

	it("all-archived → active empty, no divider", () => {
		const rows = [{ id: "x", arc: true }, { id: "y", arc: true }];
		const out = bucketActiveArchived(rows, r => r.arc);
		assert.deepEqual(out.active, []);
		assert.deepEqual(out.archived.map(r => r.id), ["x", "y"]);
		assert.equal(out.needsDivider, false);
	});

	it("mixed → both buckets populated, divider needed", () => {
		const rows = [
			{ id: "a", arc: false },
			{ id: "b", arc: true },
			{ id: "c", arc: false },
			{ id: "d", arc: true },
		];
		const out = bucketActiveArchived(rows, r => r.arc);
		assert.deepEqual(out.active.map(r => r.id), ["a", "c"], "active preserves input order");
		assert.deepEqual(out.archived.map(r => r.id), ["b", "d"], "archived preserves input order");
		assert.equal(out.needsDivider, true);
	});

	it("input order preserved across both buckets (interleaved)", () => {
		const rows = [
			{ id: "1", arc: true },
			{ id: "2", arc: false },
			{ id: "3", arc: true },
			{ id: "4", arc: false },
			{ id: "5", arc: true },
		];
		const out = bucketActiveArchived(rows, r => r.arc);
		assert.deepEqual(out.active.map(r => r.id), ["2", "4"]);
		assert.deepEqual(out.archived.map(r => r.id), ["1", "3", "5"]);
		assert.equal(out.needsDivider, true);
	});

	it("predicate coerces non-boolean truthiness consistently", () => {
		// Real-world callers pass `!!g.archived` or `c => !!c.goal.archived`
		// — but the helper itself should treat any truthy value as archived
		// when the predicate returns it. This pins that contract so a future
		// caller passing `c.goal.archived` (undefined for non-archived rows)
		// gets the same split.
		const rows = [
			{ id: "a", archived: undefined },
			{ id: "b", archived: true },
			{ id: "c", archived: false },
			{ id: "d", archived: 1 },
		];
		const out = bucketActiveArchived(rows, r => !!r.archived);
		assert.deepEqual(out.active.map(r => r.id), ["a", "c"]);
		assert.deepEqual(out.archived.map(r => r.id), ["b", "d"]);
		assert.equal(out.needsDivider, true);
	});

	it("single archived row mixed with active → divider needed", () => {
		const rows = [{ id: "a", arc: false }, { id: "b", arc: true }];
		const out = bucketActiveArchived(rows, r => r.arc);
		assert.equal(out.needsDivider, true);
	});

	it("single active row only → no divider", () => {
		const rows = [{ id: "a", arc: false }];
		const out = bucketActiveArchived(rows, r => r.arc);
		assert.equal(out.needsDivider, false);
		assert.deepEqual(out.active.map(r => r.id), ["a"]);
		assert.deepEqual(out.archived, []);
	});
});
