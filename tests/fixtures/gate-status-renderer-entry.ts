import { render } from "lit";
import { GateStatusRenderer } from "../../src/ui/tools/renderers/GateToolRenderers.js";

class GateVerificationLiveStub extends HTMLElement {
	goalId = "";
	gateId = "";
	signalId = "";
	initialSteps: any[] = [];
	finalStatus?: string;
}

if (!customElements.get("gate-verification-live")) {
	customElements.define("gate-verification-live", GateVerificationLiveStub);
}

function toolResult(data: any, isError = false) {
	return { isError, content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }] };
}

async function renderStatus(params: any, data: any, isError = false) {
	const container = document.getElementById("container")!;
	container.innerHTML = "";
	const renderer = new GateStatusRenderer();
	const out = renderer.render(params, toolResult(data, isError));
	render(out.content, container);
	await Promise.resolve();
	const live = container.querySelector("gate-verification-live") as any;
	return {
		text: container.textContent || "",
		hasLive: !!live,
		goalId: live?.goalId || "",
		gateId: live?.gateId || "",
		signalId: live?.signalId || "",
		initialSteps: live?.initialSteps || [],
		finalStatus: live?.finalStatus,
	};
}

(window as any).__renderGateStatus = renderStatus;
(window as any).__ready = true;
