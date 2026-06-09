/**
 * Unit tests for the CLIENT session-event bus subscribe SCOPING
 * (src/app/session-event-bus.ts) — the cross-session leak fix (acceptance #4).
 *
 * `host.session.subscribe` must deliver ONLY the bound session's events. The bug:
 * an UNBOUND subscription (sessionId === undefined) wildcarded to EVERY session,
 * leaking other sessions' live activity. Fix: an unbound subscription is INERT.
 *
 * EventTarget + CustomEvent are Node globals, so this runs as a node:test unit (no
 * browser fixture needed); the module under test has no DOM dependency.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	subscribeHostSessionEvent,
	publishClientStatus,
} from "../src/app/session-event-bus.ts";

describe("subscribeHostSessionEvent — own-session scoping (cross-session leak fix)", () => {
	it("a BOUND subscriber receives ONLY its own session's events", () => {
		const seen: string[] = [];
		const unsub = subscribeHostSessionEvent("sess-A", "status", (p) => seen.push(p.status + (p.detail ? `:${p.detail}` : "")));
		publishClientStatus("sess-A", "streaming", "mine");
		publishClientStatus("sess-B", "streaming", "other"); // different session — must NOT be delivered
		publishClientStatus("sess-A", "idle");
		unsub();
		publishClientStatus("sess-A", "error"); // after unsub — must NOT be delivered
		assert.deepEqual(seen, ["running:mine", "idle"]);
	});

	it("an UNBOUND subscriber (no sessionId) receives NOTHING (no wildcard firehose)", () => {
		const seen: unknown[] = [];
		const unsub = subscribeHostSessionEvent(undefined, "status", (p) => seen.push(p));
		publishClientStatus("sess-A", "streaming");
		publishClientStatus("sess-B", "idle");
		unsub(); // still a valid no-op unsubscribe fn
		assert.equal(seen.length, 0);
	});

	it("two bound subscribers on different sessions stay isolated", () => {
		const a: string[] = [];
		const b: string[] = [];
		const unsubA = subscribeHostSessionEvent("sess-A", "status", (p) => a.push(p.status));
		const unsubB = subscribeHostSessionEvent("sess-B", "status", (p) => b.push(p.status));
		publishClientStatus("sess-A", "streaming");
		publishClientStatus("sess-B", "error");
		unsubA();
		unsubB();
		assert.deepEqual(a, ["running"]);
		assert.deepEqual(b, ["error"]);
	});
});
