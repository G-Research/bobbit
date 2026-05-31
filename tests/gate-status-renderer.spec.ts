import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/gate-status-renderer.html");
const BUNDLE = path.resolve("tests/fixtures/gate-status-renderer-bundle.js");
const ENTRY = path.resolve("tests/fixtures/gate-status-renderer-entry.ts");
const RENDERER_SRC = path.resolve("src/ui/tools/renderers/GateToolRenderers.ts");
function ensureBundle() {
	const newestSource = Math.max(
		fs.statSync(ENTRY).mtimeMs,
		fs.statSync(RENDERER_SRC).mtimeMs,
	);
	const bundleExists = fs.existsSync(BUNDLE);
	if (!bundleExists || fs.statSync(BUNDLE).mtimeMs < newestSource) {
		execSync(
			[
				`npx esbuild ${ENTRY}`,
				"--bundle --format=iife --target=es2022",
				`--outfile=${BUNDLE}`,
				"--tsconfig=tsconfig.web.json",
			].join(" "),
			{ stdio: "pipe" },
		);
	}
}

test.beforeAll(ensureBundle);

test.describe("GateStatusRenderer", () => {
	test.describe.configure({ mode: "serial" });
	test.beforeEach(async ({ page }) => {
		await page.goto(`file://${FIXTURE}`);
		await page.waitForFunction(() => (window as any).__ready === true);
	});

	test("renders active latestSignal summary through gate-verification-live", async ({ page }) => {
		const result = await page.evaluate(() => (window as any).__renderGateStatus(
			{ gate_id: "implementation" },
			{
				goalId: "goal-123",
				gateId: "implementation",
				name: "Implementation",
				status: "pending",
				latestSignal: {
					id: "signal-123",
					verification: {
						status: "running",
						steps: [
							{ name: "Review", status: "running", duration_ms: 1200, output: "tail" },
							{ name: "QA", status: "waiting" },
						],
					},
				},
			},
		));

		expect(result.hasLive).toBe(true);
		expect(result.goalId).toBe("goal-123");
		expect(result.gateId).toBe("implementation");
		expect(result.signalId).toBe("signal-123");
		expect(result.initialSteps.map((s: any) => s.status)).toEqual(["running", "waiting"]);
		expect(result.finalStatus).toBeUndefined();
	});

	test("keeps legacy signals[] support and only passes terminal finalStatus", async ({ page }) => {
		const result = await page.evaluate(() => (window as any).__renderGateStatus(
			{ gate_id: "design-doc" },
			{
				goalId: "goal-legacy",
				gateId: "design-doc",
				status: "passed",
				signals: [{
					id: "signal-legacy",
					verification: {
						status: "passed",
						steps: [{ name: "Check", status: "passed", passed: true, duration_ms: 10 }],
					},
				}],
			},
		));

		expect(result.hasLive).toBe(true);
		expect(result.goalId).toBe("goal-legacy");
		expect(result.gateId).toBe("design-doc");
		expect(result.signalId).toBe("signal-legacy");
		expect(result.initialSteps).toHaveLength(1);
		expect(result.finalStatus).toBe("passed");
	});
});
