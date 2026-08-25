import { html, render } from "lit";
import { clearWorkflowEditorController, renderWorkflowEditor, renderWorkflowInspector } from "../../../../../src/app/workflow-page.js";
import { setRenderApp } from "../../../../../src/app/state.js";
import "../../../../../src/ui/lazy/safe-markdown-block.js";

let projectWorkflow: any;
let inlineWorkflow: any = null;
let customizing = false;

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value));
}

function draw(): void {
	const current = inlineWorkflow || projectWorkflow;
	render(html`
		<button data-testid="fixture-customize" @click=${() => {
			inlineWorkflow = clone(projectWorkflow);
			customizing = true;
			clearWorkflowEditorController();
			draw();
		}}>Customise for this goal</button>
		<div data-testid="fixture-surface">
			${customizing
				? renderWorkflowEditor({
					workflow: current,
					scope: "goal-draft",
					onChange: (next) => { inlineWorkflow = clone(next); },
				})
				: renderWorkflowInspector({ workflow: current, scope: "goal-draft" })}
		</div>
	`, document.getElementById("app"));
}

setRenderApp(draw);
(window as any).__loadFailureGuidanceEmbed = (next: any) => {
	projectWorkflow = clone(next);
	inlineWorkflow = null;
	customizing = false;
	clearWorkflowEditorController();
	draw();
};
(window as any).__failureGuidanceInlineWorkflow = () => clone(inlineWorkflow);
(window as any).__failureGuidanceEmbedReady = true;
