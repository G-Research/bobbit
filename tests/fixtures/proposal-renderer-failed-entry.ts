import { render } from "lit";
import { ProposalRenderer } from "../../src/ui/tools/renderers/ProposalRenderer.js";

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

document.addEventListener("proposal-open", (event) => {
	lastOpenDetail = (event as CustomEvent).detail;
});

async function renderGoalProposal(resultOverrides: Record<string, unknown> = {}) {
	const container = document.getElementById("container")!;
	container.innerHTML = "";
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
		openDetail: lastOpenDetail,
	};
}

(window as any).__renderFailedGoalProposal = () => renderGoalProposal();
(window as any).__renderUnflaggedFailedGoalProposal = () => renderGoalProposal({ isError: false });
(window as any).__renderStructuredUnknownWorkflow = () => renderGoalProposal({
	isError: false,
	content: [{ type: "text", text: JSON.stringify({
		code: "UNKNOWN_WORKFLOW",
		message: 'Unknown workflow "legacy". Available workflows for this project: general, feature.',
		availableWorkflows: [{ id: "general", name: "General" }, { id: "feature", name: "Feature" }],
	}) }],
});
(window as any).__renderNormalUnflaggedGoalProposal = () => renderGoalProposal({
	isError: false,
	content: [{ type: "text", text: "Goal proposal submitted. __proposal_rev_v1__:3" }],
});
(window as any).__ready = true;
