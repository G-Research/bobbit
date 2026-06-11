/**
 * API E2E — H3: the goal `/team/{prompt,steer,abort,dismiss}` OWN-CHILD fallback
 * must enforce owner→caller authz, exactly like `/orchestrate/*`.
 *
 * A team-lead's `team_delegate(non_blocking)` child is NOT a goal team member,
 * so those routes FALL BACK to OrchestrationCore when the target is tracked
 * under the goal's team-lead. The goal `/team/*` routes accept a sandbox-scoped
 * token, so without binding the request to the unforgeable per-session secret a
 * DIFFERENT same-goal agent that learns the helper child's session id could
 * prompt / steer / abort / dismiss the team-lead's PRIVATE child. This spec
 * pins:
 *   • the LEGITIMATE owner (team-lead, authenticating with its own secret) can
 *     prompt + dismiss its own delegate child via `/team/*`, and
 *   • a DIFFERENT caller (its own secret) AND a caller with NO secret are both
 *     DENIED 403 on every mutating verb.
 *
 * Goal-MEMBER operations (the normal `/team/*` path) are unaffected — the authz
 * guards the own-child fallback ONLY.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, createGoal, createSession, deleteGoal, deleteSession, rawApiFetch, startTeam, teardownTeam } from "./e2e-setup.js";

/** Spawn a non-blocking own child of `ownerId` (apiFetch auto-injects the owner's secret on /orchestrate/). */
async function spawnOwnChild(ownerId: string, instructions: string): Promise<string> {
	const resp = await apiFetch(`/api/sessions/${ownerId}/orchestrate/spawn`, {
		method: "POST",
		body: JSON.stringify({ instructions }),
	});
	expect(resp.status).toBe(201);
	const childId = (await resp.json()).childSessionId as string;
	expect(childId).toBeTruthy();
	return childId;
}

test.describe("team-lead own-child /team/* authz (H3)", () => {
	test("owner can prompt + dismiss its own delegate child; a different/no caller is DENIED 403", async ({ gateway }) => {
		const goal = await createGoal({ title: "Lead own-child authz", team: true });
		const attacker = await createSession(); // a foreign session (its own valid secret)
		let leadId: string | undefined;
		let childId: string | undefined;
		try {
			leadId = await startTeam(goal.id as string);
			expect(leadId).toBeTruthy();

			// The team-lead spawns its OWN non-blocking team_delegate child. It is
			// tracked by OrchestrationCore under the lead, NOT a goal team member.
			childId = await spawnOwnChild(leadId!, "lead private helper");
			const agentsResp = await apiFetch(`/api/goals/${goal.id}/team/agents`);
			const agents = (await agentsResp.json()).agents ?? [];
			expect(agents.map((a: any) => a.sessionId)).not.toContain(childId);

			const secretOf = (id: string): Record<string, string> => ({
				"X-Bobbit-Session-Secret": gateway.sessionManager.sessionSecretStore.getOrCreateSecret(id),
			});
			const attackerSecret = secretOf(attacker);
			const leadSecret = secretOf(leadId!);

			// ── DENY: a DIFFERENT caller (its own secret) on every mutating verb. ──
			const denyPrompt = await apiFetch(`/api/goals/${goal.id}/team/prompt`, {
				method: "POST", headers: attackerSecret,
				body: JSON.stringify({ sessionId: childId, message: "hijack" }),
			});
			expect(denyPrompt.status).toBe(403);

			const denySteer = await apiFetch(`/api/goals/${goal.id}/team/steer`, {
				method: "POST", headers: attackerSecret,
				body: JSON.stringify({ sessionId: childId, message: "hijack" }),
			});
			expect(denySteer.status).toBe(403);

			const denyAbort = await apiFetch(`/api/goals/${goal.id}/team/abort`, {
				method: "POST", headers: attackerSecret,
				body: JSON.stringify({ sessionId: childId }),
			});
			expect(denyAbort.status).toBe(403);

			const denyDismiss = await apiFetch(`/api/goals/${goal.id}/team/dismiss`, {
				method: "POST", headers: attackerSecret,
				body: JSON.stringify({ sessionId: childId }),
			});
			expect(denyDismiss.status).toBe(403);

			// ── DENY: NO secret at all (bearer alone is insufficient). Use
			//    rawApiFetch to bypass the harness's team-lead secret auto-injector
			//    and genuinely send no per-session secret. ──
			const noSecretPrompt = await rawApiFetch(`/api/goals/${goal.id}/team/prompt`, {
				method: "POST",
				body: JSON.stringify({ sessionId: childId, message: "hijack" }),
			});
			expect(noSecretPrompt.status).toBe(403);

			const noSecretDismiss = await rawApiFetch(`/api/goals/${goal.id}/team/dismiss`, {
				method: "POST",
				body: JSON.stringify({ sessionId: childId }),
			});
			expect(noSecretDismiss.status).toBe(403);

			// The child must still be tracked (none of the denied calls touched it).
			const childrenResp = await apiFetch(`/api/sessions/${leadId}/orchestrate/children`);
			expect(((await childrenResp.json()).children ?? []).map((c: any) => c.sessionId)).toContain(childId);

			// ── ALLOW: the legitimate owner (lead's own secret) can prompt… ──
			const okPrompt = await apiFetch(`/api/goals/${goal.id}/team/prompt`, {
				method: "POST", headers: leadSecret,
				body: JSON.stringify({ sessionId: childId, message: "follow-up task" }),
			});
			expect(okPrompt.status).toBe(200);
			expect((await okPrompt.json()).ok).toBe(true);

			// …and dismiss its own child.
			const okDismiss = await apiFetch(`/api/goals/${goal.id}/team/dismiss`, {
				method: "POST", headers: leadSecret,
				body: JSON.stringify({ sessionId: childId }),
			});
			expect(okDismiss.status).toBe(200);
			expect((await okDismiss.json()).ok).toBe(true);
			childId = undefined;
		} finally {
			if (leadId && childId) {
				await apiFetch(`/api/sessions/${leadId}/orchestrate/dismiss`, {
					method: "POST", body: JSON.stringify({ childSessionId: childId }),
				}).catch(() => {});
			}
			await teardownTeam(goal.id as string).catch(() => {});
			await deleteGoal(goal.id as string).catch(() => {});
			await deleteSession(attacker).catch(() => {});
		}
	});
});
