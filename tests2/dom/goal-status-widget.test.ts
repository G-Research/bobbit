// Migrated from tests/goal-status-widget.spec.ts (v2-dom tier).
// Renders the REAL <goal-status-widget> lit component under happy-dom, replacing
// the esbuild file:// bundle + window-exposed __mountGoalStatusWidget helper.
// The widget fetches gates + active verifications on connect (fetch stubbed) and
// opens a body-appended popover on pill click; we drive it the same way and pin
// the same DOM facts (pill badge/awaiting state, gate rows + statuses, running
// dot, sign-off card, and the review-document event the Start Review button
// dispatches).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GATE_STATUS_CLIENT_EVENT } from "../../src/app/gate-status-events.js";
import { syncCustomElements } from "./_setup/custom-elements.js";

// The custom-elements bridge keeps explicit registration deterministic. Import
// session-manager first to initialize the pack-panels ⇄ session-manager cycle
// before the widget's app/* imports hit it as a TDZ error.
let state: typeof import("../../src/app/state.js").state;

beforeAll(async () => {
	await import("../../src/app/session-manager.js");
	({ state } = await import("../../src/app/state.js"));
	await import("../../src/ui/components/GoalStatusWidget.js");
	await import("../../src/ui/lazy/safe-markdown-block.js");
	syncCustomElements();
	await customElements.whenDefined("goal-status-widget");
});

const GOAL_ID = "goal-widget-fixture";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class MockWebSocket extends EventTarget {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	static instances: MockWebSocket[] = [];
	readyState = MockWebSocket.OPEN;
	sent: string[] = [];
	constructor(public url: string) {
		super();
		MockWebSocket.instances.push(this);
		setTimeout(() => this.dispatchEvent(new Event("open")), 0);
	}
	send(data: string) { this.sent.push(data); }
	emitMessage(message: Record<string, unknown>) {
		this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
	}
	close() { this.readyState = MockWebSocket.CLOSED; this.dispatchEvent(new Event("close")); }
}

let gateRows: any[] = [];
let activeVerifications: any[] = [];
let signalsByGate = new Map<string, any[]>();
let signalFetchOverride: ((gateId: string) => Response | Promise<Response>) | undefined;
let openReviewEvents: any[] = [];
let goalStateFromServer = "in-progress";
let resetResponse: any = { ok: true };
let resetRequests: string[] = [];

function jsonResponse(body: any, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const onOpenReview = (event: Event) => { openReviewEvents.push((event as CustomEvent).detail); };

beforeEach(() => {
	gateRows = [];
	activeVerifications = [];
	signalsByGate = new Map();
	signalFetchOverride = undefined;
	openReviewEvents = [];
	goalStateFromServer = "in-progress";
	resetResponse = { ok: true };
	resetRequests = [];
	MockWebSocket.instances = [];
	vi.stubGlobal("WebSocket", MockWebSocket as any);
	vi.stubGlobal("fetch", async (url: any, init: any = {}) => {
		const textUrl = String(url);
		if (/\/gates\/[^/]+\/signals/.test(textUrl)) {
			const gateId = decodeURIComponent(textUrl.match(/\/gates\/([^/]+)\/signals/)?.[1] || "");
			if (signalFetchOverride) return signalFetchOverride(gateId);
			return jsonResponse({
				signals: signalsByGate.get(gateId) || [],
				goalTitle: "Server Goal Title",
				gateName: "Server Gate Name",
			});
		}
		if (textUrl.endsWith("/verifications/active")) return jsonResponse({ verifications: activeVerifications });
		if (textUrl.endsWith("/gates")) return jsonResponse({ gates: gateRows });
		if (/\/reset$/.test(textUrl)) {
			resetRequests.push(textUrl);
			gateRows = gateRows.map(gate => ({ ...gate, status: "pending", latestPassedSignalId: undefined }));
			return jsonResponse(resetResponse);
		}
		if (/\/bypass$/.test(textUrl)) return jsonResponse({ ok: true });
		if (/\/api\/goals(?:\?|$)/.test(textUrl)) {
			return jsonResponse({
				goals: [{ id: GOAL_ID, title: "Fixture Goal", state: goalStateFromServer, workflow: { gates: [] } }],
				generation: 1,
			});
		}
		if (/\/api\/sessions(?:\?|$)/.test(textUrl)) return jsonResponse({ changed: false });
		if (textUrl.endsWith("/api/projects")) return jsonResponse({ projects: [] });
		void init;
		return jsonResponse({ ok: true });
	});
	window.addEventListener("bobbit-open-review-document", onOpenReview);
});

afterEach(() => {
	window.removeEventListener("bobbit-open-review-document", onOpenReview);
	document.body.innerHTML = "";
	document.getElementById("goal-status-dropdown")?.remove();
	vi.unstubAllGlobals();
});

async function mountGoalStatusWidget(fixture: {
	goalId: string;
	gates: any[];
	verifications?: any[];
	signals?: Record<string, any[]>;
	cache?: { passed: number; total: number; bypassed?: number };
	goalState?: string;
}): Promise<HTMLElement> {
	openReviewEvents = [];
	gateRows = fixture.gates;
	activeVerifications = fixture.verifications || [];
	signalsByGate = new Map(Object.entries(fixture.signals || {}));
	state.gateStatusCache.clear();
	state.gatewaySessions = [] as any;
	state.sessionsGeneration = -1;
	state.goalsGeneration = -1;
	goalStateFromServer = fixture.goalState || "in-progress";
	state.goals = [{ id: fixture.goalId, title: "Fixture Goal", state: goalStateFromServer, workflow: { gates: [] } }] as any;
	if (fixture.cache) state.gateStatusCache.set(fixture.goalId, fixture.cache as any);

	await customElements.whenDefined("goal-status-widget");
	const container = document.createElement("div");
	document.body.appendChild(container);
	// Create the host imperatively so the fixture uses this file's custom-element registry,
	// not lit-html's cached template document from another isolate:false DOM file.
	const el = document.createElement("goal-status-widget") as any;
	el.goalId = fixture.goalId;
	el.token = "test-token";
	el.branch = "fixture/branch";
	container.appendChild(el);
	await el.updateComplete;
	await sleep(20);
	await el.updateComplete;
	return el as HTMLElement;
}

const dropdown = () => document.getElementById("goal-status-dropdown");

async function openDropdown(el: HTMLElement) {
	(el.querySelector('[data-testid="goal-status-widget-pill"]') as HTMLButtonElement).click();
	await (el as any).updateComplete;
	await sleep(0);
	await (el as any).updateComplete;
}

async function confirmGateReset(el: HTMLElement, gateId: string) {
	const row = dropdown()!.querySelector(`[data-testid="goal-widget-gate"][data-gate-id="${gateId}"]`)!;
	(row.querySelector('[data-testid="goal-widget-gate-reset"]') as HTMLButtonElement).click();
	let confirmButton: HTMLButtonElement | undefined;
	for (let i = 0; i < 50 && !confirmButton; i++) {
		await sleep(10);
		confirmButton = [...document.querySelectorAll<HTMLButtonElement>("button")]
			.find(button => button !== row.querySelector('[data-testid="goal-widget-gate-reset"]') && button.textContent?.trim() === "Reset");
	}
	expect(confirmButton, "reset confirmation button should render").toBeTruthy();
	confirmButton!.click();
	for (let i = 0; i < 50 && resetRequests.length === 0; i++) await sleep(10);
	await (el as any).updateComplete;
}

const gates = [
	{ gateId: "design-doc", name: "Design Document", status: "passed", latestPassedSignalId: "sig-pass" },
	{ gateId: "human-approval", name: "Human Approval", status: "pending" },
	{ gateId: "implementation", name: "Implementation", status: "failed" },
];

const verification = {
	signalId: "sig-human",
	gateId: "human-approval",
	overallStatus: "running",
	steps: [{
		name: "approve-design",
		type: "human-signoff",
		status: "running",
		awaitingHuman: true,
		humanLabel: "Approve design",
		humanPrompt: "Please approve **the design**.",
	}],
};

describe("GoalStatusWidget fixture", () => {
	it("renders compact gate progress, running sign-off state, and starts review from the popover", async () => {
		const el = await mountGoalStatusWidget({
			goalId: GOAL_ID,
			gates,
			verifications: [verification],
			cache: { passed: 1, total: 3 },
			signals: { "human-approval": [{ id: "sig-human", content: "## Design\n\nContent awaiting sign-off." }] },
		});

		const pill = el.querySelector('[data-testid="goal-status-widget-pill"]') as HTMLElement;
		expect(pill).toBeTruthy();
		expect(pill.getAttribute("data-awaiting-signoffs")).toBe("true");
		expect((pill.textContent || "").replace(/\s+/g, "")).toContain("(1/3)");
		expect(el.querySelector('[data-testid="goal-status-widget-awaiting"]')).toBeTruthy();

		await openDropdown(el);
		const dd = dropdown()!;
		expect(dd).toBeTruthy();
		expect(dd.querySelectorAll('[data-testid="goal-widget-gate"]').length).toBe(3);
		expect(dd.querySelector('[data-testid="goal-widget-gate"][data-gate-id="design-doc"]')?.getAttribute("data-gate-status")).toBe("passed");
		expect(dd.querySelector('[data-testid="goal-widget-gate"][data-gate-id="human-approval"]')?.getAttribute("data-gate-status")).toBe("running");
		expect(dd.querySelector('[data-testid="goal-widget-gate-running-dot"]')).toBeTruthy();
		expect(dd.querySelector('[data-testid="goal-widget-signoff"]')?.textContent).toContain("Approve design");
		expect(dd.querySelectorAll('[data-testid="goal-widget-signoff-content"]').length).toBe(0);

		(dd.querySelector('[data-testid="goal-widget-signoff-content-toggle"]') as HTMLButtonElement).click();
		for (let i = 0; i < 50 && openReviewEvents.length === 0; i++) await sleep(10);
		expect(openReviewEvents.length).toBe(1);
		const event = openReviewEvents[0];
		expect(event.title).toContain("Sign-off: fixture/branch / Human Approval / Approve design");
		expect(event.markdown).toContain("Content awaiting sign-off");
		expect(event.source).toMatchObject({
			kind: "verification-signoff-markdown",
			goalId: GOAL_ID,
			gateId: "human-approval",
			signalId: "sig-human",
			stepName: "approve-design",
			goalTitle: "fixture/branch",
			gateName: "Human Approval",
			stepLabel: "Approve design",
		});
	});

	it("shows launcher loading and a compact retryable error without duplicate launches", async () => {
		const el = await mountGoalStatusWidget({
			goalId: GOAL_ID,
			gates,
			verifications: [verification],
			cache: { passed: 1, total: 3 },
		});
		await openDropdown(el);

		let resolveSignals!: (response: Response) => void;
		signalFetchOverride = () => new Promise<Response>(resolve => { resolveSignals = resolve; });
		const dd = dropdown()!;
		(dd.querySelector('[data-testid="goal-widget-signoff-content-toggle"]') as HTMLButtonElement).click();
		await sleep(0);
		const loadingButton = dd.querySelector('[data-testid="goal-widget-signoff-content-toggle"]') as HTMLButtonElement;
		expect(loadingButton.disabled).toBe(true);
		expect(loadingButton.getAttribute("aria-busy")).toBe("true");
		expect(loadingButton.textContent).toContain("Opening…");
		loadingButton.click();
		resolveSignals(jsonResponse({ signals: [] }));

		for (let i = 0; i < 50 && !dd.querySelector('[role="alert"]'); i++) await sleep(10);
		expect(openReviewEvents).toHaveLength(0);
		expect(dd.querySelector('[data-testid="goal-widget-signoff-content-error"]')?.textContent).toBe("Couldn’t open review. Try again.");

		signalFetchOverride = undefined;
		signalsByGate.set("human-approval", [{ id: "sig-human", content: "Ready on retry" }]);
		(dd.querySelector('[data-testid="goal-widget-signoff-content-toggle"]') as HTMLButtonElement).click();
		for (let i = 0; i < 50 && openReviewEvents.length === 0; i++) await sleep(10);
		expect(openReviewEvents).toHaveLength(1);
		expect(openReviewEvents[0].markdown).toBe("Ready on retry");
		expect(dd.querySelector('[data-testid="goal-widget-signoff-content-error"]')).toBeNull();
	});

	it("uses the empty-content and duplicate-title conventions from the shared launcher", async () => {
		const duplicate = {
			...verification,
			signalId: "sig-human-second",
			steps: [{ ...verification.steps[0] }],
		};
		const el = await mountGoalStatusWidget({
			goalId: GOAL_ID,
			gates,
			verifications: [verification, duplicate],
			cache: { passed: 1, total: 3 },
			signals: {
				"human-approval": [
					{ id: "sig-human", content: "   " },
					{ id: "sig-human-second", content: "Other content" },
				],
			},
		});
		await openDropdown(el);
		const button = dropdown()!.querySelector('[data-signal-id="sig-human"] [data-testid="goal-widget-signoff-content-toggle"]') as HTMLButtonElement;
		button.click();
		for (let i = 0; i < 50 && openReviewEvents.length === 0; i++) await sleep(10);
		expect(openReviewEvents[0].title).toBe("Sign-off: fixture/branch / Human Approval / Approve design (sig-huma)");
		expect(openReviewEvents[0].markdown).toBe("No content was attached to this sign-off signal.");
	});

	it("hides a mounted launcher immediately when its verification step completes", async () => {
		const el = await mountGoalStatusWidget({
			goalId: GOAL_ID,
			gates,
			verifications: [verification],
			cache: { passed: 1, total: 3 },
		});
		await openDropdown(el);
		const dd = dropdown()!;
		expect(dd.querySelector('[data-testid="goal-widget-signoff-content-toggle"]')).toBeTruthy();

		window.dispatchEvent(new CustomEvent(GATE_STATUS_CLIENT_EVENT, { detail: {
			type: "gate_verification_step_complete",
			goalId: GOAL_ID,
			gateId: "human-approval",
			signalId: "sig-human",
			stepName: "approve-design",
		} }));
		await sleep(20);
		expect(dd.querySelector('[data-testid="goal-widget-signoff-content-toggle"]')).toBeNull();
	});

	it("passed, failed, bypassed, and completed states expose the right lightweight actions", async () => {
		const el = await mountGoalStatusWidget({
			goalId: GOAL_ID,
			gates: [
				{ gateId: "design-doc", name: "Design Document", status: "passed", latestPassedSignalId: "sig-pass" },
				{ gateId: "qa", name: "QA", status: "failed" },
				{ gateId: "risk", name: "Risk Review", status: "bypassed", whyBypassed: "Emergency fix", whoAmI: "Lead" },
			],
			cache: { passed: 1, total: 3, bypassed: 1 },
			goalState: "complete",
		});

		await openDropdown(el);
		const dd = dropdown()!;
		expect(dd.querySelector('[data-testid="goal-widget-completed"]')?.textContent).toContain("Completed");
		expect(dd.querySelector('[data-testid="goal-widget-gate"][data-gate-id="design-doc"] [data-testid="goal-widget-gate-view"]')).toBeTruthy();
		expect(dd.querySelector('[data-testid="goal-widget-gate"][data-gate-id="design-doc"] [data-testid="goal-widget-gate-reset"]')).toBeTruthy();
		expect(dd.querySelector('[data-testid="goal-widget-gate"][data-gate-id="qa"] [data-testid="goal-widget-gate-bypass"]')).toBeTruthy();
		expect(dd.querySelector('[data-testid="goal-widget-gate"][data-gate-id="risk"]')?.getAttribute("data-gate-status")).toBe("bypassed");
		expect(dd.querySelector('[data-testid="goal-widget-gate-bypass-info"]')?.textContent).toContain("Emergency fix");
	});

	it("tracks completion from an authoritative app goal refresh after mounting in-progress", async () => {
		const el = await mountGoalStatusWidget({
			goalId: GOAL_ID,
			gates: [
				{ gateId: "design-doc", name: "Design Document", status: "passed", latestPassedSignalId: "sig-pass" },
				{ gateId: "risk", name: "Risk Review", status: "bypassed", whyBypassed: "Accepted risk", whoAmI: "Lead" },
			],
			cache: { passed: 1, total: 2, bypassed: 1 },
			goalState: "in-progress",
		});
		await openDropdown(el);
		expect(dropdown()!.querySelector('[data-testid="goal-widget-confirm-completion"]')).toBeTruthy();
		expect(dropdown()!.querySelector('[data-testid="goal-widget-completed"]')).toBeNull();

		// Mirrors refreshSessions replacing the authoritative goal list after
		// team_complete runs in another agent/tab.
		state.goals = state.goals.map(goal => goal.id === GOAL_ID ? { ...goal, state: "complete" } : goal) as any;
		for (let i = 0; i < 50 && !dropdown()!.querySelector('[data-testid="goal-widget-completed"]'); i++) await sleep(10);

		expect((el as any)._goalState).toBe("complete");
		expect(dropdown()!.querySelector('[data-testid="goal-widget-completed"]')?.textContent).toContain("Completed");
		expect(dropdown()!.querySelector('[data-testid="goal-widget-confirm-completion"]')).toBeNull();
	});

	it("resetting a completed goal clears the completed state and shows the pending gate immediately", async () => {
		resetResponse = {
			ok: true,
			affectedGateIds: ["design-doc"],
			changedGateIds: ["design-doc"],
			unchangedGateIds: [],
			reopen: { reopened: true, previousState: "complete", state: "in-progress" },
		};
		const el = await mountGoalStatusWidget({
			goalId: GOAL_ID,
			gates: [{ gateId: "design-doc", name: "Design Document", status: "passed", latestPassedSignalId: "sig-pass" }],
			cache: { passed: 1, total: 1 },
			goalState: "complete",
		});
		await openDropdown(el);
		expect(dropdown()!.querySelector('[data-testid="goal-widget-completed"]')).toBeTruthy();

		goalStateFromServer = "in-progress";
		await confirmGateReset(el, "design-doc");
		for (let i = 0; i < 50 && state.goals.find(goal => goal.id === GOAL_ID)?.state !== "in-progress"; i++) await sleep(10);

		expect(resetRequests).toHaveLength(1);
		expect(state.goals.find(goal => goal.id === GOAL_ID)?.state).toBe("in-progress");
		expect((el as any)._goalState).toBe("in-progress");
		expect(dropdown()!.querySelector('[data-testid="goal-widget-completed"]')).toBeNull();
		expect(dropdown()!.querySelector('[data-testid="goal-widget-gate"][data-gate-id="design-doc"]')?.getAttribute("data-gate-status")).toBe("pending");
	});

	it("reconciles a completed widget when another tab broadcasts goal_state_changed", async () => {
		const el = await mountGoalStatusWidget({
			goalId: GOAL_ID,
			gates: [{ gateId: "design-doc", name: "Design Document", status: "passed", latestPassedSignalId: "sig-pass" }],
			cache: { passed: 1, total: 1 },
			goalState: "complete",
		});
		await openDropdown(el);
		expect(dropdown()!.querySelector('[data-testid="goal-widget-completed"]')).toBeTruthy();

		goalStateFromServer = "in-progress";
		gateRows = [{ gateId: "design-doc", name: "Design Document", status: "pending" }];
		MockWebSocket.instances.at(-1)!.emitMessage({ type: "goal_state_changed", goalId: GOAL_ID });
		for (let i = 0; i < 50 && dropdown()!.querySelector('[data-testid="goal-widget-completed"]'); i++) await sleep(10);

		expect(state.goals.find(goal => goal.id === GOAL_ID)?.state).toBe("in-progress");
		expect((el as any)._goalState).toBe("in-progress");
		expect(dropdown()!.querySelector('[data-testid="goal-widget-completed"]')).toBeNull();
		expect(dropdown()!.querySelector('[data-testid="goal-widget-gate"][data-gate-id="design-doc"]')?.getAttribute("data-gate-status")).toBe("pending");
	});
});
