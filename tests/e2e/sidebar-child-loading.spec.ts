/**
 * Reproducing tests for sidebar child auto-loading bugs.
 *
 * Gap 1: GET /api/goals?archived=true returns goals but no affiliated sessions.
 *        Expanding an archived goal in the sidebar shows zero children.
 *
 * Gap 2: GET /api/sessions (normal path) only BFS-enriches archived delegates
 *        via `delegateOf` chains. Archived team members (sessions with
 *        `teamLeadSessionId` set but no `delegateOf`) are never included
 *        in `archivedDelegates`.
 *
 * Both tests are expected to FAIL against the current (unfixed) codebase.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, createSession, createGoal, deleteGoal, nonGitCwd } from "./e2e-setup.js";

/** Terminate (archive) a session via DELETE. */
async function terminateSession(id: string): Promise<void> {
	const resp = await apiFetch(`/api/sessions/${id}`, { method: "DELETE" });
	expect(resp.ok, `Failed to terminate session ${id}: ${resp.status}`).toBe(true);
}

// ---------------------------------------------------------------------------
// Gap 2: Team member enrichment missing
// GET /api/sessions archivedDelegates does not include archived team members
// ---------------------------------------------------------------------------

test("archivedDelegates includes archived team members with teamLeadSessionId", async () => {
	// 1. Create a live "team lead" session
	const leadId = await createSession();

	// 2. Create a "team member" session
	const memberId = await createSession();

	// 3. PATCH the member to set teamLeadSessionId pointing to the lead
	const patchResp = await apiFetch(`/api/sessions/${memberId}`, {
		method: "PATCH",
		body: JSON.stringify({ teamLeadSessionId: leadId }),
	});
	expect(patchResp.ok, `Failed to PATCH teamLeadSessionId: ${patchResp.status}`).toBe(true);

	// 4. Terminate (archive) the team member
	await terminateSession(memberId);

	// 5. Fetch normal sessions — lead is still live, member is archived
	const resp = await apiFetch("/api/sessions");
	expect(resp.status).toBe(200);
	const body = await resp.json();

	// The lead should be in the live sessions list
	const liveIds = (body.sessions as any[]).map((s: any) => s.id);
	expect(liveIds, "Expected live sessions to include the team lead").toContain(leadId);

	// 6. archivedDelegates SHOULD include the archived team member
	//    BUG: Currently BFS only walks `delegateOf` chains, so team members
	//    with `teamLeadSessionId` (but no `delegateOf`) are never enriched.
	expect(
		body.archivedDelegates,
		"Expected archivedDelegates field to exist",
	).toBeDefined();

	const enrichedIds = (body.archivedDelegates as any[]).map((s: any) => s.id);
	expect(
		enrichedIds,
		"Expected archivedDelegates to include archived team member with teamLeadSessionId",
	).toContain(memberId);

	// Cleanup
	await terminateSession(leadId);
});

// ---------------------------------------------------------------------------
// Gap 1: Archived goals return no affiliated sessions
// GET /api/goals?archived=true has no archivedSessions field
// ---------------------------------------------------------------------------

test("archived goals endpoint returns affiliated archivedSessions", async () => {
	// 1. Create a goal (use helper which sets worktree: false for test env)
	const goal = await createGoal({ title: "Child Loading Test Goal" });
	const goalId = goal.id;

	// 2. Create a session associated with this goal
	const sessionId = await createSession({ goalId });

	// 3. Terminate (archive) the session
	await terminateSession(sessionId);

	// 4. Archive the goal via DELETE
	await deleteGoal(goalId);

	// 5. Fetch archived goals
	const archResp = await apiFetch("/api/goals?archived=true");
	expect(archResp.status).toBe(200);
	const archBody = await archResp.json();

	// The archived goal should be in the response
	const archivedGoalIds = (archBody.goals as any[]).map((g: any) => g.id);
	expect(
		archivedGoalIds,
		"Expected archived goals to include our test goal",
	).toContain(goalId);

	// 6. The response SHOULD include an archivedSessions field
	//    BUG: Currently the endpoint returns { goals, total, hasMore, nextCursor }
	//    with no affiliated session data.
	expect(
		archBody.archivedSessions,
		"Expected archived goals response to include archivedSessions field with affiliated sessions",
	).toBeDefined();

	expect(
		Array.isArray(archBody.archivedSessions),
		"Expected archivedSessions to be an array",
	).toBe(true);

	const affiliatedIds = (archBody.archivedSessions as any[]).map((s: any) => s.id);
	expect(
		affiliatedIds,
		"Expected archivedSessions to include the session affiliated with the archived goal",
	).toContain(sessionId);
});
