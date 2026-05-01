import { test, expect } from "@playwright/test";
import { formatElapsed } from "../src/server/agent/team-manager.ts";

test.describe("formatElapsed", () => {
	test("returns 0m for timestamps just now", () => {
		expect(formatElapsed(Date.now())).toBe("0m");
	});

	test("returns minutes for < 60 min", () => {
		const fiveMinAgo = Date.now() - 5 * 60_000;
		expect(formatElapsed(fiveMinAgo)).toBe("5m");
	});

	test("returns minutes for 59 min", () => {
		const fiftyNineMinAgo = Date.now() - 59 * 60_000;
		expect(formatElapsed(fiftyNineMinAgo)).toBe("59m");
	});

	test("returns hours and minutes for >= 60 min", () => {
		const sixtyMinAgo = Date.now() - 60 * 60_000;
		expect(formatElapsed(sixtyMinAgo)).toBe("1h 0m");
	});

	test("returns hours and minutes for 90 min", () => {
		const ninetyMinAgo = Date.now() - 90 * 60_000;
		expect(formatElapsed(ninetyMinAgo)).toBe("1h 30m");
	});

	test("returns hours and minutes for multi-hour durations", () => {
		const threeHoursTenMin = Date.now() - (3 * 60 + 10) * 60_000;
		expect(formatElapsed(threeHoursTenMin)).toBe("3h 10m");
	});
});
