import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, it, vi } from "vitest";
import { createFsFromVolume, Volume } from "memfs";
import { CookieStore } from "../../src/server/auth/cookie.ts";
import { handlePreviewRequest } from "../../src/server/preview/content-route.ts";
import {
	createPreviewAsyncFs,
	installPreviewDirectoryTransaction,
	isPreviewDirectoryAvailable,
	markPreviewDirectoryVerified,
	mountPath,
	removeMount,
	setPreviewFsForTesting,
	setPreviewRootForTesting,
	withPreviewDirectoryUnavailable,
	writeInline,
	type PreviewAsyncFs,
} from "../../src/server/preview/mount.ts";

const SID_A = "11111111-2222-3333-4444-555555555551";
const SID_B = "11111111-2222-3333-4444-555555555552";

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

function memfsAt(root: string): { memoryFs: typeof fs; asyncFs: PreviewAsyncFs } {
	const memoryFs = createFsFromVolume(new Volume()) as unknown as typeof fs;
	const drive = path.parse(process.cwd()).root.slice(0, 2);
	const normalizeRealpath = (value: string): string => {
		const canonical = value.replace(/\//g, path.sep);
		return path.resolve(`${drive}${canonical}`);
	};
	const rawRealpath = memoryFs.promises.realpath.bind(memoryFs.promises);
	memoryFs.promises.realpath = (async (value: fs.PathLike) =>
		normalizeRealpath(String(await rawRealpath(value)))) as typeof memoryFs.promises.realpath;
	memoryFs.mkdirSync(root, { recursive: true });
	return { memoryFs, asyncFs: createPreviewAsyncFs(memoryFs) };
}

function configureMemfs(root: string): { memoryFs: typeof fs; asyncFs: PreviewAsyncFs; previewRoot: string } {
	const { memoryFs, asyncFs } = memfsAt(root);
	const previewRoot = path.join(root, "preview");
	memoryFs.mkdirSync(previewRoot, { recursive: true });
	setPreviewRootForTesting(previewRoot);
	setPreviewFsForTesting(asyncFs);
	return { memoryFs, asyncFs, previewRoot };
}

function resolved(value: fs.PathLike): string {
	return path.resolve(String(value));
}

async function blockDirectory(directory: string): Promise<void> {
	await assert.rejects(
		withPreviewDirectoryUnavailable(directory, async () => { throw new Error("deterministic writer failure"); }),
		/deterministic writer failure/,
	);
	assert.equal(isPreviewDirectoryAvailable(directory), false);
}

class HeldReadable extends Readable {
	_read(): void { /* held until the request aborts */ }
}

afterEach(() => {
	setPreviewFsForTesting(undefined);
	setPreviewRootForTesting(undefined);
	vi.restoreAllMocks();
});

describe("preview install transaction races", () => {
	it("rolls the exact backup back when staging disappears before its rename", async () => {
		const root = path.resolve("/memfs/preview-install-source-enoent");
		const { memoryFs, asyncFs, previewRoot } = configureMemfs(root);
		const live = path.join(previewRoot, SID_A);
		const staging = path.join(previewRoot, ".staging-source-enoent");
		memoryFs.mkdirSync(live);
		memoryFs.writeFileSync(path.join(live, "old.html"), "old-live");
		memoryFs.mkdirSync(staging);
		memoryFs.writeFileSync(path.join(staging, "new.html"), "new-live");
		const expected = await asyncFs.lstat(staging);
		let removedBeforeRename = false;
		const raceFs: PreviewAsyncFs = {
			...asyncFs,
			rename: async (oldPath, newPath) => {
				if (!removedBeforeRename
					&& resolved(oldPath) === resolved(staging)
					&& resolved(newPath) === resolved(live)) {
					removedBeforeRename = true;
					memoryFs.rmSync(staging, { recursive: true, force: true });
				}
				return asyncFs.rename(oldPath, newPath);
			},
		};

		await assert.rejects(
			installPreviewDirectoryTransaction(staging, live, {
				fs: raceFs,
				entry: "new.html",
				stagingExpectedRootStats: expected,
			}),
		);
		assert.equal(removedBeforeRename, true);
		assert.equal(memoryFs.readFileSync(path.join(live, "old.html"), "utf8"), "old-live");
		assert.equal(memoryFs.existsSync(path.join(live, "new.html")), false);
		assert.equal(isPreviewDirectoryAvailable(live), true, "validated rollback must republish the old root");
	});

	it("rejects unsupported staging identity before fencing or mutating old live", async () => {
		const root = path.resolve("/memfs/preview-install-unstable-staging");
		const { memoryFs, asyncFs, previewRoot } = configureMemfs(root);
		const live = path.join(previewRoot, SID_A);
		const staging = path.join(previewRoot, ".staging-unstable");
		memoryFs.mkdirSync(live);
		memoryFs.writeFileSync(path.join(live, "old.html"), "old-live");
		memoryFs.mkdirSync(staging);
		memoryFs.writeFileSync(path.join(staging, "new.html"), "new-live");
		const unstable = await asyncFs.lstat(staging);
		Object.defineProperty(unstable, "dev", { value: undefined });
		Object.defineProperty(unstable, "ino", { value: undefined });
		let liveRenames = 0;
		const observedFs: PreviewAsyncFs = {
			...asyncFs,
			rename: async (oldPath, newPath) => {
				if (resolved(oldPath) === resolved(live)) liveRenames++;
				return asyncFs.rename(oldPath, newPath);
			},
		};

		await assert.rejects(
			installPreviewDirectoryTransaction(staging, live, {
				fs: observedFs,
				entry: "new.html",
				stagingExpectedRootStats: unstable,
			}),
			/stable directory/,
		);
		assert.equal(liveRenames, 0);
		assert.equal(memoryFs.readFileSync(path.join(live, "old.html"), "utf8"), "old-live");
		assert.equal(isPreviewDirectoryAvailable(live), true);
	});

	it("keeps a failed write blocked until a later verified writer repairs it", async () => {
		const root = path.resolve("/memfs/preview-install-persistent-block");
		const { asyncFs } = configureMemfs(root);
		const live = mountPath(SID_A);
		const writeFailure = new Error("deferred write failed");
		const failingFs: PreviewAsyncFs = {
			...asyncFs,
			writeFile: async () => { throw writeFailure; },
		};
		setPreviewFsForTesting(failingFs);
		await assert.rejects(writeInline(SID_A, "broken", "index.html"), error => error === writeFailure);
		assert.equal(isPreviewDirectoryAvailable(live), false);

		setPreviewFsForTesting(asyncFs);
		await writeInline(SID_A, "repaired", "index.html");
		assert.equal(isPreviewDirectoryAvailable(live), true);
	});

	it("serializes same-key writers before either worker can mutate", async () => {
		const directory = path.resolve("/memfs/preview-install-writer-serialization/preview", SID_A);
		const gate = deferred();
		let active = 0;
		let maximum = 0;
		const order: string[] = [];
		const first = withPreviewDirectoryUnavailable(directory, async () => {
			active++;
			maximum = Math.max(maximum, active);
			order.push("first-enter");
			await gate.promise;
			order.push("first-exit");
			active--;
			markPreviewDirectoryVerified(directory);
		});
		await new Promise<void>(resolve => setImmediate(resolve));
		const second = withPreviewDirectoryUnavailable(directory, async () => {
			active++;
			maximum = Math.max(maximum, active);
			order.push("second-enter");
			active--;
			markPreviewDirectoryVerified(directory);
		});
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(order, ["first-enter"]);
		gate.resolve();
		await Promise.all([first, second]);
		assert.deepEqual(order, ["first-enter", "first-exit", "second-enter"]);
		assert.equal(maximum, 1);
		assert.equal(isPreviewDirectoryAvailable(directory), true);
	});

	it("blocked purge detaches by rename before inspecting only the owned quarantine", async () => {
		const root = path.resolve("/memfs/preview-install-blocked-purge");
		const { memoryFs, asyncFs } = configureMemfs(root);
		const live = mountPath(SID_A);
		memoryFs.mkdirSync(path.join(live, "deep"), { recursive: true });
		memoryFs.writeFileSync(path.join(live, "deep", "asset.bin"), "asset");
		await blockDirectory(live);
		const events: string[] = [];
		const observedFs: PreviewAsyncFs = {
			...asyncFs,
			rename: async (oldPath, newPath) => {
				if (resolved(oldPath) === resolved(live)) events.push("rename-live");
				return asyncFs.rename(oldPath, newPath);
			},
			lstat: async filePath => {
				const target = resolved(filePath);
				if (target === resolved(live) || target.startsWith(`${resolved(live)}${path.sep}`)) events.push(`lstat-live:${target}`);
				return asyncFs.lstat(filePath);
			},
			opendir: async filePath => {
				if (resolved(filePath) === resolved(live)) events.push("opendir-live");
				return asyncFs.opendir(filePath);
			},
		};
		setPreviewFsForTesting(observedFs);

		await removeMount(SID_A);
		assert.equal(events[0], "rename-live");
		assert.equal(events.includes("opendir-live"), false, "blocked live identity must never be recursively opened");
		assert.equal(memoryFs.existsSync(live), false);
		assert.equal(isPreviewDirectoryAvailable(live), true);
	});

	it("destroys an aborted non-HTML stream and releases its directory lease", async () => {
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-preview-abort-"));
		const previewRoot = path.join(temp, "preview");
		setPreviewRootForTesting(previewRoot);
		const live = mountPath(SID_A);
		fs.mkdirSync(live, { recursive: true });
		fs.writeFileSync(path.join(live, "asset.bin"), Buffer.alloc(64));
		const held = new HeldReadable();
		vi.spyOn(fs, "createReadStream").mockReturnValue(held as unknown as fs.ReadStream);

		const req = Object.assign(new EventEmitter(), {
			url: `/preview/${SID_A}/asset.bin`,
			method: "GET",
			headers: { host: "x" },
			complete: true,
			aborted: false,
		}) as any;
		const res = new PassThrough() as PassThrough & {
			statusCode: number;
			headers: Record<string, string | number>;
			writeHead(status: number, headers?: Record<string, string | number>): void;
		};
		res.statusCode = 0;
		res.headers = {};
		res.writeHead = (status, headers) => {
			res.statusCode = status;
			res.headers = headers ?? {};
		};
		const route = handlePreviewRequest(
			req,
			res as any,
			`/preview/${SID_A}/asset.bin`,
			{ cookieStore: new CookieStore(Buffer.alloc(32, 7)), isLocalhost: true },
		);
		await new Promise<void>(resolve => setImmediate(resolve));
		req.emit("close");
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(held.destroyed, false, "normal completed request close must not truncate the response stream");

		let writerEntered = false;
		const writer = withPreviewDirectoryUnavailable(live, async () => {
			writerEntered = true;
			markPreviewDirectoryVerified(live);
		});
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(writerEntered, false, "writer must wait for the streaming read lease");
		req.aborted = true;
		req.emit("aborted");
		await Promise.all([route, writer]);
		assert.equal(held.destroyed, true);
		assert.equal(writerEntered, true);
		res.destroy();
		fs.rmSync(temp, { recursive: true, force: true });
	});

	it("serializes owned quarantine cleanup and logs failures without losing ownership", async () => {
		const root = path.resolve("/memfs/preview-install-cleanup-ownership");
		const { memoryFs, asyncFs } = configureMemfs(root);
		const liveA = mountPath(SID_A);
		const liveB = mountPath(SID_B);
		for (const live of [liveA, liveB]) {
			memoryFs.mkdirSync(path.join(live, "deep"), { recursive: true });
			memoryFs.writeFileSync(path.join(live, "deep", "asset.bin"), "asset");
			await blockDirectory(live);
		}

		const holdFirstOpen = deferred();
		const firstOpenStarted = deferred();
		const quarantines: string[] = [];
		let activeOpens = 0;
		let maximumOpens = 0;
		let openCalls = 0;
		const cleanupFailure = Object.assign(new Error("owned quarantine cleanup denied"), { code: "EACCES" });
		const controlledFs: PreviewAsyncFs = {
			...asyncFs,
			rename: async (oldPath, newPath) => {
				if ([resolved(liveA), resolved(liveB)].includes(resolved(oldPath))) quarantines.push(resolved(newPath));
				return asyncFs.rename(oldPath, newPath);
			},
			opendir: async filePath => {
				if (resolved(filePath).includes(".preview-quarantine-")) {
					openCalls++;
					activeOpens++;
					maximumOpens = Math.max(maximumOpens, activeOpens);
					if (openCalls === 1) {
						firstOpenStarted.resolve();
						await holdFirstOpen.promise;
					}
					activeOpens--;
				}
				return asyncFs.opendir(filePath);
			},
			rmdir: async filePath => {
				if (quarantines[0] && resolved(filePath) === quarantines[0]) throw cleanupFailure;
				return asyncFs.rmdir(filePath);
			},
		};
		setPreviewFsForTesting(controlledFs);
		const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const removals = [removeMount(SID_A), removeMount(SID_B)];
		await firstOpenStarted.promise;
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(openCalls, 1, "the second cleanup must wait behind the ownership lane");
		assert.equal(quarantines.length, 2, "both blocked roots detach before recursive cleanup ownership");
		holdFirstOpen.resolve();
		await Promise.all(removals);

		assert.equal(maximumOpens, 1);
		assert.equal(logged.mock.calls.some(call => String(call[0]).includes("failed to clean blocked mount purge")), true);
		assert.equal(memoryFs.existsSync(quarantines[0]!), true, "failed owned cleanup preserves its quarantine path");
		assert.equal(memoryFs.existsSync(liveA), false);
		assert.equal(memoryFs.existsSync(liveB), false);
	});
});
