import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../../tests/support/helpers/dom/setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTeam } from "../../src/app/api.js";
import { state, type GatewaySession, type Goal, type Project } from "../../src/app/state.js";
import "../../src/app/dialogs.js";
import "../../src/ui/components/ErrorDetails.js";
import "../../src/ui/lazy/safe-markdown-block.js";

const STACK = "GoalPausedError: paused-team-goal is paused — spawn rejected\n    at TeamManager._startTeamImpl (team-manager.ts:1874:27)";

function teamLead(): GatewaySession {
	return {
		id: "lead-1",
		title: "Paused goal team",
		cwd: "/tmp/paused-team-goal",
		status: "idle",
		createdAt: 1,
		lastActivity: 1,
		clientCount: 0,
		goalId: "paused-team-goal",
		teamGoalId: "paused-team-goal",
		role: "team-lead",
	};
}

function resumedGoal(): Goal {
	return {
		id: "paused-team-goal",
		title: "Paused team goal",
		cwd: "/tmp/paused-team-goal",
		state: "todo",
		spec: "Start after an explicit request resumes this goal.",
		createdAt: 1,
		updatedAt: 2,
		team: true,
		paused: false,
	};
}

function observeErrorDetails(): { promise: Promise<HTMLElement>; disconnect: () => void } {
	let observer: MutationObserver | undefined;
	const promise = new Promise<HTMLElement>((resolve) => {
		const find = () => document.querySelector<HTMLElement>('[data-testid="error-details-message"]');
		const resolveWhenPresent = () => {
			const details = find();
			if (!details) return;
			observer?.disconnect();
			resolve(details);
		};
		observer = new MutationObserver(resolveWhenPresent);
		observer.observe(document.body, { childList: true, subtree: true });
		resolveWhenPresent();
	});
	return { promise, disconnect: () => observer?.disconnect() };
}

beforeEach(() => {
	state.gatewaySessions = [];
	state.goals = [];
	state.projects = [];
	state.sessionsGeneration = 0;
	state.goalsGeneration = 0;
	state.sessionsError = "";
	state.sessionsLoading = false;
});

afterEach(() => {
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
});

describe("startTeam paused-goal client lifecycle", () => {
	it("refreshes the resumed goal and new team lead before returning the session", async () => {
		const requests: string[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			requests.push(url);
			if (url.includes("/api/goals/paused-team-goal/team/start")) {
				expect(init?.method).toBe("POST");
				return new Response(JSON.stringify({ sessionId: "lead-1" }), { status: 201 });
			}
			if (url.includes("/api/sessions?since=0")) {
				return new Response(JSON.stringify({ sessions: [teamLead()], generation: 1 }), { status: 200 });
			}
			if (url.includes("/api/goals?since=0")) {
				return new Response(JSON.stringify({ goals: [resumedGoal()], generation: 1 }), { status: 200 });
			}
			if (url.includes("/api/projects")) {
				return new Response(JSON.stringify({ projects: [] as Project[] }), { status: 200 });
			}
			throw new Error(`Unexpected request: ${url}`);
		});

		await expect(startTeam("paused-team-goal")).resolves.toBe("lead-1");
		expect(state.goals).toEqual([resumedGoal()]);
		expect(state.gatewaySessions).toEqual([teamLead()]);
		expect(state.goalsGeneration).toBe(1);
		expect(state.sessionsGeneration).toBe(1);
		expect(requests).toEqual(expect.arrayContaining([
			expect.stringContaining("/api/goals/paused-team-goal/team/start"),
			expect.stringContaining("/api/sessions?since=0"),
			expect.stringContaining("/api/goals?since=0"),
		]));
	});

	it.each([
		["GOAL_PAUSED", "The goal could not be resumed automatically. Resume it, then try starting the team again."],
		["NOT_TEAM_LEAD", "Only the goal's team lead or an authorized operator can resume and start this team."],
		["TEAM_DISABLED", "Enable team mode for this goal before starting a team."],
	])("shows actionable %s feedback without exposing a server stack trace and refreshes after failure", async (code, expectedMessage) => {
		const requests: string[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			requests.push(url);
			if (url.includes("/team/start")) {
				return new Response(JSON.stringify({ error: STACK, code, stack: STACK }), {
					status: 409, headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/api/sessions?since=0")) return new Response(JSON.stringify({ sessions: [], generation: 1 }));
			if (url.includes("/api/goals?since=0")) return new Response(JSON.stringify({ goals: [resumedGoal()], generation: 1 }));
			if (url.includes("/api/projects")) return new Response(JSON.stringify({ projects: [] }));
			throw new Error(`Unexpected request: ${url}`);
		});

		const errorDetails = observeErrorDetails();
		await expect(startTeam("paused-team-goal")).resolves.toBeNull();
		const message = await errorDetails.promise;
		errorDetails.disconnect();

		expect(message.textContent).toBe(expectedMessage);
		expect(document.querySelector('[data-testid="error-details-code"]')?.textContent).toBe(code);
		expect(document.querySelector('[data-testid="error-details-stack"]')).toBeNull();
		expect(document.body.textContent).not.toContain("GoalPausedError");
		expect(document.body.textContent).not.toContain("team-manager.ts");
		expect(state.goals).toEqual([resumedGoal()]);
		expect(requests).toEqual(expect.arrayContaining([
			expect.stringContaining("/api/sessions?since=0"),
			expect.stringContaining("/api/goals?since=0"),
		]));
	});
});
