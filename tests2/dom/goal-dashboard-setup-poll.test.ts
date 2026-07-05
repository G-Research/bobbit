// Migrated from tests/goal-dashboard-setup-poll.spec.ts (v2-dom tier).
// The legacy Playwright fixture modelled goal-dashboard.ts's setup-status
// polling in plain JS (there is no cleanly-mountable real component). We recreate
// that same model under happy-dom and drive it with real timers, asserting the
// identical banner-transition and polling-lifecycle behaviours. Element presence
// == visibility here because the render swaps innerHTML wholesale.
import { afterEach, describe, expect, it } from "vitest";

type Status = "preparing" | "ready" | "error";

function createModel() {
	const container = document.createElement("div");
	document.body.appendChild(container);

	const serverGoal = { setupStatus: "preparing" as Status, setupError: null as string | null };
	let currentGoal: { setupStatus: Status; setupError: string | null } | null = null;
	let refreshCount = 0;
	let setupPollTimer: ReturnType<typeof setInterval> | null = null;
	let fixEnabled = true;

	function render() {
		if (!currentGoal) { container.innerHTML = "<p>No goal loaded</p>"; return; }
		if (currentGoal.setupStatus === "preparing") {
			container.innerHTML = `<div class="setup-banner" id="setup-banner"><span>Setting up worktree…</span></div>`;
		} else if (currentGoal.setupStatus === "error") {
			container.innerHTML = `<div class="setup-banner" id="setup-banner-error"><span>Worktree setup failed${currentGoal.setupError ? ": " + currentGoal.setupError : ""}</span></div>`;
		} else {
			container.innerHTML = `<div class="ready-state" id="ready-state">✓ Worktree ready</div>`;
		}
	}

	function refreshDashboardGoal() {
		refreshCount++;
		currentGoal = { ...serverGoal };
		render();
		if (setupPollTimer && currentGoal.setupStatus !== "preparing") stopPoll();
	}

	function startPoll() {
		if (setupPollTimer) return;
		setupPollTimer = setInterval(refreshDashboardGoal, 500);
	}

	function stopPoll() {
		if (setupPollTimer) { clearInterval(setupPollTimer); setupPollTimer = null; }
	}

	function loadDashboardData() {
		stopPoll();
		currentGoal = { ...serverGoal };
		refreshCount = 0;
		render();
		if (fixEnabled && currentGoal.setupStatus === "preparing") startPoll();
	}

	loadDashboardData();

	return {
		container,
		enableFix: () => { fixEnabled = true; },
		loadDashboardData,
		stopAllPolling: stopPoll,
		setServerStatus: (status: Status, error?: string) => {
			serverGoal.setupStatus = status;
			serverGoal.setupError = error || null;
		},
		getState: () => ({
			serverStatus: serverGoal.setupStatus,
			uiStatus: currentGoal ? currentGoal.setupStatus : null,
			refreshCount,
			isPolling: setupPollTimer !== null,
		}),
	};
}

function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(predicate: () => boolean, timeout = 5000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (predicate()) return;
		await delay(20);
	}
	throw new Error("waitFor timed out");
}

let model: ReturnType<typeof createModel> | null = null;
afterEach(() => { model?.stopAllPolling(); model = null; document.body.innerHTML = ""; });

describe("Goal dashboard setup status polling", () => {
	it("banner auto-updates when server status changes from preparing to ready", async () => {
		model = createModel();
		const q = (sel: string) => model!.container.querySelector(sel);

		expect(q("#setup-banner")).toBeTruthy();
		expect(q("#setup-banner")!.textContent).toContain("Setting up worktree");

		model.enableFix();
		model.loadDashboardData();
		expect(model.getState().isPolling).toBe(true);

		model.setServerStatus("ready");
		await waitFor(() => !!q("#ready-state"), 5000);
		expect(q("#setup-banner")).toBeNull();

		const state = model.getState();
		expect(state.uiStatus).toBe("ready");
		expect(state.isPolling).toBe(false);
		expect(state.refreshCount).toBeGreaterThan(0);
	});

	it("banner auto-updates to error state when polling detects failure", async () => {
		model = createModel();
		const q = (sel: string) => model!.container.querySelector(sel);

		expect(q("#setup-banner")!.textContent).toContain("Setting up worktree");

		model.enableFix();
		model.loadDashboardData();

		model.setServerStatus("error", "git worktree add failed");
		await waitFor(() => !!q("#setup-banner-error"), 5000);
		expect(q("#setup-banner-error")!.textContent).toContain("Worktree setup failed");

		const state = model.getState();
		expect(state.uiStatus).toBe("error");
		expect(state.isPolling).toBe(false);
	});

	it("no polling starts for goals already in ready state", async () => {
		model = createModel();
		const q = (sel: string) => model!.container.querySelector(sel);

		model.setServerStatus("ready");
		model.enableFix();
		model.loadDashboardData();

		expect(q("#ready-state")).toBeTruthy();

		const state = model.getState();
		expect(state.isPolling).toBe(false);

		const countBefore = state.refreshCount;
		await delay(800); // longer than one poll interval (500ms)
		expect(model.getState().refreshCount).toBe(countBefore);
	});

	it("cleanup stops polling when leaving dashboard", () => {
		model = createModel();

		model.enableFix();
		model.loadDashboardData();
		expect(model.getState().isPolling).toBe(true);

		model.stopAllPolling();
		expect(model.getState().isPolling).toBe(false);
	});
});
