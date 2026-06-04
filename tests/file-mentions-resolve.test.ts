/**
 * Unit tests for resolveFileMentions — see design §2 / §8.1.
 *
 * Strategy: build a tmp tree with real files of various kinds and point the
 * pure resolver at it. Mirrors tests/skill-resolve.test.ts.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let cwdDir: string;

before(() => {
	cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-mentions-test-"));
	fs.mkdirSync(path.join(cwdDir, "src"), { recursive: true });
	fs.writeFileSync(path.join(cwdDir, "notes.txt"), "hello world\nline two", "utf-8");
	fs.writeFileSync(path.join(cwdDir, "src", "a.ts"), "export const x = 1;", "utf-8");
	// A tiny 1x1 PNG (binary, image extension).
	const png = Buffer.from(
		"89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
		"hex",
	);
	fs.writeFileSync(path.join(cwdDir, "pixel.png"), png);
	// A non-image binary (NUL bytes, .bin extension).
	fs.writeFileSync(path.join(cwdDir, "data.bin"), Buffer.from([0, 1, 2, 3, 0, 255, 254]));
});

after(() => {
	try { fs.rmSync(cwdDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const {
	resolveFileMentions,
	buildFileReferenceBlock,
	toWireMention,
	MAX_INLINE_TEXT_BYTES,
	MAX_MENTION_FILE_BYTES,
	MAX_MENTION_AGGREGATE_BYTES,
	MAX_MENTIONS_PER_SEND,
} = await import("../src/server/skills/resolve-file-mentions.ts");

describe("resolveFileMentions", () => {
	it("exports the documented cap constants", () => {
		assert.equal(MAX_INLINE_TEXT_BYTES, 256 * 1024);
		assert.equal(MAX_MENTION_FILE_BYTES, 10 * 1024 * 1024);
		assert.equal(MAX_MENTION_AGGREGATE_BYTES, 20 * 1024 * 1024);
		assert.equal(MAX_MENTIONS_PER_SEND, 50);
	});

	it("no mentions → text unchanged, empty mentions", () => {
		const r = resolveFileMentions("just a normal message", cwdDir);
		assert.equal(r.modelText, "just a normal message");
		assert.equal(r.mentions.length, 0);
		assert.equal(r.warnings.length, 0);
	});

	it("FOLLOW-UP-D: resolver sets internal absPath; toWireMention strips it", () => {
		const r = resolveFileMentions("@notes.txt", cwdDir);
		assert.ok(r.mentions[0].absPath, "resolver keeps canonical absPath internally");
		const wire = toWireMention(r.mentions[0]);
		assert.equal(wire.absPath, undefined, "wire mention must not carry absPath");
		assert.equal(wire.path, "notes.txt"); // other fields preserved
		assert.equal(wire.kind, "text");
	});

	it("inline text file → inlined with <file-reference> header; range covers @path", () => {
		const text = "see @notes.txt please";
		const r = resolveFileMentions(text, cwdDir);
		assert.equal(r.mentions.length, 1);
		const m = r.mentions[0];
		assert.equal(m.kind, "text");
		assert.equal(m.path, "notes.txt");
		assert.equal(m.content, "hello world\nline two");
		assert.deepEqual(m.range, [4, 4 + "@notes.txt".length]);
		const block = buildFileReferenceBlock("notes.txt", "hello world\nline two");
		assert.equal(r.modelText, "see " + block + " please");
	});

	it("bare @path whole-message works through inline scan", () => {
		const r = resolveFileMentions("@src/a.ts", cwdDir);
		assert.equal(r.mentions.length, 1);
		assert.equal(r.mentions[0].kind, "text");
		assert.equal(r.mentions[0].path, "src/a.ts");
		assert.equal(r.mentions[0].content, "export const x = 1;");
	});

	it("multiple mentions → right-to-left splice preserves earlier indices", () => {
		const text = "x @notes.txt y @src/a.ts z";
		const r = resolveFileMentions(text, cwdDir);
		assert.equal(r.mentions.length, 2);
		assert.equal(r.mentions[0].path, "notes.txt");
		assert.equal(r.mentions[1].path, "src/a.ts");
		const b1 = buildFileReferenceBlock("notes.txt", "hello world\nline two");
		const b2 = buildFileReferenceBlock("src/a.ts", "export const x = 1;");
		assert.equal(r.modelText, "x " + b1 + " y " + b2 + " z");
	});

	it("content snapshot is captured at resolve time (later mutation ignored)", () => {
		const tmp = path.join(cwdDir, "mutating.txt");
		fs.writeFileSync(tmp, "ORIGINAL", "utf-8");
		const r = resolveFileMentions("@mutating.txt", cwdDir);
		fs.writeFileSync(tmp, "CHANGED", "utf-8");
		assert.equal(r.mentions[0].content, "ORIGINAL");
	});

	it("image by extension → kind image, base64 data, modelText unchanged", () => {
		const text = "look @pixel.png ok";
		const r = resolveFileMentions(text, cwdDir);
		assert.equal(r.mentions.length, 1);
		const m = r.mentions[0];
		assert.equal(m.kind, "image");
		assert.equal(m.mimeType, "image/png");
		assert.ok(m.data && m.data.length > 0);
		assert.equal(m.content, undefined);
		assert.equal(r.modelText, text); // literal @path left in place
	});

	it("non-image binary (NUL bytes) → kind binary, base64 data, modelText unchanged", () => {
		const text = "@data.bin";
		const r = resolveFileMentions(text, cwdDir);
		assert.equal(r.mentions[0].kind, "binary");
		assert.ok(r.mentions[0].data && r.mentions[0].data.length > 0);
		assert.equal(r.mentions[0].mimeType, "application/octet-stream");
		assert.equal(r.modelText, text); // literal @path left (not inlined)
	});

	it("binary mimeType is ext-derived when known (.pdf)", () => {
		fs.writeFileSync(path.join(cwdDir, "doc.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]));
		const r = resolveFileMentions("@doc.pdf", cwdDir);
		assert.equal(r.mentions[0].kind, "binary");
		assert.equal(r.mentions[0].mimeType, "application/pdf");
	});

	it("FOLLOW-UP-C: invalid UTF-8 without NUL bytes → kind binary, not inlined as text", () => {
		// Lone 0xFF / 0xFE continuation bytes are not valid UTF-8 and contain no NUL.
		fs.writeFileSync(path.join(cwdDir, "invalid-utf8.dat"), Buffer.from([0xff, 0xfe, 0x41, 0xc0, 0x80]));
		const r = resolveFileMentions("@invalid-utf8.dat", cwdDir);
		assert.equal(r.mentions[0].kind, "binary");
		assert.equal(r.mentions[0].content, undefined);
		assert.equal(r.modelText, "@invalid-utf8.dat");
	});

	it("missing file → unresolved, literal token preserved, reason set", () => {
		const text = "see @nope.txt here";
		const r = resolveFileMentions(text, cwdDir);
		assert.equal(r.mentions[0].kind, "unresolved");
		assert.equal(r.mentions[0].reason, "missing");
		assert.equal(r.modelText, text);
		assert.ok(r.warnings.length >= 1);
	});

	it("outside-cwd traversal → unresolved (outside-cwd), no throw", () => {
		const r = resolveFileMentions("@../secret.txt", cwdDir);
		assert.equal(r.mentions[0].kind, "unresolved");
		assert.equal(r.mentions[0].reason, "outside-cwd");
	});

	it("oversized text (per-file text cap) → unresolved too-large, literal preserved", () => {
		const big = path.join(cwdDir, "big.txt");
		fs.writeFileSync(big, "x".repeat(2048), "utf-8");
		const r = resolveFileMentions("@big.txt", cwdDir, { maxFileBytes: 1024 });
		assert.equal(r.mentions[0].kind, "unresolved");
		assert.equal(r.mentions[0].reason, "too-large");
		assert.equal(r.modelText, "@big.txt");
	});

	it("aggregate cap → later mentions become unresolved (aggregate-cap)", () => {
		fs.writeFileSync(path.join(cwdDir, "p.txt"), "aaaa", "utf-8");
		fs.writeFileSync(path.join(cwdDir, "q.txt"), "bbbb", "utf-8");
		const r = resolveFileMentions("@p.txt @q.txt", cwdDir, { maxAggregateBytes: 5 });
		assert.equal(r.mentions[0].kind, "text");
		assert.equal(r.mentions[1].kind, "unresolved");
		assert.equal(r.mentions[1].reason, "aggregate-cap");
	});

	it("trailing punctuation is trimmed from the token (see @notes.txt.)", () => {
		const r = resolveFileMentions("see @notes.txt.", cwdDir);
		assert.equal(r.mentions.length, 1);
		assert.equal(r.mentions[0].path, "notes.txt");
		// Range must cover exactly "@notes.txt" (not the trailing dot).
		assert.deepEqual(r.mentions[0].range, [4, 4 + "@notes.txt".length]);
	});

	it("backslash path normalised for lookup (header uses forward slashes)", () => {
		const r = resolveFileMentions("@src\\a.ts", cwdDir);
		assert.equal(r.mentions[0].kind, "text");
		assert.ok(r.modelText.includes('path="src/a.ts"'));
	});

	it("never throws on a mix of good and bad references", () => {
		const text = "@notes.txt @nope.txt @../x @pixel.png";
		const r = resolveFileMentions(text, cwdDir);
		assert.equal(r.mentions.length, 4);
		assert.deepEqual(
			r.mentions.map((m) => m.kind),
			["text", "unresolved", "unresolved", "image"],
		);
	});

	it("HIGH-1: symlink inside cwd pointing outside cwd is rejected (outside-cwd), no leak", (t) => {
		const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-mentions-outside-"));
		const secret = path.join(outsideDir, "secret.txt");
		fs.writeFileSync(secret, "TOPSECRET", "utf-8");
		const link = path.join(cwdDir, "link-to-secret.txt");
		try {
			fs.symlinkSync(secret, link);
		} catch {
			// Creating symlinks can throw EPERM on unprivileged Windows — skip
			// so the suite stays green there.
			t.skip("symlink creation not permitted on this platform");
			fs.rmSync(outsideDir, { recursive: true, force: true });
			return;
		}
		const r = resolveFileMentions("@link-to-secret.txt", cwdDir);
		assert.equal(r.mentions[0].kind, "unresolved");
		assert.equal(r.mentions[0].reason, "outside-cwd");
		assert.ok(!(r.mentions[0].content ?? "").includes("TOPSECRET"), "secret must not be snapshotted");
		fs.rmSync(link, { force: true });
		fs.rmSync(outsideDir, { recursive: true, force: true });
	});

	it("HIGH-5: more than MAX_MENTIONS_PER_SEND tokens → extras unresolved (too-many-mentions)", () => {
		const n = MAX_MENTIONS_PER_SEND + 3;
		const text = Array.from({ length: n }, () => "@notes.txt").join(" ");
		const r = resolveFileMentions(text, cwdDir);
		assert.equal(r.mentions.length, n);
		// First MAX are resolved (text); extras degrade without fs work.
		assert.equal(r.mentions[MAX_MENTIONS_PER_SEND - 1].kind, "text");
		assert.equal(r.mentions[MAX_MENTIONS_PER_SEND].kind, "unresolved");
		assert.equal(r.mentions[MAX_MENTIONS_PER_SEND].reason, "too-many-mentions");
		assert.equal(r.mentions[n - 1].reason, "too-many-mentions");
	});
});
