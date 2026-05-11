/**
 * Integration test for sidecar-driven exact recovery.
 *
 * Scenario:
 *   1. A team-mode goal exists with a worktree path.
 *   2. The bobbit session record was lost from `sessions.json` (sessionStore
 *      has no entry for the team-lead).
 *   3. The team-store still references a `teamLeadSessionId`.
 *   4. The agent's `.jsonl` and its bobbit-owned `.bobbit.json` sidecar
 *      survive in `~/.bobbit/agent/sessions/<slug>/`.
 *
 * Expectation: `restoreTeams` reconstructs a session record whose
 * `id` and `title` match the ORIGINAL values from the sidecar — NOT a
 * freshly-rolled UUID + fun-name from the heuristic fallback.
 *
 * We override HOME so the production wrapper's `os.homedir()` resolves to a
 * scratch dir we can stage with the agent slug-dir structure.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-sidecar-recovery-home-"));
const TMP_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-sidecar-recovery-state-"));
const TMP_WT = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-sidecar-recovery-wt-"));
const ORIGINAL_HOME = os.homedir();

// Override HOME *before* importing modules — TeamManager binds os.homedir()
// at scan time, so it'll re-read each call.
process.env.HOME = TMP_HOME;
process.env.BOBBIT_DIR = TMP_STATE;

const { TeamStore } = await import("../src/server/agent/team-store.ts");
const { GoalStore } = await import("../src/server/agent/goal-store.ts");
const { SessionStore } = await import("../src/server/agent/session-store.ts");
const { TeamManager } = await import("../src/server/agent/team-manager.ts");
const { writeSessionSidecar } = await import("../src/server/agent/session-sidecar.ts");
type SessionSidecar = import("../src/server/agent/session-sidecar.ts").SessionSidecar;
const { slugDirNameForCwd } = await import("../src/server/agent/team-store-consistency.ts");

function buildProjectContext(stateDir: string) {
	const teamStore = new TeamStore(stateDir);
	const goalStore = new GoalStore(stateDir);
	const sessionStore = new SessionStore(stateDir);
	return { teamStore, goalStore, sessionStore };
}

function buildPCM(contexts: Array<ReturnType<typeof buildProjectContext>>) {
	return {
		all: () => contexts,
		getContextForGoal: (goalId: string) => {
			for (const c of contexts) if (c.goalStore.get(goalId)) return c;
			return undefined;
		},
	};
}

const makeStubSessionManager = () => ({ getSession: () => undefined, getSessionGoalId: () => undefined }) as any;

describe("sidecar-driven exact recovery", () => {
	after(() => {
		process.env.HOME = ORIGINAL_HOME;
		try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
		try { fs.rmSync(TMP_STATE, { recursive: true, force: true }); } catch { /* ignore */ }
		try { fs.rmSync(TMP_WT, { recursive: true, force: true }); } catch { /* ignore */ }
	});

	it("orphan team-lead recovery prefers sidecar over heuristic — original id + title preserved", () => {
		// Stage:
		//   - HOME/.bobbit/agent/sessions/<slug>/<agent-id>.jsonl  ← session-line-0 with cwd matching worktree
		//   - HOME/.bobbit/agent/sessions/<slug>/<agent-id>.bobbit.json  ← sidecar with original bobbit metadata
		//   - GoalStore has a team-mode goal whose worktreePath points at TMP_WT
		//   - TeamStore has a team entry pointing at the ORIGINAL bobbit session id
		//   - SessionStore is empty (the lossy event we're recovering from)
		const worktreePath = path.join(TMP_WT, "goal-real-goal-12345678");
		fs.mkdirSync(worktreePath, { recursive: true });

		const slug = slugDirNameForCwd(worktreePath);
		const slugDir = path.join(TMP_HOME, ".bobbit", "agent", "sessions", slug);
		fs.mkdirSync(slugDir, { recursive: true });

		const agentSessionId = "agent-abc-123";
		const jsonlPath = path.join(slugDir, `${agentSessionId}.jsonl`);
		const firstLine = JSON.stringify({
			type: "session",
			id: agentSessionId,
			cwd: worktreePath,
			timestamp: new Date("2024-01-01T00:00:00Z").toISOString(),
		});
		fs.writeFileSync(jsonlPath, firstLine + "\n");

		// Original bobbit session id and title — these are what the sidecar
		// preserves and what the recovery should restore exactly.
		const ORIGINAL_BOBBIT_ID = "11111111-2222-3333-4444-555555555555";
		const ORIGINAL_TITLE = "Team Lead: Calcifer Springer";
		const ORIGINAL_CREATED_AT = 1700000000000;

		const sidecar: SessionSidecar = {
			version: 1,
			bobbitSessionId: ORIGINAL_BOBBIT_ID,
			agentSessionId,
			role: "team-lead",
			teamGoalId: "real-goal",
			title: ORIGINAL_TITLE,
			accessory: "crown",
			createdAt: ORIGINAL_CREATED_AT,
			modelProvider: "anthropic",
			modelId: "claude-sonnet-4",
		};
		writeSessionSidecar(jsonlPath, sidecar);

		// Stage stores
		const ctx = buildProjectContext(TMP_STATE);
		ctx.goalStore.put({
			id: "real-goal",
			title: "Real Goal",
			cwd: worktreePath,
			state: "in-progress",
			spec: "spec",
			createdAt: ORIGINAL_CREATED_AT,
			updatedAt: ORIGINAL_CREATED_AT,
			setupStatus: "ready",
			team: true,
			worktreePath,
			repoPath: TMP_WT,
			branch: "goal/real-goal-12345678",
			projectId: "proj-1",
			archived: false,
		} as any);
		// Team-store points at the ORIGINAL bobbit id (so this exercises the
		// second-pass orphan-team-lead recovery path, not the third pass).
		ctx.teamStore.put({
			goalId: "real-goal",
			teamLeadSessionId: ORIGINAL_BOBBIT_ID,
			agents: [],
			maxConcurrent: 3,
		} as any);
		// SessionStore intentionally empty — the lossy event we're recovering from.

		// Drive restoreTeams
		const tm = new TeamManager(makeStubSessionManager(), {
			taskManager: {} as any,
			roleStore: {} as any,
			colorStore: { get: () => undefined, set: () => {}, getAll: () => ({}) } as any,
			projectContextManager: buildPCM([ctx]) as any,
		});
		void tm;

		// Assert: a session record was reconstructed AND it has the original
		// bobbit id + title (NOT a fresh UUID + fun-name).
		const recovered = ctx.sessionStore.get(ORIGINAL_BOBBIT_ID);
		assert.ok(recovered, "session record must be present under the ORIGINAL bobbit id");
		assert.equal(recovered!.id, ORIGINAL_BOBBIT_ID, "id must be the original bobbit id from the sidecar");
		assert.equal(recovered!.title, ORIGINAL_TITLE, "title must be the original from the sidecar (not 'Team Lead: <funname> (recovered)')");
		assert.equal(recovered!.createdAt, ORIGINAL_CREATED_AT, "createdAt must come from the sidecar");
		assert.equal((recovered as any).modelProvider, "anthropic", "modelProvider must come from the sidecar");
		assert.equal((recovered as any).modelId, "claude-sonnet-4", "modelId must come from the sidecar");
		assert.equal(recovered!.role, "team-lead");
		// Team-store entry is preserved untouched.
		assert.ok(ctx.teamStore.get("real-goal"), "team-store entry must be preserved");
	});
});
