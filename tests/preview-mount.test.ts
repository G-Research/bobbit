/**
 * Unit tests for `src/server/preview/mount.ts` (WP-A).
 *
 * Covers writeInline (default + custom + bad entry), copyFileTree (sibling
 * tree + 25 MiB cap + symlink escape), removeMount (idempotent), and the
 * 100 MiB mount-total ceiling.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	copyFileTree,
	DEFAULT_INLINE_ENTRY,
	MAX_COPY_BYTES,
	MAX_MOUNT_BYTES,
	mountDir,
	PreviewMountError,
	removeMount,
	setPreviewRootForTesting,
	writeInline,
} from "../src/server/preview/mount.ts";

const SID = "11111111-2222-3333-4444-555555555555";
const SID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

let root: string;
let supportsSymlink = true;

before(() => {
	root = mkdtempSync(path.join(tmpdir(), "bobbit-mount-"));
	setPreviewRootForTesting(root);
	// Probe symlink support on the host (Windows without dev-mode rejects it).
	try {
		const probe = path.join(root, "_probe");
		writeFileSync(probe, "x");
		const link = path.join(root, "_probe-link");
		symlinkSync(probe, link);
	} catch {
		supportsSymlink = false;
	}
});

after(() => {
	setPreviewRootForTesting(undefined);
	try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("mountDir / sessionId validation", () => {
	it("creates the mount directory for a valid sid", () => {
		const dir = mountDir(SID);
		assert.equal(dir, path.join(root, SID));
		assert.equal(statSync(dir).isDirectory(), true);
	});
	it("rejects an invalid sessionId with status 400", () => {
		assert.throws(() => mountDir("not-a-uuid"), (err: any) => {
			return err instanceof PreviewMountError && err.statusCode === 400;
		});
	});
});

describe("writeInline", () => {
	it("writes inline.html by default", () => {
		const r = writeInline(SID, "<h1>hello</h1>");
		assert.equal(r.entry, DEFAULT_INLINE_ENTRY);
		assert.equal(r.url, `/preview/${SID}/${DEFAULT_INLINE_ENTRY}`);
		assert.equal(r.path, path.join(root, SID, DEFAULT_INLINE_ENTRY));
		assert.equal(statSync(r.path).size, Buffer.byteLength("<h1>hello</h1>"));
	});
	it("accepts a custom single-segment entry", () => {
		const r = writeInline(SID, "<p>p</p>", "report.html");
		assert.equal(r.entry, "report.html");
		assert.ok(r.url.endsWith("/report.html"));
	});
	it("rejects an entry containing a path separator", () => {
		assert.throws(() => writeInline(SID, "x", "sub/foo.html"), PreviewMountError);
		assert.throws(() => writeInline(SID, "x", "sub\\foo.html"), PreviewMountError);
		assert.throws(() => writeInline(SID, "x", ".."), PreviewMountError);
		assert.throws(() => writeInline(SID, "x", "."), PreviewMountError);
		assert.throws(() => writeInline(SID, "x", ""), PreviewMountError);
	});
	it("overwrites the same entry atomically", () => {
		writeInline(SID, "first", "rep.html");
		const r = writeInline(SID, "second-much-longer", "rep.html");
		assert.equal(statSync(r.path).size, "second-much-longer".length);
	});
});

describe("copyFileTree", () => {
	it("copies srcFile + sibling tree", () => {
		const src = mkdtempSync(path.join(tmpdir(), "bobbit-mount-src-"));
		try {
			const entry = path.join(src, "report.html");
			writeFileSync(entry, "<h1>r</h1>");
			mkdirSync(path.join(src, "videos"));
			writeFileSync(path.join(src, "videos", "v.webm"), "vid");
			writeFileSync(path.join(src, "styles.css"), "body{}");

			const r = copyFileTree(SID_B, entry);
			assert.equal(r.entry, "report.html");
			assert.equal(r.url, `/preview/${SID_B}/report.html`);
			const dest = mountDir(SID_B);
			assert.equal(statSync(path.join(dest, "report.html")).isFile(), true);
			assert.equal(statSync(path.join(dest, "videos", "v.webm")).isFile(), true);
			assert.equal(statSync(path.join(dest, "styles.css")).isFile(), true);
		} finally {
			rmSync(src, { recursive: true, force: true });
		}
	});

	it("rejects a tree larger than MAX_COPY_BYTES", () => {
		const src = mkdtempSync(path.join(tmpdir(), "bobbit-mount-big-"));
		try {
			const entry = path.join(src, "index.html");
			writeFileSync(entry, "<h1>x</h1>");
			// Create one big sibling that pushes total > MAX_COPY_BYTES.
			const big = Buffer.alloc(MAX_COPY_BYTES + 1024, 0x61);
			writeFileSync(path.join(src, "big.bin"), big);
			assert.throws(() => copyFileTree(SID_B, entry), (err: any) => {
				return err instanceof PreviewMountError && err.statusCode === 413;
			});
		} finally {
			rmSync(src, { recursive: true, force: true });
		}
	});

	it("rejects symlinks pointing outside the source tree", { skip: !supportsSymlink }, () => {
		const outside = mkdtempSync(path.join(tmpdir(), "bobbit-mount-out-"));
		writeFileSync(path.join(outside, "secret.txt"), "shh");
		const src = mkdtempSync(path.join(tmpdir(), "bobbit-mount-sym-"));
		try {
			const entry = path.join(src, "index.html");
			writeFileSync(entry, "<h1>x</h1>");
			symlinkSync(path.join(outside, "secret.txt"), path.join(src, "leak"));
			assert.throws(() => copyFileTree(SID_B, entry), (err: any) => {
				return err instanceof PreviewMountError && err.statusCode === 403;
			});
		} finally {
			rmSync(src, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("rejects a non-absolute srcFile", () => {
		assert.throws(() => copyFileTree(SID_B, "report.html"), (err: any) => {
			return err instanceof PreviewMountError && err.statusCode === 400;
		});
	});

	it("rejects a missing srcFile", () => {
		assert.throws(() => copyFileTree(SID_B, path.join(root, "no-such-dir", "x.html")), (err: any) => {
			return err instanceof PreviewMountError && (err.statusCode === 404 || err.statusCode === 400);
		});
	});
});

describe("removeMount", () => {
	it("is idempotent", () => {
		writeInline(SID, "x", "z.html");
		removeMount(SID);
		// Second call must not throw.
		removeMount(SID);
		// And on a never-existed sid.
		removeMount("ffffffff-ffff-ffff-ffff-ffffffffffff");
	});
	it("ignores invalid sessionIds silently", () => {
		removeMount("not-a-uuid");
	});
});

describe("100 MiB mount ceiling", () => {
	it("rejects writeInline that would exceed the ceiling", () => {
		// Pre-fill the mount close to the limit with one huge entry.
		const sid = "cccccccc-cccc-cccc-cccc-cccccccccccc";
		const big = "x".repeat(MAX_MOUNT_BYTES - 10);
		writeInline(sid, big, "big.html");
		// Now an additional write that, combined, exceeds the ceiling.
		const more = "y".repeat(1024);
		assert.throws(() => writeInline(sid, more, "extra.html"), (err: any) => {
			return err instanceof PreviewMountError && err.statusCode === 413;
		});
		removeMount(sid);
	});
});
