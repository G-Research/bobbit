import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";
import {
	BACKGROUND_IO_CONCURRENCY,
	RECOVERY_IO_CONCURRENCY,
	copyTree,
	listTreeFiles,
	processDynamicQueue,
	readFileInChunks,
	removeTree,
	walkTree,
	type AsyncTreeDirent,
	type AsyncTreeDirectory,
	type AsyncTreeFileHandle,
	type AsyncTreeFs,
	type AsyncTreeStats,
} from "../../src/server/agent/bounded-async-work.ts";

class Deferred {
	readonly promise: Promise<void>;
	private resolvePromise!: () => void;

	constructor() {
		this.promise = new Promise((resolve) => { this.resolvePromise = resolve; });
	}

	resolve(): void {
		this.resolvePromise();
	}
}

async function waitUntil(predicate: () => boolean, attempts = 1_000): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("condition did not become true");
}

type FakeKind = "directory" | "file" | "symlink";

interface FakeNode {
	kind: FakeKind;
	id: number;
	mode?: number;
	children?: string[];
	content?: Uint8Array;
	linkTarget?: string;
}

function stats(node: FakeNode): AsyncTreeStats {
	return {
		atime: new Date(1_000),
		mtime: new Date(2_000),
		dev: 1,
		ino: node.id,
		mode: node.mode ?? 0o644,
		isDirectory: () => node.kind === "directory",
		isFile: () => node.kind === "file",
		isSymbolicLink: () => node.kind === "symlink",
	};
}

function dirent(name: string, kind: FakeKind): AsyncTreeDirent {
	return {
		name,
		isDirectory: () => kind === "directory",
		isFile: () => kind === "file",
		isSymbolicLink: () => kind === "symlink",
	};
}

class FakeTreeFs implements AsyncTreeFs {
	readonly nodes = new Map<string, FakeNode>();
	readonly calls: string[] = [];
	active = 0;
	maxActive = 0;
	deferLstatBelowRoot: Deferred | undefined;
	substituteFileAtOpen: { source: string; target: string; done?: boolean } | undefined;
	root = path.resolve("/tree");
	private nextId = 1;

	private async io<T>(label: string, operation: () => T | Promise<T>): Promise<T> {
		this.calls.push(label);
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		try {
			return await operation();
		} finally {
			this.active--;
		}
	}

	private node(filePath: string): FakeNode {
		const node = this.nodes.get(path.resolve(filePath));
		if (!node) {
			const error = new Error(`missing ${filePath}`) as NodeJS.ErrnoException;
			error.code = "ENOENT";
			throw error;
		}
		return node;
	}

	directory(filePath: string, children: string[]): this {
		this.nodes.set(path.resolve(filePath), { kind: "directory", id: this.nextId++, children });
		return this;
	}

	file(filePath: string, content = new Uint8Array()): this {
		this.nodes.set(path.resolve(filePath), { kind: "file", id: this.nextId++, mode: 0o640, content });
		return this;
	}

	symlinkNode(filePath: string, target: string): this {
		this.nodes.set(path.resolve(filePath), { kind: "symlink", id: this.nextId++, linkTarget: target });
		return this;
	}

	async lstat(filePath: string): Promise<AsyncTreeStats> {
		return this.io(`lstat:${path.resolve(filePath)}`, async () => {
			if (this.deferLstatBelowRoot && path.resolve(filePath) !== this.root) {
				await this.deferLstatBelowRoot.promise;
			}
			return stats(this.node(filePath));
		});
	}

	async opendir(dirPath: string): Promise<AsyncTreeDirectory> {
		return this.io(`opendir:${path.resolve(dirPath)}`, () => {
			const absolute = path.resolve(dirPath);
			const node = this.node(absolute);
			if (node.kind !== "directory") throw new Error(`opendir followed non-directory ${absolute}`);
			const entries = (node.children ?? []).map((name) => {
				const child = this.node(path.join(absolute, name));
				return dirent(name, child.kind);
			});
			let cursor = 0;
			let closed = false;
			return {
				read: async () => this.io(`read:${absolute}`, () => entries[cursor++] ?? null),
				close: async () => this.io(`close:${absolute}`, () => { closed = true; }),
				get closed() { return closed; },
			};
		});
	}

	async mkdir(dirPath: string, options: { recursive: boolean }): Promise<void> {
		await this.io(`mkdir:${path.resolve(dirPath)}:${String(options.recursive)}`, () => {
			const absolute = path.resolve(dirPath);
			if (!options.recursive && this.nodes.has(absolute)) {
				const error = new Error("exists") as NodeJS.ErrnoException;
				error.code = "EEXIST";
				throw error;
			}
			this.nodes.set(absolute, { kind: "directory", id: this.nextId++, children: [] });
		});
	}

	async copyFile(source: string, destination: string, _mode?: number): Promise<void> {
		await this.io(`copy:${path.resolve(source)}->${path.resolve(destination)}`, () => {
			const sourceNode = this.node(source);
			this.nodes.set(path.resolve(destination), {
				kind: "file",
				id: this.nextId++,
				mode: sourceNode.mode,
				content: sourceNode.content ? Uint8Array.from(sourceNode.content) : new Uint8Array(),
			});
		});
	}

	async readlink(filePath: string): Promise<string> {
		return this.io(`readlink:${path.resolve(filePath)}`, () => this.node(filePath).linkTarget ?? "");
	}

	async symlink(target: string, filePath: string): Promise<void> {
		await this.io(`symlink:${target}->${path.resolve(filePath)}`, () => {
			this.nodes.set(path.resolve(filePath), { kind: "symlink", id: this.nextId++, linkTarget: target });
		});
	}

	async unlink(filePath: string): Promise<void> {
		await this.io(`unlink:${path.resolve(filePath)}`, () => { this.nodes.delete(path.resolve(filePath)); });
	}

	async rmdir(dirPath: string): Promise<void> {
		await this.io(`rmdir:${path.resolve(dirPath)}`, () => { this.nodes.delete(path.resolve(dirPath)); });
	}

	async utimes(filePath: string, _atime: Date, _mtime: Date): Promise<void> {
		await this.io(`utimes:${path.resolve(filePath)}`, () => { this.node(filePath); });
	}

	async realpath(filePath: string): Promise<string> {
		return this.io(`realpath:${path.resolve(filePath)}`, () => {
			const absolute = path.resolve(filePath);
			const parsed = path.parse(absolute);
			let current = parsed.root;
			for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
				const candidate = path.join(current, segment);
				const node = this.node(candidate);
				current = node.kind === "symlink"
					? path.resolve(path.dirname(candidate), node.linkTarget ?? "")
					: candidate;
			}
			return current;
		});
	}

	async open(filePath: string, flags: string | number, mode?: number): Promise<AsyncTreeFileHandle> {
		return this.io(`open:${path.resolve(filePath)}`, () => {
			const absolute = path.resolve(filePath);
			if (this.substituteFileAtOpen
				&& !this.substituteFileAtOpen.done
				&& absolute === path.resolve(this.substituteFileAtOpen.source)) {
				this.substituteFileAtOpen.done = true;
				this.nodes.set(absolute, {
					kind: "symlink",
					id: this.nextId++,
					linkTarget: path.resolve(this.substituteFileAtOpen.target),
				});
			}

			const numericFlags = typeof flags === "number" ? flags : 0;
			const creating = typeof flags === "string"
				? flags.includes("w") || flags.includes("a")
				: (numericFlags & fs.constants.O_CREAT) !== 0;
			const exclusive = typeof flags === "string"
				? flags.includes("x")
				: (numericFlags & fs.constants.O_EXCL) !== 0;
			let openedPath = absolute;
			let openedNode: FakeNode;
			if (creating) {
				if (exclusive && this.nodes.has(absolute)) {
					const error = new Error("exists") as NodeJS.ErrnoException;
					error.code = "EEXIST";
					throw error;
				}
				openedNode = { kind: "file", id: this.nextId++, mode: mode ?? 0o666, content: new Uint8Array() };
				this.nodes.set(absolute, openedNode);
			} else {
				openedNode = this.node(absolute);
				if (openedNode.kind === "symlink") {
					const noFollow = (fs.constants as Record<string, number | undefined>).O_NOFOLLOW;
					if (typeof noFollow === "number" && noFollow !== 0 && (numericFlags & noFollow) !== 0) {
						const error = new Error("symlink") as NodeJS.ErrnoException;
						error.code = "ELOOP";
						throw error;
					}
					openedPath = path.resolve(path.dirname(absolute), openedNode.linkTarget ?? "");
					openedNode = this.node(openedPath);
				}
			}

			return {
				read: async (buffer, offset, length, position) => this.io(`file-read:${position}:${length}`, () => {
					const content = openedNode.content ?? new Uint8Array();
					const bytesRead = Math.min(length, Math.max(0, content.length - position));
					buffer.set(content.subarray(position, position + bytesRead), offset);
					return { bytesRead };
				}),
				write: async (buffer, offset, length, position) => this.io(`file-write:${position}:${length}`, () => {
					const prior = openedNode.content ?? new Uint8Array();
					const content = new Uint8Array(Math.max(prior.length, position + length));
					content.set(prior);
					content.set(buffer.subarray(offset, offset + length), position);
					openedNode.content = content;
					return { bytesWritten: length };
				}),
				stat: async () => this.io(`file-stat:${openedPath}`, () => stats(openedNode)),
				chmod: async newMode => this.io(`file-chmod:${openedPath}`, () => { openedNode.mode = newMode; }),
				close: async () => this.io(`file-close:${openedPath}`, () => {}),
			};
		});
	}
}

describe("bounded async work", () => {
	it("keeps the recovery ceiling alias while exposing the shared background ceiling", () => {
		assert.equal(BACKGROUND_IO_CONCURRENCY, 8);
		assert.equal(RECOVERY_IO_CONCURRENCY, BACKGROUND_IO_CONCURRENCY);
	});

	it("bounds dynamic workers and queue growth while deferred I/O yields the event loop", async () => {
		const gate = new Deferred();
		const processed: number[] = [];
		const retained: number[] = [];
		let active = 0;
		let maxActive = 0;
		let rejectedOffers = 0;
		let timerRan = false;

		const operation = processDynamicQueue([0], 3, async (item, queue) => {
			const local = [item];
			if (item === 0) {
				for (let child = 1; child <= 20; child++) {
					if (!queue.tryEnqueue(child)) {
						rejectedOffers++;
						local.push(child);
					}
				}
			}
			for (const current of local) {
				active++;
				maxActive = Math.max(maxActive, active);
				await gate.promise;
				active--;
				processed.push(current);
				if (current !== item) retained.push(current);
			}
		}, { maxQueued: 2 });

		setImmediate(() => { timerRan = true; });
		await waitUntil(() => active === 3 && timerRan);
		assert.equal(maxActive, 3);
		assert.ok(rejectedOffers > 0, "the fixed pending queue must apply backpressure");

		gate.resolve();
		await operation;
		assert.deepEqual([...processed].sort((a, b) => a - b), Array.from({ length: 21 }, (_, index) => index));
		assert.ok(retained.length > 0, "the worker must retain and iteratively process rejected offers");
		assert.ok(maxActive <= 3);
	});

	it("walks a deep tree iteratively, sorts files, and never traverses a symlink", async () => {
		const tree = new FakeTreeFs();
		const root = tree.root;
		const depth = 1_000;
		let current = root;
		for (let index = 0; index < depth; index++) {
			const childName = `d${index}`;
			tree.directory(current, [childName]);
			current = path.join(current, childName);
		}
		tree.directory(current, ["z.txt", "a.txt", "escape"])
			.file(path.join(current, "z.txt"), Uint8Array.of(3))
			.file(path.join(current, "a.txt"), Uint8Array.of(1))
			.symlinkNode(path.join(current, "escape"), path.resolve("/outside"))
			.directory(path.resolve("/outside"), ["secret.txt"])
			.file(path.resolve("/outside/secret.txt"), Uint8Array.of(9));

		let timerRan = false;
		setImmediate(() => { timerRan = true; });
		const files = await listTreeFiles(root, { concurrency: 3, fs: tree });

		assert.equal(timerRan, true, "a deep all-resolved fake traversal must cooperatively yield");
		assert.equal(files.length, 2);
		assert.ok(files[0]!.endsWith("/a.txt"));
		assert.ok(files[1]!.endsWith("/z.txt"));
		assert.equal(tree.calls.includes(`opendir:${path.resolve("/outside")}`), false);
		assert.equal(tree.calls.includes(`opendir:${path.join(current, "escape")}`), false);
		assert.ok(tree.maxActive <= 3);
	});

	it("caps wide deferred traversal at the injected operation-level limit", async () => {
		const tree = new FakeTreeFs();
		const root = tree.root;
		const names = Array.from({ length: 30 }, (_, index) => `${index}.txt`);
		tree.directory(root, names);
		for (const name of names) tree.file(path.join(root, name));
		const gate = new Deferred();
		tree.deferLstatBelowRoot = gate;

		const visited: string[] = [];
		const traversal = walkTree(root, (entry) => { visited.push(entry.relativePath); }, {
			concurrency: 2,
			fs: tree,
		});
		await waitUntil(() => tree.active === 2);
		assert.equal(tree.maxActive, 2);
		assert.equal(visited.length, 1, "child visits remain pending behind deferred lstat");

		gate.resolve();
		await traversal;
		assert.equal(visited.length, names.length + 1);
		assert.ok(tree.maxActive <= 2);
	});

	it("streams fixed-size chunks without retaining the file body", async () => {
		const tree = new FakeTreeFs();
		const filePath = path.join(tree.root, "large.bin");
		const content = Uint8Array.from({ length: 1_025 }, (_, index) => index % 251);
		tree.file(filePath, content);
		const lengths: number[] = [];
		let sum = 0;
		await readFileInChunks(filePath, (chunk) => {
			lengths.push(chunk.length);
			for (const byte of chunk) sum += byte;
		}, { fs: tree, chunkSize: 64 });

		assert.equal(Math.max(...lengths), 64);
		assert.equal(lengths.length, Math.ceil(content.length / 64));
		assert.equal(sum, content.reduce((total, byte) => total + byte, 0));
		assert.ok(tree.calls.includes(`file-read:${content.length}:64`), "the terminal bounded read must observe EOF");
		assert.ok(tree.calls.includes(`file-close:${path.resolve(filePath)}`));
	});

	it("copies links as links and removes them without opening their targets", async () => {
		const tree = new FakeTreeFs();
		const source = tree.root;
		const nested = path.join(source, "nested");
		const link = path.join(source, "escape");
		const destination = path.resolve("/copy");
		tree.directory(source, ["nested", "escape"])
			.directory(nested, ["file.txt"])
			.file(path.join(nested, "file.txt"), Uint8Array.of(1, 2, 3))
			.symlinkNode(link, path.resolve("/outside"))
			.directory(path.resolve("/outside"), ["secret"])
			.file(path.resolve("/outside/secret"), Uint8Array.of(9));

		await copyTree(source, destination, { concurrency: 2, fs: tree });
		assert.equal(tree.nodes.get(path.join(destination, "escape"))?.kind, "symlink");
		assert.deepEqual(tree.nodes.get(path.join(destination, "nested/file.txt"))?.content, Uint8Array.of(1, 2, 3));
		assert.equal(tree.calls.includes(`opendir:${path.resolve("/outside")}`), false);

		tree.calls.length = 0;
		await removeTree(source, { fs: tree });
		assert.ok(tree.calls.includes(`unlink:${link}`));
		assert.equal(tree.calls.includes(`opendir:${link}`), false);
		assert.equal(tree.calls.includes(`opendir:${path.resolve("/outside")}`), false);
		const childRmdir = tree.calls.indexOf(`rmdir:${nested}`);
		const rootRmdir = tree.calls.indexOf(`rmdir:${source}`);
		assert.ok(childRmdir >= 0 && rootRmdir > childRmdir, "directories must be deleted post-order");

		await removeTree(source, { fs: tree });
	});

	it("does not copy external bytes when a shared-copy source becomes a symlink at open", async () => {
		const tree = new FakeTreeFs();
		const source = tree.root;
		const sourceFile = path.join(source, "victim.txt");
		const outsideFile = path.resolve("/outside/secret.txt");
		const destination = path.resolve("/copy-race");
		tree.directory(source, ["victim.txt"])
			.file(sourceFile, Uint8Array.of(1, 2, 3))
			.directory(path.dirname(outsideFile), [path.basename(outsideFile)])
			.file(outsideFile, Uint8Array.of(9, 9, 9));
		tree.substituteFileAtOpen = { source: sourceFile, target: outsideFile };

		await assert.rejects(copyTree(source, destination, { concurrency: 1, fs: tree }), /regular file|symlink/i);

		assert.equal(tree.nodes.has(path.join(destination, "victim.txt")), false);
		assert.deepEqual(tree.nodes.get(outsideFile)?.content, Uint8Array.of(9, 9, 9));
		assert.equal(tree.calls.some(call => call.startsWith("file-read:")), false, "the followed descriptor must be rejected before reading");
	});
});
