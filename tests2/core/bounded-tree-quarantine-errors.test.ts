import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFsFromVolume, Volume } from "memfs";
import { afterEach, describe, it, vi } from "vitest";
import {
	realAsyncTreeFs,
	removeTree,
	type AsyncTreeDirectory,
	type AsyncTreeFs,
	type AsyncTreeStats,
} from "../../src/server/agent/bounded-async-work.ts";
import { createPreviewAsyncFs } from "../../src/server/preview/mount.ts";

const cleanupRoots: string[] = [];

function tempRoot(label: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `bobbit-quarantine-${label}-`));
	cleanupRoots.push(root);
	return root;
}

function ioFailure(operation: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`injected ${operation} failure`), { code: "EIO" });
}

function isQuarantine(filePath: string): boolean {
	return path.basename(filePath).startsWith(".bobbit-remove-");
}

function quarantineEntries(root: string, io: typeof fs = fs): string[] {
	const found: string[] = [];
	const pending = [root];
	while (pending.length > 0) {
		const current = pending.pop()!;
		for (const entry of io.readdirSync(current, { withFileTypes: true })) {
			const child = path.join(current, entry.name);
			if (isQuarantine(child)) found.push(child);
			if (entry.isDirectory()) pending.push(child);
		}
	}
	return found;
}

type FailureOperation = "opendir" | "read" | "unlink" | "rmdir";
type FailureScope = "root" | "child";

interface FailureFixture {
	memoryFs: typeof fs;
	parent: string;
	root: string;
	child?: string;
	failure: NodeJS.ErrnoException;
	io: AsyncTreeFs;
	rootQuarantine(): string;
	childQuarantine(): string;
}

function makeFailureFixture(operation: FailureOperation, scope: FailureScope): FailureFixture {
	const memoryFs = createFsFromVolume(new Volume()) as unknown as typeof fs;
	const parent = path.resolve(`/memfs/quarantine-${scope}-${operation}`);
	memoryFs.mkdirSync(parent, { recursive: true });
	const base = createPreviewAsyncFs(memoryFs);
	const root = path.join(parent, "target");
	const child = scope === "child" ? path.join(root, "nested") : undefined;
	if (operation === "unlink") {
		if (scope === "root") memoryFs.writeFileSync(root, "root-visible");
		else {
			memoryFs.mkdirSync(root);
			memoryFs.writeFileSync(child!, "child-visible");
		}
	} else {
		memoryFs.mkdirSync(child ?? root, { recursive: true });
		// rmdir failures happen after a successful descendant deletion, proving a
		// partially cleaned directory is restored visibly rather than stranded.
		memoryFs.writeFileSync(path.join(child ?? root, "inside.txt"), "visible-before-failure");
	}

	const failure = ioFailure(`${scope} ${operation}`);
	let rootQuarantine = "";
	let childQuarantine = "";
	let injected = false;
	const targetQuarantine = (): string => scope === "root" ? rootQuarantine : childQuarantine;
	const shouldFail = (filePath: string): boolean => (
		!injected
		&& targetQuarantine() !== ""
		&& path.resolve(filePath) === path.resolve(targetQuarantine())
	);
	const io: AsyncTreeFs = {
		...base,
		readlink: filePath => memoryFs.promises.readlink(filePath),
		symlink: (target, filePath) => memoryFs.promises.symlink(target, filePath),
		rename: async (oldPath, newPath) => {
			await base.rename(oldPath, newPath);
			if (path.resolve(oldPath) === path.resolve(root)) rootQuarantine = path.resolve(newPath);
			else if (!childQuarantine && isQuarantine(newPath)) childQuarantine = path.resolve(newPath);
		},
		opendir: async dirPath => {
			if (operation === "opendir" && shouldFail(dirPath)) {
				injected = true;
				throw failure;
			}
			// memfs directory handles expose dynamically renamed entries unlike the
			// native test target. A snapshot keeps this fake Node-faithful.
			const entries = memoryFs.readdirSync(dirPath, { withFileTypes: true });
			let cursor = 0;
			const directory: AsyncTreeDirectory = {
				read: async () => entries[cursor++] ?? null,
				close: async () => {},
			};
			if (operation !== "read" || !shouldFail(dirPath)) return directory;
			return {
				read: async () => {
					if (!injected) {
						injected = true;
						throw failure;
					}
					return directory.read();
				},
				close: () => directory.close(),
			};
		},
		unlink: async filePath => {
			if (operation === "unlink" && shouldFail(filePath)) {
				injected = true;
				throw failure;
			}
			await base.unlink(filePath);
		},
		rmdir: async dirPath => {
			if (operation === "rmdir" && shouldFail(dirPath)) {
				injected = true;
				throw failure;
			}
			await base.rmdir(dirPath);
		},
	};
	return {
		memoryFs,
		parent,
		root,
		child,
		failure,
		io,
		rootQuarantine: () => rootQuarantine,
		childQuarantine: () => childQuarantine,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of cleanupRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("bounded tree quarantine failure restoration", () => {
	for (const scope of ["root", "child"] as const) {
		for (const operation of ["opendir", "read", "unlink", "rmdir"] as const) {
			it(`restores and retries a detached ${scope} after ${operation} fails`, async () => {
				const fixture = makeFailureFixture(operation, scope);
				await assert.rejects(
					removeTree(fixture.root, { fs: fixture.io }),
					(error: unknown) => error === fixture.failure,
				);

				assert.equal(fixture.memoryFs.existsSync(fixture.root), true, "the caller-visible root must be restored");
				if (scope === "child") {
					assert.equal(fixture.memoryFs.existsSync(fixture.child!), true, "the failed child must be restored before its root");
				}
				assert.deepEqual(quarantineEntries(fixture.parent, fixture.memoryFs), [], "successful restoration must not strand a quarantine");
				assert.equal((fixture.failure as { quarantinePath?: string }).quarantinePath, undefined);

				await removeTree(fixture.root, { fs: fixture.io });
				assert.equal(fixture.memoryFs.existsSync(fixture.root), false, "the restored partial tree must remain retryable");
				assert.deepEqual(quarantineEntries(fixture.parent, fixture.memoryFs), []);
			});
		}
	}

	it("does not overwrite a collision at the original path and reports the exact quarantine", async () => {
		const parent = tempRoot("collision");
		const root = path.join(parent, "target");
		fs.mkdirSync(root);
		fs.writeFileSync(path.join(root, "inside.txt"), "owned");
		const failure = ioFailure("opendir collision");
		let quarantine = "";
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const io: AsyncTreeFs = {
			...realAsyncTreeFs,
			rename: async (oldPath, newPath) => {
				await realAsyncTreeFs.rename(oldPath, newPath);
				if (path.resolve(oldPath) === path.resolve(root)) quarantine = path.resolve(newPath);
			},
			opendir: async dirPath => {
				if (quarantine && path.resolve(dirPath) === quarantine) {
					fs.mkdirSync(root);
					fs.writeFileSync(path.join(root, "EXTERNAL.txt"), "external-sentinel");
					throw failure;
				}
				return realAsyncTreeFs.opendir(dirPath);
			},
		};

		await assert.rejects(removeTree(root, { fs: io }), error => error === failure);

		assert.equal(fs.readFileSync(path.join(root, "EXTERNAL.txt"), "utf8"), "external-sentinel");
		assert.equal(fs.readFileSync(path.join(quarantine, "inside.txt"), "utf8"), "owned");
		assert.equal((failure as { quarantinePath?: string }).quarantinePath, quarantine);
		assert.equal(logged.mock.calls.some(call => String(call[0]).includes(quarantine)), true);
	});

	it("relocates retained quarantine context through a restored '..name' ancestor", async () => {
		const parent = tempRoot("nested-dot-name");
		const root = path.join(parent, "target");
		const dotName = path.join(root, "..name");
		const filePath = path.join(dotName, "inside.txt");
		fs.mkdirSync(dotName, { recursive: true });
		fs.writeFileSync(filePath, "owned");
		const failure = ioFailure("nested unlink");
		let rootQuarantine = "";
		let dotNameQuarantine = "";
		let fileQuarantine = "";
		let restoreDenied = false;
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const io: AsyncTreeFs = {
			...realAsyncTreeFs,
			rename: async (oldPath, newPath) => {
				const oldAbsolute = path.resolve(oldPath);
				const newAbsolute = path.resolve(newPath);
				if (fileQuarantine
					&& oldAbsolute === fileQuarantine
					&& newAbsolute === path.join(dotNameQuarantine, "inside.txt")) {
					restoreDenied = true;
					throw Object.assign(new Error("restore denied"), { code: "EACCES" });
				}
				await realAsyncTreeFs.rename(oldPath, newPath);
				if (oldAbsolute === path.resolve(root)) rootQuarantine = newAbsolute;
				else if (oldAbsolute === path.join(rootQuarantine, "..name")) dotNameQuarantine = newAbsolute;
				else if (oldAbsolute === path.join(dotNameQuarantine, "inside.txt")) fileQuarantine = newAbsolute;
			},
			unlink: async filePathToRemove => {
				if (fileQuarantine && path.resolve(filePathToRemove) === fileQuarantine) throw failure;
				await realAsyncTreeFs.unlink(filePathToRemove);
			},
		};

		await assert.rejects(removeTree(root, { fs: io }), error => error === failure);

		const retained = quarantineEntries(parent);
		assert.equal(restoreDenied, true);
		assert.equal(retained.length, 1);
		assert.equal(path.dirname(retained[0]!), dotName);
		assert.equal(fs.readFileSync(retained[0]!, "utf8"), "owned");
		assert.equal(fs.existsSync(fileQuarantine), false, "the pre-restoration quarantine path must move with its ancestors");
		assert.equal((failure as { quarantinePath?: string }).quarantinePath, retained[0]);
		assert.equal(logged.mock.calls.some(call => String(call[0]).includes(retained[0]!)), true);
	});

	it("preserves a mismatched quarantine identity without external deletion", async () => {
		const parent = tempRoot("mismatch");
		const root = path.join(parent, "target");
		const detachedOwned = path.join(parent, "detached-owned");
		const external = path.join(parent, "external");
		fs.mkdirSync(root);
		fs.writeFileSync(path.join(root, "inside.txt"), "owned");
		fs.mkdirSync(external);
		fs.writeFileSync(path.join(external, "KEEP.txt"), "external-sentinel");
		const failure = ioFailure("mismatched opendir");
		let quarantine = "";
		let destructiveCalls = 0;
		vi.spyOn(console, "error").mockImplementation(() => {});
		const io: AsyncTreeFs = {
			...realAsyncTreeFs,
			rename: async (oldPath, newPath) => {
				await realAsyncTreeFs.rename(oldPath, newPath);
				if (path.resolve(oldPath) === path.resolve(root)) quarantine = path.resolve(newPath);
			},
			opendir: async dirPath => {
				if (quarantine && path.resolve(dirPath) === quarantine) {
					await fs.promises.rename(quarantine, detachedOwned);
					await fs.promises.rename(external, quarantine);
					throw failure;
				}
				return realAsyncTreeFs.opendir(dirPath);
			},
			unlink: async filePath => { destructiveCalls++; await realAsyncTreeFs.unlink(filePath); },
			rmdir: async dirPath => { destructiveCalls++; await realAsyncTreeFs.rmdir(dirPath); },
		};

		await assert.rejects(removeTree(root, { fs: io }), error => error === failure);

		assert.equal(destructiveCalls, 0);
		assert.equal(fs.readFileSync(path.join(quarantine, "KEEP.txt"), "utf8"), "external-sentinel");
		assert.equal(fs.readFileSync(path.join(detachedOwned, "inside.txt"), "utf8"), "owned");
		assert.equal((failure as { quarantinePath?: string }).quarantinePath, quarantine);
	});

	it("preserves the original error when an exact quarantine cannot be renamed back", async () => {
		const parent = tempRoot("restore-denied");
		const root = path.join(parent, "target");
		fs.mkdirSync(root);
		const failure = ioFailure("root opendir");
		let quarantine = "";
		let restoreAttempted = false;
		vi.spyOn(console, "error").mockImplementation(() => {});
		const io: AsyncTreeFs = {
			...realAsyncTreeFs,
			rename: async (oldPath, newPath) => {
				if (quarantine
					&& path.resolve(oldPath) === quarantine
					&& path.resolve(newPath) === path.resolve(root)) {
					restoreAttempted = true;
					throw Object.assign(new Error("restore denied"), { code: "EACCES" });
				}
				await realAsyncTreeFs.rename(oldPath, newPath);
				if (path.resolve(oldPath) === path.resolve(root)) quarantine = path.resolve(newPath);
			},
			opendir: async dirPath => {
				if (quarantine && path.resolve(dirPath) === quarantine) throw failure;
				return realAsyncTreeFs.opendir(dirPath);
			},
		};

		await assert.rejects(removeTree(root, { fs: io }), error => error === failure);

		assert.equal(restoreAttempted, true);
		assert.equal(fs.statSync(quarantine).isDirectory(), true);
		assert.equal((failure as { quarantinePath?: string }).quarantinePath, quarantine);
	});

	it("treats a parent disappearing before setup as missing only with force", async () => {
		const root = path.resolve("/virtual/parent/target");
		const parent = path.dirname(root);
		const rootStats: AsyncTreeStats = {
			dev: 1,
			ino: 2,
			isDirectory: () => true,
			isFile: () => false,
			isSymbolicLink: () => false,
		};
		const parentMissing = Object.assign(new Error("parent disappeared"), { code: "ENOENT" });
		const io = {
			lstat: async (filePath: string): Promise<AsyncTreeStats> => {
				if (path.resolve(filePath) === root) return rootStats;
				if (path.resolve(filePath) === parent) throw parentMissing;
				throw Object.assign(new Error("unexpected path"), { code: "ENOENT" });
			},
			opendir: async (): Promise<AsyncTreeDirectory> => { throw new Error("unexpected opendir"); },
			rename: async (): Promise<void> => { throw new Error("unexpected rename"); },
			unlink: async (): Promise<void> => { throw new Error("unexpected unlink"); },
			rmdir: async (): Promise<void> => { throw new Error("unexpected rmdir"); },
		};

		await removeTree(root, { fs: io, force: true });
		await assert.rejects(removeTree(root, { fs: io, force: false }), error => error === parentMissing);
	});
});
