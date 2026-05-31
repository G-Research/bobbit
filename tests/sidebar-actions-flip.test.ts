import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	computeSidebarActionFlipDeltas,
	type SidebarActionsFlipRect,
} from "../src/ui/components/sidebar-actions-flip.ts";

function rect(left: number, top: number, width: number, height: number): DOMRectReadOnly {
	return {
		x: left,
		y: top,
		left,
		top,
		width,
		height,
		right: left + width,
		bottom: top + height,
		toJSON() { return this; },
	} as DOMRectReadOnly;
}

function flip(actionId: string, left: number, top: number, width: number, height: number): SidebarActionsFlipRect {
	return { actionId, rect: rect(left, top, width, height) };
}

describe("computeSidebarActionFlipDeltas", () => {
	it("computes translate and scale from matching source and target rects", () => {
		assert.deepEqual(
			computeSidebarActionFlipDeltas(
				[flip("modify", 10, 20, 24, 24)],
				[flip("modify", 40, 70, 16, 12)],
			),
			[{ actionId: "modify", dx: -30, dy: -50, sx: 1.5, sy: 2 }],
		);
	});

	it("ignores sources without a matching target", () => {
		assert.deepEqual(
			computeSidebarActionFlipDeltas(
				[flip("modify", 10, 20, 20, 20), flip("terminate", 30, 20, 20, 20)],
				[flip("modify", 10, 20, 20, 20)],
			),
			[{ actionId: "modify", dx: 0, dy: 0, sx: 1, sy: 1 }],
		);
	});

	it("does not produce NaN or Infinity for zero-size target rects", () => {
		const [delta] = computeSidebarActionFlipDeltas(
			[flip("copy-link", 5, 6, 18, 18)],
			[flip("copy-link", 8, 10, 0, 0)],
		);

		assert.deepEqual(delta, { actionId: "copy-link", dx: -3, dy: -4, sx: 1, sy: 1 });
		for (const value of [delta.dx, delta.dy, delta.sx, delta.sy]) {
			assert.equal(Number.isFinite(value), true);
		}
	});

	it("keeps source ordering for deterministic animation sequencing", () => {
		assert.deepEqual(
			computeSidebarActionFlipDeltas(
				[flip("archive", 0, 0, 10, 10), flip("dashboard", 0, 0, 10, 10)],
				[flip("dashboard", 5, 5, 10, 10), flip("archive", 3, 4, 10, 10)],
			).map((delta) => delta.actionId),
			["archive", "dashboard"],
		);
	});
});
