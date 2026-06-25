import { test, expect } from "@playwright/test";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const FIXTURE = path.resolve("tests/fixtures/proposal-renderer-failed.html");
const BUNDLE = path.resolve("tests/fixtures/proposal-renderer-failed-bundle.js");
const ENTRY = path.resolve("tests/fixtures/proposal-renderer-failed-entry.ts");
const RENDERER_SRC = path.resolve("src/ui/tools/renderers/ProposalRenderer.ts");
const REV_HELPER_SRC = path.resolve("src/ui/tools/renderers/proposal-rev-marker.ts");

test.beforeAll(() => {
	buildBundle({ entry: ENTRY, outfile: BUNDLE, deps: [ENTRY, RENDERER_SRC, REV_HELPER_SRC] });
});

test.describe("ProposalRenderer — failed goal proposal", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(`file://${FIXTURE}`);
		await page.waitForFunction(() => (window as any).__ready === true);
	});

	test("renders MISSING_WORKFLOW as a failed but openable proposal card", async ({ page }) => {
		const result = await page.evaluate(() => (window as any).__renderFailedGoalProposal());

		expect(result.failedCard, "failed propose_goal results must use the failed proposal card state").toBe(true);
		expect(result.errorText).toContain("Workflow is required for this project");
		expect(result.errorText).toContain("general");
		expect(result.errorText).toContain("feature");
		expect(result.text).toContain("Missing Workflow Goal");
		expect(result.hasOpenButton, "failed proposal drafts must remain inspectable").toBe(true);
		expect(result.hasRev, "failed proposal attempts must not masquerade as server-stamped revisions").toBe(false);
	});
});
