import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
/**
 * Regression coverage for the FlexSearch flush-on-close teardown race.
 *
 * Background: E2E teardown does `await gw.shutdown()` then `rm(bobbitDir)`.
 * If the search flush-on-close is fire-and-forget, the `rm` runs while a
 * debounced/`close()` flush is still writing into `search.flex/index/` and
 * the write fails with ENOENT (Windows: EPERM/EBUSY) — logged as
 * `[search] flex flush error`. The fix:
 *   1. `close()` awaits the in-flight + final flush, so callers can safely
 *      remove the dir only after the returned promise settles.
 *   2. `__doFlush()`/`writeMeta()` swallow ENOENT/EPERM/EBUSY *when closed*
 *      (benign teardown race) but still surface genuine open-store errors.
 *   3. The debounced `_scheduleSave` timer re-checks `_closed` before flushing.
 */
import { expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	FLEX_EXPORT_BUNDLE_FILE,
	FLEX_EXPORT_BUNDLE_VERSION,
	FlexSearchStore,
	type FlexDoc,
} from "../../../src/server/search/flex-store.ts";

function tmp(prefix = "flex-close-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function doc(overrides: Partial<FlexDoc> & { id: string; text: string }): FlexDoc {
	return {
		id: overrides.id,
		source_id: overrides.source_id ?? "messages",
		project_id: overrides.project_id ?? "p1",
		entity_type: overrides.entity_type ?? "message",
		parent_id: overrides.parent_id ?? null,
		archived: overrides.archived ?? false,
		archived_tag: (overrides.archived ? "true" : "false") as "true" | "false",
		timestamp: overrides.timestamp ?? 1_700_000_000_000,
		content_hash: overrides.content_hash ?? `${overrides.id}:h`,
		weight: overrides.weight ?? 1.0,
		role: overrides.role ?? null,
		title: overrides.title ?? null,
		text: overrides.text,
		identifier_text: overrides.identifier_text ?? "",
		goal_id: overrides.goal_id ?? null,
		session_id: overrides.session_id ?? null,
		session_title: overrides.session_title ?? null,
		file_path: overrides.file_path ?? null,
		start_line: overrides.start_line ?? null,
		end_line: overrides.end_line ?? null,
	};
}

test("close skips persistence when the store has no mutations", async () => {
	const dir = tmp();
	const store = await FlexSearchStore.open({ dataDir: dir });
	const internals = store as unknown as { _doFlush(): Promise<void> };
	const originalFlush = internals._doFlush.bind(store);
	let flushes = 0;
	internals._doFlush = async () => { flushes += 1; await originalFlush(); };
	try {
		await store.close();
		expect(flushes).toBe(0);
		expect(fs.existsSync(path.join(dir, "index", "__docs__.json"))).toBe(false);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("legacy per-key exports load and migrate to one versioned bundle on the next write", async () => {
	const dir = tmp();
	const store = await FlexSearchStore.open({ dataDir: dir });
	await store.upsert([doc({ id: "legacy", text: "legacy searchable text" })]);
	await store.close();
	const indexDir = path.join(dir, "index");
	const bundlePath = path.join(indexDir, FLEX_EXPORT_BUNDLE_FILE);
	const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8")) as { exports: Array<[string, unknown]> };
	fs.rmSync(bundlePath);
	for (const [key, data] of bundle.exports) {
		fs.writeFileSync(path.join(indexDir, `${encodeURIComponent(key)}.json`), JSON.stringify(data));
	}

	const legacy = await FlexSearchStore.open({ dataDir: dir });
	try {
		expect((await legacy.search({ q: "legacy", limit: 10 })).results.map((result) => result.id)).toContain("legacy");
		await legacy.upsert([doc({ id: "new", text: "new searchable text" })]);
	} finally {
		await legacy.close();
	}
	const migrated = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
	expect(migrated.version).toBe(FLEX_EXPORT_BUNDLE_VERSION);
	expect(Array.isArray(migrated.exports)).toBe(true);
	expect(fs.readdirSync(indexDir).filter((file) => file.endsWith(".json")).sort()).toEqual([
		"__docs__.json",
		FLEX_EXPORT_BUNDLE_FILE,
	].sort());
	const reopened = await FlexSearchStore.open({ dataDir: dir });
	try {
		expect((await reopened.search({ q: "searchable", limit: 10 })).results.map((result) => result.id).sort()).toEqual(["legacy", "new"]);
	} finally {
		await reopened.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("corrupt or partial export bundle rebuilds from the atomic docs mirror and repairs on close", async () => {
	for (const corrupt of ["{broken", JSON.stringify({ version: FLEX_EXPORT_BUNDLE_VERSION, exports: [] })]) {
		const dir = tmp();
		const store = await FlexSearchStore.open({ dataDir: dir });
		await store.upsert([doc({ id: "recover", text: "recover from mirror" })]);
		await store.close();
		const bundlePath = path.join(dir, "index", FLEX_EXPORT_BUNDLE_FILE);
		fs.writeFileSync(bundlePath, corrupt);
		const recovered = await FlexSearchStore.open({ dataDir: dir });
		try {
			expect((await recovered.search({ q: "recover", limit: 10 })).results.map((result) => result.id)).toContain("recover");
		} finally {
			await recovered.close();
		}
		const repaired = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
		expect(repaired.version).toBe(FLEX_EXPORT_BUNDLE_VERSION);
		expect(typeof repaired.docsHash).toBe("string");
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("atomic bundle rename failure is bounded and a later retry commits a coherent bundle", async () => {
	const dir = tmp();
	const store = await FlexSearchStore.open({ dataDir: dir });
	await store.upsert([doc({ id: "before", text: "before value" })]);
	await (store as unknown as { _flushNow(): Promise<void> })._flushNow();
	const bundlePath = path.join(dir, "index", FLEX_EXPORT_BUNDLE_FILE);
	const priorBundle = fs.readFileSync(bundlePath, "utf8");
	await store.upsert([doc({ id: "after", text: "after value" })]);
	const internals = store as unknown as {
		_saveTimer: ReturnType<typeof setTimeout> | null;
		_dirty: boolean;
		_atomicRename(src: string, dest: string): Promise<void>;
		_flushNow(): Promise<void>;
	};
	if (internals._saveTimer) clearTimeout(internals._saveTimer);
	internals._saveTimer = null;
	const realRename = internals._atomicRename.bind(store);
	let injected = false;
	internals._atomicRename = async (src, dest) => {
		if (!injected && dest === bundlePath) {
			injected = true;
			throw new Error("injected bundle rename failure");
		}
		await realRename(src, dest);
	};
	const errors: string[] = [];
	const originalError = console.error;
	console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
	try {
		await internals._flushNow();
		expect(internals._dirty).toBe(true);
		expect(fs.readFileSync(bundlePath, "utf8")).toBe(priorBundle);
		expect(errors.some((line) => line.includes("injected bundle rename failure"))).toBe(true);
		await internals._flushNow();
		expect(internals._dirty).toBe(false);
		const committed = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
		expect(committed.version).toBe(FLEX_EXPORT_BUNDLE_VERSION);
	} finally {
		console.error = originalError;
		await store.close();
	}
	const reopened = await FlexSearchStore.open({ dataDir: dir });
	try {
		expect((await reopened.search({ q: "after", limit: 10 })).results.map((result) => result.id)).toContain("after");
	} finally {
		await reopened.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("persistent flush failure returns once and a later explicit retry persists", async () => {
	const dir = tmp();
	const store = await FlexSearchStore.open({ dataDir: dir });
	await store.upsert([doc({ id: "retry", text: "persist after retry" })]);
	const internals = store as unknown as {
		_saveTimer: ReturnType<typeof setTimeout> | null;
		_dirty: boolean;
		_doFlush(): Promise<void>;
		_flushNow(): Promise<void>;
	};
	if (internals._saveTimer) clearTimeout(internals._saveTimer);
	internals._saveTimer = null;
	const realFlush = internals._doFlush.bind(store);
	let attempts = 0;
	internals._doFlush = async () => {
		attempts += 1;
		if (attempts === 1) throw new Error("injected persistent write failure");
		await realFlush();
	};
	const errors: string[] = [];
	const originalError = console.error;
	console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
	try {
		await Promise.race([
			internals._flushNow(),
			new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("flush retry loop")), 250)),
		]);
		expect(attempts).toBe(1);
		expect(internals._dirty).toBe(true);
		expect(errors.some((line) => line.includes("injected persistent write failure"))).toBe(true);

		await internals._flushNow();
		expect(attempts).toBe(2);
		expect(internals._dirty).toBe(false);
		expect(fs.existsSync(path.join(dir, "index", "__docs__.json"))).toBe(true);
	} finally {
		console.error = originalError;
		await store.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("mutation during an in-flight flush schedules one bounded follow-up flush", async () => {
	const dir = tmp();
	const store = await FlexSearchStore.open({ dataDir: dir });
	await store.upsert([doc({ id: "first", text: "first" })]);
	const internals = store as unknown as {
		_saveTimer: ReturnType<typeof setTimeout> | null;
		_doFlush(): Promise<void>;
		_flushNow(): Promise<void>;
	};
	if (internals._saveTimer) clearTimeout(internals._saveTimer);
	internals._saveTimer = null;
	const realFlush = internals._doFlush.bind(store);
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => { release = resolve; });
	let attempts = 0;
	internals._doFlush = async () => {
		attempts += 1;
		if (attempts === 1) await blocked;
		await realFlush();
	};
	try {
		const flushing = internals._flushNow();
		await Promise.resolve();
		await store.upsert([doc({ id: "second", text: "second" })]);
		if (internals._saveTimer) clearTimeout(internals._saveTimer);
		internals._saveTimer = null;
		release();
		await flushing;
		expect(attempts).toBe(2);
		const persisted = JSON.parse(fs.readFileSync(path.join(dir, "index", "__docs__.json"), "utf8"));
		expect(persisted.map((entry: FlexDoc) => entry.id).sort()).toEqual(["first", "second"]);
	} finally {
		await store.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("upsert → close → rm dir settles cleanly (no error log, no unhandled rejection)", async () => {
	const dir = tmp();
	const store = await FlexSearchStore.open({ dataDir: dir });

	const errors: string[] = [];
	const rejections: unknown[] = [];
	const origError = console.error;
	const onRejection = (reason: unknown) => rejections.push(reason);
	console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
	process.on("unhandledRejection", onRejection);

	try {
		// Schedules a debounced flush (`_scheduleSave`).
		await store.upsert([
			doc({ id: "a", text: "hello world goal one" }),
			doc({ id: "b", text: "entirely different subject" }),
		]);

		// close() must await the in-flight/final flush before resolving, so
		// the subsequent rm cannot race a pending write.
		await store.close();

		fs.rmSync(dir, { recursive: true, force: true });

		// Give any stray (unref'd) timer a chance to fire against the now-gone dir.
		await new Promise((r) => setTimeout(r, 50));
	} finally {
		console.error = origError;
		process.off("unhandledRejection", onRejection);
	}

	expect(errors.filter((e) => e.includes("flex flush error"))).toEqual([]);
	expect(errors.filter((e) => e.includes("flex persistence failed"))).toEqual([]);
	expect(rejections).toEqual([]);
	// The dir stays gone — no flush recreated it after close.
	expect(fs.existsSync(dir)).toBe(false);
});

test("__doFlush against a removed dir does NOT throw or log when _closed", async () => {
	const dir = tmp();
	const store = await FlexSearchStore.open({ dataDir: dir });
	await store.upsert([doc({ id: "a", text: "hello" })]);

	const errors: string[] = [];
	const origError = console.error;
	console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

	try {
		// Simulate the teardown race: store closed, target dir already removed.
		(store as unknown as { _closed: boolean })._closed = true;
		fs.rmSync(dir, { recursive: true, force: true });

		// Private flush — benign ENOENT/EPERM/EBUSY must be swallowed silently.
		await expect(
			(store as unknown as { __doFlush(): Promise<void> }).__doFlush(),
		).resolves.toBeUndefined();
	} finally {
		console.error = origError;
	}

	expect(errors).toEqual([]);
});

test("__doFlush while OPEN still writes (genuine path not suppressed)", async () => {
	const dir = tmp();
	const store = await FlexSearchStore.open({ dataDir: dir });
	try {
		await store.upsert([doc({ id: "a", text: "hello world" })]);
		// Disable the separately-covered debounce before calling the unsafe private
		// primitive directly. Under loaded Windows runs the timer can otherwise fire
		// between upsert and this line, producing two writers for the same `.tmp`
		// path — a race production avoids by funnelling writes through _flushNow.
		const internals = store as unknown as { _saveTimer: ReturnType<typeof setTimeout> | null; __doFlush(): Promise<void> };
		if (internals._saveTimer) clearTimeout(internals._saveTimer);
		internals._saveTimer = null;
		// Directly flush while open — must produce the persisted docs file.
		await internals.__doFlush();
		expect(fs.existsSync(path.join(dir, "index", "__docs__.json"))).toBe(true);
	} finally {
		await store.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
