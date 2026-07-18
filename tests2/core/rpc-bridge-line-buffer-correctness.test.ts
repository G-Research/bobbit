import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { RpcBridge } from "../../src/server/agent/rpc-bridge.ts";

function marker(seq: number, payload = ""): string {
	return JSON.stringify({ type: "line_buffer_marker", seq, payload });
}

function feed(chunks: readonly string[]): { bridge: any; events: any[] } {
	const bridge: any = new RpcBridge({});
	const events: any[] = [];
	bridge.onEvent((event: any) => events.push(event));
	for (const chunk of chunks) bridge.handleData(chunk);
	return { bridge, events };
}

/** Reference the framing behavior that handleData used before incremental scanning. */
function naiveCompleteLines(chunks: readonly string[]): string[] {
	let buffer = "";
	const complete: string[] = [];
	for (const chunk of chunks) {
		buffer += chunk;
		const lines = buffer.split("\n");
		buffer = lines.pop()!;
		for (const line of lines) {
			const trimmed = line.replace(/\r$/, "").trim();
			if (trimmed) complete.push(trimmed);
		}
	}
	return complete;
}

describe("RpcBridge incremental JSONL framing", () => {
	it("matches the former scanner across partial, packed, blank, CRLF, and non-JSON lines", () => {
		const lines = [marker(0), "not json", marker(1, "  content stays exact  "), marker(2)];
		const stream = `  ${lines[0]}  \r\n\n${lines[1]}\n${lines[2]}\r\n   \n${lines[3]}\n`;
		const cuts = [1, 2, 9, 31, 32, 67, stream.length - 2];
		const chunks: string[] = [];
		let start = 0;
		for (const end of cuts) {
			chunks.push(stream.slice(start, end), "");
			start = end;
		}
		chunks.push(stream.slice(start));

		const expected = naiveCompleteLines(chunks)
			.flatMap(line => {
				try { return [JSON.parse(line)]; } catch { return []; }
			});
		const { events } = feed(chunks);

		assert.deepEqual(events, expected);
	});

	it("retains a partial line verbatim and dispatches it exactly once when completed", () => {
		const full = marker(7, "partial payload");
		const splitAt = Math.floor(full.length / 2);
		const bridge: any = new RpcBridge({});
		const events: any[] = [];
		bridge.onEvent((event: any) => events.push(event));

		bridge.handleData(full.slice(0, splitAt));
		bridge.handleData("");
		assert.deepEqual(events, []);
		assert.equal(bridge.lineBuffer, full.slice(0, splitAt));

		bridge.handleData(full.slice(splitAt));
		assert.deepEqual(events, []);
		assert.equal(bridge.lineBuffer, full);

		bridge.handleData("\n");
		assert.deepEqual(events, [JSON.parse(full)]);
		assert.equal(bridge.lineBuffer, "");
	});

	it("preserves line order and listener registration order", () => {
		const bridge: any = new RpcBridge({});
		const calls: string[] = [];
		bridge.onEvent((event: any) => calls.push(`a${event.seq}`));
		bridge.onEvent((event: any) => calls.push(`b${event.seq}`));

		bridge.handleData(`${marker(1)}\n${marker(2)}\n${marker(3)}\n`);

		assert.deepEqual(calls, ["a1", "b1", "a2", "b2", "a3", "b3"]);
	});

	it("resolves matching responses without emitting them and emits unmatched responses", () => {
		const bridge: any = new RpcBridge({});
		const events: any[] = [];
		const resolved: any[] = [];
		bridge.onEvent((event: any) => events.push(event));
		bridge.pending.set("req_1", {
			resolve: (value: any) => resolved.push(value),
			reject: () => {},
			timeout: undefined,
		});

		const matching = { type: "response", id: "req_1", success: true };
		const unmatched = { type: "response", id: "req_missing", success: false };
		bridge.handleData(`${JSON.stringify(matching)}\n${JSON.stringify(unmatched)}\n`);

		assert.deepEqual(resolved, [matching]);
		assert.deepEqual(events, [unmatched]);
		assert.equal(bridge.pending.has("req_1"), false);
	});

	it("propagates listener errors while retaining only the final incomplete fragment", () => {
		const bridge: any = new RpcBridge({});
		const seen: number[] = [];
		let throwOnce = true;
		bridge.onEvent((event: any) => {
			seen.push(event.seq);
			if (throwOnce) {
				throwOnce = false;
				throw new Error("listener failed");
			}
		});

		const trailing = marker(3).slice(0, -1);
		assert.throws(
			() => bridge.handleData(`${marker(1)}\n${marker(2)}\n${trailing}`),
			/listener failed/,
		);
		assert.equal(bridge.lineBuffer, trailing);

		bridge.handleData("}\n");
		assert.deepEqual(seen, [1, 3], "unprocessed complete lines are not replayed after an error");
	});

	it("keeps multibyte content lossless when StringDecoder receives split bytes", () => {
		const text = "日本語 🚀 café";
		const line = marker(4, text) + "\n";
		const bytes = Buffer.from(line, "utf8");
		const payloadStart = bytes.indexOf(Buffer.from("日本語", "utf8"));
		const splitAt = payloadStart + 1;
		const bridge: any = new RpcBridge({});
		const events: any[] = [];
		bridge.onEvent((event: any) => events.push(event));

		bridge.handleData(bridge.stdoutDecoder.write(bytes.subarray(0, splitAt)));
		bridge.handleData(bridge.stdoutDecoder.write(bytes.subarray(splitAt)));

		assert.equal(events.length, 1);
		assert.equal(events[0].payload, text);
	});

	it("reassembles a large line split across many chunks without changing content", () => {
		const payload = "abcdef0123456789".repeat(32 * 1024);
		const line = marker(9, payload) + "\n";
		const bridge: any = new RpcBridge({});
		const events: any[] = [];
		bridge.onEvent((event: any) => events.push(event));
		for (let offset = 0; offset < line.length; offset += 4093) {
			bridge.handleData(line.slice(offset, offset + 4093));
		}

		assert.equal(events.length, 1);
		assert.equal(events[0].seq, 9);
		assert.equal(events[0].payload, payload);
	});
});
