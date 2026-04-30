// Test entry — bundles renderMissionDagSvg so we can render it in a file:// fixture.
import { render } from "lit";
import { renderMissionDagSvg } from "../../src/ui/components/MissionDagSvg.js";
import type { MissionPlan } from "../../src/app/mission-types.js";

(window as any).__renderDag = (plan: MissionPlan | null, container: HTMLElement) => {
	render(renderMissionDagSvg(plan), container);
};
(window as any).__ready = true;
