/**
 * API E2E for the verification-lock-after-restart bug (AC#5).
 *
 * Scenario: a command-type verification step is mid-flight when the
 * gateway is SIGKILLed. The persisted `active-verifications.json`
 * survives with `status: "running"`. Pre-fix, the next `gate_signal` on
 * the same commit SHA hit `areVerificationSessionsAlive()`, which
 * fast-pathed to `true` for any persisted-running command step without a
 * `sessionId`, locking the gate behind HTTP 409 forever (the only
 * workaround was an empty commit to change the SHA).
 *
 * We can't truly kill+respawn the in-process gateway from inside a test
 * (the harness is worker-scoped and the server has singletons), so we
 * simulate the post-restart state directly against the live harness:
 *
 *   1. Seed a zombie `ActiveVerification` entry into both the
 *      harness's in-memory map AND `active-verifications.json` on disk,
 *      shaped exactly like what a constructor-load from a previous boot
 *      would produce (no `sessionId`, no live `bootEpoch` match, dead
 *      `pid`). This mirrors the boot sequence in `server.ts` ~line 1130
 *      where `_loadActive()` populates the map.
 *
 *   2. Also seed a matching `GateSignal` in the gateStore with
 *      `commitSha === HEAD` so the duplicate-detection path in
 *      `server.ts:4792` will actually fire on re-signal.
 *
 *   3. Call `harness.resumeInterruptedVerifications()` — the same call
 *      `server.ts` makes during boot. Assert the zombie is removed from
 *      both memory and disk (Layer 2 acceptance criteria 3 & 4).
 *
 *   4. Re-signal the gate via POST /api/goals/:id/gates/:gateId/signal.
 *      Assert: response is 201 (NOT 409), a brand-new signal id is
 *      returned, and a fresh verification is in flight.
 *
 * Pre-fix, this fails at step 3 (zombie still in map, persistence still
 * contains the signalId) and again at step 4 (HTTP 409
 * "Verification already in progress for this commit").
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, createGoal, deleteGoal } from "./e2e-setup.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const SLOW_WORKFLOW_ID = `test-restart-resignal-${Date.now()}`;

/** Create a workflow with one slow command step. */
async function createSlowWorkflow(): Promise<void> {
	const res = await apiFetch("/api/workflows", {
		method: "POST",
		body: JSON.stringify({
			id: SLOW_WORKFLOW_ID,
			name: "Test Restart Resignal",
			description: "Workflow with slow command for restart-resignal tests",
			gates: [
				{
					id: "slow-gate",
					name: "Slow Gate",
					dependsOn: [],
					verify: [
						{
							name: "Slow check",
							type: "command",
							// Long enough that we can intercept mid-flight if needed,
							// but the actual restart-resignal path below never waits
							// on this command — it seeds a fake zombie directly.
							run: 'node -e "setTimeout(()=>{console.log(\'done\');process.exit(0)},5000)"',
						},
					],
				},
			],
		}),
	});
	expect(res.status).toBe(201);
}

async function deleteSlowWorkflow(): Promise<void> {
	await apiFetch(`/api/workflows/${SLOW_WORKFLOW_ID}`, { method: "DELETE" }).catch(() => {});
}

/** Initialize a git repo at `dir` and produce one commit; return HEAD SHA. */
function gitInitWithCommit(dir: string): string {
	fs.mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "--initial-branch=master"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "test@bobbit.local"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "user.name", "test"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir, stdio: "ignore" });
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();
}

/** A pid that is overwhelmingly unlikely to be in use. */
function deadPid(): number {
	// 0x7ffffffe — well above any reasonable PID range on Linux/macOS/Windows.
	return 0x7ffffffe;
}

test.describe("Verification lock after restart — re-signal is accepted", () => {
	test.setTimeout(60_000);

	test.beforeAll(async () => {
		await createSlowWorkflow();
	});

	test.afterAll(async () => {
		await deleteSlowWorkflow();
	});

	test("zombie command verification from previous boot is cleaned up; re-signal at same SHA returns 201", async ({ gateway }) => {
		// 1. Real git repo so `git rev-parse HEAD` returns a real SHA — without
		//    this the duplicate-detection block in server.ts:4792 is skipped
		//    entirely and we wouldn't actually exercise the bug.
		const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "verif-restart-repo-"));
		const headSha = gitInitWithCommit(repoDir);

		const goal = await createGoal({
			title: `Restart Resignal ${Date.now()}`,
			workflowId: SLOW_WORKFLOW_ID,
			worktree: false,
			cwd: repoDir,
		});
		const goalId = goal.id;
		const gateId = "slow-gate";

		const sm = gateway.sessionManager;
		const harness = sm._verificationHarness;
		expect(harness, "verification harness wired on session manager").toBeTruthy();

		// Project-scoped gateStore — same one server.ts uses for duplicate detection.
		const ctx = (sm.getProjectContextManager?.() ?? sm.projectContextManager).getContextForGoal(goalId);
		expect(ctx, "project context for goal").toBeTruthy();
		const gateStore = ctx.gateStore;

		const zombieSignalId = `sig-zombie-${randomUUID()}`;
		const startedAt = Date.now() - 60_000;

		try {
			// 2. Seed gateStore with a running signal at the current HEAD SHA.
			//    This is what would have been persisted by the original (pre-kill)
			//    gate_signal request.
			gateStore.recordSignal({
				id: zombieSignalId,
				goalId,
				gateId,
				sessionId: "unknown",
				timestamp: startedAt,
				commitSha: headSha,
				verification: {
					status: "running",
					startedAt,
					steps: [{ name: "Slow check", type: "command", status: "running", startedAt }],
				},
			});

			// 3. Seed the active-verifications.json file on disk shaped exactly
			//    as the constructor-load path would produce on boot: command-
			//    type step, `status: "running"`, no sessionId, no live pid
			//    binding for THIS process.
			const stateDir = path.join(gateway.bobbitDir, "state");
			const persistPath = path.join(stateDir, "active-verifications.json");
			const zombie = {
				goalId,
				gateId,
				signalId: zombieSignalId,
				overallStatus: "running",
				startedAt,
				currentPhase: 0,
				steps: [
					{
						name: "Slow check",
						type: "command",
						status: "running",
						startedAt,
						// Note: NO sessionId (command steps never have one).
						// pid + startTimeMs are present (production always writes them)
						// but the pid is dead and bootEpoch doesn't match this process,
						// so the alive-check must conclude the process is gone.
						pid: deadPid(),
						startTimeMs: startedAt,
						bootEpoch: "00000000-0000-0000-0000-000000000000", // different from any plausible runtime bootEpoch
						timeoutSec: 300,
					},
				],
			};
			// Merge with any existing persisted state (other tests in this worker
			// may have unrelated entries — preserve them).
			let existing: { verifications?: unknown[] } = { verifications: [] };
			if (fs.existsSync(persistPath)) {
				try { existing = JSON.parse(fs.readFileSync(persistPath, "utf-8")); } catch { /* ignore */ }
			}
			const merged = {
				verifications: [...(existing.verifications ?? []).filter((v: any) => v?.signalId !== zombieSignalId), zombie],
			};
			fs.mkdirSync(stateDir, { recursive: true });
			fs.writeFileSync(persistPath, JSON.stringify(merged, null, 2));

			// 4. Mirror the constructor-load step: add the zombie to the live
			//    in-memory map. This is what `new VerificationHarness(stateDir, ...)`
			//    does at boot (verification-harness.ts ~line 1022).
			harness.activeVerifications.set(zombieSignalId, zombie);

			// Sanity: the duplicate-detection probe ALREADY sees this as dead
			// thanks to the fix (areVerificationSessionsAlive layer-2 floor).
			// Pre-fix, this would have returned true.
			expect(
				harness.areVerificationSessionsAlive(zombieSignalId),
				"areVerificationSessionsAlive must NOT report a previous-boot zombie command step as alive",
			).toBe(false);

			// 5. Run the boot resume path. Post-fix, this synchronously removes
			//    the zombie from `activeVerifications` AND rewrites the
			//    persistence file with it gone.
			await harness.resumeInterruptedVerifications();

			expect(
				harness.activeVerifications.has(zombieSignalId),
				"resumeInterruptedVerifications must remove the zombie from the in-memory map",
			).toBe(false);

			if (fs.existsSync(persistPath)) {
				const raw = fs.readFileSync(persistPath, "utf-8");
				expect(
					raw.includes(zombieSignalId),
					`resumeInterruptedVerifications must purge the zombie from ${persistPath} — otherwise the next boot would reload it`,
				).toBe(false);
			}

			// 6. Re-signal the same gate at the same SHA via the public HTTP API.
			//    Pre-fix: HTTP 409 "Verification already in progress for this commit"
			//    Post-fix: HTTP 201, a brand-new signalId, a fresh verification running.
			const resignal = await apiFetch(`/api/goals/${goalId}/gates/${gateId}/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "Re-signal after simulated restart" }),
			});
			if (resignal.status !== 201) {
				const body = await resignal.text();
				throw new Error(`re-signal expected 201, got ${resignal.status}: ${body}`);
			}
			const resignalBody = await resignal.json();
			const newSignalId = resignalBody?.signal?.id;
			expect(newSignalId, "new signal id returned").toBeTruthy();
			expect(
				newSignalId,
				"re-signal must produce a fresh signal id, not echo the zombie",
			).not.toBe(zombieSignalId);

			// The zombie must not be reachable via the active verifications list
			// any more — either the fresh verification replaced it, or both have
			// already settled (the slow command is short enough that on fast
			// machines it can complete before this assertion runs). What matters
			// is that the zombie signal id is gone.
			const liveActives = harness.getActiveVerifications(goalId);
			expect(
				liveActives.some((v: any) => v.signalId === zombieSignalId),
				"zombie signal must not reappear in active verifications after re-signal",
			).toBe(false);

			// Clean up the slow verification we just kicked off so it doesn't
			// keep running after the test.
			await apiFetch(`/api/goals/${goalId}/gates/${gateId}/cancel-verification`, {
				method: "POST",
			}).catch(() => {});
		} finally {
			try { await deleteGoal(goalId); } catch { /* ignore */ }
			try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});
});
