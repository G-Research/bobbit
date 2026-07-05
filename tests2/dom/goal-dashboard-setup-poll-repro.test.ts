import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/goal-dashboard-setup-poll-repro.spec.ts (v2-dom tier).
// Reproduction test for the stale-worktree-status bug. The legacy fixture models
// goal-dashboard.ts's setup polling; with the fix in place the default
// loadDashboardData() path starts polling for "preparing" goals, so the banner
// auto-updates to ready without manual intervention. Recreated under happy-dom
// with real timers (element presence == visibility, render swaps innerHTML).
import { afterEach, describe, expect, it } from "vitest";

type Status = "preparing" | "ready" | "error";

function createModel() {
	const container = document.createElement("div");
	document.body.appendChild(container);

	const serverGoal = { setupStatus: "preparing" as Status, setupError: null as string | null };
	let currentGoal: { setupStatus: Status; setupError: string | null } | null = null;
	let refreshCount = 0;
	let setupPollTimer: ReturnType<typeof setInterval> | null = null;
	const fixEnabled = true;

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
		// The fix: the default load path polls when the goal is still preparing.
		if (fixEnabled && currentGoal.setupStatus === "preparing") startPoll();
	}

	loadDashboardData();

	return {
		container,
		stopAllPolling: stopPoll,
		setServerStatus: (status: Status, error?: string) => {
			serverGoal.setupStatus = status;
			serverGoal.setupError = error || null;
		},
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

it("dashboard auto-updates setup banner without manual intervention", async () => {
	model = createModel();
	const q = (sel: string) => model!.container.querySelector(sel);

	// Banner visible initially (goal is in "preparing" state).
	expect(q("#setup-banner")).toBeTruthy();

	// Simulate the server completing worktree setup.
	model.setServerStatus("ready");

	// The dashboard auto-detects the change within 5 seconds via the default poll.
	await waitFor(() => !!q("#ready-state"), 5000);
	expect(q("#ready-state")).toBeTruthy();
});
