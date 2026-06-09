/**
 * Unit tests for the internal→contract ADAPTER
 * (src/server/extension-host/contract-adapter.ts) — design
 * docs/design/extension-host-phase2.md §4 (B2) / extension-host.md §3 ADAPTER SEAM.
 *
 * Pinned invariants:
 *   - Internal transcript JSONL rows → frozen HostMessage / HostContentBlock /
 *     ToolCallRecord shapes (the decoupling layer packs see).
 *   - BOTH tool_use wire shapes are tolerated: Anthropic {type:"tool_use",id,name}
 *     and pi-coding-agent {toolCallId,toolName} — same shape-tolerance as
 *     action-guard.ts::transcriptHasToolUse, but emitting blocks not a boolean.
 *   - tool_result blocks (Anthropic block-level + pi message-level toolResult).
 *   - CONTRACT_VERSION === HOST_CONTRACT_VERSION.
 *   - Unknown block types are tolerated (skipped, render nothing).
 *   - Reads are scoped to the OWN session by construction — the adapter takes only
 *     a JSONL string + (for tool-call) a toolUseId; there is NO other-session param.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	transcriptToHostMessages,
	transcriptToToolCall,
	buildTranscriptEnvelope,
	CONTRACT_VERSION,
} from "../src/server/extension-host/contract-adapter.ts";
import { HOST_CONTRACT_VERSION } from "../src/shared/extension-host/host-api.ts";

const line = (obj: unknown) => JSON.stringify(obj);

describe("CONTRACT_VERSION", () => {
	it("equals the frozen HOST_CONTRACT_VERSION (single source of truth)", () => {
		assert.equal(CONTRACT_VERSION, HOST_CONTRACT_VERSION);
	});
});

describe("transcriptToHostMessages — basic mapping", () => {
	it("maps role + text blocks and assigns an id/ts", () => {
		const jsonl = [
			line({ type: "message", id: "e1", ts: "2024-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
			line({ type: "message", id: "e2", timestamp: "2024-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }),
		].join("\n");
		const msgs = transcriptToHostMessages(jsonl);
		assert.equal(msgs.length, 2);
		assert.deepEqual(msgs[0], { id: "e1", role: "user", content: [{ type: "text", text: "hello" }], ts: Date.parse("2024-01-01T00:00:00.000Z") });
		assert.equal(msgs[1].role, "assistant");
		assert.equal(msgs[1].ts, Date.parse("2024-01-01T00:00:01.000Z"));
	});

	it("treats a string message body as a single text block", () => {
		const jsonl = line({ type: "message", id: "e1", message: { role: "user", content: "plain string" } });
		const msgs = transcriptToHostMessages(jsonl);
		assert.deepEqual(msgs[0].content, [{ type: "text", text: "plain string" }]);
	});

	it("synthesizes an id when the entry has none, and ts=0 when absent", () => {
		const jsonl = line({ type: "message", message: { role: "system", content: [{ type: "text", text: "x" }] } });
		const msgs = transcriptToHostMessages(jsonl);
		assert.equal(msgs[0].id, "msg-0");
		assert.equal(msgs[0].ts, 0);
		assert.equal(msgs[0].role, "system");
	});

	it("returns [] for empty/nullish input and skips unparseable lines", () => {
		assert.deepEqual(transcriptToHostMessages(undefined), []);
		assert.deepEqual(transcriptToHostMessages(null), []);
		assert.deepEqual(transcriptToHostMessages(""), []);
		const jsonl = ["{not json", line({ type: "message", id: "ok", message: { role: "user", content: [{ type: "text", text: "y" }] } })].join("\n");
		const msgs = transcriptToHostMessages(jsonl);
		assert.equal(msgs.length, 1);
		assert.equal(msgs[0].id, "ok");
	});
});

describe("transcriptToHostMessages — tool_use shapes", () => {
	it("maps the Anthropic {type:'tool_use',id,name,input} shape", () => {
		const jsonl = line({ type: "message", id: "e1", message: { role: "assistant", content: [
			{ type: "tool_use", id: "tu-1", name: "sample_action", input: { foo: 1 } },
		] } });
		const [m] = transcriptToHostMessages(jsonl);
		assert.deepEqual(m.content, [{ type: "tool_use", toolUseId: "tu-1", tool: "sample_action", input: { foo: 1 } }]);
	});

	it("maps the pi-coding-agent {toolCallId,toolName} shape", () => {
		const jsonl = line({ type: "message", id: "e1", message: { role: "assistant", content: [
			{ toolCallId: "tu-9", toolName: "sample_action", args: { a: true } },
		] } });
		const [m] = transcriptToHostMessages(jsonl);
		assert.deepEqual(m.content, [{ type: "tool_use", toolUseId: "tu-9", tool: "sample_action", input: { a: true } }]);
	});
});

describe("transcriptToHostMessages — tool_result shapes", () => {
	it("maps an Anthropic block-level tool_result (is_error)", () => {
		const jsonl = line({ type: "message", id: "e1", message: { role: "user", content: [
			{ type: "tool_result", tool_use_id: "tu-1", content: "out", is_error: true },
		] } });
		const [m] = transcriptToHostMessages(jsonl);
		assert.deepEqual(m.content, [{ type: "tool_result", toolUseId: "tu-1", output: "out", isError: true }]);
	});

	it("maps a pi-coding-agent message-level toolResult row → user role + tool_result block", () => {
		const jsonl = line({ type: "message", id: "e1", message: { role: "toolResult", toolCallId: "tu-2", toolName: "sample_action", isError: false, content: [{ type: "text", text: "ok" }] } });
		const [m] = transcriptToHostMessages(jsonl);
		assert.equal(m.role, "user");
		assert.deepEqual(m.content, [{ type: "tool_result", toolUseId: "tu-2", output: [{ type: "text", text: "ok" }], isError: false }]);
	});
});

describe("transcriptToHostMessages — tolerance", () => {
	it("skips unknown block types (renders nothing) but keeps known siblings", () => {
		const jsonl = line({ type: "message", id: "e1", message: { role: "assistant", content: [
			{ type: "thinking", thinking: "secret" },
			{ type: "text", text: "visible" },
			{ type: "image", source: {} },
		] } });
		const [m] = transcriptToHostMessages(jsonl);
		assert.deepEqual(m.content, [{ type: "text", text: "visible" }]);
	});

	it("skips entries without a message object", () => {
		const jsonl = [
			line({ type: "compaction", id: "c1" }),
			line({ type: "message", id: "e1", message: { role: "user", content: [{ type: "text", text: "kept" }] } }),
		].join("\n");
		const msgs = transcriptToHostMessages(jsonl);
		assert.equal(msgs.length, 1);
		assert.equal(msgs[0].id, "e1");
	});
});

describe("transcriptToToolCall", () => {
	const jsonl = [
		line({ type: "message", id: "e1", message: { role: "assistant", content: [
			{ type: "text", text: "calling" },
			{ type: "tool_use", id: "tu-1", name: "sample_action", input: { q: "x" } },
		] } }),
		line({ type: "message", id: "e2", message: { role: "user", content: [
			{ type: "tool_result", tool_use_id: "tu-1", content: "the output", is_error: false },
		] } }),
	].join("\n");

	it("joins a tool_use with its later tool_result", () => {
		const rec = transcriptToToolCall(jsonl, "tu-1");
		assert.deepEqual(rec, { toolUseId: "tu-1", tool: "sample_action", input: { q: "x" }, output: "the output", isError: false });
	});

	it("returns the call with null output when no result row exists yet", () => {
		const onlyCall = line({ type: "message", id: "e1", message: { role: "assistant", content: [
			{ type: "tool_use", id: "tu-7", name: "t", input: {} },
		] } });
		const rec = transcriptToToolCall(onlyCall, "tu-7");
		assert.deepEqual(rec, { toolUseId: "tu-7", tool: "t", input: {}, output: null, isError: false });
	});

	it("returns null when the tool_use id is not present (own-session, no other-session param)", () => {
		assert.equal(transcriptToToolCall(jsonl, "tu-missing"), null);
		assert.equal(transcriptToToolCall(null, "tu-1"), null);
		assert.equal(transcriptToToolCall(jsonl, ""), null);
	});

	it("joins the pi-coding-agent message-level toolResult by toolCallId", () => {
		const piJsonl = [
			line({ type: "message", id: "e1", message: { role: "assistant", content: [
				{ toolCallId: "tu-9", toolName: "sample_action", args: { a: 1 } },
			] } }),
			line({ type: "message", id: "e2", message: { role: "toolResult", toolCallId: "tu-9", toolName: "sample_action", isError: true, content: "boom" } }),
		].join("\n");
		const rec = transcriptToToolCall(piJsonl, "tu-9");
		assert.deepEqual(rec, { toolUseId: "tu-9", tool: "sample_action", input: { a: 1 }, output: "boom", isError: true });
	});
});

describe("buildTranscriptEnvelope", () => {
	const messages = transcriptToHostMessages([
		line({ type: "message", id: "e1", message: { role: "user", content: [{ type: "text", text: "alpha" }] } }),
		line({ type: "message", id: "e2", message: { role: "assistant", content: [{ type: "text", text: "beta" }] } }),
		line({ type: "message", id: "e3", message: { role: "user", content: [{ type: "text", text: "gamma" }] } }),
	].join("\n"));

	it("returns all messages with total/returned when unpaged", () => {
		const env = buildTranscriptEnvelope(messages);
		assert.equal(env.total, 3);
		assert.equal(env.returned, 3);
		assert.equal(env.messages.length, 3);
	});

	it("windows by offset + limit", () => {
		const env = buildTranscriptEnvelope(messages, { offset: 1, limit: 1 });
		assert.equal(env.total, 3);
		assert.equal(env.returned, 1);
		assert.equal(env.messages[0].id, "e2");
	});

	it("filters by pattern (total counts the filtered population)", () => {
		const env = buildTranscriptEnvelope(messages, { pattern: "gamma" });
		assert.equal(env.total, 1);
		assert.equal(env.returned, 1);
		assert.equal(env.messages[0].id, "e3");
	});

	it("throws on an invalid regex pattern", () => {
		assert.throws(() => buildTranscriptEnvelope(messages, { pattern: "(" }));
	});
});
