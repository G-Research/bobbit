import { render } from "lit";
import { ProposalRenderer } from "../../src/ui/tools/renderers/ProposalRenderer.js";

const ERROR_BODY = {
	ok: false,
	code: "MISSING_WORKFLOW",
	message: "Workflow is required for this project. Re-call propose_goal with one of: general, feature.",
	availableWorkflows: [
		{ id: "general", name: "General" },
		{ id: "feature", name: "Feature" },
	],
};

function failedResult() {
	return {
		role: "toolResult",
		toolCallId: "tool_missing_workflow",
		toolName: "propose_goal",
		isError: true,
		content: [{ type: "text", text: JSON.stringify(ERROR_BODY) }],
		timestamp: Date.now(),
	};
}

async function renderFailedGoalProposal() {
	const container = document.getElementById("container")!;
	container.innerHTML = "";
	const renderer = new ProposalRenderer("propose_goal");
	const out = renderer.render(
		{ title: "Missing Workflow Goal", spec: "Draft body without a workflow." },
		failedResult() as any,
		false,
	);
	render(out.content, container);
	await Promise.resolve();
	return {
		text: container.textContent || "",
		failedCard: !!container.querySelector('[data-testid="proposal-failed-card"]'),
		errorText: container.querySelector('[data-testid="proposal-error-message"]')?.textContent || "",
		hasOpenButton: !!container.querySelector('[data-testid="proposal-open-button"]'),
		hasRev: !!container.querySelector('[data-testid="proposal-rev"]'),
	};
}

(window as any).__renderFailedGoalProposal = renderFailedGoalProposal;
(window as any).__ready = true;
