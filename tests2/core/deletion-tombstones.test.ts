import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
	deletionTombstoneFile,
	readAllDeletionTombstones,
	readDeletionTombstones,
	recordDeletionTombstone,
} from "../../src/server/agent/deletion-tombstones.ts";
import { installScopedMemFs } from "./helpers/scoped-memfs.js";

const ROOT = path.resolve("/memfs/deletion-tombstones");
let fixtureSequence = 0;
let restoreFs: () => void;

beforeAll(() => {
	const scoped = installScopedMemFs(["existsSync", "mkdirSync", "readFileSync", "writeFileSync"]);
	restoreFs = scoped.restore;
	scoped.fs.mkdirSync(ROOT, { recursive: true });
});

afterAll(() => restoreFs());

function tmpDir(): string {
	const dir = path.join(ROOT, `case-${fixtureSequence++}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
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
});
