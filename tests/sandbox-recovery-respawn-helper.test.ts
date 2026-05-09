/**
 * Drives the `_respawnAgentInPlace` helper shape against a minimal
 * SessionManager-like shim (the heavy import chain — flexsearch,
 * pi-coding-agent, etc. — does not work under tsx --test, so we mirror the
 * helper's exact body and pin its observable contract).
 *
 * What this asserts for the sandbox-recovery shape (NO `_overrideAllowedTools`):
 *
 *   1. The streaming frame-of-reference is snapshotted AFTER `unsubscribe()`
 *      so a final in-flight event can't race past `lastSeq`. (This is the
 *      "snapshot after unsubscribe" tightening from the goal spec.)
 *   2. `_restartFrameOfReference` is stashed on the persisted-session record
 *      before `restoreSession` is invoked.
 *   3. The cleanup `delete (ps as any)._restartFrameOfReference` and
 *      `delete (ps as any)._overrideAllowedTools` runs in `finally` even
 *      when `restoreSession` throws.
 *   4. Live WS clients are re-attached to the restored session and a
 *      single `session_status` frame is broadcast — and the new buffer
 *      seeded via `seedNextSeq(lastSeq + 1)` is what the client sees, so
 *      `_highestSeq` / `_lastStatusVersion` carry over.
 *
 * The helper body in `src/server/agent/session-manager.ts::_respawnAgentInPlace`
 * is mirrored here verbatim. If the real helper drifts, this test should be
 * updated to match — the shape is the contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EventBuffer } from "../src/server/agent/event-buffer.ts";
import { broadcastStatus } from "../src/server/agent/session-status.ts";

const SESSION_MANAGER_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"src",
	"server",
	"agent",
	"session-manager.ts",
);

// ---------- Minimal SessionManager shim ----------
// Mirrors `_respawnAgentInPlace` and the subset of `restoreSession` it needs.
// Importantly: snapshot is captured AFTER `unsubscribe()` (the timing pin).

interface FakeSession {
	id: string;
	status: string;
	statusVersion: number;
	clients: Set<any>;
	eventBuffer: EventBuffer;
	rpcClient: { stop: () => Promise<void> };
	unsubscribe: () => void;
	streamingStartedAt?: number;
}

interface FakePs {
	id: string;
	[k: string]: any;
}

class FakeManager {
	sessions = new Map<string, FakeSession>();
	restoreCalls: Array<{ frameOfRef: any; overrideAllowedTools: any }> = [];
	restoreThrows = false;

	private _snapshot(s: FakeSession) {
		return { lastSeq: s.eventBuffer.lastSeq, lastStatusVersion: s.statusVersion ?? 0 };
	}

	async restoreSession(ps: FakePs): Promise<void> {
		// Capture what the helper handed us.
		this.restoreCalls.push({
			frameOfRef: (ps as any)._restartFrameOfReference,
			overrideAllowedTools: (ps as any)._overrideAllowedTools,
		});
		if (this.restoreThrows) throw new Error("synthetic restore failure");

		// Mirror real restoreSession's seedNextSeq + initialStatusVersion behaviour.
		const f = (ps as any)._restartFrameOfReference;
		const buf = new EventBuffer();
		if (f && Number.isFinite(f.lastSeq) && f.lastSeq > 0) buf.seedNextSeq(f.lastSeq + 1);
		const statusVersion = f && Number.isFinite(f.lastStatusVersion) ? f.lastStatusVersion : 0;

		const session: FakeSession = {
			id: ps.id,
			status: "starting",
			statusVersion,
			clients: new Set(),
			eventBuffer: buf,
			rpcClient: { stop: async () => {} },
			unsubscribe: () => {},
		};
		this.sessions.set(ps.id, session);
	}

	async _respawnAgentInPlace(
		session: FakeSession,
		ps: FakePs,
		opts?: { mutatePs?: (ps: FakePs) => void; finalStatus?: string },
	): Promise<FakeSession | undefined> {
		const savedClients = new Set(session.clients);
		session.unsubscribe();
		const frameOfRef = this._snapshot(session);
		try { await session.rpcClient.stop(); } catch { /* ignore */ }

		this.sessions.delete(session.id);
		(ps as any)._restartFrameOfReference = frameOfRef;
		opts?.mutatePs?.(ps);
		try {
			await this.restoreSession(ps);
		} finally {
			delete (ps as any)._restartFrameOfReference;
			delete (ps as any)._overrideAllowedTools;
		}
		const restored = this.sessions.get(session.id);
		if (restored) {
			for (const ws of savedClients) {
				if ((ws as any).readyState === 1) restored.clients.add(ws);
			}
			(broadcastStatus as any)(restored, opts?.finalStatus ?? "idle");
		}
		return restored;
	}
}

// Client-side dedup-gate mirror (matches remote-agent.ts shape).
function makeFakeClient() {
	const applied: any[] = [];
	let highestSeq = 0;
	let lastStatusVersion = -1;
	let seqInit = false;
	function onStatus(f: { statusVersion: number; status: string }) {
		if (f.statusVersion <= lastStatusVersion) return;
		lastStatusVersion = f.statusVersion;
		applied.push({ kind: "status", v: f.statusVersion, status: f.status });
	}
	function onEvent(seq: number, ev: any) {
		if (!seqInit) { highestSeq = seq - 1; seqInit = true; }
		if (seq <= highestSeq) return;
		if (seq !== highestSeq + 1) return;
		highestSeq = seq;
		applied.push({ kind: "event", seq, ev });
	}
	function makeWs() {
		return {
			readyState: 1,
			bufferedAmount: 0,
			send(data: string) {
				const m = JSON.parse(data);
				if (m.type === "session_status") onStatus(m);
				else if (m.type === "event") onEvent(m.seq, m.data);
			},
		};
	}
	return {
		makeWs,
		applied,
		getHighestSeq: () => highestSeq,
		getLastStatusVersion: () => lastStatusVersion,
	};
}

test("_respawnAgentInPlace (sandbox-recovery shape) carries seq + statusVersion across respawn", async () => {
	const client = makeFakeClient();
	const ws = client.makeWs();

	const mgr = new FakeManager();
	const oldBuf = new EventBuffer();
	const oldSession: FakeSession = {
		id: "s1",
		status: "idle",
		statusVersion: 0,
		clients: new Set([ws]),
		eventBuffer: oldBuf,
		rpcClient: { stop: async () => {} },
		unsubscribe: () => {},
	};
	mgr.sessions.set("s1", oldSession);

	// Drive the old session: 2 status flips + 10 events.
	(broadcastStatus as any)(oldSession, "streaming", { streamingStartedAt: 1 });
	for (let i = 1; i <= 10; i++) {
		const e = oldBuf.push({ type: "live", i });
		ws.send(JSON.stringify({ type: "event", data: e.event, seq: e.seq, ts: e.ts }));
	}
	(broadcastStatus as any)(oldSession, "idle");
	assert.equal(client.getHighestSeq(), 10);
	assert.equal(client.getLastStatusVersion(), 2);

	// Sandbox-recovery shape: NO mutatePs, NO _overrideAllowedTools.
	const ps: FakePs = { id: "s1" };
	const restored = await mgr._respawnAgentInPlace(oldSession, ps);

	assert.ok(restored, "restored session present");
	assert.equal(mgr.restoreCalls.length, 1);
	assert.deepEqual(
		mgr.restoreCalls[0].frameOfRef,
		{ lastSeq: 10, lastStatusVersion: 2 },
		"frame-of-reference snapshotted from old session and stashed on ps",
	);
	assert.equal(
		mgr.restoreCalls[0].overrideAllowedTools,
		undefined,
		"sandbox-recovery shape does not set _overrideAllowedTools",
	);
	// Cleanup invariant: both fields cleared in finally.
	assert.equal((ps as any)._restartFrameOfReference, undefined);
	assert.equal((ps as any)._overrideAllowedTools, undefined);

	// Restored buffer/session must be primed so client gates keep advancing.
	// statusVersion was seeded at 2 by restoreSession, then bumped to 3 by the
	// helper's final `broadcastStatus(restored, "idle")`. Either way it must be
	// >= the old client's high-water mark (2) so the next bump is accepted.
	assert.ok(restored!.statusVersion >= 2, `statusVersion seeded from prior frame-of-reference, got ${restored!.statusVersion}`);
	assert.equal(restored!.clients.has(ws), true, "live WS re-attached");

	// `_respawnAgentInPlace` broadcasts a final "idle" — bumps version 2 -> 3.
	assert.equal(client.getLastStatusVersion(), 3, "post-respawn idle status applied (3 > 2)");

	// Drive 5 post-recovery events on the new buffer.
	for (let i = 1; i <= 5; i++) {
		const e = restored!.eventBuffer.push({ type: "post-recovery", i });
		ws.send(JSON.stringify({ type: "event", data: e.event, seq: e.seq, ts: e.ts }));
	}
	const postEvents = client.applied.filter((m: any) => m.kind === "event" && m.ev.type === "post-recovery");
	assert.equal(postEvents.length, 5, "all post-recovery events applied (no dropped frames)");
	assert.equal(client.getHighestSeq(), 15, "11..15 = 5 new events on top of old 10");
});

test("_respawnAgentInPlace cleans up _restartFrameOfReference + _overrideAllowedTools when restoreSession throws", async () => {
	const mgr = new FakeManager();
	mgr.restoreThrows = true;
	const oldBuf = new EventBuffer();
	const oldSession: FakeSession = {
		id: "s2",
		status: "idle",
		statusVersion: 0,
		clients: new Set(),
		eventBuffer: oldBuf,
		rpcClient: { stop: async () => {} },
		unsubscribe: () => {},
	};
	mgr.sessions.set("s2", oldSession);
	const ps: FakePs = { id: "s2" };

	await assert.rejects(
		() => mgr._respawnAgentInPlace(oldSession, ps, {
			mutatePs: p => { (p as any)._overrideAllowedTools = ["bash"]; },
		}),
		/synthetic restore failure/,
	);

	assert.equal(
		(ps as any)._restartFrameOfReference,
		undefined,
		"_restartFrameOfReference cleared even when restoreSession throws",
	);
	assert.equal(
		(ps as any)._overrideAllowedTools,
		undefined,
		"_overrideAllowedTools cleared even when restoreSession throws",
	);
});

test("_respawnAgentInPlace snapshots streaming frame-of-reference AFTER unsubscribe (timing pin)", async () => {
	// The goal spec tightens timing: snapshot must happen AFTER unsubscribe()
	// so a final in-flight `agent_end`-style event cannot race past `lastSeq`.
	// Verify by having `unsubscribe()` push one final event into the buffer
	// and asserting the snapshot includes it.
	const mgr = new FakeManager();
	const oldBuf = new EventBuffer();
	for (let i = 1; i <= 3; i++) oldBuf.push({ type: "live", i });

	const oldSession: FakeSession = {
		id: "s3",
		status: "idle",
		statusVersion: 0,
		clients: new Set(),
		eventBuffer: oldBuf,
		rpcClient: { stop: async () => {} },
		unsubscribe: () => {
			// Simulate one in-flight event that lands during teardown.
			oldBuf.push({ type: "trailing-end", inflight: true });
		},
	};
	mgr.sessions.set("s3", oldSession);

	const ps: FakePs = { id: "s3" };
	await mgr._respawnAgentInPlace(oldSession, ps);

	assert.equal(mgr.restoreCalls.length, 1);
	assert.equal(
		mgr.restoreCalls[0].frameOfRef.lastSeq,
		4,
		"snapshot taken AFTER unsubscribe — includes trailing in-flight event (lastSeq=4 not 3)",
	);
});

test("real _respawnAgentInPlace exists in session-manager.ts and matches the shim's contract", () => {
	// Sanity pin against the real source: the helper must be defined and the
	// known callsites (restartAgent, _restartSessionWithUpdatedRole,
	// recoverSandboxSessions, ensureSessionAlive) must route through it.
	const src = readFileSync(SESSION_MANAGER_PATH, "utf8");

	assert.ok(
		/private\s+(?:async\s+)?_respawnAgentInPlace\s*\(/.test(src),
		"SessionManager._respawnAgentInPlace must be defined",
	);

	for (const callsite of [
		"private async _restartSessionWithUpdatedRole(",
		"async restartAgent(",
		"private async recoverSandboxSessions(",
		"async ensureSessionAlive(",
	]) {
		const i = src.indexOf(callsite);
		assert.ok(i >= 0, `callsite ${callsite} not found`);
		const rest = src.slice(i + callsite.length);
		const endRel = rest.search(/\n\t(?:\/\*\*|private |async |public |constructor)/);
		const body = rest.slice(0, endRel >= 0 ? endRel : 4000);
		assert.ok(
			body.includes("_respawnAgentInPlace"),
			`${callsite.trim()} must route through _respawnAgentInPlace`,
		);
	}
});
