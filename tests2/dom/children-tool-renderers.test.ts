// Migrated from tests/children-tool-renderers.spec.ts (v2-dom tier).
// Renders the REAL nine Children tool renderers via lit into happy-dom (was an
// esbuild file:// bundle) and asserts on rendered DOM. The two interactive
// custom elements (<children-mutation-approval>, <children-goal-state-pill>)
// use shadow DOM, so their internals are queried via shadowRoot (Playwright
// pierced open shadow roots automatically; happy-dom querySelector does not).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
// Statically import the lazy custom-element chunks so their top-level
// @customElement decorators run while happy-dom's customElements is live.
import "../../src/ui/lazy/children-mutation-approval.js";
import "../../src/ui/lazy/children-goal-state-pill.js";
import "../../src/ui/components/ExpandableSection.js";
// <children-goal-state-pill>.connectedCallback() fire-and-forget dynamic-imports
// remote-agent.js. Pre-import it (and its safe-markdown transitive graph)
// statically so it resolves DURING the test rather than after env teardown
// (which would surface as a "customElements is not defined" unhandled rejection
// that corrupts the shared fork under isolate:false). session-manager.js is
// imported FIRST so it owns the session-manager⇄pack-panels import cycle and
// pack-panels fully initialises before remote-agent pulls it in (TDZ guard).
import "../../src/app/session-manager.js";
import "../../src/app/remote-agent.js";
import "../../src/ui/lazy/safe-markdown-block.js";

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

let container: HTMLElement;
let fetchCalls: Array<{ url: string; method: string; body: any }>;
let fetchResponder: ((url: string, init: any) => { status: number; body: any }) | undefined;

function renderChildren(
	toolName: string,
	params: any,
	result: any = undefined,
	isStreaming = false,
	ctx: any = {},
): void {
	const r = renderers[toolName];
	if (!r) throw new Error(`no renderer for ${toolName}`);
	const out = r.render(params, result, isStreaming, ctx);
	render(out.content, container);
}

const q = (sel: string) => container.querySelector(sel);
const qa = (sel: string) => container.querySelectorAll(sel);
const pierce = (host: any, sel: string) => host?.shadowRoot?.querySelector(sel) as HTMLElement | null;

async function waitFor(fn: () => boolean, timeout = 3000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (fn()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error("waitFor timed out");
}

beforeEach(() => {
	_setSubgoalsEnabledForTesting(true);
	fetchCalls = [];
	fetchResponder = undefined;
	vi.stubGlobal("fetch", async (url: any, init: any = {}) => {
		fetchCalls.push({ url: String(url), method: init?.method || "GET", body: init?.body });
		const resp = fetchResponder ? fetchResponder(String(url), init) : { status: 200, body: { ok: true } };
		return new Response(JSON.stringify(resp.body), { status: resp.status, headers: { "Content-Type": "application/json" } });
	});
	container = document.createElement("div");
	container.id = "container";
	document.body.appendChild(container);
});

afterEach(() => {
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
});

describe("Children tool renderers — streaming/success/error per tool", () => {
	const tools = [
		"goal_spawn_child", "goal_plan_propose", "goal_plan_status", "goal_merge_child",
		"goal_pause", "goal_resume", "goal_archive_child", "goal_decide_mutation", "goal_set_policy",
	];
	for (const name of tools) {
		it(`${name}: streaming renders header`, () => {
			renderChildren(name, {}, undefined, true);
			// Loader spinner present (renderHeader's inprogress state)
			expect(qa(".animate-spin").length).toBe(1);
		});

		it(`${name}: error result renders destructive text`, () => {
			renderChildren(name, {}, {
				role: "toolResult", toolCallId: "t1", toolName: name,
				isError: true, content: [{ type: "text", text: "boom" }], timestamp: 0,
			}, false);
			expect(qa(".text-destructive").length).toBeGreaterThan(0);
			expect(container.textContent || "").toContain("boom");
		});
	}
});

describe("goal_spawn_child", () => {
	it("success renders title + planId data-testids + state pill", () => {
		renderChildren("goal_spawn_child",
			{ title: "Add login", planId: "p-1", spec: "Build login flow" },
			{ role: "toolResult", toolCallId: "t1", toolName: "goal_spawn_child",
				isError: false, content: [{ type: "text", text: JSON.stringify({ id: "g-deadbeef-1234" }) }], timestamp: 0 },
			false);
		expect(q('[data-testid="children-spawn-title"]')?.textContent).toBe("Add login");
		expect(q('[data-testid="children-spawn-planid"]')?.textContent).toBe("p-1");
		expect(qa("children-goal-state-pill").length).toBe(1);
	});
});

describe("goal_plan_propose", () => {
	it("renders step rows for plain proposal", () => {
		renderChildren("goal_plan_propose",
			{ steps: [
				{ phase: "do", title: "Step A", spec: "spec A" },
				{ phase: "do", title: "Step B", spec: "spec B" },
			] },
			{ role: "toolResult", toolCallId: "t1", toolName: "goal_plan_propose",
				isError: false, content: [{ type: "text", text: JSON.stringify({ classification: "fix-up", applied: true }) }], timestamp: 0 },
			false);
		expect(qa('[data-testid="children-plan-step-row"]').length).toBe(2);
		expect(q('[data-testid="children-classification-badge"]')?.textContent).toBe("fix-up");
		expect(q('[data-testid="children-applied-pill"]')).toBeTruthy();
	});

	it("criteria-drop classification shows red banner", () => {
		renderChildren("goal_plan_propose",
			{ steps: [{ phase: "do", title: "X", spec: "y" }] },
			{ role: "toolResult", toolCallId: "t1", toolName: "goal_plan_propose",
				isError: false, content: [{ type: "text", text: JSON.stringify({ classification: "criteria-drop" }) }], timestamp: 0 },
			false);
		expect(q('[data-testid="children-criteria-drop-banner"]')?.textContent || "").toMatch(/drop acceptance criteria/);
	});

	it("requiresApproval renders <children-mutation-approval> with buttons", async () => {
		renderChildren("goal_plan_propose",
			{ steps: [{ phase: "do", title: "X", spec: "y" }] },
			{ role: "toolResult", toolCallId: "t1", toolName: "goal_plan_propose",
				isError: false, content: [{ type: "text", text: JSON.stringify({ classification: "expansion", requiresApproval: true, requestId: "req-aaa" }) }], timestamp: 0 },
			false, { goalId: "goal-xyz" });
		const approval = q("children-mutation-approval") as any;
		expect(approval.getAttribute("request-id")).toBe("req-aaa");
		expect(approval.getAttribute("goal-id")).toBe("goal-xyz");
		await approval.updateComplete;
		expect(pierce(approval, '[data-testid="children-mutation-approve"]')).toBeTruthy();
		expect(pierce(approval, '[data-testid="children-mutation-reject"]')).toBeTruthy();
	});

	it("fallback spawn-children-direct shows spawned list", () => {
		renderChildren("goal_plan_propose",
			{ steps: [] },
			{ role: "toolResult", toolCallId: "t1", toolName: "goal_plan_propose",
				isError: false, content: [{ type: "text", text: JSON.stringify({
					fallback: "spawn-children-direct",
					spawned: [
						{ planId: "p1", childGoalId: "abcdef1234" },
						{ planId: "p2", alreadyExists: true },
					],
				}) }], timestamp: 0 },
			false);
		const list = q('[data-testid="children-fallback-list"]');
		expect(list).toBeTruthy();
		expect(list?.textContent || "").toContain("p1");
		expect(list?.textContent || "").toContain("p2");
		expect(container.textContent || "").toContain("fell back to spawn-children-direct");
	});

	it("partial streaming with steps renders rows already complete", () => {
		renderChildren("goal_plan_propose",
			{ steps: [{ phase: "do", title: "Partial", spec: "spec" }] },
			undefined, true);
		expect(qa('[data-testid="children-plan-step-row"]').length).toBe(1);
	});

	it("approve button POSTs decision endpoint with {decision:'approve'} and pill flips", async () => {
		renderChildren("goal_plan_propose",
			{ steps: [{ phase: "do", title: "X", spec: "y" }] },
			{ role: "toolResult", toolCallId: "t1", toolName: "goal_plan_propose",
				isError: false, content: [{ type: "text", text: JSON.stringify({ classification: "expansion", requiresApproval: true, requestId: "req-bbb" }) }], timestamp: 0 },
			false, { goalId: "goal-zzz" });
		const approval = q("children-mutation-approval") as any;
		await approval.updateComplete;
		fetchCalls = [];
		pierce(approval, '[data-testid="children-mutation-approve"]')!.click();
		await waitFor(() => !!pierce(approval, '[data-testid="children-mutation-decided"]'));
		expect(pierce(approval, '[data-testid="children-mutation-decided"]')?.textContent || "").toMatch(/Approved/);
		const post = fetchCalls.find((c) => c.method === "POST" && /mutation\/req-bbb\/decision/.test(c.url));
		expect(post).toBeTruthy();
		expect(JSON.parse(post!.body)).toEqual({ decision: "approve" });
	});
});

describe("remaining children tool success outputs", () => {
	it("goal_plan_status renders plan summary, rows, child chips, and plan tab action", () => {
		renderChildren("goal_plan_status", {},
			{ role: "toolResult", toolCallId: "t1", toolName: "goal_plan_status", isError: false, content: [{ type: "text", text: JSON.stringify({
				steps: [{ phase: "do", title: "Build API", spec: "Implement endpoint", planId: "p-api", childGoalId: "goal-child-1", childState: "running" }],
				frozen: true,
				replanCount: 2,
			}) }], timestamp: 0 },
			false, { goalId: "goal-parent" });
		expect(container.textContent || "").toContain("Plan — 1 steps");
		expect(container.textContent || "").toContain("frozen");
		expect(container.textContent || "").toContain("replanCount=2");
		expect(qa('[data-testid="children-plan-step-row"]').length).toBe(1);
		expect(q('[data-testid="children-plan-open-tab"]')).toBeTruthy();
		expect((q("children-goal-state-pill") as any)?.getAttribute("goal-id")).toBe("goal-child-1");
	});

	it("goal_pause and goal_resume render affected counts and cascade chip", () => {
		renderChildren("goal_pause", { cascade: true },
			{ role: "toolResult", toolCallId: "t1", toolName: "goal_pause", isError: false, content: [{ type: "text", text: JSON.stringify({ paused: 2 }) }], timestamp: 0 }, false);
		expect(container.textContent || "").toContain("Paused 2 goals");
		expect(container.textContent || "").toContain("cascade");

		renderChildren("goal_resume", {},
			{ role: "toolResult", toolCallId: "t1", toolName: "goal_resume", isError: false, content: [{ type: "text", text: JSON.stringify({ resumed: 1 }) }], timestamp: 0 }, false);
		expect(container.textContent || "").toContain("Resumed 1 goal");
	});

	it("goal_archive_child renders fallback count, child chip, cascade, and manual-merge badge", () => {
		renderChildren("goal_archive_child", { childGoalId: "goal-archive-1", cascade: true, mergedManually: true },
			{ role: "toolResult", toolCallId: "t1", toolName: "goal_archive_child", isError: false, content: [{ type: "text", text: "{}" }], timestamp: 0 }, false);
		expect(container.textContent || "").toContain("Archived 1 goal");
		expect(container.textContent || "").toContain("cascade");
		expect(container.textContent || "").toContain("merged manually");
	});
});

describe("feature flag off → falls through to DefaultRenderer", () => {
	it("goal_spawn_child keeps DefaultRenderer fallback payloads collapsed", () => {
		_setSubgoalsEnabledForTesting(false);
		renderChildren("goal_spawn_child",
			{ title: "T", planId: "p-1" },
			{ role: "toolResult", toolCallId: "t1", toolName: "goal_spawn_child",
				isError: false, content: [{ type: "text", text: JSON.stringify({ id: "g-1" }) }], timestamp: 0 },
			false);
		expect(container.textContent || "").toContain("Goal Spawn Child");
		const buttons = Array.from(qa("button"));
		expect(buttons.some((b) => /input/i.test(b.textContent || ""))).toBe(true);
		expect(buttons.some((b) => /output/i.test(b.textContent || ""))).toBe(true);
		expect(qa('[data-testid="children-spawn-title"]').length).toBe(0);
	});
});

describe("goal_set_policy", () => {
	it("renders policy row + concurrency bar", () => {
		renderChildren("goal_set_policy",
			{ divergencePolicy: "balanced", maxConcurrentChildren: 3 },
			{ role: "toolResult", toolCallId: "t1", toolName: "goal_set_policy",
				isError: false, content: [{ type: "text", text: "{}" }], timestamp: 0 },
			false);
		expect(q('[data-testid="children-policy-row"]')?.textContent || "").toContain("balanced");
		expect(q('[data-testid="children-concurrency-row"]')?.textContent || "").toContain("3");
	});
});

describe("goal_decide_mutation", () => {
	it("approved decision + applied response", () => {
		renderChildren("goal_decide_mutation",
			{ decision: "approve", requestId: "req-cccccccc" },
			{ role: "toolResult", toolCallId: "t1", toolName: "goal_decide_mutation",
				isError: false, content: [{ type: "text", text: JSON.stringify({ applied: true }) }], timestamp: 0 },
			false);
		expect(container.textContent || "").toContain("Approved");
		expect(container.textContent || "").toMatch(/Applied/);
	});
});

describe("goal_merge_child outcome pills", () => {
	it("conflict result shows conflict pill and expandable output", () => {
		renderChildren("goal_merge_child",
			{ childGoalId: "abc12345xyz" },
			{ role: "toolResult", toolCallId: "t1", toolName: "goal_merge_child",
				isError: false, content: [{ type: "text", text: JSON.stringify({ conflict: true, output: "CONFLICT (content)" }) }], timestamp: 0 },
			false);
		expect(q('[data-testid="children-merge-pill"]')?.textContent || "").toMatch(/conflict/);
	});

	it("plain success shows merged pill", () => {
		renderChildren("goal_merge_child",
			{ childGoalId: "abc12345xyz" },
			{ role: "toolResult", toolCallId: "t1", toolName: "goal_merge_child",
				isError: false, content: [{ type: "text", text: JSON.stringify({ ok: true }) }], timestamp: 0 },
			false);
		expect(q('[data-testid="children-merge-pill"]')?.textContent || "").toMatch(/merged/);
	});
});
