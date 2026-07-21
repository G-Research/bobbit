import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "vitest";
import {
	RECOVERY_IO_CONCURRENCY,
	type AsyncTreeDirent,
	type AsyncTreeDirectory,
	type AsyncTreeStats,
} from "../../src/server/agent/bounded-async-work.ts";
import { removeTargetedTree } from "../../src/server/skills/git.ts";

type NodeKind = "directory" | "file" | "symlink";

interface FakeNode {
	kind: NodeKind;
	children?: string[];
	target?: string;
}

function fakeStats(kind: NodeKind): AsyncTreeStats {
	return {
		isDirectory: () => kind === "directory",
		isFile: () => kind === "file",
		isSymbolicLink: () => kind === "symlink",
	};
}

function fakeDirent(name: string, kind: NodeKind): AsyncTreeDirent {
	return {
		name,
		isDirectory: () => kind === "directory",
		isFile: () => kind === "file",
		isSymbolicLink: () => kind === "symlink",
	};
}

function missing(filePath: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`missing ${filePath}`), { code: "ENOENT" });
}

/**
 * Models the exact race: the first lstat sees a directory, then opendir swaps
 * that pathname to a directory symlink and follows it to an external tree.
 * Child pathname operations also resolve through the substituted link, so the
 * vulnerable walker deterministically deletes the external sentinel.
 */
class SwapBeforeOpenFs {
	readonly target = path.resolve("/cleanup/target");
	readonly external = path.resolve("/external");
	readonly sentinel = path.join(this.external, "KEEP.txt");
	readonly calls: string[] = [];
	readonly nodes = new Map<string, FakeNode>([
		[this.target, { kind: "directory", children: [] }],
		[this.external, { kind: "directory", children: ["KEEP.txt"] }],
		[this.sentinel, { kind: "file" }],
	]);
	private swapped = false;

	private resolveParentLinks(filePath: string): string {
		const absolute = path.resolve(filePath);
		const targetNode = this.nodes.get(this.target);
		if (targetNode?.kind !== "symlink" || !targetNode.target) return absolute;
		const relative = path.relative(this.target, absolute);
		if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return absolute;
		return path.join(targetNode.target, relative);
	}

	private node(filePath: string): FakeNode {
		const resolved = this.resolveParentLinks(filePath);
		const node = this.nodes.get(resolved);
		if (!node) throw missing(resolved);
		return node;
	}

	async lstat(filePath: string): Promise<AsyncTreeStats> {
		const absolute = path.resolve(filePath);
		this.calls.push(`lstat:${absolute}`);
		return fakeStats(this.node(absolute).kind);
	}

	async opendir(dirPath: string): Promise<AsyncTreeDirectory> {
		const absolute = path.resolve(dirPath);
		this.calls.push(`opendir:${absolute}`);
		if (absolute === this.target && !this.swapped) {
			this.swapped = true;
			this.nodes.set(this.target, { kind: "symlink", target: this.external });
		}

		let openedPath = this.resolveParentLinks(absolute);
		const openedNode = this.nodes.get(openedPath);
		if (openedNode?.kind === "symlink" && openedNode.target) openedPath = openedNode.target;
		const directory = this.nodes.get(openedPath);
		if (directory?.kind !== "directory") throw new Error(`not a directory: ${openedPath}`);
		const entries = (directory.children ?? [])
			.map((name) => ({ name, node: this.nodes.get(path.join(openedPath, name)) }))
			.filter((entry): entry is { name: string; node: FakeNode } => entry.node !== undefined)
			.map((entry) => fakeDirent(entry.name, entry.node.kind));
		let cursor = 0;
		return {
			read: async () => {
				this.calls.push(`read:${openedPath}`);
				return entries[cursor++] ?? null;
			},
			close: async () => { this.calls.push(`close:${openedPath}`); },
		};
	}

	async unlink(filePath: string): Promise<void> {
		const absolute = path.resolve(filePath);
		const resolved = this.resolveParentLinks(absolute);
		this.calls.push(`unlink:${resolved}`);
		if (!this.nodes.delete(resolved)) throw missing(resolved);
	}

	async rmdir(dirPath: string): Promise<void> {
		const absolute = path.resolve(dirPath);
		const resolved = this.resolveParentLinks(absolute);
		this.calls.push(`rmdir:${resolved}`);
		if (!this.nodes.delete(resolved)) throw missing(resolved);
	}
}

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

describe("targeted Git cleanup symlink safety", () => {
	it("unlinks a directory replaced before opendir without deleting the external sentinel", async () => {
		const io = new SwapBeforeOpenFs();

		await removeTargetedTree(io.target, io);

		assert.equal(io.nodes.has(io.target), false, "the substituted symlink itself should be removed");
		assert.equal(io.nodes.has(io.external), true, "the external directory must remain");
		assert.equal(io.nodes.has(io.sentinel), true, "cleanup must never delete through the substituted symlink");
		assert.equal(io.calls.includes(`unlink:${io.sentinel}`), false);

		await removeTargetedTree(io.target, io);
		assert.equal(io.nodes.has(io.sentinel), true, "missing-target cleanup must remain idempotent");
	});

	it("retains the shared process-wide cleanup ceiling", async () => {
		const gate = new Deferred();
		let active = 0;
		let maxActive = 0;
		let started = 0;
		const io = {
			lstat: async (): Promise<AsyncTreeStats> => {
				started++;
				active++;
				maxActive = Math.max(maxActive, active);
				await gate.promise;
				active--;
				return fakeStats("file");
			},
			opendir: async (): Promise<AsyncTreeDirectory> => { throw new Error("unexpected opendir"); },
			unlink: async (): Promise<void> => {},
			rmdir: async (): Promise<void> => { throw new Error("unexpected rmdir"); },
		};
		const cleanup = Promise.all(Array.from(
			{ length: RECOVERY_IO_CONCURRENCY * 2 },
			(_, index) => removeTargetedTree(path.resolve(`/cleanup/${index}`), io),
		));

		await waitUntil(() => active === RECOVERY_IO_CONCURRENCY);
		assert.equal(started, RECOVERY_IO_CONCURRENCY, "later roots must wait for a cleanup slot");
		assert.equal(maxActive, RECOVERY_IO_CONCURRENCY);

		gate.resolve();
		await cleanup;
		assert.equal(started, RECOVERY_IO_CONCURRENCY * 2);
		assert.equal(maxActive, RECOVERY_IO_CONCURRENCY);
	});
});
