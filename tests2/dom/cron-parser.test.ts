// Migrated from tests/cron-parser.spec.ts (v2-dom tier).
// The legacy file:// fixture INLINED a copy of fieldMatches/cronMatches. This port
// imports the REAL functions from staff-trigger-engine.ts (higher fidelity) and
// asserts the same behaviors.
import { describe, expect, it } from "vitest";
import { fieldMatches, cronMatches } from "../../src/server/agent/staff-trigger-engine.js";

describe("fieldMatches", () => {
	it("* matches any value", () => {
		for (const v of [0, 1, 15, 30, 59]) expect(fieldMatches("*", v)).toBe(true);
	});

	it("exact number matches only that value", () => {
		expect(fieldMatches("5", 5)).toBe(true);
		expect(fieldMatches("5", 4)).toBe(false);
		expect(fieldMatches("5", 6)).toBe(false);
		expect(fieldMatches("0", 0)).toBe(true);
	});

	it("range N-M matches inclusive", () => {
		expect(fieldMatches("1-5", 0)).toBe(false);
		expect(fieldMatches("1-5", 1)).toBe(true);
		expect(fieldMatches("1-5", 3)).toBe(true);
		expect(fieldMatches("1-5", 5)).toBe(true);
		expect(fieldMatches("1-5", 6)).toBe(false);
	});

	it("comma-separated list matches any element", () => {
		expect(fieldMatches("1,15,30", 1)).toBe(true);
		expect(fieldMatches("1,15,30", 15)).toBe(true);
		expect(fieldMatches("1,15,30", 30)).toBe(true);
		expect(fieldMatches("1,15,30", 2)).toBe(false);
		expect(fieldMatches("1,15,30", 0)).toBe(false);
	});

	it("*/N step matches multiples of N from 0", () => {
		expect(fieldMatches("*/15", 0)).toBe(true);
		expect(fieldMatches("*/15", 15)).toBe(true);
		expect(fieldMatches("*/15", 30)).toBe(true);
		expect(fieldMatches("*/15", 45)).toBe(true);
		expect(fieldMatches("*/15", 7)).toBe(false);
		expect(fieldMatches("*/15", 1)).toBe(false);
	});

	it("*/5 matches all multiples of 5", () => {
		for (const v of [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]) expect(fieldMatches("*/5", v)).toBe(true);
		for (const v of [1, 2, 3, 4, 6, 7, 8, 9, 11]) expect(fieldMatches("*/5", v)).toBe(false);
	});

	it("range with step N-M/S", () => {
		expect(fieldMatches("10-20/3", 10)).toBe(true);
		expect(fieldMatches("10-20/3", 13)).toBe(true);
		expect(fieldMatches("10-20/3", 16)).toBe(true);
		expect(fieldMatches("10-20/3", 19)).toBe(true);
		expect(fieldMatches("10-20/3", 11)).toBe(false);
		expect(fieldMatches("10-20/3", 9)).toBe(false);
		expect(fieldMatches("10-20/3", 21)).toBe(false);
	});
});

describe("cronMatches", () => {
	it("* * * * * matches any date", () => {
		expect(cronMatches("* * * * *", new Date(2025, 2, 15, 14, 30))).toBe(true);
	});

	it("0 9 * * * matches 09:00 but not 09:01", () => {
		expect(cronMatches("0 9 * * *", new Date(2025, 2, 15, 9, 0))).toBe(true);
		expect(cronMatches("0 9 * * *", new Date(2025, 2, 15, 9, 1))).toBe(false);
		expect(cronMatches("0 9 * * *", new Date(2025, 2, 15, 10, 0))).toBe(false);
	});

	it("*/15 * * * * matches :00, :15, :30, :45 but not :07", () => {
		for (const m of [0, 15, 30, 45]) expect(cronMatches("*/15 * * * *", new Date(2025, 0, 1, 12, m))).toBe(true);
		expect(cronMatches("*/15 * * * *", new Date(2025, 0, 1, 12, 7))).toBe(false);
	});

	it("1-5 * * * * matches minutes 1-5 but not 0 or 6", () => {
		for (const m of [1, 2, 3, 4, 5]) expect(cronMatches("1-5 * * * *", new Date(2025, 0, 1, 12, m))).toBe(true);
		expect(cronMatches("1-5 * * * *", new Date(2025, 0, 1, 12, 0))).toBe(false);
		expect(cronMatches("1-5 * * * *", new Date(2025, 0, 1, 12, 6))).toBe(false);
	});

	it("1,15,30 * * * * matches 1, 15, 30 but not 2", () => {
		for (const m of [1, 15, 30]) expect(cronMatches("1,15,30 * * * *", new Date(2025, 0, 1, 12, m))).toBe(true);
		expect(cronMatches("1,15,30 * * * *", new Date(2025, 0, 1, 12, 2))).toBe(false);
	});

	it("0 9 * * 1-5 matches weekday 09:00 but not Sunday 09:00", () => {
		expect(cronMatches("0 9 * * 1-5", new Date(2025, 2, 17, 9, 0))).toBe(true); // Monday
		expect(cronMatches("0 9 * * 1-5", new Date(2025, 2, 21, 9, 0))).toBe(true); // Friday
		expect(cronMatches("0 9 * * 1-5", new Date(2025, 2, 16, 9, 0))).toBe(false); // Sunday
		expect(cronMatches("0 9 * * 1-5", new Date(2025, 2, 22, 9, 0))).toBe(false); // Saturday
	});

	it("0 0 1 1 * matches midnight Jan 1", () => {
		expect(cronMatches("0 0 1 1 *", new Date(2025, 0, 1, 0, 0))).toBe(true);
		expect(cronMatches("0 0 1 1 *", new Date(2025, 0, 2, 0, 0))).toBe(false);
		expect(cronMatches("0 0 1 1 *", new Date(2025, 1, 1, 0, 0))).toBe(false);
	});

	it("59 23 31 12 * matches 23:59 Dec 31", () => {
		expect(cronMatches("59 23 31 12 *", new Date(2025, 11, 31, 23, 59))).toBe(true);
		expect(cronMatches("59 23 31 12 *", new Date(2025, 11, 31, 23, 58))).toBe(false);
	});

	it("day of week 0 and 7 both mean Sunday", () => {
		expect(cronMatches("0 0 * * 0", new Date(2025, 2, 16, 0, 0))).toBe(true);
		expect(cronMatches("0 0 * * 7", new Date(2025, 2, 16, 0, 0))).toBe(true);
		expect(cronMatches("0 0 * * 0", new Date(2025, 2, 17, 0, 0))).toBe(false);
		expect(cronMatches("0 0 * * 7", new Date(2025, 2, 17, 0, 0))).toBe(false);
	});

	it("invalid cron expression (wrong number of fields) returns false", () => {
		expect(cronMatches("0 9 *", new Date())).toBe(false);
	});
});
