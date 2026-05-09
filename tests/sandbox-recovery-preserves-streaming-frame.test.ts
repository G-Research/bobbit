/**
 * Reproducing test for the sandbox-recovery dropped-events bug.
 *
 * `SessionManager.recoverSandboxSessions` (`src/server/agent/session-manager.ts`
 * ~L600–L630) is triggered by `SandboxManager.onContainerRecovered()` when a
 * project's Docker container is recreated. It rebuilds the SessionInfo +
 * EventBuffer in-place while the client's WebSocket stays open, but — unlike
 * `restartAgent` and `_restartSessionWithUpdatedRole` (PR #529) — does NOT
 * stash `_restartFrameOfReference` on the persisted session. The new
 * EventBuffer therefore starts at seq=1 and the new SessionInfo at
 * statusVersion=0; the client's `_highestSeq` / `_lastStatusVersion` trackers
 * were advanced by the OLD session, so every post-recovery frame is silently
 * dropped by the client's dedup gates.
 *
 * Companion to `tests/restart-preserves-streaming-frame.test.ts` (which pins
 * the analogous fix for the other two restart paths). The fix shape is to
 * extract `SessionManager._respawnAgentInPlace(session, ps, opts?)` and route
 * `recoverSandboxSessions` (and the other two existing sites + the in-memory
 * branch of `ensureSessionAlive`) through it.
 *
 * This test pins TWO things:
 *
 *  1. The pure dropped-events behaviour at the EventBuffer + broadcastStatus
 *     level (currently passes — regression pin).
 *  2. The existence of `SessionManager.prototype._respawnAgentInPlace` — the
 *     private helper that the fix introduces. This currently FAILS on master
 *     and is the explicit reproducer for the missing-fix state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { EventBuffer } from "../src/server/agent/event-buffer.ts";
import { broadcastStatus } from "../src/server/agent/session-status.ts";

// Resolve session-manager.ts path without importing it (the import chain pulls
// in flexsearch and other heavy deps that don't work under tsx --test).
const SESSION_MANAGER_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"src",
	"server",
	"agent",
	"session-manager.ts",
);

// Minimal client-side mirror of the version + seq dedup gates in
// src/app/remote-agent.ts. Mirrors the helper in
// tests/restart-preserves-streaming-frame.test.ts.
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
		if (seq <= highestSeq) return; // dedup gate
		if (seq !== highestSeq + 1) return; // out-of-order — drop
		highestSeq = seq;
		applied.push(ev);
	}
	function onStatus(frame: { status: string; statusVersion: number }) {
		const v = frame.statusVersion;
		if (v <= lastStatusVersion) return; // idempotent gate
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
	return {
		makeWs,
		applied,
		sent,
		getHighestSeq: () => highestSeq,
		getLastStatusVersion: () => lastStatusVersion,
	};
}

test("recoverSandboxSessions — BROKEN path drops every post-recovery frame (regression pin)", () => {
	// Reproduce the current behaviour: simulate the unfixed
	// `recoverSandboxSessions` flow — fresh EventBuffer (no seedNextSeq) +
	// fresh SessionInfo (statusVersion: 0) — and confirm the client's dedup
	// gates silently drop every post-recovery frame.
	const client = makeFakeClient();
	const ws = client.makeWs();

	// Old session — emit a few status flips + 10 live events.
	const oldSession: any = { id: "s1", status: "idle", statusVersion: 0, clients: new Set([ws]) };
	const oldBuf = new EventBuffer();

	broadcastStatus(oldSession, "streaming", { streamingStartedAt: 1 });
	for (let i = 1; i <= 10; i++) {
		const entry = oldBuf.push({ type: "live", i });
		ws.send(JSON.stringify({ type: "event", data: entry.event, seq: entry.seq, ts: entry.ts }));
	}
	broadcastStatus(oldSession, "idle");

	const oldClientSeq = client.getHighestSeq();
	const oldClientVersion = client.getLastStatusVersion();
	assert.equal(oldClientSeq, 10);
	assert.equal(oldClientVersion, 2); // streaming + idle

	// === BROKEN sandbox-recovery: rebuild buffer + session WITHOUT seeding ===
	const newBufNoSeed = new EventBuffer();
	const newSessionNoSeed: any = {
		id: "s1",
		status: "starting",
		statusVersion: 0,
		clients: new Set([ws]),
	};

	const beforeApplied = client.applied.length;

	// Step 6 in recoverSandboxSessions: broadcastStatus(restored, "idle").
	// version bumps from 0 -> 1, but client's lastStatusVersion is already 2,
	// so this is silently dropped.
	broadcastStatus(newSessionNoSeed, "idle");

	// Five post-recovery agent events. Each starts at seq 1..5 — all <= 10 —
	// every one is silently dropped.
	for (let i = 1; i <= 5; i++) {
		const entry = newBufNoSeed.push({ type: "post-recovery", i });
		ws.send(JSON.stringify({ type: "event", data: entry.event, seq: entry.seq, ts: entry.ts }));
	}

	const newlyApplied = client.applied.length - beforeApplied;
	assert.equal(
		newlyApplied,
		0,
		"BROKEN path: all 5 post-recovery events AND the post-recovery status flip are silently dropped",
	);
	assert.equal(client.getHighestSeq(), oldClientSeq, "client _highestSeq did not advance");
	assert.equal(
		client.getLastStatusVersion(),
		oldClientVersion,
		"client _lastStatusVersion did not advance",
	);
});

test("recoverSandboxSessions — FIXED path: seedNextSeq + statusVersion carry-over keeps frames flowing", () => {
	// Same setup, but this time apply the fix shape: snapshot lastSeq +
	// statusVersion BEFORE building the new buffer/session, then seed the new
	// EventBuffer and the new SessionInfo with the high-water marks.
	const client = makeFakeClient();
	const ws = client.makeWs();

	const oldSession: any = { id: "s1", status: "idle", statusVersion: 0, clients: new Set([ws]) };
	const oldBuf = new EventBuffer();

	broadcastStatus(oldSession, "streaming", { streamingStartedAt: 1 });
	for (let i = 1; i <= 10; i++) {
		const entry = oldBuf.push({ type: "live", i });
		ws.send(JSON.stringify({ type: "event", data: entry.event, seq: entry.seq, ts: entry.ts }));
	}
	broadcastStatus(oldSession, "idle");

	const oldClientSeq = client.getHighestSeq();
	const oldClientVersion = client.getLastStatusVersion();

	// === FIXED sandbox-recovery: snapshot first, then seed ===
	const snapshot = { lastSeq: oldBuf.lastSeq, lastStatusVersion: oldSession.statusVersion };
	const newBuf = new EventBuffer();
	newBuf.seedNextSeq(snapshot.lastSeq + 1);
	const newSession: any = {
		id: "s1",
		status: "starting",
		statusVersion: snapshot.lastStatusVersion,
		clients: new Set([ws]),
	};

	broadcastStatus(newSession, "idle"); // bumps to 3 — accepted (3 > 2)
	for (let i = 1; i <= 5; i++) {
		const entry = newBuf.push({ type: "post-recovery", i });
		ws.send(JSON.stringify({ type: "event", data: entry.event, seq: entry.seq, ts: entry.ts }));
	}

	const postRecoveryLive = client.applied.filter((m: any) => m.type === "post-recovery");
	assert.equal(postRecoveryLive.length, 5, "all 5 post-recovery live events applied");
	assert.equal(client.getHighestSeq(), 15, "11..15 = 5 new events on top of old 10");
	assert.ok(client.getHighestSeq() > oldClientSeq);
	assert.equal(client.getLastStatusVersion(), 3, "post-recovery idle bump applied");
	assert.ok(client.getLastStatusVersion() > oldClientVersion);
});

test("recoverSandboxSessions — wired through _respawnAgentInPlace + frame-of-reference snapshot (pinned for fix)", () => {
	// The fix extracts a private `_respawnAgentInPlace(session, ps, opts?)`
	// helper that owns the snapshot/unsubscribe/stop/restore/re-attach/
	// broadcast dance, and routes `restartAgent`,
	// `_restartSessionWithUpdatedRole`, `recoverSandboxSessions`, and the
	// in-memory branch of `ensureSessionAlive` through it.
	//
	// On master this assertion FAILS because:
	//   - the helper `_respawnAgentInPlace` does not exist yet, AND
	//   - `recoverSandboxSessions` does not call
	//     `_snapshotStreamingFrameOfReference` and does not stash
	//     `_restartFrameOfReference` on the persisted session.
	//
	// This is the explicit reproducer pin for the missing-fix state.
	const src = readFileSync(SESSION_MANAGER_PATH, "utf8");

	// Locate `recoverSandboxSessions`'s body so we only inspect that method.
	const startMarker = "private async recoverSandboxSessions(";
	const startIdx = src.indexOf(startMarker);
	assert.ok(startIdx >= 0, "recoverSandboxSessions method not found in session-manager.ts");
	// Heuristic body slice: take ~2000 chars from the method start, which is
	// well within its body and well clear of unrelated methods.
	const body = src.slice(startIdx, startIdx + 2000);

	const hasHelperDefinition = /private\s+(?:async\s+)?_respawnAgentInPlace\s*\(/.test(src);
	const recoveryUsesHelper = body.includes("_respawnAgentInPlace");
	const recoverySnapshotsFrame = body.includes("_snapshotStreamingFrameOfReference")
		|| body.includes("_restartFrameOfReference");

	assert.ok(
		hasHelperDefinition,
		"SessionManager._respawnAgentInPlace helper is not defined — sandbox-recovery fix not applied",
	);
	assert.ok(
		recoveryUsesHelper || recoverySnapshotsFrame,
		"recoverSandboxSessions does not preserve streaming frame-of-reference — sandbox-recovery fix not applied",
	);
});
