// Test entry — bundle every Children renderer so a file:// fixture can mount
// each one. Also auto-registers the two lazy custom elements.
import { render } from "lit";
import { GoalSpawnChildRenderer } from "../../src/ui/tools/renderers/GoalSpawnChildRenderer.js";
import { GoalPlanProposeRenderer } from "../../src/ui/tools/renderers/GoalPlanProposeRenderer.js";
import { GoalPlanStatusRenderer } from "../../src/ui/tools/renderers/GoalPlanStatusRenderer.js";
import { GoalMergeChildRenderer } from "../../src/ui/tools/renderers/GoalMergeChildRenderer.js";
import { GoalPauseRenderer, GoalResumeRenderer } from "../../src/ui/tools/renderers/GoalPauseResumeRenderer.js";
import { GoalArchiveChildRenderer } from "../../src/ui/tools/renderers/GoalArchiveChildRenderer.js";
import { GoalDecideMutationRenderer } from "../../src/ui/tools/renderers/GoalDecideMutationRenderer.js";
import { GoalSetPolicyRenderer } from "../../src/ui/tools/renderers/GoalSetPolicyRenderer.js";
import { _setSubgoalsEnabledForTesting } from "../../src/app/subgoals-flag.js";
import "../../src/ui/lazy/children-mutation-approval.js";
import "../../src/ui/lazy/children-goal-state-pill.js";

const renderers: Record<string, any> = {
	goal_spawn_child: new GoalSpawnChildRenderer(),
	goal_plan_propose: new GoalPlanProposeRenderer(),
	goal_plan_status: new GoalPlanStatusRenderer(),
	goal_merge_child: new GoalMergeChildRenderer(),
	goal_pause: new GoalPauseRenderer(),
	goal_resume: new GoalResumeRenderer(),
	goal_archive_child: new GoalArchiveChildRenderer(),
	goal_decide_mutation: new GoalDecideMutationRenderer(),
	goal_set_policy: new GoalSetPolicyRenderer(),
};

// Default flag on for tests — individual tests can override via __setFlag.
_setSubgoalsEnabledForTesting(true);

(window as any).__setFlag = (enabled: boolean | undefined) => _setSubgoalsEnabledForTesting(enabled);

(window as any).__renderChildren = (
	toolName: string,
	container: HTMLElement,
	params: any,
	result: any = undefined,
	isStreaming = false,
	ctx: any = {},
) => {
	const r = renderers[toolName];
	if (!r) throw new Error(`no renderer for ${toolName}`);
	const out = r.render(params, result, isStreaming, ctx);
	render(out.content, container);
};

// Fetch mock — every test should call __resetFetchCalls() up front.
(window as any).__fetchCalls = [];
(window as any).__setFetchResponse = (fn: (url: string, init: any) => { status: number; body: any }) => {
	(window as any).__fetchResponder = fn;
};
(window as any).__getFetchCalls = () => (window as any).__fetchCalls || [];
(window as any).__resetFetchCalls = () => { (window as any).__fetchCalls = []; };
window.fetch = async (url: any, init: any = {}) => {
	(window as any).__fetchCalls.push({ url: String(url), method: init?.method || "GET", body: init?.body });
	const responder = (window as any).__fetchResponder as undefined | ((u: string, i: any) => { status: number; body: any });
	const resp = responder ? responder(String(url), init) : { status: 200, body: { ok: true } };
	return new Response(JSON.stringify(resp.body), { status: resp.status, headers: { "Content-Type": "application/json" } });
};

(window as any).__ready = true;
