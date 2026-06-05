// Test entry — bundles ActivateSkillRenderer so we can render it in a file:// fixture.
//
// The renderer imports `SkillChip` for its custom-element side effect
// (auto-registers <skill-chip>). The explicit import below makes that intent
// visible and resilient to tree-shaking.
import { render } from "lit";
import { ActivateSkillRenderer } from "../../src/ui/tools/renderers/ActivateSkillRenderer.js";
import "../../src/ui/components/SkillChip.js";

function renderActivate(
	container: HTMLElement,
	params: any,
	result: any = undefined,
	isStreaming = false,
) {
	const r = new ActivateSkillRenderer();
	const out = r.render(params, result, isStreaming);
	render(out.content, container);
}

(window as any).__renderActivate = renderActivate;
(window as any).__ready = true;
