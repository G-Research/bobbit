import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ClaudeCodeJsonlParser, ClaudeCodeStreamLimitError } from "../src/server/agent/claude-code-stream.ts";

function parseChunks(chunks: Array<Buffer | string>) {
	const parser = new ClaudeCodeJsonlParser();
	const events: any[] = [];
	const diagnostics: any[] = [];
	for (const chunk of chunks) {
		const result = parser.push(chunk);
		events.push(...result.events);
		diagnostics.push(...result.diagnostics);
	}
	const end = parser.end();
	events.push(...end.events);
	diagnostics.push(...end.diagnostics);
	return { events, diagnostics };
}

describe("ClaudeCodeJsonlParser", () => {
	it("parses multiple complete JSONL lines", () => {
		const { events, diagnostics } = parseChunks([
			'{"type":"system","subtype":"init"}\n{"type":"result","is_error":false}\n',
		]);
		assert.equal(events.length, 2);
		assert.equal(events[0].type, "system");
		assert.equal(events[1].type, "result");
		assert.equal(diagnostics.length, 0);
	});

	it("buffers incomplete trailing fragments until newline", () => {
		const parser = new ClaudeCodeJsonlParser();
		assert.equal(parser.push('{"type":"assistant"').events.length, 0);
		assert.deepEqual(parser.push('}\n').events, [{ type: "assistant" }]);
	});

	it("skips blank and non-JSON diagnostic lines while retaining diagnostics", () => {
		const { events, diagnostics } = parseChunks([
			'\nClaude Code starting...\n{"type":"result","is_error":false}\nnot json\n',
		]);
		assert.equal(events.length, 1);
		assert.equal(events[0].type, "result");
		assert.equal(diagnostics.length, 2);
		assert.match(diagnostics[0].message, /Ignoring non-JSON/);
	});

	it("reassembles multibyte UTF-8 split across every chunk boundary", () => {
		const text = "日本語 🚀 café";
		const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }) + "\n";
		const buf = Buffer.from(line, "utf8");
		for (let split = 1; split < buf.length; split++) {
			const { events } = parseChunks([buf.subarray(0, split), buf.subarray(split)]);
			assert.equal(events[0].message.content[0].text, text, `split ${split} corrupted UTF-8`);
		}
	});

	it("parses a final unterminated JSON line on end()", () => {
		const parser = new ClaudeCodeJsonlParser();
		assert.equal(parser.push('{"type":"result"}').events.length, 0);
		assert.deepEqual(parser.end().events, [{ type: "result" }]);
	});

	it("fails closed when a JSONL line exceeds the configured bound", () => {
		const parser = new ClaudeCodeJsonlParser({ maxJsonlLineLength: 20 });
		assert.throws(() => parser.push('{"type":"assistant","x":"too long"}\n'), ClaudeCodeStreamLimitError);
	});

	it("truncates retained non-JSON diagnostics", () => {
		const parser = new ClaudeCodeJsonlParser({ maxDiagnosticLineLength: 8 });
		const result = parser.push("not json but very long\n");
		assert.equal(result.diagnostics.length, 1);
		assert.equal(result.diagnostics[0].line.length, 8);
		assert.match(result.diagnostics[0].line, /…$/);
	});
});
