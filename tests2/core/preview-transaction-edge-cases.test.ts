import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import { createFsFromVolume, Volume } from "memfs";
import {
	createPreviewAsyncFs,
	installPreviewDirectoryTransaction,
	isPreviewDirectoryAvailable,
	markPreviewDirectoryVerified,
	mountFile,
	setPreviewFsForTesting,
	setPreviewRootForTesting,
	withPreviewDirectoryUnavailable,
	type PreviewAsyncFs,
} from "../../src/server/preview/mount.ts";

const SID = "11111111-2222-3333-4444-555555555559";

function resolved(value: fs.PathLike): string {
	return path.resolve(String(value));
}

function configureMemfs(root: string): {
	memoryFs: typeof fs;
	asyncFs: PreviewAsyncFs;
	previewRoot: string;
} {
	const memoryFs = createFsFromVolume(new Volume()) as unknown as typeof fs;
	const drive = path.parse(process.cwd()).root.slice(0, 2);
	const normalizeRealpath = (value: string): string => {
		const canonical = value.replace(/\//g, path.sep);
		return path.resolve(`${drive}${canonical}`);
	};
	const rawRealpath = memoryFs.promises.realpath.bind(memoryFs.promises);
	memoryFs.promises.realpath = (async (value: fs.PathLike) =>
		normalizeRealpath(String(await rawRealpath(value)))) as typeof memoryFs.promises.realpath;
	const previewRoot = path.join(root, "preview");
	memoryFs.mkdirSync(previewRoot, { recursive: true });
	const asyncFs = createPreviewAsyncFs(memoryFs);
	setPreviewRootForTesting(previewRoot);
	setPreviewFsForTesting(asyncFs);
	return { memoryFs, asyncFs, previewRoot };
}

async function blockDirectory(directory: string): Promise<void> {
	await assert.rejects(
		withPreviewDirectoryUnavailable(directory, async () => { throw new Error("blocked writer"); }),
		/blocked writer/,
	);
	assert.equal(isPreviewDirectoryAvailable(directory), false);
}

afterEach(() => {
	setPreviewFsForTesting(undefined);
	setPreviewRootForTesting(undefined);
	vi.restoreAllMocks();
});

describe("preview transaction edge cases", () => {
	it("republishes an intact verified live root after a pre-mutation hash error", async () => {
		const root = path.resolve("/memfs/preview-transaction-preflight");
		const { memoryFs, asyncFs, previewRoot } = configureMemfs(root);
		const live = path.join(previewRoot, SID);
		const staging = path.join(previewRoot, ".staging-preflight");
		memoryFs.mkdirSync(live);
		memoryFs.writeFileSync(path.join(live, "old.html"), "old-live");
		memoryFs.mkdirSync(staging);
		memoryFs.writeFileSync(path.join(staging, "new.html"), "new-live");
		markPreviewDirectoryVerified(live);
		const expected = await asyncFs.lstat(staging);
		const unsupported = Object.assign(new Error("unsupported old-live read"), { code: "ENOTSUP" });
		let liveRenames = 0;
		const failingFs: PreviewAsyncFs = {
			...asyncFs,
			open: async (filePath, flags, mode) => {
				if (resolved(filePath) === resolved(path.join(live, "old.html"))) throw unsupported;
				return asyncFs.open(filePath, flags, mode);
			},
			rename: async (oldPath, newPath) => {
				if (resolved(oldPath) === resolved(live)) liveRenames++;
				return asyncFs.rename(oldPath, newPath);
			},
		};

		await assert.rejects(
			installPreviewDirectoryTransaction(staging, live, {
				fs: failingFs,
				entry: "new.html",
				stagingExpectedRootStats: expected,
			}),
			error => error === unsupported,
		);
		assert.equal(liveRenames, 0);
		assert.equal(memoryFs.readFileSync(path.join(live, "old.html"), "utf8"), "old-live");
		assert.equal(isPreviewDirectoryAvailable(live), true, "the intact old root must remain servable");
	});

	it("repairs a blocked directory symlink by rename without traversing its target", async () => {
		const root = path.resolve("/memfs/preview-transaction-blocked-link");
		const { memoryFs, asyncFs, previewRoot } = configureMemfs(root);
		const live = path.join(previewRoot, SID);
		const staging = path.join(previewRoot, ".staging-link-repair");
		const outside = path.join(root, "outside");
		memoryFs.mkdirSync(outside);
		memoryFs.writeFileSync(path.join(outside, "SENTINEL.txt"), "external-sentinel");
		memoryFs.symlinkSync(outside, live, "dir");
		memoryFs.mkdirSync(staging);
		memoryFs.writeFileSync(path.join(staging, "new.html"), "new-live");
		await blockDirectory(live);
		const expected = await asyncFs.lstat(staging);
		let quarantine = "";
		let outsideOpens = 0;
		const observedFs: PreviewAsyncFs = {
			...asyncFs,
			rename: async (oldPath, newPath) => {
				if (resolved(oldPath) === resolved(live) && memoryFs.lstatSync(live).isSymbolicLink()) {
					quarantine = resolved(newPath);
					const target = memoryFs.readlinkSync(live);
					memoryFs.unlinkSync(live);
					memoryFs.symlinkSync(target, String(newPath), "dir");
					return;
				}
				return asyncFs.rename(oldPath, newPath);
			},
			opendir: async filePath => {
				if (resolved(filePath) === resolved(outside)) outsideOpens++;
				return asyncFs.opendir(filePath);
			},
		};

		const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const installed = await installPreviewDirectoryTransaction(staging, live, {
			fs: observedFs,
			entry: "new.html",
			stagingExpectedRootStats: expected,
		});
		assert.match(installed.contentHash, /^[a-f0-9]{64}$/);
		assert.ok(quarantine, "the blocked link must first be detached by rename");
		assert.equal(memoryFs.lstatSync(quarantine).isSymbolicLink(), true);
		assert.equal(
			logged.mock.calls.some(call => String(call[0]).includes(`preserving blocked preview replacement at ${quarantine}`)),
			true,
			"a non-directory quarantine must be consumed by an exact preservation log",
		);
		assert.equal(outsideOpens, 0);
		assert.equal(memoryFs.readFileSync(path.join(outside, "SENTINEL.txt"), "utf8"), "external-sentinel");
		assert.equal(memoryFs.readFileSync(path.join(live, "new.html"), "utf8"), "new-live");
		assert.equal(isPreviewDirectoryAvailable(live), true);
	});

	it("logs an exact mismatched failed-live quarantine while preserving rollback", async () => {
		const root = path.resolve("/memfs/preview-transaction-mismatched-live");
		const { memoryFs, asyncFs, previewRoot } = configureMemfs(root);
		const live = path.join(previewRoot, SID);
		const staging = path.join(previewRoot, ".staging-mismatched-live");
		const intruder = path.join(previewRoot, ".intruder-live");
		const displacedInstall = path.join(previewRoot, ".displaced-install");
		memoryFs.mkdirSync(live);
		memoryFs.writeFileSync(path.join(live, "old.html"), "old-live");
		memoryFs.mkdirSync(staging);
		memoryFs.writeFileSync(path.join(staging, "new.html"), "new-live");
		memoryFs.mkdirSync(intruder);
		memoryFs.writeFileSync(path.join(intruder, "INTRUDER.txt"), "intruder");
		markPreviewDirectoryVerified(live);
		const expected = await asyncFs.lstat(staging);
		let installed = false;
		let substituted = false;
		let failedLiveQuarantine = "";
		const raceFs: PreviewAsyncFs = {
			...asyncFs,
			rename: async (oldPath, newPath) => {
				const oldResolved = resolved(oldPath);
				if (oldResolved === resolved(staging) && resolved(newPath) === resolved(live)) installed = true;
				if (installed && substituted && oldResolved === resolved(live)) failedLiveQuarantine = resolved(newPath);
				return asyncFs.rename(oldPath, newPath);
			},
			lstat: async filePath => {
				if (installed
					&& !substituted
					&& resolved(filePath) === resolved(path.join(live, "new.html"))) {
					substituted = true;
					memoryFs.renameSync(live, displacedInstall);
					memoryFs.renameSync(intruder, live);
				}
				return asyncFs.lstat(filePath);
			},
		};
		const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

		await assert.rejects(
			installPreviewDirectoryTransaction(staging, live, {
				fs: raceFs,
				entry: "new.html",
				stagingExpectedRootStats: expected,
			}),
		);
		assert.equal(substituted, true);
		assert.ok(failedLiveQuarantine);
		assert.equal(
			logged.mock.calls.some(call => String(call[0]).includes(`mismatched failed preview preserved at ${failedLiveQuarantine}`)),
			true,
		);
		assert.equal(memoryFs.readFileSync(path.join(failedLiveQuarantine, "INTRUDER.txt"), "utf8"), "intruder");
		assert.equal(memoryFs.readFileSync(path.join(live, "old.html"), "utf8"), "old-live");
		assert.equal(isPreviewDirectoryAvailable(live), true, "the exact old backup must remain rollback authority");
	});

	it("writes zero source bytes when a staging destination ancestor is swapped outside", async () => {
		const root = path.resolve("/memfs/preview-copy-destination-swap");
		const { memoryFs, asyncFs, previewRoot } = configureMemfs(root);
		const sourceDir = path.join(root, "source");
		const source = path.join(sourceDir, "report.html");
		const outside = path.join(root, "outside");
		memoryFs.mkdirSync(sourceDir);
		memoryFs.writeFileSync(source, "SOURCE-BYTES-MUST-NOT-ESCAPE");
		memoryFs.mkdirSync(outside);
		memoryFs.writeFileSync(path.join(outside, "SENTINEL.txt"), "external-sentinel");
		let sourceReads = 0;
		let swappedStaging = "";
		let detachedStaging = "";
		const raceFs: PreviewAsyncFs = {
			...asyncFs,
			link: async () => { throw new Error("hardlink optimization must not run"); },
			open: async (filePath, flags, mode) => {
				const absolute = resolved(filePath);
				if (flags === "wx" && path.basename(path.dirname(absolute)).startsWith(`.${SID}.tmp-`)) {
					swappedStaging = path.dirname(absolute);
					detachedStaging = `${swappedStaging}.detached`;
					memoryFs.renameSync(swappedStaging, detachedStaging);
					memoryFs.symlinkSync(outside, swappedStaging, "dir");
				}
				const handle = await asyncFs.open(filePath, flags, mode);
				if (absolute !== resolved(source)) return handle;
				return {
					read: async (...args: Parameters<typeof handle.read>) => {
						sourceReads++;
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

		await assert.rejects(mountFile(SID, source));
		assert.ok(swappedStaging, "the deterministic destination swap must run");
		assert.equal(sourceReads, 0, "destination validation must finish before the first source read");
		assert.equal(memoryFs.readFileSync(path.join(outside, "SENTINEL.txt"), "utf8"), "external-sentinel");
		const escaped = path.join(outside, "report.html");
		assert.equal(memoryFs.existsSync(escaped), true, "exclusive path creation may leave an empty outside file");
		assert.equal(memoryFs.readFileSync(escaped).byteLength, 0, "no source bytes may escape through the swapped ancestor");
		assert.equal(memoryFs.existsSync(path.join(previewRoot, SID)), false);
		memoryFs.rmSync(detachedStaging, { recursive: true, force: true });
	});
});
