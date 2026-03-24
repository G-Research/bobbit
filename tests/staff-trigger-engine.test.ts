/**
 * Unit tests for staff-trigger-engine.ts — cron matching and trigger evaluation.
 * Tests the pure functions (fieldMatches, cronMatches) directly, plus TriggerEngine
 * tick logic with mock StaffManager/SessionManager.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	fieldMatches,
	cronMatches,
	TriggerEngine,
} from "../src/server/agent/staff-trigger-engine.ts";

// ---------------------------------------------------------------------------
// fieldMatches — individual cron field matching
// ---------------------------------------------------------------------------

describe("fieldMatches", () => {
	describe("wildcard", () => {
		it("* matches any value", () => {
			assert.ok(fieldMatches("*", 0));
			assert.ok(fieldMatches("*", 30));
			assert.ok(fieldMatches("*", 59));
		});
	});

	describe("exact match", () => {
		it("matches exact number", () => {
			assert.ok(fieldMatches("5", 5));
			assert.ok(fieldMatches("0", 0));
			assert.ok(fieldMatches("59", 59));
		});

		it("does not match different number", () => {
			assert.ok(!fieldMatches("5", 6));
			assert.ok(!fieldMatches("0", 1));
		});
	});

	describe("range (N-M)", () => {
		it("matches values within inclusive range", () => {
			assert.ok(fieldMatches("1-5", 1));
			assert.ok(fieldMatches("1-5", 3));
			assert.ok(fieldMatches("1-5", 5));
		});

		it("does not match values outside range", () => {
			assert.ok(!fieldMatches("1-5", 0));
			assert.ok(!fieldMatches("1-5", 6));
		});
	});

	describe("step (*/S)", () => {
		it("*/5 matches multiples of 5", () => {
			assert.ok(fieldMatches("*/5", 0));
			assert.ok(fieldMatches("*/5", 5));
			assert.ok(fieldMatches("*/5", 10));
			assert.ok(fieldMatches("*/5", 55));
		});

		it("*/5 does not match non-multiples", () => {
			assert.ok(!fieldMatches("*/5", 1));
			assert.ok(!fieldMatches("*/5", 3));
			assert.ok(!fieldMatches("*/5", 14));
		});

		it("*/1 matches everything", () => {
			assert.ok(fieldMatches("*/1", 0));
			assert.ok(fieldMatches("*/1", 30));
		});
	});

	describe("range with step (N-M/S)", () => {
		it("10-20/3 matches 10, 13, 16, 19", () => {
			assert.ok(fieldMatches("10-20/3", 10));
			assert.ok(fieldMatches("10-20/3", 13));
			assert.ok(fieldMatches("10-20/3", 16));
			assert.ok(fieldMatches("10-20/3", 19));
		});

		it("10-20/3 does not match 11, 12, 20, 9", () => {
			assert.ok(!fieldMatches("10-20/3", 11));
			assert.ok(!fieldMatches("10-20/3", 12));
			assert.ok(!fieldMatches("10-20/3", 20));
			assert.ok(!fieldMatches("10-20/3", 9));
		});
	});

	describe("comma-separated list", () => {
		it("matches any value in the list", () => {
			assert.ok(fieldMatches("1,5,10", 1));
			assert.ok(fieldMatches("1,5,10", 5));
			assert.ok(fieldMatches("1,5,10", 10));
		});

		it("does not match values not in the list", () => {
			assert.ok(!fieldMatches("1,5,10", 2));
			assert.ok(!fieldMatches("1,5,10", 7));
		});

		it("supports mixed syntax in comma list", () => {
			// "1,5-10,*/15" — matches 1, 5-10, or multiples of 15
			assert.ok(fieldMatches("1,5-10,*/15", 1));
			assert.ok(fieldMatches("1,5-10,*/15", 7));
			assert.ok(fieldMatches("1,5-10,*/15", 30));
			assert.ok(!fieldMatches("1,5-10,*/15", 3));
		});
	});

	describe("edge cases", () => {
		it("handles step with invalid step value", () => {
			assert.ok(!fieldMatches("*/0", 5));    // step 0 is invalid
			assert.ok(!fieldMatches("*/-1", 5));   // negative step
			assert.ok(!fieldMatches("*/abc", 5));  // NaN step
		});

		it("single number with step treated as */step", () => {
			// e.g. "5/10" — the implementation treats it like */10
			assert.ok(fieldMatches("5/10", 0));
			assert.ok(fieldMatches("5/10", 10));
			assert.ok(!fieldMatches("5/10", 5)); // 5 % 10 !== 0
		});
	});
});

// ---------------------------------------------------------------------------
// cronMatches — full 5-field cron expression matching
// ---------------------------------------------------------------------------

describe("cronMatches", () => {
	// Helper: create a Date for a specific time
	function makeDate(year: number, month: number, day: number, hour: number, minute: number): Date {
		return new Date(year, month - 1, day, hour, minute);
	}

	it("* * * * * matches any date", () => {
		assert.ok(cronMatches("* * * * *", new Date()));
		assert.ok(cronMatches("* * * * *", makeDate(2025, 6, 15, 12, 30)));
	});

	it("matches specific minute and hour", () => {
		const date = makeDate(2025, 3, 24, 14, 30);
		assert.ok(cronMatches("30 14 * * *", date));
		assert.ok(!cronMatches("31 14 * * *", date));
		assert.ok(!cronMatches("30 15 * * *", date));
	});

	it("matches specific day of month", () => {
		const date = makeDate(2025, 3, 24, 0, 0);
		assert.ok(cronMatches("0 0 24 * *", date));
		assert.ok(!cronMatches("0 0 25 * *", date));
	});

	it("matches specific month", () => {
		const date = makeDate(2025, 3, 1, 0, 0);
		assert.ok(cronMatches("0 0 1 3 *", date));
		assert.ok(!cronMatches("0 0 1 4 *", date));
	});

	it("matches day of week (0 = Sunday)", () => {
		// March 24, 2025 is a Monday (day 1)
		const monday = makeDate(2025, 3, 24, 12, 0);
		assert.ok(cronMatches("0 12 * * 1", monday));
		assert.ok(!cronMatches("0 12 * * 0", monday));
	});

	it("treats 7 as Sunday (same as 0)", () => {
		// March 23, 2025 is a Sunday (day 0)
		const sunday = makeDate(2025, 3, 23, 12, 0);
		assert.ok(cronMatches("0 12 * * 7", sunday));
		assert.ok(cronMatches("0 12 * * 0", sunday));
	});

	it("rejects expressions with wrong number of fields", () => {
		assert.ok(!cronMatches("* * *", new Date()));
		assert.ok(!cronMatches("* * * * * *", new Date()));
		assert.ok(!cronMatches("", new Date()));
	});

	it("every 5 minutes pattern", () => {
		assert.ok(cronMatches("*/5 * * * *", makeDate(2025, 1, 1, 0, 0)));
		assert.ok(cronMatches("*/5 * * * *", makeDate(2025, 1, 1, 0, 15)));
		assert.ok(!cronMatches("*/5 * * * *", makeDate(2025, 1, 1, 0, 3)));
	});

	it("weekday 9am pattern (0 9 * * 1-5)", () => {
		// Monday 9:00
		assert.ok(cronMatches("0 9 * * 1-5", makeDate(2025, 3, 24, 9, 0)));
		// Sunday 9:00 — should not match
		assert.ok(!cronMatches("0 9 * * 1-5", makeDate(2025, 3, 23, 9, 0)));
		// Monday 10:00 — wrong hour
		assert.ok(!cronMatches("0 9 * * 1-5", makeDate(2025, 3, 24, 10, 0)));
	});
});

// ---------------------------------------------------------------------------
// TriggerEngine — tick logic with mock managers
// ---------------------------------------------------------------------------

describe("TriggerEngine", () => {
	function makeMockStaffManager(staffList: any[] = []) {
		const triggerUpdates: any[] = [];
		const wakeHistory: any[] = [];
		return {
			listStaff: () => staffList,
			updateTriggerState: (staffId: string, triggerId: string, update: any) => {
				triggerUpdates.push({ staffId, triggerId, update });
				// Apply update to the trigger in staffList for subsequent reads
				for (const s of staffList) {
					for (const t of s.triggers) {
						if (t.id === triggerId) Object.assign(t, update);
					}
				}
			},
			wake: async (staffId: string, prompt: string) => {
				wakeHistory.push({ staffId, prompt });
			},
			triggerUpdates,
			wakeHistory,
		};
	}

	function makeMockSessionManager(sessions: Record<string, any> = {}) {
		return {
			getSession: (id: string) => sessions[id] || null,
		};
	}

	describe("schedule trigger", () => {
		it("fires when cron matches current time", () => {
			const now = new Date();
			const cronMinute = now.getMinutes();
			const cronHour = now.getHours();

			const staff = {
				id: "staff-1",
				name: "Test Staff",
				state: "active",
				currentSessionId: null,
				triggers: [
					{
						id: "t1",
						type: "schedule",
						config: { cron: `${cronMinute} ${cronHour} * * *` },
						enabled: true,
						prompt: "Do the thing",
					},
				],
			};

			const mgr = makeMockStaffManager([staff]);
			const sessionMgr = makeMockSessionManager();
			const engine = new TriggerEngine(mgr as any, sessionMgr as any);

			// Access private tick via any
			(engine as any).tick();

			assert.equal(mgr.wakeHistory.length, 1);
			assert.equal(mgr.wakeHistory[0].staffId, "staff-1");
			assert.ok(mgr.wakeHistory[0].prompt.includes("Do the thing"));
		});

		it("does not fire when cron does not match", () => {
			const now = new Date();
			// Pick a minute that's definitely not now
			const wrongMinute = (now.getMinutes() + 30) % 60;

			const staff = {
				id: "staff-1",
				name: "Test",
				state: "active",
				currentSessionId: null,
				triggers: [
					{
						id: "t1",
						type: "schedule",
						config: { cron: `${wrongMinute} * * * *` },
						enabled: true,
					},
				],
			};

			const mgr = makeMockStaffManager([staff]);
			const engine = new TriggerEngine(mgr as any, makeMockSessionManager() as any);
			(engine as any).tick();
			assert.equal(mgr.wakeHistory.length, 0);
		});

		it("does not re-fire in the same minute", () => {
			const now = new Date();
			const cronMinute = now.getMinutes();
			const cronHour = now.getHours();

			// Set lastFired to the start of the current minute — guaranteed same minute
			const currentMinuteStart = Math.floor(now.getTime() / 60_000) * 60_000;

			const staff = {
				id: "staff-1",
				name: "Test",
				state: "active",
				currentSessionId: null,
				triggers: [
					{
						id: "t1",
						type: "schedule",
						config: { cron: `${cronMinute} ${cronHour} * * *` },
						enabled: true,
						lastFired: currentMinuteStart + 1000, // 1 second into current minute
					},
				],
			};

			const mgr = makeMockStaffManager([staff]);
			const engine = new TriggerEngine(mgr as any, makeMockSessionManager() as any);
			(engine as any).tick();
			assert.equal(mgr.wakeHistory.length, 0);
		});

		it("does not fire for disabled trigger", () => {
			const now = new Date();

			const staff = {
				id: "staff-1",
				name: "Test",
				state: "active",
				currentSessionId: null,
				triggers: [
					{
						id: "t1",
						type: "schedule",
						config: { cron: `${now.getMinutes()} ${now.getHours()} * * *` },
						enabled: false,
					},
				],
			};

			const mgr = makeMockStaffManager([staff]);
			const engine = new TriggerEngine(mgr as any, makeMockSessionManager() as any);
			(engine as any).tick();
			assert.equal(mgr.wakeHistory.length, 0);
		});

		it("skips schedule trigger with no cron expression", () => {
			const staff = {
				id: "staff-1",
				name: "Test",
				state: "active",
				currentSessionId: null,
				triggers: [
					{
						id: "t1",
						type: "schedule",
						config: {},
						enabled: true,
					},
				],
			};

			const mgr = makeMockStaffManager([staff]);
			const engine = new TriggerEngine(mgr as any, makeMockSessionManager() as any);
			(engine as any).tick();
			assert.equal(mgr.wakeHistory.length, 0);
		});
	});

	describe("staff state filtering", () => {
		it("skips paused staff", () => {
			const now = new Date();
			const staff = {
				id: "staff-1",
				name: "Test",
				state: "paused",
				currentSessionId: null,
				triggers: [
					{
						id: "t1",
						type: "schedule",
						config: { cron: `${now.getMinutes()} ${now.getHours()} * * *` },
						enabled: true,
					},
				],
			};

			const mgr = makeMockStaffManager([staff]);
			const engine = new TriggerEngine(mgr as any, makeMockSessionManager() as any);
			(engine as any).tick();
			assert.equal(mgr.wakeHistory.length, 0);
		});

		it("skips staff with currently streaming session", () => {
			const now = new Date();
			const staff = {
				id: "staff-1",
				name: "Test",
				state: "active",
				currentSessionId: "session-active",
				triggers: [
					{
						id: "t1",
						type: "schedule",
						config: { cron: `${now.getMinutes()} ${now.getHours()} * * *` },
						enabled: true,
					},
				],
			};

			const sessions = { "session-active": { status: "streaming" } };
			const mgr = makeMockStaffManager([staff]);
			const engine = new TriggerEngine(mgr as any, makeMockSessionManager(sessions) as any);
			(engine as any).tick();
			assert.equal(mgr.wakeHistory.length, 0);
		});

		it("fires for staff with idle session", () => {
			const now = new Date();
			const staff = {
				id: "staff-1",
				name: "Test",
				state: "active",
				currentSessionId: "session-idle",
				triggers: [
					{
						id: "t1",
						type: "schedule",
						config: { cron: `${now.getMinutes()} ${now.getHours()} * * *` },
						enabled: true,
						prompt: "go",
					},
				],
			};

			const sessions = { "session-idle": { status: "idle" } };
			const mgr = makeMockStaffManager([staff]);
			const engine = new TriggerEngine(mgr as any, makeMockSessionManager(sessions) as any);
			(engine as any).tick();
			assert.equal(mgr.wakeHistory.length, 1);
		});
	});

	describe("manual triggers", () => {
		it("are never auto-fired by tick", () => {
			const staff = {
				id: "staff-1",
				name: "Test",
				state: "active",
				currentSessionId: null,
				triggers: [
					{
						id: "t1",
						type: "manual",
						config: {},
						enabled: true,
						prompt: "manual task",
					},
				],
			};

			const mgr = makeMockStaffManager([staff]);
			const engine = new TriggerEngine(mgr as any, makeMockSessionManager() as any);
			(engine as any).tick();
			assert.equal(mgr.wakeHistory.length, 0);
		});
	});

	describe("start and stop", () => {
		it("start sets up interval, stop clears it", () => {
			const mgr = makeMockStaffManager([]);
			const engine = new TriggerEngine(mgr as any, makeMockSessionManager() as any);
			engine.start();
			// Engine should have an interval handle
			assert.ok((engine as any).intervalHandle !== null);
			engine.stop();
			assert.equal((engine as any).intervalHandle, null);
		});
	});
});
