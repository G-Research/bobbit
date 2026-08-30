/**
 * API E2E — Sub-goal B archive cascade via the PUBLIC DELETE route.
 *
 * Gap (design §6, "parent dormant/not-live" path): `DELETE /api/sessions/:id`
 * first calls `terminateSession(id)`, which cascade-reaps a LIVE parent's
 * children. But when the parent is NOT live (dormant / store-only — e.g. a
 * completed delegate parent, or a parent that went dormant after a restart),
 * `terminateSession` returns false. Previously the route only archived when
 * `purge=true`; the normal `purge=false` DELETE returned 404 WITHOUT archiving,
 * so `cascadeReapOwner` never ran and the dormant parent's live children leaked.
 *
 * The UI non-goal terminate flow uses exactly this path (and suppresses 404s).
 *
 * This test makes the parent store-only (removed from the in-memory live map
 * while its non-archived store record survives — precisely the shape a parent
 * has after a restart that deferred it), then DELETEs it with `purge=false` and
 * asserts the live child is cascade-archived through the public route.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, createSession, deleteSession, nonGitCwd } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

async function createDelegate(parentId: string): Promise<string> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({
			delegateOf: parentId,
			instructions: "dormant-cascade child",
			cwd: nonGitCwd(),
		}),
	});
	expect(resp.status).toBe(201);
	return (await resp.json()).id as string;
}

test("DELETE on a dormant/store-only parent cascade-archives its live children (purge=false)", async ({ gateway }) => {
	const sm = gateway.sessionManager;

	// 1. Live parent + a live delegate child.
	const parentId = await createSession();
	const childId = await createDelegate(parentId);

	// Let the child run its spawn prompt to completion so the cascade terminates a
	// cleanly-idle child (mirrors orchestrate-restart.spec.ts) rather than racing
	// an in-flight stream. Then it is genuinely live and linked to the parent.
	await pollUntil(async () => (sm.getSession(childId)?.status === "idle" ? true : null),
		{ timeoutMs: 15_000, intervalMs: 50, label: "child idle" });
	expect(sm.isSessionLive(childId)).toBe(true);
	expect(sm.getPersistedSession(childId)?.delegateOf).toBe(parentId);

	// 2. Make the PARENT store-only: drop it from the in-memory live map while
	//    leaving its (non-archived) persisted record intact. This is exactly the
	//    shape a parent has after a restart that deferred it without reviving it —
	//    `terminateSession(parentId)` will now return false, but the store record
	//    (and thus its children's linkage) survives.
	(sm as any).sessions.delete(parentId);
	expect(sm.isSessionLive(parentId)).toBe(false);
	expect(sm.getPersistedSession(parentId)).toBeTruthy();
	// The child is still live — it must be cascade-reaped by the DELETE.
	expect(sm.isSessionLive(childId)).toBe(true);

	// 3. Public DELETE with purge=false — the path the UI non-goal terminate uses.
	const del = await apiFetch(`/api/sessions/${parentId}`, { method: "DELETE" });
	expect(del.status).toBe(200);
	expect((await del.json()).ok).toBe(true);

	// 4. The child is cascade-reaped by the DELETE (purge=false): the dormant
	//    parent's live child must be archived even though `terminateSession`
	//    returned false. Poll because the cascade settles asynchronously.
	await pollUntil(async () => (!sm.isSessionLive(childId) ? true : null),
		{ timeoutMs: 10_000, intervalMs: 25, label: "child reaped" });
	expect(sm.getArchivedSession(childId), "child should be archived").toBeTruthy();

	// Gone from the live session list (the public surface the UI sidebar reads).
	const liveResp = await apiFetch("/api/sessions");
	expect(liveResp.status).toBe(200);
	const liveIds = ((await liveResp.json()).sessions as any[]).map((s: any) => s.id);
	expect(liveIds, "child should be gone from the live list").not.toContain(childId);
	expect(liveIds, "parent should be gone from the live list").not.toContain(parentId);

	// Present under include=archived (parity with team-shutdown child archival).
	const archivedResp = await apiFetch("/api/sessions?include=archived&limit=50");
	expect(archivedResp.status).toBe(200);
	const archivedBody = await archivedResp.json();
	const archivedIds = [
		...((archivedBody.sessions ?? []) as any[]).filter((s: any) => s.archived),
		...((archivedBody.archivedDelegates ?? []) as any[]),
	].map((s: any) => s.id);
	expect(archivedIds, "child should appear under include=archived").toContain(childId);

	// The dormant parent itself is archived too.
	expect(sm.getArchivedSession(parentId), "parent should be archived").toBeTruthy();

	// Cleanup (best-effort).
	await deleteSession(parentId);
	await deleteSession(childId);
});

test("DELETE on a truly-unknown id still 404s", async ({ gateway }) => {
	void gateway;
	const del = await apiFetch(`/api/sessions/does-not-exist-anywhere`, { method: "DELETE" });
	expect(del.status).toBe(404);
});
