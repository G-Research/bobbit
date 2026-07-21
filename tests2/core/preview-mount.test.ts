import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createFsFromVolume, Volume } from "memfs";
import {
	DEFAULT_INLINE_ENTRY,
	contentHashForMount,
	createPreviewAsyncFs,
	mountDir,
	mountFile,
	mountPath,
	movePreviewDirectoryContents,
	PreviewMountError,
	removeMount,
	setPreviewFsForTesting,
	setPreviewRootForTesting,
	writeInline,
	type PreviewAsyncFs,
} from "../../src/server/preview/mount.ts";

const SID = "11111111-2222-3333-4444-555555555555";
const SID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SID_C = "99999999-8888-7777-6666-555555555555";
let root: string;
let testFs: typeof fs;
let sequence = 0;

function makeDir(label: string): string {
	const dir = path.join(root, "fixtures", `${label}-${sequence++}`);
	testFs.mkdirSync(dir, { recursive: true });
	return dir;
}

beforeAll(() => {
	const volumeFs = createFsFromVolume(new Volume()) as unknown as typeof fs;
	const drive = path.parse(process.cwd()).root.slice(0, 2);
	const normalizeRealpath = (value: string) => {
		const canonical = value.replace(/\//g, path.sep);
		return path.resolve(`${drive}${canonical}`);
	};
	const rawRealpathSync = volumeFs.realpathSync.bind(volumeFs);
	volumeFs.realpathSync = ((value: fs.PathLike) => normalizeRealpath(String(rawRealpathSync(value)))) as typeof volumeFs.realpathSync;
	const rawRealpath = volumeFs.promises.realpath.bind(volumeFs.promises);
	volumeFs.promises.realpath = (async (value: fs.PathLike) => normalizeRealpath(String(await rawRealpath(value)))) as typeof volumeFs.promises.realpath;
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

	it("rejects an entry replaced by a symlink during the direct-copy fallback", async () => {
		await removeMount(SID_B);
		const src = makeSource();
		const outside = makeDir("fallback-outside");
		const victim = path.join(src, "report.html");
		const secret = path.join(outside, "secret.txt");
		testFs.writeFileSync(secret, "external-secret");
		const baseFs = createPreviewAsyncFs(testFs);
		let victimOpens = 0;
		let substituted = false;
		let reads = 0;
		const raceFs: PreviewAsyncFs = {
			...baseFs,
			link: async () => {
				const error = new Error("cross-device") as NodeJS.ErrnoException;
				error.code = "EXDEV";
				throw error;
			},
			open: async (filePath, flags, mode) => {
				const absolute = path.resolve(String(filePath));
				if (absolute === path.resolve(victim)) {
					victimOpens++;
					if (!substituted && victimOpens === 2) {
						substituted = true;
						testFs.unlinkSync(victim);
						testFs.symlinkSync(secret, victim);
					}
				}
				const handle = await baseFs.open(filePath, flags, mode);
				return {
					read: async (...args: Parameters<typeof handle.read>) => {
						reads++;
						return handle.read(...args);
					},
					write: (...args: Parameters<typeof handle.write>) => handle.write(...args),
					stat: (...args: Parameters<typeof handle.stat>) => handle.stat(...args),
					chmod: (newMode: number) => handle.chmod(newMode),
					close: () => handle.close(),
				} as unknown as fs.promises.FileHandle;
			},
		};
		setPreviewFsForTesting(raceFs);
		try {
			await assert.rejects(
				mountFile(SID_B, victim),
				(error: unknown) => error instanceof PreviewMountError && error.statusCode === 500,
			);
		} finally {
			setPreviewFsForTesting(testFs);
		}

		assert.equal(victimOpens, 2, "the EXDEV fallback must reopen the source for descriptor-anchored streaming");
		assert.equal(reads, 0, "the followed secret descriptor must be rejected before reading");
		assert.equal(testFs.readFileSync(secret, "utf-8"), "external-secret");
		assert.equal(testFs.existsSync(path.join(mountPath(SID_B), "report.html")), false);
		assert.deepEqual(testFs.readdirSync(root).filter(name => name.startsWith(`.${SID_B}.tmp-`)), []);
		testFs.rmSync(src, { recursive: true, force: true });
		testFs.rmSync(outside, { recursive: true, force: true });
		await removeMount(SID_B);
	});

	it("falls back to a descriptor-anchored copy when a successful hardlink has the wrong identity", async () => {
		await removeMount(SID_B);
		const src = makeSource();
		const victim = path.join(src, "report.html");
		const baseFs = createPreviewAsyncFs(testFs);
		let linkCalls = 0;
		let victimOpens = 0;
		let fallbackDestinationOpens = 0;
		let producedDifferentIdentity = false;
		const mismatchFs: PreviewAsyncFs = {
			...baseFs,
			link: async (existingPath, newPath) => {
				linkCalls++;
				await baseFs.copyFile(existingPath, newPath, fs.constants.COPYFILE_EXCL);
				const sourceStats = await baseFs.lstat(existingPath);
				const destinationStats = await baseFs.lstat(newPath);
				producedDifferentIdentity = sourceStats.dev !== destinationStats.dev || sourceStats.ino !== destinationStats.ino;
			},
			open: async (filePath, flags, mode) => {
				if (path.resolve(String(filePath)) === path.resolve(victim)) victimOpens++;
				if (flags === "wx") fallbackDestinationOpens++;
				return baseFs.open(filePath, flags, mode);
			},
		};
		setPreviewFsForTesting(mismatchFs);
		try {
			const result = await mountFile(SID_B, victim);
			assert.equal(testFs.readFileSync(result.path, "utf-8"), "<h1>r</h1>");
		} finally {
			setPreviewFsForTesting(testFs);
			testFs.rmSync(src, { recursive: true, force: true });
			await removeMount(SID_B);
		}

		assert.equal(producedDifferentIdentity, true, "the injected successful link must produce a different inode");
		assert.equal(linkCalls, 1);
		assert.equal(victimOpens, 2, "the safe fallback must reopen and revalidate the source");
		assert.equal(
			fallbackDestinationOpens,
			1,
			"only the source fallback exclusively creates a child; the staged root is installed by rename",
		);
	});

	it("rejects a staging-root symlink substitution without moving external contents", async () => {
		const staging = makeDir("staging-race");
		const destination = makeDir("staging-race-destination");
		const outside = makeDir("staging-race-outside");
		const sentinel = path.join(outside, "KEEP.txt");
		testFs.writeFileSync(path.join(staging, "inside.html"), "inside");
		testFs.writeFileSync(sentinel, "external-sentinel");

		const baseFs = createPreviewAsyncFs(testFs);
		let substituted = false;
		const renameSources: string[] = [];
		const raceFs: PreviewAsyncFs = {
			...baseFs,
			rename: async (oldPath, newPath) => {
				const source = path.resolve(String(oldPath));
				renameSources.push(source);
				if (!substituted && source === path.resolve(staging)) {
					substituted = true;
					testFs.rmSync(staging, { recursive: true, force: true });
					testFs.symlinkSync(outside, staging);
					// memfs rename follows a directory symlink; model the native rename(2)
					// contract explicitly so only the link itself moves to the claim path.
					const linkTarget = testFs.readlinkSync(staging);
					testFs.unlinkSync(staging);
					testFs.symlinkSync(linkTarget, String(newPath));
					return;
				}
				return baseFs.rename(oldPath, newPath);
			},
		};

		try {
			await assert.rejects(
				movePreviewDirectoryContents(staging, destination, { fs: raceFs, concurrency: 1 }),
				(error: unknown) => error instanceof PreviewMountError && error.statusCode === 500,
			);
			assert.equal(substituted, true, "the deterministic root substitution must run");
			assert.deepEqual(
				renameSources,
				[path.resolve(staging)],
				"only the initial no-follow root claim may rename through the caller-known staging path",
			);
			assert.equal(testFs.readFileSync(sentinel, "utf-8"), "external-sentinel");
			assert.equal(testFs.existsSync(path.join(destination, "KEEP.txt")), false);
			assert.equal(testFs.existsSync(staging), false, "the substituted symlink should be safely unlinked");
		} finally {
			testFs.rmSync(staging, { recursive: true, force: true });
			testFs.rmSync(destination, { recursive: true, force: true });
			testFs.rmSync(outside, { recursive: true, force: true });
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

	it("removeMount propagates non-ENOENT deletion failures", async () => {
		await writeInline(SID_C, "x", "z.html");
		const target = path.resolve(mountPath(SID_C));
		const baseFs = createPreviewAsyncFs(testFs);
		const failure = Object.assign(new Error("mount deletion denied"), { code: "EACCES" });
		let deletionAttempted = false;
		const failingFs: PreviewAsyncFs = {
			...baseFs,
			lstat: async filePath => {
				if (path.resolve(String(filePath)) === target) {
					deletionAttempted = true;
					throw failure;
				}
				return baseFs.lstat(filePath);
			},
		};
		setPreviewFsForTesting(failingFs);
		try {
			await assert.rejects(removeMount(SID_C), (error: unknown) => error === failure);
			assert.equal(deletionAttempted, true);
		} finally {
			setPreviewFsForTesting(testFs);
			await removeMount(SID_C);
		}
	});
});
