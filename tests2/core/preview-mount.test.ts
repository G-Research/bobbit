import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import path from "node:path";
import { createFsFromVolume, Volume } from "memfs";
import {
	DEFAULT_INLINE_ENTRY,
	contentHashForMount,
	mountDir,
	mountFile,
	mountPath,
	PreviewMountError,
	removeMount,
	setPreviewFsForTesting,
	setPreviewRootForTesting,
	writeInline,
} from "../../src/server/preview/mount.ts";

const SID = "11111111-2222-3333-4444-555555555555";
const SID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SID_C = "99999999-8888-7777-6666-555555555555";
let root: string;
let testFs: typeof import("node:fs");
let sequence = 0;

function makeDir(label: string): string {
	const dir = path.join(root, "fixtures", `${label}-${sequence++}`);
	testFs.mkdirSync(dir, { recursive: true });
	return dir;
}

beforeAll(() => {
	const volumeFs = createFsFromVolume(new Volume()) as unknown as typeof import("node:fs");
	const drive = path.parse(process.cwd()).root.slice(0, 2);
	const normalizeRealpath = (value: string) => {
		const canonical = value.replace(/\//g, path.sep);
		return path.resolve(`${drive}${canonical}`);
	};
	const rawRealpathSync = volumeFs.realpathSync.bind(volumeFs);
	volumeFs.realpathSync = ((value: import("node:fs").PathLike) => normalizeRealpath(String(rawRealpathSync(value)))) as typeof volumeFs.realpathSync;
	const rawRealpath = volumeFs.promises.realpath.bind(volumeFs.promises);
	volumeFs.promises.realpath = (async (value: import("node:fs").PathLike) => normalizeRealpath(String(await rawRealpath(value)))) as typeof volumeFs.promises.realpath;
	testFs = volumeFs;
	root = path.resolve("/memfs/preview-mount");
	testFs.mkdirSync(root, { recursive: true });
	setPreviewFsForTesting(testFs);
	setPreviewRootForTesting(root);
});

afterAll(() => {
	setPreviewRootForTesting(undefined);
	setPreviewFsForTesting(undefined);
});

function assertHash(value: string): void {
	assert.match(value, /^[a-f0-9]{64}$/);
}

function listMount(sid: string): string[] {
	const out: string[] = [];
	const walk = (dir: string, prefix: string) => {
		for (const ent of testFs.readdirSync(dir, { withFileTypes: true })) {
			const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
			if (ent.isDirectory()) walk(path.join(dir, ent.name), rel);
			else if (ent.isFile()) out.push(rel);
		}
	};
	walk(mountPath(sid), "");
	return out.sort();
}

function makeSource(): string {
	const src = makeDir("source");
	testFs.writeFileSync(path.join(src, "report.html"), "<h1>r</h1>");
	testFs.writeFileSync(path.join(src, "styles.css"), "body{}");
	testFs.writeFileSync(path.join(src, "secret.env"), "KEY=shh");
	testFs.mkdirSync(path.join(src, "img"));
	testFs.writeFileSync(path.join(src, "img", "a.png"), "pngA");
	testFs.writeFileSync(path.join(src, "img", "b.png"), "pngB");
	testFs.writeFileSync(path.join(src, "img", "c.svg"), "<svg/>");
	testFs.mkdirSync(path.join(src, "sub"));
	testFs.writeFileSync(path.join(src, "sub", "file.png"), "subpng");
	return src;
}

describe("preview mount", () => {
	it("keeps mountDir validation and creates a valid mount", () => {
		assert.equal(mountDir(SID), path.join(root, SID));
		assert.equal(testFs.statSync(mountPath(SID)).isDirectory(), true);
		assert.throws(() => mountDir("not-a-uuid"), PreviewMountError);
	});

	it("writes inline content atomically and returns stable async hashes", async () => {
		const first = await writeInline(SID, "<h1>hello</h1>");
		assert.equal(first.entry, DEFAULT_INLINE_ENTRY);
		assert.equal(first.relPath, path.posix.join(SID, DEFAULT_INLINE_ENTRY));
		assertHash(first.contentHash);
		assert.equal(first.contentHash, await contentHashForMount(SID));
		const second = await writeInline(SID, "longer replacement", DEFAULT_INLINE_ENTRY);
		assert.notEqual(second.contentHash, first.contentHash);
		assert.equal(testFs.readFileSync(second.path, "utf-8"), "longer replacement");
	});

	it("rejects unsafe inline entries", async () => {
		for (const entry of ["sub/foo.html", "sub\\foo.html", "..", ".", ""]) {
			await assert.rejects(writeInline(SID, "x", entry), PreviewMountError);
		}
	});

	it("mounts only declared literals and globs with sorted asset paths", async () => {
		const src = makeSource();
		try {
			const result = await mountFile(SID_B, path.join(src, "report.html"), ["styles.css", "img/*.png", "sub/file.png"]);
			assert.deepEqual(result.assets, ["img/a.png", "img/b.png", "styles.css", "sub/file.png"]);
			assert.deepEqual(listMount(SID_B), ["img/a.png", "img/b.png", "report.html", "styles.css", "sub/file.png"]);
			assertHash(result.contentHash);
			assert.equal(testFs.existsSync(path.join(mountPath(SID_B), "secret.env")), false);
		} finally {
			testFs.rmSync(src, { recursive: true, force: true });
			await removeMount(SID_B);
		}
	});

	it("rejects invalid asset specs and missing literals", async () => {
		const src = makeSource();
		try {
			for (const spec of ["../escape", "/abs/path", "C:/Windows/x", "**/*.css", "img/[ab].png", "{a,b}.png", "sub\\file.png"]) {
				await assert.rejects(mountFile(SID_B, path.join(src, "report.html"), [spec]), PreviewMountError);
			}
			await assert.rejects(
				mountFile(SID_B, path.join(src, "report.html"), ["missing.css"]),
				(error: any) => error instanceof PreviewMountError && error.statusCode === 404,
			);
		} finally {
			testFs.rmSync(src, { recursive: true, force: true });
			await removeMount(SID_B);
		}
	});

	it("does not traverse an escaping asset symlink", async () => {
		const outside = makeDir("outside");
		const src = makeSource();
		testFs.writeFileSync(path.join(outside, "secret.txt"), "shh");
		try {
			testFs.symlinkSync(path.join(outside, "secret.txt"), path.join(src, "leak.txt"));
			await assert.rejects(
				mountFile(SID_B, path.join(src, "report.html"), ["leak.txt"]),
				(error: any) => error instanceof PreviewMountError && error.statusCode === 403,
			);
		} finally {
			testFs.rmSync(src, { recursive: true, force: true });
			testFs.rmSync(outside, { recursive: true, force: true });
			await removeMount(SID_B);
		}
	});

	it("stages before swap, supports reopening a mounted path, and rolls back staging errors", async () => {
		const src = makeSource();
		try {
			const first = await mountFile(SID_B, path.join(src, "report.html"), ["styles.css"]);
			const prior = listMount(SID_B);
			await assert.rejects(mountFile(SID_B, path.join(src, "report.html"), ["missing.css"]), PreviewMountError);
			assert.deepEqual(listMount(SID_B), prior);
			const reopened = await mountFile(SID_B, first.path);
			assert.equal(testFs.readFileSync(reopened.path, "utf-8"), "<h1>r</h1>");
			assert.deepEqual(testFs.readdirSync(root).filter(name => name.startsWith(`.${SID_B}.tmp-`)), []);
		} finally {
			testFs.rmSync(src, { recursive: true, force: true });
			await removeMount(SID_B);
		}
	});

	it("removeMount is async and idempotent", async () => {
		await writeInline(SID_C, "x", "z.html");
		await removeMount(SID_C);
		await removeMount(SID_C);
		await removeMount("not-a-uuid");
		assert.equal(testFs.existsSync(mountPath(SID_C)), false);
	});
});
