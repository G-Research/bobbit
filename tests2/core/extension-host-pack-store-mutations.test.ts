import { describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPackStore } from "../../src/server/extension-host/pack-store.ts";

function fixture() {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pack-store-mutation-"));
	return {
		rootDir,
		store: createPackStore({ rootDir }),
		cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }),
	};
}

describe("PackStore.mutate — GF-03/GF-04 typed transactional fencing", () => {
	it("commits a versioned value once and replays an immediate idempotent retry without a second commit", async () => {
		const f = fixture();
		try {
			const first = await f.store.mutate("foundation", "record", { revision: 1 }, {
				expectedVersion: null,
				idempotencyKey: "request-1",
			});
			assert.deepEqual(first, { status: "committed", committed: true, value: { revision: 1 }, version: 1 });
			assert.deepEqual(await f.store.read("foundation", "record"), { state: "present", value: { revision: 1 }, version: 1 });

			const replay = await f.store.mutate("foundation", "record", { revision: 1 }, {
				expectedVersion: null,
				idempotencyKey: "request-1",
			});
			assert.deepEqual(replay, { status: "replayed", committed: false, value: { revision: 1 }, version: 1 });

			const mismatch = await f.store.mutate("foundation", "record", { revision: 2 }, { idempotencyKey: "request-1" });
			assert.deepEqual(mismatch, {
				status: "conflict",
				committed: false,
				diagnostic: { code: "STORE_MUTATION_IDEMPOTENCY_MISMATCH", retryable: false },
			});
			assert.deepEqual(await f.store.get("foundation", "record"), { revision: 1 });
		} finally { f.cleanup(); }
	});

	it("serializes same-key expected-version contenders and reports the loser as a non-committed conflict", async () => {
		const f = fixture();
		try {
			const initial = await f.store.mutate("foundation", "record", "one", { expectedVersion: null });
			assert.equal(initial.status, "committed");
			const [left, right] = await Promise.all([
				f.store.mutate("foundation", "record", "left", { expectedVersion: 1, idempotencyKey: "left" }),
				f.store.mutate("foundation", "record", "right", { expectedVersion: 1, idempotencyKey: "right" }),
			]);
			const outcomes = [left, right];
			assert.equal(outcomes.filter((outcome) => outcome.status === "committed").length, 1);
			assert.equal(outcomes.filter((outcome) => outcome.status === "conflict" && outcome.committed === false).length, 1);
			const persisted = await f.store.read<string>("foundation", "record");
			assert.equal(persisted.state, "present");
			if (persisted.state === "present") assert.equal(persisted.version, 2);
		} finally { f.cleanup(); }
	});

	it("rejects invalid/quota preflight before changing the durable value", async () => {
		const f = fixture();
		try {
			await f.store.put("foundation", "record", "safe");
			const cyclic: { self?: unknown } = {};
			cyclic.self = cyclic;
			const invalid = await f.store.mutate("foundation", "record", cyclic);
			assert.deepEqual(invalid, {
				status: "rejected",
				committed: false,
				diagnostic: { code: "STORE_MUTATION_INVALID", retryable: false },
			});
			const tooLarge = await createPackStore({ rootDir: f.rootDir, quota: { maxValueBytes: 32 } })
				.mutate("foundation", "record", "x".repeat(200));
			assert.deepEqual(tooLarge, {
				status: "rejected",
				committed: false,
				diagnostic: { code: "STORE_MUTATION_QUOTA_EXCEEDED", retryable: false },
			});
			assert.equal(await f.store.get("foundation", "record"), "safe");
		} finally { f.cleanup(); }
	});

	it("stops an abort that arrives after temporary durability but before rename, with no false committed outcome", async () => {
		const f = fixture();
		const originalOpen = fs.promises.open;
		try {
			await f.store.put("foundation", "record", "safe");
			const expired = await f.store.mutate("foundation", "record", "expired", { deadlineEpochMs: Date.now() - 1 });
			assert.deepEqual(expired, {
				status: "aborted",
				committed: false,
				diagnostic: { code: "STORE_MUTATION_DEADLINE_EXCEEDED", retryable: true },
			});
			assert.equal(await f.store.get("foundation", "record"), "safe");
			const controller = new AbortController();
			fs.promises.open = (async (file: fs.PathLike, flags: string | number, mode?: number) => {
				const handle = await originalOpen(file, flags, mode);
				const sync = handle.sync.bind(handle);
				(handle as unknown as { sync: () => Promise<void> }).sync = async () => {
					await sync();
					controller.abort();
				};
				return handle;
			}) as typeof fs.promises.open;
			const result = await f.store.mutate("foundation", "record", "late", { expectedVersion: 0, signal: controller.signal });
			assert.deepEqual(result, {
				status: "aborted",
				committed: false,
				diagnostic: { code: "STORE_MUTATION_ABORTED", retryable: false },
			});
			assert.equal(await f.store.get("foundation", "record"), "safe");
			assert.deepEqual(fs.readdirSync(path.join(f.rootDir, "ext-store", "foundation")).filter((name) => name.endsWith(".tmp")), []);
		} finally {
			fs.promises.open = originalOpen;
			f.cleanup();
		}
	});

	it("maps a write failure to a safe retryable result and preserves the prior value", async () => {
		const f = fixture();
		const originalRename = fs.promises.rename;
		try {
			await f.store.put("foundation", "record", "safe");
			fs.promises.rename = (async () => {
				const error = new Error("private path and backend text must not escape") as NodeJS.ErrnoException;
				error.code = "EIO";
				throw error;
			}) as typeof fs.promises.rename;
			const result = await f.store.mutate("foundation", "record", "unsafe", { expectedVersion: 0 });
			assert.deepEqual(result, {
				status: "error",
				committed: false,
				diagnostic: { code: "STORE_MUTATION_WRITE_FAILED", retryable: true },
			});
			assert.equal(await f.store.get("foundation", "record"), "safe");
		} finally {
			fs.promises.rename = originalRename;
			f.cleanup();
		}
	});

	it("does not label a create-if-absent conflict retryable", async () => {
		const f = fixture();
		try {
			await f.store.put("foundation", "record", "already-present");
			assert.deepEqual(await f.store.mutate("foundation", "record", "new", { expectedVersion: null }), {
				status: "conflict",
				committed: false,
				diagnostic: { code: "STORE_MUTATION_EXPECTED_VERSION_CONFLICT", retryable: false },
			});
		} finally { f.cleanup(); }
	});

	it("keeps versions monotonic when a legacy put follows a fenced mutation", async () => {
		const f = fixture();
		try {
			const first = await f.store.mutate("foundation", "record", "one");
			assert.equal(first.status, "committed");
			if (first.status === "committed") assert.equal(first.version, 1);
			await f.store.put("foundation", "record", "two");
			assert.deepEqual(await f.store.read("foundation", "record"), { state: "present", value: "two", version: 2 });
			assert.deepEqual(await f.store.mutate("foundation", "record", "three", { expectedVersion: 2 }), {
				status: "committed", committed: true, value: "three", version: 3,
			});
		} finally { f.cleanup(); }
	});

	it("re-checks an abort during a Windows replace retry and restores the old value", async () => {
		const f = fixture();
		const originalRename = fs.promises.rename;
		const controller = new AbortController();
		try {
			await f.store.put("foundation", "record", "safe");
			fs.promises.rename = (async (from: fs.PathLike, to: fs.PathLike) => {
				if (String(from).endsWith(".tmp") && String(to).endsWith("record.json")) {
					const error = new Error("simulated Windows lock") as NodeJS.ErrnoException;
					error.code = "EPERM";
					throw error;
				}
				return originalRename(from, to);
			}) as typeof fs.promises.rename;
			setTimeout(() => controller.abort(), 5);
			const result = await f.store.mutate("foundation", "record", "late", { signal: controller.signal });
			assert.deepEqual(result, {
				status: "aborted",
				committed: false,
				diagnostic: { code: "STORE_MUTATION_ABORTED", retryable: false },
			});
			assert.equal(await f.store.get("foundation", "record"), "safe");
			assert.deepEqual(fs.readdirSync(path.join(f.rootDir, "ext-store", "foundation")).filter((name) => name.endsWith(".tmp") || name.endsWith(".bak")), []);
		} finally {
			fs.promises.rename = originalRename;
			f.cleanup();
		}
	});
});
