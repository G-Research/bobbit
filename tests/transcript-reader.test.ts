import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	readTranscript,
	parseJsonl,
	resolveOffset,
	TranscriptReaderError,
	type ReadTranscriptEnvelope,
} from "../src/server/agent/transcript-reader.js";

function makeJsonl(messages: Array<{ role: string; content: any; ts?: string }>): string {
	return messages
		.map((m) => JSON.stringify({ type: "message", ts: m.ts, message: { role: m.role, content: m.content } }))
		.join("\n") + "\n";
}

const sample = makeJsonl([
	{ role: "user", content: "hello world", ts: "2026-05-04T00:00:00Z" },
	{ role: "assistant", content: [{ type: "text", text: "hi there" }] },
	{ role: "user", content: "this contains an ERROR" },
	{ role: "assistant", content: [{ type: "tool_use", name: "bash", input: { cmd: "ls" } }] },
	{ role: "user", content: "another line" },
	{ role: "assistant", content: [{ type: "text", text: "second error in transcript" }] },
	{ role: "user", content: "final" },
]);

const reader = (s: string) => ({ readContent: async () => s });

describe("transcript-reader / parseJsonl", () => {
	it("skips blank and malformed lines", () => {
		const text = "\n{not json}\n" + JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }) + "\n";
		const out = parseJsonl(text);
		assert.equal(out.length, 1);
		assert.equal(out[0].role, "user");
		assert.equal(out[0].index, 0);
	});

	it("ignores non-message envelopes", () => {
		const text = JSON.stringify({ type: "agent_start" }) + "\n" +
			JSON.stringify({ type: "message", message: { role: "user", content: "x" } });
		const out = parseJsonl(text);
		assert.equal(out.length, 1);
	});
});

describe("transcript-reader / resolveOffset", () => {
	it("non-negative passes through", () => {
		assert.equal(resolveOffset(3, 10), 3);
		assert.equal(resolveOffset(0, 10), 0);
	});
	it("negative indexes from end", () => {
		assert.equal(resolveOffset(-1, 10), 9);
		assert.equal(resolveOffset(-10, 10), 0);
	});
	it("clamps negative beyond start to 0", () => {
		assert.equal(resolveOffset(-20, 5), 0);
	});
});

describe("transcript-reader / readTranscript", () => {
	it("default offset/limit returns first 20", async () => {
		const env = await readTranscript({}, reader(sample));
		assert.equal(env.total, 7);
		assert.equal(env.returned, 7);
		assert.equal(env.offsetStart, 0);
		assert.equal(env.offsetEnd, 6);
	});

	it("positive slicing", async () => {
		const env = await readTranscript({ offset: 2, limit: 3 }, reader(sample));
		assert.equal(env.returned, 3);
		assert.equal(env.offsetStart, 2);
		assert.equal(env.offsetEnd, 4);
	});

	it("negative offset (tail)", async () => {
		const env = await readTranscript({ offset: -2, limit: 2 }, reader(sample));
		assert.equal(env.returned, 2);
		assert.equal(env.offsetStart, 5);
		assert.equal(env.offsetEnd, 6);
	});

	it("offset = -1 returns last message only", async () => {
		const env = await readTranscript({ offset: -1, limit: 1 }, reader(sample));
		assert.equal(env.returned, 1);
		assert.equal(env.offsetStart, 6);
	});

	it("out-of-range positive offset returns empty + total", async () => {
		const env = await readTranscript({ offset: 100, limit: 5 }, reader(sample));
		assert.equal(env.total, 7);
		assert.equal(env.returned, 0);
		assert.equal(env.offsetStart, -1);
		assert.equal(env.offsetEnd, -1);
		assert.deepEqual(env.messages, []);
	});

	it("compact rendering trims long text and includes tool blocks", async () => {
		const long = "x".repeat(2000);
		const j = makeJsonl([
			{ role: "assistant", content: [
				{ type: "text", text: long },
				{ type: "tool_use", name: "bash", input: { cmd: "echo hi" } },
				{ type: "tool_result", content: "y".repeat(500) },
			] },
		]);
		const env = await readTranscript({}, reader(j));
		const m = env.messages[0] as any;
		assert.ok(m.text.length <= 800 + 1, `text length=${m.text.length}`);
		assert.equal(m.toolUses.length, 1);
		assert.equal(m.toolUses[0].name, "bash");
		assert.ok(m.toolUses[0].inputPreview.length <= 200);
		assert.equal(m.toolResults.length, 1);
		assert.ok(m.toolResults[0].preview.length <= 200);
	});

	it("verbose returns raw content", async () => {
		const env = await readTranscript({ offset: 1, limit: 1, verbose: true }, reader(sample));
		const m = env.messages[0] as any;
		assert.ok(Array.isArray(m.content));
		assert.equal(m.content[0].type, "text");
	});

	it("pattern filters to matches and reports matchCount", async () => {
		const env = await readTranscript({ pattern: "error" }, reader(sample));
		assert.equal(env.total, 7);
		assert.equal(env.matchCount, 2);
		assert.equal(env.returned, 2);
		const indices = env.messages.map((m) => m.index);
		assert.deepEqual(indices, [2, 5]);
	});

	it("pattern with case_sensitive misses lowercase", async () => {
		const env = await readTranscript({ pattern: "ERROR", caseSensitive: true }, reader(sample));
		assert.equal(env.matchCount, 1);
		assert.equal(env.returned, 1);
		assert.equal(env.messages[0].index, 2);
	});

	it("pattern + window: last 1 of 2 matches", async () => {
		const env = await readTranscript({ pattern: "error", offset: -1, limit: 1 }, reader(sample));
		assert.equal(env.matchCount, 2);
		assert.equal(env.returned, 1);
		assert.equal(env.messages[0].index, 5);
	});

	it("pattern + context expands neighbours and dedupes", async () => {
		// matches at 2 and 5; ±1 context expands to {1,2,3,4,5,6}
		const env = await readTranscript({ pattern: "error", context: 1 }, reader(sample));
		assert.equal(env.matchCount, 2);
		const indices = env.messages.map((m) => m.index);
		assert.deepEqual(indices, [1, 2, 3, 4, 5, 6]);
	});

	it("invalid regex throws invalid_regex", async () => {
		await assert.rejects(
			() => readTranscript({ pattern: "(" }, reader(sample)),
			(err: unknown) => err instanceof TranscriptReaderError && err.code === "invalid_regex",
		);
	});

	it("limit out of range throws invalid_params", async () => {
		await assert.rejects(
			() => readTranscript({ limit: 0 }, reader(sample)),
			(err: unknown) => err instanceof TranscriptReaderError && err.code === "invalid_params",
		);
		await assert.rejects(
			() => readTranscript({ limit: 1000 }, reader(sample)),
			(err: unknown) => err instanceof TranscriptReaderError && err.code === "invalid_params",
		);
	});

	it("context > 5 throws invalid_params", async () => {
		await assert.rejects(
			() => readTranscript({ pattern: "x", context: 6 }, reader(sample)),
			(err: unknown) => err instanceof TranscriptReaderError && err.code === "invalid_params",
		);
	});

	it("empty content throws transcript_unavailable", async () => {
		await assert.rejects(
			() => readTranscript({}, reader("")),
			(err: unknown) => err instanceof TranscriptReaderError && err.code === "transcript_unavailable",
		);
	});

	it("null content throws transcript_unavailable", async () => {
		await assert.rejects(
			() => readTranscript({}, { readContent: async () => null }),
			(err: unknown) => err instanceof TranscriptReaderError && err.code === "transcript_unavailable",
		);
	});

	it("envelope exposes matchCount only when pattern is set", async () => {
		const noPattern = await readTranscript({}, reader(sample));
		assert.equal((noPattern as ReadTranscriptEnvelope).matchCount, undefined);
		const withPattern = await readTranscript({ pattern: "x" }, reader(sample));
		assert.equal(typeof withPattern.matchCount, "number");
	});
});
