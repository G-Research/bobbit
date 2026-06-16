import { test, expect } from "@playwright/test";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const FIXTURE = path.resolve("tests/fixtures/gate-signal-renderer.html");
const BUNDLE = path.resolve("tests/fixtures/gate-signal-renderer-bundle.js");
const ENTRY = path.resolve("tests/fixtures/gate-signal-renderer-entry.ts");
const RENDERER_SRC = path.resolve("src/ui/tools/renderers/GateToolRenderers.ts");

const AGENT_REMINDER = "Gate signal accepted. Verification is running asynchronously. Do not poll with `gate_status` or `gate_inspect`. Go idle now and wait for the server to deliver verification results or further instructions.";

test.beforeAll(() => {
	buildBundle({ entry: ENTRY, outfile: BUNDLE, deps: [ENTRY, RENDERER_SRC] });
});

test.describe("GateSignalRenderer", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(`file://${FIXTURE}`);
		await page.waitForFunction(() => (window as any).__ready === true);
	});

	test("renders live gate signal UI without exposing the top-level agent reminder", async ({ page }) => {
		const result = await page.evaluate((agentReminder) => (window as any).__renderGateSignal(
			{ gate_id: "implementation" },
			{
				signal: {
					id: "signal-123",
					goalId: "goal-abc",
					gateId: "implementation",
					status: "running",
					steps: [
						{ name: "typecheck", type: "command", status: "running", duration_ms: 2500, output: "checking" },
						{ name: "review", type: "llm-review", status: "waiting" },
					],
				},
				agentReminder,
			},
		), AGENT_REMINDER);

		expect(result.hasLive).toBe(true);
		expect(result.text).toContain("Signaled implementation");
		expect(result.text).not.toContain(AGENT_REMINDER);
		expect(result.goalId).toBe("goal-abc");
		expect(result.gateId).toBe("implementation");
		expect(result.signalId).toBe("signal-123");
		expect(result.initialSteps.map((step: any) => step.status)).toEqual(["running", "waiting"]);
		expect(result.finalStatus).toBeUndefined();
	});
});
