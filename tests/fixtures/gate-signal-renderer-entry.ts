import { render } from "lit";
import { GateSignalRenderer } from "../../src/ui/tools/renderers/GateToolRenderers.js";

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

function toolResult(data: any) {
	return { isError: false, content: [{ type: "text", text: JSON.stringify(data) }] };
}

async function renderSignal(params: any, data: any) {
	const container = document.getElementById("container")!;
	container.innerHTML = "";
	const renderer = new GateSignalRenderer();
	const out = renderer.render(params, toolResult(data));
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

(window as any).__renderGateSignal = renderSignal;
(window as any).__ready = true;
