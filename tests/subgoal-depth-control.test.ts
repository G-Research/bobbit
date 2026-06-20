/**
 * Unit tests for `resolveDepthControl` — the single source of truth for the
 * "Max nesting depth" stepper math shared by the goal-proposal panel
 * (`proposal-panels.ts`) and the existing-goal Sub-goals settings
 * (`goal-dashboard-children-tab.ts`).
 *
 * These pin the invariant behind both maintainer-reported bugs: the value the
 * UI DISPLAYS (`depthValue`) is the value the payload must SUBMIT/PERSIST.
 * Because both call sites read `depthValue`, they can never disagree.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveDepthControl } from "../src/app/subgoal-eligibility.ts";

describe("resolveDepthControl", () => {
	it("untouched top-level goal shows the full inherited cap", () => {
		// goalDepth 1, cap 3, no override → display the full cap.
		const r = resolveDepthControl(1, 3, null);
		assert.equal(r.minDepth, 2);
		assert.equal(r.maxDepth, 3);
		assert.equal(r.atGlobalCap, false);
		assert.equal(r.depthFixed, false);
		assert.equal(r.depthValue, 3);
		assert.equal(r.levelsBelow, 2);
	});

	it("clamps a too-LOW configured value UP to minDepth (bug #1 repro)", () => {
		// The exact maintainer repro: user set depth 2, then selected a parent
		// that pushes the new goal to depth 2 (minDepth 3). The stepper shows 3;
		// the payload must therefore ALSO be 3, not the stale 2.
		const r = resolveDepthControl(2, 4, 2);
		assert.equal(r.minDepth, 3);
		assert.equal(r.maxDepth, 4);
		assert.equal(r.depthValue, 3, "displayed/submitted value must clamp UP to minDepth");
	});

	it("clamps a too-HIGH configured value DOWN to the inherited cap", () => {
		// Parent later tightened to cap 3 while the goal had stored 5.
		const r = resolveDepthControl(1, 3, 5);
		assert.equal(r.depthValue, 3);
	});

	it("keeps an in-band configured value untouched", () => {
		const r = resolveDepthControl(1, 4, 3);
		assert.equal(r.depthValue, 3);
		assert.equal(r.depthFixed, false);
	});

	it("flags depthFixed when exactly one value fits", () => {
		// goalDepth 1, cap 2 → minDepth 2 === maxDepth 2.
		const r = resolveDepthControl(1, 2, null);
		assert.equal(r.depthFixed, true);
		assert.equal(r.atGlobalCap, false);
		assert.equal(r.depthValue, 2);
		assert.equal(r.levelsBelow, 1);
	});

	it("flags atGlobalCap when the goal already sits at the cap (no room below)", () => {
		// goalDepth 3, cap 3 → minDepth 4 > maxDepth 3.
		const r = resolveDepthControl(3, 3, null);
		assert.equal(r.atGlobalCap, true);
		assert.equal(r.depthFixed, false);
		assert.equal(r.depthValue, 3);
		assert.equal(r.levelsBelow, 0);
	});

	it("atGlobalCap pins depthValue to the cap regardless of a stale override", () => {
		const r = resolveDepthControl(4, 3, 2);
		assert.equal(r.atGlobalCap, true);
		assert.equal(r.depthValue, 3);
	});
});
