import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/mobile-archived.spec.ts (v2-dom tier).
//
// The legacy spec ran the fixture at a 375x667 viewport, but the archived-section
// rendering logic is pure DOM (class toggling + filtering) and does not read any
// geometry (no getBoundingClientRect/visualViewport/matchMedia) — so it ports to
// happy-dom faithfully. We reproduce the fixture's mock state + renderMobileLanding
// and assert the same classes, counts, attributes and header text.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function setup() {
	document.body.innerHTML = `
		<div id="main-goals"></div>
		<div id="archived-goals-section" class="hidden"></div>
		<div id="archived-sessions-section" class="hidden"></div>`;

	const mockState = {
		goals: [
			{ id: "g1", title: "Live Goal 1", state: "in-progress", archived: false },
			{ id: "g2", title: "Live Goal 2", state: "todo", archived: false },
			{ id: "g3", title: "Archived Goal 1", state: "complete", archived: true },
		],
		archivedSessions: [
			{ id: "s1", title: "Standalone archived", teamGoalId: null as string | null, delegateOf: null as string | null },
			{ id: "s2", title: "Goal-linked archived", teamGoalId: "g3", delegateOf: null as string | null },
			{ id: "s3", title: "Delegate archived", teamGoalId: null as string | null, delegateOf: "s1" },
		],
		showArchived: false,
	};

	function renderMobileLanding() {
		const sortedGoals = [...mockState.goals];
		const liveGoals = sortedGoals.filter((g) => !g.archived);
		const archivedGoals = sortedGoals.filter((g) => g.archived);

		const mainEl = document.getElementById("main-goals")!;
		mainEl.innerHTML = liveGoals
			.map((g) => `<div class="goal-item" data-goal-id="${g.id}" data-archived="false">${g.title}</div>`)
			.join("");

		const archivedGoalsEl = document.getElementById("archived-goals-section")!;
		if (mockState.showArchived && archivedGoals.length > 0) {
			archivedGoalsEl.classList.remove("hidden");
			archivedGoalsEl.innerHTML =
				`<div class="section-header">Archived Goals</div>` +
				archivedGoals
					.map((g) => `<div class="goal-item opacity-60" data-goal-id="${g.id}" data-archived="true">${g.title}</div>`)
					.join("");
		} else {
			archivedGoalsEl.classList.add("hidden");
			archivedGoalsEl.innerHTML = "";
		}

		const archivedSessionsEl = document.getElementById("archived-sessions-section")!;
		const standaloneArchived = mockState.showArchived
			? mockState.archivedSessions.filter((s) => !s.teamGoalId && !s.delegateOf)
			: [];
		if (standaloneArchived.length > 0) {
			archivedSessionsEl.classList.remove("hidden");
			archivedSessionsEl.innerHTML =
				`<div class="section-header">Archived</div>` +
				standaloneArchived
					.map((s) => `<div class="archived-session" data-session-id="${s.id}">${s.title}</div>`)
					.join("");
		} else {
			archivedSessionsEl.classList.add("hidden");
			archivedSessionsEl.innerHTML = "";
		}
	}

	function setShowArchived(val: boolean) {
		mockState.showArchived = val;
		renderMobileLanding();
	}

	renderMobileLanding();
	return { setShowArchived };
}

let h: ReturnType<typeof setup>;
const $ = (sel: string) => document.querySelector(sel)!;
const $$ = (sel: string) => Array.from(document.querySelectorAll(sel));

beforeEach(() => {
	h = setup();
});
afterEach(() => {
	document.body.innerHTML = "";
});

describe("Mobile archived sections", () => {
	it("only live goals appear in main list", () => {
		const mainGoals = $$("#main-goals .goal-item");
		expect(mainGoals).toHaveLength(2);
		for (const goal of mainGoals) {
			expect(goal.getAttribute("data-archived")).toBe("false");
		}
	});

	it("archived sections hidden when showArchived is false", () => {
		expect($("#archived-goals-section").classList.contains("hidden")).toBe(true);
		expect($("#archived-sessions-section").classList.contains("hidden")).toBe(true);
	});

	it("archived goals section appears when showArchived is true", () => {
		h.setShowArchived(true);
		const section = $("#archived-goals-section");
		expect(section.classList.contains("hidden")).toBe(false);
		expect(section.querySelector(".section-header")!.textContent).toBe("Archived Goals");

		const archivedGoals = section.querySelectorAll(".goal-item");
		expect(archivedGoals).toHaveLength(1);
		expect(archivedGoals[0].classList.contains("opacity-60")).toBe(true);
		expect(archivedGoals[0].getAttribute("data-archived")).toBe("true");
	});

	it("archived goals do NOT appear in main list when showArchived is true", () => {
		h.setShowArchived(true);
		const mainGoals = $$("#main-goals .goal-item");
		expect(mainGoals).toHaveLength(2);
		for (const goal of mainGoals) {
			expect(goal.getAttribute("data-archived")).toBe("false");
		}
	});

	it("standalone archived sessions section appears when showArchived is true", () => {
		h.setShowArchived(true);
		const section = $("#archived-sessions-section");
		expect(section.classList.contains("hidden")).toBe(false);
		expect(section.querySelector(".section-header")!.textContent).toBe("Archived");

		const sessions = section.querySelectorAll(".archived-session");
		expect(sessions).toHaveLength(1);
		expect(sessions[0].getAttribute("data-session-id")).toBe("s1");
	});

	it("toggling showArchived off hides both sections", () => {
		h.setShowArchived(true);
		expect($("#archived-goals-section").classList.contains("hidden")).toBe(false);
		expect($("#archived-sessions-section").classList.contains("hidden")).toBe(false);

		h.setShowArchived(false);
		expect($("#archived-goals-section").classList.contains("hidden")).toBe(true);
		expect($("#archived-sessions-section").classList.contains("hidden")).toBe(true);
	});
});
