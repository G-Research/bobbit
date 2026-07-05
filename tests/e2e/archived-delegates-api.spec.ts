/**
 * E2E tests for SB-00b: Archived delegates of live sessions must be
 * returned by the paginated archived sessions endpoint.
 *
 * Bug: GET /api/sessions?include=archived&limit=50 does NOT include
 * `archivedDelegates` for live sessions. The non-archived path runs BFS
 * and returns them, but the paginated archived path omits them entirely.
 *
 * These tests create a live session with an archived delegate, then
 * verify that both the normal and archived fetch paths return the
 * delegate information.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, createGoal, createSession, nonGitCwd } from "./e2e-setup.js";

/**
 * Create a delegate session for a parent session via the REST API.
 * Returns the delegate session ID.
 */
async function createDelegate(parentId: string): Promise<string> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({
			delegateOf: parentId,
			instructions: "Test delegate for archived-delegates bug",
			cwd: nonGitCwd(),
		}),
	});
	expect(resp.status).toBe(201);
	const data = await resp.json();
	return data.id;
}

/**
 * Terminate (archive) a session via DELETE.
 */
async function terminateSession(id: string): Promise<void> {
	const resp = await apiFetch(`/api/sessions/${id}`, { method: "DELETE" });
	expect(resp.ok, `Failed to terminate session ${id}: ${resp.status}`).toBe(true);
}

// ---------------------------------------------------------------------------
// Normal path: GET /api/sessions (no include=archived)
// ---------------------------------------------------------------------------

test("normal sessions fetch returns archivedDelegates for live sessions", async () => {
	// 1. Create a live parent session
	const parentId = await createSession();

	// 2. Create a delegate of the parent
	const delegateId = await createDelegate(parentId);

	// 3. Terminate (archive) the delegate
	await terminateSession(delegateId);

	// 4. Fetch sessions normally (no include=archived)
	const resp = await apiFetch("/api/sessions");
	expect(resp.status).toBe(200);
	const body = await resp.json();

	// 5. The response must include archivedDelegates containing our delegate
	expect(
		body.archivedDelegates,
		"Expected response to have archivedDelegates field",
	).toBeDefined();
	expect(
		Array.isArray(body.archivedDelegates),
		"Expected archivedDelegates to be an array",
	).toBe(true);

	const delegateIds = body.archivedDelegates.map((s: any) => s.id);
	expect(
		delegateIds,
		"Expected archivedDelegates to include the archived delegate of the live session",
	).toContain(delegateId);

	// Cleanup
	await terminateSession(parentId);
});

// ---------------------------------------------------------------------------
// Bug: GET /api/sessions?include=archived&limit=50 omits archivedDelegates
// ---------------------------------------------------------------------------

test("paginated archived fetch returns archivedDelegates for live sessions", async () => {
	// 1. Create a live parent session
	const parentId = await createSession();

	// 2. Create a delegate of the parent
	const delegateId = await createDelegate(parentId);

	// 3. Terminate (archive) the delegate
	await terminateSession(delegateId);

	// 4. Fetch archived sessions (paginated path)
	const resp = await apiFetch("/api/sessions?include=archived&limit=50");
	expect(resp.status).toBe(200);
	const body = await resp.json();

	// 5. The response must include archivedDelegates
	//    BUG: Currently the paginated archived path does NOT return this field.
	expect(
		body.archivedDelegates,
		"Expected archivedDelegates to be present in paginated archived response",
	).toBeDefined();
	expect(
		Array.isArray(body.archivedDelegates),
		"Expected archivedDelegates to be an array",
	).toBe(true);

	const delegateIds = (body.archivedDelegates as any[]).map((s: any) => s.id);
	expect(
		delegateIds,
		"Expected archivedDelegates to include archived delegate of live session",
	).toContain(delegateId);

	// Cleanup
	await terminateSession(parentId);
});

// ---------------------------------------------------------------------------
// Bug: GET /api/sessions?include=archived (no limit) also omits archivedDelegates
// ---------------------------------------------------------------------------

test("non-paginated archived fetch returns archivedDelegates for live sessions", async () => {
	// 1. Create a live parent session
	const parentId = await createSession();

	// 2. Create a delegate of the parent
	const delegateId = await createDelegate(parentId);

	// 3. Terminate (archive) the delegate
	await terminateSession(delegateId);

	// 4. Fetch archived sessions (non-paginated — no limit param)
	const resp = await apiFetch("/api/sessions?include=archived");
	expect(resp.status).toBe(200);
	const body = await resp.json();

	// 5. The response must include archivedDelegates
	//    BUG: The non-paginated archived path also does NOT return this field.
	expect(
		body.archivedDelegates,
		"Expected archivedDelegates to be present in non-paginated archived response",
	).toBeDefined();
	expect(
		Array.isArray(body.archivedDelegates),
		"Expected archivedDelegates to be an array",
	).toBe(true);

	const delegateIds = (body.archivedDelegates as any[]).map((s: any) => s.id);
	expect(
		delegateIds,
		"Expected archivedDelegates to include archived delegate of live session",
	).toContain(delegateId);

	// Cleanup
	await terminateSession(parentId);
});

// ---------------------------------------------------------------------------
// PERF-03: default (non `include=archived`) path materialized every archived
// session across every visible project context on every poll, then
// re-scanned that whole clone array once per BFS-queued node. The fix
// (src/server/agent/archived-session-bfs.ts) indexes archived sessions by
// parent key once, then walks only the subgraph reachable from live seeds.
// This must be byte-identical to the original algorithm's reachable set —
// exercise a multi-level delegate chain, a cross-goal child, and a
// teamLeadSessionId link (the BFS relation the other two tests don't touch),
// plus a negative control that must NOT show up.
// ---------------------------------------------------------------------------

test("default sessions fetch reaches multi-level delegate chains, cross-goal children, and teamLeadSessionId links — but not unrelated archived sessions", async () => {
	// --- Live parent A, with a 2-level delegate chain hanging off it ---
	const parentA = await createSession();
	const delegateB = await createDelegate(parentA);
	await terminateSession(delegateB); // archive level 1
	const delegateC = await createDelegate(delegateB);
	await terminateSession(delegateC); // archive level 2 (grandchild of A)

	// --- Live goal G, with an archived direct child + a delegate of that child ---
	const goal = await createGoal({ title: "PERF-03 cross-goal reachability" });
	const goalChildD = await createSession({ goalId: goal.id });
	await terminateSession(goalChildD);
	const delegateOfGoalChildE = await createDelegate(goalChildD);
	await terminateSession(delegateOfGoalChildE);

	// --- Archived session linked to A only via teamLeadSessionId ---
	const teamMemberW = await createSession();
	await terminateSession(teamMemberW);
	const patchResp = await apiFetch(`/api/sessions/${teamMemberW}`, {
		method: "PATCH",
		body: JSON.stringify({ teamLeadSessionId: parentA }),
	});
	expect(patchResp.ok, `Failed to link teamLeadSessionId: ${patchResp.status}`).toBe(true);

	// --- Negative control: archived session with no relation to any of the above ---
	const unrelated = await createSession();
	await terminateSession(unrelated);

	const resp = await apiFetch("/api/sessions");
	expect(resp.status).toBe(200);
	const body = await resp.json();
	expect(Array.isArray(body.archivedDelegates)).toBe(true);
	const ids: string[] = body.archivedDelegates.map((s: any) => s.id);

	expect(ids, "multi-level delegate chain: direct child").toContain(delegateB);
	expect(ids, "multi-level delegate chain: grandchild reachable transitively").toContain(delegateC);
	expect(ids, "cross-goal child reachable via live goal seed").toContain(goalChildD);
	expect(ids, "delegate of a cross-goal child (chain continues past the goal hop)").toContain(delegateOfGoalChildE);
	expect(ids, "teamLeadSessionId link back to the live parent").toContain(teamMemberW);
	expect(ids, "unrelated archived session must NOT be materialized into the response").not.toContain(unrelated);

	// Cleanup
	await terminateSession(parentA);
	await apiFetch(`/api/goals/${goal.id}?cascade=true`, { method: "DELETE" }).catch(() => {});
});
