/**
 * SWARM-W4.5 — `POST /api/goals/:id/swarm/plan-fan-in` and the
 * `/plan-verify`/`/plan-confirm`/`/plan-reject` gate surface. End-to-end
 * against the real in-process gateway (mock agent, real git worktrees) —
 * proves the full sequencing: N planning-only siblings fan out → terminal
 * barrier fires → the server-side synthesis role ACTUALLY spawns and runs
 * (real `TeamManager.spawnRole` + real `SessionManager.waitForIdle`/
 * `getSessionOutput` against the mock agent, not a stub) → the human-gated
 * pre-build confirm spawns exactly ONE ordinary (non-swarm-tagged) build
 * child → OR the human rejects and the group is archived with no auto-retry
 * (orchestrator ruling #1). Mirrors `tests/e2e/api-swarm-best-of-n.spec.ts`'s
 * structure and helpers.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, rawApiFetch, gitCwd, deleteGoal, seedTeamLeadHeader, readE2EToken } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

let gw: any;
let token: string;
test.beforeAll(async ({ gateway }) => { gw = gateway; token = readE2EToken(); });

async function createParentGoalWithTeam(): Promise<{ id: string; worktreePath?: string; repoPath?: string; branch?: string }> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: `plan-fan-in parent ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			cwd: gitCwd(),
			autoStartTeam: false,
			workflowId: "feature",
			spec: "# Plan-fan-in E2E parent\n\nLong enough spec to pass the SPEC_REQUIRED guard for a manual team start.",
		}),
	});
	expect(resp.status).toBe(201);
	const created = await resp.json();
	const parent = await pollUntil(
		async () => {
			const r = await apiFetch(`/api/goals/${created.id}`);
			if (r.status !== 200) return null;
			const g = await r.json();
			return g.setupStatus === "ready" && g.repoPath ? g : null;
		},
		{ timeoutMs: 30_000, intervalMs: 100, label: `parent ${created.id} setup ready` },
	);
	// Plan-fan-in's synthesis step spawns a role into the PARENT's own team —
	// the route fails fast (409) if the parent has no active team, so start
	// one for real (not just an auth-header stand-in) before fanning out.
	const startResp = await apiFetch(`/api/goals/${parent.id}/team/start`, { method: "POST" });
	expect(startResp.status).toBe(201);
	await pollUntil(
		async () => {
			const r = await apiFetch(`/api/goals/${parent.id}/team`);
			if (r.status !== 200) return null;
			const t = await r.json();
			return t.teamLeadSessionId ? t : null;
		},
		{ timeoutMs: 30_000, intervalMs: 100, label: `team started for ${parent.id}` },
	);
	return parent;
}

async function readGoal(id: string): Promise<any> {
	const r = await apiFetch(`/api/goals/${id}`);
	expect(r.status).toBe(200);
	return r.json();
}

async function waitReady(id: string): Promise<any> {
	return pollUntil(
		async () => {
			const g = await readGoal(id);
			return g.setupStatus === "ready" ? g : null;
		},
		{ timeoutMs: 30_000, intervalMs: 100, label: `sibling ${id} setup ready` },
	);
}

/** Force a child goal terminal via the general archive route (mergedManually stamps state=complete first) — same technique `api-swarm-best-of-n.spec.ts` uses, deterministic and independent of the mock agent's own turn timing. */
async function forceTerminal(id: string): Promise<void> {
	const resp = await apiFetch(`/api/goals/${id}?cascade=true&mergedManually=true`, { method: "DELETE" });
	expect(resp.status).toBe(200);
}

async function fanOutPlanGroup(parentId: string, headers: Record<string, string>): Promise<{ swarmGroup: string; siblingGoalIds: string[] }> {
	const resp = await rawApiFetch(`/api/goals/${parentId}/swarm/plan-fan-in`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers },
		body: JSON.stringify({
			spec: "Plan-fan-in E2E: propose a caching strategy for the search endpoint.",
			fanOut: 2,
			tokenBudgetPerNode: 500_000,
			wallClockMsPerNode: 5 * 60_000,
		}),
	});
	expect(resp.status).toBe(201);
	return resp.json();
}

async function waitForSynthesis(parentId: string, swarmGroup: string): Promise<any> {
	return pollUntil(
		async () => {
			const r = await apiFetch(`/api/goals/${parentId}/swarm-groups/${swarmGroup}`);
			if (r.status !== 200) return null;
			const status = await r.json();
			if (status.synthesis?.status === "done" || status.synthesis?.status === "failed") return status;
			return null;
		},
		{ timeoutMs: 30_000, intervalMs: 200, label: `synthesis settled for group ${swarmGroup}` },
	);
}

test.describe("SWARM-W4.5 — POST /api/goals/:id/swarm/plan-fan-in (fan-out)", () => {
	test("creates N swarm-tagged, planning-only siblings sharing one swarmGroup; refuses when the parent has no active team", async () => {
		// No team started for THIS parent — plan-fan-in must fail fast.
		const resp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: `plan-fan-in no-team parent ${Date.now()}`,
				cwd: gitCwd(),
				autoStartTeam: false,
				workflowId: "feature",
			}),
		});
		expect(resp.status).toBe(201);
		const created = await resp.json();
		try {
			const denied = await rawApiFetch(`/api/goals/${created.id}/swarm/plan-fan-in`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
				body: JSON.stringify({ spec: "x".repeat(30), fanOut: 2 }),
			});
			expect(denied.status).toBe(403); // no team-lead/human auth at all
		} finally {
			await deleteGoal(created.id);
		}
	});

	test("full round trip: fan-out → barrier → REAL synthesis role runs → human confirm spawns ONE ordinary build child @smoke", async () => {
		const parent = await createParentGoalWithTeam();
		let swarmGroup = "";
		let siblingGoalIds: string[] = [];
		let buildGoalId = "";
		try {
			const headers = seedTeamLeadHeader(gw, parent.id);
			const created = await fanOutPlanGroup(parent.id, headers);
			swarmGroup = created.swarmGroup;
			siblingGoalIds = created.siblingGoalIds;
			expect(siblingGoalIds.length).toBe(2);

			for (const sibId of siblingGoalIds) {
				const sib = await readGoal(sibId);
				expect(sib.swarmGroup).toBe(swarmGroup);
				expect(sib.parentGoalId).toBe(parent.id);
			}

			await waitReady(siblingGoalIds[0]);
			await waitReady(siblingGoalIds[1]);

			const preStatus = await (await apiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}`)).json();
			expect(preStatus.config?.topology).toBe("plan-fan-in");
			expect(preStatus.barrierFired).toBe(false);
			expect(preStatus.synthesis).toBeUndefined();

			await forceTerminal(siblingGoalIds[0]);
			await forceTerminal(siblingGoalIds[1]);

			// The barrier fires synchronously with the second forceTerminal call;
			// synthesis is an async continuation off that same event — poll for it
			// to actually settle against the REAL mock-agent-driven session.
			const synthStatus = await waitForSynthesis(parent.id, swarmGroup);
			expect(synthStatus.barrierFired).toBe(true);
			expect(synthStatus.synthesis.status).toBe("done");
			expect(typeof synthStatus.synthesis.output).toBe("string");
			expect(synthStatus.synthesis.output.length).toBeGreaterThan(0);
			expect(synthStatus.synthesis.planHash).toBeTruthy();

			// Agent-only /plan-verify gets the plan back but no token.
			const agentVerify = await rawApiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}/plan-verify`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers },
			});
			expect(agentVerify.status).toBe(200);
			const agentVerifyBody = await agentVerify.json();
			expect(agentVerifyBody.outcome).toBe("synthesized");
			expect(agentVerifyBody.confirmationToken).toBeUndefined();

			// A confirm attempt with no token must be rejected.
			const noTokenConfirm = await apiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}/plan-confirm`, { method: "POST" });
			expect(noTokenConfirm.status).toBe(403);

			// Human /plan-verify mints a real token.
			const humanVerify = await apiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}/plan-verify`, { method: "POST" });
			expect(humanVerify.status).toBe(200);
			const humanVerifyBody = await humanVerify.json();
			expect(humanVerifyBody.confirmationToken).toBeTruthy();

			// Human /plan-confirm spawns exactly one ordinary build child.
			const confirmResp = await apiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}/plan-confirm`, {
				method: "POST",
				body: JSON.stringify({ confirmationToken: humanVerifyBody.confirmationToken }),
			});
			expect(confirmResp.status).toBe(201);
			const confirmBody = await confirmResp.json();
			expect(confirmBody.confirmed).toBe(true);
			buildGoalId = confirmBody.buildGoalId;
			expect(buildGoalId).toBeTruthy();

			const build = await readGoal(buildGoalId);
			expect(build.swarmGroup).toBeFalsy(); // design §5: ordinary, non-swarm-tagged row
			expect(build.parentGoalId).toBe(parent.id);
			expect(build.spec).toBe(synthStatus.synthesis.output);

			// Persistence check: survives a fresh GET.
			const afterConfirmStatus = await (await apiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}`)).json();
			expect(afterConfirmStatus.buildGoalId).toBe(buildGoalId);

			// Re-confirming must be rejected — a group confirms at most once.
			const reConfirm = await apiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}/plan-confirm`, {
				method: "POST",
				body: JSON.stringify({ confirmationToken: humanVerifyBody.confirmationToken }),
			});
			expect(reConfirm.status).toBe(409);
		} finally {
			if (buildGoalId) await deleteGoal(buildGoalId).catch(() => {});
			for (const id of siblingGoalIds) await deleteGoal(id).catch(() => {});
			await apiFetch(`/api/goals/${parent.id}/team/teardown`, { method: "POST" }).catch(() => {});
			await deleteGoal(parent.id);
		}
	});

	test("plan-rejection path (orchestrator ruling #1): archives the plan siblings, no build, no auto-retry", async () => {
		const parent = await createParentGoalWithTeam();
		let swarmGroup = "";
		let siblingGoalIds: string[] = [];
		try {
			const headers = seedTeamLeadHeader(gw, parent.id);
			const created = await fanOutPlanGroup(parent.id, headers);
			swarmGroup = created.swarmGroup;
			siblingGoalIds = created.siblingGoalIds;
			await waitReady(siblingGoalIds[0]);
			await waitReady(siblingGoalIds[1]);
			await forceTerminal(siblingGoalIds[0]);
			await forceTerminal(siblingGoalIds[1]);
			await waitForSynthesis(parent.id, swarmGroup);

			const humanVerify = await apiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}/plan-verify`, { method: "POST" });
			const humanVerifyBody = await humanVerify.json();
			expect(humanVerifyBody.confirmationToken).toBeTruthy();

			const rejectResp = await apiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}/plan-reject`, {
				method: "POST",
				body: JSON.stringify({ confirmationToken: humanVerifyBody.confirmationToken }),
			});
			expect(rejectResp.status).toBe(200);
			const rejectBody = await rejectResp.json();
			expect(rejectBody.rejected).toBe(true);
			expect(new Set(rejectBody.archivedSiblingIds)).toEqual(new Set(siblingGoalIds));

			const status = await (await apiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}`)).json();
			expect(typeof status.planRejectedAt).toBe("number");
			expect(status.buildGoalId).toBeFalsy();

			// No auto-retry: confirming afterward is rejected.
			const confirmAfterReject = await apiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}/plan-confirm`, {
				method: "POST",
				body: JSON.stringify({ confirmationToken: humanVerifyBody.confirmationToken }),
			});
			expect(confirmAfterReject.status).toBe(409);
		} finally {
			for (const id of siblingGoalIds) await deleteGoal(id).catch(() => {});
			await apiFetch(`/api/goals/${parent.id}/team/teardown`, { method: "POST" }).catch(() => {});
			await deleteGoal(parent.id);
		}
	});

	test("best-of-n /verify and /confirm refuse a plan-fan-in group (WRONG_TOPOLOGY)", async () => {
		const parent = await createParentGoalWithTeam();
		let swarmGroup = "";
		let siblingGoalIds: string[] = [];
		try {
			const headers = seedTeamLeadHeader(gw, parent.id);
			const created = await fanOutPlanGroup(parent.id, headers);
			swarmGroup = created.swarmGroup;
			siblingGoalIds = created.siblingGoalIds;

			const verifyResp = await apiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}/verify`, { method: "POST" });
			expect(verifyResp.status).toBe(400);
			const verifyBody = await verifyResp.json();
			expect(verifyBody.code).toBe("WRONG_TOPOLOGY");

			const confirmResp = await apiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}/confirm`, {
				method: "POST",
				body: JSON.stringify({ winnerGoalId: siblingGoalIds[0] }),
			});
			expect(confirmResp.status).toBe(400);
			const confirmBody = await confirmResp.json();
			expect(confirmBody.code).toBe("WRONG_TOPOLOGY");
		} finally {
			for (const id of siblingGoalIds) await deleteGoal(id).catch(() => {});
			await apiFetch(`/api/goals/${parent.id}/team/teardown`, { method: "POST" }).catch(() => {});
			await deleteGoal(parent.id);
		}
	});
});
