/**
 * SWARM-W1 — `POST /api/goals/:id/swarm/best-of-n` and the `/swarm-groups/*`
 * status/verify/confirm surface. End-to-end against the real in-process
 * gateway (mock agent, real git worktrees) — proves the full fixed
 * best-of-N pattern: fan-out → terminal barrier → deterministic verify →
 * human-gated confirm → REAL git integration, and that every step's state
 * survives a fresh GET (the "reload-persist" contract the browser E2E also
 * covers via the UI).
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, rawApiFetch, gitCwd, deleteGoal, seedTeamLeadHeader, readE2EToken } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

let gw: any;
let token: string;
test.beforeAll(async ({ gateway }) => { gw = gateway; token = readE2EToken(); });

async function createParentGoal(): Promise<{ id: string; worktreePath?: string; repoPath?: string; branch?: string }> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: `swarm-w1 parent ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			cwd: gitCwd(),
			autoStartTeam: false,
			workflowId: "feature",
		}),
	});
	expect(resp.status).toBe(201);
	const created = await resp.json();
	return pollUntil(
		async () => {
			const r = await apiFetch(`/api/goals/${created.id}`);
			if (r.status !== 200) return null;
			const g = await r.json();
			return g.setupStatus === "ready" && g.repoPath ? g : null;
		},
		{ timeoutMs: 30_000, intervalMs: 100, label: `parent ${created.id} setup ready` },
	);
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

/** Force a child goal terminal via the general archive route (mergedManually stamps state=complete first) — deterministic, no dependency on the mock agent's own timing. */
async function forceTerminal(id: string): Promise<void> {
	const resp = await apiFetch(`/api/goals/${id}?cascade=true&mergedManually=true`, { method: "DELETE" });
	expect(resp.status).toBe(200);
}

test.describe("SWARM-W1 — POST /api/goals/:id/swarm/best-of-n (fan-out)", () => {
	test("creates N swarm-tagged siblings sharing one swarmGroup, orchestration-gated (team-lead only)", async () => {
		const parent = await createParentGoal();
		try {
			// Unauthenticated (no team-lead credential) → 403, not silently created.
			const denied = await rawApiFetch(`/api/goals/${parent.id}/swarm/best-of-n`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
				body: JSON.stringify({ spec: "x".repeat(30), n: 2, verifyCommand: "true" }),
			});
			expect(denied.status).toBe(403);

			const headers = seedTeamLeadHeader(gw, parent.id);
			const resp = await rawApiFetch(`/api/goals/${parent.id}/swarm/best-of-n`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers },
				body: JSON.stringify({
					spec: "Best-of-N E2E: implement the reported fix and add a regression test.",
					n: 2,
					tokenBudgetPerNode: 500_000,
					wallClockMsPerNode: 5 * 60_000,
					verifyCommand: "test -f WINNER_MARKER",
				}),
			});
			expect(resp.status).toBe(201);
			const created = await resp.json();
			expect(created.siblingGoalIds.length).toBe(2);
			expect(created.swarmGroup).toBeTruthy();

			for (const sibId of created.siblingGoalIds) {
				const sib = await readGoal(sibId);
				expect(sib.swarmGroup).toBe(created.swarmGroup);
				expect(sib.parentGoalId).toBe(parent.id);
				expect(sib.subgoalsAllowed).toBe(false);
				expect(sib.maxNestingDepth).toBe(0);
			}
		} finally {
			await deleteGoal(parent.id);
		}
	});
});

test.describe("SWARM-W1 — barrier → verify → confirm → real git integration", () => {
	test("full round trip: fan-out, drive to terminal, verify picks the passing candidate, human confirm performs a REAL merge, state persists across fresh GETs @smoke", async () => {
		const parent = await createParentGoal();
		let swarmGroup = "";
		let siblingGoalIds: string[] = [];
		try {
			const headers = seedTeamLeadHeader(gw, parent.id);
			const createResp = await rawApiFetch(`/api/goals/${parent.id}/swarm/best-of-n`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers },
				body: JSON.stringify({
					spec: "Best-of-N E2E: implement the reported fix and add a regression test.",
					n: 2,
					tokenBudgetPerNode: 500_000,
					wallClockMsPerNode: 5 * 60_000,
					verifyCommand: "test -f WINNER_MARKER",
				}),
			});
			expect(createResp.status).toBe(201);
			const created = await createResp.json();
			swarmGroup = created.swarmGroup;
			siblingGoalIds = created.siblingGoalIds;

			// Status before the barrier fires.
			const preStatus = await (await apiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}`)).json();
			expect(preStatus.expectedCount).toBe(2);
			expect(preStatus.barrierFired).toBe(false);

			// Wait for both siblings' worktrees, then plant the marker in ONLY
			// the first sibling's worktree so the deterministic verifier passes
			// for exactly one candidate.
			const sib0 = await waitReady(siblingGoalIds[0]);
			const sib1 = await waitReady(siblingGoalIds[1]);
			expect(sib0.worktreePath).toBeTruthy();
			expect(sib1.worktreePath).toBeTruthy();
			writeFileSync(join(sib0.worktreePath, "WINNER_MARKER"), "winner\n");
			execFileSync("git", ["add", "."], { cwd: sib0.worktreePath, stdio: "pipe" });
			execFileSync("git", ["commit", "-m", "winning candidate"], { cwd: sib0.worktreePath, stdio: "pipe" });

			// Drive both siblings to terminal deterministically.
			await forceTerminal(siblingGoalIds[0]);
			await forceTerminal(siblingGoalIds[1]);

			const barrierStatus = await (await apiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}`)).json();
			expect(barrierStatus.barrierFired).toBe(true);
			expect(barrierStatus.capturedCount).toBe(2);
			expect(barrierStatus.allFailed).toBe(false);

			// An agent-only (team-lead-credentialed, no human cookie) verify call
			// gets scores back but NO confirmation token — the human-gate must
			// not be satisfiable by the orchestrating agent itself.
			const agentVerify = await rawApiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}/verify`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers },
			});
			expect(agentVerify.status).toBe(200);
			const agentVerifyBody = await agentVerify.json();
			expect(agentVerifyBody.outcome).toBe("picked");
			expect(agentVerifyBody.winnerGoalId).toBe(siblingGoalIds[0]);
			expect(agentVerifyBody.confirmationToken).toBeUndefined();

			// A confirm attempt with no token must be rejected.
			const noTokenConfirm = await apiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}/confirm`, {
				method: "POST",
				body: JSON.stringify({ winnerGoalId: siblingGoalIds[0] }),
			});
			expect(noTokenConfirm.status).toBe(403);

			// The human/UI verify call (apiFetch auto-injects the operator
			// cookie) DOES mint a confirmation token bound to this exact pick.
			const humanVerify = await apiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}/verify`, { method: "POST" });
			expect(humanVerify.status).toBe(200);
			const humanVerifyBody = await humanVerify.json();
			expect(humanVerifyBody.outcome).toBe("picked");
			expect(humanVerifyBody.winnerGoalId).toBe(siblingGoalIds[0]);
			expect(humanVerifyBody.confirmationToken).toBeTruthy();

			// Persistence check (mirrors the browser reload contract): a FRESH
			// GET (simulating a page reload) still shows the verify pick.
			const afterVerifyStatus = await (await apiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}`)).json();
			expect(afterVerifyStatus.lastVerify?.outcome).toBe("picked");
			expect(afterVerifyStatus.lastVerify?.winnerGoalId).toBe(siblingGoalIds[0]);
			expect(afterVerifyStatus.integratedGoalId).toBeFalsy();

			// Human confirm → REAL git integration (bypasses the SWARM-W0 suppression).
			const confirmResp = await apiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}/confirm`, {
				method: "POST",
				body: JSON.stringify({ winnerGoalId: siblingGoalIds[0], confirmationToken: humanVerifyBody.confirmationToken }),
			});
			expect(confirmResp.status).toBe(200);
			const confirmBody = await confirmResp.json();
			expect(confirmBody.integrated).toBe(true);
			expect(confirmBody.winnerGoalId).toBe(siblingGoalIds[0]);
			expect(confirmBody.losers).toEqual([siblingGoalIds[1]]);

			// Proof of a REAL merge: the parent's branch now contains the marker
			// committed only on the winning sibling's branch.
			const parentAfter = await readGoal(parent.id);
			const markerInParent = execFileSync(
				"git", ["show", `${parentAfter.branch}:WINNER_MARKER`],
				{ cwd: parentAfter.worktreePath, encoding: "utf-8" },
			);
			expect(markerInParent).toContain("winner");

			// Persistence check: integration state survives a fresh GET.
			const afterConfirmStatus = await (await apiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}`)).json();
			expect(afterConfirmStatus.integratedGoalId).toBe(siblingGoalIds[0]);
			expect(typeof afterConfirmStatus.integratedAt).toBe("number");

			// Re-confirming must be rejected — a group integrates at most once.
			const reConfirm = await apiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}/confirm`, {
				method: "POST",
				body: JSON.stringify({ winnerGoalId: siblingGoalIds[0], confirmationToken: humanVerifyBody.confirmationToken }),
			});
			expect(reConfirm.status).toBe(409);
		} finally {
			for (const id of siblingGoalIds) await deleteGoal(id).catch(() => {});
			await deleteGoal(parent.id);
		}
	});

	test("all-failed group escalates — verify never invents a winner and confirm has nothing to consume", async () => {
		const parent = await createParentGoal();
		let swarmGroup = "";
		let siblingGoalIds: string[] = [];
		try {
			const headers = seedTeamLeadHeader(gw, parent.id);
			const createResp = await rawApiFetch(`/api/goals/${parent.id}/swarm/best-of-n`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers },
				body: JSON.stringify({
					spec: "Best-of-N all-failed E2E fixture.",
					n: 2,
					tokenBudgetPerNode: 500_000,
					wallClockMsPerNode: 5 * 60_000,
					verifyCommand: "test -f NEVER_CREATED_MARKER",
				}),
			});
			expect(createResp.status).toBe(201);
			const created = await createResp.json();
			swarmGroup = created.swarmGroup;
			siblingGoalIds = created.siblingGoalIds;
			await waitReady(siblingGoalIds[0]);
			await waitReady(siblingGoalIds[1]);

			// Force BOTH terminal WITHOUT ever setting state=complete — the
			// general archive route's own convention stamps "killed" for a
			// non-complete archive (see server.ts's swarmTerminalStatus derivation).
			await apiFetch(`/api/goals/${siblingGoalIds[0]}?cascade=true`, { method: "DELETE" });
			await apiFetch(`/api/goals/${siblingGoalIds[1]}?cascade=true`, { method: "DELETE" });

			const status = await (await apiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}`)).json();
			expect(status.barrierFired).toBe(true);
			expect(status.allFailed).toBe(true);

			const verifyResp = await apiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}/verify`, { method: "POST" });
			expect(verifyResp.status).toBe(200);
			const verifyBody = await verifyResp.json();
			expect(verifyBody.outcome).toBe("all-failed");
			expect(verifyBody.confirmationToken).toBeUndefined();
		} finally {
			for (const id of siblingGoalIds) await deleteGoal(id).catch(() => {});
			await deleteGoal(parent.id);
		}
	});
});
