import { render } from "lit";
import { ProposalRenderer } from "../../src/ui/tools/renderers/ProposalRenderer.js";

const ERROR_TEXT = "Workflow is required for this project. Re-call propose_goal with one of these workflow IDs: general, feature.";

function failedResult() {
	return {
		role: "toolResult",
		toolCallId: "tool_missing_workflow",
		toolName: "propose_goal",
		isError: true,
		content: [{ type: "text", text: ERROR_TEXT }],
		timestamp: Date.now(),
	};
}

let lastOpenDetail: unknown;

document.addEventListener("proposal-open", (event) => {
	lastOpenDetail = (event as CustomEvent).detail;
});

async function renderFailedGoalProposal() {
	const container = document.getElementById("container")!;
	container.innerHTML = "";
	lastOpenDetail = undefined;
	const renderer = new ProposalRenderer("propose_goal");
	const out = renderer.render(
		{ title: "Missing Workflow Goal", spec: "Draft body without a workflow." },
		failedResult() as any,
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

(window as any).__renderFailedGoalProposal = renderFailedGoalProposal;
(window as any).__ready = true;
