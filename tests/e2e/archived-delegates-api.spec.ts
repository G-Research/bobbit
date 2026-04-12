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
import { apiFetch, createSession, nonGitCwd } from "./e2e-setup.js";

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
