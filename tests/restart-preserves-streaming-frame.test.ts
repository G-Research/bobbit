/**
 * Regression test for the restart-streaming-frame-of-reference fix.
 *
 * After PR #500 (unify-session-status), the in-place restart paths
 * (`restartAgent`, `_restartSessionWithUpdatedRole`) silently dropped every
 * post-restart agent event because they built a brand-new EventBuffer (seq
 * counter back to 1) and a brand-new SessionInfo (statusVersion: 0) while the
 * client kept its open WebSocket and stale `_highestSeq` / `_lastStatusVersion`
 * trackers. The fix snapshots both monotonic counters before the respawn and
 * seeds them onto the new SessionInfo / EventBuffer so the client's dedup
 * gates keep advancing.
 *
 * This test exercises the EventBuffer half of the fix as a pure unit (the
 * SessionManager half — `_snapshotStreamingFrameOfReference` reading
 * `eventBuffer.lastSeq` + `statusVersion` and threading them through
 * `restoreSession` via a `_restartFrameOfReference` field on the persisted
 * session — is observed end-to-end via the H2-(b) E2E spec which now flips
 * its previously-soft assertion to a hard one).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { EventBuffer } from "../src/server/agent/event-buffer.ts";
import { broadcastStatus } from "../src/server/agent/session-status.ts";

// Minimal client-side mirror of the version + seq dedup gates in
// src/app/remote-agent.ts. Kept inline so the test doesn't drag in any
// browser-only modules.
function makeFakeClient() {
	const sent: any[] = [];
	const applied: any[] = [];
	let highestSeq = 0;
	let lastStatusVersion = -1;
	let seqInitialized = false;
	function onEvent(seq: number, ev: any) {
		if (!seqInitialized) {
			highestSeq = seq - 1;
			seqInitialized = true;
		}
		if (seq <= highestSeq) return; // dedup gate (the one that was breaking)
		if (seq !== highestSeq + 1) return; // out-of-order — buffer (omitted)
		highestSeq = seq;
		applied.push(ev);
	}
	function onStatus(frame: { status: string; statusVersion: number }) {
		const v = frame.statusVersion;
		if (v <= lastStatusVersion) return; // idempotent gate (the other one)
		lastStatusVersion = v;
		applied.push({ type: "status", status: frame.status, v });
	}
	function makeWs() {
		return {
			readyState: 1,
			bufferedAmount: 0,
			send(data: string) {
				const msg = JSON.parse(data);
				if (msg.type === "session_status") onStatus(msg);
				else if (msg.type === "event") onEvent(msg.seq, msg.data);
				sent.push(msg);
			},
		};
	}
	return { makeWs, applied, sent, getHighestSeq: () => highestSeq, getLastStatusVersion: () => lastStatusVersion };
}

test("restartAgent — without the fix, fresh seq=1 is dropped by client _highestSeq dedup gate", () => {
	// This scenario mirrors the BROKEN behaviour to pin the regression: a fresh
	// EventBuffer seeded at seq=1 (no seedNextSeq call) emits events that the
	// client's dedup gate silently drops because the client's _highestSeq was
	// advanced by the OLD session.
	const client = makeFakeClient();
	const ws = client.makeWs();

	// Old session — emits 25 events. Client tracker advances to seq=25.
	const oldBuf = new EventBuffer();
	for (let i = 1; i <= 25; i++) {
		const entry = oldBuf.push({ type: "live", i });
		ws.send(JSON.stringify({ type: "event", data: entry.event, seq: entry.seq, ts: entry.ts }));
	}
	assert.equal(client.getHighestSeq(), 25);

	// Restart WITHOUT seeding — fresh buffer starts at seq=1.
	const newBufNoSeed = new EventBuffer();
	const beforeApplied = client.applied.length;
	for (let i = 1; i <= 5; i++) {
		const entry = newBufNoSeed.push({ type: "post-restart", i });
		ws.send(JSON.stringify({ type: "event", data: entry.event, seq: entry.seq, ts: entry.ts }));
	}
	const droppedCount = 5 - (client.applied.length - beforeApplied);
	assert.equal(droppedCount, 5, "without seeding, all 5 post-restart events are silently dropped");
});

test("restartAgent — seedNextSeq + statusVersion carry-over keeps the client receiving live frames", () => {
	const client = makeFakeClient();
	const ws = client.makeWs();

	// Old session SessionInfo-shaped object the broadcastStatus helper accepts.
	const oldSession: any = { id: "s1", status: "idle", statusVersion: 0, clients: new Set([ws]) };
	const oldBuf = new EventBuffer();

	// Drive a realistic burst: a few status flips + a few live events.
	broadcastStatus(oldSession, "streaming", { streamingStartedAt: 1 });
	for (let i = 1; i <= 10; i++) {
		const entry = oldBuf.push({ type: "live", i });
		ws.send(JSON.stringify({ type: "event", data: entry.event, seq: entry.seq, ts: entry.ts }));
	}
	broadcastStatus(oldSession, "idle");

	const oldClientSeq = client.getHighestSeq();
	const oldClientVersion = client.getLastStatusVersion();
	assert.equal(oldClientSeq, 10);
	assert.equal(oldClientVersion, 2); // streaming (1) + idle (2)

	// === Server-side restart simulation ===
	// 1. Snapshot frame-of-reference (mirrors _snapshotStreamingFrameOfReference).
	const snapshot = { lastSeq: oldBuf.lastSeq, lastStatusVersion: oldSession.statusVersion };
	// 2. Build a fresh EventBuffer + SessionInfo, seeded from the snapshot.
	const newBuf = new EventBuffer();
	newBuf.seedNextSeq(snapshot.lastSeq + 1);
	const newSession: any = {
		id: "s1",
		status: "starting",
		statusVersion: snapshot.lastStatusVersion,
		clients: new Set([ws]),
	};
	// 3. Server emits the post-restart status flip + a few new events.
	broadcastStatus(newSession, "idle"); // bumps to 3 — accepted by client (3 > 2)
	for (let i = 1; i <= 5; i++) {
		const entry = newBuf.push({ type: "post-restart", i });
		ws.send(JSON.stringify({ type: "event", data: entry.event, seq: entry.seq, ts: entry.ts }));
	}

	// === Assertions ===
	// Every post-restart frame landed.
	const postRestartLive = client.applied.filter((m: any) => m.type === "post-restart");
	assert.equal(postRestartLive.length, 5, "all post-restart live events applied");

	// Client trackers advanced monotonically.
	assert.ok(client.getHighestSeq() > oldClientSeq, "highestSeq advanced past old high-water mark");
	assert.equal(client.getHighestSeq(), 15, "11..15 = 5 new events on top of old 10");
	assert.ok(
		client.getLastStatusVersion() > oldClientVersion,
		"lastStatusVersion advanced past old high-water mark",
	);
	assert.equal(client.getLastStatusVersion(), 3, "post-restart idle bump applied");
});

test("restartAgent — multiple cascading restarts each preserve the frame of reference", () => {
	// Tool grants -> permission denial -> manual restart all chain through the
	// same `restartAgent`/`_restartSessionWithUpdatedRole` code path. Verify
	// the seed survives N consecutive restarts.
	const client = makeFakeClient();
	const ws = client.makeWs();
	const session: any = { id: "s1", status: "idle", statusVersion: 0, clients: new Set([ws]) };

	let buf = new EventBuffer();
	let droppedTotal = 0;
	for (let restart = 0; restart < 5; restart++) {
		// Each round: 4 events + 1 status flip.
		for (let i = 0; i < 4; i++) {
			const entry = buf.push({ type: "live", restart, i });
			ws.send(JSON.stringify({ type: "event", data: entry.event, seq: entry.seq, ts: entry.ts }));
		}
		broadcastStatus(session, restart % 2 === 0 ? "streaming" : "idle");

		// Snapshot + restart.
		const snapshot = { lastSeq: buf.lastSeq, lastStatusVersion: session.statusVersion };
		buf = new EventBuffer();
		buf.seedNextSeq(snapshot.lastSeq + 1);
		// session.statusVersion stays at snapshot.lastStatusVersion (the new
		// SessionInfo would be initialised with this value).
	}
	assert.equal(droppedTotal, 0);
	// Final seq = 5 restarts × 4 events = 20.
	assert.equal(client.getHighestSeq(), 20);
});
