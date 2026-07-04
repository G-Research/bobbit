/**
 * Unit tests for the shared atomic-write primitives in
 * src/server/agent/atomic-json.ts (CON-01 fix).
 *
 * Covers the write discipline (tmp write -> fsync -> rename, .bak rotation)
 * and the load-time fallback (primary missing/corrupt -> newest parseable
 * .bak -> undefined) that gate-store / team-store / task-store / inbox-store
 * now share instead of each doing a truncating fs.writeFileSync with no
 * backup.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir } from "./helpers/tmp.ts";

import {
	atomicWriteJsonSync,
	loadJsonWithBackupFallback,
	rotateBackups,
	bakPath,
} from "../src/server/agent/atomic-json.ts";

const tmpRoot = makeTmpDir("atomic-json-");

afterEach(() => {
	// Clean the root between tests so each test gets a fresh dir tree.
	for (const entry of fs.readdirSync(tmpRoot)) {
		fs.rmSync(path.join(tmpRoot, entry), { recursive: true, force: true });
	}
});

function freshFile(label: string): string {
	const dir = fs.mkdtempSync(path.join(tmpRoot, `${label}-`));
	return path.join(dir, "data.json");
}

describe("atomicWriteJsonSync", () => {
	it("writes JSON that round-trips and leaves no stray .tmp file", () => {
		const file = freshFile("basic");
		atomicWriteJsonSync(file, { hello: "world" }, { backups: 3 });

		assert.ok(fs.existsSync(file));
		assert.ok(!fs.existsSync(`${file}.tmp`), "no stray .tmp after a successful write");
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), { hello: "world" });
	});

	it("creates the parent directory if missing", () => {
		const dir = fs.mkdtempSync(path.join(tmpRoot, "mkdir-"));
		const nested = path.join(dir, "nested", "sub", "data.json");
		atomicWriteJsonSync(nested, [1, 2, 3], { backups: 0 });
		assert.ok(fs.existsSync(nested));
		assert.deepEqual(JSON.parse(fs.readFileSync(nested, "utf-8")), [1, 2, 3]);
	});

	it("rotates up to N .bak generations, oldest dropped first", () => {
		const file = freshFile("rotate");
		atomicWriteJsonSync(file, { n: 1 }, { backups: 2 });
		atomicWriteJsonSync(file, { n: 2 }, { backups: 2 }); // .bak.1 <- {n:1}
		atomicWriteJsonSync(file, { n: 3 }, { backups: 2 }); // .bak.2 <- {n:1}, .bak.1 <- {n:2}

		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), { n: 3 });
		assert.deepEqual(JSON.parse(fs.readFileSync(bakPath(file, 1), "utf-8")), { n: 2 });
		assert.deepEqual(JSON.parse(fs.readFileSync(bakPath(file, 2), "utf-8")), { n: 1 });
	});

	it("a torn write (simulated kill mid-write) does not corrupt the prior good file, because rename is atomic", () => {
		const file = freshFile("torn");
		atomicWriteJsonSync(file, { good: true }, { backups: 1 });
		const before = fs.readFileSync(file, "utf-8");

		// Simulate a kill-9 between the tmp write and rename: write garbage
		// straight to the .tmp path and never rename it. The real (already
		// renamed) primary file must be untouched.
		fs.writeFileSync(`${file}.tmp`, "{not valid json", "utf-8");

		assert.equal(fs.readFileSync(file, "utf-8"), before, "primary file unchanged by a torn .tmp write");
		assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, "utf-8")));
	});

	it("does not write or rotate backups when backups is 0", () => {
		const file = freshFile("nobak");
		atomicWriteJsonSync(file, { a: 1 }, { backups: 0 });
		atomicWriteJsonSync(file, { a: 2 }, { backups: 0 });
		assert.ok(!fs.existsSync(bakPath(file, 1)));
	});
});

describe("rotateBackups", () => {
	it("is a no-op when the source file does not exist", () => {
		const file = freshFile("missing-rotate");
		assert.doesNotThrow(() => rotateBackups(file, 3));
		assert.ok(!fs.existsSync(bakPath(file, 1)));
	});
});

describe("loadJsonWithBackupFallback", () => {
	it("returns undefined when the file does not exist and there are no backups", () => {
		const file = freshFile("nofile");
		assert.equal(loadJsonWithBackupFallback(file, { backups: 3 }), undefined);
	});

	it("(a) reads the primary file when it parses cleanly", () => {
		const file = freshFile("clean");
		atomicWriteJsonSync(file, { ok: true }, { backups: 2 });
		const data = loadJsonWithBackupFallback<{ ok: boolean }>(file, { backups: 2 });
		assert.deepEqual(data, { ok: true });
	});

	it("(b) corrupt primary + valid .bak -> recovers from the newest parseable backup", () => {
		const file = freshFile("corrupt-with-bak");
		atomicWriteJsonSync(file, { version: 1 }, { backups: 2 }); // no .bak yet
		atomicWriteJsonSync(file, { version: 2 }, { backups: 2 }); // .bak.1 <- {version:1}

		// Corrupt the primary in place (simulating a torn write that DID land
		// on the real path, e.g. a non-atomic writeFileSync interrupted mid-flush).
		fs.writeFileSync(file, "{ this is not valid json", "utf-8");

		const usedBackups: string[] = [];
		const data = loadJsonWithBackupFallback<{ version: number }>(file, {
			backups: 2,
			onBackupUsed: (f) => usedBackups.push(f),
		});

		assert.deepEqual(data, { version: 1 }, "recovered the most recent valid backup, not an empty store");
		assert.deepEqual(usedBackups, [bakPath(file, 1)]);
	});

	it("(b) primary missing entirely + valid .bak -> recovers from backup", () => {
		const file = freshFile("missing-with-bak");
		atomicWriteJsonSync(file, { version: 1 }, { backups: 2 });
		atomicWriteJsonSync(file, { version: 2 }, { backups: 2 });
		fs.unlinkSync(file);

		const data = loadJsonWithBackupFallback<{ version: number }>(file, { backups: 2 });
		assert.deepEqual(data, { version: 1 });
	});

	it("(b) falls through to the second backup when the first is also corrupt", () => {
		const file = freshFile("skip-bad-bak");
		atomicWriteJsonSync(file, { version: 1 }, { backups: 2 }); // becomes .bak.2 eventually
		atomicWriteJsonSync(file, { version: 2 }, { backups: 2 }); // .bak.1 <- v1
		atomicWriteJsonSync(file, { version: 3 }, { backups: 2 }); // .bak.2 <- v1, .bak.1 <- v2

		fs.writeFileSync(file, "not json", "utf-8");
		fs.writeFileSync(bakPath(file, 1), "also not json", "utf-8");

		const data = loadJsonWithBackupFallback<{ version: number }>(file, { backups: 2 });
		assert.deepEqual(data, { version: 1 }, "skipped corrupt primary AND corrupt .bak.1, landed on valid .bak.2");
	});

	it("(c) corrupt primary with no backups configured -> returns undefined (current start-empty behavior)", () => {
		const file = freshFile("corrupt-no-bak");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "{ not valid", "utf-8");

		const data = loadJsonWithBackupFallback(file, { backups: 0 });
		assert.equal(data, undefined);
	});

	it("(c) corrupt primary with backups configured but none present on disk -> returns undefined", () => {
		const file = freshFile("corrupt-no-bak-file");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "{ not valid", "utf-8");

		const data = loadJsonWithBackupFallback(file, { backups: 3 });
		assert.equal(data, undefined);
	});
});
