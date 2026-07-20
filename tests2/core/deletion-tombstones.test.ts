import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
	deletionTombstoneFile,
	readAllDeletionTombstones,
	readDeletionTombstones,
	recordDeletionTombstone,
	recordDeletionTombstoneAsync,
} from "../../src/server/agent/deletion-tombstones.ts";
import { ColorStore } from "../../src/server/agent/color-store.ts";
import { sessionFileDelete, sessionSidecarDelete } from "../../src/server/agent/session-fs.ts";
import { sidecarPathFor } from "../../src/server/agent/session-sidecar.ts";
import { TeamStore, type PersistedTeamEntry } from "../../src/server/agent/team-store.ts";
import { installScopedMemFs, type NodeFs } from "./helpers/scoped-memfs.js";

const ROOT = path.resolve("/memfs/deletion-tombstones");
let fixtureSequence = 0;
let restoreFs: () => void;
let memoryFs: NodeFs;

beforeAll(() => {
	const scoped = installScopedMemFs(["existsSync", "mkdirSync", "readFileSync", "writeFileSync"]);
	restoreFs = scoped.restore;
	memoryFs = scoped.fs;
	memoryFs.mkdirSync(ROOT, { recursive: true });
});

afterAll(() => restoreFs());

function tmpDir(): string {
	const dir = path.join(ROOT, `case-${fixtureSequence++}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}

function deferredWriteFs() {
	const entered = deferred();
	const release = deferred();
	const promises = memoryFs.promises;
	let writes = 0;
	const fsImpl = {
		existsSync: memoryFs.existsSync.bind(memoryFs),
		mkdirSync: memoryFs.mkdirSync.bind(memoryFs),
		readFileSync: memoryFs.readFileSync.bind(memoryFs),
		writeFileSync: memoryFs.writeFileSync.bind(memoryFs),
		promises: {
			access: promises.access.bind(promises),
			mkdir: promises.mkdir.bind(promises),
			readFile: promises.readFile.bind(promises),
			writeFile: async (...args: any[]) => {
				writes++;
				if (writes === 1) {
					entered.resolve();
					await release.promise;
				}
				return (promises.writeFile as any).apply(promises, args);
			},
			unlink: promises.unlink.bind(promises),
		},
	} as any;
	return { fsImpl, entered: entered.promise, release: () => release.resolve(), writes: () => writes };
}

function teamEntry(goalId: string): PersistedTeamEntry {
	return { goalId, teamLeadSessionId: `lead-${goalId}`, agents: [], maxConcurrent: 3 };
}

describe("deletion tombstones", () => {
	it("records and reads back a tombstone", () => {
		const dir = tmpDir();
		recordDeletionTombstone(dir, "staff.json", "abc");
		assert.deepEqual([...readDeletionTombstones(dir, "staff.json")], ["abc"]);
		assert.equal(readDeletionTombstones(dir, "staff.json").has("abc"), true);
		// Shape is the pinned `{ "<fileName>": ["<key>"] }` map.
		assert.deepEqual(readAllDeletionTombstones(dir), { "staff.json": ["abc"] });
		assert.equal(fs.existsSync(deletionTombstoneFile(dir)), true);
	});

	it("is idempotent — recording the same key twice keeps a single entry", () => {
		const dir = tmpDir();
		recordDeletionTombstone(dir, "staff.json", "abc");
		recordDeletionTombstone(dir, "staff.json", "abc");
		assert.deepEqual(readAllDeletionTombstones(dir)["staff.json"], ["abc"]);
	});

	it("keeps per-file namespaces separate", () => {
		const dir = tmpDir();
		recordDeletionTombstone(dir, "staff.json", "a");
		recordDeletionTombstone(dir, "sessions.json", "b");
		recordDeletionTombstone(dir, "goals.json", "c");
		assert.deepEqual([...readDeletionTombstones(dir, "staff.json")], ["a"]);
		assert.deepEqual([...readDeletionTombstones(dir, "sessions.json")], ["b"]);
		assert.deepEqual([...readDeletionTombstones(dir, "goals.json")], ["c"]);
	});

	it("creates the state dir when it does not exist", () => {
		const parent = tmpDir();
		const dir = path.join(parent, "nested", "state");
		recordDeletionTombstone(dir, "staff.json", "x");
		assert.equal(fs.existsSync(deletionTombstoneFile(dir)), true);
		assert.deepEqual([...readDeletionTombstones(dir, "staff.json")], ["x"]);
	});

	it("returns empty for a missing file and tolerates a corrupt file", () => {
		const dir = tmpDir();
		assert.equal(readDeletionTombstones(dir, "staff.json").size, 0);
		assert.deepEqual(readAllDeletionTombstones(dir), {});
		fs.writeFileSync(deletionTombstoneFile(dir), "{ not valid json", "utf-8");
		assert.equal(readDeletionTombstones(dir, "staff.json").size, 0);
		assert.deepEqual(readAllDeletionTombstones(dir), {});
		// Recording after corruption recovers by overwriting with a valid file.
		recordDeletionTombstone(dir, "staff.json", "y");
		assert.deepEqual([...readDeletionTombstones(dir, "staff.json")], ["y"]);
	});

	it("ignores empty keys (no tombstone written)", () => {
		const dir = tmpDir();
		recordDeletionTombstone(dir, "staff.json", "");
		assert.equal(fs.existsSync(deletionTombstoneFile(dir)), false);
	});

	it("serializes deferred async writes and folds synchronous tombstones in call order", async () => {
		const dir = tmpDir();
		const deferredFs = deferredWriteFs();
		let settled = false;
		const first = recordDeletionTombstoneAsync(dir, "sessions.json", "async-a", deferredFs.fsImpl.promises)
			.then(() => { settled = true; });
		await deferredFs.entered;

		let eventLoopProgressed = false;
		await Promise.resolve().then(() => { eventLoopProgressed = true; });
		assert.equal(eventLoopProgressed, true);
		assert.equal(settled, false, "async tombstone must remain pending at deferred I/O");

		const second = recordDeletionTombstoneAsync(dir, "sessions.json", "async-b", deferredFs.fsImpl.promises);
		recordDeletionTombstone(dir, "sessions.json", "sync-c");
		deferredFs.release();
		await Promise.all([first, second]);

		assert.deepEqual(readAllDeletionTombstones(dir)["sessions.json"], ["async-a", "async-b", "sync-c"]);
		assert.equal(deferredFs.writes(), 2, "a mutation arriving during the held write gets a serialized follow-up write");
	});
});

describe("async purge leaf persistence", () => {
	it("ColorStore removeAsync folds a concurrent synchronous set into its durable drain", async () => {
		const dir = tmpDir();
		const deferredFs = deferredWriteFs();
		const store = new ColorStore(dir, deferredFs.fsImpl);
		store.set("remove-me", 1);

		const removal = store.removeAsync("remove-me");
		await deferredFs.entered;
		store.set("survivor", 2);
		deferredFs.release();
		await removal;

		const restored = new ColorStore(dir, memoryFs as any);
		assert.equal(restored.get("remove-me"), undefined);
		assert.equal(restored.get("survivor"), 2);
		assert.equal(deferredFs.writes(), 2);
	});

	it("TeamStore removeAsync preserves a synchronous put ordered behind deferred persistence", async () => {
		const dir = tmpDir();
		const deferredFs = deferredWriteFs();
		const store = new TeamStore(dir, deferredFs.fsImpl);
		store.put(teamEntry("remove-me"));

		const removal = store.removeAsync("remove-me");
		await deferredFs.entered;
		store.put(teamEntry("survivor"));
		deferredFs.release();
		await removal;

		const restored = new TeamStore(dir, memoryFs as any);
		assert.equal(restored.get("remove-me"), undefined);
		assert.equal(restored.get("survivor")?.teamLeadSessionId, "lead-survivor");
		assert.equal(deferredFs.writes(), 2);
	});

	it("session transcript and derived sidecar deletion yield at deferred async unlink", async () => {
		const dir = tmpDir();
		const transcript = path.join(dir, "trusted.jsonl");
		const sidecar = sidecarPathFor(transcript);
		memoryFs.writeFileSync(transcript, "{}\n", "utf-8");
		memoryFs.writeFileSync(sidecar, "{}", "utf-8");

		const entered = deferred();
		const release = deferred();
		const unlink = memoryFs.promises.unlink.bind(memoryFs.promises);
		let calls = 0;
		const deleteFs = {
			unlink: async (target: fs.PathLike) => {
				calls++;
				if (calls === 1) {
					entered.resolve();
					await release.promise;
				}
				await unlink(target);
			},
		};

		let settled = false;
		const transcriptDelete = sessionFileDelete({ sandboxed: false }, transcript, null, deleteFs)
			.then((result) => { settled = true; return result; });
		await entered.promise;
		await Promise.resolve();
		assert.equal(settled, false);
		release.resolve();
		assert.equal(await transcriptDelete, true);
		await sessionSidecarDelete(transcript, deleteFs);
		assert.equal(memoryFs.existsSync(transcript), false);
		assert.equal(memoryFs.existsSync(sidecar), false);
	});
});
