/**
 * E2E test for team_prompt's relaxed membership check.
 *
 * Verifies:
 *  - Parent team-lead can `team_prompt` a DIRECT-child team-lead session.
 *  - Parent team-lead is REJECTED (403 NOT_TEAM_MEMBER_OR_DIRECT_CHILD)
 *    when targeting a grandchild's team-lead session.
 *  - Asymmetry preserved: `team_steer` against a direct-child team-lead
 *    still 403s (caller-team-only).
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, createGoal, deleteGoal, defaultProjectId, gitCwd } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

test.setTimeout(120_000);

interface AgentInfo {
	sessionId: string;
	role: string;
	status: string;
}

/**
 * Wait until a goal has a live `team-lead` session, and return its sessionId.
 * The team-lead is NOT in `listAgents()` (it's stored as `teamLeadSessionId`
 * on the team entry), so we look it up via the sessions index by
 * (teamGoalId, role).
 */
async function waitForTeamLead(goalId: string): Promise<string> {
	let leadId = "";
	await pollUntil(async () => {
		const r = await apiFetch(`/api/sessions`);
		if (r.status !== 200) return false;
		const data = await r.json() as { sessions: Array<{ id: string; role?: string; teamGoalId?: string; goalId?: string; status?: string }> };
		const lead = data.sessions.find(s =>
			s.role === "team-lead"
			&& (s.teamGoalId === goalId || s.goalId === goalId)
			&& s.status !== "terminated",
		);
		if (lead?.id) {
			leadId = lead.id;
			return true;
		}
		return false;
	}, { timeoutMs: 60_000, intervalMs: 200, label: `team-lead for ${goalId}` });
	return leadId;
}

/** Spawn a child via the spawn-child route, return the child goal id. */
async function spawnChild(parentId: string, planId: string, title: string): Promise<string> {
	const r = await apiFetch(`/api/goals/${parentId}/spawn-child`, {
		method: "POST",
		body: JSON.stringify({ planId, title, spec: `${title} spec` }),
	});
	expect(r.status).toBe(201);
	const data = await r.json();
	return data.id as string;
}

test.describe("team_prompt — direct-child team-lead relaxation", () => {
	let rootId = "";
	let childId = "";
	let grandchildId = "";
	let rootLead = "";
	let childLead = "";
	let grandchildLead = "";

	test.beforeAll(async () => {
		test.setTimeout(120_000);
		const projectId = await defaultProjectId();
		// Root needs a real git repo so spawn-child can derive child cwds.
		const root = await createGoal({
			title: "tp-direct-child-root",
			team: true,
			projectId,
			cwd: gitCwd(),
			worktree: true,
		});
		rootId = root.id;
		// Wait for root's worktree+team to be ready.
		await pollUntil(async () => {
			const r = await apiFetch(`/api/goals/${rootId}`);
			if (r.status !== 200) return false;
			const g = await r.json();
			return g.setupStatus === "ready" && !!g.repoPath;
		}, { timeoutMs: 60_000, intervalMs: 200, label: `root ${rootId} ready` });
		rootLead = await waitForTeamLead(rootId);

		// Direct child via spawn-child route — auto-starts the child's team.
		childId = await spawnChild(rootId, "p-child", "tp-direct-child-c");
		await pollUntil(async () => {
			const r = await apiFetch(`/api/goals/${childId}`);
			if (r.status !== 200) return false;
			const g = await r.json();
			return g.setupStatus === "ready" && !!g.repoPath;
		}, { timeoutMs: 60_000, intervalMs: 200, label: `child ${childId} ready` });
		childLead = await waitForTeamLead(childId);

		// Grandchild — child of the direct child.
		grandchildId = await spawnChild(childId, "p-grand", "tp-direct-child-g");
		grandchildLead = await waitForTeamLead(grandchildId);
	});

	test.afterAll(async () => {
		// Cascade-archive the root — server tears down all descendants.
		await deleteGoal(rootId, true);
	});

	test("Test A: parent → direct-child team-lead succeeds", async () => {
		const resp = await apiFetch(`/api/goals/${rootId}/team/prompt`, {
			method: "POST",
			body: JSON.stringify({ sessionId: childLead, message: "hello from parent" }),
		});
		expect(resp.status).toBe(200);
		const data = await resp.json();
		expect(data.ok).toBe(true);
		expect(["dispatched", "queued"]).toContain(data.status);
		// Sanity: the root team-lead exists (so scope is non-trivial).
		expect(rootLead).toBeTruthy();
	});

	test("Test B: parent → grandchild team-lead returns 403 NOT_TEAM_MEMBER_OR_DIRECT_CHILD", async () => {
		const resp = await apiFetch(`/api/goals/${rootId}/team/prompt`, {
			method: "POST",
			body: JSON.stringify({ sessionId: grandchildLead, message: "hi grandchild" }),
		});
		expect(resp.status).toBe(403);
		const data = await resp.json();
		expect(data.code).toBe("NOT_TEAM_MEMBER_OR_DIRECT_CHILD");
		expect(data.error).toContain("not a member");
	});

	test("Test C: asymmetry — team_steer against direct-child team-lead still 403", async () => {
		const resp = await apiFetch(`/api/goals/${rootId}/team/steer`, {
			method: "POST",
			body: JSON.stringify({ sessionId: childLead, message: "redirect" }),
		});
		expect(resp.status).toBe(403);
		const data = await resp.json();
		expect(data.error).toContain("not a member");
	});
});
