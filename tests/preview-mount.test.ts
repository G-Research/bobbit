/**
 * Unit tests for `src/server/preview/mount.ts`.
 *
 * Covers writeInline (default + custom + bad entry), mountFile (explicit
 * asset opt-in: literals, nested paths, globs, validation, symlink escape),
 * and removeMount (idempotent).
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	DEFAULT_INLINE_ENTRY,
	mountDir,
	mountFile,
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

function listMount(sid: string): string[] {
	const base = mountDir(sid);
	const out: string[] = [];
	const walk = (dir: string, prefix: string) => {
		for (const ent of readdirSync(dir, { withFileTypes: true })) {
			const rel = prefix === "" ? ent.name : `${prefix}/${ent.name}`;
			if (ent.isDirectory()) walk(path.join(dir, ent.name), rel);
			else if (ent.isFile()) out.push(rel);
		}
	};
	walk(base, "");
	return out.sort();
}

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

describe("mountFile — explicit asset opt-in", () => {
	function makeSrc(): string {
		const src = mkdtempSync(path.join(tmpdir(), "bobbit-mountfile-src-"));
		writeFileSync(path.join(src, "report.html"), "<h1>r</h1>");
		writeFileSync(path.join(src, "styles.css"), "body{}");
		writeFileSync(path.join(src, "secret.env"), "KEY=shh");
		mkdirSync(path.join(src, "img"));
		writeFileSync(path.join(src, "img", "a.png"), "pngA");
		writeFileSync(path.join(src, "img", "b.png"), "pngB");
		writeFileSync(path.join(src, "img", "c.svg"), "<svg/>");
		mkdirSync(path.join(src, "sub"));
		writeFileSync(path.join(src, "sub", "file.png"), "subpng");
		return src;
	}

	it("with no assets — copies only the entry, no siblings", () => {
		const src = makeSrc();
		try {
			const r = mountFile(SID_B, path.join(src, "report.html"));
			assert.equal(r.entry, "report.html");
			assert.deepEqual(r.assets, []);
			assert.deepEqual(listMount(SID_B), ["report.html"]);
		} finally {
			rmSync(src, { recursive: true, force: true });
			removeMount(SID_B);
		}
	});

	it("with literal assets — copies entry + declared, nothing else", () => {
		const src = makeSrc();
		try {
			const r = mountFile(SID_B, path.join(src, "report.html"), ["styles.css"]);
			assert.deepEqual(r.assets, ["styles.css"]);
			assert.deepEqual(listMount(SID_B), ["report.html", "styles.css"]);
		} finally {
			rmSync(src, { recursive: true, force: true });
			removeMount(SID_B);
		}
	});

	it("with nested literal asset — preserves directory structure", () => {
		const src = makeSrc();
		try {
			const r = mountFile(SID_B, path.join(src, "report.html"), ["sub/file.png"]);
			assert.deepEqual(r.assets, ["sub/file.png"]);
			assert.deepEqual(listMount(SID_B), ["report.html", "sub/file.png"]);
		} finally {
			rmSync(src, { recursive: true, force: true });
			removeMount(SID_B);
		}
	});

	it("with single-segment glob — expands inside the matched dir only", () => {
		const src = makeSrc();
		try {
			const r = mountFile(SID_B, path.join(src, "report.html"), ["img/*.png"]);
			assert.deepEqual(r.assets, ["img/a.png", "img/b.png"]);
			// img/c.svg must NOT be present.
			assert.deepEqual(listMount(SID_B), ["img/a.png", "img/b.png", "report.html"]);
		} finally {
			rmSync(src, { recursive: true, force: true });
			removeMount(SID_B);
		}
	});

	it("rejects a `..` escape in an asset path with 400", () => {
		const src = makeSrc();
		try {
			assert.throws(
				() => mountFile(SID_B, path.join(src, "report.html"), ["../escape"]),
				(err: any) => err instanceof PreviewMountError && err.statusCode === 400,
			);
		} finally {
			rmSync(src, { recursive: true, force: true });
			removeMount(SID_B);
		}
	});

	it("rejects an absolute asset path with 400", () => {
		const src = makeSrc();
		try {
			assert.throws(
				() => mountFile(SID_B, path.join(src, "report.html"), ["/abs/path"]),
				(err: any) => err instanceof PreviewMountError && err.statusCode === 400,
			);
			assert.throws(
				() => mountFile(SID_B, path.join(src, "report.html"), ["C:/Windows/x"]),
				(err: any) => err instanceof PreviewMountError && err.statusCode === 400,
			);
		} finally {
			rmSync(src, { recursive: true, force: true });
			removeMount(SID_B);
		}
	});

	it("rejects `**` glob with 400", () => {
		const src = makeSrc();
		try {
			assert.throws(
				() => mountFile(SID_B, path.join(src, "report.html"), ["**/*.css"]),
				(err: any) => err instanceof PreviewMountError && err.statusCode === 400,
			);
		} finally {
			rmSync(src, { recursive: true, force: true });
			removeMount(SID_B);
		}
	});

	it("rejects `[abc]` and `{a,b}` globs with 400", () => {
		const src = makeSrc();
		try {
			assert.throws(
				() => mountFile(SID_B, path.join(src, "report.html"), ["img/[ab].png"]),
				(err: any) => err instanceof PreviewMountError && err.statusCode === 400,
			);
			assert.throws(
				() => mountFile(SID_B, path.join(src, "report.html"), ["{a,b}.png"]),
				(err: any) => err instanceof PreviewMountError && err.statusCode === 400,
			);
		} finally {
			rmSync(src, { recursive: true, force: true });
			removeMount(SID_B);
		}
	});

	it("rejects backslash in asset path with 400", () => {
		const src = makeSrc();
		try {
			assert.throws(
				() => mountFile(SID_B, path.join(src, "report.html"), ["sub\\file.png"]),
				(err: any) => err instanceof PreviewMountError && err.statusCode === 400,
			);
		} finally {
			rmSync(src, { recursive: true, force: true });
			removeMount(SID_B);
		}
	});

	it("missing literal asset → 404", () => {
		const src = makeSrc();
		try {
			assert.throws(
				() => mountFile(SID_B, path.join(src, "report.html"), ["missing.css"]),
				(err: any) => err instanceof PreviewMountError && err.statusCode === 404,
			);
		} finally {
			rmSync(src, { recursive: true, force: true });
			removeMount(SID_B);
		}
	});

	it("symlink asset escaping the source dir → 403", { skip: !supportsSymlink }, () => {
		const outside = mkdtempSync(path.join(tmpdir(), "bobbit-mountfile-out-"));
		writeFileSync(path.join(outside, "secret.txt"), "shh");
		const src = makeSrc();
		try {
			symlinkSync(path.join(outside, "secret.txt"), path.join(src, "leak.txt"));
			assert.throws(
				() => mountFile(SID_B, path.join(src, "report.html"), ["leak.txt"]),
				(err: any) => err instanceof PreviewMountError && err.statusCode === 403,
			);
		} finally {
			rmSync(src, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
			removeMount(SID_B);
		}
	});

	it("rejects non-absolute srcFile with 400", () => {
		assert.throws(
			() => mountFile(SID_B, "report.html"),
			(err: any) => err instanceof PreviewMountError && err.statusCode === 400,
		);
	});

	it("rejects missing srcFile", () => {
		assert.throws(
			() => mountFile(SID_B, path.join(root, "no-such-dir", "x.html")),
			(err: any) => err instanceof PreviewMountError && (err.statusCode === 404 || err.statusCode === 400),
		);
	});

	it("glob with no matches is not an error", () => {
		const src = makeSrc();
		try {
			const r = mountFile(SID_B, path.join(src, "report.html"), ["img/*.gif"]);
			assert.deepEqual(r.assets, []);
			assert.deepEqual(listMount(SID_B), ["report.html"]);
		} finally {
			rmSync(src, { recursive: true, force: true });
			removeMount(SID_B);
		}
	});

	it("re-mounting wipes prior mount contents", () => {
		const src = makeSrc();
		try {
			mountFile(SID_B, path.join(src, "report.html"), ["styles.css"]);
			assert.ok(existsSync(path.join(mountDir(SID_B), "styles.css")));
			// Re-mount with no assets → styles.css should be gone.
			mountFile(SID_B, path.join(src, "report.html"));
			assert.ok(!existsSync(path.join(mountDir(SID_B), "styles.css")));
			assert.ok(existsSync(path.join(mountDir(SID_B), "report.html")));
		} finally {
			rmSync(src, { recursive: true, force: true });
			removeMount(SID_B);
		}
	});
});

describe("mountFile \u2014 re-open same source file (Bug 4)", () => {
	/**
	 * Reproducing tests for Bug 4: mountFile() wipes destRoot before copying.
	 * If the source file's realpath lives inside destRoot, the wipe deletes it
	 * and the subsequent copy throws ("cannot copy a file onto itself" / ENOENT).
	 *
	 * Both tests must FAIL on master and pass after the atomic stage-then-swap fix.
	 */
	it("two consecutive mountFile() calls with the same external source succeed", () => {
		const src = mkdtempSync(path.join(tmpdir(), "bobbit-mount-bug4a-"));
		try {
			const entry = path.join(src, "report.html");
			writeFileSync(entry, "<h1>v1</h1>");
			const r1 = mountFile(SID_B, entry);
			const t1 = statSync(r1.path).mtimeMs;
			// Ensure mtime can move forward across platforms with coarse granularity.
			const sleep = Date.now() + 25;
			while (Date.now() < sleep) { /* busy-wait — short, deterministic */ }
			writeFileSync(entry, "<h1>v2-longer</h1>");
			const r2 = mountFile(SID_B, entry);
			const t2 = statSync(r2.path).mtimeMs;
			assert.equal(r2.entry, "report.html");
			assert.ok(t2 >= t1, `second mtime (${t2}) should be >= first (${t1})`);
			assert.equal(statSync(r2.path).size, "<h1>v2-longer</h1>".length);
		} finally {
			rmSync(src, { recursive: true, force: true });
			removeMount(SID_B);
		}
	});

	it("mountFile() succeeds when srcFile is a path inside the existing mount", () => {
		const src = mkdtempSync(path.join(tmpdir(), "bobbit-mount-bug4b-"));
		try {
			const originalEntry = path.join(src, "report.html");
			writeFileSync(originalEntry, "<h1>seed</h1>");
			const r1 = mountFile(SID_B, originalEntry);
			// r1.path now points inside mountDir(SID_B). Simulate the agent passing
			// that very path back into preview_open(file=...).
			const insideMount = r1.path;
			assert.ok(
				insideMount.startsWith(mountDir(SID_B)),
				`expected ${insideMount} to be inside ${mountDir(SID_B)}`,
			);
			assert.ok(existsSync(insideMount));

			// Currently: wipeContents(destRoot) deletes insideMount before the copy,
			// so this throws or produces an empty/stale file.
			const r2 = mountFile(SID_B, insideMount);
			assert.equal(r2.entry, "report.html");
			assert.ok(existsSync(r2.path), "mount entry must exist after re-mount from inside-mount source");
			assert.equal(statSync(r2.path).size, "<h1>seed</h1>".length, "entry contents must be preserved");
		} finally {
			rmSync(src, { recursive: true, force: true });
			removeMount(SID_B);
		}
	});
});

describe("removeMount", () => {
	it("is idempotent", () => {
		writeInline(SID, "x", "z.html");
		removeMount(SID);
		removeMount(SID);
		removeMount("ffffffff-ffff-ffff-ffff-ffffffffffff");
	});
	it("ignores invalid sessionIds silently", () => {
		removeMount("not-a-uuid");
	});
});
