/**
 * SWARM-W4.6 — `POST /api/goals/:id/swarm/orchestrator-worker`.
 *
 * End-to-end against the real in-process gateway (mock agent, real
 * TeamManager.spawnRole for decompose + synthesis): decompose emits fenced
 * shard JSON, workers are created as swarmGroup-tagged merge-all leaves, the
 * barrier fires, synthesis runs, and the best-of-N winner routes reject this
 * topology.
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
			title: `orchestrator-worker parent ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			cwd: gitCwd(),
			autoStartTeam: false,
			workflowId: "feature",
			spec: "# Orchestrator-worker E2E parent\n\nLong enough spec to pass the SPEC_REQUIRED guard for a manual team start.",
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
		{ timeoutMs: 30_000, intervalMs: 100, label: `worker ${id} setup ready` },
	);
}

async function forceTerminal(id: string): Promise<void> {
	const resp = await apiFetch(`/api/goals/${id}?cascade=true&mergedManually=true`, { method: "DELETE" });
	expect(resp.status).toBe(200);
}

async function fanOutMergeAll(parentId: string, headers: Record<string, string>): Promise<{ swarmGroup: string; siblingGoalIds: string[]; shards: Array<{ title: string; spec: string; rationale: string }> }> {
	const resp = await rawApiFetch(`/api/goals/${parentId}/swarm/orchestrator-worker`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers },
		body: JSON.stringify({
			spec: "Orchestrator-worker E2E: inspect API and persistence as disjoint shards.",
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
		{ timeoutMs: 30_000, intervalMs: 200, label: `merge-all synthesis settled for group ${swarmGroup}` },
	);
}

test.describe("SWARM-W4.6 — POST /api/goals/:id/swarm/orchestrator-worker (merge-all)", () => {
	test("full round trip: decompose → merge-all workers → barrier → synthesis; best-of-N routes reject @smoke", async () => {
		const parent = await createParentGoalWithTeam();
		let swarmGroup = "";
		let siblingGoalIds: string[] = [];
		try {
			const headers = seedTeamLeadHeader(gw, parent.id);
			const created = await fanOutMergeAll(parent.id, headers);
			swarmGroup = created.swarmGroup;
			siblingGoalIds = created.siblingGoalIds;
			expect(created.shards.length).toBe(2);
			expect(siblingGoalIds.length).toBe(2);

			for (const [i, sibId] of siblingGoalIds.entries()) {
				const sib = await readGoal(sibId);
				expect(sib.swarmGroup).toBe(swarmGroup);
				expect(sib.parentGoalId).toBe(parent.id);
				expect(sib.subgoalsAllowed).toBe(false);
				expect(sib.maxNestingDepth).toBe(0);
				expect(sib.title).toBe(created.shards[i].title);
				expect(sib.spec).toContain(created.shards[i].spec);
			}

			const preStatus = await (await apiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}`)).json();
			expect(preStatus.config?.topology).toBe("orchestrator-worker");
			expect(preStatus.reconcileMode).toBe("merge-all");
			expect(preStatus.barrierFired).toBe(false);

			await waitReady(siblingGoalIds[0]);
			await waitReady(siblingGoalIds[1]);
			await forceTerminal(siblingGoalIds[0]);
			await forceTerminal(siblingGoalIds[1]);

			const synthStatus = await waitForSynthesis(parent.id, swarmGroup);
			expect(synthStatus.barrierFired).toBe(true);
			expect(synthStatus.allFailed).toBe(false);
			expect(synthStatus.synthesis.status).toBe("done");
			expect(typeof synthStatus.synthesis.output).toBe("string");
			expect(synthStatus.synthesis.output.length).toBeGreaterThan(0);

			const verifyResp = await apiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}/verify`, { method: "POST" });
			expect(verifyResp.status).toBe(400);
			expect((await verifyResp.json()).code).toBe("WRONG_TOPOLOGY");

			const confirmResp = await apiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}/confirm`, {
				method: "POST",
				body: JSON.stringify({ winnerGoalId: siblingGoalIds[0] }),
			});
			expect(confirmResp.status).toBe(400);
			expect((await confirmResp.json()).code).toBe("WRONG_TOPOLOGY");
		} finally {
			for (const id of siblingGoalIds) await deleteGoal(id).catch(() => {});
			await apiFetch(`/api/goals/${parent.id}/team/teardown`, { method: "POST" }).catch(() => {});
			await deleteGoal(parent.id);
		}
	});
});
