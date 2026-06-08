/**
 * Fixture entry pinning getSidebarData()'s treatment of staff-related sessions.
 *
 * Regression guard for: the ephemeral *staff-creation assistant* (a session
 * with `assistantType: "staff"` that is NOT a staff agent) used to be filtered
 * out of the Sessions bucket, making it invisible in the sidebar. Real
 * *staff-agent* sessions (in state.staffList) must still be excluded — they
 * render under the dedicated Staff header.
 */
import { getSidebarData, state, type GatewaySession } from "../../src/app/state.js";

const PROJECT_ID = "staff-assistant-fixture-project";

function makeSession(over: Partial<GatewaySession>): GatewaySession {
	return {
		id: "s",
		title: "session",
		cwd: "/tmp/staff-assistant-fixture",
		projectId: PROJECT_ID,
		status: "idle",
		createdAt: 1,
		lastActivity: 1,
		clientCount: 0,
		...over,
	} as GatewaySession;
}

function setup(): void {
	const staffAgentSessionId = "staff-agent-session";
	const sessions: GatewaySession[] = [
		// Plain ungrouped chat session.
		makeSession({ id: "plain-session", title: "Plain", createdAt: 1 }),
		// Staff-creation assistant (the wand) — must appear in the Sessions bucket.
		makeSession({ id: "staff-creation-assistant", title: "Staff Assistant", assistantType: "staff", createdAt: 2 }),
		// Goal/role/tool/project creation assistants — already visible; sanity anchor.
		makeSession({ id: "goal-creation-assistant", title: "Goal Assistant", assistantType: "goal", createdAt: 3 }),
		// Real staff-agent permanent session — must NOT appear (rendered under Staff header).
		makeSession({ id: staffAgentSessionId, title: "greeter", createdAt: 4 }),
	];

	Object.assign(state, {
		gatewaySessions: sessions,
		archivedSessions: [] as GatewaySession[],
		goals: [],
		projects: [],
		activeProjectId: PROJECT_ID,
		// One staff agent owns `staff-agent-session`.
		staffList: [{ id: "staff-1", name: "greeter", projectId: PROJECT_ID, state: "active", currentSessionId: staffAgentSessionId }],
	});
}

(window as any).__staffAssistantSidebar = {
	reset() {
		setup();
	},
	ungroupedIds(): string[] {
		setup();
		return getSidebarData().ungroupedSessions.map((s) => s.id);
	},
};
(window as any).__staffAssistantSidebarReady = true;
