/**
 * Unit tests for the WebSocket overflow-guard decision logic in
 * `src/server/ws-overflow-guard.ts`. The actual broadcast loop in
 * `session-manager.ts` is covered indirectly through E2E; here we pin
 * down the policy: a transient spike must not cause an immediate
 * terminate, but a persistent spike must.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	decideOverflowAction,
	DEFAULT_OVERFLOW_GUARD,
} from "../src/server/ws-overflow-guard.ts";

test("OG-01: under threshold => send", () => {
	const action = decideOverflowAction(0, false);
	assert.equal(action.kind, "send");
});

test("OG-02: at threshold (boundary) => send", () => {
	const action = decideOverflowAction(DEFAULT_OVERFLOW_GUARD.overflowBytes, false);
	assert.equal(action.kind, "send");
});

test("OG-03: just over threshold, first observation => send-and-defer-check (no immediate terminate)", () => {
	const action = decideOverflowAction(DEFAULT_OVERFLOW_GUARD.overflowBytes + 1, false);
	assert.equal(action.kind, "send-and-defer-check");
});

test("OG-04: way over threshold, first observation => still send-and-defer-check (transient spike given chance to drain)", () => {
	const action = decideOverflowAction(50 * 1024 * 1024, false);
	assert.equal(action.kind, "send-and-defer-check");
});

test("OG-05: over threshold during deferred re-check => terminate (persistent spike)", () => {
	const action = decideOverflowAction(DEFAULT_OVERFLOW_GUARD.overflowBytes + 1, true);
	assert.equal(action.kind, "terminate");
});

test("OG-06: drained below threshold during deferred re-check => send (no terminate)", () => {
	// Spike crossed threshold, deferred re-check fires 10ms later, by then
	// the kernel has drained the buffer. We must NOT terminate.
	const action = decideOverflowAction(0, true);
	assert.equal(action.kind, "send");
});

test("OG-07: custom config respected", () => {
	const cfg = { overflowBytes: 1000, warnBytes: 500 };
	assert.equal(decideOverflowAction(999, false, cfg).kind, "send");
	assert.equal(decideOverflowAction(1001, false, cfg).kind, "send-and-defer-check");
	assert.equal(decideOverflowAction(1001, true, cfg).kind, "terminate");
});
