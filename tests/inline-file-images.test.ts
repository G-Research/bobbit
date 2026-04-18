/**
 * Unit tests for `inlineFileImages` — the helper that rewrites
 * `<img src="file://...">` references in QA HTML reports to inline base64
 * data URIs.
 *
 * Covers:
 *  - single file:// PNG gets inlined
 *  - missing file leaves the src unchanged
 *  - non-image extensions are left unchanged
 *  - paths outside the session cwd are rejected (unchanged)
 *  - 20 MB cap stops further inlining
 *  - other tag attributes are preserved
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { inlineFileImages } from "../src/server/agent/inline-file-images.js";

function mkTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "inline-img-"));
}

// Minimal valid PNG (1×1 transparent pixel).
const PNG_1x1 = Buffer.from(
	"89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D4944415478DA63F8CF000000030001" +
		"000100A7E8B13C0000000049454E44AE426082",
	"hex",
);

function fileUri(abs: string): string {
	// Windows: C:\Users\... → file:///C:/Users/...
	const normalised = abs.replace(/\\/g, "/");
	return normalised.startsWith("/") ? `file://${normalised}` : `file:///${normalised}`;
}

test("inlines a single file:// PNG reference into a data URI", () => {
	const cwd = mkTempDir();
	const imgPath = path.join(cwd, "shot.png");
	fs.writeFileSync(imgPath, PNG_1x1);

	const html = `<p>before</p><img src="${fileUri(imgPath)}" alt="screenshot" class="big"><p>after</p>`;
	const out = inlineFileImages(html, cwd, { logger: () => {} });

	assert.match(out, /src="data:image\/png;base64,[A-Za-z0-9+/=]+"/);
	assert.match(out, /alt="screenshot"/);
	assert.match(out, /class="big"/);
	assert.match(out, /<p>before<\/p>/);
	assert.match(out, /<p>after<\/p>/);
	assert.ok(!out.includes("file://"), "file:// should be gone from output");
});

test("leaves src unchanged when the referenced file does not exist", () => {
	const cwd = mkTempDir();
	const ghost = path.join(cwd, "does-not-exist.png");
	const html = `<img src="${fileUri(ghost)}">`;

	const warnings: string[] = [];
	const out = inlineFileImages(html, cwd, { logger: (m) => warnings.push(m) });

	assert.equal(out, html, "HTML should be unchanged for a missing file");
	assert.ok(warnings.some((w) => w.includes("Missing image file")));
});

test("leaves non-image extensions alone", () => {
	const cwd = mkTempDir();
	const txtPath = path.join(cwd, "notes.txt");
	fs.writeFileSync(txtPath, "hello");

	const html = `<img src="${fileUri(txtPath)}">`;
	const out = inlineFileImages(html, cwd, { logger: () => {} });

	assert.equal(out, html, "non-image extension must not be inlined");
});

test("rejects paths outside the session cwd", () => {
	const cwd = mkTempDir();
	const outside = mkTempDir();
	const imgPath = path.join(outside, "outside.png");
	fs.writeFileSync(imgPath, PNG_1x1);

	const html = `<img src="${fileUri(imgPath)}">`;
	const warnings: string[] = [];
	const out = inlineFileImages(html, cwd, { logger: (m) => warnings.push(m) });

	assert.equal(out, html, "paths outside cwd must not be inlined");
	assert.ok(warnings.some((w) => w.includes("outside session cwd")));
});

test("enforces a total-bytes cap — stops inlining after the cap is hit", () => {
	const cwd = mkTempDir();
	// Three ~2 KB files. Cap at 3 KB → first inlines, second pushes over, remainder skipped.
	const buf = Buffer.alloc(2048, 0xab);
	const fakePng = Buffer.concat([PNG_1x1.subarray(0, 8), buf]); // header-ish prefix, still fine
	const p1 = path.join(cwd, "a.png");
	const p2 = path.join(cwd, "b.png");
	const p3 = path.join(cwd, "c.png");
	fs.writeFileSync(p1, fakePng);
	fs.writeFileSync(p2, fakePng);
	fs.writeFileSync(p3, fakePng);

	const html =
		`<img src="${fileUri(p1)}">` +
		`<img src="${fileUri(p2)}">` +
		`<img src="${fileUri(p3)}">`;

	const warnings: string[] = [];
	const out = inlineFileImages(html, cwd, { maxBytes: 3000, logger: (m) => warnings.push(m) });

	// First should inline, second should remain file://, third should remain file://.
	const dataUriMatches = out.match(/data:image\/png;base64,/g) || [];
	const fileUriMatches = out.match(/src="file:\/\//g) || [];
	assert.equal(dataUriMatches.length, 1, "exactly one image fits under the cap");
	assert.equal(fileUriMatches.length, 2, "remaining two images must stay as file://");
	assert.ok(warnings.some((w) => w.includes("cap reached")));
});

test("accepts paths under .bobbit-qa/ subtree (the canonical QA spill dir)", () => {
	const cwd = mkTempDir();
	const qaDir = path.join(cwd, ".bobbit-qa", "screenshots");
	fs.mkdirSync(qaDir, { recursive: true });
	const imgPath = path.join(qaDir, `${crypto.randomUUID()}.png`);
	fs.writeFileSync(imgPath, PNG_1x1);

	const html = `<img src="${fileUri(imgPath)}">`;
	const out = inlineFileImages(html, cwd, { logger: () => {} });

	assert.match(out, /src="data:image\/png;base64,/);
});

test("handles multiple image extensions (.jpg, .jpeg, .gif, .webp)", () => {
	const cwd = mkTempDir();
	const paths: Record<string, string> = {};
	for (const ext of [".jpg", ".jpeg", ".gif", ".webp"]) {
		const p = path.join(cwd, `img${ext}`);
		fs.writeFileSync(p, PNG_1x1); // content doesn't matter for mime mapping
		paths[ext] = p;
	}
	const html = Object.values(paths).map((p) => `<img src="${fileUri(p)}">`).join("\n");
	const out = inlineFileImages(html, cwd, { logger: () => {} });

	assert.match(out, /data:image\/jpeg;base64/);
	assert.match(out, /data:image\/gif;base64/);
	assert.match(out, /data:image\/webp;base64/);
	assert.ok(!out.includes("file://"), "all should be inlined");
});
