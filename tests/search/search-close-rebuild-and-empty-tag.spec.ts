/**
 * Regression coverage for two search-subsystem issues seen in E2E logs:
 *
 *   1. PRIMARY — `[search] Background rebuild failed: Error:
 *      FlexSearchStore: already closed`. `SearchService._doOpen()` schedules
 *      a deferred startup rebuild via `setTimeout`. If `close()` runs before
 *      the timer fires, the rebuild used to call `store.clear()` on a closed
 *      store and throw. The fix keeps the timer handle on the instance,
 *      `clearTimeout`s it in `close()`, guards the scheduled callback to
 *      no-op once the service is closed, and waits for a rebuild that already
 *      passed the timer guard before closing the store.
 *
 *   2. SECONDARY — `[search] Skipping corrupt index file 1.tag.json:
 *      TypeError: Cannot read properties of null (reading 'length')`. An
 *      empty / partially-empty FlexSearch tag context exports as
 *      `[[field, null], ...]`; on reload `Document.import` crashes on
 *      `null.length`. The fix strips the null-valued tag entries on both the
 *      export (write) and import (read) paths so an empty tag context is a
 *      clean no-op instead of a "corrupt file" warning + rebuild-from-mirror.
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	FlexSearchStore,
	isTagKey,
	sanitiseTagImport,
	classifyTagImport,
	type FlexDoc,
} from "../../src/server/search/flex-store.ts";
import { SearchService } from "../../src/server/search/search-service.ts";
import { ProgressBus } from "../../src/server/search/progress-bus.ts";

function tmp(prefix = "search-fix-"): string {
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

// ── Fix 1: background rebuild timer cancelled on close ──────────────

test("close() cancels the scheduled startup rebuild — no 'already closed' throw", async () => {
	const stateDir = tmp("svc-rebuild-");
	const prevDelay = process.env.BOBBIT_SEARCH_STARTUP_DELAY_MS;
	// Long delay so close() reliably wins the race with the timer.
	process.env.BOBBIT_SEARCH_STARTUP_DELAY_MS = "10000";

	const errors: string[] = [];
	const origError = console.error;
	console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

	try {
		const svc = new SearchService({
			stateDir,
			projectId: "p1",
			progressBus: new ProgressBus(),
		});
		// Fresh dir → no meta → needsRebuild → a rebuild timer is scheduled
		// because context stores are supplied.
		const context = {
			goalStore: { getAll: () => [] },
			sessionStore: { getAll: () => [] },
			staffStore: { getAll: () => [] },
		} as unknown as Parameters<SearchService["open"]>[0];
		svc.open(context);
		await svc.whenReady();

		// Timer must be live before close.
		expect((svc as unknown as { _rebuildTimer: unknown })._rebuildTimer).not.toBeNull();

		await svc.close();

		// Timer handle cleared by close().
		expect((svc as unknown as { _rebuildTimer: unknown })._rebuildTimer).toBeNull();

		// Give any stray (unref'd) timer a window to (wrongly) fire.
		await new Promise((r) => setTimeout(r, 50));
	} finally {
		console.error = origError;
		if (prevDelay === undefined) delete process.env.BOBBIT_SEARCH_STARTUP_DELAY_MS;
		else process.env.BOBBIT_SEARCH_STARTUP_DELAY_MS = prevDelay;
		fs.rmSync(stateDir, { recursive: true, force: true });
	}

	expect(errors.filter((e) => e.includes("already closed"))).toEqual([]);
	expect(errors.filter((e) => e.includes("Background rebuild failed"))).toEqual([]);
});

test("rapid open() → close() with no whenReady(): no rebuild timer, store closed, state stays closed", async () => {
	const stateDir = tmp("svc-open-close-race-");
	const prevDelay = process.env.BOBBIT_SEARCH_STARTUP_DELAY_MS;
	// Long delay so the rebuild timer would still be pending if not cancelled.
	process.env.BOBBIT_SEARCH_STARTUP_DELAY_MS = "10000";

	const errors: string[] = [];
	const origError = console.error;
	console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

	try {
		const svc = new SearchService({
			stateDir,
			projectId: "p1",
			progressBus: new ProgressBus(),
		});
		const context = {
			goalStore: { getAll: () => [] },
			sessionStore: { getAll: () => [] },
			staffStore: { getAll: () => [] },
		} as unknown as Parameters<SearchService["open"]>[0];

		// Begin opening, then close immediately WITHOUT whenReady() — close()
		// must coordinate with the in-flight open() so no resources leak.
		svc.open(context);
		await svc.close();

		// Give any stray (unref'd) timer or open continuation a window to fire.
		await new Promise((r) => setTimeout(r, 60));

		// close() won the race: state is "closed" (never left flipped to
		// "ready"), the store was torn down, and no rebuild timer is pending.
		expect(svc.getState()).toBe("closed");
		expect((svc as unknown as { _store: unknown })._store).toBeNull();
		expect((svc as unknown as { _rebuildTimer: unknown })._rebuildTimer).toBeNull();
	} finally {
		console.error = origError;
		if (prevDelay === undefined) delete process.env.BOBBIT_SEARCH_STARTUP_DELAY_MS;
		else process.env.BOBBIT_SEARCH_STARTUP_DELAY_MS = prevDelay;
		fs.rmSync(stateDir, { recursive: true, force: true });
	}

	expect(errors.filter((e) => e.includes("already closed"))).toEqual([]);
	expect(errors.filter((e) => e.includes("Background rebuild failed"))).toEqual([]);
});

test("scheduled rebuild callback no-ops when the service is already closed", async () => {
	const stateDir = tmp("svc-rebuild-guard-");
	const prevDelay = process.env.BOBBIT_SEARCH_STARTUP_DELAY_MS;
	// Fire the timer almost immediately.
	process.env.BOBBIT_SEARCH_STARTUP_DELAY_MS = "1";

	const errors: string[] = [];
	const origError = console.error;
	console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

	try {
		const svc = new SearchService({
			stateDir,
			projectId: "p1",
			progressBus: new ProgressBus(),
		});
		const context = {
			goalStore: { getAll: () => [] },
			sessionStore: { getAll: () => [] },
			staffStore: { getAll: () => [] },
		} as unknown as Parameters<SearchService["open"]>[0];
		svc.open(context);
		await svc.whenReady();
		// Close immediately, then defeat the clearTimeout safety net by
		// firing the callback after close — the `_state === "closed"` guard
		// must keep it from touching the closed store.
		await svc.close();
		await new Promise((r) => setTimeout(r, 30));
	} finally {
		console.error = origError;
		if (prevDelay === undefined) delete process.env.BOBBIT_SEARCH_STARTUP_DELAY_MS;
		else process.env.BOBBIT_SEARCH_STARTUP_DELAY_MS = prevDelay;
		fs.rmSync(stateDir, { recursive: true, force: true });
	}

	expect(errors.filter((e) => e.includes("already closed"))).toEqual([]);
});

test("close() waits for an in-flight startup rebuild before closing the store", async () => {
	const stateDir = tmp("svc-rebuild-in-flight-");
	const prevDelay = process.env.BOBBIT_SEARCH_STARTUP_DELAY_MS;
	process.env.BOBBIT_SEARCH_STARTUP_DELAY_MS = "1";

	const errors: string[] = [];
	const unhandled: string[] = [];
	const origError = console.error;
	const originalClear = FlexSearchStore.prototype.clear;
	let releaseClear!: () => void;
	let enteredClear!: () => void;
	const clearEntered = new Promise<void>((resolve) => { enteredClear = resolve; });
	const clearReleased = new Promise<void>((resolve) => { releaseClear = resolve; });
	let blockNextClear = true;
	console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
	const onUnhandled = (reason: unknown) => {
		unhandled.push(reason instanceof Error ? reason.message : String(reason));
	};
	process.on("unhandledRejection", onUnhandled);
	FlexSearchStore.prototype.clear = async function clearWithTestGate() {
		await originalClear.call(this);
		if (blockNextClear) {
			blockNextClear = false;
			enteredClear();
			await clearReleased;
		}
	};

	try {
		const svc = new SearchService({
			stateDir,
			projectId: "p1",
			progressBus: new ProgressBus(),
		});
		const context = {
			goalStore: {
				getAll: () => [{
					id: "g1",
					title: "Search race goal",
					spec: "Close while the startup rebuild is in flight.",
					state: "open",
					projectId: "p1",
					createdAt: 1,
					updatedAt: 2,
				}],
			},
			sessionStore: { getAll: () => [] },
			staffStore: { getAll: () => [] },
		} as unknown as Parameters<SearchService["open"]>[0];
		svc.open(context);
		await svc.whenReady();

		await Promise.race([
			clearEntered,
			new Promise((_, reject) => setTimeout(() => reject(new Error("startup rebuild did not start")), 1_000)),
		]);

		let closeSettled = false;
		const closePromise = svc.close().then(() => { closeSettled = true; });
		await new Promise((r) => setTimeout(r, 30));
		expect(closeSettled).toBe(false);

		releaseClear();
		await closePromise;
		await new Promise((r) => setTimeout(r, 30));
	} finally {
		FlexSearchStore.prototype.clear = originalClear;
		process.off("unhandledRejection", onUnhandled);
		console.error = origError;
		if (prevDelay === undefined) delete process.env.BOBBIT_SEARCH_STARTUP_DELAY_MS;
		else process.env.BOBBIT_SEARCH_STARTUP_DELAY_MS = prevDelay;
		fs.rmSync(stateDir, { recursive: true, force: true });
	}

	expect(errors.filter((e) => e.includes("already closed"))).toEqual([]);
	expect(errors.filter((e) => e.includes("Background rebuild failed"))).toEqual([]);
	expect(unhandled.filter((e) => e.includes("already closed"))).toEqual([]);
});

// ── Fix 2: empty/null tag export round-trips cleanly ────────────────

test("sanitiseTagImport strips null-valued tag entries", () => {
	// Empty index shape — every field null.
	expect(
		sanitiseTagImport([["source_id", null], ["project_id", null], ["archived_tag", null]]),
	).toBeNull();
	// Mixed — keep only the populated field.
	expect(
		sanitiseTagImport([["source_id", [["messages", ["a"]]]], ["project_id", null]]),
	).toEqual([["source_id", [["messages", ["a"]]]]]);
	// Non-array / junk → nothing to import.
	expect(sanitiseTagImport(null)).toBeNull();
	expect(sanitiseTagImport("nope")).toBeNull();
});

test("classifyTagImport: import / empty / invalid", () => {
	// Populated → import only the non-null fields.
	expect(
		classifyTagImport([["source_id", [["messages", ["a"]]]], ["project_id", null]]),
	).toEqual({ kind: "import", entries: [["source_id", [["messages", ["a"]]]]] });
	// Known empty-tag shape (all null) → clean no-op, NOT a corruption.
	expect(
		classifyTagImport([["source_id", null], ["project_id", null], ["archived_tag", null]]),
	).toEqual({ kind: "empty" });
	// Empty array → empty.
	expect(classifyTagImport([])).toEqual({ kind: "empty" });
	// Non-array / unparseable (safeParse returns the raw string) → invalid.
	expect(classifyTagImport(null)).toEqual({ kind: "invalid" });
	expect(classifyTagImport("{not valid json")).toEqual({ kind: "invalid" });
	// Array with a malformed entry → invalid (not the recognized tag shape).
	expect(classifyTagImport([["source_id", null], ["oops"]])).toEqual({ kind: "invalid" });
	expect(classifyTagImport([42])).toEqual({ kind: "invalid" });
});

test("isTagKey recognises tag export keys", () => {
	expect(isTagKey("1.tag")).toBe(true);
	expect(isTagKey("source_id.1.tag")).toBe(true);
	expect(isTagKey("1.reg")).toBe(false);
	expect(isTagKey("title.1.map")).toBe(false);
	expect(isTagKey("1.doc")).toBe(false);
});

test("empty index export → reopen: no 'corrupt index file' tag warning", async () => {
	const dir = tmp("empty-tag-");
	const warns: string[] = [];
	const origWarn = console.warn;
	console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };

	try {
		// No docs upserted → empty index. Force a flush (export) then reopen.
		const store = await FlexSearchStore.open({ dataDir: dir });
		await store.compact();
		await store.close();

		const reopened = await FlexSearchStore.open({ dataDir: dir });
		await reopened.close();
	} finally {
		console.warn = origWarn;
		fs.rmSync(dir, { recursive: true, force: true });
	}

	expect(warns.filter((w) => w.includes("Skipping corrupt index file"))).toEqual([]);
	expect(warns.filter((w) => w.includes("1.tag"))).toEqual([]);
});

test("pre-existing null-shape tag export file imports cleanly (no warning, no rebuild)", async () => {
	const dir = tmp("legacy-tag-");
	const indexDir = path.join(dir, "index");
	fs.mkdirSync(indexDir, { recursive: true });
	// Simulate a previously-written empty tag export on disk.
	fs.writeFileSync(path.join(indexDir, "__docs__.json"), "[]", "utf-8");
	fs.writeFileSync(
		path.join(indexDir, "1.tag.json"),
		JSON.stringify([["source_id", null], ["project_id", null], ["archived_tag", null]]),
		"utf-8",
	);

	const warns: string[] = [];
	const origWarn = console.warn;
	console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };

	try {
		const store = await FlexSearchStore.open({ dataDir: dir });
		await store.close();
	} finally {
		console.warn = origWarn;
		fs.rmSync(dir, { recursive: true, force: true });
	}

	expect(warns.filter((w) => w.includes("Skipping corrupt index file"))).toEqual([]);
	expect(warns.filter((w) => w.includes("Rebuilding in-memory index"))).toEqual([]);
});

test("corrupt invalid-JSON tag export in a populated index → rebuild-from-mirror", async () => {
	const dir = tmp("corrupt-tag-");
	const indexDir = path.join(dir, "index");
	fs.mkdirSync(indexDir, { recursive: true });
	// A populated mirror so rebuild-from-mirror has something to rebuild from.
	const mirror = doc({
		id: "goal:1",
		text: "hello world goal",
		source_id: "goals",
		entity_type: "goal",
		project_id: "p1",
	});
	fs.writeFileSync(path.join(indexDir, "__docs__.json"), JSON.stringify([mirror]), "utf-8");
	// A genuinely corrupt (invalid-JSON) tag export must NOT be silently
	// skipped — it has to count as an import failure so rebuild fires.
	fs.writeFileSync(path.join(indexDir, "1.tag.json"), "{not valid json", "utf-8");

	const warns: string[] = [];
	const origWarn = console.warn;
	console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };

	let count = 0;
	try {
		const store = await FlexSearchStore.open({ dataDir: dir });
		count = store.count();
		await store.close();
	} finally {
		console.warn = origWarn;
		fs.rmSync(dir, { recursive: true, force: true });
	}

	// Corrupt tag payload counted as a failure → rebuild-from-mirror fired.
	expect(warns.filter((w) => w.includes("Rebuilding in-memory index")).length).toBeGreaterThan(0);
	// The mirror doc survived (rebuild restores it).
	expect(count).toBe(1);
});

test("populated tag index round-trips: tag-filtered search still works after reload", async () => {
	const dir = tmp("populated-tag-");
	const warns: string[] = [];
	const origWarn = console.warn;
	console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };

	try {
		const store = await FlexSearchStore.open({ dataDir: dir });
		await store.upsert([
			doc({ id: "goal:1", text: "hello world goal", source_id: "goals", entity_type: "goal", project_id: "p1" }),
			doc({ id: "session:1", text: "hello session here", source_id: "sessions", entity_type: "session", project_id: "p1" }),
		]);
		await store.compact();
		await store.close();

		const reopened = await FlexSearchStore.open({ dataDir: dir });
		const res = await reopened.search({ q: "hello", types: ["goals"], includeArchived: true });
		await reopened.close();

		// Tag filter survived the reload — only the goals row comes back.
		expect(res.results.length).toBe(1);
		expect(res.results[0]?.type).toBe("goal");
	} finally {
		console.warn = origWarn;
		fs.rmSync(dir, { recursive: true, force: true });
	}

	expect(warns.filter((w) => w.includes("Skipping corrupt index file"))).toEqual([]);
});
