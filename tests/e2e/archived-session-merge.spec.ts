/**
 * API E2E tests for Gap 3: archived session merge behavior.
 *
 * Verifies that the server returns BFS-enriched archived delegates in both
 * the normal and paginated archived session endpoints, enabling the client-side
 * merge logic in fetchArchivedSessionsPaginated() to preserve pre-existing
 * BFS-enriched sessions instead of wiping them.
 *
 * Test scenario:
 *   1. Create a live team lead + archived team member (via teamLeadSessionId)
 *   2. Create a live parent + archived delegate (via delegateOf)
 *   3. Verify normal fetch returns both in archivedDelegates
 *   4. Verify paginated archived fetch also returns them in archivedDelegates
 *   5. This proves the client merge can safely combine both responses without loss
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, createSession } from "./e2e-setup.js";

/** Terminate (archive) a session via DELETE. */
async function terminateSession(id: string): Promise<void> {
	const resp = await apiFetch(`/api/sessions/${id}`, { method: "DELETE" });
	expect(resp.ok, `Failed to terminate session ${id}: ${resp.status}`).toBe(true);
}

test.describe("Archived session merge (Gap 3)", () => {

	// Combined test: the original pair of tests shared the same fixture shape
	// (live parent + archived delegate) and essentially covered the same two
	// fetch paths. We build the fixture ONCE and run every assertion from
	// both originals against it.
	test("both fetch paths return enriched delegates enabling safe client merge (and preserve them across live-poll → paginated transition)", async () => {
		// 1. Create a live parent session with an archived delegate
		const parentId = await createSession();
		const delegateId = await createSession();

		// Patch delegate to point to parent
		const patchDel = await apiFetch(`/api/sessions/${delegateId}`, {
			method: "PATCH",
			body: JSON.stringify({ delegateOf: parentId }),
		});
		expect(patchDel.ok).toBe(true);

		// Archive the delegate
		await terminateSession(delegateId);

		// 2. Create a live team lead with an archived team member
		const leadId = await createSession();
		const memberId = await createSession();

		const patchMember = await apiFetch(`/api/sessions/${memberId}`, {
			method: "PATCH",
			body: JSON.stringify({ teamLeadSessionId: leadId }),
		});
		expect(patchMember.ok).toBe(true);

		// Archive the team member
		await terminateSession(memberId);

		// 3. Normal fetch — should include both archived sessions in archivedDelegates
		//    (covers original test 1 steps 3 + original test 2 step A — "live poll")
		const normalResp = await apiFetch("/api/sessions");
		expect(normalResp.status).toBe(200);
		const normalBody = await normalResp.json();

		expect(normalBody.archivedDelegates, "Normal fetch should have archivedDelegates").toBeDefined();
		const normalEnrichedIds = (normalBody.archivedDelegates as any[]).map((s: any) => s.id);
		expect(normalEnrichedIds, "Normal fetch archivedDelegates should include archived delegate").toContain(delegateId);
		expect(normalEnrichedIds, "Normal fetch archivedDelegates should include archived team member").toContain(memberId);

		// From original test 2: "Live poll should enrich archived delegate"
		const normalDelegateIdsOnly = (normalBody.archivedDelegates || []).map((s: any) => s.id);
		expect(normalDelegateIdsOnly, "Live poll should enrich archived delegate").toContain(delegateId);

		// 4. Paginated archived fetch — should also return archivedDelegates
		//    (covers original test 1 step 4 + original test 2 step B — "See archived" toggle)
		const archivedResp = await apiFetch("/api/sessions?include=archived&limit=50");
		expect(archivedResp.status).toBe(200);
		const archivedBody = await archivedResp.json();

		expect(archivedBody.archivedDelegates, "Paginated fetch should have archivedDelegates").toBeDefined();
		const archivedEnrichedIds = (archivedBody.archivedDelegates as any[]).map((s: any) => s.id);
		expect(archivedEnrichedIds, "Paginated fetch archivedDelegates should include archived delegate").toContain(delegateId);
		expect(archivedEnrichedIds, "Paginated fetch archivedDelegates should include archived team member").toContain(memberId);

		// 5. The combined set of sessions + archivedDelegates should cover both
		//    (they may overlap — archived delegates can appear in both lists;
		//    the important thing is they exist in at least one)
		const archivedSessionIds = (archivedBody.sessions as any[]).map((s: any) => s.id);
		const allArchivedIds = new Set([...archivedSessionIds, ...archivedEnrichedIds]);
		expect(allArchivedIds.has(delegateId), "Delegate should be in combined set").toBe(true);
		expect(allArchivedIds.has(memberId), "Team member should be in combined set").toBe(true);

		// From original test 2: explicit assertion that paginated fetch preserves
		// the delegate so the client-side merge doesn't drop it.
		const archSessionIds = (archivedBody.sessions || []).map((s: any) => s.id);
		const archDelegateIdsOnly = (archivedBody.archivedDelegates || []).map((s: any) => s.id);
		const allFromArch = new Set([...archSessionIds, ...archDelegateIdsOnly]);
		expect(
			allFromArch.has(delegateId),
			"Paginated fetch must include the delegate (in sessions or archivedDelegates) so client merge preserves it",
		).toBe(true);

		// Cleanup
		await terminateSession(parentId);
		await terminateSession(leadId);
	});
});
