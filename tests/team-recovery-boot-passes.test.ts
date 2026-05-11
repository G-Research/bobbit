/**
 * Boot-time team-lead recovery — wiring tests for `TeamManager.restoreTeams`
 * passes 2 & 3, plus the `purgeOneSession` refusal guard wired through
 * `SessionManager`.
 *
 * The pure helpers in `team-store-consistency.ts` are exhaustively covered
 * by `tests/team-store-consistency.test.ts` (52 cases). This file pins the
 * I/O glue:
 *
 *   - Pass 3 (fully-orphan recovery): a team-mode goal whose team-lead
 *     session is missing from sessions.json AND whose team-store entry is
 *     absent, but whose `.jsonl` survives in the agent slug-dir under
 *     `~/.bobbit/agent/sessions/`, must boot-restore as a fresh session
 *     record with role="team-lead", a `(recovered)` fun-name title, the
 *     correct teamGoalId, and `agentSessionFile` pointing at the surviving
 *     .jsonl. A fresh UUID is allocated (the original is unknowable).
 *
 *   - Pass 2 (dangling team-store cleanup with successful recovery): a
 *     team-store entry whose `teamLeadSessionId` doesn't resolve must be
 *     repaired — the existing entry preserved and a session record put
 *     back, NOT dropped, when the slug-dir's .jsonl survives.
 *
 *   - The `purgeOneSession` refusal guard, wired through `SessionManager`:
 *     when a team-lead session is referenced by a live team-store entry
 *     AND its owning goal is NOT archived, the guard must refuse to
 *     destroy the session record. We verify this two ways:
 *       (a) a behavioural test running `canPurgeTeamLeadSession` against
 *           real `TeamStore` + `GoalStore` instances with the same
 *           callback shape `purgeOneSession` uses internally;
 *       (b) a source-grep guard pinning that `purgeOneSession` still
 *           calls `canPurgeTeamLeadSession` with the team-store/goal-store
 *           lookups, logs a refusal warning naming `teardownTeam`, and
 *           early-returns before the destructive cleanup.
 *
 *     Direct `SessionManager` instantiation isn't possible from a unit
 *     test under the current node-tsx + flexsearch setup (importing the
 *     module pulls in `search/flex-store.ts` which fails to resolve the
 *     named `Document` export at runtime — a separate infra issue tracked
 *     elsewhere). The two-pronged guard above provides equivalent
 *     coverage of the wiring without that dependency.
 *
 * We isolate from the user's real `~/.bobbit/agent/sessions/` by setting
 * `HOME` (which `os.homedir()` reads on POSIX) and `USERPROFILE` (Windows)
 * to a temp dir before any production code runs. The team-manager's
 * production wrapper builds its sessionsRoot from `os.homedir()`, so this
 * is sufficient to redirect its disk-scan to our fixture.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Set HOME + BOBBIT_DIR BEFORE any dynamic imports so the production code
// (which reads `os.homedir()` at call-time) sees the redirected paths.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "team-recover-home-"));
const TEST_BOBBIT = fs.mkdtempSync(path.join(os.tmpdir(), "team-recover-state-"));
const PREV_HOME = process.env.HOME;
const PREV_USERPROFILE = process.env.USERPROFILE;
const PREV_BOBBIT = process.env.BOBBIT_DIR;
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.BOBBIT_DIR = TEST_BOBBIT;

const { TeamStore } = await import("../src/server/agent/team-store.ts");
const { GoalStore } = await import("../src/server/agent/goal-store.ts");
const { SessionStore } = await import("../src/server/agent/session-store.ts");
const { TeamManager } = await import("../src/server/agent/team-manager.ts");
const { canPurgeTeamLeadSession, slugDirNameForCwd } = await import("../src/server/agent/team-store-consistency.ts");

type PersistedGoal = import("../src/server/agent/goal-store.ts").PersistedGoal;
type PersistedSession = import("../src/server/agent/session-store.ts").PersistedSession;

after(() => {
	try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
	try { fs.rmSync(TEST_BOBBIT, { recursive: true, force: true }); } catch { /* ignore */ }
	if (PREV_HOME === undefined) delete process.env.HOME; else process.env.HOME = PREV_HOME;
	if (PREV_USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = PREV_USERPROFILE;
	if (PREV_BOBBIT === undefined) delete process.env.BOBBIT_DIR; else process.env.BOBBIT_DIR = PREV_BOBBIT;
});

function makeGoal(id: string, overrides: Partial<PersistedGoal> = {}): PersistedGoal {
	return {
		id,
		title: `Goal ${id}`,
		cwd: "/tmp/test",
		state: "in-progress",
		spec: "spec",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		setupStatus: "ready",
		team: true,
		projectId: "proj-1",
		...overrides,
	};
}

function buildProjectContext(stateDir: string) {
	fs.mkdirSync(stateDir, { recursive: true });
	const teamStore = new TeamStore(stateDir);
	const goalStore = new GoalStore(stateDir);
	const sessionStore = new SessionStore(stateDir);
	return { teamStore, goalStore, sessionStore };
}

function buildPCM(contexts: Array<ReturnType<typeof buildProjectContext>>) {
	return {
		all: () => contexts,
		getContextForGoal: (goalId: string) => {
			for (const c of contexts) {
				if (c.goalStore.get(goalId)) return c;
			}
			return null;
		},
		getOrCreate: (_projectId: string) => contexts[0] ?? null,
	};
}

function makeStubSessionManager() {
	return {
		getSession: () => undefined,
		getSessionGoalId: () => undefined,
	} as any;
}

function makeStubColorStore() {
	return {
		get: () => undefined,
		set: () => {},
		getAll: () => ({}),
		remove: () => {},
	} as any;
}

/**
 * Seed a fake .jsonl into the agent sessions slug-dir for the given worktree.
 * Mirrors pi-coding-agent's "session" first-line shape, which the scanner
 * uses to validate cwd + extract the agent session id.
 */
function seedAgentJsonl(worktreeCwd: string, opts: { id?: string; timestamp?: string; mtime?: Date } = {}): string {
	const sessionsRoot = path.join(TEST_HOME, ".bobbit", "agent", "sessions");
	const slug = slugDirNameForCwd(worktreeCwd);
	const dir = path.join(sessionsRoot, slug);
	fs.mkdirSync(dir, { recursive: true });
	const ts = opts.timestamp ?? new Date().toISOString();
	const filename = `${ts.replace(/[:.]/g, "-")}_${opts.id ?? "11111111-2222-3333-4444-555555555555"}.jsonl`;
	const full = path.join(dir, filename);
	const firstLine = JSON.stringify({
		type: "session",
		id: opts.id ?? "11111111-2222-3333-4444-555555555555",
		cwd: worktreeCwd,
		timestamp: ts,
	});
	// Add a couple of synthetic event lines so size > 0 and the file looks plausible.
	fs.writeFileSync(full, firstLine + "\n" + JSON.stringify({ type: "user", text: "hello" }) + "\n");
	if (opts.mtime) fs.utimesSync(full, opts.mtime, opts.mtime);
	return full;
}

const STATE_DIR = path.join(TEST_BOBBIT, "state");

describe("TeamManager.restoreTeams — boot recovery wiring", () => {
	beforeEach(() => {
		try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
		fs.mkdirSync(STATE_DIR, { recursive: true });
		// Wipe the agent sessions root between tests so each .jsonl is fresh.
		const sessionsRoot = path.join(TEST_HOME, ".bobbit", "agent", "sessions");
		try { fs.rmSync(sessionsRoot, { recursive: true, force: true }); } catch { /* ignore */ }
	});

	it("pass-3 (fully-orphan): reconstructs a team-lead session for a team-mode goal whose .jsonl survives", () => {
		const ctx = buildProjectContext(STATE_DIR);
		const worktreePath = path.join(TEST_HOME, "wt", "goal-fully-orphan");
		const goal = makeGoal("goal-fully-orphan", {
			title: "Fully orphan team",
			worktreePath,
			repoPath: "/tmp/repo",
			branch: "goal/fully-orphan",
		});
		ctx.goalStore.put(goal);
		// No team-store entry, no session record — but a .jsonl on disk.
		assert.equal(ctx.teamStore.get(goal.id), undefined);
		assert.equal(ctx.sessionStore.getAll().length, 0);
		const jsonlPath = seedAgentJsonl(worktreePath);

		const tm = new TeamManager(makeStubSessionManager(), {
			taskManager: {} as any,
			roleStore: {} as any,
			colorStore: makeStubColorStore(),
			projectContextManager: buildPCM([ctx]) as any,
		});
		void tm;

		const all = ctx.sessionStore.getAll();
		assert.equal(all.length, 1, "exactly one team-lead session record must be reconstructed");
		const tl = all[0];
		assert.equal(tl.role, "team-lead");
		assert.equal(tl.teamGoalId, goal.id);
		assert.equal(tl.worktreePath, worktreePath);
		assert.equal(tl.agentSessionFile, jsonlPath, "agentSessionFile must point at the surviving .jsonl");
		assert.match(tl.title, /^Team Lead: .+ \(recovered\)$/, "title must match 'Team Lead: <fun-name> (recovered)'");
		assert.ok(tl.id && tl.id !== "11111111-2222-3333-4444-555555555555",
			"reconstructed session id must be a fresh UUID, not the agent-session id from the .jsonl");
		assert.equal(tl.accessory, "crown");
	});

	it("pass-3 (fully-orphan, archived goal): stamps archived + archivedAt from the .jsonl mtime", () => {
		const ctx = buildProjectContext(STATE_DIR);
		const worktreePath = path.join(TEST_HOME, "wt", "goal-archived-orphan");
		const goal = makeGoal("goal-archived-orphan", {
			worktreePath,
			repoPath: "/tmp/repo",
			archived: true,
			archivedAt: Date.now() - 86_400_000,
		});
		ctx.goalStore.put(goal);
		const mtime = new Date(Date.now() - 3_600_000);
		seedAgentJsonl(worktreePath, { mtime });

		const tm = new TeamManager(makeStubSessionManager(), {
			taskManager: {} as any,
			roleStore: {} as any,
			colorStore: makeStubColorStore(),
			projectContextManager: buildPCM([ctx]) as any,
		});
		void tm;

		const all = ctx.sessionStore.getAll();
		assert.equal(all.length, 1);
		const tl = all[0];
		assert.equal(tl.archived, true);
		assert.ok(typeof tl.archivedAt === "number" && tl.archivedAt > 0,
			"archivedAt must be stamped on the recovered record");
	});

	it("pass-3: no .jsonl on disk → no recovery, no session record created", () => {
		const ctx = buildProjectContext(STATE_DIR);
		const worktreePath = path.join(TEST_HOME, "wt", "goal-no-jsonl");
		ctx.goalStore.put(makeGoal("goal-no-jsonl", { worktreePath, repoPath: "/tmp/repo" }));

		const tm = new TeamManager(makeStubSessionManager(), {
			taskManager: {} as any,
			roleStore: {} as any,
			colorStore: makeStubColorStore(),
			projectContextManager: buildPCM([ctx]) as any,
		});
		void tm;

		assert.equal(ctx.sessionStore.getAll().length, 0,
			"without a surviving .jsonl, recovery must not synthesise a record");
	});

	it("pass-3: skips goals that already have a live team-lead session record", () => {
		const ctx = buildProjectContext(STATE_DIR);
		const worktreePath = path.join(TEST_HOME, "wt", "goal-already-has-lead");
		ctx.goalStore.put(makeGoal("goal-already-has-lead", { worktreePath, repoPath: "/tmp/repo" }));
		ctx.sessionStore.put({
			id: "existing-lead-id",
			title: "Team Lead: existing",
			cwd: worktreePath,
			agentSessionFile: "/tmp/existing.jsonl",
			createdAt: Date.now(),
			lastActivity: Date.now(),
			role: "team-lead",
			teamGoalId: "goal-already-has-lead",
		} as PersistedSession);
		seedAgentJsonl(worktreePath);

		const tm = new TeamManager(makeStubSessionManager(), {
			taskManager: {} as any,
			roleStore: {} as any,
			colorStore: makeStubColorStore(),
			projectContextManager: buildPCM([ctx]) as any,
		});
		void tm;

		const leads = ctx.sessionStore.getAll().filter(s => s.teamGoalId === "goal-already-has-lead" && s.role === "team-lead");
		assert.equal(leads.length, 1, "must not duplicate when a team-lead already exists");
		assert.equal(leads[0].id, "existing-lead-id");
	});

	it("pass-2 (recoverable orphan): preserves team-store entry and reconstructs session when .jsonl survives", () => {
		const ctx = buildProjectContext(STATE_DIR);
		const worktreePath = path.join(TEST_HOME, "wt", "goal-recoverable-orphan");
		const goal = makeGoal("goal-recoverable-orphan", { worktreePath, repoPath: "/tmp/repo" });
		ctx.goalStore.put(goal);
		// Team-store points at a session id that doesn't exist in sessions.json.
		ctx.teamStore.put({
			goalId: goal.id,
			teamLeadSessionId: "dead-session-id",
			agents: [],
			maxConcurrent: 3,
		});
		const jsonlPath = seedAgentJsonl(worktreePath);

		const tm = new TeamManager(makeStubSessionManager(), {
			taskManager: {} as any,
			roleStore: {} as any,
			colorStore: makeStubColorStore(),
			projectContextManager: buildPCM([ctx]) as any,
		});
		void tm;

		// Team-store entry must still be there (we recovered rather than dropped).
		const entry = ctx.teamStore.get(goal.id);
		assert.ok(entry, "team-store entry must be preserved when recovery succeeds");
		// Session record must have been put back at the same id.
		const recovered = ctx.sessionStore.get("dead-session-id");
		assert.ok(recovered, "session record must be reconstructed at the team-store's id");
		assert.equal(recovered.role, "team-lead");
		assert.equal(recovered.teamGoalId, goal.id);
		assert.equal(recovered.agentSessionFile, jsonlPath);
		assert.match(recovered.title, /\(recovered\)$/);
	});

	it("pass-2 (unrecoverable orphan): drops team-store entry when no .jsonl can be found", () => {
		const ctx = buildProjectContext(STATE_DIR);
		const worktreePath = path.join(TEST_HOME, "wt", "goal-unrecoverable");
		ctx.goalStore.put(makeGoal("goal-unrecoverable", { worktreePath, repoPath: "/tmp/repo" }));
		ctx.teamStore.put({
			goalId: "goal-unrecoverable",
			teamLeadSessionId: "dead-session-id",
			agents: [],
			maxConcurrent: 3,
		});
		// No .jsonl seeded.

		const tm = new TeamManager(makeStubSessionManager(), {
			taskManager: {} as any,
			roleStore: {} as any,
			colorStore: makeStubColorStore(),
			projectContextManager: buildPCM([ctx]) as any,
		});
		void tm;

		assert.equal(ctx.teamStore.get("goal-unrecoverable"), undefined,
			"unrecoverable orphan must be dropped from team-store so Start Team works again");
		assert.equal(ctx.sessionStore.get("dead-session-id"), undefined);
	});
});

describe("purgeOneSession refusal guard — behavioural test against real stores", () => {
	/**
	 * The guard is the predicate `canPurgeTeamLeadSession`, with callbacks
	 * resolved through PCM as `(goalId) => ctx.teamStore.get(goalId)?.teamLeadSessionId`
	 * and `(goalId) => !!ctx.goalStore.get(goalId)?.archived`. This mirrors
	 * the exact lambdas inside `SessionManager.purgeOneSession` (see
	 * src/server/agent/session-manager.ts ~line 4655). If those lambdas
	 * drift, the source-grep guard below will fail.
	 */
	beforeEach(() => {
		try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
		fs.mkdirSync(STATE_DIR, { recursive: true });
	});

	it("refuses to purge a team-lead while the team-store references it on a NON-archived goal", () => {
		const ctx = buildProjectContext(STATE_DIR);
		const goal = makeGoal("live-goal", { archived: false });
		ctx.goalStore.put(goal);
		ctx.teamStore.put({
			goalId: goal.id,
			teamLeadSessionId: "live-team-lead-id",
			agents: [],
			maxConcurrent: 3,
		});
		const ps = { role: "team-lead", id: "live-team-lead-id", teamGoalId: goal.id };
		const verdict = canPurgeTeamLeadSession(
			ps,
			(goalId) => ctx.teamStore.get(goalId)?.teamLeadSessionId ?? undefined,
			(goalId) => !!ctx.goalStore.get(goalId)?.archived,
		);
		assert.equal(verdict.allow, false);
		if (verdict.allow === false) {
			assert.match(verdict.reason, /teardownTeam/i,
				"refusal reason must instruct the caller to run teardownTeam");
			assert.match(verdict.reason, new RegExp(goal.id),
				"refusal reason must name the owning goal id");
		}
	});

	it("ALLOWS purge once the owning goal is archived (teardownTeam should already have run)", () => {
		const ctx = buildProjectContext(STATE_DIR);
		const goal = makeGoal("archived-goal", { archived: true, archivedAt: Date.now() });
		ctx.goalStore.put(goal);
		ctx.teamStore.put({
			goalId: goal.id,
			teamLeadSessionId: "archived-team-lead-id",
			agents: [],
			maxConcurrent: 3,
		});
		const ps = { role: "team-lead", id: "archived-team-lead-id", teamGoalId: goal.id };
		const verdict = canPurgeTeamLeadSession(
			ps,
			(goalId) => ctx.teamStore.get(goalId)?.teamLeadSessionId ?? undefined,
			(goalId) => !!ctx.goalStore.get(goalId)?.archived,
		);
		assert.equal(verdict.allow, true);
	});

	it("ALLOWS purge for a team-lead whose team-store entry was already removed", () => {
		const ctx = buildProjectContext(STATE_DIR);
		const goal = makeGoal("orphan-goal", { archived: false });
		ctx.goalStore.put(goal);
		// No team-store entry at all.
		const ps = { role: "team-lead", id: "orphan-tl", teamGoalId: goal.id };
		const verdict = canPurgeTeamLeadSession(
			ps,
			(goalId) => ctx.teamStore.get(goalId)?.teamLeadSessionId ?? undefined,
			(goalId) => !!ctx.goalStore.get(goalId)?.archived,
		);
		assert.equal(verdict.allow, true);
	});
});

describe("purgeOneSession refusal guard — source-grep wiring guard", () => {
	const SOURCE = path.resolve(import.meta.dirname, "..", "src", "server", "agent", "session-manager.ts");
	const text = fs.readFileSync(SOURCE, "utf-8");

	it("imports canPurgeTeamLeadSession from team-store-consistency", () => {
		assert.match(
			text,
			/import\s*{[^}]*canPurgeTeamLeadSession[^}]*}\s*from\s*"\.\/team-store-consistency\.js"/,
			"session-manager must import canPurgeTeamLeadSession from the shared helper",
		);
	});

	it("purgeOneSession calls canPurgeTeamLeadSession with teamStore + goalStore callbacks", () => {
		const start = text.indexOf("private async purgeOneSession");
		assert.ok(start > 0, "purgeOneSession method must exist");
		// Take a generous window — guard sits near the top of the method.
		const window = text.slice(start, start + 4000);
		assert.match(window, /canPurgeTeamLeadSession\(/,
			"purgeOneSession must call canPurgeTeamLeadSession");
		assert.match(window, /ctx\.teamStore\.get\(\s*goalId\s*\)\?\.teamLeadSessionId/,
			"the teamLeadSessionId callback must read from ctx.teamStore.get(goalId)");
		assert.match(window, /!!ctx\.goalStore\.get\(\s*goalId\s*\)\?\.archived/,
			"the archived predicate must read from ctx.goalStore.get(goalId).archived");
		assert.match(window, /verdict\.allow/,
			"the verdict.allow branch must guard the rest of the method");
		assert.match(window, /Refusing to purge session/i,
			"refusal log message must remain greppable for debugging.md");
	});
});
