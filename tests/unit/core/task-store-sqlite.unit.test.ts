import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskStore, type PersistedTask } from "../../../src/server/agent/task-store.js";
import { createMemFs } from "../../support/harnesses/shared/mem-fs.js";

const roots: string[] = [];
const stores: TaskStore[] = [];

function tempRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-task-sqlite-"));
	roots.push(root);
	return root;
}

function openStore(stateDir: string): TaskStore {
	const store = new TaskStore(stateDir);
	stores.push(store);
	return store;
}

function task(id: string, overrides: Partial<PersistedTask> = {}): PersistedTask {
	return {
		id,
		goalId: "goal-1",
		title: `Task ${id}`,
		type: "implementation",
		state: "todo",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function createUnmarkedDatabase(stateDir: string, failInserts = false): void {
	const db = new Database(path.join(stateDir, "tasks.sqlite"));
	db.exec(`
		CREATE TABLE task_store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;
		CREATE TABLE task_records (id TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT;
		PRAGMA user_version = 1;
	`);
	if (failInserts) {
		db.exec("CREATE TRIGGER fail_task_import BEFORE INSERT ON task_records BEGIN SELECT RAISE(ABORT, 'injected import failure'); END;");
	}
	db.close();
}

async function closeTracked(store: TaskStore): Promise<void> {
	stores.splice(stores.indexOf(store), 1);
	await store.close();
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const store of stores.splice(0)) {
		try { await store.close(); } catch { /* failure behavior is asserted by its test */ }
	}
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("TaskStore SQLite persistence", () => {
	it("keeps injected FsLike fixtures on JSON and preserves legacy canonicalization", async () => {
		const memfs = createMemFs();
		const stateDir = path.resolve("/memfs/task-store-sqlite");
		memfs.mkdirSync(stateDir, { recursive: true });
		memfs.writeFileSync(path.join(stateDir, "tasks.json"), JSON.stringify([{
			...task("legacy"),
			workflowArtifactId: "implementation",
			inputArtifactIds: ["design"],
			commitSha: "abc123",
		}]), "utf-8");
		const store = new TaskStore(stateDir, memfs);
		expect(store.get("legacy")).toMatchObject({
			workflowGateId: "implementation",
			inputGateIds: ["design"],
			headSha: "abc123",
		});
		expect(store.get("legacy")).not.toHaveProperty("workflowArtifactId");
		expect(store.get("legacy")).not.toHaveProperty("inputArtifactIds");
		expect(store.get("legacy")).not.toHaveProperty("commitSha");
		store.put(task("new"));
		await store.close();
		expect(memfs.existsSync(path.join(stateDir, "tasks.json"))).toBe(true);
		expect(memfs.existsSync(path.join(stateDir, "tasks.sqlite"))).toBe(false);
	});

	it("initializes an empty authoritative database and reloads exact records", async () => {
		const stateDir = tempRoot();
		const empty = openStore(stateDir);
		expect(empty.getAll()).toEqual([]);
		expect(fs.existsSync(path.join(stateDir, "tasks.sqlite"))).toBe(true);
		empty.put(task("unicode", {
			title: "Ship ✓ SQLite",
			dependsOn: ["design"],
			gitHandoff: { api: { baseSha: "a", headSha: "b", branch: "feat/✓" } },
			legacyExtension: { nested: ["preserved", 7] },
		} as Partial<PersistedTask>));
		await closeTracked(empty);

		const reloaded = openStore(stateDir);
		expect(reloaded.get("unicode")).toEqual(task("unicode", {
			title: "Ship ✓ SQLite",
			dependsOn: ["design"],
			gitHandoff: { api: { baseSha: "a", headSha: "b", branch: "feat/✓" } },
			legacyExtension: { nested: ["preserved", 7] },
		} as Partial<PersistedTask>));
		expect(reloaded.getGeneration()).toBe(0);
	});

	it("migrates live and recovery JSON exactly, with live identity precedence and collision-safe retirement", () => {
		const stateDir = tempRoot();
		const liveFile = path.join(stateDir, "tasks.json");
		const recoveryFile = `${liveFile}.pre-migration`;
		const live = [task("conflict", { state: "complete", completedAt: 5 }), task("live", { title: "Live ✓" })];
		const recovery = [task("conflict", { state: "blocked" }), task("recovered", { goalId: "goal-2" })];
		const liveBytes = Buffer.from(JSON.stringify(live));
		const recoveryBytes = Buffer.from(JSON.stringify(recovery));
		fs.writeFileSync(liveFile, liveBytes);
		fs.writeFileSync(recoveryFile, recoveryBytes);
		fs.writeFileSync(`${liveFile}.sqlite-retired`, "occupied");
		fs.writeFileSync(`${recoveryFile}-recovered`, "occupied-recovery");

		const store = openStore(stateDir);
		expect(store.getAll()).toHaveLength(3);
		expect(store.get("conflict")?.state).toBe("complete");
		expect(store.get("recovered")?.goalId).toBe("goal-2");
		expect(fs.readFileSync(`${liveFile}.sqlite-retired`)).toEqual(Buffer.from("occupied"));
		expect(fs.readFileSync(`${liveFile}.sqlite-retired.1`)).toEqual(liveBytes);
		expect(fs.readFileSync(`${recoveryFile}-recovered`)).toEqual(Buffer.from("occupied-recovery"));
		expect(fs.readFileSync(`${recoveryFile}-recovered.1`)).toEqual(recoveryBytes);
	});

	it("filters goal-tombstoned recovery-only tasks while retaining live and authoritative conflicts", async () => {
		const stateDir = tempRoot();
		const tombstoneBytes = Buffer.from(JSON.stringify({ "goals.json": ["deleted-goal"] }, null, 2));
		fs.writeFileSync(path.join(stateDir, ".deletion-tombstones.json"), tombstoneBytes);
		fs.writeFileSync(path.join(stateDir, "tasks.json.pre-migration"), JSON.stringify([
			task("recovery-only", { goalId: "deleted-goal" }),
			task("control", { goalId: "live-goal" }),
		]));
		fs.writeFileSync(path.join(stateDir, "tasks.json"), JSON.stringify([
			task("live-wins", { goalId: "deleted-goal" }),
		]));
		const migrated = openStore(stateDir);
		expect(migrated.get("recovery-only")).toBeUndefined();
		expect(migrated.get("control")).toBeDefined();
		expect(migrated.get("live-wins")).toBeDefined();
		expect(fs.readFileSync(path.join(stateDir, ".deletion-tombstones.json"))).toEqual(tombstoneBytes);
		await closeTracked(migrated);

		fs.writeFileSync(path.join(stateDir, "tasks.json.pre-migration"), JSON.stringify([
			task("live-wins", { goalId: "deleted-goal", state: "blocked" }),
			task("late-deleted", { goalId: "deleted-goal" }),
		]));
		const recovered = openStore(stateDir);
		expect(recovered.get("live-wins")?.state).toBe("todo");
		expect(recovered.get("late-deleted")).toBeUndefined();
	});

	it("recovers missing tasks into authoritative SQLite once with SQLite precedence and tombstone filtering", async () => {
		const stateDir = tempRoot();
		const recoveryFile = path.join(stateDir, "tasks.json.pre-migration");
		const preferredBackup = path.join(stateDir, "tasks.json.pre-migration-recovered");
		const store = openStore(stateDir);
		store.put(task("conflict", { state: "complete", completedAt: 2 }));
		await closeTracked(store);

		fs.writeFileSync(path.join(stateDir, ".deletion-tombstones.json"), JSON.stringify({ "goals.json": ["deleted-goal"] }));
		const recoveryBytes = Buffer.from(JSON.stringify([
			task("conflict", { state: "blocked" }),
			task("eligible", { goalId: "active-goal" }),
			task("tombstoned", { goalId: "deleted-goal" }),
		]));
		fs.writeFileSync(recoveryFile, recoveryBytes);
		fs.writeFileSync(preferredBackup, "occupied");

		const recovered = openStore(stateDir);
		expect(recovered.get("conflict")?.state).toBe("complete");
		expect(recovered.get("eligible")?.goalId).toBe("active-goal");
		expect(recovered.get("tombstoned")).toBeUndefined();
		expect(fs.existsSync(recoveryFile)).toBe(false);
		expect(fs.readFileSync(preferredBackup, "utf-8")).toBe("occupied");
		expect(fs.readFileSync(`${preferredBackup}.1`)).toEqual(recoveryBytes);
		await closeTracked(recovered);

		const replayBytes = Buffer.from(JSON.stringify([
			task("eligible", { state: "blocked" }),
			task("replayed"),
		]));
		fs.writeFileSync(recoveryFile, replayBytes);
		const reopened = openStore(stateDir);
		expect(reopened.get("eligible")?.state).toBe("todo");
		expect(reopened.get("replayed")).toBeUndefined();
		expect(fs.readFileSync(recoveryFile)).toEqual(replayBytes);
	});

	it("writes only dirty IDs, batches removeMany atomically, and reports affected bytes", async () => {
		const stateDir = tempRoot();
		const store = openStore(stateDir);
		const untouched = task("untouched", { spec: "large stable payload" });
		store.put(untouched);
		store.put(task("changed"));
		store.put(task("removed"));
		await store.flush();
		const db = new Database(path.join(stateDir, "tasks.sqlite"));
		const before = db.prepare("SELECT payload FROM task_records WHERE id = ?").get("untouched") as { payload: string };
		db.close();

		const changed = task("changed", { state: "in-progress", updatedAt: 2 });
		store.put(changed);
		await store.flush();
		expect(store.getPersistenceMetrics()?.bytes).toBe(Buffer.byteLength(JSON.stringify(changed)));
		const check = new Database(path.join(stateDir, "tasks.sqlite"));
		expect((check.prepare("SELECT payload FROM task_records WHERE id = ?").get("untouched") as { payload: string }).payload).toBe(before.payload);
		check.close();

		const generation = store.getGeneration();
		store.removeMany(["changed", "removed"]);
		expect(store.getGeneration()).toBe(generation + 1);
		store.removeMany([]);
		expect(store.getGeneration()).toBe(generation + 1);
		await closeTracked(store);
		const reloaded = openStore(stateDir);
		expect(reloaded.getAll()).toEqual([untouched]);
	});

	it("rejects invalid published fields transactionally and commits the requeued batch after correction", async () => {
		const stateDir = tempRoot();
		const store = openStore(stateDir);
		store.put(task("durable"));
		await store.flush();

		store.put(task("durable", { state: "complete", completedAt: 2 }));
		const invalid = task("invalid");
		(invalid as unknown as Record<string, unknown>).title = 42;
		store.put(invalid);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(store.flush()).rejects.toThrow(/title must be a non-empty string/);
		errors.mockRestore();

		const db = new Database(path.join(stateDir, "tasks.sqlite"));
		expect((db.prepare("SELECT payload FROM task_records WHERE id = ?").get("durable") as { payload: string }).payload)
			.toBe(JSON.stringify(task("durable")));
		expect((db.prepare("SELECT COUNT(*) AS count FROM task_records").get() as { count: number }).count).toBe(1);
		expect(db.prepare("SELECT payload FROM task_records WHERE id = ?").get("invalid")).toBeUndefined();
		db.close();

		invalid.title = "Corrected";
		await store.flush();
		await closeTracked(store);
		const reopened = openStore(stateDir);
		expect(reopened.get("durable")?.state).toBe("complete");
		expect(reopened.get("invalid")?.title).toBe("Corrected");
	});

	it("rejects dirty-key and serialized payload identity mismatches and retries after correction", async () => {
		const stateDir = tempRoot();
		const store = openStore(stateDir);
		store.put(task("durable"));
		await store.flush();

		const mismatched = task("dirty-key");
		store.put(mismatched);
		mismatched.id = "payload-id";
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(store.flush()).rejects.toThrow(/identity mismatch/);
		errors.mockRestore();

		const db = new Database(path.join(stateDir, "tasks.sqlite"));
		expect((db.prepare("SELECT COUNT(*) AS count FROM task_records").get() as { count: number }).count).toBe(1);
		expect(db.prepare("SELECT payload FROM task_records WHERE id IN (?, ?)").get("dirty-key", "payload-id")).toBeUndefined();
		db.close();

		mismatched.id = "dirty-key";
		await store.flush();
		await closeTracked(store);
		const reopened = openStore(stateDir);
		expect(reopened.get("dirty-key")).toEqual(task("dirty-key"));
		expect(reopened.get("payload-id")).toBeUndefined();
	});

	it("rolls back a whole dirty batch after serialization failure and requeues it", async () => {
		const stateDir = tempRoot();
		const store = openStore(stateDir);
		store.put(task("a"));
		store.put(task("b"));
		await store.flush();
		store.put(task("a", { state: "complete", completedAt: 2 }));
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		store.put(task("b", { resultSummary: circular as unknown as string }));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(store.flush()).rejects.toThrow(/circular/i);
		error.mockRestore();

		const reader = openStore(stateDir);
		expect(reader.get("a")?.state).toBe("todo");
		expect(reader.get("b")?.resultSummary).toBeUndefined();
		await closeTracked(reader);
		store.put(task("b", { resultSummary: "fixed" }));
		await store.flush();
		await closeTracked(store);
		const reloaded = openStore(stateDir);
		expect(reloaded.get("a")?.state).toBe("complete");
		expect(reloaded.get("b")?.resultSummary).toBe("fixed");
	});

	it("rejects malformed and duplicate sources without modifying their bytes or importing rows", () => {
		const malformedDir = tempRoot();
		const malformedFile = path.join(malformedDir, "tasks.json");
		const malformedBytes = Buffer.from(JSON.stringify([task("ok"), task("bad", { updatedAt: Number.NaN })]));
		fs.writeFileSync(malformedFile, malformedBytes);
		expect(() => openStore(malformedDir)).toThrow(/updatedAt must be finite/);
		expect(fs.readFileSync(malformedFile)).toEqual(malformedBytes);
		expect(fs.existsSync(`${malformedFile}.sqlite-retired`)).toBe(false);

		const duplicateDir = tempRoot();
		const duplicateFile = path.join(duplicateDir, "tasks.json");
		const duplicateBytes = Buffer.from(JSON.stringify([task("same"), task("same")]));
		fs.writeFileSync(duplicateFile, duplicateBytes);
		expect(() => openStore(duplicateDir)).toThrow(/Duplicate tasks\.json task same/);
		expect(fs.readFileSync(duplicateFile)).toEqual(duplicateBytes);

		const failedDir = tempRoot();
		const failedFile = path.join(failedDir, "tasks.json");
		const failedBytes = Buffer.from(JSON.stringify([task("import")]));
		fs.writeFileSync(failedFile, failedBytes);
		createUnmarkedDatabase(failedDir, true);
		expect(() => openStore(failedDir)).toThrow(/injected import failure/);
		expect(fs.readFileSync(failedFile)).toEqual(failedBytes);
		const db = new Database(path.join(failedDir, "tasks.sqlite"));
		expect((db.prepare("SELECT COUNT(*) AS count FROM task_records").get() as { count: number }).count).toBe(0);
		expect((db.prepare("SELECT COUNT(*) AS count FROM task_store_meta").get() as { count: number }).count).toBe(0);
		db.close();
	}, 15_000);

	it("rolls back statement failures for batched deletion and retries every dirty ID", async () => {
		const stateDir = tempRoot();
		const store = openStore(stateDir);
		store.put(task("delete-a"));
		store.put(task("delete-b"));
		await store.flush();
		let db = new Database(path.join(stateDir, "tasks.sqlite"));
		db.exec(`
			CREATE TRIGGER fail_delete_b BEFORE DELETE ON task_records
			WHEN old.id = 'delete-b'
			BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END;
		`);
		db.close();

		store.removeMany(["delete-a", "delete-b"]);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(store.flush()).rejects.toThrow(/injected delete failure/);
		errors.mockRestore();
		db = new Database(path.join(stateDir, "tasks.sqlite"));
		expect((db.prepare("SELECT COUNT(*) AS count FROM task_records").get() as { count: number }).count).toBe(2);
		db.exec("DROP TRIGGER fail_delete_b");
		db.close();

		await store.flush();
		await closeTracked(store);
		const reloaded = openStore(stateDir);
		expect(reloaded.getAll()).toEqual([]);
	});

	it("leaves durable retirement intent after interruption and never reimports changed source bytes", () => {
		const stateDir = tempRoot();
		const source = path.join(stateDir, "tasks.json");
		const preferred = `${source}.sqlite-retired`;
		fs.writeFileSync(source, JSON.stringify([task("committed", { state: "complete", completedAt: 2 })]));
		const originalUnlink = fs.unlinkSync;
		const unlink = vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => {
			const error = new Error("injected unlink interruption") as NodeJS.ErrnoException;
			error.code = "EACCES";
			throw error;
		});
		expect(() => openStore(stateDir)).toThrow(/injected unlink interruption/);
		unlink.mockRestore();
		expect(fs.existsSync(source)).toBe(true);
		expect(fs.existsSync(preferred)).toBe(true);

		originalUnlink(source);
		fs.writeFileSync(source, JSON.stringify([task("committed", { state: "blocked" }), task("stale-only")]));
		const recovered = openStore(stateDir);
		expect(recovered.get("committed")?.state).toBe("complete");
		expect(recovered.get("stale-only")).toBeUndefined();
		expect(fs.existsSync(`${preferred}.1`)).toBe(true);
		const db = new Database(path.join(stateDir, "tasks.sqlite"));
		expect(db.prepare("SELECT value FROM task_store_meta WHERE key = ?").get("pending_retirement:tasks.json")).toBeUndefined();
		db.close();
	});

	it("rejects corrupt authoritative payloads and row identity mismatches while releasing handles", async () => {
		const malformedDir = tempRoot();
		const store = openStore(malformedDir);
		store.put(task("row"));
		await closeTracked(store);
		const malformedDbFile = path.join(malformedDir, "tasks.sqlite");
		let db = new Database(malformedDbFile);
		db.prepare("UPDATE task_records SET payload = ? WHERE id = ?").run("{bad json", "row");
		db.close();
		expect(() => openStore(malformedDir)).toThrow(/Invalid SQLite payload/);
		fs.renameSync(malformedDbFile, `${malformedDbFile}.released`);

		const mismatchDir = tempRoot();
		const mismatch = openStore(mismatchDir);
		mismatch.put(task("expected"));
		await closeTracked(mismatch);
		const mismatchDbFile = path.join(mismatchDir, "tasks.sqlite");
		db = new Database(mismatchDbFile);
		db.prepare("UPDATE task_records SET payload = ? WHERE id = ?").run(JSON.stringify(task("wrong")), "expected");
		db.close();
		expect(() => openStore(mismatchDir)).toThrow(/row identity mismatch/);
		fs.renameSync(mismatchDbFile, `${mismatchDbFile}.released`);
	});

	it("rejects persistent final publication for all close callers and still releases the native handle", async () => {
		const stateDir = tempRoot();
		const store = openStore(stateDir);
		let attempts = 0;
		store.put(task("persistent", {
			legacyExtension: {
				toJSON() {
					attempts++;
					throw new Error("persistent serialization failure");
				},
			},
		} as Partial<PersistedTask>));
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const first = store.close();
		const second = store.close();
		expect(second).toBe(first);
		const results = await Promise.allSettled([first, second]);
		expect(results).toMatchObject([
			{ status: "rejected", reason: { message: "persistent serialization failure" } },
			{ status: "rejected", reason: { message: "persistent serialization failure" } },
		]);
		expect(attempts).toBe(2);
		errors.mockRestore();
		stores.splice(stores.indexOf(store), 1);
		const dbFile = path.join(stateDir, "tasks.sqlite");
		fs.renameSync(dbFile, `${dbFile}.released`);
	});

	it("shares concurrent close, retries once, fences mutations, and releases the native handle", async () => {
		const stateDir = tempRoot();
		const store = openStore(stateDir);
		let attempts = 0;
		const transient = task("retry", {
			legacyExtension: {
				toJSON() {
					attempts++;
					if (attempts === 1) throw new Error("transient serialization failure");
					return { durable: true };
				},
			},
		} as Partial<PersistedTask>);
		store.put(transient);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const first = store.close();
		const second = store.close();
		expect(second).toBe(first);
		expect(() => store.put(task("late"))).toThrow(/TaskStore is closing or closed/);
		expect(() => store.remove("retry")).toThrow(/TaskStore is closing or closed/);
		expect(() => store.removeMany(["retry"])).toThrow(/TaskStore is closing or closed/);
		await first;
		expect(attempts).toBe(2);
		errors.mockRestore();
		stores.splice(stores.indexOf(store), 1);

		const dbFile = path.join(stateDir, "tasks.sqlite");
		fs.renameSync(dbFile, `${dbFile}.released`);
		fs.renameSync(`${dbFile}.released`, dbFile);
		const reloaded = openStore(stateDir);
		expect(reloaded.get("retry")).toMatchObject({ legacyExtension: { durable: true } });
	});
});
