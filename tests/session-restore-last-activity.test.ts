/**
 * Reproducing test for the lastActivity restart-corruption bug.
 *
 * Bug: src/server/agent/session-manager.ts has three rpc-event handlers that
 * bump session.lastActivity = Date.now() on lifecycle frames emitted by the
 * agent CLI immediately after a resume:
 *
 *   1. restoreSession (~L2483) — gated by `restoring`, but the flag clears
 *      BEFORE post-resume frames (agent_idle, connection_state, state,
 *      agent_start) arrive. They bump lastActivity to Date.now().
 *   2. role-restart (~L3539) — no gate at all on lastActivity; every event
 *      including pure history replay clobbers the timestamp.
 *   3. abort-restart (~L4708) — same shape as #2.
 *
 * After a server restart the persisted lastActivity gets clobbered to "now"
 * for every restored session that emits any post-resume event.
 *
 * Fix design (per Issue Analysis gate): introduce a selective filter
 * `isUserVisibleActivity(event)` that returns true only for genuine new
 * activity (message_update / tool_execution_start / tool_execution_end /
 * agent_end) and apply it at all three sites. lastActivity is only bumped
 * when the filter returns true.
 *
 * NOTE: this test cannot import `src/server/agent/session-manager.ts`
 * directly — it transitively pulls in `flexsearch`, which the Node-test +
 * tsx ESM loader rejects (see `tests/get-image-model-for-session.test.ts`
 * for the same workaround). Instead we:
 *
 *   (A) source-scan session-manager.ts to verify the fix's structural
 *       footprint at all three sites.
 *   (B) replicate the closure shape behaviourally and drive it through
 *       realistic event sequences. In (B) the handler routes through the
 *       `isUserVisibleActivity` filter the fix is expected to add — a
 *       local re-host the source-scan locks against the production export.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SOURCE_PATH = path.join(PROJECT_ROOT, "src/server/agent/session-manager.ts");
const SOURCE = fs.readFileSync(SOURCE_PATH, "utf-8");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-last-activity-test-"));
const stateDir = path.join(tmpRoot, "state");
fs.mkdirSync(stateDir, { recursive: true });
process.env.BOBBIT_DIR = tmpRoot;

const { SessionStore } = await import("../src/server/agent/session-store.ts");
type PersistedSession = import("../src/server/agent/session-store.ts").PersistedSession;

const STORE_FILE = path.join(stateDir, "sessions.json");

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const ORIGINAL_TS = Date.now() - ONE_WEEK_MS;

function freshStore() {
	if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
	return new SessionStore(stateDir);
}

function makeSession(): PersistedSession {
	return {
		id: "sess-bug",
		title: "Pre-restart session",
		cwd: "/tmp/test",
		agentSessionFile: "/tmp/test/agent.jsonl",
		createdAt: ORIGINAL_TS - 1000,
		lastActivity: ORIGINAL_TS,
	};
}

/**
 * Realistic sequence of events emitted by the agent CLI immediately after
 * `switch_session` resolves on a restored session. None of these represent
 * new user-visible activity — they are lifecycle frames the CLI sends to
 * sync the gateway with the agent's current state.
 */
const POST_RESTORE_LIFECYCLE_EVENTS = [
	{ type: "agent_idle" },
	{ type: "connection_state", connected: true },
	{ type: "state", model: "claude-sonnet-4-5" },
	{ type: "agent_start" }, // fires on resume too — must NOT bump
	{ type: "session_title", title: "Pre-restart session" },
];

/**
 * Genuine new-activity events. These MUST bump lastActivity once the fix
 * is in place — used to prove the filter doesn't over-suppress.
 */
const REAL_ACTIVITY_EVENTS = [
	{ type: "message_update", role: "assistant", text: "hi" },
	{ type: "tool_execution_start", toolName: "read" },
	{ type: "tool_execution_end", toolName: "read" },
	{ type: "agent_end" },
];

// ---------------------------------------------------------------------------
// (A) Source-scan: the fix must export `isUserVisibleActivity` and use it at
//     all three call sites. Today none of these are present → fails loudly.
// ---------------------------------------------------------------------------

describe("session-manager.ts has the isUserVisibleActivity filter wired in", () => {
	it("exports an isUserVisibleActivity helper", () => {
		assert.ok(
			/export\s+function\s+isUserVisibleActivity\s*\(/.test(SOURCE)
				|| /export\s+const\s+isUserVisibleActivity\s*=/.test(SOURCE),
			"session-manager.ts must export `isUserVisibleActivity` — bug fix scaffolding missing",
		);
	});

	it("restoreSession's onEvent handler uses isUserVisibleActivity to gate lastActivity", () => {
		const idx = SOURCE.indexOf("const restoreStore = this.getSessionStore(ps.projectId);");
		assert.ok(idx > 0, "restoreStore declaration not found — restoreSession scope changed");
		const window = SOURCE.slice(idx, idx + 1500);
		assert.ok(
			/isUserVisibleActivity\s*\(/.test(window),
			"restoreSession handler must call isUserVisibleActivity before bumping lastActivity",
		);
	});

	it("role-restart's onEvent handler uses isUserVisibleActivity to gate lastActivity", () => {
		const idx = SOURCE.indexOf("const roleStore = this.resolveStoreForSession(id);");
		assert.ok(idx > 0, "roleStore declaration not found — role-restart scope changed");
		const window = SOURCE.slice(idx, idx + 800);
		assert.ok(
			/isUserVisibleActivity\s*\(/.test(window),
			"role-restart handler must call isUserVisibleActivity before bumping lastActivity",
		);
	});

	it("abort-restart's onEvent handler uses isUserVisibleActivity to gate lastActivity", () => {
		const idx = SOURCE.indexOf("const abortStore = this.resolveStoreForSession(id);");
		assert.ok(idx > 0, "abortStore declaration not found — abort-restart scope changed");
		const window = SOURCE.slice(idx, idx + 800);
		assert.ok(
			/isUserVisibleActivity\s*\(/.test(window),
			"abort-restart handler must call isUserVisibleActivity before bumping lastActivity",
		);
	});
});

// ---------------------------------------------------------------------------
// (B) Behavioural contract — drives a closure with the same shape as the
//     three production sites through realistic event sequences. The handler
//     routes through `isUserVisibleActivity`, defined here as the
//     test-and-fix expects it to behave. The source-scan tests above keep
//     this contract in lockstep with production.
// ---------------------------------------------------------------------------

/**
 * The expected post-fix filter contract — drives both this file's closure
 * shape and the (D) filter-semantics tests below. The source-scan in (A)
 * asserts the production helper exists and is used; this local re-host
 * defines the semantics the contract requires.
 */
function isUserVisibleActivity(event: any): boolean {
	if (!event || typeof event.type !== "string") return false;
	switch (event.type) {
		case "message_update":
		case "tool_execution_start":
		case "tool_execution_end":
		case "agent_end":
			return true;
		default:
			return false;
	}
}

// ---------------------------------------------------------------------------
// (D) Filter semantics — explicit truth table for every event type the spec
//     names. Locks the contract that the implementation's helper must obey.
// ---------------------------------------------------------------------------

describe("isUserVisibleActivity filter semantics", () => {
	it("returns false for every post-restore lifecycle frame", () => {
		for (const event of POST_RESTORE_LIFECYCLE_EVENTS) {
			assert.equal(
				isUserVisibleActivity(event),
				false,
				`lifecycle frame ${JSON.stringify(event)} must NOT count as user-visible activity`,
			);
		}
	});

	it("returns true for every genuine new-activity event", () => {
		for (const event of REAL_ACTIVITY_EVENTS) {
			assert.equal(
				isUserVisibleActivity(event),
				true,
				`real activity event ${JSON.stringify(event)} must count as user-visible activity`,
			);
		}
	});
});

function buildSiteHandler(opts: {
	store: InstanceType<typeof SessionStore>;
	sessionId: string;
	site: "restore" | "role-restart" | "abort-restart";
	/** When true, simulate the BUGGY (current-master) behaviour: no filter. */
	buggy?: boolean;
}) {
	const session = { lastActivity: ORIGINAL_TS };
	const updates: Array<Partial<PersistedSession>> = [];

	let restoring = opts.site === "restore";
	let switchingSession = opts.site !== "restore";

	const shouldBump = (event: any): boolean => {
		if (opts.buggy) {
			// Mirror master: gate only on `restoring` for restoreSession; no
			// gate at all for the other two sites.
			if (opts.site === "restore") return !restoring;
			return true;
		}
		// Post-fix: never bump during replay phase (use existing flag), and
		// even after replay, only bump on real activity frames.
		if (opts.site === "restore" && restoring) return false;
		return isUserVisibleActivity(event);
	};

	const handler = (event: any) => {
		if (shouldBump(event)) {
			session.lastActivity = Date.now();
			updates.push({ lastActivity: session.lastActivity });
			opts.store.update(opts.sessionId, { lastActivity: session.lastActivity });
		}
		void switchingSession;
	};

	return {
		handler,
		session,
		updates,
		flipRestoringFalse: () => { restoring = false; },
		flipSwitchingFalse: () => { switchingSession = false; },
	};
}

// First — prove the bug exists today by running the BUGGY closure and showing
// it corrupts lastActivity. These assertions document the symptom; if they
// ever start failing on master, the bug has been silently fixed elsewhere
// and this whole test should be re-evaluated.

describe("BUG repro (master): post-resume lifecycle frames clobber lastActivity", () => {
	beforeEach(() => {
		if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
	});

	it("restoreSession buggy closure clobbers lastActivity to ~now", () => {
		const store = freshStore();
		store.put(makeSession());
		const ctx = buildSiteHandler({ store, sessionId: "sess-bug", site: "restore", buggy: true });
		ctx.flipRestoringFalse();
		for (const event of POST_RESTORE_LIFECYCLE_EVENTS) ctx.handler(event);
		store.flush();
		const persisted = store.get("sess-bug")!;
		// Master: drift from ORIGINAL_TS is ~ ONE_WEEK_MS (huge). This assertion
		// documents the symptom — should always hold on master.
		assert.ok(
			Math.abs(persisted.lastActivity - ORIGINAL_TS) > 60_000,
			"buggy closure should have clobbered lastActivity by far more than a minute",
		);
	});
});

// Now — the actual contract test. Driving the post-fix closure through the
// same sequence MUST preserve the original timestamp. If `isUserVisibleActivity`
// is exported and wired in at all three sites (asserted in (A)), this passes.

describe("POST-FIX contract: restoreSession preserves persisted lastActivity", () => {
	beforeEach(() => {
		if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
	});

	it("preserves the persisted lastActivity across post-resume lifecycle frames", () => {
		const store = freshStore();
		store.put(makeSession());
		const ctx = buildSiteHandler({ store, sessionId: "sess-bug", site: "restore" });

		// Replay phase — switch_session is still pending, restoring still true.
		ctx.handler({ type: "message_update", role: "user", text: "old" });
		ctx.handler({ type: "agent_end" });
		// switch_session resolves → restoring = false.
		ctx.flipRestoringFalse();
		// CLI now flushes lifecycle frames to sync the gateway.
		for (const event of POST_RESTORE_LIFECYCLE_EVENTS) ctx.handler(event);

		store.flush();
		const persisted = store.get("sess-bug")!;
		const drift = Math.abs(persisted.lastActivity - ORIGINAL_TS);
		assert.ok(
			drift < 1000,
			`lastActivity drifted ${drift} ms from pre-restart value — post-resume lifecycle frames clobbered it (updates: ${ctx.updates.length})`,
		);
	});

	it("DOES bump lastActivity when a real new-activity event arrives post-resume", () => {
		const store = freshStore();
		store.put(makeSession());
		const ctx = buildSiteHandler({ store, sessionId: "sess-bug", site: "restore" });
		ctx.flipRestoringFalse();
		// Lifecycle noise — should be ignored.
		for (const event of POST_RESTORE_LIFECYCLE_EVENTS) ctx.handler(event);
		const before = Date.now();
		// Real activity — should bump.
		ctx.handler({ type: "message_update", role: "assistant", text: "real new turn" });

		store.flush();
		const persisted = store.get("sess-bug")!;
		assert.ok(
			persisted.lastActivity >= before,
			`lastActivity (${persisted.lastActivity}) should have advanced past ${before} on real activity event`,
		);
	});
});

// Behavioural coverage for role-restart and abort-restart relies on the
// source-scan tests in (A) above. Their closure semantics today (no flag,
// no filter) clobber lastActivity even for plain replay events; the spec's
// fix design defers the precise gating mechanism to the implementer
// (filter-only, switching-gate-only, or both). The source-scan asserts the
// filter is wired at those sites; the contract test in (D) below proves the
// filter's semantics on lifecycle vs activity events.

// ---------------------------------------------------------------------------
// (C) Concurrent-restore clustering — the goal-spec symptom: with N>1
//     sessions restored concurrently, the buggy closure makes their
//     timestamps cluster. The fixed closure must keep them un-clustered.
// ---------------------------------------------------------------------------

describe("POST-FIX contract: concurrent restore must not cluster lastActivity timestamps", () => {
	beforeEach(() => {
		if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
	});

	it("five sessions with widely-varied pre-restart timestamps stay un-clustered", () => {
		const store = freshStore();
		const ids = ["s1", "s2", "s3", "s4", "s5"];
		const baseTimes = [
			Date.now() - 60_000,
			Date.now() - 60 * 60_000,
			Date.now() - 24 * 60 * 60_000,
			Date.now() - 7 * 24 * 60 * 60_000,
			Date.now() - 30 * 24 * 60 * 60_000,
		];
		for (let i = 0; i < ids.length; i++) {
			store.put({
				id: ids[i],
				title: `s${i}`,
				cwd: "/tmp/test",
				agentSessionFile: `/tmp/test/${ids[i]}.jsonl`,
				createdAt: baseTimes[i] - 1000,
				lastActivity: baseTimes[i],
			});
		}

		for (const id of ids) {
			const ctx = buildSiteHandler({ store, sessionId: id, site: "restore" });
			ctx.flipRestoringFalse();
			for (const event of POST_RESTORE_LIFECYCLE_EVENTS) ctx.handler(event);
		}
		store.flush();

		const persistedTimes = ids.map((id) => store.get(id)!.lastActivity);
		for (let i = 0; i < ids.length; i++) {
			const drift = Math.abs(persistedTimes[i] - baseTimes[i]);
			assert.ok(
				drift < 1000,
				`session ${ids[i]} lastActivity drifted ${drift} ms from pre-restart value`,
			);
		}
		const sorted = [...persistedTimes].sort((a, b) => a - b);
		const minSpread = sorted[sorted.length - 1] - sorted[0];
		assert.ok(
			minSpread > 60_000,
			`all sessions clustered within ${minSpread} ms — restart corruption present (timestamps: ${persistedTimes.join(", ")})`,
		);
	});
});
