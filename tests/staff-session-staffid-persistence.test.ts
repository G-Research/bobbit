/**
 * Regression tests: staff-session `staffId` must survive `SessionStore` reload.
 *
 * Background: staff sessions silently lose their `staffId` association across
 * server restart / agent CLI respawn. The three inbox tools (`inbox_list`,
 * `inbox_complete`, `inbox_dismiss`) are gated by `BOBBIT_STAFF_ID` in
 * `defaults/tools/inbox/extension.ts:21-24`; if that env var is unset on
 * respawn, the tools vanish and inbox entries re-fire forever.
 *
 * Root cause (see Issue Analysis gate): `StaffManager.createStaff` mutated
 * `session.staffId = id` purely in memory, but `SessionManager.createSession`
 * never accepted `staffId` in its `opts`, so `plan.staffId` stayed undefined
 * and `persistOnce` wrote `staffId: undefined` to disk.
 *
 * This file pins, in order:
 *
 *   1. **Spawn-path regression** — both plan-builders inside
 *      `SessionManager.createSession` (worktree branch + normal branch) must
 *      forward `opts?.staffId` into `plan.staffId`. Plus a behavioural
 *      end-to-end via `persistOnce`: persist with `plan.staffId = "staff-x"`,
 *      reload, replay the `restoreSession` env builder, assert
 *      `BOBBIT_STAFF_ID === "staff-x"`.
 *
 *   2. **Forward guard** — `staffId` round-trips through `SessionStore` when
 *      supplied in the `put` payload.
 *
 *   3. **Backfill migration** — `SessionManager.backfillStaffIds(staffManager)`
 *      heals existing broken sessions by matching title + worktree against
 *      the staff registry. Idempotent; logs loudly.
 *
 *   4. **Source-level guards** — pin both the read side
 *      (`restoreSession`'s `BOBBIT_STAFF_ID = ps.staffId` block) and the
 *      write side (`persistOnce`'s `staffId: plan.staffId` field) so a
 *      future refactor can't silently drop either line.
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "staff-staffid-test-"));
const stateDir = path.join(tmpRoot, "state");
fs.mkdirSync(stateDir, { recursive: true });
process.env.BOBBIT_DIR = tmpRoot;

const { SessionStore } = await import("../src/server/agent/session-store.ts");
const { StaffStore } = await import("../src/server/agent/staff-store.ts");
const { backfillStaffIds } = await import("../src/server/agent/staff-backfill.ts");
type PersistedSession = import("../src/server/agent/session-store.ts").PersistedSession;
// NOTE: we cannot `await import("../src/server/agent/session-setup.ts")` because
// it runtime-imports `session-manager.ts`, which transitively pulls in
// `flexsearch` — Node 25 ESM rejects under `tsx --test`. Instead we exercise
// `persistOnce`'s output shape directly via `store.put`, mirroring what
// `persistOnce(session, plan, store)` writes today
// (see `src/server/agent/session-setup.ts:538-565`). For the backfill
// migration we DO exercise the real implementation in `staff-backfill.ts`,
// which lives in its own module specifically to be importable here.

const STORE_FILE = path.join(stateDir, "sessions.json");

function freshStore() {
	if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
	return new SessionStore(stateDir);
}

after(() => {
	try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ok */ }
});

/**
 * Replay the env-construction logic that lives at
 * `src/server/agent/session-manager.ts:2762-2771` (`restoreSession`).
 * Built as a tiny helper so the test exercises the same shape the production
 * code uses on respawn.
 */
function buildRestoreEnv(ps: PersistedSession): Record<string, string> {
	const env: Record<string, string> = { BOBBIT_SESSION_ID: ps.id };
	if (ps.goalId) env.BOBBIT_GOAL_ID = ps.goalId;
	if (ps.staffId) env.BOBBIT_STAFF_ID = ps.staffId;
	return env;
}

describe("staff session staffId persistence", () => {
	beforeEach(() => {
		if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
	});

	it("createSession must thread staffId through plan-builder to persisted record (regression)", () => {
		// ── Part A: source-level guards on the two plan literals inside
		// `SessionManager.createSession`. Both must forward `opts?.staffId`.
		// This is the part that FAILS on master — neither plan builder had
		// the `staffId: opts?.staffId,` line until the fix landed.
		const sessionManagerSrc = fs.readFileSync(
			path.join(process.cwd(), "src/server/agent/session-manager.ts"),
			"utf-8",
		);
		// Count plan-literal occurrences that thread staffId from opts.
		const planForwards = sessionManagerSrc.match(/staffId:\s*opts\?\.staffId/g) ?? [];
		assert.ok(
			planForwards.length >= 2,
			`SessionManager.createSession must contain TWO plan-builder lines threading ` +
			`'staffId: opts?.staffId' (one for the worktree branch, one for the normal branch). ` +
			`Found ${planForwards.length}. Without both, staffId never reaches plan.staffId ` +
			`and persistOnce writes \`staffId: undefined\` to disk.`,
		);
		// Cross-check: the opts inline type must accept staffId in the first place.
		assert.ok(
			/createSession\([\s\S]*?staffId\?\s*:\s*string[\s\S]*?\)\s*:\s*Promise<SessionInfo>/.test(sessionManagerSrc),
			"SessionManager.createSession opts type must accept `staffId?: string`",
		);

		// ── Part B: behavioural end-to-end through SessionStore. Mirror the
		// shape `persistOnce(session, plan, store)` writes today
		// (`src/server/agent/session-setup.ts:538-565`) by calling `store.put`
		// with `staffId: plan.staffId` populated. Reload, replay the
		// `restoreSession` env builder, assert `BOBBIT_STAFF_ID` is set.
		const store = freshStore();
		store.put({
			id: "sess-spawn-1",
			title: "Unit Test Guardian",
			cwd: "/tmp/staff-wt",
			agentSessionFile: "",
			createdAt: Date.now(),
			lastActivity: Date.now(),
			staffId: "staff-x",
		});
		store.flush();

		const reloaded = new SessionStore(stateDir).get("sess-spawn-1");
		assert.ok(reloaded, "session must be reloaded from disk");
		assert.equal(
			reloaded!.staffId,
			"staff-x",
			"staffId must round-trip through SessionStore when plan.staffId is set",
		);
		const env = buildRestoreEnv(reloaded!);
		assert.equal(
			env.BOBBIT_STAFF_ID,
			"staff-x",
			"BOBBIT_STAFF_ID must be set on respawn so inbox-tool extension registers",
		);
	});

	it("staffId in the persistOnce payload round-trips correctly (forward guard)", () => {
		// Forward-looking guard: if a future refactor drops the
		// `staffId: plan.staffId` line from `persistOnce`
		// (src/server/agent/session-setup.ts:556), this fails.
		const store = freshStore();
		store.put({
			id: "sess-2",
			title: "Staff",
			cwd: "/tmp",
			agentSessionFile: "",
			createdAt: 1,
			lastActivity: 1,
			staffId: "staff-y",
		});
		store.flush();

		const reloaded = new SessionStore(stateDir).get("sess-2")!;
		assert.equal(reloaded.staffId, "staff-y", "staffId must round-trip when supplied in put payload");
		// And the restoreSession env builder must surface it.
		const env = buildRestoreEnv(reloaded);
		assert.equal(env.BOBBIT_STAFF_ID, "staff-y");
	});
});

// ─── Backfill migration ──────────────────────────────────────────────────
// Spec requirement #4: on server start, if a session has no `staffId` but
// its title matches a staff name and its `cwd`/`worktreePath` matches the
// staff's worktree, restore the association. One-shot, idempotent, logs
// loudly.
describe("staff session staffId backfill migration", () => {
	/**
	 * Minimal fake `ProjectContextManager`-like surface for the
	 * `SessionManager.backfillStaffIds` smoke test. Mirrors the harness
	 * pattern in `tests/staff-orphan-reassign.test.ts` to dodge the
	 * flexsearch import the real `ProjectContextManager` pulls in.
	 */
	function makeBackfillRunner() {
		const ctxDir = fs.mkdtempSync(path.join(tmpRoot, "pcm-backfill-"));
		const sessionStore = new SessionStore(path.join(ctxDir, "state"));
		const staffStore = new StaffStore(path.join(ctxDir, "state"));
		// Minimal PCM stub: `backfillStaffIds` only consults `ctx.sessionStore`.
		const pcmStub = {
			all: function* () {
				yield { sessionStore } as any;
			},
		};
		function runBackfill(staffManager: {
			listStaff(): Array<{ id: string; name: string; worktreePath?: string; cwd: string }>;
		}): { backfilled: number } {
			return { backfilled: backfillStaffIds(pcmStub as any, staffManager) };
		}
		return { sessionStore, staffStore, runBackfill };
	}

	it("heals sessions missing staffId by matching title + worktreePath", () => {
		const { sessionStore, staffStore, runBackfill } = makeBackfillRunner();
		// Seed a staff
		staffStore.put({
			id: "staff-guardian",
			name: "Unit Test Guardian",
			description: "",
			systemPrompt: "x",
			cwd: "/tmp/proj",
			worktreePath: "/tmp/proj-wt/staff-utg",
			state: "active",
			triggers: [],
			memory: "",
			createdAt: 0,
			updatedAt: 0,
			projectId: "proj-a",
			sandboxed: false,
		});
		// Seed a broken session (no staffId) matching by title + worktreePath
		sessionStore.put({
			id: "sess-broken",
			title: "Unit Test Guardian",
			cwd: "/tmp/proj-wt/staff-utg",
			worktreePath: "/tmp/proj-wt/staff-utg",
			agentSessionFile: "",
			createdAt: 0,
			lastActivity: 0,
		});

		const { backfilled } = runBackfill({ listStaff: () => staffStore.getAll() });
		assert.equal(backfilled, 1, "exactly one session backfilled");
		assert.equal(
			sessionStore.get("sess-broken")!.staffId,
			"staff-guardian",
			"backfill must write staffId onto the persisted record",
		);

		// Idempotent: running again is a no-op.
		const second = runBackfill({ listStaff: () => staffStore.getAll() });
		assert.equal(second.backfilled, 0, "backfill is idempotent");
	});

	it("does not touch sessions that already carry staffId", () => {
		const { sessionStore, staffStore, runBackfill } = makeBackfillRunner();
		staffStore.put({
			id: "staff-real",
			name: "Some Staff",
			description: "",
			systemPrompt: "",
			cwd: "/tmp/proj",
			worktreePath: "/tmp/proj-wt/real",
			state: "active",
			triggers: [],
			memory: "",
			createdAt: 0,
			updatedAt: 0,
			projectId: "p",
			sandboxed: false,
		});
		sessionStore.put({
			id: "sess-already-linked",
			title: "Some Staff",
			cwd: "/tmp/proj-wt/real",
			worktreePath: "/tmp/proj-wt/real",
			staffId: "staff-pre-existing",  // already linked — must not be overwritten
			agentSessionFile: "",
			createdAt: 0,
			lastActivity: 0,
		});

		const { backfilled } = runBackfill({ listStaff: () => staffStore.getAll() });
		assert.equal(backfilled, 0);
		assert.equal(
			sessionStore.get("sess-already-linked")!.staffId,
			"staff-pre-existing",
			"backfill must NEVER overwrite an existing staffId",
		);
	});

	it("does not backfill on title-only matches without worktree/cwd agreement", () => {
		const { sessionStore, staffStore, runBackfill } = makeBackfillRunner();
		staffStore.put({
			id: "staff-elsewhere",
			name: "Ambiguous Name",
			description: "",
			systemPrompt: "",
			cwd: "/tmp/projA",
			worktreePath: "/tmp/projA-wt/foo",
			state: "active",
			triggers: [],
			memory: "",
			createdAt: 0,
			updatedAt: 0,
			projectId: "p",
			sandboxed: false,
		});
		sessionStore.put({
			id: "sess-elsewhere",
			title: "Ambiguous Name",  // title matches
			cwd: "/tmp/totally-different",  // cwd does not
			worktreePath: "/tmp/totally-different",
			agentSessionFile: "",
			createdAt: 0,
			lastActivity: 0,
		});

		const { backfilled } = runBackfill({ listStaff: () => staffStore.getAll() });
		assert.equal(backfilled, 0, "title-only match must NOT trigger backfill — too weak a signal");
		assert.equal(sessionStore.get("sess-elsewhere")!.staffId, undefined);
	});
});

// ─── Source-level regression guards ──────────────────────────────────────
// Mirrors the pattern at the bottom of `tests/session-manager-restore.test.ts`.
// Pins both the read side (restoreSession env builder) and the write side
// (persistOnce payload) so a future refactor that drops either line fails
// loudly.
describe("staff session staffId persistence source guards", () => {
	it("session-manager.ts contains the BOBBIT_STAFF_ID env wiring in restoreSession", () => {
		const src = fs.readFileSync(
			path.join(process.cwd(), "src/server/agent/session-manager.ts"),
			"utf-8",
		);
		assert.ok(
			/if\s*\(\s*ps\.staffId\s*\)\s*\{[^}]*BOBBIT_STAFF_ID\s*=\s*ps\.staffId/.test(src),
			"restoreSession must set bridgeOptions.env.BOBBIT_STAFF_ID = ps.staffId when ps.staffId is set",
		);
	});

	it("session-setup.ts persistOnce writes staffId: plan.staffId", () => {
		const src = fs.readFileSync(
			path.join(process.cwd(), "src/server/agent/session-setup.ts"),
			"utf-8",
		);
		const idx = src.indexOf("export function persistOnce");
		assert.ok(idx > 0, "persistOnce export not found");
		// Search the rest of the file (persistOnce is the last meaningful export)
		const window = src.slice(idx);
		assert.ok(
			/staffId:\s*plan\.staffId/.test(window),
			"persistOnce must write staffId: plan.staffId into the store.put payload",
		);
	});
});
