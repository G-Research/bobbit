/**
 * SWARM-W2 — restart-resume for the hard governor (design/swarm-orchestration.md
 * §11 Wave 2 "restart-resume"; the gap `docs/design/swarm-orchestration-w1.md`
 * flags explicitly: "a hard-killed governor timer does not re-arm on restart
 * (the `SwarmGovernor` instance is in-memory only)").
 *
 * The in-process E2E harness has no true gateway-reboot primitive (see
 * `orchestrate-restart.spec.ts`'s header note — the same limitation applies
 * here). As that spec does for `OrchestrationCore`, restart survival is driven
 * at the integration level against the REAL running gateway by invoking the
 * exact same boot-time function `server.ts` calls right after constructing
 * `VerificationHarness` (`reArmSwarmGovernorsOnBoot`) over the live
 * `projectContextManager`/`verificationHarness` — NOT a fake. This proves the
 * production wiring, not just the unit-level arithmetic (already covered by
 * `tests/swarm-w2-governor-restart.test.ts` and
 * `tests/swarm-w2-restart-resume.test.ts`).
 *
 * Scenario: fan out 2 siblings with a short `wallClockMsPerNode`. Force ONE
 * sibling terminal (a captured "done" artifact) but deliberately leave the
 * OTHER still running (uncaptured) — reproducing "the gateway restarted
 * mid-swarm". Before the fix, re-invoking boot with an empty `SwarmGovernor`
 * would never re-arm that still-running sibling: it would stay uncaptured
 * forever and the barrier would never fire. After the fix, the re-arm sweep
 * re-registers it with the REMAINING wall-clock budget (already elapsed by
 * the time this test reaches it) — the straggler timer fires almost
 * immediately, hard-kills the sibling, and the barrier converges.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, rawApiFetch, gitCwd, deleteGoal, seedTeamLeadHeader, readE2EToken } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";
import { reArmSwarmGovernorsOnBoot } from "../../src/server/agent/swarm-restart-resume.js";

let gw: any;
let token: string;
test.beforeAll(async ({ gateway }) => { gw = gateway; token = readE2EToken(); });

async function createParentGoal(): Promise<{ id: string }> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: `swarm-w2 restart-resume parent ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

/** Force a child goal terminal deterministically (no dependency on the mock agent's own timing). */
async function forceTerminal(id: string): Promise<void> {
	const resp = await apiFetch(`/api/goals/${id}?cascade=true&mergedManually=true`, { method: "DELETE" });
	expect(resp.status).toBe(200);
}

test.describe("SWARM-W2 — reArmSwarmGovernorsOnBoot (restart-resume)", () => {
	test("a still-running sibling left uncaptured across a simulated restart gets re-armed and straggler-killed, converging the barrier", async () => {
		const parent = await createParentGoal();
		let swarmGroup = "";
		let siblingGoalIds: string[] = [];
		try {
			const headers = seedTeamLeadHeader(gw, parent.id);
			const createResp = await rawApiFetch(`/api/goals/${parent.id}/swarm/best-of-n`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers },
				body: JSON.stringify({
					spec: "Restart-resume E2E: this prompt is never meant to be verified — the test forces termination.",
					n: 2,
					tokenBudgetPerNode: 500_000,
					// Long enough that the ORIGINAL (never-restarted) governor
					// instance does not straggler-kill either sibling during this
					// test's own setup/assertions below — the whole point is to
					// prove the RESTARTED path re-arms it, not to race the original.
					wallClockMsPerNode: 8_000,
					verifyCommand: "true",
				}),
			});
			expect(createResp.status).toBe(201);
			const created = await createResp.json();
			swarmGroup = created.swarmGroup;
			siblingGoalIds = created.siblingGoalIds;
			expect(siblingGoalIds.length).toBe(2);

			// Sibling[0]: force terminal now — a normal "done" capture, unaffected
			// by anything below.
			await forceTerminal(siblingGoalIds[0]);

			// Sibling[1]: deliberately left running/uncaptured — this is the node
			// whose restart-resume behavior we're proving.
			const preStatus = await (await apiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}`)).json();
			expect(preStatus.barrierFired).toBe(false);
			expect(preStatus.capturedCount).toBe(1);
			expect(gw.verificationHarness.swarmGovernor.isRegistered(siblingGoalIds[1])).toBe(true);

			// ── Simulate a gateway restart: a real restart destroys the ENTIRE
			// in-memory `SwarmGovernor` instance (a fresh one is constructed at
			// boot) — `unregisterNode` on the still-live sibling is the faithful
			// proxy for that within a single process. Only THIS sibling is
			// touched, so concurrently-running tests' own governor state is
			// unaffected.
			gw.verificationHarness.swarmGovernor.unregisterNode(siblingGoalIds[1]);
			expect(gw.verificationHarness.swarmGovernor.isRegistered(siblingGoalIds[1])).toBe(false);

			// Re-run the EXACT boot-time re-arm sweep `server.ts` calls right
			// after constructing `VerificationHarness`, against the live (real)
			// projectContextManager/harness — no fake.
			const result = reArmSwarmGovernorsOnBoot(gw.projectContextManager, gw.verificationHarness);
			expect(result.nodesReArmed).toBeGreaterThanOrEqual(1);
			expect(gw.verificationHarness.swarmGovernor.isRegistered(siblingGoalIds[1])).toBe(true);

			// The re-armed straggler timer fires once its (elapsed-time-aware)
			// remaining budget expires, hard-kills sibling[1], and converges the
			// barrier — WITHOUT the fix this would never happen (an unregistered
			// node is never re-checked and nothing else ever captures it).
			const postStatus = await pollUntil(
				async () => {
					const s = await (await apiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}`)).json();
					return s.barrierFired ? s : null;
				},
				{ timeoutMs: 20_000, intervalMs: 200, label: "barrier converges after restart re-arm" },
			);
			expect(postStatus.capturedCount).toBe(2);
			const sibling1Artifact = postStatus.artifacts.find((a: any) => a.goalId === siblingGoalIds[1]);
			expect(sibling1Artifact?.status).toBe("killed");
		} finally {
			for (const id of siblingGoalIds) await deleteGoal(id).catch(() => {});
			await deleteGoal(parent.id);
		}
	});

	test("a group whose barrier already fired before the restart is left untouched (nothing to re-arm)", async () => {
		const parent = await createParentGoal();
		let swarmGroup = "";
		let siblingGoalIds: string[] = [];
		try {
			const headers = seedTeamLeadHeader(gw, parent.id);
			const createResp = await rawApiFetch(`/api/goals/${parent.id}/swarm/best-of-n`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers },
				body: JSON.stringify({
					spec: "Restart-resume E2E control case: both siblings terminate before the simulated restart.",
					n: 2,
					tokenBudgetPerNode: 500_000,
					wallClockMsPerNode: 5 * 60_000,
					verifyCommand: "true",
				}),
			});
			expect(createResp.status).toBe(201);
			const created = await createResp.json();
			swarmGroup = created.swarmGroup;
			siblingGoalIds = created.siblingGoalIds;

			await forceTerminal(siblingGoalIds[0]);
			await forceTerminal(siblingGoalIds[1]);

			const preStatus = await (await apiFetch(`/api/goals/${parent.id}/swarm-groups/${swarmGroup}`)).json();
			expect(preStatus.barrierFired).toBe(true);

			const result = reArmSwarmGovernorsOnBoot(gw.projectContextManager, gw.verificationHarness);
			// This group is already fully barriered — the sweep must not touch it
			// (no node to re-arm), though other in-flight groups from earlier tests
			// running concurrently could still contribute to the totals, so we only
			// assert THIS group's siblings were never re-registered.
			expect(gw.verificationHarness.swarmGovernor.isRegistered(siblingGoalIds[0])).toBe(false);
			expect(gw.verificationHarness.swarmGovernor.isRegistered(siblingGoalIds[1])).toBe(false);
			void result;
		} finally {
			for (const id of siblingGoalIds) await deleteGoal(id).catch(() => {});
			await deleteGoal(parent.id);
		}
	});
});
