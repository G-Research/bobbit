import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/archived-sessions-refresh.html")}`;

test.describe("Archived sessions auto-refresh", () => {

	test("newly archived session appears without toggling showArchived", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(async () => {
			const state = (window as any).__state;
			const refresh = (window as any).__refreshSessions;

			// Setup: 2 live sessions, showArchived on, archived sessions already loaded
			state.showArchived = true;
			(window as any).__setArchivedSessionsLoaded(true);
			(window as any).__serverSessions = [
				{ id: "s1", status: "idle" },
				{ id: "s2", status: "idle" },
			];
			(window as any).__serverArchivedSessions = [];
			(window as any).__serverSessionsGeneration = 1;

			// Initial fetch
			await refresh();
			const liveAfterInit = state.gatewaySessions.length;
			const archivedAfterInit = state.archivedSessions.length;

			// Now s2 gets archived — server returns s2 as archived
			(window as any).__serverSessions = [{ id: "s1", status: "idle" }];
			(window as any).__serverArchivedSessions = [{ id: "s2", status: "terminated", archived: true }];
			(window as any).__serverSessionsGeneration = 2;
			(window as any).__fetchLog.length = 0;

			await refresh();

			const archivedFetches = (window as any).__fetchLog.filter(
				(e: any) => e.path.includes("include=archived")
			);

			return {
				liveAfterInit,
				archivedAfterInit,
				liveAfterArchive: state.gatewaySessions.length,
				archivedAfterArchive: state.archivedSessions.length,
				archivedIds: state.archivedSessions.map((s: any) => s.id),
				archivedFetchCount: archivedFetches.length,
			};
		});

		expect(result.liveAfterInit).toBe(2);
		expect(result.archivedAfterInit).toBe(0);
		expect(result.liveAfterArchive).toBe(1);
		expect(result.archivedAfterArchive).toBe(1);
		expect(result.archivedIds).toEqual(["s2"]);
		expect(result.archivedFetchCount).toBe(1);
	});

	test("archived sessions not re-fetched when showArchived is off", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const fetchCount = await page.evaluate(async () => {
			const state = (window as any).__state;
			const refresh = (window as any).__refreshSessions;

			state.showArchived = false;
			(window as any).__setArchivedSessionsLoaded(false);
			(window as any).__serverSessions = [{ id: "s1", status: "idle" }];
			(window as any).__serverArchivedSessions = [{ id: "s2", status: "terminated", archived: true }];
			(window as any).__serverSessionsGeneration = 1;

			await refresh();
			(window as any).__fetchLog.length = 0;

			// Change sessions — but showArchived is off
			(window as any).__serverSessions = [];
			(window as any).__serverSessionsGeneration = 2;

			await refresh();

			return (window as any).__fetchLog.filter(
				(e: any) => e.path.includes("include=archived")
			).length;
		});

		expect(fetchCount).toBe(0);
	});

	test("archived sessions not re-fetched when sessions unchanged", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const fetchCount = await page.evaluate(async () => {
			const state = (window as any).__state;
			const refresh = (window as any).__refreshSessions;

			state.showArchived = true;
			(window as any).__setArchivedSessionsLoaded(true);
			(window as any).__serverSessions = [{ id: "s1", status: "idle" }];
			(window as any).__serverArchivedSessions = [];
			(window as any).__serverSessionsGeneration = 1;

			// Initial fetch to set generation
			await refresh();
			(window as any).__fetchLog.length = 0;

			// Same generation — no change
			await refresh();

			return (window as any).__fetchLog.filter(
				(e: any) => e.path.includes("include=archived")
			).length;
		});

		expect(fetchCount).toBe(0);
	});

	test("initial load with showArchived on fetches archived sessions", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(async () => {
			const state = (window as any).__state;
			const refresh = (window as any).__refreshSessions;

			state.showArchived = true;
			(window as any).__setArchivedSessionsLoaded(false);
			(window as any).__serverSessions = [{ id: "s1", status: "idle" }];
			(window as any).__serverArchivedSessions = [{ id: "old", status: "terminated", archived: true }];
			(window as any).__serverSessionsGeneration = 1;

			await refresh();

			return {
				loaded: (window as any).__archivedSessionsLoaded(),
				count: state.archivedSessions.length,
				ids: state.archivedSessions.map((s: any) => s.id),
			};
		});

		expect(result.loaded).toBe(true);
		expect(result.count).toBe(1);
		expect(result.ids).toEqual(["old"]);
	});
});
