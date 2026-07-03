import { render } from "lit";
import { TeamDismissRenderer } from "../../src/ui/tools/renderers/TeamToolRenderers.js";

const renderer = new TeamDismissRenderer();

(window as any).__renderTeamDismiss = (
	container: HTMLElement,
	params: any,
	result: any = undefined,
	isStreaming = false,
) => {
	const out = renderer.render(params, result, isStreaming);
	render(out.content, container);
};

(window as any).__ready = true;
