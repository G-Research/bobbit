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

	test("renders plaintext MISSING_WORKFLOW extension errors as a failed but reopenable proposal card", async ({ page }) => {
		const result = await page.evaluate(() => (window as any).__renderFailedGoalProposal());

		expect(result.failedCard, "failed propose_goal results must use the failed proposal card state").toBe(true);
		expect(result.errorText).toBe("Workflow is required for this project. Re-call propose_goal with one of these workflow IDs: general, feature.");
		expect(result.text).toContain("Missing Workflow Goal");
		expect(result.hasOpenButton, "failed proposal drafts must remain inspectable").toBe(true);
		expect(result.hasRev, "failed proposal attempts must not masquerade as server-stamped revisions").toBe(false);
		expect(result.openDetail, "opening a plaintext workflow failure must preserve failed workflow metadata").toMatchObject({
			type: "goal",
			fields: {
				title: "Missing Workflow Goal",
				spec: "Draft body without a workflow.",
			},
			workflowValidationError: {
				code: "MISSING_WORKFLOW",
				message: "Workflow is required for this project. Re-call propose_goal with one of these workflow IDs: general, feature.",
			},
		});
		const workflowIds = result.openDetail?.workflowValidationError?.availableWorkflows?.map((workflow: { id: string }) => workflow.id) ?? [];
		expect(workflowIds, "plaintext workflow failures should keep valid workflow IDs available for the proposal panel").toEqual(["general", "feature"]);
	});

	test("infers missing-workflow failures when older transcripts have isError false", async ({ page }) => {
		const result = await page.evaluate(() => (window as any).__renderUnflaggedFailedGoalProposal());

		expect(result.failedCard, "known workflow-validation text should render as failed even if isError was dropped").toBe(true);
		expect(result.hasRev, "inferred failures must not emit a successful rev marker").toBe(false);
		expect(result.openDetail).toMatchObject({
			type: "goal",
			workflowValidationError: {
				code: "MISSING_WORKFLOW",
				message: "Workflow is required for this project. Re-call propose_goal with one of these workflow IDs: general, feature.",
			},
		});
	});

	test("infers structured UNKNOWN_WORKFLOW failures without poisoning available workflow details", async ({ page }) => {
		const result = await page.evaluate(() => (window as any).__renderStructuredUnknownWorkflow());

		expect(result.failedCard).toBe(true);
		expect(result.errorText).toContain('Unknown workflow "legacy"');
		expect(result.openDetail?.workflowValidationError?.code).toBe("UNKNOWN_WORKFLOW");
		expect(result.openDetail?.workflowValidationError?.availableWorkflows).toEqual([
			{ id: "general", name: "General" },
			{ id: "feature", name: "Feature" },
		]);
	});

	test("does not infer failure for normal unflagged rev-backed proposal results", async ({ page }) => {
		const result = await page.evaluate(() => (window as any).__renderNormalUnflaggedGoalProposal());

		expect(result.failedCard).toBe(false);
		expect(result.errorText).toBe("");
		expect(result.hasRev).toBe(true);
		expect(result.openDetail).toMatchObject({ type: "goal", rev: 3 });
		expect(result.openDetail?.workflowValidationError).toBeUndefined();
	});
});
