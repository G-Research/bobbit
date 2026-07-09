import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/proposal-renderer-failed.spec.ts (v2-dom tier).
// Renders the REAL ProposalRenderer via lit into a happy-dom container
// (replacing the esbuild file:// bundle) and drives the same failed-proposal
// scenarios the legacy entry exposed on `window`.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "lit";
import { ProposalRenderer } from "../../src/ui/tools/renderers/ProposalRenderer.js";
// ProposalRenderer.render() calls ensureMarkdownBlock() (a fire-and-forget
// dynamic import of the markdown/KaTeX graph). Pre-import that chunk statically
// so its top-level @customElement decorators run now (while happy-dom's
// customElements is live) instead of racing env teardown as an unhandled
// "customElements is not defined" rejection.
import "../../src/ui/lazy/safe-markdown-block.js";

const ERROR_TEXT = "Workflow is required for this project. Re-call propose_goal with one of these workflow IDs: general, feature.";

function toolResult(overrides: Record<string, unknown> = {}) {
	return {
		role: "toolResult",
		toolCallId: "tool_missing_workflow",
		toolName: "propose_goal",
		isError: true,
		content: [{ type: "text", text: ERROR_TEXT }],
		timestamp: Date.now(),
		...overrides,
	};
}

let lastOpenDetail: unknown;
const onProposalOpen = (event: Event) => { lastOpenDetail = (event as CustomEvent).detail; };

beforeEach(() => {
	lastOpenDetail = undefined;
	document.addEventListener("proposal-open", onProposalOpen);
});
afterEach(() => {
	document.removeEventListener("proposal-open", onProposalOpen);
	document.body.innerHTML = "";
});

async function renderGoalProposal(resultOverrides: Record<string, unknown> = {}) {
	const container = document.createElement("div");
	container.id = "container";
	document.body.appendChild(container);
	lastOpenDetail = undefined;
	const renderer = new ProposalRenderer("propose_goal");
	const out = renderer.render(
		{ title: "Missing Workflow Goal", spec: "Draft body without a workflow." },
		toolResult(resultOverrides) as any,
		false,
	);
	render(out.content, container);
	await Promise.resolve();
	const openButton = container.querySelector('[data-testid="proposal-open-button"]') as HTMLElement | null;
	openButton?.click();
	await Promise.resolve();
	return {
		text: container.textContent || "",
		failedCard: !!container.querySelector('[data-testid="proposal-failed-card"]'),
		errorText: container.querySelector('[data-testid="proposal-error-message"]')?.textContent || "",
		hasOpenButton: !!openButton,
		hasRev: !!container.querySelector('[data-testid="proposal-rev"]'),
		openDetail: lastOpenDetail as any,
	};
}

describe("ProposalRenderer — failed goal proposal", () => {
	it("renders plaintext MISSING_WORKFLOW extension errors as a failed but reopenable proposal card", async () => {
		const result = await renderGoalProposal();

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

	it("infers missing-workflow failures when older transcripts have isError false", async () => {
		const result = await renderGoalProposal({ isError: false });

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

	it("infers structured UNKNOWN_WORKFLOW failures without poisoning available workflow details", async () => {
		const result = await renderGoalProposal({
			isError: false,
			content: [{ type: "text", text: JSON.stringify({
				code: "UNKNOWN_WORKFLOW",
				message: 'Unknown workflow "legacy". Available workflows for this project: general, feature.',
				availableWorkflows: [{ id: "general", name: "General" }, { id: "feature", name: "Feature" }],
			}) }],
		});

		expect(result.failedCard).toBe(true);
		expect(result.errorText).toContain('Unknown workflow "legacy"');
		expect(result.openDetail?.workflowValidationError?.code).toBe("UNKNOWN_WORKFLOW");
		expect(result.openDetail?.workflowValidationError?.availableWorkflows).toEqual([
			{ id: "general", name: "General" },
			{ id: "feature", name: "Feature" },
		]);
	});

	it("does not infer failure for normal unflagged rev-backed proposal results", async () => {
		const result = await renderGoalProposal({
			isError: false,
			content: [{ type: "text", text: "Goal proposal submitted. __proposal_rev_v1__:3" }],
		});

		expect(result.failedCard).toBe(false);
		expect(result.errorText).toBe("");
		expect(result.hasRev).toBe(true);
		expect(result.openDetail).toMatchObject({ type: "goal", rev: 3 });
		expect(result.openDetail?.workflowValidationError).toBeUndefined();
	});
});
