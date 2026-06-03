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
	isWithinAgentSessionsDir,
	resolveSafeSessionsPath,
} from "../src/server/agent/transcript-sanitizer.ts";

function msg(role: string, content: unknown, id = "x"): string {
	return JSON.stringify({ type: "message", id, ts: "2026-01-01T00-00-00-000Z", message: { role, content } });
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

	it("(g) leaves a tool_result-only user message byte-identical (no text by design)", () => {
		const line = msg("user", [{ type: "tool_result", toolCallId: "t1", content: "ok done" }]);
		const { changed, content } = sanitizeTranscriptContent(line);
		assert.equal(changed, false, "tool_result user message must NOT be rewritten");
		assert.equal(content, line, "tool_result user message must stay byte-identical");
	});

	it("(g') leaves a toolResult-variant user message byte-identical", () => {
		const line = msg("user", [{ type: "toolResult", toolCallId: "t2", content: [{ type: "text", text: "" }] }]);
		const { changed, content } = sanitizeTranscriptContent(line);
		assert.equal(changed, false, "toolResult user message must NOT be rewritten");
		assert.equal(content, line, "toolResult user message must stay byte-identical");
	});

	it("(g'') leaves a tool_result + blank-text user message byte-identical (tool result wins)", () => {
		// Even if a stray empty text block coexists, the presence of a tool_result
		// block means this is tool-call history and must not be touched.
		const line = msg("user", [{ type: "text", text: "" }, { type: "tool_result", content: "x" }]);
		const { changed, content } = sanitizeTranscriptContent(line);
		assert.equal(changed, false);
		assert.equal(content, line);
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
