/**
 * Pins the perm-frame seq-gap fix: when a client (re)attaches to a session
 * with a pending tool-permission, the on-attach branch in `ws/handler.ts`
 * must replay the ORIGINAL broadcast's `seq`/`ts` rather than allocating a
 * fresh seq from `EventBuffer.pushFrame()`.
 *
 * Bug shape (`src/server/ws/handler.ts:364-368` pre-fix):
 *
 *   const pendingPerm = sessionManager.getPendingToolPermission(sessionId);
 *   if (pendingPerm) {
 *     const { seq, ts } = session.eventBuffer.pushFrame();   // ← consumes a global seq
 *     send(ws, { type: "tool_permission_needed", ...pendingPerm, seq, ts });
 *   }
 *
 * `pushFrame()` increments the shared `nextSeq` counter for the session.
 * The frame is unicast to the joining socket only — every other already-
 * attached client never sees `seq=N+1`, so when the next live event arrives
 * at `seq=N+2` it is gap-buffered forever (waiting for missing `seq=N+1`)
 * until the `_pendingEventsMax = 500` overflow → forced snapshot kicks in.
 *
 * Three pins below — same shape as `tests/sandbox-recovery-respawn-helper.test.ts`:
 *
 *   1. Structural: `pushFrame()` is called from exactly ONE site in
 *      `src/server/` (excluding `event-buffer.ts` itself, where it's
 *      defined) — the body of `requestToolGrant` in `session-manager.ts`.
 *      Any future regression that re-introduces a unicast `pushFrame()` in
 *      `ws/handler.ts` (or anywhere else) fails CI immediately.
 *
 *   2. API-shape: `getPendingToolPermission()`'s return type exposes
 *      `seq` and `ts`. The handler-on-attach replay path must read them
 *      from this method, not allocate fresh.
 *
 *   3. Behavioural: simulate two attached clients + a late-joiner, mirror
 *      the broadcast + on-attach contract using `EventBuffer` directly,
 *      and assert the original clients see no gap when the late-joiner
 *      replay reuses the same `seq`. Drives a fake client sequencer that
 *      mirrors the production `_advanceTopLevelSeq` / `_drainOrderedEvents`
 *      logic in `src/app/remote-agent.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EventBuffer } from "../src/server/agent/event-buffer.ts";

const SRC_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"src",
	"server",
);
const HANDLER_PATH = path.join(SRC_DIR, "ws", "handler.ts");
const MANAGER_PATH = path.join(SRC_DIR, "agent", "session-manager.ts");
const EVENT_BUFFER_PATH = path.join(SRC_DIR, "agent", "event-buffer.ts");

// ── 1. Structural — single allocation site ──────────────────────────────────

test("pushFrame() is called from exactly one site in src/server/ — requestToolGrant only", async () => {
	// Walk src/server recursively, counting `eventBuffer.pushFrame(` occurrences.
	// `event-buffer.ts` itself defines the method — skip it.
	const fs = await import("node:fs");
	const path = await import("node:path");

	const callsites: Array<{ file: string; line: number; text: string }> = [];

	function walk(dir: string) {
		for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				walk(full);
			} else if (ent.isFile() && (ent.name.endsWith(".ts") || ent.name.endsWith(".tsx"))) {
				if (path.resolve(full) === path.resolve(EVENT_BUFFER_PATH)) continue;
				const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
				lines.forEach((text, i) => {
					if (/\bpushFrame\s*\(/.test(text)) {
						callsites.push({ file: path.relative(SRC_DIR, full), line: i + 1, text: text.trim() });
					}
				});
			}
		}
	}
	walk(SRC_DIR);

	const summary = callsites.map(c => `  ${c.file}:${c.line}  ${c.text}`).join("\n");
	assert.equal(
		callsites.length,
		1,
		`expected exactly ONE pushFrame() callsite in src/server/, got ${callsites.length}:\n${summary}`,
	);

	const only = callsites[0];
	assert.match(
		only.file.replace(/\\/g, "/"),
		/agent\/session-manager\.ts$/,
		`only pushFrame() callsite must live in agent/session-manager.ts — got ${only.file}`,
	);

	// And it must sit inside requestToolGrant — find that function's body and
	// assert the line number falls inside it.
	const mgrSrc = readFileSync(MANAGER_PATH, "utf8");
	const mgrLines = mgrSrc.split(/\r?\n/);
	const fnIdx = mgrLines.findIndex(l => /\basync\s+requestToolGrant\s*\(/.test(l));
	assert.ok(fnIdx >= 0, "requestToolGrant must be defined in session-manager.ts");
	// Find end-of-function: scan forward for the next top-level method declaration.
	let endIdx = mgrLines.length;
	for (let i = fnIdx + 1; i < mgrLines.length; i++) {
		if (/^\t(?:private |public |async |static |\/\*\*|[a-zA-Z_][a-zA-Z0-9_]*\s*\()/.test(mgrLines[i])
			&& !mgrLines[i].includes("requestToolGrant")) {
			// Heuristic: next member declaration at indent 1 (tab).
			endIdx = i;
			break;
		}
	}
	assert.ok(
		only.line > fnIdx + 1 && only.line <= endIdx + 1,
		`pushFrame() callsite at ${only.file}:${only.line} must lie inside requestToolGrant (lines ${fnIdx + 1}..${endIdx + 1})`,
	);
});

// ── 2. API-shape — getPendingToolPermission must expose seq + ts ────────────

test("getPendingToolPermission return type exposes seq + ts", () => {
	const src = readFileSync(MANAGER_PATH, "utf8");

	// Find the method declaration line and capture the return-type annotation.
	const re = /getPendingToolPermission\(id:\s*string\):\s*([\s\S]*?)\{/;
	const m = src.match(re);
	assert.ok(m, "getPendingToolPermission must be declared with a typed return");

	const ret = m[1];
	assert.match(
		ret,
		/\bseq\s*:\s*number\b/,
		`getPendingToolPermission return type must include 'seq: number' — got: ${ret.trim()}`,
	);
	assert.match(
		ret,
		/\bts\s*:\s*number\b/,
		`getPendingToolPermission return type must include 'ts: number' — got: ${ret.trim()}`,
	);
});

test("ws/handler.ts on-attach branch reads seq/ts from getPendingToolPermission, not from pushFrame()", () => {
	const src = readFileSync(HANDLER_PATH, "utf8");

	// Locate the on-attach pendingPerm block.
	const idx = src.indexOf("getPendingToolPermission");
	assert.ok(idx >= 0, "ws/handler.ts must call getPendingToolPermission");

	// Slice the relevant block — far enough to include the surrounding `if`/send.
	const block = src.slice(idx, idx + 600);

	assert.ok(
		!/\bpushFrame\s*\(/.test(block),
		`ws/handler.ts on-attach pendingPerm branch must NOT allocate a fresh seq via pushFrame(); ` +
		`replay the seq/ts from getPendingToolPermission instead. Block:\n${block}`,
	);

	// And the send() must forward seq+ts (from the spread of pendingPerm or explicit fields).
	assert.match(
		block,
		/send\(ws,\s*\{[\s\S]*tool_permission_needed[\s\S]*\}\)/,
		"ws/handler.ts must still send a tool_permission_needed frame to the late-joiner",
	);
});

// ── 3. Behavioural shim — late-joiner replay reuses original seq ────────────

/** Mirrors the production sequencer in `src/app/remote-agent.ts` —
 * top-level frames that carry seq must advance `_highestSeq`; out-of-order
 * `event` frames are gap-buffered. Identical shape to the existing fixture
 * `tests/fixtures/remote-agent-sequence-hole.html`. */
class FakeClient {
	highestSeq = 0;
	seqInitialized = false;
	pendingEvents: Array<{ seq: number; data: any }> = [];
	dispatched: Array<{ kind: string; seq: number; data?: any }> = [];
	cards: Array<{ seq: number; ts: number }> = [];

	private _drain() {
		while (this.pendingEvents.length > 0 && this.pendingEvents[0].seq === this.highestSeq + 1) {
			const next = this.pendingEvents.shift()!;
			this.highestSeq = next.seq;
			this.dispatched.push({ kind: "event", seq: next.seq, data: next.data });
		}
	}

	private _advanceTopLevel(seq: number): boolean {
		if (!this.seqInitialized) {
			this.highestSeq = seq - 1;
			this.seqInitialized = true;
		}
		if (seq <= this.highestSeq) return false;
		if (seq !== this.highestSeq + 1) {
			// Gap — production code would force a snapshot. For repro purposes
			// we just record the gap state; the test asserts no gap is hit.
			this.pendingEvents = [];
			this.highestSeq = seq;
			return true;
		}
		this.highestSeq = seq;
		return true;
	}

	receive(msg: any) {
		if (msg.type === "event") {
			const seq = msg.seq as number;
			if (!this.seqInitialized) {
				this.highestSeq = seq - 1;
				this.seqInitialized = true;
			}
			if (seq <= this.highestSeq) return;
			if (seq !== this.highestSeq + 1) {
				this.pendingEvents.push({ seq, data: msg.data });
				this.pendingEvents.sort((a, b) => a.seq - b.seq);
				return;
			}
			this.highestSeq = seq;
			this.dispatched.push({ kind: "event", seq, data: msg.data });
			this._drain();
			return;
		}
		if (msg.type === "tool_permission_needed") {
			if (!this._advanceTopLevel(msg.seq)) return;
			this.cards.push({ seq: msg.seq, ts: msg.ts });
			this._drain();
			return;
		}
	}

	get gapBuffered(): number {
		return this.pendingEvents.length;
	}
}

/**
 * Mini server shim mirroring the contract that `requestToolGrant` +
 * `getPendingToolPermission` + the on-attach handler branch must obey
 * AFTER the fix: the perm `seq`/`ts` is allocated once and stashed on the
 * pending-grant record; late-joiner attach REPLAYS that same seq, not a
 * fresh one.
 */
class FakeServer {
	clients = new Set<FakeClient>();
	buffer = new EventBuffer();
	pendingPerm?: { toolName: string; seq: number; ts: number };

	attach(client: FakeClient) {
		this.clients.add(client);
		// The fixed on-attach branch: replay the cached seq/ts from
		// getPendingToolPermission. NO pushFrame() here.
		if (this.pendingPerm) {
			client.receive({
				type: "tool_permission_needed",
				toolName: this.pendingPerm.toolName,
				seq: this.pendingPerm.seq,
				ts: this.pendingPerm.ts,
			});
		}
	}

	requestToolGrant(toolName: string) {
		const { seq, ts } = this.buffer.pushFrame();
		this.pendingPerm = { toolName, seq, ts };
		// Broadcast to all currently attached clients.
		for (const c of this.clients) {
			c.receive({ type: "tool_permission_needed", toolName, seq, ts });
		}
	}

	resolveGrant() {
		this.pendingPerm = undefined;
	}

	emitEvent(data: any) {
		const { seq, ts, event } = this.buffer.push(data);
		for (const c of this.clients) {
			c.receive({ type: "event", seq, ts, data: event });
		}
	}
}

test("late-joiner perm replay reuses original seq — original clients see NO gap on next live event", () => {
	const server = new FakeServer();
	const tab1 = new FakeClient();
	const tab2 = new FakeClient();
	server.attach(tab1);
	server.attach(tab2);

	// Step 1: agent calls a gated tool — perm broadcast at seq=1 to both tabs.
	server.requestToolGrant("Bash");
	assert.equal(tab1.cards.length, 1, "tab1 received perm card");
	assert.equal(tab2.cards.length, 1, "tab2 received perm card");
	assert.equal(tab1.cards[0].seq, 1);
	assert.equal(tab2.cards[0].seq, 1);
	assert.equal(tab1.highestSeq, 1, "tab1 advanced through perm seq");
	assert.equal(tab2.highestSeq, 1);

	// Step 2: tab2 disconnects briefly and a fresh tab3 attaches mid-perm.
	server.clients.delete(tab2);
	const tab3 = new FakeClient();
	server.attach(tab3);

	assert.equal(tab3.cards.length, 1, "tab3 got the perm replay on attach");
	assert.equal(
		tab3.cards[0].seq,
		1,
		"late-joiner replay must reuse the ORIGINAL perm seq (1), not allocate seq=2",
	);
	assert.equal(tab3.highestSeq, 1, "tab3 sequencer advanced through replayed perm");

	// Step 3: user grants. Agent emits next event — must land at seq=2, not seq=3.
	server.resolveGrant();
	server.emitEvent({ type: "agent_chunk", text: "ok" });

	assert.equal(
		tab1.gapBuffered,
		0,
		"tab1 must NOT gap-buffer the next event — original-tab gap is the bug",
	);
	assert.equal(tab1.highestSeq, 2, "tab1 dispatched the post-grant event");
	assert.equal(tab1.dispatched.length, 1, "tab1 dispatched exactly one event");
	assert.equal(tab1.dispatched[0].seq, 2);

	assert.equal(tab3.gapBuffered, 0, "tab3 also has no gap");
	assert.equal(tab3.highestSeq, 2);
});

test("FakeServer parity: if late-joiner attach allocated a fresh seq via pushFrame(), original tabs WOULD gap-buffer (negative control)", () => {
	// Negative control: this exercises the BROKEN behaviour to prove the
	// repro shim is sensitive to the bug it is pinning. We deliberately
	// reproduce the pre-fix `pushFrame()` allocation in the attach path and
	// assert that an already-attached client gap-buffers the next live event.
	class BrokenServer extends FakeServer {
		override attach(client: FakeClient) {
			this.clients.add(client);
			if (this.pendingPerm) {
				// PRE-FIX BUG: allocate a fresh seq, send only to joining client.
				const { seq, ts } = this.buffer.pushFrame();
				client.receive({
					type: "tool_permission_needed",
					toolName: this.pendingPerm.toolName,
					seq,
					ts,
				});
			}
		}
	}

	const server = new BrokenServer();
	const tab1 = new FakeClient();
	server.attach(tab1);
	server.requestToolGrant("Bash");
	assert.equal(tab1.highestSeq, 1);

	const tab3 = new FakeClient();
	server.attach(tab3); // ← consumes seq=2, sent only to tab3.

	// Now agent emits the post-grant event: it lands at seq=3.
	server.resolveGrant();
	server.emitEvent({ type: "agent_chunk", text: "ok" });

	// tab1 expected seq=2, got seq=3 — buffered as gap. THIS IS THE BUG.
	assert.equal(
		tab1.gapBuffered,
		1,
		"sanity: under the BROKEN pushFrame()-on-attach model, tab1 gap-buffers the next event",
	);
	assert.equal(tab1.highestSeq, 1, "tab1 stuck at original perm seq, never advanced through unicast seq=2");
	assert.equal(
		tab1.dispatched.length,
		0,
		"tab1 dispatched NOTHING after the grant — UI appears frozen",
	);
});
