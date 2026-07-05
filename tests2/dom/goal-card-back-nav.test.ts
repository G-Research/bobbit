// Migrated from tests/goal-card-back-nav.spec.ts (v2-dom tier).
// The legacy Playwright fixture was a self-contained hash-router replica of the
// mobile goal-card navigation design. We rebuild that same DOM + routing logic
// under happy-dom and drive real hash navigation + window.history.back()
// (happy-dom fires hashchange on hash set and popstate+hashchange on back), so
// the same "no goal-dashboard entry leaks into history" behaviours hold.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const BODY_HTML = `
<div id="view-landing" class="view active">
  <div class="goal-card" id="goal-card-1">
    <div class="goal-header" id="goal-header-1" data-goal-id="goal-1">
      <span class="chevron" id="chevron-1">▸</span>
      <span class="goal-title">Test Goal Alpha</span>
    </div>
    <div class="goal-body hidden" id="goal-body-1">
      <button class="dashboard-btn" id="dashboard-btn-1">Dashboard</button>
      <div class="session-card" id="session-card-tl" data-session-id="session-tl-1">Team Lead</div>
      <div class="session-card" id="session-card-c1" data-session-id="session-c1">Coder</div>
    </div>
  </div>
  <div class="goal-card" id="goal-card-2">
    <div class="goal-header" id="goal-header-2" data-goal-id="goal-2">
      <span class="chevron" id="chevron-2">▸</span>
      <span class="goal-title">Test Goal Beta</span>
    </div>
    <div class="goal-body hidden" id="goal-body-2">
      <button class="dashboard-btn" id="dashboard-btn-2">Dashboard</button>
    </div>
  </div>
</div>
<div id="view-goal-dashboard" class="view">
  <h2 id="dashboard-title">Goal Dashboard</h2>
  <div class="session-card" id="dashboard-session-tl" data-session-id="session-tl-1">Team Lead</div>
</div>
<div id="view-session" class="view">
  <p>Connected to session <span id="connected-session-id"></span></p>
</div>
`;

let cleanup: (() => void) | null = null;

function setup() {
	document.body.innerHTML = BODY_HTML;
	window.location.hash = "#/";

	function getRouteFromHash() {
		const hash = window.location.hash || "";
		const sessionMatch = hash.match(/^#\/session\/([a-z0-9-]+)$/i);
		if (sessionMatch) return { view: "session", sessionId: sessionMatch[1] } as const;
		const goalMatch = hash.match(/^#\/goal\/([a-z0-9-]+)$/i);
		if (goalMatch) return { view: "goal-dashboard", goalId: goalMatch[1] } as const;
		return { view: "landing" } as const;
	}

	function setHashRoute(view: string, id?: string, replace?: boolean) {
		let newHash: string;
		if (view === "session" && id) newHash = "#/session/" + id;
		else if (view === "goal-dashboard" && id) newHash = "#/goal/" + id;
		else newHash = "#/";
		if (window.location.hash !== newHash) {
			if (replace) {
				history.replaceState({}, "", newHash);
				window.dispatchEvent(new Event("hashchange"));
			} else {
				window.location.hash = newHash;
			}
		}
	}

	let connectedSessionId: string | null = null;
	let connectingSessionId: string | null = null;

	function showView(viewName: string) {
		document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
		document.getElementById("view-" + viewName)?.classList.add("active");
	}

	function handleHashChange() {
		const route = getRouteFromHash();
		if (route.view === "session" && route.sessionId) {
			connectedSessionId = route.sessionId;
			document.getElementById("connected-session-id")!.textContent = route.sessionId;
			showView("session");
		} else if (route.view === "goal-dashboard" && route.goalId) {
			connectedSessionId = null;
			document.getElementById("dashboard-title")!.textContent = "Goal Dashboard: " + route.goalId;
			showView("goal-dashboard");
		} else {
			connectedSessionId = null;
			showView("landing");
		}
	}

	window.addEventListener("hashchange", handleHashChange);

	async function connectToSession(sessionId: string) {
		if (connectingSessionId) return;
		connectingSessionId = sessionId;
		const startingRoute = getRouteFromHash();
		await new Promise((r) => setTimeout(r, 50));
		connectedSessionId = sessionId;
		connectingSessionId = null;
		const currentRoute = getRouteFromHash();
		const replaceHistory = startingRoute.view === "goal-dashboard" || currentRoute.view === "goal-dashboard";
		setHashRoute("session", sessionId, replaceHistory);
	}

	const expandedGoals = new Set<string>();
	document.querySelectorAll(".goal-header").forEach((header) => {
		header.addEventListener("click", () => {
			const goalId = (header as HTMLElement).dataset.goalId!;
			const n = goalId.split("-")[1];
			const body = document.getElementById("goal-body-" + n)!;
			const chevron = document.getElementById("chevron-" + n)!;
			if (expandedGoals.has(goalId)) {
				expandedGoals.delete(goalId);
				body.classList.add("hidden");
				chevron.textContent = "▸";
			} else {
				expandedGoals.add(goalId);
				body.classList.remove("hidden");
				chevron.textContent = "▾";
			}
		});
	});

	document.querySelectorAll(".dashboard-btn").forEach((btn) => {
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			const goalId = (btn.closest(".goal-card")!.querySelector(".goal-header") as HTMLElement).dataset.goalId!;
			setHashRoute("goal-dashboard", goalId);
		});
	});

	document.querySelectorAll(".session-card").forEach((card) => {
		card.addEventListener("click", () => connectToSession((card as HTMLElement).dataset.sessionId!));
	});

	cleanup = () => window.removeEventListener("hashchange", handleHashChange);
}

function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(predicate: () => boolean, timeout = 3000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (predicate()) return;
		await delay(10);
	}
	throw new Error("waitFor timed out");
}

const hasClass = (id: string, cls: string) => document.getElementById(id)!.classList.contains(cls);
const click = (id: string) => (document.getElementById(id) as HTMLElement).click();

beforeEach(() => setup());
afterEach(() => { cleanup?.(); cleanup = null; document.body.innerHTML = ""; });

describe("Goal card back navigation", () => {
	it("clicking goal card header expands/collapses — does NOT navigate to dashboard", () => {
		expect(hasClass("view-landing", "active")).toBe(true);
		expect(hasClass("goal-body-1", "hidden")).toBe(true);

		click("goal-header-1");
		expect(hasClass("goal-body-1", "hidden")).toBe(false);
		expect(window.location.hash).toBe("#/");
		expect(hasClass("view-landing", "active")).toBe(true);

		click("goal-header-1");
		expect(hasClass("goal-body-1", "hidden")).toBe(true);
		expect(window.location.hash).toBe("#/");
	});

	it("clicking session inside expanded goal card — navigates directly, browser back goes to landing", async () => {
		click("goal-header-1");
		expect(hasClass("goal-body-1", "hidden")).toBe(false);

		click("session-card-tl");
		// happy-dom dispatches hashchange asynchronously, so wait on the view.
		await waitFor(() => hasClass("view-session", "active"));

		window.history.back();
		await waitFor(() => hasClass("view-landing", "active"));
		expect(window.location.hash).toBe("#/");
		expect(window.location.hash).not.toContain("/goal/");
	});

	it("explicit dashboard button navigates to dashboard, session from there — back goes to landing", async () => {
		click("goal-header-1");
		click("dashboard-btn-1");
		await waitFor(() => hasClass("view-goal-dashboard", "active"));

		click("dashboard-session-tl");
		await waitFor(() => hasClass("view-session", "active"));

		window.history.back();
		await waitFor(() => hasClass("view-landing", "active"));
		expect(window.location.hash).toBe("#/");
		expect(window.location.hash).not.toContain("/goal/");
	});

	it("no goal-dashboard hash ever enters history when clicking sessions from landing", async () => {
		const hashHistory: string[] = [];
		window.addEventListener("hashchange", () => hashHistory.push(window.location.hash));

		click("goal-header-1");
		click("session-card-tl");
		await waitFor(() => hasClass("view-session", "active"));

		const goalDashboardEntries = hashHistory.filter((h) => h.includes("/goal/"));
		expect(goalDashboardEntries).toHaveLength(0);
	});
});
