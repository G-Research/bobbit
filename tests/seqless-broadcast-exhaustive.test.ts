/**
 * WP4 / RC3 — the seq-less bypass broadcast set is exhausted.
 *
 * Every stream `{type:"event"}` frame MUST go through emitSessionEvent (which
 * assigns a seq, enters the EventBuffer, and replays on resume). Three frames
 * previously bypassed it (auto_retry_pending, auto_retry_cancelled, forceAbort
 * agent_end), so a reconnect during backoff/abort orphaned a stale banner or
 * stranded a streaming partial (S5/S21). Source-scan structural pin: fails if a
 * raw `broadcast(..., {type:"event", ...})` is reintroduced in session-manager.ts
 * or the extracted session-steering.ts.
 * See docs/design/comms-stack/02-analysis.md §RC3.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/** Strip block + line comments so doc examples of the old pattern don't match. */
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

test("no raw broadcast({type:'event'}) sites remain in session event sources (code, not comments)", () => {
	const sources = [
		"src/server/agent/session-manager.ts",
		"src/server/agent/session-steering.ts",
	];
	// A broadcast(...) whose frame literal carries type:"event", tolerant of
	// newlines between the call and the key. emitSessionEvent is the only path.
	const re = /broadcast\s*\([^;]*?\btype:\s*["']event["']/gs;
	const hits = sources.flatMap((sourcePath) => {
		const raw = fs.readFileSync(path.resolve(sourcePath), "utf-8");
		return (stripComments(raw).match(re) ?? []).map((hit) => ({ sourcePath, hit }));
	});
	assert.deepEqual(
		hits,
		[],
		`Found ${hits.length} raw broadcast({type:"event"}) site(s). Route stream events through ` +
			`emitSessionEvent so they are seq-stamped + buffered + replayable:\n` +
			hits.map(({ sourcePath, hit }) => `  ${sourcePath}: ${hit.replace(/\s+/g, " ").slice(0, 100)}`).join("\n"),
	);
});

test("the three former bypass frames are emitted via emitSessionEvent", () => {
	const managerSrc = fs.readFileSync(path.resolve("src/server/agent/session-manager.ts"), "utf-8");
	const steeringSrc = fs.readFileSync(path.resolve("src/server/agent/session-steering.ts"), "utf-8");
	// Assert the exact emit-call expressions exist (guards against a regression
	// that drops the frames entirely instead of re-routing them).
	for (const [src, call] of [
		[steeringSrc, "emitSessionEvent(session, pendingEvent)"],
		[steeringSrc, "emitSessionEvent(session, cancelledEvent)"],
		[managerSrc, 'emitSessionEvent(session, { type: "agent_end", messages: [] })'],
	] as const) {
		assert.ok(src.includes(call), `expected call: ${call} (WP4/RC3)`);
	}
});
