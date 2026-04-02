/**
 * Reproducing test for the verification output modal bug.
 *
 * Bug: The modal shows "Waiting for output…" because both the chat widget
 * (GateVerificationLive._openModal) and the goal dashboard read only from
 * the WS accumulator (liveOutput/_stepOutputs), ignoring API-fetched output.
 *
 * This test simulates the exact data flow:
 * 1. API reconciliation populates steps[i].output (Path A)
 * 2. WS events populate _stepOutputs Map / liveOutput (Path B)
 * 3. Modal opens and reads only Path B — gets empty string
 * 4. The fix: read Path B || Path A
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/verification-modal-output.html")}`;

test.describe("Verification output modal data flow bug", () => {

	test("chat widget _openModal uses API output when WS accumulator is empty", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			// Simulate: API reconcile has populated steps with output
			const steps = [
				{ name: "Content present", type: "command", status: "passed", output: "ok\n" },
				{ name: "Analysis quality", type: "llm-review", status: "passed", output: "Looks good" },
			];

			// Simulate: WS accumulator is empty (no WS events received — e.g. component
			// connected after verification started, or page was refreshed)
			const stepOutputs = new Map();

			// Current buggy behavior: reads only from WS accumulator
			const buggyOutput = (window as any).chatWidgetOpenModal(stepOutputs, steps, 0);

			// Fixed behavior: falls back to steps[i].output
			const fixedOutput = (window as any).chatWidgetOpenModalFixed(stepOutputs, steps, 0);

			return { buggyOutput, fixedOutput };
		});

		// The buggy path gives empty string — this is the bug
		expect(result.buggyOutput).toBe("");

		// The fixed path should give the API output
		// THIS ASSERTION TESTS THE FIX — it should pass after the code change
		expect(
			result.buggyOutput || result.fixedOutput,
			"Modal should show step output from API when WS accumulator is empty"
		).toBeTruthy();

		// THE KEY ASSERTION: the current buggy code path must provide output
		// This FAILS because chatWidgetOpenModal returns "" when _stepOutputs is empty
		expect(
			result.buggyOutput,
			"Expected chat widget modal to show output but got empty string (bug: reads only WS accumulator, ignores API output)"
		).toBeTruthy();
	});

	test("dashboard modal uses API output when liveOutput is empty", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			// Simulate: API fetch populated step.output, but no WS events set liveOutput
			const step = {
				output: "ok\n",       // From API (fetchActiveVerifications)
				liveOutput: undefined, // No WS events received
			};

			const buggyOutput = (window as any).dashboardOpenModal(step);
			const fixedOutput = (window as any).dashboardOpenModalFixed(step);

			return { buggyOutput, fixedOutput };
		});

		// Buggy path: empty
		expect(result.buggyOutput).toBe("");

		// Fixed path: has content
		expect(result.fixedOutput).toBe("ok\n");

		// THE KEY ASSERTION: current buggy code must provide output
		// This FAILS because dashboardOpenModal reads only liveOutput
		expect(
			result.buggyOutput,
			"Expected dashboard modal to show output but got empty string (bug: reads only liveOutput, ignores API output)"
		).toBeTruthy();
	});

	test("_fetchAndReconcile seeds _stepOutputs from API response", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const existingStepOutputs = new Map();
			const apiSteps = [
				{ name: "Step 1", output: "echo output here\n" },
				{ name: "Step 2", output: "test results\n" },
			];

			// Current behavior: does NOT seed stepOutputs
			const buggyMap = (window as any).reconcileStepOutputs(existingStepOutputs, apiSteps);

			// Fixed behavior: seeds stepOutputs from API
			const fixedMap = (window as any).reconcileStepOutputsFixed(existingStepOutputs, apiSteps);

			return {
				buggyHasStep0: buggyMap.has(0),
				buggyHasStep1: buggyMap.has(1),
				fixedHasStep0: fixedMap.has(0),
				fixedHasStep1: fixedMap.has(1),
				fixedStep0: fixedMap.get(0),
				fixedStep1: fixedMap.get(1),
			};
		});

		// Fixed version correctly seeds
		expect(result.fixedHasStep0).toBe(true);
		expect(result.fixedStep0).toBe("echo output here\n");

		// THE KEY ASSERTION: current buggy reconcile must seed stepOutputs
		// This FAILS because reconcileStepOutputs does not seed from API
		expect(
			result.buggyHasStep0,
			"Expected _fetchAndReconcile to seed _stepOutputs from API but it did not (bug: API output not seeded into WS accumulator)"
		).toBe(true);
	});
});
