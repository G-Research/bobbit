import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/session-colors.spec.ts (v2-dom tier).
// The legacy file:// fixture inlined a copy of the palette + assignment logic.
// This port exercises the REAL BOBBIT_HUE_ROTATIONS / sessionHueRotation /
// sessionColorMap from src/app/session-colors.ts. sessionHueRotation persists the
// assignment via patchSession → gatewayFetch, so fetch is stubbed. The map is
// cleared before each test to mimic the fixture's __reset().
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOBBIT_HUE_ROTATIONS, sessionHueRotation, sessionColorMap } from "../../src/app/session-colors.js";

const EXPECTED = [-110, -85, -60, -35, -10, 0, 15, 25, 40, 50, 65, 75, 100, 125];

beforeEach(() => {
	sessionColorMap.clear();
	vi.stubGlobal("fetch", async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
});

afterEach(() => {
	sessionColorMap.clear();
	vi.unstubAllGlobals();
});

describe("Bobbit session colors palette", () => {
	it("palette has exactly 14 colours", () => {
		expect(BOBBIT_HUE_ROTATIONS.length).toBe(14);
	});

	it("palette does not contain removed hue values", () => {
		for (const removed of [150, 175, 200, 225, 250, -135]) {
			expect(BOBBIT_HUE_ROTATIONS).not.toContain(removed);
		}
	});

	it("palette matches expected values in order", () => {
		expect(BOBBIT_HUE_ROTATIONS).toEqual(EXPECTED);
	});

	it("assigns sequential indices up to 14", () => {
		sessionColorMap.clear();
		const r: number[] = [];
		for (let i = 0; i < 14; i++) {
			sessionHueRotation(`s-${i}`);
			r.push(sessionColorMap.get(`s-${i}`)!);
		}
		expect(r).toEqual(Array.from({ length: 14 }, (_, i) => i));
	});

	it("wraps around after all 14 colours used", () => {
		sessionColorMap.clear();
		for (let i = 0; i < 14; i++) sessionHueRotation(`s-${i}`);
		sessionHueRotation("extra");
		expect(sessionColorMap.get("extra")).toBe(0);
	});

	it("each hue value is unique", () => {
		expect(new Set(BOBBIT_HUE_ROTATIONS).size).toBe(BOBBIT_HUE_ROTATIONS.length);
	});

	it("same session always gets same colour", () => {
		sessionColorMap.clear();
		expect(sessionHueRotation("test")).toBe(sessionHueRotation("test"));
	});
});
