/**
 * Unit tests for the `orient` tool's assembly logic (Finding W2.15).
 *
 * `buildOrientPayload` (src/server/agent/orient.ts) is a pure function — no
 * gateway, no filesystem, no session managers — so these tests exercise it
 * directly with hand-built inputs mirroring the live-session and
 * persisted-session shapes the server.ts route handler normalizes into
 * `OrientSessionInput` before calling it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildOrientPayload, ORIENT_API_ROUTE_FAMILIES, type OrientGatewayInput, type OrientSessionInput } from "../src/server/agent/orient.ts";

const GATEWAY: OrientGatewayInput = {
	version: "0.13.0",
	url: "https://127.0.0.1:3001",
	tokenPath: "/tmp/bobbit-test/.bobbit/state/token",
};

const MINIMAL_SESSION: OrientSessionInput = {
	id: "sess-1",
	title: "Untitled",
	status: "idle",
	cwd: "/repo",
};

describe("buildOrientPayload", () => {
	it("reports session/goal/project as null when the session has none of them", () => {
		const payload = buildOrientPayload({ gateway: GATEWAY, session: MINIMAL_SESSION, goal: null, project: null });
		assert.equal(payload.session.id, "sess-1");
		assert.equal(payload.session.goalId, null);
		assert.equal(payload.session.teamGoalId, null);
		assert.equal(payload.session.teamLeadSessionId, null);
		assert.equal(payload.session.worktreePath, null);
		assert.equal(payload.session.role, null);
		assert.equal(payload.goal, null);
		assert.equal(payload.project, null);
		assert.deepEqual(payload.session.runtime, {
			sandboxed: false,
			containerId: null,
			model: null,
			thinkingLevel: null,
		});
	});

	it("passes the gateway block and the curated route-family list through untouched", () => {
		const payload = buildOrientPayload({ gateway: GATEWAY, session: MINIMAL_SESSION, goal: null, project: null });
		assert.deepEqual(payload.gateway, GATEWAY);
		assert.equal(payload.apiRouteFamilies, ORIENT_API_ROUTE_FAMILIES);
		assert.ok(payload.apiRouteFamilies.length > 0, "expected at least one curated route family");
		for (const { family, example } of payload.apiRouteFamilies) {
			assert.match(example, /^(GET|POST|PUT|PATCH|DELETE) \/api\//, `${family} example should look like "METHOD /api/..."`);
		}
	});

	it("fills in a fully-populated live session (team member, sandboxed, goal-scoped)", () => {
		const session: OrientSessionInput = {
			id: "sess-2",
			title: "Implement thing",
			status: "streaming",
			cwd: "/repo/worktree",
			worktreePath: "/repo/worktree",
			role: "coder",
			assistantType: "goal",
			sandboxed: true,
			containerId: "container-abc",
			model: "anthropic/claude-sonnet-5",
			thinkingLevel: "high",
			readOnly: false,
			delegateOf: undefined,
			parentSessionId: undefined,
			childKind: undefined,
			projectId: "proj-1",
			goalId: "goal-1",
			teamGoalId: "goal-1",
			teamLeadSessionId: "sess-lead",
		};
		const payload = buildOrientPayload({
			gateway: GATEWAY,
			session,
			goal: {
				id: "goal-1",
				title: "Ship the thing",
				state: "in-progress",
				branch: "goal/ship-the-thing",
				team: true,
				teamLeadSessionId: "sess-lead",
				parentGoalId: undefined,
			},
			project: { id: "proj-1", name: "bobbit", rootPath: "/repo" },
		});

		assert.equal(payload.session.role, "coder");
		assert.equal(payload.session.goalId, "goal-1");
		assert.equal(payload.session.teamGoalId, "goal-1");
		assert.equal(payload.session.teamLeadSessionId, "sess-lead");
		assert.deepEqual(payload.session.runtime, {
			sandboxed: true,
			containerId: "container-abc",
			model: "anthropic/claude-sonnet-5",
			thinkingLevel: "high",
		});
		assert.deepEqual(payload.goal, {
			id: "goal-1",
			title: "Ship the thing",
			state: "in-progress",
			branch: "goal/ship-the-thing",
			team: true,
			teamLeadSessionId: "sess-lead",
			parentGoalId: null,
		});
		assert.deepEqual(payload.project, { id: "proj-1", name: "bobbit", rootPath: "/repo" });
	});

	it("normalizes a goal with no branch/team/parent to explicit nulls, not undefined", () => {
		const payload = buildOrientPayload({
			gateway: GATEWAY,
			session: { ...MINIMAL_SESSION, goalId: "goal-2" },
			goal: { id: "goal-2", title: "Solo goal", state: "todo" },
			project: null,
		});
		assert.deepEqual(payload.goal, {
			id: "goal-2",
			title: "Solo goal",
			state: "todo",
			branch: null,
			team: false,
			teamLeadSessionId: null,
			parentGoalId: null,
		});
	});

	it("is a pure function — same input produces a deep-equal result", () => {
		const input = {
			gateway: GATEWAY,
			session: { ...MINIMAL_SESSION, goalId: "goal-3", role: "reviewer" },
			goal: { id: "goal-3", title: "X", state: "todo", branch: "goal/x" },
			project: { id: "p", name: "p", rootPath: "/p" },
		};
		assert.deepEqual(buildOrientPayload(input), buildOrientPayload(input));
	});
});
