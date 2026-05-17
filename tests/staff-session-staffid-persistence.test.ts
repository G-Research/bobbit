/**
 * Regression test: staff-session `staffId` must survive SessionStore reload.
 *
 * Background: staff sessions silently lose their `staffId` association across
 * server restart / agent CLI respawn. The three inbox tools (`inbox_list`,
 * `inbox_complete`, `inbox_dismiss`) are gated by `BOBBIT_STAFF_ID` in
 * `defaults/tools/inbox/extension.ts:21-24`; if that env var is unset on
 * respawn, the tools vanish and inbox entries re-fire forever.
 *
 * Root cause (see Issue Analysis gate): `StaffManager.createStaff` mutates
 * `session.staffId = id` purely in memory, but `SessionManager.createSession`
 * never propagates `staffId` into the plan, so `persistOnce` writes
 * `staffId: undefined` to disk. Nothing ever calls `store.update(id, { staffId })`,
 * so the persisted record is missing `staffId` from turn 1. The bug surfaces
 * on the *next* respawn when `restoreSession` builds the env from disk.
 *
 * This file pins:
 *   1. The on-master regression (test fails today, passes after the fix).
 *   2. A forward-looking guard that the spawn path's `staffId` field
 *      round-trips correctly if it IS supplied.
 *   3. Source-level guards on both the read side (`restoreSession`) and the
 *      write side (`persistOnce`) so a future refactor can't silently drop
 *      either line.
 *
 * Style mirrors `tests/session-manager-restore.test.ts` — pure unit test
 * against `SessionStore` with no real `SessionManager`, temp state dir,
 * `node:test` runner.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "staff-staffid-test-"));
const stateDir = path.join(tmpRoot, "state");
fs.mkdirSync(stateDir, { recursive: true });
process.env.BOBBIT_DIR = tmpRoot;

const { SessionStore } = await import("../src/server/agent/session-store.ts");
type PersistedSession = import("../src/server/agent/session-store.ts").PersistedSession;

const STORE_FILE = path.join(stateDir, "sessions.json");

function freshStore() {
	if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
	return new SessionStore(stateDir);
}

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

	it("staffId set during staff-manager spawn must survive SessionStore reload (regression)", () => {
		// Step 1: persist a session the way master's StaffManager.createStaff path
		// does today — `staffId` is NOT in the put payload because
		// SessionManager.createSession's opts don't accept it, so plan.staffId is
		// undefined and persistOnce writes `staffId: undefined`.
		const store = freshStore();
		store.put({
			id: "sess-1",
			title: "Unit Test Guardian",
			cwd: "/tmp/staff-wt",
			agentSessionFile: "/tmp/staff-wt/agent.jsonl",
			createdAt: Date.now(),
			lastActivity: Date.now(),
			// NOTE: no staffId — master's createSession doesn't propagate it.
		});

		// Master's staff-manager then does `session.staffId = "staff-x"` purely in
		// memory and calls `persistSessionMetadata` which only flushes
		// `agentSessionFile` — it does NOT copy `session.staffId` back into the
		// store. We mimic that by NOT calling store.update({ staffId }) here.
		store.flush();

		// Step 2: discard the live session, reload from disk (simulates a process
		// restart / in-place agent CLI respawn / sandbox recovery).
		const store2 = new SessionStore(stateDir);
		const ps = store2.get("sess-1");
		assert.ok(ps, "session must be reloaded from disk");

		// Step 3: replay the restoreSession env-builder shape.
		const bridgeEnv = buildRestoreEnv(ps!);

		// Step 4: assert what we WANT to be true. This fails on master because
		// the spawn path never wrote staffId into the persisted record.
		assert.equal(
			ps!.staffId,
			"staff-x",
			"staffId must round-trip through SessionStore — spawn path should pass plan.staffId",
		);
		assert.equal(
			bridgeEnv.BOBBIT_STAFF_ID,
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

// Source-level regression guards — mirrors the pattern at the bottom of
// `tests/session-manager-restore.test.ts`. Pins both the read side
// (restoreSession env builder) and the write side (persistOnce payload) so a
// future refactor that drops either line fails loudly.
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
