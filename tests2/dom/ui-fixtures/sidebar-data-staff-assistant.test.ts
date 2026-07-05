import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/ui-fixtures/sidebar-data-staff-assistant.spec.ts (v2-dom tier).
// Pure-logic port: the legacy fixture bundled state.ts and exercised
// getSidebarData() directly (no rendering). We call the REAL getSidebarData()
// against seeded app state and assert the same ungrouped-session bucket facts.
import { afterEach, describe, expect, it } from "vitest";
import { getSidebarData, state, type GatewaySession } from "../../../src/app/state.js";

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
		// Goal creation assistant — already visible; sanity anchor.
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

afterEach(() => {
	Object.assign(state, {
		gatewaySessions: [],
		archivedSessions: [],
		goals: [],
		projects: [],
		staffList: [],
	});
});

describe("getSidebarData — staff-creation assistant visibility", () => {
	it("staff-creation assistant appears in Sessions bucket; staff-agent session does not", () => {
		setup();
		const ids = getSidebarData().ungroupedSessions.map((s) => s.id);

		// The ephemeral staff-creation assistant must be visible alongside the
		// goal assistant and plain sessions.
		expect(ids).toContain("staff-creation-assistant");
		expect(ids).toContain("goal-creation-assistant");
		expect(ids).toContain("plain-session");

		// The real staff-agent permanent session stays out of the Sessions bucket
		// (it renders under the dedicated Staff header).
		expect(ids).not.toContain("staff-agent-session");
	});
});
