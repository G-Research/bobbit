/**
 * Unit tests for verification timer accuracy logic.
 *
 * Tests the core patterns from GateVerificationLive.ts:
 * - Server timestamps are used when provided (not Date.now())
 * - Fallback to Date.now() when server timestamps are absent
 * - toCardEntry() computes correct durationMs for running vs completed steps
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/verification-timer.html")}`;

test.describe("Verification timer accuracy", () => {

	test("gate_verification_started uses server startedAt for step timestamps", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const steps = await page.evaluate(() => {
			const serverTimestamp = 1700000000000; // fixed server timestamp
			const detail = { startedAt: serverTimestamp };
			const stepDefs = [
				{ name: "Type check", type: "command" },
				{ name: "Run tests", type: "command" },
			];
			return (window as any).handleVerificationStarted(detail, stepDefs);
		});

		expect(steps).toHaveLength(2);
		expect(steps[0].startedAt).toBe(1700000000000);
		expect(steps[1].startedAt).toBe(1700000000000);
		expect(steps[0].status).toBe("running");
		expect(steps[0].name).toBe("Type check");
		expect(steps[1].name).toBe("Run tests");
	});

	test("gate_verification_started falls back to Date.now() when startedAt missing", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const before = Date.now();
			const detail = {}; // no startedAt
			const stepDefs = [{ name: "Step 1", type: "command" }];
			const steps = (window as any).handleVerificationStarted(detail, stepDefs);
			const after = Date.now();
			return { startedAt: steps[0].startedAt, before, after };
		});

		// The startedAt should be approximately Date.now() (within the before/after window)
		expect(result.startedAt).toBeGreaterThanOrEqual(result.before);
		expect(result.startedAt).toBeLessThanOrEqual(result.after);
	});

	test("gate_verification_step_started uses server startedAt", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const steps = await page.evaluate(() => {
			const initialSteps = [
				{ name: "Step A", type: "command", status: "running", startedAt: 1700000000000 },
				{ name: "Step B", type: "command", status: "running", startedAt: 1700000000000 },
			];
			const detail = { stepIndex: 1, startedAt: 1700000005000, sessionId: "sess-1" };
			return (window as any).handleStepStarted(detail, initialSteps);
		});

		// Step 0 should keep its original startedAt
		expect(steps[0].startedAt).toBe(1700000000000);
		// Step 1 should have the server-provided startedAt
		expect(steps[1].startedAt).toBe(1700000005000);
		expect(steps[1].sessionId).toBe("sess-1");
	});

	test("gate_verification_step_started preserves existing startedAt when missing from event", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const steps = await page.evaluate(() => {
			const initialSteps = [
				{ name: "Step A", type: "command", status: "running", startedAt: 1700000001000 },
			];
			const detail = { stepIndex: 0 }; // no startedAt
			return (window as any).handleStepStarted(detail, initialSteps);
		});

		// Should keep the existing startedAt since none was provided
		expect(steps[0].startedAt).toBe(1700000001000);
	});

	test("toCardEntry computes durationMs from startedAt for running steps", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const fiveSecondsAgo = Date.now() - 5000;
			const step = { name: "Running step", type: "command", status: "running", startedAt: fiveSecondsAgo };
			const entry = (window as any).toCardEntry(step, 0);
			return { durationMs: entry.durationMs, status: entry.status };
		});

		// durationMs should be approximately 5000ms (allow 500ms tolerance for execution time)
		expect(result.durationMs).toBeGreaterThanOrEqual(4500);
		expect(result.durationMs).toBeLessThanOrEqual(6000);
		expect(result.status).toBe("running");
	});

	test("toCardEntry uses provided durationMs for completed steps", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const step = {
				name: "Done step",
				type: "command",
				status: "passed",
				startedAt: 1700000000000,
				durationMs: 12345,
			};
			return (window as any).toCardEntry(step, 0);
		});

		expect(result.durationMs).toBe(12345);
		expect(result.status).toBe("completed");
	});

	test("toCardEntry returns 0 for completed step without durationMs", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const step = {
				name: "Done step",
				type: "command",
				status: "failed",
				startedAt: 1700000000000,
				// no durationMs
			};
			return (window as any).toCardEntry(step, 0);
		});

		expect(result.durationMs).toBe(0);
		expect(result.status).toBe("error");
	});

	test("server timestamp far in the past produces large durationMs for running step", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			// Server started 60 seconds ago
			const step = {
				name: "Long step",
				type: "command",
				status: "running",
				startedAt: Date.now() - 60000,
			};
			return (window as any).toCardEntry(step, 0);
		});

		// Should show ~60 seconds of duration
		expect(result.durationMs).toBeGreaterThanOrEqual(59000);
		expect(result.durationMs).toBeLessThanOrEqual(62000);
	});
});
