// Test entry — drives the REAL `createVisibilityAwarePoller` / `hasPollDiff`
// (src/app/visibility-poller.ts) added for PERF-04. Loaded under a file://
// fixture so `document.visibilityState` / `visibilitychange` are real DOM
// primitives rather than a jsdom-less reproduction.
import { createVisibilityAwarePoller, hasPollDiff, type VisibilityAwarePoller } from "../../src/app/visibility-poller.js";

// ── Scenario 1: bare tick counter — proves the pause/immediate-fire contract
// itself, independent of any render/diff concern. ──
let basicPoller: VisibilityAwarePoller | null = null;
let tickCount = 0;

(window as any).__startBasicPoller = (intervalMs: number) => {
	tickCount = 0;
	basicPoller = createVisibilityAwarePoller(() => {
		tickCount++;
	}, intervalMs);
};

(window as any).__stopBasicPoller = () => {
	basicPoller?.stop();
	basicPoller = null;
};

(window as any).__getTickCount = () => tickCount;

// ── Scenario 2: diff-before-render — mirrors goal-dashboard.ts's agentPoll
// fix: fetch, diff via the real `hasPollDiff`, only bump a render counter when
// the payload actually changed. ──
let diffPoller: VisibilityAwarePoller | null = null;
let renderCount = 0;
let fakeAgents: Array<{ id: string }> = [{ id: "a1" }];
let lastApplied: Array<{ id: string }> = [];

(window as any).__startDiffPoller = (intervalMs: number) => {
	renderCount = 0;
	lastApplied = fakeAgents;
	renderCount++; // initial mount render, mirrors startAgentPolling's immediate fetchAgents().then(render)
	diffPoller = createVisibilityAwarePoller(() => {
		const next = fakeAgents;
		if (hasPollDiff(lastApplied, next)) {
			lastApplied = next;
			renderCount++;
		}
	}, intervalMs);
};

(window as any).__stopDiffPoller = () => {
	diffPoller?.stop();
	diffPoller = null;
};

(window as any).__setFakeAgents = (v: Array<{ id: string }>) => {
	fakeAgents = v;
};

(window as any).__getRenderCount = () => renderCount;

(window as any).__ready = true;
