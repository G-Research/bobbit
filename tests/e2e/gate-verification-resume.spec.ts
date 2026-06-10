/**
 * API E2E test for gate verification resume after server restart.
 *
 * Covers both LLM-review restart bugs end-to-end against a real in-process
 * gateway:
 *
 *   Bug 1 — TeamManager.resubscribeTeamEvents() must NOT attach the
 *           agent_end → notifyTeamLead listener to reviewer sessions.
 *           After restart, firing agent_end on a reviewer must NOT
 *           steer/enqueue a "Agent ... has finished" message to the
 *           team lead.
 *
 *   Bug 2 — VerificationHarness._tryResumeFromSession must give a resumed
 *           reviewer the full reminder window before declaring failure
 *           and terminating the session. Pre-fix, the session was killed
 *           ~46ms after the reminder was dispatched because waitForIdle
 *           resolved synchronously against an already-idle status.
 *
 * Why this lives as an in-process API E2E rather than a true OS-process
 * restart test:
 *
 *   The in-process harness shares Node's module cache across the test —
 *   spinning a *second* gateway in the same worker is fragile (server
 *   singletons, project-root binding) and the existing fixture is
 *   designed worker-scoped for exactly this reason. Instead, we drive the
 *   two restart-resume code paths directly:
 *
 *     - For Bug 1 we exercise `restoreTeams() + resubscribeTeamEvents()`
 *       using the live TeamManager — the same calls server.ts makes
 *       during boot (server.ts:1130).
 *
 *     - For Bug 2 we seed an ActiveVerification pointing at a real live
 *       session, then call resumeInterruptedVerifications() — the same
 *       call server.ts makes during boot (server.ts:1133).
 *
 *   The session, RPC bridge, event subscriptions, and verification harness
 *   are all real — only the boot sequence is short-circuited.
 */
import { test, expect } from "./in-process-harness.js";
import {
	assertStaysFalse,
	createGoal,
	createSession,
	deleteGoal,
	waitForCondition,
	waitForSessionStatus,
} from "./e2e-setup.js";
import fs from "node:fs";
import path from "node:path";

// Reach into the in-process gateway. These are private fields but the
// harness exposes the SessionManager and chains through it.
function getInternals(gateway: any) {
	const sm = gateway.sessionManager;
	const harness = sm._verificationHarness;
	const teamManager = harness?.teamManager;
	if (!harness) throw new Error("verification harness not wired on session manager");
	if (!teamManager) throw new Error("team manager not wired on verification harness");
	return { sm, harness, teamManager };
}

test.describe("gate verification resume after restart", () => {
	test.describe.configure({ mode: "serial" });
	test.setTimeout(30_000);

	test("Bug 1: resubscribeTeamEvents skips reviewer agents — no team-lead nudge after restart", async ({ gateway }) => {
		const { sm, teamManager } = getInternals(gateway);

		// Create a goal whose workflow allows a team. Use the test-fast
		// workflow so the goal is real and routable through team APIs.
		const goal = await createGoal({ title: `Resume Bug1 ${Date.now()}`, workflowId: "test-fast" });
		const goalId = goal.id;

		// Create a session that will play the role of the team lead.
		const teamLeadId = await createSession({ goalId });
		// And another session that will be tagged as a reviewer.
		const reviewerId = await createSession({ goalId });
		// And a real worker session — this one MUST trigger a nudge so we know
		// the listener wiring works for non-reviewer agents (negative control).
		const workerId = await createSession({ goalId });

		try {
			// Spin up a team for the goal. spawnRole would create a worker
			// branch; instead we drive the team store directly to mirror
			// what the server does during restart restoreTeams().
			//
			// Step 1: have TeamManager start a team rooted at our team-lead session.
			//   We do this by reaching into the team store and writing a persisted
			//   entry, then calling the same restoreTeams path that boot uses.
			const ctx = (sm.getProjectContextManager?.() ?? sm.projectContextManager).getContextForGoal(goalId);
			expect(ctx, "project context for goal").toBeTruthy();
			const teamStore = ctx.teamStore;

			teamStore.put({
				goalId,
				teamLeadSessionId: teamLeadId,
				agents: [
					// One real worker (kind: worker) — agent_end should nudge.
					{ sessionId: workerId, role: "coder", kind: "worker", task: "code", createdAt: Date.now() },
					// One reviewer (kind: reviewer) — agent_end MUST NOT nudge.
					{ sessionId: reviewerId, role: "reviewer", kind: "reviewer", task: "Verification review: Code quality", createdAt: Date.now() },
				],
				maxConcurrent: 12,
			});

			// Re-run restore + resubscribe. This is the boot sequence:
			//   restoreTeams() (constructor) → resubscribeTeamEvents()
			// The TeamManager is already constructed in this gateway; calling
			// the private restoreTeams() refreshes its in-memory map from the
			// store we just seeded.
			(teamManager as any).restoreTeams();
			teamManager.resubscribeTeamEvents();

			const internalAgents = (teamManager as any).teams.get(goalId).agents;
			expect(internalAgents.find((a: any) => a.sessionId === reviewerId).kind).toBe("reviewer");
			expect(internalAgents.find((a: any) => a.sessionId === workerId).kind).toBe("worker");

			// Spy on team-lead steer + enqueue paths.
			const origSteer = sm.deliverLiveSteer.bind(sm);
			const origEnqueue = sm.enqueuePrompt.bind(sm);
			let nudgeCount = 0;
			let reviewerNudgeCount = 0;
			let workerNudgeCount = 0;
			const matchNudge = (msg: string) => /has finished/i.test(msg);
			sm.deliverLiveSteer = async (sid: string, msg: string) => {
				if (sid === teamLeadId && matchNudge(msg)) {
					nudgeCount++;
					if (msg.includes(reviewerId.slice(0, 8))) reviewerNudgeCount++;
					if (msg.includes(workerId.slice(0, 8))) workerNudgeCount++;
				}
				return origSteer(sid, msg);
			};
			sm.enqueuePrompt = (sid: string, msg: string, opts?: any) => {
				if (sid === teamLeadId && matchNudge(msg)) {
					nudgeCount++;
					if (msg.includes(reviewerId.slice(0, 8))) reviewerNudgeCount++;
					if (msg.includes(workerId.slice(0, 8))) workerNudgeCount++;
				}
				return origEnqueue(sid, msg, opts);
			};

			// Shrink the worker-idle nudge debounce to a negligible value so the
			// nudge fires almost immediately and we can assert via fast polling
			// instead of waiting out the real 5s window. (The 5s timing itself is
			// covered deterministically by the unit tests using a logical clock.)
			(teamManager as any).workerIdleNudgeDebounceMs = 20;

			try {
				// Fire agent_end on the reviewer's RPC bridge. With the fix,
				// no listener is wired for reviewer agents → no nudge.
				const reviewerSession = sm.getSession(reviewerId);
				expect(reviewerSession, "reviewer session live").toBeTruthy();
				for (const cb of [...reviewerSession.rpcClient.eventListeners]) {
					try { cb({ type: "agent_end" }); } catch { /* non-fatal */ }
				}

				// Fire agent_end on the worker. Listener is wired → nudge fires
				// after the (shrunk-to-20ms) idle debounce, since no agent_start
				// arrives within the window to cancel it.
				const workerSession = sm.getSession(workerId);
				expect(workerSession, "worker session live").toBeTruthy();
				for (const cb of [...workerSession.rpcClient.eventListeners]) {
					try { cb({ type: "agent_end" }); } catch { /* non-fatal */ }
				}

				// Poll until the worker nudge propagates (debounce ~20ms + the async
				// notifyTeamLead path). The ceiling is just a safety bound — the
				// condition resolves as soon as the nudge lands. Reviewer nudges
				// would land on the same path, so observing the worker nudge implies
				// the reviewer's chance has passed too.
				await waitForCondition(() => workerNudgeCount === 1, {
					timeoutMs: 2_000,
					message: "worker agent_end nudge",
				});

				expect(reviewerNudgeCount, "reviewer agent_end must NOT nudge team lead").toBe(0);
				expect(workerNudgeCount, "worker agent_end must nudge team lead exactly once").toBe(1);
				expect(nudgeCount).toBe(1);
			} finally {
				sm.deliverLiveSteer = origSteer;
				sm.enqueuePrompt = origEnqueue;
			}
		} finally {
			try { await deleteGoal(goalId); } catch { /* ignore */ }
		}
	});

	test("Bug 2: resume gives idle reviewer time to respond to reminder — no instant terminate", async ({ gateway }) => {
		const { sm, harness } = getInternals(gateway);

		const goal = await createGoal({ title: `Resume Bug2 ${Date.now()}`, workflowId: "test-fast" });
		const goalId = goal.id;

		// A real session that will play the role of the resumed reviewer.
		// It will be in `idle` status when the harness picks it up — that's
		// exactly the bug-reproducing condition.
		const reviewerId = await createSession({ goalId });

		try {
			const reviewerSession = sm.getSession(reviewerId);
			expect(reviewerSession, "reviewer session live").toBeTruthy();
			// Reviewer must be idle when the harness picks it up — that's the
			// exact bug-reproducing condition. waitForSessionStatus drives this
			// off the public REST API rather than wall-clock guessing.
			await waitForSessionStatus(reviewerId, "idle");

			// Replace the rpc prompt with a true no-op. This isolates the bug:
			// pre-fix the reminder dispatch is followed by an instant
			// waitForIdle resolution (because the session is still idle), and
			// the harness terminates the session ~46ms later. Post-fix, the
			// harness awaits waitForStreaming(10s) first — with a no-op
			// prompt it times out, then waitForIdle(120s) is pending, so the
			// session stays alive throughout the test window.
			const origPrompt = reviewerSession.rpcClient.prompt.bind(reviewerSession.rpcClient);
			reviewerSession.rpcClient.prompt = async (_text: string) => { /* swallow */ };

			// Seed the persisted active-verifications file pointing at the
			// reviewer session, then re-load the harness's in-memory map by
			// invoking the same resume path as boot.
			const stateDir = path.join(gateway.bobbitDir, "state");
			const persistPath = path.join(stateDir, "active-verifications.json");
			const signalId = `sig-${Date.now()}`;
			const persisted = {
				verifications: [
					{
						goalId,
						gateId: "design-doc",
						signalId,
						overallStatus: "running",
						startedAt: Date.now() - 5_000,
						steps: [
							{
								name: "Code quality review",
								type: "llm-review",
								status: "running",
								startedAt: Date.now() - 5_000,
								sessionId: reviewerId,
							},
						],
					},
				],
			};
			fs.mkdirSync(stateDir, { recursive: true });
			fs.writeFileSync(persistPath, JSON.stringify(persisted, null, 2));

			// Track terminateSession calls so we can assert timing.
			const origTerminate = sm.terminateSession.bind(sm);
			let terminatedAt: number | null = null;
			let terminatedSessionId: string | null = null;
			sm.terminateSession = async (sid: string) => {
				if (sid === reviewerId && terminatedAt === null) {
					terminatedAt = Date.now();
					terminatedSessionId = sid;
				}
				return origTerminate(sid);
			};

			try {
				// Kick off resume. This is the path server.ts takes at boot
				// after restoreTeams + restoreSessions complete.
				const startedAt = Date.now();
				const resumePromise = harness.resumeInterruptedVerifications();

				// Pre-fix bug: the harness dispatched the reminder, raced
				// resultPromise vs waitForIdle(120s), and waitForIdle resolved
				// synchronously because the session was still idle. The
				// `finally` block then called terminateSession ~46ms after
				// the resume began. Assert that does NOT happen — over the next
				// 500ms post-resume the session must still be alive. With the
				// fix the harness is parked inside waitForStreaming(10s); we'd
				// see no terminate until that timeout elapses or we synthesise
				// an agent_start below.
				await assertStaysFalse(() => terminatedAt !== null, {
					durationMs: 500,
					message: `reviewer session ${reviewerId} terminated prematurely (pre-fix bug was ~46ms)`,
				});
				void startedAt;

				// Don't wait for the full waitForStreaming(10s) + waitForIdle(120s)
				// timeout to elapse. Synthesise agent_start/agent_end so both
				// races resolve and _tryResumeFromSession's finally block runs,
				// then poll until the resume promise settles.
				for (const cb of [...reviewerSession.rpcClient.eventListeners]) {
					try { cb({ type: "agent_start" }); } catch { /* non-fatal */ }
				}
				for (const cb of [...reviewerSession.rpcClient.eventListeners]) {
					try { cb({ type: "agent_end" }); } catch { /* non-fatal */ }
				}
				let resumeSettled = false;
				resumePromise.finally(() => { resumeSettled = true; });
				await waitForCondition(() => resumeSettled, {
					timeoutMs: 10_000,
					message: "resumeInterruptedVerifications to settle",
				});
				reviewerSession.rpcClient.prompt = origPrompt;
			} finally {
				sm.terminateSession = origTerminate;
				try { fs.unlinkSync(persistPath); } catch { /* best-effort */ }
			}
		} finally {
			try { await deleteGoal(goalId); } catch { /* ignore */ }
		}
	});
});
