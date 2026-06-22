/**
 * Unit test: transcript sanitizer — un-poison persisted blank-text user
 * messages in an agent `.jsonl` at the rehydration boundary.
 *
 * Covers:
 *   (a) image-adjacent blank-text user message  → rewritten to "Attachments:"
 *   (b) standalone blank-text user message (non-image attachment-only send)
 *       → rewritten to "Attachments:"
 *   (c) user message with NO text block (only image)  → leading text inserted
 *   (d) string-content blank user message  → rewritten
 *   (e) valid transcripts pass through unchanged + byte-identical (idempotent)
 *   (f) assistant / non-user blank messages are NOT touched
 *   (g) valid tool-result history is left byte-identical while orphan results
 *       are dropped or filtered
 *
 * Run with:
 *   npx tsx --test --test-force-exit tests/transcript-sanitizer.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	sanitizeTranscriptContent,
	sanitizeAgentTranscriptFile,
	rebaseTranscriptCwdMetadataContent,
	isWithinAgentSessionsDir,
	resolveSafeSessionsPath,
} from "../src/server/agent/transcript-sanitizer.ts";

function msg(role: string, content: unknown, id = "x"): string {
	return JSON.stringify({ type: "message", id, ts: "2026-01-01T00-00-00-000Z", message: { role, content } });
}

function assistantToolCall(toolCallId: string, id = `assistant-${toolCallId}`, stopReason?: string): string {
	return JSON.stringify({
		type: "message",
		id,
		ts: "2026-01-01T00-00-00-000Z",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: "bash", input: { command: "echo ok" } }],
			...(stopReason ? { stopReason } : {}),
		},
	});
}

function assistantToolUse(toolCallId: string, id = `assistant-${toolCallId}`): string {
	return JSON.stringify({
		type: "message",
		id,
		ts: "2026-01-01T00-00-00-000Z",
		message: {
			role: "assistant",
			content: [{ type: "tool_use", id: toolCallId, name: "bash", input: { command: "echo ok" } }],
		},
	});
}

function assistantPiToolCall(toolCallId: string, id = `assistant-${toolCallId}`): string {
	return JSON.stringify({
		type: "message",
		id,
		ts: "2026-01-01T00-00-00-000Z",
		message: {
			role: "assistant",
			content: [{ toolCallId, toolName: "bash", args: { command: "echo ok" } }],
		},
	});
}

function toolResultRow(toolCallId: string, id = `result-${toolCallId}`): string {
	return JSON.stringify({
		type: "message",
		id,
		ts: "2026-01-01T00-00-00-000Z",
		message: { role: "toolResult", toolCallId, content: "ok done" },
	});
}

const IMG = { type: "image", source: { data: "AAAA" } };

describe("sanitizeTranscriptContent", () => {
	it("(a) rewrites image-adjacent blank-text user message", () => {
		const line = msg("user", [{ type: "text", text: "" }, IMG]);
		const { content, changed, rewritten } = sanitizeTranscriptContent(line);
		assert.equal(changed, true);
		assert.equal(rewritten, 1);
		const parsed = JSON.parse(content);
		assert.equal(parsed.message.content[0].text, "Attachments:");
		// image block preserved
		assert.deepEqual(parsed.message.content[1], IMG);
	});

	it("(b) rewrites standalone blank-text user message", () => {
		const line = msg("user", [{ type: "text", text: "" }]);
		const { content, changed } = sanitizeTranscriptContent(line);
		assert.equal(changed, true);
		assert.equal(JSON.parse(content).message.content[0].text, "Attachments:");
	});

	it("(c) inserts leading text block when user message has only an image", () => {
		const line = msg("user", [IMG]);
		const { content, changed } = sanitizeTranscriptContent(line);
		assert.equal(changed, true);
		const blocks = JSON.parse(content).message.content;
		assert.equal(blocks[0].type, "text");
		assert.equal(blocks[0].text, "Attachments:");
		assert.deepEqual(blocks[1], IMG);
	});

	it("(d) rewrites blank string-content user message", () => {
		const line = msg("user", "   ");
		const { content, changed } = sanitizeTranscriptContent(line);
		assert.equal(changed, true);
		assert.equal(JSON.parse(content).message.content, "Attachments:");
	});

	it("(e) leaves a valid transcript byte-identical (idempotent)", () => {
		const valid = [
			msg("user", [{ type: "text", text: "hello" }]),
			msg("assistant", [{ type: "text", text: "hi" }]),
			msg("user", "plain text"),
		].join("\n");
		const first = sanitizeTranscriptContent(valid);
		assert.equal(first.changed, false);
		assert.equal(first.content, valid);
		// Re-running a sanitized output is also a no-op.
		const poisoned = msg("user", [{ type: "text", text: "" }, IMG]);
		const once = sanitizeTranscriptContent(poisoned);
		const twice = sanitizeTranscriptContent(once.content);
		assert.equal(twice.changed, false);
		assert.equal(twice.content, once.content);
	});

	it("(f) does NOT touch a blank assistant message", () => {
		const line = msg("assistant", [{ type: "text", text: "" }]);
		const { changed, content } = sanitizeTranscriptContent(line);
		assert.equal(changed, false);
		assert.equal(content, line);
	});

	it("(g) leaves a valid toolCall + toolResult row pair byte-identical and idempotent", () => {
		const file = [assistantToolCall("t1"), toolResultRow("t1")].join("\n");
		const first = sanitizeTranscriptContent(file);
		assert.equal(first.changed, false, "valid message-level toolResult must stay unchanged");
		assert.equal(first.content, file, "valid tool-call history must stay byte-identical");
		assert.equal(first.droppedToolResultRows, 0);
		assert.equal(first.filteredToolResultBlocks, 0);

		const second = sanitizeTranscriptContent(first.content);
		assert.equal(second.changed, false, "valid pair sanitizer pass must remain a no-op");
		assert.equal(second.content, file);
	});

	it("(g') leaves a valid tool_use + toolResult-block user message byte-identical", () => {
		const result = msg("user", [{ type: "toolResult", toolCallId: "t2", content: [{ type: "text", text: "" }] }], "result-t2");
		const file = [assistantToolUse("t2"), result].join("\n");
		const { changed, content } = sanitizeTranscriptContent(file);
		assert.equal(changed, false, "valid toolResult user message must NOT be rewritten");
		assert.equal(content, file, "valid toolResult user message must stay byte-identical");
	});

	it("(g' pi) leaves a valid pi {toolCallId,toolName} + toolResult row pair byte-identical", () => {
		const file = [assistantPiToolCall("pi-tool"), toolResultRow("pi-tool")].join("\n");
		const first = sanitizeTranscriptContent(file);
		assert.equal(first.changed, false, "pi-shaped assistant tool call must validate the matching toolResult row");
		assert.equal(first.content, file, "valid pi-shaped tool-call history must stay byte-identical");
		assert.equal(first.droppedToolResultRows, 0);

		const second = sanitizeTranscriptContent(first.content);
		assert.equal(second.changed, false, "valid pi-shaped pair sanitizer pass must remain a no-op");
		assert.equal(second.content, file);
	});

	it("(g'') leaves a valid tool_result + blank-text user message byte-identical (tool result wins)", () => {
		// Even if a stray empty text block coexists, the presence of a valid
		// tool_result block means this is tool-call history and must not be touched.
		const result = msg("user", [{ type: "text", text: "" }, { type: "tool_result", tool_use_id: "t3", content: "x" }], "result-t3");
		const file = [assistantToolCall("t3"), result].join("\n");
		const { changed, content } = sanitizeTranscriptContent(file);
		assert.equal(changed, false);
		assert.equal(content, file);
	});

	it("drops a toolResult row whose only matching assistant row was aborted", () => {
		const assistant = assistantToolCall("aborted-tool", "assistant-aborted", "aborted");
		const result = toolResultRow("aborted-tool", "late-result");
		const after = msg("user", "after", "after");
		const file = [assistant, result, after].join("\n");

		const sanitized = sanitizeTranscriptContent(file);
		assert.equal(sanitized.changed, true);
		assert.equal(sanitized.rewritten, 0);
		assert.equal(sanitized.droppedToolResultRows, 1);
		assert.equal(sanitized.filteredToolResultBlocks, 0);
		assert.equal(sanitized.content, [assistant, after].join("\n"));

		const second = sanitizeTranscriptContent(sanitized.content);
		assert.equal(second.changed, false, "orphan repair must be idempotent");
		assert.equal(second.content, sanitized.content);
	});

	it("drops a toolResult row whose only matching assistant row errored", () => {
		const assistant = assistantToolCall("errored-tool", "assistant-error", "error");
		const result = toolResultRow("errored-tool", "late-error-result");
		const file = [assistant, result].join("\n");

		const sanitized = sanitizeTranscriptContent(file);
		assert.equal(sanitized.changed, true);
		assert.equal(sanitized.droppedToolResultRows, 1);
		assert.equal(sanitized.content, assistant);
	});

	it("drops a toolResult row after a compaction boundary with no retained tool call", () => {
		const user = msg("user", "retained prompt", "retained-user");
		const compaction = JSON.stringify({ type: "compaction", id: "compact-1" });
		const result = toolResultRow("pre-compaction-tool", "orphan-after-compaction");
		const file = [user, compaction, result].join("\n");

		const sanitized = sanitizeTranscriptContent(file);
		assert.equal(sanitized.changed, true);
		assert.equal(sanitized.droppedToolResultRows, 1);
		assert.equal(sanitized.content, [user, compaction].join("\n"));
	});

	it("drops a post-compaction toolResult whose matching assistant tool call was before the compaction marker", () => {
		// Regression (PR #845): seenToolCallIds used to persist across the
		// `compaction` marker, so a post-compaction toolResult could incorrectly
		// match a pre-compaction assistant tool call that is no longer in the
		// retained context — rehydrating an orphan function_call_output.
		const assistant = assistantToolCall("pre-compact-call", "assistant-pre-compact");
		const compaction = JSON.stringify({ type: "compaction", id: "compact-1" });
		const result = toolResultRow("pre-compact-call", "late-result-after-compaction");
		const after = msg("user", "after", "after");
		const file = [assistant, compaction, result, after].join("\n");

		const sanitized = sanitizeTranscriptContent(file);
		assert.equal(sanitized.changed, true);
		assert.equal(sanitized.droppedToolResultRows, 1);
		assert.equal(sanitized.filteredToolResultBlocks, 0);
		assert.equal(sanitized.content, [assistant, compaction, after].join("\n"));

		const second = sanitizeTranscriptContent(sanitized.content);
		assert.equal(second.changed, false, "compaction-boundary orphan repair must be idempotent");
		assert.equal(second.content, sanitized.content);
	});

	it("keeps a toolCall before the marker when firstKeptEntryId names an earlier retained user row", () => {
		// Pi's exact retained-range boundary can point to any retained entry, not
		// just an assistant tool-call row. A later retained assistant tool call before
		// the inline compaction marker is still valid for post-marker results.
		const retainedUser = msg("user", "retained prompt", "retained-user");
		const assistant = assistantToolCall("kept-before-marker-call", "assistant-kept-before-marker");
		const compaction = JSON.stringify({ type: "compaction", id: "compact-1", firstKeptEntryId: "retained-user" });
		const result = toolResultRow("kept-before-marker-call", "result-after-marker");
		const file = [retainedUser, assistant, compaction, result].join("\n");

		const sanitized = sanitizeTranscriptContent(file);
		assert.equal(sanitized.changed, false, "valid retained-range pair must stay unchanged");
		assert.equal(sanitized.content, file, "valid retained-range pair must stay byte-identical");
		assert.equal(sanitized.droppedToolResultRows, 0);
	});

	it("keeps a valid toolCall + toolResult pair when both are after the compaction marker", () => {
		// A post-compaction assistant tool call matched by a post-compaction
		// toolResult is valid retained history and must stay byte-identical.
		const preUser = msg("user", "retained prompt", "retained-user");
		const compaction = JSON.stringify({ type: "compaction", id: "compact-1" });
		const assistant = assistantToolCall("post-compact-call", "assistant-post-compact");
		const result = toolResultRow("post-compact-call", "post-compact-result");
		const file = [preUser, compaction, assistant, result].join("\n");

		const sanitized = sanitizeTranscriptContent(file);
		assert.equal(sanitized.changed, false, "valid post-compaction pair must stay unchanged");
		assert.equal(sanitized.content, file, "valid post-compaction pair must stay byte-identical");
		assert.equal(sanitized.droppedToolResultRows, 0);
	});

	it("filters orphan user/content tool_result blocks while preserving valid blocks and other content", () => {
		const assistant = assistantToolCall("valid-block");
		const userLine = msg("user", [
			{ type: "text", text: "tool outputs:" },
			{ type: "tool_result", tool_use_id: "valid-block", content: "keep me" },
			{ type: "toolResult", toolCallId: "orphan-block", content: "drop me" },
			IMG,
		], "mixed-results");
		const file = [assistant, userLine].join("\n");

		const sanitized = sanitizeTranscriptContent(file);
		assert.equal(sanitized.changed, true);
		assert.equal(sanitized.droppedToolResultRows, 0);
		assert.equal(sanitized.filteredToolResultBlocks, 1);

		const lines = sanitized.content.split("\n");
		assert.equal(lines[0], assistant, "assistant tool call must stay byte-identical");
		const blocks = JSON.parse(lines[1]).message.content;
		assert.deepEqual(blocks, [
			{ type: "text", text: "tool outputs:" },
			{ type: "tool_result", tool_use_id: "valid-block", content: "keep me" },
			IMG,
		]);

		const second = sanitizeTranscriptContent(sanitized.content);
		assert.equal(second.changed, false, "filtered transcript must be idempotent");
		assert.equal(second.content, sanitized.content);
	});

	it("rewrites blank/image-only user content after filtering orphan tool_result blocks", () => {
		const userLine = msg("user", [
			{ type: "text", text: "   " },
			{ type: "tool_result", tool_use_id: "missing", content: "drop me" },
			IMG,
		], "orphan-plus-attachment");

		const sanitized = sanitizeTranscriptContent(userLine);
		assert.equal(sanitized.changed, true);
		assert.equal(sanitized.filteredToolResultBlocks, 1);
		assert.equal(sanitized.rewritten, 1);

		const blocks = JSON.parse(sanitized.content).message.content;
		assert.deepEqual(blocks, [
			{ type: "text", text: "Attachments:" },
			IMG,
		]);

		const second = sanitizeTranscriptContent(sanitized.content);
		assert.equal(second.changed, false, "filter + blank-user repair must be idempotent in one pass");
		assert.equal(second.content, sanitized.content);
	});

	it("rewrites image-only user content after filtering orphan toolResult blocks", () => {
		const userLine = msg("user", [
			{ type: "toolResult", toolCallId: "missing", content: "drop me" },
			IMG,
		], "orphan-plus-image");

		const sanitized = sanitizeTranscriptContent(userLine);
		assert.equal(sanitized.changed, true);
		assert.equal(sanitized.filteredToolResultBlocks, 1);
		assert.equal(sanitized.rewritten, 1);

		const blocks = JSON.parse(sanitized.content).message.content;
		assert.deepEqual(blocks, [
			{ type: "text", text: "Attachments:" },
			IMG,
		]);

		const second = sanitizeTranscriptContent(sanitized.content);
		assert.equal(second.changed, false, "image-only remainder must not need a second repair pass");
		assert.equal(second.content, sanitized.content);
	});

	it("drops a user/content tool_result-only row when every block is orphaned", () => {
		const orphan = msg("user", [{ type: "tool_result", tool_use_id: "missing", content: "drop" }], "orphan-user-result");
		const next = msg("user", "next", "next");
		const file = [orphan, next].join("\n");

		const sanitized = sanitizeTranscriptContent(file);
		assert.equal(sanitized.changed, true);
		assert.equal(sanitized.filteredToolResultBlocks, 1);
		assert.equal(sanitized.content, next);
	});

	it("preserves other lines and only rewrites poisoned ones in a multi-line file", () => {
		const good1 = msg("user", [{ type: "text", text: "keep me" }], "a");
		const bad = msg("user", [{ type: "text", text: "" }, IMG], "b");
		const good2 = msg("assistant", [{ type: "text", text: "reply" }], "c");
		const file = [good1, bad, good2].join("\n");
		const { content, changed, rewritten } = sanitizeTranscriptContent(file);
		assert.equal(changed, true);
		assert.equal(rewritten, 1);
		const lines = content.split("\n");
		assert.equal(lines[0], good1, "untouched good line must stay byte-identical");
		assert.equal(lines[2], good2, "untouched assistant line must stay byte-identical");
		assert.equal(JSON.parse(lines[1]).message.content[0].text, "Attachments:");
	});

	it("preserves trailing newline shape", () => {
		const file = msg("user", [{ type: "text", text: "" }, IMG]) + "\n";
		const { content } = sanitizeTranscriptContent(file);
		assert.ok(content.endsWith("\n"), "trailing newline preserved");
	});

	it("skips non-JSON and non-message lines untouched", () => {
		const file = ["not json", msg("user", "ok"), '{"type":"compaction","id":"z"}'].join("\n");
		const { content, changed } = sanitizeTranscriptContent(file);
		assert.equal(changed, false);
		assert.equal(content, file);
	});

	it("empty input is a no-op", () => {
		const { content, changed } = sanitizeTranscriptContent("");
		assert.equal(changed, false);
		assert.equal(content, "");
	});
});

describe("rebaseTranscriptCwdMetadataContent", () => {
	const oldCwd = "C:/Users/test/bobbit-wt/session-old123";
	const otherOldCwd = "C:/Users/test/bobbit-wt/session-other456";
	const newCwd = "C:/Users/test/bobbit-wt/session-new789";

	function rebase(content: string) {
		return rebaseTranscriptCwdMetadataContent(content, { oldCwds: [oldCwd, otherOldCwd], newCwd });
	}

	it("rewrites system init cwd metadata from an old cwd to the new cwd", () => {
		const line = JSON.stringify({ type: "system", subtype: "init", cwd: oldCwd, session_id: "old123" });
		const { content, changed, rewritten } = rebase(line);
		assert.equal(changed, true);
		assert.equal(rewritten, 1);
		assert.deepEqual(JSON.parse(content), { type: "system", subtype: "init", cwd: newCwd, session_id: "old123" });
	});

	it("rewrites Pi-style session cwd metadata and is idempotent", () => {
		const line = JSON.stringify({
			type: "session",
			version: 3,
			id: "019ed586-a59a-7d8a-a518-3d4d5e4c6e54",
			timestamp: "2026-06-17T12:20:31.770Z",
			cwd: oldCwd,
		});

		const once = rebase(line);
		assert.equal(once.changed, true);
		assert.equal(once.rewritten, 1);
		assert.deepEqual(JSON.parse(once.content), {
			type: "session",
			version: 3,
			id: "019ed586-a59a-7d8a-a518-3d4d5e4c6e54",
			timestamp: "2026-06-17T12:20:31.770Z",
			cwd: newCwd,
		});

		const twice = rebase(once.content);
		assert.equal(twice.changed, false);
		assert.equal(twice.rewritten, 0);
		assert.equal(twice.content, once.content);
	});

	it("rewrites legacy system cwd metadata with no subtype", () => {
		const line = JSON.stringify({ type: "system", cwd: oldCwd, note: "legacy init shape" });
		const { content, changed, rewritten } = rebase(line);
		assert.equal(changed, true);
		assert.equal(rewritten, 1);
		assert.deepEqual(JSON.parse(content), { type: "system", cwd: newCwd, note: "legacy init shape" });
	});

	it("leaves unrelated system cwd values unchanged", () => {
		const unrelatedCwd = JSON.stringify({ type: "system", subtype: "init", cwd: "C:/Users/test/elsewhere" });
		const nonInitSubtype = JSON.stringify({ type: "system", subtype: "summary", cwd: oldCwd });
		const file = [unrelatedCwd, nonInitSubtype].join("\n");
		const { content, changed, rewritten } = rebase(file);
		assert.equal(changed, false);
		assert.equal(rewritten, 0);
		assert.equal(content, file);
	});

	it("leaves user and assistant message content byte-identical even when text mentions old paths", () => {
		const system = JSON.stringify({ type: "system", subtype: "init", cwd: oldCwd });
		const userLine = msg("user", [{ type: "text", text: `please inspect ${oldCwd}` }], "user-path");
		const assistantLine = msg("assistant", [{ type: "text", text: `I saw ${otherOldCwd}` }], "assistant-path");
		const file = [system, userLine, assistantLine].join("\n");

		const { content, changed, rewritten } = rebase(file);
		assert.equal(changed, true);
		assert.equal(rewritten, 1);
		const lines = content.split("\n");
		assert.equal(JSON.parse(lines[0]).cwd, newCwd);
		assert.equal(lines[1], userLine, "user-visible path mention must stay byte-identical");
		assert.equal(lines[2], assistantLine, "assistant-visible path mention must stay byte-identical");
	});

	it("is idempotent after rebasing cwd metadata", () => {
		const firstOld = JSON.stringify({ type: "system", subtype: "init", cwd: oldCwd });
		const secondOld = JSON.stringify({ type: "system", cwd: otherOldCwd });
		const file = [firstOld, secondOld, msg("user", `still mentions ${oldCwd}`, "u")].join("\n") + "\n";

		const once = rebase(file);
		assert.equal(once.changed, true);
		assert.equal(once.rewritten, 2);
		const twice = rebase(once.content);
		assert.equal(twice.changed, false);
		assert.equal(twice.rewritten, 0);
		assert.equal(twice.content, once.content);
		assert.ok(once.content.endsWith("\n"), "trailing newline preserved across rebase");
	});
});

describe("transcript write path validation", () => {
	let agentDir: string;
	let sessionsRoot: string;
	let prevAgentDir: string | undefined;

	before(() => {
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-sanitizer-agentdir-"));
		sessionsRoot = path.join(agentDir, "sessions");
		fs.mkdirSync(sessionsRoot, { recursive: true });
		prevAgentDir = process.env.BOBBIT_AGENT_DIR;
		process.env.BOBBIT_AGENT_DIR = agentDir;
	});

	after(() => {
		if (prevAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR;
		else process.env.BOBBIT_AGENT_DIR = prevAgentDir;
		try { fs.rmSync(agentDir, { recursive: true, force: true }); } catch { /* best-effort */ }
	});

	const POISONED = JSON.stringify({
		type: "message",
		id: "p",
		message: { role: "user", content: [{ type: "text", text: "" }, { type: "image", source: { data: "AAAA" } }] },
	});

	it("isWithinAgentSessionsDir accepts a path inside the sessions root", () => {
		const inside = path.join(sessionsRoot, "--slug--", "2026_x.jsonl");
		assert.equal(isWithinAgentSessionsDir(inside), true);
	});

	it("isWithinAgentSessionsDir rejects paths outside the root, traversal, and empty", () => {
		assert.equal(isWithinAgentSessionsDir(path.join(agentDir, "evil.jsonl")), false);
		assert.equal(isWithinAgentSessionsDir(path.join(sessionsRoot, "..", "escape.jsonl")), false);
		assert.equal(isWithinAgentSessionsDir(path.join(os.tmpdir(), "elsewhere.jsonl")), false);
		assert.equal(isWithinAgentSessionsDir(""), false);
	});

	it("sanitizeAgentTranscriptFile rewrites a poisoned file inside the sessions root", async () => {
		const dir = path.join(sessionsRoot, "--cwd--");
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, "2026-01-01T00-00-00-000Z_abc.jsonl");
		fs.writeFileSync(file, POISONED, "utf-8");

		const rewritten = await sanitizeAgentTranscriptFile({ sandboxed: false }, file, null);
		assert.equal(rewritten, 1);
		assert.equal(JSON.parse(fs.readFileSync(file, "utf-8")).message.content[0].text, "Attachments:");
	});

	it("sanitizeAgentTranscriptFile refuses to clobber a file OUTSIDE the sessions root", async () => {
		// A poisoned transcript whose path escapes the sessions dir must be left
		// byte-identical (no write) rather than rewritten.
		const outside = path.join(agentDir, "outside-the-root.jsonl");
		fs.writeFileSync(outside, POISONED, "utf-8");

		const rewritten = await sanitizeAgentTranscriptFile({ sandboxed: false }, outside, null);
		assert.equal(rewritten, 0, "write outside sessions root must be skipped");
		assert.equal(fs.readFileSync(outside, "utf-8"), POISONED, "file must remain untouched");
	});

	it("sanitizeAgentTranscriptFile rejects a symlink inside the sessions root (no read, no write)", async (t) => {
		// Real (poisoned) file living OUTSIDE the sessions root.
		const realTarget = path.join(agentDir, "symlink-target.jsonl");
		fs.writeFileSync(realTarget, POISONED, "utf-8");

		// A symlink INSIDE the sessions root pointing at the external file. If the
		// platform forbids symlink creation (Windows w/o privilege), skip.
		const link = path.join(sessionsRoot, "evil-link.jsonl");
		try {
			fs.symlinkSync(realTarget, link);
		} catch {
			t.skip("symlink creation not permitted on this platform");
			return;
		}

		const rewritten = await sanitizeAgentTranscriptFile({ sandboxed: false }, link, null);
		assert.equal(rewritten, 0, "symlinked transcript path must be rejected");
		assert.equal(
			fs.readFileSync(realTarget, "utf-8"),
			POISONED,
			"symlink target must remain byte-identical (not followed)",
		);
	});

	it("resolveSafeSessionsPath rejects symlink/out-of-root and accepts a real in-root file", () => {
		const dir = path.join(sessionsRoot, "--ok--");
		fs.mkdirSync(dir, { recursive: true });
		const ok = path.join(dir, "real.jsonl");
		fs.writeFileSync(ok, POISONED, "utf-8");
		assert.equal(resolveSafeSessionsPath(ok), fs.realpathSync(ok));
		assert.equal(resolveSafeSessionsPath(path.join(agentDir, "nope.jsonl")), null);
		assert.equal(resolveSafeSessionsPath(path.join(sessionsRoot, "..", "x.jsonl")), null);
		assert.equal(resolveSafeSessionsPath(""), null);
	});
});
