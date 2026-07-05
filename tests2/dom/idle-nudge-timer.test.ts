import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/idle-nudge-timer.spec.ts (v2-dom tier).
// Pure-logic test of the REAL formatElapsed helper — no DOM, imported directly
// from src (same symbol the legacy spec imported).
import { describe, expect, it } from "vitest";
import { formatElapsed } from "../../src/server/agent/team-manager.js";

describe("formatElapsed", () => {
	it("returns 0m for timestamps just now", () => {
		expect(formatElapsed(Date.now())).toBe("0m");
	});

	it("returns minutes for < 60 min", () => {
		const fiveMinAgo = Date.now() - 5 * 60_000;
		expect(formatElapsed(fiveMinAgo)).toBe("5m");
	});

	it("returns minutes for 59 min", () => {
		const fiftyNineMinAgo = Date.now() - 59 * 60_000;
		expect(formatElapsed(fiftyNineMinAgo)).toBe("59m");
	});

	it("returns hours and minutes for >= 60 min", () => {
		const sixtyMinAgo = Date.now() - 60 * 60_000;
		expect(formatElapsed(sixtyMinAgo)).toBe("1h 0m");
	});

	it("returns hours and minutes for 90 min", () => {
		const ninetyMinAgo = Date.now() - 90 * 60_000;
		expect(formatElapsed(ninetyMinAgo)).toBe("1h 30m");
	});

	it("returns hours and minutes for multi-hour durations", () => {
		const threeHoursTenMin = Date.now() - (3 * 60 + 10) * 60_000;
		expect(formatElapsed(threeHoursTenMin)).toBe("3h 10m");
	});
});
