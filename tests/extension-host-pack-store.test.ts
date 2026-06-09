/**
 * Unit tests for Slice B1 — file-backed, pack-namespaced KV store
 * (src/server/extension-host/pack-store.ts), design
 * docs/design/extension-host-phase2.md §3.
 *
 * Pinned invariants (the cross-pack-denial guarantees behind `host.store.*`):
 *   - put/get/list round-trip, with values JSON-serialized under {v:1,value}.
 *   - Keys are physically namespaced under `<root>/ext-store/<packId>/`.
 *   - A SECOND pack CANNOT read the first pack's key (it can only name its own packId).
 *   - Key traversal (`../`, separators, illegal chars) is structurally impossible.
 *   - A non-pack caller (packId === "") is rejected.
 *   - The store endpoint guard order is: scoped guard → server-derived identity →
 *     non-pack rejection → store op (proven by the guard-ordering test).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPackStore, PackStoreQuotaError, DEFAULT_PACK_STORE_QUOTA, withStoreTimeout, PackStoreTimeoutError } from "../src/server/extension-host/pack-store.ts";

let rootDir: string;
before(() => {
	rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pack-store-test-"));
});
after(() => {
	try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("withStoreTimeout — bound a stuck store backend (design §3 B1.2)", () => {
	it("rejects a HUNG store op with PackStoreTimeoutError after the wall-time", async () => {
		const hung = new Promise<never>(() => { /* never settles */ });
		await assert.rejects(
			() => withStoreTimeout(hung, 25, "store get"),
			(e) => e instanceof PackStoreTimeoutError && /store get timed out after 25ms/.test((e as Error).message),
		);
	});

	it("resolves a fast op normally (no spurious timeout) and propagates rejections verbatim", async () => {
		assert.equal(await withStoreTimeout(Promise.resolve(42), 1000), 42);
		const boom = new Error("backend exploded");
		await assert.rejects(() => withStoreTimeout(Promise.reject(boom), 1000), (e) => e === boom);
	});
});

describe("createPackStore — round-trip + on-disk namespacing", () => {
	it("put/get round-trips arbitrary JSON values", async () => {
		const store = createPackStore({ rootDir });
		await store.put("pack-a", "prefs", { theme: "dark", n: 42 });
		assert.deepEqual(await store.get("pack-a", "prefs"), { theme: "dark", n: 42 });
		await store.put("pack-a", "flag", true);
		assert.equal(await store.get("pack-a", "flag"), true);
	});

	it("get → null for a missing key and for a corrupt file", async () => {
		const store = createPackStore({ rootDir });
		assert.equal(await store.get("pack-a", "never-written"), null);
		// Corrupt the on-disk file → get returns null (no throw).
		const dir = path.join(rootDir, "ext-store", "pack-a");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "corrupt.json"), "{not json");
		assert.equal(await store.get("pack-a", "corrupt"), null);
	});

	it("keys are physically stored under <root>/ext-store/<packId>/", async () => {
		const store = createPackStore({ rootDir });
		await store.put("pack-ns", "k1", 1);
		const dir = path.join(rootDir, "ext-store", "pack-ns");
		assert.ok(fs.existsSync(dir), "packId dir exists");
		const files = fs.readdirSync(dir);
		assert.equal(files.length, 1);
		assert.ok(files[0].endsWith(".json"));
	});

	it("list returns decoded keys filtered by prefix, sorted", async () => {
		const store = createPackStore({ rootDir });
		await store.put("pack-list", "alpha", 1);
		await store.put("pack-list", "alize", 2);
		await store.put("pack-list", "beta", 3);
		assert.deepEqual(await store.list("pack-list"), ["alize", "alpha", "beta"]);
		assert.deepEqual(await store.list("pack-list", "al"), ["alize", "alpha"]);
		assert.deepEqual(await store.list("pack-list", "z"), []);
	});

	it("list on a pack with no keys yet → []", async () => {
		const store = createPackStore({ rootDir });
		assert.deepEqual(await store.list("pack-empty"), []);
	});
});

describe("createPackStore — cross-pack read rejection (the security keystone)", () => {
	it("a SECOND pack cannot read the first pack's key", async () => {
		const store = createPackStore({ rootDir });
		await store.put("pack-one", "secret", "owned-by-one");
		// pack-two names the SAME key, but is scoped to its OWN packId dir → miss.
		assert.equal(await store.get("pack-two", "secret"), null);
		// pack-two's list never sees pack-one's keys.
		assert.deepEqual(await store.list("pack-two"), []);
		// pack-one still reads its own value.
		assert.equal(await store.get("pack-one", "secret"), "owned-by-one");
	});

	it("a key encoding that mentions another pack cannot escape the dir", async () => {
		const store = createPackStore({ rootDir });
		// Even a key literally containing another packId stays inside pack-x's dir.
		await store.put("pack-x", "pack-one/secret", "still-mine");
		assert.equal(await store.get("pack-x", "pack-one/secret"), "still-mine");
		// pack-one's real "secret" is untouched.
		const onePref = await store.get("pack-one", "secret");
		assert.notEqual(onePref, "still-mine");
	});
});

describe("createPackStore — key traversal is structurally impossible", () => {
	it("traversal-style keys are encoded into a single safe segment", async () => {
		const store = createPackStore({ rootDir });
		const evil = ["../../etc/passwd", "..", "../sibling", "a/b\\c", "*", "."];
		for (const key of evil) {
			await store.put("pack-trav", key, "x");
			assert.equal(await store.get("pack-trav", key), "x");
		}
		// Every key landed as a flat file inside the packId dir — nothing escaped.
		const dir = path.join(rootDir, "ext-store", "pack-trav");
		for (const name of fs.readdirSync(dir)) {
			assert.ok(!name.includes(path.sep), "no separator in stored filename");
			assert.ok(name.endsWith(".json"));
		}
		// No file was created outside the packId dir (e.g. no etc/ sibling).
		assert.ok(!fs.existsSync(path.join(rootDir, "ext-store", "etc")));
	});
});

describe("createPackStore — per-pack quotas (Fix C)", () => {
	it("rejects a single value larger than maxValueBytes (before writing)", async () => {
		const store = createPackStore({ rootDir, quota: { maxValueBytes: 64 } });
		const big = "x".repeat(200);
		await assert.rejects(() => store.put("pack-q1", "k", big), PackStoreQuotaError);
		await assert.rejects(() => store.put("pack-q1", "k", big), /too large/);
		// Nothing was written — the key does not exist.
		assert.equal(await store.get("pack-q1", "k"), null);
		assert.deepEqual(await store.list("pack-q1"), []);
	});

	it("rejects a NEW key once maxKeys is reached (overwrites of existing keys still allowed)", async () => {
		const store = createPackStore({ rootDir, quota: { maxKeys: 2 } });
		await store.put("pack-q2", "a", 1);
		await store.put("pack-q2", "b", 2);
		// A third DISTINCT key is rejected.
		await assert.rejects(() => store.put("pack-q2", "c", 3), /key limit/);
		// Overwriting an EXISTING key is still fine (not a new key).
		await store.put("pack-q2", "a", 99);
		assert.equal(await store.get("pack-q2", "a"), 99);
		assert.deepEqual(await store.list("pack-q2"), ["a", "b"]);
	});

	it("rejects a write that would exceed maxTotalBytes across the pack", async () => {
		// Each ~50-byte value; cap the pack at ~120 bytes so the third write overflows.
		const store = createPackStore({ rootDir, quota: { maxTotalBytes: 120, maxValueBytes: 1024 } });
		const val = "y".repeat(40);
		await store.put("pack-q3", "a", val);
		await store.put("pack-q3", "b", val);
		await assert.rejects(() => store.put("pack-q3", "c", val), /store full/);
		// Overwriting an existing key with a SMALLER value is allowed (frees space).
		await store.put("pack-q3", "a", "z");
		assert.equal(await store.get("pack-q3", "a"), "z");
	});

	it("default quota allows ordinary UI-state writes", async () => {
		assert.ok(DEFAULT_PACK_STORE_QUOTA.maxValueBytes >= 1024);
		const store = createPackStore({ rootDir });
		await store.put("pack-q4", "prefs", { theme: "dark", items: [1, 2, 3] });
		assert.deepEqual(await store.get("pack-q4", "prefs"), { theme: "dark", items: [1, 2, 3] });
	});
});

describe("createPackStore — concurrent put does NOT exceed quota (per-pack mutex)", () => {
	it("parallel NEW-key puts never exceed maxKeys", async () => {
		const store = createPackStore({ rootDir, quota: { maxKeys: 5, maxValueBytes: 1024, maxTotalBytes: 1024 * 1024 } });
		const pack = "pack-conc-keys";
		const results = await Promise.allSettled(
			Array.from({ length: 25 }, (_, i) => store.put(pack, `k${i}`, i)),
		);
		const ok = results.filter((r) => r.status === "fulfilled").length;
		const keys = await store.list(pack);
		assert.ok(keys.length <= 5, `key count ${keys.length} must not exceed maxKeys=5 under concurrency`);
		assert.equal(ok, keys.length, "exactly the fulfilled puts should be persisted (no over-admission)");
	});

	it("parallel puts never exceed maxTotalBytes", async () => {
		const val = "z".repeat(80); // ~95-byte envelope each
		const store = createPackStore({ rootDir, quota: { maxKeys: 1000, maxValueBytes: 1024, maxTotalBytes: 400 } });
		const pack = "pack-conc-bytes";
		await Promise.allSettled(Array.from({ length: 25 }, (_, i) => store.put(pack, `k${i}`, val)));
		const dir = path.join(rootDir, "ext-store", pack);
		let total = 0;
		for (const name of fs.readdirSync(dir)) {
			if (!name.endsWith(".json")) continue;
			total += fs.statSync(path.join(dir, name)).size;
		}
		assert.ok(total <= 400, `cumulative bytes ${total} must not exceed maxTotalBytes=400 under concurrency`);
	});
});

describe("createPackStore — atomic writes + corrupt-file quarantine", () => {
	it("leaves no temp files behind and keeps the value intact across overwrite", async () => {
		const store = createPackStore({ rootDir });
		const pack = "pack-atomic";
		await store.put(pack, "k", { a: 1 });
		await store.put(pack, "k", { a: 2 });
		assert.deepEqual(await store.get(pack, "k"), { a: 2 });
		const dir = path.join(rootDir, "ext-store", pack);
		const names = fs.readdirSync(dir);
		assert.equal(names.filter((n) => n.endsWith(".json")).length, 1, "exactly one .json key file");
		assert.equal(names.filter((n) => n.endsWith(".tmp")).length, 0, "no temp files left behind after an atomic write");
	});

	it("quarantines a corrupt file on get (moves it aside, returns null, list ignores it)", async () => {
		const store = createPackStore({ rootDir });
		const pack = "pack-corrupt";
		const dir = path.join(rootDir, "ext-store", pack);
		fs.mkdirSync(dir, { recursive: true });
		// encodeKey("bad") leaves alnum verbatim → "bad.json".
		const file = path.join(dir, "bad.json");
		fs.writeFileSync(file, "{ truncated json");
		assert.equal(await store.get(pack, "bad"), null, "corrupt JSON reads as null");
		assert.ok(!fs.existsSync(file), "the corrupt file is moved aside (quarantined), not left in place");
		const quarantined = fs.readdirSync(dir).filter((n) => n.includes(".corrupt-"));
		assert.equal(quarantined.length, 1, "a single quarantined copy exists for inspection");
		assert.deepEqual(await store.list(pack), [], "the quarantined file is not a .json key → list ignores it");
	});
});

describe("createPackStore — non-pack / invalid identity is rejected", () => {
	it("empty packId (a non-pack caller) is rejected on every op", async () => {
		const store = createPackStore({ rootDir });
		await assert.rejects(() => store.get("", "k"), /pack identity/);
		await assert.rejects(() => store.put("", "k", 1), /pack identity/);
		await assert.rejects(() => store.list(""), /pack identity/);
	});

	it("a packId carrying path separators or .. is rejected", async () => {
		const store = createPackStore({ rootDir });
		for (const bad of ["..", "a/b", "a\\b", "."]) {
			await assert.rejects(() => store.put(bad, "k", 1), /pack identity/);
		}
	});

	it("an empty key is rejected", async () => {
		const store = createPackStore({ rootDir });
		await assert.rejects(() => store.put("pack-a", "", 1), /non-empty/);
		await assert.rejects(() => store.get("pack-a", ""), /non-empty/);
	});
});
