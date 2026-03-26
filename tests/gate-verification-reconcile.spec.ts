/**
 * Unit tests for gate verification reconciliation logic.
 *
 * Tests the reconciliation functions that fix the stuck "running" state bug
 * in <gate-verification-live>. When the component misses the completion
 * CustomEvent (due to disconnect/reconnect, scrollback, or page refresh),
 * it should fetch gate state from REST and reconcile.
 *
 * Pattern: file:// fixture with window-exposed functions, evaluated in page context.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/gate-verification-reconcile.html")}`;

test.describe("Gate verification reconciliation", () => {

	test("reconciles stuck running component to passed when REST shows passed", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const componentState = {
				steps: [
					{ name: "Type check", type: "command", status: "running", startedAt: Date.now() - 5000 },
					{ name: "Run tests", type: "command", status: "running", startedAt: Date.now() - 5000 },
				],
				overallStatus: "running",
			};

			const gateData = {
				signals: [{
					id: "signal-123",
					verification: {
						status: "passed",
						steps: [
							{ name: "Type check", type: "command", passed: true, output: "OK", duration_ms: 3200 },
							{ name: "Run tests", type: "command", passed: true, output: "12 passed", duration_ms: 8500 },
						],
					},
				}],
			};

			return (window as any).reconcileFromGateData(componentState, gateData, "signal-123");
		});

		expect(result.overallStatus).toBe("passed");
		expect(result.steps).toHaveLength(2);
		expect(result.steps[0].status).toBe("passed");
		expect(result.steps[0].name).toBe("Type check");
		expect(result.steps[0].durationMs).toBe(3200);
		expect(result.steps[0].output).toBe("OK");
		expect(result.steps[1].status).toBe("passed");
		expect(result.steps[1].name).toBe("Run tests");
		expect(result.steps[1].durationMs).toBe(8500);
		expect(result.steps[1].output).toBe("12 passed");
	});

	test("reconciles stuck running component to failed when REST shows failure", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const componentState = {
				steps: [
					{ name: "Type check", type: "command", status: "running", startedAt: Date.now() - 10000 },
					{ name: "Run tests", type: "command", status: "running", startedAt: Date.now() - 10000 },
				],
				overallStatus: "running",
			};

			const gateData = {
				signals: [{
					id: "signal-456",
					verification: {
						status: "failed",
						steps: [
							{ name: "Type check", type: "command", passed: true, output: "OK", duration_ms: 2100 },
							{ name: "Run tests", type: "command", passed: false, output: "3 failed", duration_ms: 5000 },
						],
					},
				}],
			};

			return (window as any).reconcileFromGateData(componentState, gateData, "signal-456");
		});

		expect(result.overallStatus).toBe("failed");
		expect(result.steps).toHaveLength(2);
		expect(result.steps[0].status).toBe("passed");
		expect(result.steps[1].status).toBe("failed");
		expect(result.steps[1].output).toBe("3 failed");
	});

	test("skips reconciliation when already in terminal state", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const originalSteps = [
				{ name: "Type check", type: "command", status: "passed", durationMs: 1500, startedAt: 0 },
			];
			const componentState = {
				steps: originalSteps,
				overallStatus: "passed",
			};

			const gateData = {
				signals: [{
					id: "signal-789",
					verification: {
						status: "passed",
						steps: [
							{ name: "Type check", type: "command", passed: true, output: "OK", duration_ms: 1500 },
						],
					},
				}],
			};

			const reconciled = (window as any).reconcileFromGateData(componentState, gateData, "signal-789");
			// Should return the exact same steps reference (no change)
			return {
				overallStatus: reconciled.overallStatus,
				stepsAreSame: reconciled.steps === originalSteps,
				steps: reconciled.steps,
			};
		});

		expect(result.overallStatus).toBe("passed");
		expect(result.stepsAreSame).toBe(true);
	});

	test("skips reconciliation when signalId is missing", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			return (window as any).shouldReconcile("running", "goal-1", "gate-1", "");
		});

		expect(result).toBe(false);
	});

	test("skips reconciliation when goalId is missing", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			return (window as any).shouldReconcile("running", "", "gate-1", "signal-1");
		});

		expect(result).toBe(false);
	});

	test("shouldReconcile returns true when status is running and all IDs present", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			return (window as any).shouldReconcile("running", "goal-1", "gate-1", "signal-1");
		});

		expect(result).toBe(true);
	});

	test("shouldReconcile returns true when status is idle and all IDs present", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			return (window as any).shouldReconcile("idle", "goal-1", "gate-1", "signal-1");
		});

		expect(result).toBe(true);
	});

	test("shouldReconcile returns false when already passed", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			return (window as any).shouldReconcile("passed", "goal-1", "gate-1", "signal-1");
		});

		expect(result).toBe(false);
	});

	test("maps GateSignalStep fields correctly", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const gateStep = {
				name: "Analysis quality",
				type: "llm-review",
				passed: true,
				output: "Looks good\nAll criteria met",
				duration_ms: 53119,
			};
			return (window as any).mapGateSignalStep(gateStep);
		});

		expect(result.name).toBe("Analysis quality");
		expect(result.type).toBe("llm-review");
		expect(result.status).toBe("passed");
		expect(result.durationMs).toBe(53119);
		expect(result.output).toBe("Looks good\nAll criteria met");
		expect(result.startedAt).toBeGreaterThan(0);
	});

	test("maps passed=false to status failed", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			return (window as any).mapGateSignalStep({
				name: "Tests", type: "command", passed: false, output: "FAIL", duration_ms: 1000,
			});
		});

		expect(result.status).toBe("failed");
	});

	test("maps passed=null to status running", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			return (window as any).mapGateSignalStep({
				name: "Tests", type: "command", passed: null, output: "", duration_ms: 0,
			});
		});

		expect(result.status).toBe("running");
	});

	test("does not reconcile when REST signal verification is still running", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const componentState = {
				steps: [
					{ name: "Step 1", type: "command", status: "running", startedAt: Date.now() - 2000 },
				],
				overallStatus: "running",
			};

			const gateData = {
				signals: [{
					id: "signal-still-running",
					verification: {
						status: "running",
						steps: [],
					},
				}],
			};

			return (window as any).reconcileFromGateData(componentState, gateData, "signal-still-running");
		});

		// Should not change — REST also shows running
		expect(result.overallStatus).toBe("running");
		expect(result.steps).toHaveLength(1);
		expect(result.steps[0].status).toBe("running");
	});

	test("handles missing signal in gate data gracefully", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const componentState = {
				steps: [{ name: "Step 1", type: "command", status: "running", startedAt: Date.now() }],
				overallStatus: "running",
			};

			const gateData = {
				signals: [{
					id: "other-signal",
					verification: { status: "passed", steps: [] },
				}],
			};

			return (window as any).reconcileFromGateData(componentState, gateData, "signal-not-found");
		});

		// Should not change — signal not found
		expect(result.overallStatus).toBe("running");
	});
});
