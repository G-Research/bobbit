import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import {
	copyTree,
	realAsyncTreeFs,
	removeTree,
	walkTree,
	type AsyncTreeFs,
} from "../../src/server/agent/bounded-async-work.ts";

const cleanupRoots: string[] = [];

function tempRoot(label: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `bobbit-${label}-`));
	cleanupRoots.push(root);
	return root;
}

function expectStale(error: unknown): boolean {
	assert.equal((error as NodeJS.ErrnoException).code, "ESTALE");
	return true;
}

function isQuarantine(filePath: string): boolean {
	return path.basename(filePath).startsWith(".bobbit-remove-");
}

afterEach(() => {
	for (const root of cleanupRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("bounded tree claim and quarantine races", () => {
	it("does not invoke a claimed visitor hash after its parent is replaced", async () => {
		const parent = tempRoot("visitor-claim");
		const root = path.join(parent, "source");
		const nested = path.join(root, "nested");
		const detached = path.join(parent, "detached-original");
		const replacement = path.join(parent, "replacement");
		fs.mkdirSync(nested, { recursive: true });
		fs.writeFileSync(path.join(nested, "victim.txt"), "inside");
		fs.mkdirSync(replacement);
		fs.writeFileSync(path.join(replacement, "victim.txt"), "external-sentinel");
		let hashed = false;

		await assert.rejects(
			walkTree(root, async entry => {
				if (entry.relativePath !== "nested/victim.txt") return;
				fs.renameSync(nested, detached);
				fs.renameSync(replacement, nested);
				await entry.withCurrentClaim(async () => { hashed = true; });
			}, { fs: realAsyncTreeFs, concurrency: 1 }),
			expectStale,
		);

		assert.equal(hashed, false, "replacement bytes must never reach the hash callback");
		assert.equal(fs.readFileSync(path.join(nested, "victim.txt"), "utf8"), "external-sentinel");
	});

	it("discards a readlink result when the parent changes inside readlink", async () => {
		const parent = tempRoot("readlink-claim");
		const root = path.join(parent, "source");
		const nested = path.join(root, "nested");
		const detached = path.join(parent, "detached-original");
		const replacement = path.join(parent, "replacement");
		const destination = path.join(parent, "copy");
		const sentinel = path.join(parent, "EXTERNAL.txt");
		fs.mkdirSync(path.join(nested, "inside-dir"), { recursive: true });
		fs.writeFileSync(path.join(nested, "inside-dir", "inside.txt"), "inside");
		fs.symlinkSync(path.join(nested, "inside-dir"), path.join(nested, "link"), "junction");
		fs.mkdirSync(replacement);
		fs.writeFileSync(sentinel, "external-sentinel");
		fs.symlinkSync(parent, path.join(replacement, "link"), "junction");
		let swapped = false;
		const io: AsyncTreeFs = {
			...realAsyncTreeFs,
			async readlink(filePath) {
				if (!swapped && path.resolve(filePath) === path.resolve(path.join(nested, "link"))) {
					swapped = true;
					await fs.promises.rename(nested, detached);
					await fs.promises.rename(replacement, nested);
				}
				return realAsyncTreeFs.readlink(filePath);
			},
		};

		await assert.rejects(copyTree(root, destination, { fs: io, concurrency: 1 }), expectStale);

		assert.equal(swapped, true);
		assert.equal(fs.existsSync(path.join(destination, "nested", "link")), false);
		assert.equal(fs.readFileSync(sentinel, "utf8"), "external-sentinel");
	});

	it("never traverses a replacement installed inside opendir", async () => {
		const parent = tempRoot("opendir-quarantine");
		const root = path.join(parent, "claimed");
		const detached = path.join(parent, "detached-original");
		const replacement = path.join(parent, "replacement");
		fs.mkdirSync(root);
		fs.writeFileSync(path.join(root, "inside.txt"), "inside");
		fs.mkdirSync(replacement);
		fs.writeFileSync(path.join(replacement, "EXTERNAL.txt"), "external-sentinel");
		let racedPath = "";
		let destructiveCalls = 0;
		const io: AsyncTreeFs = {
			...realAsyncTreeFs,
			async opendir(dirPath) {
				if (!racedPath && isQuarantine(dirPath)) {
					racedPath = path.resolve(dirPath);
					await fs.promises.rename(dirPath, detached);
					await fs.promises.rename(replacement, dirPath);
				}
				return realAsyncTreeFs.opendir(dirPath);
			},
			async unlink(filePath) {
				destructiveCalls++;
				return realAsyncTreeFs.unlink(filePath);
			},
			async rmdir(dirPath) {
				destructiveCalls++;
				return realAsyncTreeFs.rmdir(dirPath);
			},
		};

		await assert.rejects(removeTree(root, { fs: io }), expectStale);

		assert.ok(racedPath);
		assert.equal(destructiveCalls, 0, "the replacement must fail identity validation before deletion");
		assert.equal(fs.readFileSync(path.join(racedPath, "EXTERNAL.txt"), "utf8"), "external-sentinel");
		assert.equal(fs.readFileSync(path.join(detached, "inside.txt"), "utf8"), "inside");
	});

	it("restores a replacement moved by a raced root detach", async () => {
		const parent = tempRoot("rename-quarantine");
		const root = path.join(parent, "claimed");
		const detached = path.join(parent, "detached-original");
		const replacement = path.join(parent, "replacement");
		fs.mkdirSync(root);
		fs.writeFileSync(path.join(root, "inside.txt"), "inside");
		fs.mkdirSync(replacement);
		fs.writeFileSync(path.join(replacement, "EXTERNAL.txt"), "external-sentinel");
		let raced = false;
		const io: AsyncTreeFs = {
			...realAsyncTreeFs,
			async rename(oldPath, newPath) {
				if (!raced && path.resolve(oldPath) === path.resolve(root)) {
					raced = true;
					await fs.promises.rename(root, detached);
					await fs.promises.rename(replacement, root);
				}
				return realAsyncTreeFs.rename(oldPath, newPath);
			},
		};

		await assert.rejects(removeTree(root, { fs: io }), expectStale);

		assert.equal(raced, true);
		assert.equal(fs.readFileSync(path.join(root, "EXTERNAL.txt"), "utf8"), "external-sentinel");
		assert.equal(fs.readFileSync(path.join(detached, "inside.txt"), "utf8"), "inside");
		assert.equal(fs.readdirSync(parent).some(name => name.startsWith(".bobbit-remove-")), false);
	});

	it("does not delete a replacement installed before unlink returns", async () => {
		const parent = tempRoot("unlink-quarantine");
		const root = path.join(parent, "claimed.txt");
		const replacement = path.join(parent, "replacement");
		fs.writeFileSync(root, "inside");
		fs.mkdirSync(replacement);
		fs.writeFileSync(path.join(replacement, "EXTERNAL.txt"), "external-sentinel");
		let racedPath = "";
		const io: AsyncTreeFs = {
			...realAsyncTreeFs,
			async unlink(filePath) {
				await realAsyncTreeFs.unlink(filePath);
				if (!racedPath && isQuarantine(filePath)) {
					racedPath = path.resolve(filePath);
					await fs.promises.rename(replacement, filePath);
				}
			},
		};

		await assert.rejects(removeTree(root, { fs: io }), expectStale);

		assert.ok(racedPath);
		assert.equal(fs.readFileSync(path.join(racedPath, "EXTERNAL.txt"), "utf8"), "external-sentinel");
	});

	it("does not delete a replacement installed before rmdir returns", async () => {
		const parent = tempRoot("rmdir-quarantine");
		const root = path.join(parent, "claimed");
		const replacement = path.join(parent, "replacement");
		fs.mkdirSync(root);
		fs.mkdirSync(replacement);
		fs.writeFileSync(path.join(replacement, "EXTERNAL.txt"), "external-sentinel");
		let racedPath = "";
		const io: AsyncTreeFs = {
			...realAsyncTreeFs,
			async rmdir(dirPath) {
				await realAsyncTreeFs.rmdir(dirPath);
				if (!racedPath && isQuarantine(dirPath)) {
					racedPath = path.resolve(dirPath);
					await fs.promises.rename(replacement, dirPath);
				}
			},
		};

		await assert.rejects(removeTree(root, { fs: io }), expectStale);

		assert.ok(racedPath);
		assert.equal(fs.readFileSync(path.join(racedPath, "EXTERNAL.txt"), "utf8"), "external-sentinel");
	});

	it("preserveRoot detaches authorized children but retains the claimed root", async () => {
		const parent = tempRoot("preserve-root");
		const root = path.join(parent, "claimed");
		fs.mkdirSync(root);
		fs.writeFileSync(path.join(root, "one.txt"), "one");
		fs.mkdirSync(path.join(root, "nested"));
		fs.writeFileSync(path.join(root, "nested", "two.txt"), "two");
		const renameSources: string[] = [];
		const io: AsyncTreeFs = {
			...realAsyncTreeFs,
			async rename(oldPath, newPath) {
				renameSources.push(path.resolve(oldPath));
				return realAsyncTreeFs.rename(oldPath, newPath);
			},
		};

		await removeTree(root, { fs: io, preserveRoot: true });

		assert.equal(fs.statSync(root).isDirectory(), true);
		assert.deepEqual(fs.readdirSync(root), []);
		assert.equal(renameSources.includes(path.resolve(root)), false, "the preserved root itself must never detach");
		assert.ok(renameSources.includes(path.resolve(path.join(root, "one.txt"))));
		assert.ok(renameSources.includes(path.resolve(path.join(root, "nested"))));
	});
});
