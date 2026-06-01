/**
 * WP2 / RC1 — stable correlation id + id-based dedup at the reducer boundary.
 *
 * Pins the four duplicate-render holes (S7/S10 id-less empty-text rows, S18
 * optimistic-vs-snapshot same-text, S17 skill-expanded echo) AND the
 * non-regression guards that keep genuinely-distinct same-text rows separate
 * (the over-dedup landmines called out in 03-remediation-plan.md §WP2).
 * Pure reducer; RED on master where noted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduce, initialState, keyFor, type Action, type ReducerState } from "../src/app/message-reducer.ts";

function live(seq: number, message: any): Action {
	return { type: "live-event", frame: { type: "message_end", message }, seq, ts: 0 };
}
function snapshot(messages: any[]): Action {
	return { type: "snapshot", messages };
}
function optimistic(id: string, text: string, extra: any = {}): Action {
	return { type: "optimistic-prompt", message: { id, role: "user", content: [{ type: "text", text }], ...extra } };
}
function applyAll(actions: Action[]): ReducerState {
	let s = initialState();
	for (const a of actions) s = reduce(s, a);
	return s;
}
const txt = (text: string) => [{ type: "text", text }];
const abortedRow = () => ({ role: "assistant", content: txt(""), stopReason: "aborted" });
const userRow = (text: string) => ({ role: "user", content: txt(text) });

test("S7/S10: id-less EMPTY-text aborted live row + snapshot with same → ONE (idempotent)", () => {
	const s = applyAll([live(5, abortedRow()), snapshot([abortedRow()])]);
	assert.equal(s.messages.length, 1, "empty-text aborted row deduped via plainTextEquivKey (RED on master: 2)");
	const s2 = reduce(s, snapshot([abortedRow()]));
	assert.equal(s2.messages.length, 1, "second snapshot is idempotent");
});

test("S18: optimistic same-text + snapshot-before-echo → ONE; later id-less live echo → still ONE", () => {
	const afterSnap = applyAll([optimistic("optimistic_1", "foo"), snapshot([userRow("foo")])]);
	assert.equal(afterSnap.messages.length, 1, "optimistic deduped against snapshot (RED on master: 2)");
	const afterEcho = reduce(afterSnap, live(3, userRow("foo")));
	assert.equal(afterEcho.messages.length, 1, "live echo consumes the prior-snapshot artifact, no re-stack");
});

test("S18 non-regression: two id'd snapshot same-text rows stay TWO; two distinct optimistic+echo pairs stay TWO", () => {
	const snap = applyAll([snapshot([{ id: "s1", ...userRow("dup") }, { id: "s2", ...userRow("dup") }])]);
	assert.equal(snap.messages.length, 2, "snapshot rows are authoritative — never collapsed");
	const pairs = applyAll([
		optimistic("optimistic_1", "same"),
		optimistic("optimistic_2", "same"),
		live(1, { id: "e1", ...userRow("same") }),
		live(2, { id: "e2", ...userRow("same") }),
	]);
	assert.equal(pairs.messages.length, 2, "two distinct prompts of the same text both survive");
});

test("step-4b over-dedup guard: prior-snapshot assistant 'OK' + a DISTINCT new live assistant 'OK' stay TWO", () => {
	const s = applyAll([
		snapshot([{ role: "assistant", content: txt("OK") }]),
		live(5, { role: "assistant", content: txt("OK") }),
	]);
	assert.equal(s.messages.length, 2, "step 4b is user-scoped — a new assistant same-text reply is NOT over-deduped");
});

test("S17 (unprefixed): optimistic /foo with skillExpansions + echo of the EXPANDED body → ONE", () => {
	const opt = optimistic("optimistic_1", "/foo bar", {
		role: "user-with-attachments",
		skillExpansions: [{ name: "foo", args: "", source: "", filePath: "", range: [0, 4], expanded: "EXPANDED" }],
	});
	const s = applyAll([opt, live(1, { id: "e1", ...userRow("EXPANDED bar") })]);
	assert.equal(s.messages.length, 1, "reconstructModelText matches /foo→EXPANDED (RED on master: 2)");
});

test("prefixed-S17 scope-out: optimistic /foo + error-recovery-PREFIXED echo stays TWO (documented not-closed)", () => {
	const opt = optimistic("optimistic_1", "/foo", {
		skillExpansions: [{ range: [0, 4], expanded: "EXPANDED" }],
	});
	const s = applyAll([opt, live(1, { id: "e1", ...userRow("[SYSTEM: previous turn failed]\n\nEXPANDED") })]);
	assert.equal(s.messages.length, 2, "prefixed echo is owned by the server-side splice fix, not WP2");
});

test("synth:seq stamp: id-less live row gets synth:seq:<seq>; re-delivery replaces in place", () => {
	const s = applyAll([live(7, { role: "assistant", content: txt("hi") })]);
	assert.equal(s.messages[0].id, "synth:seq:7");
	const s2 = reduce(s, live(7, { role: "assistant", content: txt("hi") }));
	assert.equal(s2.messages.length, 1, "same synth:seq id → replace-by-id, not a duplicate");
	assert.equal(s2.messages[0].id, "synth:seq:7");
});

test("keyFor reorder-stability: synth:seq id gives a stable render key (no index-derived churn)", () => {
	const s = applyAll([live(9, { role: "assistant", content: txt("stable") })]);
	assert.equal(keyFor(s.messages[0]), "synth:seq:9", "id-based key is stable across reorders/re-stamps");
});
