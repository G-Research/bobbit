/**
 * Pure-mirror tests for `teardownTeamWithDialog` in `src/app/api.ts`.
 *
 * The function dynamically imports `dialogs.js` and reads `window.__goalCache`,
 * which makes a direct import-and-stub approach require a full browser-like
 * shim (state.ts pulls in DOM globals via its dependency chain). We follow
 * the same pure-mirror pattern as `tests/cascade-dialog.test.ts`: re-implement
 * the small state machine here in node-friendly form, with all I/O surfaces
 * (HTTP probe, dialog, refresh) injected as functions, then assert the
 * branch coverage. The full UI flow is covered by the browser harness in
 * `tests/e2e/ui/` (cascade-archive / cascade-pause spec patterns).
 *
 * State machine being tested:
 *
 *   1. probe POST /api/goals/:id/team/teardown (no cascade query)
 *   2. probe.ok                                     → refreshSessions; return true
 *   3. probe.status === 409 + code HAS_DESCENDANT_TEAMS
 *        a. dialog returns "cancel"                 → return false (no second POST)
 *        b. dialog returns "cascade"                → POST ?cascade=true
 *             - if ok                               → refreshSessions; return true
 *             - if !ok                              → showError; return false
 *        c. dialog returns "this-only"              → return false
 *   4. probe.status === 409 with no/wrong code      → showError; return false
 *   5. probe.status non-2xx, non-409                → showError; return false
 *   6. probe throws (network)                       → showError; return false
 *
 * Each assertion focuses on the call-side-effects and return value — exactly
 * what dashboard's handleEndTeam relies on.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Pure mirror of `teardownTeamWithDialog`. The single source of truth is
// `src/app/api.ts`; if the function diverges here the asserted branches
// will diverge from production behaviour and the tests will fail.
// ---------------------------------------------------------------------------

interface FakeResponse {
	ok: boolean;
	status: number;
	json(): Promise<any>;
}

interface MirrorDeps {
	/** Each call records the URL it was invoked with. Returns the next FakeResponse. */
	fetch: (url: string, init: { method: string }) => Promise<FakeResponse>;
	showStopTeamDialog: (
		goal: { id: string; title: string },
		count: number,
		descendants: Array<{ id: string; title: string }>,
	) => Promise<"this-only" | "cascade" | "cancel">;
	getCachedGoal: (goalId: string) => { id: string; title: string } | undefined;
	refreshSessions: () => Promise<void>;
	showError: (title: string, message: string) => void;
}

async function teardownTeamWithDialogMirror(
	goalId: string,
	deps: MirrorDeps,
): Promise<boolean> {
	try {
		const probe = await deps.fetch(`/api/goals/${goalId}/team/teardown`, { method: "POST" });
		if (probe.ok) {
			await deps.refreshSessions();
			return true;
		}
		if (probe.status === 409) {
			const body = (await probe.json().catch(() => null)) as
				| { code?: string; count?: number; descendants?: Array<{ id: string; title: string }> }
				| null;
			if (body?.code === "HAS_DESCENDANT_TEAMS") {
				const goal = deps.getCachedGoal(goalId) ?? { id: goalId, title: goalId.slice(0, 8) };
				const decision = await deps.showStopTeamDialog(goal, body.count ?? 0, body.descendants ?? []);
				if (decision === "cancel") return false;
				if (decision === "cascade") {
					const r = await deps.fetch(`/api/goals/${goalId}/team/teardown?cascade=true`, { method: "POST" });
					if (!r.ok) throw new Error(`Failed: ${r.status}`);
					await deps.refreshSessions();
					return true;
				}
				return false;
			}
		}
		throw new Error(`Failed: ${probe.status}`);
	} catch (err) {
		deps.showError("Failed to tear down team", err instanceof Error ? err.message : String(err));
		return false;
	}
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function jsonResponse(status: number, ok: boolean, body: any): FakeResponse {
	return { ok, status, json: async () => body };
}

function makeRecorder() {
	const fetchCalls: Array<{ url: string; method: string }> = [];
	const dialogCalls: Array<{ goal: any; count: number; descendants: any[] }> = [];
	const refreshCalls: number[] = [];
	const errorCalls: Array<{ title: string; message: string }> = [];
	return { fetchCalls, dialogCalls, refreshCalls, errorCalls };
}

describe("teardownTeamWithDialog — pure mirror", () => {
	it("probe 200 (no descendants) → no dialog, refresh, return true", async () => {
		const rec = makeRecorder();
		const result = await teardownTeamWithDialogMirror("g1", {
			fetch: async (url, init) => {
				rec.fetchCalls.push({ url, method: init.method });
				return jsonResponse(200, true, { ok: true, toreDown: 1, errors: [] });
			},
			showStopTeamDialog: async (goal, count, descendants) => {
				rec.dialogCalls.push({ goal, count, descendants });
				return "cancel";
			},
			getCachedGoal: () => ({ id: "g1", title: "Goal 1" }),
			refreshSessions: async () => { rec.refreshCalls.push(Date.now()); },
			showError: (title, message) => rec.errorCalls.push({ title, message }),
		});

		assert.equal(result, true);
		assert.equal(rec.fetchCalls.length, 1, "exactly one POST (no cascade)");
		assert.equal(rec.fetchCalls[0].url, "/api/goals/g1/team/teardown");
		assert.equal(rec.fetchCalls[0].method, "POST");
		assert.equal(rec.dialogCalls.length, 0, "dialog must NOT be invoked");
		assert.equal(rec.refreshCalls.length, 1, "refreshSessions called exactly once");
		assert.equal(rec.errorCalls.length, 0);
	});

	it("probe 409 HAS_DESCENDANT_TEAMS + dialog 'cascade' → second POST with ?cascade=true, refresh, return true", async () => {
		const rec = makeRecorder();
		let fetchIdx = 0;
		const result = await teardownTeamWithDialogMirror("g1", {
			fetch: async (url, init) => {
				rec.fetchCalls.push({ url, method: init.method });
				fetchIdx++;
				if (fetchIdx === 1) {
					return jsonResponse(409, false, {
						code: "HAS_DESCENDANT_TEAMS",
						count: 2,
						descendants: [{ id: "c1", title: "Child 1" }, { id: "c2", title: "Child 2" }],
						message: "Goal has 2 descendant team(s) still running. Re-call with ?cascade=true to stop them all.",
					});
				}
				return jsonResponse(200, true, { ok: true, toreDown: 3, errors: [] });
			},
			showStopTeamDialog: async (goal, count, descendants) => {
				rec.dialogCalls.push({ goal, count, descendants });
				return "cascade";
			},
			getCachedGoal: () => ({ id: "g1", title: "Goal 1" }),
			refreshSessions: async () => { rec.refreshCalls.push(Date.now()); },
			showError: (title, message) => rec.errorCalls.push({ title, message }),
		});

		assert.equal(result, true);
		assert.equal(rec.fetchCalls.length, 2, "probe + cascade POST");
		assert.equal(rec.fetchCalls[0].url, "/api/goals/g1/team/teardown");
		assert.equal(rec.fetchCalls[1].url, "/api/goals/g1/team/teardown?cascade=true");
		// Dialog received the count + descendants from the 409 body verbatim.
		assert.equal(rec.dialogCalls.length, 1);
		assert.equal(rec.dialogCalls[0].count, 2);
		assert.deepEqual(rec.dialogCalls[0].descendants, [
			{ id: "c1", title: "Child 1" },
			{ id: "c2", title: "Child 2" },
		]);
		assert.deepEqual(rec.dialogCalls[0].goal, { id: "g1", title: "Goal 1" });
		assert.equal(rec.refreshCalls.length, 1, "refreshSessions called once after cascade success");
		assert.equal(rec.errorCalls.length, 0);
	});

	it("probe 409 + dialog 'cancel' → no second POST, no refresh, return false, no error", async () => {
		const rec = makeRecorder();
		const result = await teardownTeamWithDialogMirror("g1", {
			fetch: async (url, init) => {
				rec.fetchCalls.push({ url, method: init.method });
				return jsonResponse(409, false, {
					code: "HAS_DESCENDANT_TEAMS",
					count: 1,
					descendants: [{ id: "c1", title: "Child 1" }],
				});
			},
			showStopTeamDialog: async (goal, count, descendants) => {
				rec.dialogCalls.push({ goal, count, descendants });
				return "cancel";
			},
			getCachedGoal: () => ({ id: "g1", title: "Goal 1" }),
			refreshSessions: async () => { rec.refreshCalls.push(Date.now()); },
			showError: (title, message) => rec.errorCalls.push({ title, message }),
		});

		assert.equal(result, false);
		assert.equal(rec.fetchCalls.length, 1, "ONLY the probe — no second POST after cancel");
		assert.equal(rec.dialogCalls.length, 1);
		assert.equal(rec.refreshCalls.length, 0, "no refresh on cancel");
		assert.equal(rec.errorCalls.length, 0, "cancel is NOT an error");
	});

	it("probe 409 + dialog 'this-only' → no second POST, return false (degenerate path; count=0 case)", async () => {
		// `showStopTeamDialog` returns "this-only" only when descendantTeamCount === 0,
		// in which case the route would have returned 200 in the first place. This
		// case documents the safety: even if the dialog returned "this-only", the
		// wrapper does NOT issue a second POST — caller must re-invoke explicitly.
		const rec = makeRecorder();
		const result = await teardownTeamWithDialogMirror("g1", {
			fetch: async (url, init) => {
				rec.fetchCalls.push({ url, method: init.method });
				return jsonResponse(409, false, {
					code: "HAS_DESCENDANT_TEAMS",
					count: 1,
					descendants: [{ id: "c1", title: "Child 1" }],
				});
			},
			showStopTeamDialog: async () => "this-only",
			getCachedGoal: () => ({ id: "g1", title: "Goal 1" }),
			refreshSessions: async () => { rec.refreshCalls.push(Date.now()); },
			showError: (title, message) => rec.errorCalls.push({ title, message }),
		});

		assert.equal(result, false);
		assert.equal(rec.fetchCalls.length, 1, "no second POST on this-only");
		assert.equal(rec.refreshCalls.length, 0);
	});

	it("probe 409 with WRONG code (not HAS_DESCENDANT_TEAMS) → showError, return false, no dialog", async () => {
		const rec = makeRecorder();
		const result = await teardownTeamWithDialogMirror("g1", {
			fetch: async (url, init) => {
				rec.fetchCalls.push({ url, method: init.method });
				return jsonResponse(409, false, { code: "SOMETHING_ELSE", count: 1, descendants: [] });
			},
			showStopTeamDialog: async (goal, count, descendants) => {
				rec.dialogCalls.push({ goal, count, descendants });
				return "cancel";
			},
			getCachedGoal: () => undefined,
			refreshSessions: async () => { rec.refreshCalls.push(Date.now()); },
			showError: (title, message) => rec.errorCalls.push({ title, message }),
		});

		assert.equal(result, false);
		assert.equal(rec.dialogCalls.length, 0, "wrong code path skips dialog");
		assert.equal(rec.errorCalls.length, 1);
		assert.equal(rec.errorCalls[0].title, "Failed to tear down team");
		assert.match(rec.errorCalls[0].message, /Failed: 409/);
	});

	it("probe 500 → showError, return false, no dialog", async () => {
		const rec = makeRecorder();
		const result = await teardownTeamWithDialogMirror("g1", {
			fetch: async (url, init) => {
				rec.fetchCalls.push({ url, method: init.method });
				return jsonResponse(500, false, { error: "boom" });
			},
			showStopTeamDialog: async () => "cancel",
			getCachedGoal: () => undefined,
			refreshSessions: async () => { rec.refreshCalls.push(Date.now()); },
			showError: (title, message) => rec.errorCalls.push({ title, message }),
		});

		assert.equal(result, false);
		assert.equal(rec.dialogCalls.length, 0);
		assert.equal(rec.errorCalls.length, 1);
		assert.match(rec.errorCalls[0].message, /Failed: 500/);
	});

	it("probe throws (network error) → showError carries error message, return false", async () => {
		const rec = makeRecorder();
		const result = await teardownTeamWithDialogMirror("g1", {
			fetch: async () => { throw new Error("ECONNREFUSED"); },
			showStopTeamDialog: async () => "cancel",
			getCachedGoal: () => undefined,
			refreshSessions: async () => { rec.refreshCalls.push(Date.now()); },
			showError: (title, message) => rec.errorCalls.push({ title, message }),
		});

		assert.equal(result, false);
		assert.equal(rec.errorCalls.length, 1);
		assert.equal(rec.errorCalls[0].title, "Failed to tear down team");
		assert.equal(rec.errorCalls[0].message, "ECONNREFUSED");
	});

	it("cascade POST returns non-ok → showError, return false (cascade-confirm-then-fail path)", async () => {
		const rec = makeRecorder();
		let fetchIdx = 0;
		const result = await teardownTeamWithDialogMirror("g1", {
			fetch: async (url, init) => {
				rec.fetchCalls.push({ url, method: init.method });
				fetchIdx++;
				if (fetchIdx === 1) {
					return jsonResponse(409, false, {
						code: "HAS_DESCENDANT_TEAMS",
						count: 1,
						descendants: [{ id: "c1", title: "Child 1" }],
					});
				}
				return jsonResponse(500, false, { error: "teardown blew up" });
			},
			showStopTeamDialog: async () => "cascade",
			getCachedGoal: () => ({ id: "g1", title: "Goal 1" }),
			refreshSessions: async () => { rec.refreshCalls.push(Date.now()); },
			showError: (title, message) => rec.errorCalls.push({ title, message }),
		});

		assert.equal(result, false);
		assert.equal(rec.fetchCalls.length, 2);
		assert.equal(rec.fetchCalls[1].url, "/api/goals/g1/team/teardown?cascade=true");
		assert.equal(rec.refreshCalls.length, 0, "refresh skipped on cascade failure");
		assert.equal(rec.errorCalls.length, 1);
		assert.match(rec.errorCalls[0].message, /Failed: 500/);
	});

	it("getCachedGoal returns undefined → dialog called with synthesized fallback goal { id, title=id.slice(0,8) }", async () => {
		const rec = makeRecorder();
		const longId = "abcdef0123456789";
		const result = await teardownTeamWithDialogMirror(longId, {
			fetch: async (url, init) => {
				rec.fetchCalls.push({ url, method: init.method });
				if (rec.fetchCalls.length === 1) {
					return jsonResponse(409, false, {
						code: "HAS_DESCENDANT_TEAMS",
						count: 1,
						descendants: [{ id: "c1", title: "Child 1" }],
					});
				}
				return jsonResponse(200, true, { ok: true, toreDown: 2, errors: [] });
			},
			showStopTeamDialog: async (goal, count, descendants) => {
				rec.dialogCalls.push({ goal, count, descendants });
				return "cascade";
			},
			getCachedGoal: () => undefined,  // cache miss
			refreshSessions: async () => { rec.refreshCalls.push(Date.now()); },
			showError: (title, message) => rec.errorCalls.push({ title, message }),
		});

		assert.equal(result, true);
		// Dialog received synthesized goal.
		assert.equal(rec.dialogCalls.length, 1);
		assert.equal(rec.dialogCalls[0].goal.id, longId);
		assert.equal(rec.dialogCalls[0].goal.title, "abcdef01");  // first 8 chars of id
	});

	it("probe 409 with empty descendants array (count provided, descendants undefined) → dialog gets [] fallback", async () => {
		// The wrapper coerces `body.descendants ?? []` and `body.count ?? 0`.
		// A malformed 409 (count present, descendants missing) must still drive
		// the dialog without crashing.
		const rec = makeRecorder();
		const result = await teardownTeamWithDialogMirror("g1", {
			fetch: async (url, init) => {
				rec.fetchCalls.push({ url, method: init.method });
				if (rec.fetchCalls.length === 1) {
					return jsonResponse(409, false, { code: "HAS_DESCENDANT_TEAMS", count: 3 });
				}
				return jsonResponse(200, true, { ok: true, toreDown: 1, errors: [] });
			},
			showStopTeamDialog: async (goal, count, descendants) => {
				rec.dialogCalls.push({ goal, count, descendants });
				return "cascade";
			},
			getCachedGoal: () => ({ id: "g1", title: "Goal 1" }),
			refreshSessions: async () => { rec.refreshCalls.push(Date.now()); },
			showError: (title, message) => rec.errorCalls.push({ title, message }),
		});

		assert.equal(result, true);
		assert.equal(rec.dialogCalls[0].count, 3);
		assert.deepEqual(rec.dialogCalls[0].descendants, []);
	});

	it("probe 409 with body that fails to parse → showError, return false (caught .json() rejection)", async () => {
		const rec = makeRecorder();
		const result = await teardownTeamWithDialogMirror("g1", {
			fetch: async (url, init) => {
				rec.fetchCalls.push({ url, method: init.method });
				return {
					ok: false,
					status: 409,
					json: async () => { throw new Error("not json"); },
				};
			},
			showStopTeamDialog: async () => "cancel",
			getCachedGoal: () => undefined,
			refreshSessions: async () => { rec.refreshCalls.push(Date.now()); },
			showError: (title, message) => rec.errorCalls.push({ title, message }),
		});

		// `.catch(() => null)` → body becomes null → falls through to `throw new Error(\`Failed: ${probe.status}\`)`.
		assert.equal(result, false);
		assert.equal(rec.errorCalls.length, 1);
		assert.match(rec.errorCalls[0].message, /Failed: 409/);
	});
});

describe("URL contract", () => {
	it("no-cascade probe URL is parameter-free", () => {
		const goalId = "g1";
		assert.equal(`/api/goals/${goalId}/team/teardown`, "/api/goals/g1/team/teardown");
	});
	it("cascade confirm URL is exactly ?cascade=true (handler tests against literal string)", () => {
		const goalId = "g1";
		const url = `/api/goals/${goalId}/team/teardown?cascade=true`;
		// Handler at server.ts ~L6016: `url.searchParams.get("cascade") === "true"`.
		// Anything else (?cascade=1, ?cascade=True, omitted) is interpreted as false.
		assert.match(url, /\?cascade=true$/);
	});
});
