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
import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FlexSearchStore, type FlexDoc } from "../../src/server/search/flex-store.ts";

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
		// Directly flush while open — must produce the persisted docs file.
		await (store as unknown as { __doFlush(): Promise<void> }).__doFlush();
		expect(fs.existsSync(path.join(dir, "index", "__docs__.json"))).toBe(true);
	} finally {
		await store.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
