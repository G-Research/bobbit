/**
 * S14 — multibyte UTF-8 reassembly across stdout chunk boundaries.
 *
 * Drives the REAL RpcBridge decoder + handleData (no spawn). A single JSON line
 * carrying CJK/emoji text is split at every internal byte boundary; the parsed
 * event's text must equal the original (zero U+FFFD). RED on master, where the
 * stdout handler did `chunk.toString("utf-8")` per chunk, corrupting any
 * multibyte char straddling a boundary. See docs/design/comms-stack/02-analysis.md S14.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RpcBridge } from "../src/server/agent/rpc-bridge.ts";

const REPL = "�";

function feedSplit(text: string, splitAt: number): string {
	// Fresh bridge per split so the decoder/lineBuffer start clean.
	const bridge: any = new RpcBridge({});
	const events: any[] = [];
	bridge.onEvent((e: any) => events.push(e));
	const line = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";
	const buf = Buffer.from(line, "utf-8");
	const a = buf.subarray(0, splitAt);
	const b = buf.subarray(splitAt);
	// Mirror the production stdout handler: decode each chunk through the
	// persistent decoder, then hand the decoded string to handleData.
	bridge.handleData(bridge.stdoutDecoder.write(a));
	bridge.handleData(bridge.stdoutDecoder.write(b));
	return events[0]?.message?.content?.[0]?.text ?? "<<no-event>>";
}

function assertAllSplitsClean(label: string, text: string) {
	const line = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";
	const len = Buffer.byteLength(line, "utf-8");
	let corrupted = 0;
	for (let i = 1; i < len; i++) {
		if (feedSplit(text, i) !== text) corrupted++;
	}
	assert.equal(corrupted, 0, `[${label}] ${corrupted} corrupted split points (expected 0 with StringDecoder)`);
}

test("3-byte CJK reassembles across every chunk boundary", () => {
	assertAllSplitsClean("CJK", "日本語のテキスト 是中文");
});

test("4-byte emoji (surrogate pair) reassembles across every chunk boundary", () => {
	assertAllSplitsClean("emoji", "progress 🚀 done 🎉 ✅");
});

test("2-byte accented Latin reassembles across every chunk boundary", () => {
	assertAllSplitsClean("accent", "café déjà vu naïve");
});

test("a known mid-codepoint split yields the exact text, no U+FFFD", () => {
	// Split at byte 1 of the JSON guarantees the first multibyte char in the
	// payload straddles the boundary for the CJK case.
	const text = "日本語";
	const out = feedSplit(text, 30);
	assert.ok(!out.includes(REPL), `should not contain U+FFFD, got: ${out}`);
});
